// Idempotent loader: extracted_logs/*.jsonl  ->  BigQuery credit_events.
//
// WHY THIS EXISTS. The previous loader picked files by GCS creation time and wrote its checkpoint only
// after ALL chunks loaded. That produced ~1.49M duplicate rows (2026-10): a re-exported ledger rewrites its
// event file under the same name with a newer timestamp (loaded again), and a run that failed on chunk 3 of
// 5 reloaded chunks 1-2. Both are impossible here:
//
//   * Every file is recorded BY NAME in a ledger table (credit_bureau.loaded_files). A name that is in the
//     ledger is never loaded again, even if the object is rewritten or the checkpoint is lost.
//   * Each chunk is ONE BigQuery transaction that inserts the event rows AND the ledger rows together, so a
//     failure leaves nothing half-done and a retry cannot double-load.
//   * The checkpoint is only a scan hint, never a correctness mechanism.
//
// Usage (see README.md):
//   node loader.js --init                create the ledger table (idempotent)
//   node loader.js --seed [--before ISO] record every file created at/before the cutoff as already loaded
//   node loader.js [--dry-run]           load new files (targeted listing of live folders only)
//   node loader.js --full [--dry-run]    same, but scan the whole prefix (run daily as a safety net)
const crypto = require("crypto");
const { Storage } = require("@google-cloud/storage");
const { BigQuery } = require("@google-cloud/bigquery");

const BUCKET = process.env.BUCKET || "stellar-credit-bureau-data-index";
const PREFIX = process.env.PREFIX || "extracted_logs/";
const RAW_PREFIX = process.env.RAW_PREFIX || "raw/";
const DATASET = process.env.DATASET || "credit_bureau";
const EVENTS_TABLE = process.env.EVENTS_TABLE || "credit_events";
const LEDGER_TABLE = process.env.LEDGER_TABLE || "loaded_files";
const STATE_PATH = process.env.STATE_PATH || "_bq_loader_v2_state.json";
const V1_CHECKPOINT_PATH = process.env.V1_CHECKPOINT_PATH || "_bq_loader_checkpoint.json";
const CHUNK_SIZE = Number(process.env.CHUNK_SIZE || 5000);          // files per transaction (external table limit is 10,000)
const OVERLAP_MS = Number(process.env.OVERLAP_HOURS || 12) * 3600 * 1000; // re-examine this much history; the ledger makes it harmless
const MAX_FILES_PER_RUN = Number(process.env.MAX_FILES_PER_RUN || 150000);

const args = new Set(process.argv.slice(2));
const argValue = (flag) => { const i = process.argv.indexOf(flag); return i > -1 ? process.argv[i + 1] : undefined; };
const DRY = args.has("--dry-run");

const storage = new Storage();
const bq = new BigQuery();
const bucket = storage.bucket(BUCKET);
const log = (m) => console.log("[bq-loader-v2] " + m);

const EVENT_COLUMNS = [
  ["ledgerSequence", "INTEGER"], ["transactionHash", "STRING"], ["blockCloseTime", "TIMESTAMP"], ["protocolName", "STRING"],
  ["category", "STRING"], ["contractId", "STRING"], ["userAddress", "STRING"], ["eventType", "STRING"], ["amount", "FLOAT"],
  ["assetContractId", "STRING"], ["assetCode", "STRING"], ["assetOutContractId", "STRING"], ["assetOutCode", "STRING"],
  ["amountOut", "FLOAT"], ["counterpartyAddress", "STRING"], ["poolShareTokensAfter", "FLOAT"], ["collateralRatioAfter", "FLOAT"]
];
const NAME_OF_FILE = 'REGEXP_EXTRACT(_FILE_NAME, r"' + PREFIX + '(.*)$")';

// ---------- state (scan hint only) ----------
async function readJson(path, fallback) {
  try { const [buf] = await bucket.file(path).download(); return JSON.parse(buf.toString("utf-8")); } catch { return fallback; }
}
async function writeJson(path, obj) {
  await bucket.file(path).save(JSON.stringify(obj), { contentType: "application/json", resumable: false });
}

// ---------- listing ----------
async function listPrefix(prefix, onFile) {
  let pageToken;
  do {
    const [files, next] = await bucket.getFiles({ prefix, maxResults: 5000, autoPaginate: false, ...(pageToken && { pageToken }) });
    for (const f of files) if (f.name.endsWith(".jsonl")) onFile(f);
    pageToken = next && next.pageToken;
  } while (pageToken);
}

