// Fraud / ladder-gaming monitor for the LCRD credit-line pool (TESTNET).
//
// The on-chain contract already enforces hard guards (≥50% utilization, ≥21-day hold, ≤1 ladder step
// per 30 days, 90-day pause after a write-off). This service catches the patterns that slip *through*
// those guards — borrowers who technically qualify but behave like wash-cyclers or a sybil cluster —
// and (optionally) freezes them via the underwriter key.
//
// It reconstructs each borrower's cycles from the pool's own events (borrowed / repaid / line_set /
// cycle), scores the behaviour, and flags on a repeated signature confirmed across ≥2 polls. Freezing
// a real user is harmful, so DRY_RUN is the DEFAULT: it logs + alerts but does not freeze until an
// operator sets DRY_RUN=false. State persists across restarts so history accrues beyond the RPC's
// ~24h event-retention window.
//
// Secrets: the underwriter seed comes from UNDERWRITER_SECRET or UNDERWRITER_SECRET_FILE, never args.
// Testnet only; mock tokens, no real value.
const {
  rpc, Keypair, TransactionBuilder, Contract, Networks, xdr, scValToNative, nativeToScVal, Address,
} = require("@stellar/stellar-sdk");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const RPC = process.env.RPC_URL || "https://soroban-testnet.stellar.org";
const POOL = process.env.POOL_ID;
const SECRET = process.env.UNDERWRITER_SECRET
  || (process.env.UNDERWRITER_SECRET_FILE && fs.readFileSync(process.env.UNDERWRITER_SECRET_FILE, "utf8").trim());
const POLL_MS = Number(process.env.POLL_MS || 30000);
// Seed window must stay INSIDE the RPC's event-retention horizon — a start ledger past it returns an
// empty page on testnet (not an error). ~8h is safely inside; the monitor then accrues forward via the
// cursor and persists state, so long-horizon (21-day) cycle history builds up over time regardless.
const LOOKBACK = Number(process.env.LOOKBACK_LEDGERS || 6000);
const STATE = process.env.STATE_FILE || path.join(__dirname, "state.json");
const DRY_RUN = process.env.DRY_RUN !== "false"; // enforce only when explicitly disabled
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

// Detection thresholds (match the contract's floors; a wash-cycler hugs them).
const DAY = 86400;
const MIN_HOLD = Number(process.env.MIN_HOLD_DAYS || 21) * DAY;
const HOLD_HUG = Number(process.env.HOLD_HUG_DAYS || 3) * DAY;      // "right at" the 21-day floor
const UTIL_FLOOR = Number(process.env.UTIL_FLOOR_PCT || 50) / 100;  // 50%
const UTIL_HUG = Number(process.env.UTIL_HUG_PCT || 10) / 100;      // within +10% of the floor
const WASH_CYCLES_TO_FLAG = Number(process.env.WASH_CYCLES_TO_FLAG || 2);
const SYBIL_CLUSTER = Number(process.env.SYBIL_CLUSTER || 4);       // ≥N borrowers cycling in lockstep
const CONFIRM_OBSERVATIONS = Number(process.env.CONFIRM_OBSERVATIONS || 2);

if (!POOL) { console.error("FATAL: set POOL_ID"); process.exit(1); }
if (!DRY_RUN && !SECRET) { console.error("FATAL: enforcement on but no UNDERWRITER_SECRET"); process.exit(1); }

const server = new rpc.Server(RPC);
const kp = SECRET ? Keypair.fromSecret(SECRET) : null;
const NET = Networks.TESTNET;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString(), ...a);
const toScVal = (x) => (typeof x === "string" ? xdr.ScVal.fromXDR(x, "base64") : x);

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE, "utf8")); }
  catch { return { cursor: null, startLedger: null, borrowers: {}, frozen: {}, lockstep: {} }; }
}
function saveState(s) { fs.writeFileSync(STATE, JSON.stringify(s)); }

function borrower(state, addr) {
  if (!state.borrowers[addr]) {
    state.borrowers[addr] = {
      limit: 0, outstanding: 0,
      cycleStart: 0, cyclePeak: 0, externalPayerThisCycle: false,
      washCycles: 0, totalCycles: 0, draws: 0, repays: 0,
      candidateStreak: 0, flaggedAt: 0,
    };
  }
  return state.borrowers[addr];
}

// Freeze a borrower's line via the underwriter. `freeze` also zeroes their ladder progress on-chain.
async function freeze(addr) {
  const account = await server.getAccount(kp.publicKey());
  const tx = new TransactionBuilder(account, { fee: "1000000", networkPassphrase: NET })
    .addOperation(new Contract(POOL).call("freeze", new Address(addr).toScVal()))
    .setTimeout(60).build();
  const prepared = await server.prepareTransaction(tx);
  prepared.sign(kp);
  const sent = await server.sendTransaction(prepared);
  if (sent.status === "ERROR") throw new Error("submit " + JSON.stringify(sent.errorResult));
  let got = await server.getTransaction(sent.hash);
  const t0 = Date.now();
  while (got.status === "NOT_FOUND" && Date.now() - t0 < 40000) { await sleep(1500); got = await server.getTransaction(sent.hash); }
  if (got.status !== "SUCCESS") throw new Error("tx " + got.status);
  return sent.hash;
}

async function alert(payload) {
  if (!WEBHOOK_URL) return;
  try {
    const body = JSON.stringify(payload);
    const headers = { "content-type": "application/json" };
    if (WEBHOOK_SECRET) headers["x-lcrd-signature"] = crypto.createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex");
    await fetch(WEBHOOK_URL, { method: "POST", headers, body });
  } catch (e) { log("webhook failed", String(e && e.message || e)); }
}

