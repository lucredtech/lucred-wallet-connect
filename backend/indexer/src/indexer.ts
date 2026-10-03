import {
  listNewRawObjects,
  downloadObjectToMemory,
  decompressZstd,
  writeJsonlToGCS,
  deleteRawObject,
  readCheckpoint,
  writeCheckpoint,
  findLatestRawFolder
} from './gcs';
import { parseLedgerCloseMetaBatch } from './xdrParser';
import { PROTOCOL_REGISTRY } from './registry';
import { discoverAllDynamicPools } from './poolDiscovery';

const ENABLE_DYNAMIC_POOL_DISCOVERY = (process.env.ENABLE_DYNAMIC_POOL_DISCOVERY ?? 'true') === 'true';
const POOL_DISCOVERY_REFRESH_MS = Number(process.env.POOL_DISCOVERY_REFRESH_MS ?? 24 * 60 * 60 * 1000);

const RAW_BUCKET = requireEnv('RAW_BUCKET_NAME'); // bucket Galexie's config.toml exports into
// Comma-separated list, e.g. "raw/FCA0,raw/FCA1,raw/FCC8" - lets one instance
// cover an arbitrary GROUP of fine-grained shard prefixes without needing a
// separate container per prefix. Added 2026-09-25 to rebalance an uneven
// 15-shard deployment (some single-prefix shards turned out to hold 900K+
// files, others near zero) without exploding the container count - see
// project_parallel_indexer_deployment.md.
const RAW_PREFIXES = (process.env.RAW_PREFIX ?? '').split(',').map((p) => p.trim());
// Added 2026-10-01: replaces a static RAW_PREFIX guess with one that
// tracks wherever Galexie is CURRENTLY writing, forever, with no manual
// rebalancing. Confirmed on real fleet data this was a genuine problem, not
// a hypothetical one: 14 of 16 statically-assigned shards were polling
// permanently-exhausted ranges (the complement-based prefix only ever
// decreases as ledgers advance, so yesterday's "hot" prefix never becomes
// hot again), while the one assignment that still mattered was about to run
// out with nothing positioned to take over - a correctness gap, not just
// wasted ListObjects cost. See project_live_tip_dynamic_prefix memory.
// Mutually exclusive with RAW_PREFIX/RAW_PREFIXES above - sharding a
// historical backlog across many fixed prefixes is a different, legitimate
// use case this flag isn't for.
const LIVE_TIP_DYNAMIC_PREFIX = (process.env.LIVE_TIP_DYNAMIC_PREFIX ?? 'false') === 'true';
// How often to re-check for a folder rollover - deliberately much less
// frequent than POLL_INTERVAL_MS (a cheap but non-zero GCS list call each
// time; checking every poll cycle would add ~172,800 calls/month for a
// 15s interval, noticeable against the exact over-polling problem this
// feature exists to fix). A new ~64K-ledger folder is created roughly every
// few hours at current chain throughput, so checking every few minutes
// means, at worst, a few minutes of delay picking up a rollover - not
// 24h+/forever the way a missed static reassignment was.
const LIVE_TIP_FOLDER_CHECK_MS = Number(process.env.LIVE_TIP_FOLDER_CHECK_MS ?? 2 * 60 * 1000);
const OUTPUT_BUCKET = process.env.OUTPUT_BUCKET_NAME ?? RAW_BUCKET;
const OUTPUT_PREFIX = process.env.OUTPUT_PREFIX ?? 'extracted_logs/';
const CHECKPOINT_PATH = process.env.CHECKPOINT_PATH ?? '_indexer_checkpoint.json';
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 15_000);
const DELETE_RAW_AFTER_PROCESSING = (process.env.DELETE_RAW_AFTER_PROCESSING ?? 'true') === 'true';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

// How many raw objects to download/process at once. Measured directly on a
// real backfill: each file's download+decompress is ~650-1200ms, almost
// entirely spent waiting on the GCS round-trip, not CPU - one-at-a-time
// processing topped out around 1.3 files/sec, well under Galexie's ~4.3
// files/sec sustained export rate during a large backfill, so the raw
// backlog grew forever no matter how fairly listNewRawObjects picked which
// files to look at. Overlapping downloads fixes the actual bottleneck.
//
// Raised from an initial 30, then 80, once real multi-instance testing (6
// Galexie instances backfilling different ledger ranges in parallel into
// the same bucket) pushed aggregate production well past what either
// sustained. This is network-round-trip-bound, not CPU-bound (confirmed:
// the indexer container sits around 1-1.5 cores of usage regardless of
// this value, well under its host's real capacity) - consistent with the
// real ceiling being the underlying HTTP client's own connection-pool
// limit to storage.googleapis.com rather than anything this code controls
// directly, which is also why raising this further is a reasonable thing
// to try rather than assuming no further gain is possible.
const PROCESSING_CONCURRENCY = 150;