// Folders currently present under raw/ (the live partition and anything still waiting to be indexed).
async function rawFolders() {
  const out = new Set();
  let pageToken;
  do {
    const [, next, apiResponse] = await bucket.getFiles({ prefix: RAW_PREFIX, delimiter: "/", autoPaginate: false, ...(pageToken && { pageToken }) });
    for (const p of (apiResponse && apiResponse.prefixes) || []) out.add(p.slice(RAW_PREFIX.length).replace(/\/$/, ""));
    pageToken = next && next.pageToken;
  } while (pageToken);
  out.delete("");
  return [...out];
}
// An event file is named  <PREFIX>raw_<folder>_<file>.jsonl , so a raw folder maps to a name prefix.
const extractedPrefixForFolder = (folder) => PREFIX + "raw_" + folder + "_";

async function collectCandidates(state, full) {
  const since = new Date(state.watermark).getTime() - OVERLAP_MS;
  const found = new Map();            // name -> timeCreated ms
  let prefixes;
  if (full) prefixes = [PREFIX];
  else prefixes = [...new Set([...(await rawFolders()).map(extractedPrefixForFolder), ...(state.activePrefixes || [])])];
  log((full ? "FULL scan of " : "targeted scan of ") + prefixes.length + " prefix(es)");
  for (const p of prefixes) {
    await listPrefix(p, (f) => {
      const created = new Date(f.metadata.timeCreated).getTime();
      if (created > since) found.set(f.name.slice(PREFIX.length), created);
    });
  }
  return { found, prefixes };
}

// ---------- ledger ----------
const ledgerRef = () => "`" + bq.projectId + "." + DATASET + "." + LEDGER_TABLE + "`";
const eventsRef = () => "`" + bq.projectId + "." + DATASET + "." + EVENTS_TABLE + "`";

async function initLedger() {
  await bq.query("CREATE TABLE IF NOT EXISTS " + ledgerRef() +
    " (name STRING NOT NULL, loadedAt TIMESTAMP NOT NULL, eventRows INT64, source STRING) CLUSTER BY name");
  log("ledger table ready: " + DATASET + "." + LEDGER_TABLE);
}

// Of these names, which are already in the ledger? (parameter arrays let BigQuery prune the clustered table)
async function alreadyLoaded(names) {
  const done = new Set();
  for (let i = 0; i < names.length; i += 10000) {
    const [rows] = await bq.query({
      query: "SELECT name FROM " + ledgerRef() + " WHERE name IN UNNEST(@names)",
      params: { names: names.slice(i, i + 10000) }, types: { names: ["STRING"] }
    });
    for (const r of rows) done.add(r.name);
  }
  return done;
}

// ---------- the atomic chunk load ----------
function chunkScript() {
  return [
    // Names not already in the ledger (parameter array lets BigQuery prune the clustered ledger).
    "DECLARE todo ARRAY<STRING> DEFAULT (SELECT ARRAY_AGG(n) FROM UNNEST(@todo) n WHERE n NOT IN (SELECT name FROM " + ledgerRef() + " WHERE name IN UNNEST(@todo)));",
    "DECLARE inserted INT64 DEFAULT 0;",
    "BEGIN TRANSACTION;",
    "INSERT INTO " + eventsRef() + " (" + EVENT_COLUMNS.map((c) => c[0]).join(", ") + ")",
    "SELECT " + EVENT_COLUMNS.map((c) => c[0]).join(", ") + " FROM ext WHERE " + NAME_OF_FILE + " IN UNNEST(IFNULL(todo, []));",
    "SET inserted = @@row_count;",
    "INSERT INTO " + ledgerRef() + " (name, loadedAt, eventRows, source)",
    "SELECT " + NAME_OF_FILE + ", CURRENT_TIMESTAMP(), COUNT(*), 'run' FROM ext WHERE " + NAME_OF_FILE + " IN UNNEST(IFNULL(todo, [])) GROUP BY 1;",
    "COMMIT TRANSACTION;",
    "SELECT ARRAY_LENGTH(IFNULL(todo, [])) AS filesLoaded, inserted AS eventRows;"
  ].join("\n");
}

async function loadChunk(names) {
  const jobId = "loader_v2_" + crypto.createHash("sha1").update(names.slice().sort().join("\n")).digest("hex").slice(0, 24) + "_" + Date.now();
  const [job] = await bq.createQueryJob({
    jobId,
    query: chunkScript(),
    params: { todo: names }, types: { todo: ["STRING"] },
    tableDefinitions: {
      ext: {
        sourceUris: names.map((n) => "gs://" + BUCKET + "/" + PREFIX + n),
        sourceFormat: "NEWLINE_DELIMITED_JSON",
        schema: { fields: EVENT_COLUMNS.map(([name, type]) => ({ name, type })) },
        ignoreUnknownValues: true,
        maxBadRecords: 1000
      }
    },
    labels: { loader: "v2" }
  });
  const [rows] = await job.getQueryResults();
  return rows[0] || { filesLoaded: 0, eventRows: 0 };
}