// Close out a cycle (outstanding hit 0) and judge whether it looks like wash-cycling.
function closeCycle(b, ts, state, addr) {
  if (b.cycleStart === 0) return;
  const duration = ts - b.cycleStart;
  const util = b.limit > 0 ? b.cyclePeak / b.limit : 0;
  const hugsHold = duration >= MIN_HOLD && duration <= MIN_HOLD + HOLD_HUG;
  const hugsUtil = util >= UTIL_FLOOR && util <= UTIL_FLOOR + UTIL_HUG;
  const washLike = hugsHold && hugsUtil && !b.externalPayerThisCycle; // self-funded, minimal, robotic
  b.totalCycles += 1;
  if (washLike) b.washCycles += 1;
  // lockstep/sybil: bucket cycle completions by hour; many distinct borrowers in a bucket = cluster
  const bucket = String(Math.floor(ts / 3600));
  const set = new Set(state.lockstep[bucket] || []);
  set.add(addr);
  state.lockstep[bucket] = [...set];
  b.cycleStart = 0; b.cyclePeak = 0; b.externalPayerThisCycle = false;
}

function applyEvent(state, sym, addr, val, ts) {
  const b = borrower(state, addr);
  if (sym === "line_set") { b.limit = Number(val[0]); return; }      // [limit, score, tier, apr, ref]
  if (sym === "secured") { b.limit = Number(val[0]); return; }       // [cap, apr]
  if (sym === "cycle") { if (val[2] != null) b.limit = Number(val[2]); return; } // [cycles, apr, limit]
  if (sym === "borrowed") {
    const amt = Number(val);
    b.outstanding += amt; b.draws += 1;
    if (b.cycleStart === 0) b.cycleStart = ts;
    if (b.outstanding > b.cyclePeak) b.cyclePeak = b.outstanding;
    return;
  }
  if (sym === "repaid") {                                            // [payer, to_interest, to_principal]
    const payer = typeof val[0] === "string" ? val[0] : "";
    const toPrincipal = Number(val[2] || 0);
    if (payer && payer !== addr) b.externalPayerThisCycle = true;    // a 3rd-party payer is less wash-like
    b.outstanding = Math.max(0, b.outstanding - toPrincipal); b.repays += 1;
    if (b.outstanding === 0) closeCycle(b, ts, state, addr);
    return;
  }
}

// After folding in new events, decide who to flag/freeze.
async function evaluate(state) {
  // Which hourly buckets show lockstep sybil behaviour?
  const sybilAddrs = new Set();
  for (const bucket of Object.keys(state.lockstep)) {
    const addrs = state.lockstep[bucket] || [];
    if (addrs.length >= SYBIL_CLUSTER) addrs.forEach((a) => sybilAddrs.add(a));
  }
  for (const [addr, b] of Object.entries(state.borrowers)) {
    if (state.frozen[addr]) continue;
    const reasons = [];
    if (b.washCycles >= WASH_CYCLES_TO_FLAG) reasons.push(`${b.washCycles} wash-like cycles`);
    if (sybilAddrs.has(addr)) reasons.push("sybil lockstep cluster");
    const candidate = reasons.length > 0;
    b.candidateStreak = candidate ? b.candidateStreak + 1 : 0;
    if (candidate && b.candidateStreak >= CONFIRM_OBSERVATIONS && !b.flaggedAt) {
      b.flaggedAt = Date.now();
      log("FLAGGED", addr, "—", reasons.join("; "), DRY_RUN ? "(dry-run: not frozen)" : "(freezing)");
      await alert({ event: "fraud_flag", borrower: addr, reasons, dryRun: DRY_RUN, at: b.flaggedAt });
      if (!DRY_RUN) {
        try { const hash = await freeze(addr); state.frozen[addr] = { at: Date.now(), tx: hash, reasons }; log("FROZEN", addr, "tx", hash); }
        catch (e) { const m = String(e && e.message || e); log("freeze failed", addr, m); if (/#10|LineInactive/.test(m)) state.frozen[addr] = { at: Date.now(), already: true }; }
      }
    }
  }
}

async function tick(state) {
  if (!state.startLedger) {
    const latest = await server.getLatestLedger();
    state.startLedger = Math.max(1, latest.sequence - LOOKBACK);
    saveState(state);
  }
  const base = { filters: [{ type: "contract", contractIds: [POOL] }], limit: 100 };
  let req = state.cursor ? { ...base, cursor: state.cursor } : { ...base, startLedger: state.startLedger };
  for (;;) {
    const res = await server.getEvents(req);
    for (const ev of res.events || []) {
      let sym = ""; try { sym = scValToNative(toScVal(ev.topic[0])); } catch { continue; }
      let addr = ""; try { addr = scValToNative(toScVal(ev.topic[1])); } catch { /* some events have no addr */ }
      if (typeof addr !== "string" || !addr.startsWith("G")) continue;
      let val; try { val = scValToNative(toScVal(ev.value)); } catch { continue; }
      const ts = Number(ev.ledgerClosedAt ? Math.floor(new Date(ev.ledgerClosedAt).getTime() / 1000) : Date.now() / 1000);
      applyEvent(state, sym, addr, val, ts);
    }
    if (res.cursor) { state.cursor = res.cursor; }
    if (!res.events || res.events.length < 100) break; // caught up
    req = { ...base, cursor: state.cursor };
  }
  await evaluate(state);
  saveState(state);
}

async function main() {
  log(`fraud-monitor start — pool ${POOL} — ${DRY_RUN ? "DRY-RUN (alert only)" : "ENFORCING (will freeze)"} — underwriter ${kp ? kp.publicKey() : "none"}`);
  const state = loadState();
  for (;;) {
    try { await tick(state); } catch (e) { log("tick error", String(e && e.message || e)); }
    await sleep(POLL_MS);
  }
}
main();