/** Runs `fn` over `items` with at most `concurrency` in flight at once. */
async function mapWithConcurrency<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  let index = 0;
  async function worker(): Promise<void> {
    while (index < items.length) {
      const item = items[index++];
      await fn(item);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
}

async function processOnce(
  rawPrefix: string,
  alreadyProcessed: Set<string>,
  pageToken: string | undefined
): Promise<{ eventCount: number; nextPageToken: string | undefined }> {
  const { files: candidates, nextPageToken } = await listNewRawObjects(RAW_BUCKET, rawPrefix, alreadyProcessed, pageToken);
  let totalEvents = 0;

  await mapWithConcurrency(candidates, PROCESSING_CONCURRENCY, async (file) => {
    try {
      // Downloaded straight into a Buffer and processed in memory; nothing
      // is ever written to local disk, so there is no tmpfs file to purge.
      const compressed = await downloadObjectToMemory(file);
      const rawXdr = decompressZstd(compressed);
      const events = parseLedgerCloseMetaBatch(rawXdr);

      if (events.length > 0) {
        const objectBaseName = file.name.replace(/\.xdr\.zst$/, '').replace(/\//g, '_');
        const jsonlPayload = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
        await writeJsonlToGCS(OUTPUT_BUCKET, OUTPUT_PREFIX, objectBaseName, jsonlPayload);
        console.log(`☁️  Wrote ${events.length} credit events from ${file.name} to gs://${OUTPUT_BUCKET}/${OUTPUT_PREFIX}${objectBaseName}.jsonl`);
        totalEvents += events.length;
      }

      if (DELETE_RAW_AFTER_PROCESSING) {
        await deleteRawObject(file);
      }
      alreadyProcessed.add(file.name);
    } catch (err) {
      // Leave the object in place (and out of the checkpoint) so the next
      // poll retries it, instead of silently dropping a ledger range.
      console.error(`Failed to process ${file.name}, will retry next poll:`, err);
    }
  });

  return { eventCount: totalEvents, nextPageToken };
}

/**
 * Runs the full dynamic-discovery sweep (Soroswap, Sushi, DeFindex, Aquarius
 * - see poolDiscovery.ts) and merges results into the live PROTOCOL_REGISTRY.
 * Called once at startup and again on a timer (POOL_DISCOVERY_REFRESH_MS)
 * from startDaemon, so new pools/vaults are picked up without a restart.
 * discoverAllDynamicPools() already never throws (one source's failure
 * doesn't lose the others); the try/catch here is just so a completely
 * unexpected error on a periodic run logs and gets skipped rather than
 * taking down the whole poll loop via an unhandled rejection.
 */
async function runDynamicPoolDiscovery(): Promise<void> {
  try {
    const discovered = await discoverAllDynamicPools();
    Object.assign(PROTOCOL_REGISTRY, discovered);
    console.log(`🔎 Registry now covers ${Object.keys(PROTOCOL_REGISTRY).length} contracts total`);
  } catch (err) {
    console.error('Dynamic pool discovery refresh failed, keeping existing registry:', err);
  }
}

/**
 * Self-rescheduling jittered loop (±20% of POOL_DISCOVERY_REFRESH_MS),
 * replacing the old fixed setInterval - added 2026-10-01 alongside the
 * startup jitter above, same reasoning: a fixed interval keeps whatever
 * relative offset a batch of containers started with forever, so a bulk
 * fleet redeploy (confirmed to happen repeatedly - see
 * project_parallel_indexer_deployment memory) permanently synchronizes
 * their refresh cycles right back together. Re-randomizing the delay each
 * cycle lets the fleet's discovery load drift apart over time instead of
 * staying locked in step.
 */
function scheduleNextPoolDiscovery(): void {
  const jitter = POOL_DISCOVERY_REFRESH_MS * 0.2 * (Math.random() * 2 - 1);
  setTimeout(async () => {
    await runDynamicPoolDiscovery();
    scheduleNextPoolDiscovery();
  }, Math.round(POOL_DISCOVERY_REFRESH_MS + jitter));
}

async function startDaemon(): Promise<void> {
  console.log(
    LIVE_TIP_DYNAMIC_PREFIX
      ? `🚀 Dynamic live-tip mode: tracking the current raw/ folder automatically, checked every ${LIVE_TIP_FOLDER_CHECK_MS}ms, polling every ${POLL_INTERVAL_MS}ms`
      : `🚀 Polling gs://${RAW_BUCKET}/{${RAW_PREFIXES.join(',')}} every ${POLL_INTERVAL_MS}ms for new Galexie exports`
  );

  // Factory-deployed pools (Soroswap pairs, Sushi pools) and factory-deployed
  // vaults (DeFindex) aren't fixed addresses - registry.ts can't list them
  // statically without going stale the moment a new one launches. Mutating
  // PROTOCOL_REGISTRY here (the same object instance xdrParser.ts imports)
  // extends it in place before the poll loop starts reading it.
  //
  // This used to run ONLY here, once, at process startup - meaning a pool or
  // vault created after a container's last restart was invisible until its
  // NEXT restart, which given some containers run 22+ hours (occasionally
  // days) between rebuilds is a real, unbounded staleness window. Confirmed
  // concretely 2026-09-30: the DeFindex factory alone had grown to 117 real
  // vaults, 94 of which a stale one-time-at-startup registry would have kept
  // missing indefinitely. Fixed by also re-running discovery on a timer -
  // Object.assign only ever ADDS/overwrites keys, never removes, so a
  // transient failure on a later run just leaves the registry as it was,
  // same never-throws safety discoverAllDynamicPools already has internally.
  if (ENABLE_DYNAMIC_POOL_DISCOVERY) {
    // Startup jitter (0-60s), added 2026-10-01: the fleet runs ~17 of these
    // containers, often (re)deployed in the same batch (see
    // project_parallel_indexer_deployment memory's rebalance history), so
    // without this every one of them hits mainnet.sorobanrpc.com's pool
    // discovery calls (up to ~750 total across Soroswap/Sushi/DeFindex/
    // Aquarius) in the same few seconds on every fleet-wide redeploy -
    // confirmed on real logs this was a major contributor to the 429
    // thundering-herd that left DeFindex vaults (MERU among others) missing
    // from multiple shards' registries fleet-wide. A random spread-out start
    // trades a few seconds of startup delay for not synchronizing the whole
    // fleet's discovery load into one burst.
    await sleep(Math.random() * 60_000);
    await runDynamicPoolDiscovery();
    scheduleNextPoolDiscovery();
  }

  const checkpoint = await readCheckpoint(OUTPUT_BUCKET, CHECKPOINT_PATH);
  const alreadyProcessed = new Set(checkpoint.processedObjects);

  // Carries each prefix's OWN listing cursor across cycles - each prefix is
  // an independent keyspace, so they can't share one cursor. Same reasoning
  // as the single-prefix case (see the long comment on listNewRawObjects in
  // gcs.ts): re-listing from the top every cycle can starve an older
  // backlog indefinitely. A prefix's cursor naturally resets to undefined
  // (start a fresh pass) once that prefix's contents are exhausted.
  // In dynamic mode this map gets a fresh single entry whenever the live
  // folder rolls over (see below) - starting that new prefix's cursor at
  // undefined is correct and intentional, not a bug: a brand-new folder
  // has nothing in it yet for any cursor to skip past.
  let currentPrefixes = RAW_PREFIXES;
  const pageTokens = new Map<string, string | undefined>(currentPrefixes.map((p) => [p, undefined]));
  let lastFolderCheck = 0;

  if (LIVE_TIP_DYNAMIC_PREFIX) {
    const initial = await findLatestRawFolder(RAW_BUCKET, 'raw/');
    if (initial) {
      currentPrefixes = [`raw/${initial}/`];
      pageTokens.set(currentPrefixes[0], undefined);
      console.log(`📍 Dynamic live-tip prefix: starting on ${currentPrefixes[0]}`);
    } else {
      console.error('LIVE_TIP_DYNAMIC_PREFIX is set but no raw/ folders were found - falling back to RAW_PREFIX');
    }
    lastFolderCheck = Date.now();
  }

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (LIVE_TIP_DYNAMIC_PREFIX && Date.now() - lastFolderCheck >= LIVE_TIP_FOLDER_CHECK_MS) {
      lastFolderCheck = Date.now();
      try {
        const latest = await findLatestRawFolder(RAW_BUCKET, 'raw/');
        const latestPrefix = latest ? `raw/${latest}/` : null;
        if (latestPrefix && !currentPrefixes.includes(latestPrefix)) {
          console.log(`📍 Live-tip folder rolled over: ${currentPrefixes.join(',')} -> ${latestPrefix}`);
          currentPrefixes = [latestPrefix];
          pageTokens.set(latestPrefix, undefined);
        }
      } catch (err) {
        console.error('Live-tip folder check failed, keeping current prefix:', err);
      }
    }

    // Prefixes are processed one at a time per cycle, not concurrently -
    // each already runs up to PROCESSING_CONCURRENCY (150) downloads in
    // parallel internally, and gcs.ts's https.globalAgent.maxSockets (200)
    // is a process-wide cap, not per-prefix, so running every prefix's own
    // 150-way batch at once would just contend for the same socket pool
    // instead of adding real throughput.
    for (const rawPrefix of currentPrefixes) {
      try {
        const { eventCount, nextPageToken } = await processOnce(rawPrefix, alreadyProcessed, pageTokens.get(rawPrefix));
        pageTokens.set(rawPrefix, nextPageToken);
        if (eventCount > 0) {
          await writeCheckpoint(OUTPUT_BUCKET, CHECKPOINT_PATH, {
            processedObjects: Array.from(alreadyProcessed)
          });
        }
      } catch (err) {
        console.error(`Poll cycle failed for prefix ${rawPrefix}:`, err);
      }
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

startDaemon().catch((err) => {
  console.error('Fatal error, exiting:', err);
  process.exit(1);
});