// ---------- modes ----------
async function seed() {
  const before = argValue("--before") || (await readJson(V1_CHECKPOINT_PATH, {})).lastWatermark;
  if (!before) throw new Error("no cutoff: pass --before <ISO time> or provide the v1 checkpoint");
  const cutoff = new Date(before).getTime();
  log("seeding the ledger with every file created at or before " + before + (DRY ? " (dry run)" : ""));
  await initLedger();
  const names = [];
  await listPrefix(PREFIX, (f) => { if (new Date(f.metadata.timeCreated).getTime() <= cutoff) names.push(f.name.slice(PREFIX.length)); });
  log("found " + names.length + " files to record");
  if (DRY || names.length === 0) return;
  const [[existing]] = await bq.query("SELECT COUNT(*) AS n FROM " + ledgerRef() + " WHERE source = 'seed'");
  if (Number(existing.n) > 0 && !args.has("--force")) throw new Error("ledger already has " + existing.n + " seeded names; seeding twice would duplicate them (use --force only if you know why)");
  // Load job from a stream (not streaming inserts), generated lazily so 1.4M names don't sit in memory twice.
  const table = bq.dataset(DATASET).table(LEDGER_TABLE);
  const nowIso = new Date().toISOString();
  const { Readable } = require("stream");
  function* lines() { for (const n of names) yield JSON.stringify({ name: n, loadedAt: nowIso, eventRows: null, source: "seed" }) + "\n"; }
  await new Promise((resolve, reject) => {
    Readable.from(lines()).pipe(table.createWriteStream({ sourceFormat: "NEWLINE_DELIMITED_JSON", writeDisposition: "WRITE_APPEND" }))
      .on("error", reject).on("complete", resolve);
  });
  log("ledger seeded with " + names.length + " names");
}

async function run() {
  const full = args.has("--full");
  const state = await readJson(STATE_PATH, null) || { watermark: (await readJson(V1_CHECKPOINT_PATH, {})).lastWatermark || "1970-01-01T00:00:00.000Z", activePrefixes: [] };
  log("watermark " + state.watermark + (DRY ? " (dry run)" : ""));

  const { found, prefixes } = await collectCandidates(state, full);
  const all = [...found.keys()];
  const done = await alreadyLoaded(all);
  const todo = all.filter((n) => !done.has(n));
  log("candidates " + all.length + ", already in ledger " + done.size + ", to load " + todo.length);

  if (todo.length > MAX_FILES_PER_RUN) throw new Error("refusing to load " + todo.length + " files in one run (limit " + MAX_FILES_PER_RUN + "); investigate, or raise MAX_FILES_PER_RUN");
  if (DRY) { log("dry run: would load " + Math.min(todo.length, 5) + " of " + todo.length + " e.g. " + todo.slice(0, 3).join(", ")); return; }

  let files = 0, rows = 0;
  for (let i = 0; i < todo.length; i += CHUNK_SIZE) {
    const chunk = todo.slice(i, i + CHUNK_SIZE);
    const res = await loadChunk(chunk);            // atomic: events + ledger together, or nothing
    files += Number(res.filesLoaded); rows += Number(res.eventRows);
    log("chunk " + (i / CHUNK_SIZE + 1) + ": " + res.filesLoaded + " files, " + res.eventRows + " rows");
  }
  log("loaded " + files + " files, " + rows + " rows");

  // Scan hint for the next run: newest creation time seen, and the prefixes that still matter.
  const newest = Math.max(new Date(state.watermark).getTime(), ...found.values());
  const touched = new Set();
  for (const n of todo) { const k = n.lastIndexOf("_"); if (k > 0) touched.add(PREFIX + n.slice(0, k + 1)); } // never the bare PREFIX
  await writeJson(STATE_PATH, { watermark: new Date(newest).toISOString(), activePrefixes: full ? state.activePrefixes || [] : [...new Set([...prefixes.filter((p) => p !== PREFIX), ...touched])].slice(-6), lastRun: new Date().toISOString(), lastFiles: files, lastRows: rows });
}

(async () => {
  if (args.has("--init")) return initLedger();
  if (args.has("--seed")) return seed();
  return run();
})().catch((e) => { console.error("[bq-loader-v2] FATAL:", e.message); process.exit(1); });
