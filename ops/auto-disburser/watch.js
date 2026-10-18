// Auto-disburser for the Stage B collateral escrow (TESTNET).
//
// Watches the escrow contract's `deposit` events and, for each new loan in the Open state, submits
// the treasury-signed `disburse` — so borrowers who deposit collateral are funded automatically,
// without a human running the CLI each time. Idempotent: every loan id is recorded once disbursed
// (or once seen to be non-Open), and `disburse` itself guards `status == Open`, so retries are safe.
//
// Secrets: the treasury secret is read from TREASURY_SECRET (never hard-coded). Everything else is
// plain config. Testnet only; mock tokens, no real value.
const {
  rpc, Keypair, TransactionBuilder, Contract, Networks, xdr, scValToNative, nativeToScVal,
} = require("@stellar/stellar-sdk");
const fs = require("fs");
const path = require("path");

const RPC = process.env.RPC_URL || "https://soroban-testnet.stellar.org";
const ESCROW = process.env.ESCROW_ID;
// Treasury seed from TREASURY_SECRET, or a file named by TREASURY_SECRET_FILE (so a deployment can
// generate the key on the host and mount it — the secret never passes through env or args).
const SECRET = process.env.TREASURY_SECRET
  || (process.env.TREASURY_SECRET_FILE && fs.readFileSync(process.env.TREASURY_SECRET_FILE, "utf8").trim());
const POLL_MS = Number(process.env.POLL_MS || 10000);
const LOOKBACK = Number(process.env.LOOKBACK_LEDGERS || 500);
const STATE = process.env.STATE_FILE || path.join(__dirname, "state.json");

if (!ESCROW || !SECRET) {
  console.error("FATAL: set ESCROW_ID and TREASURY_SECRET in the environment");
  process.exit(1);
}

const server = new rpc.Server(RPC);
const kp = Keypair.fromSecret(SECRET);
const NET = Networks.TESTNET;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString(), ...a);

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE, "utf8")); } catch { return { cursor: null, startLedger: null, done: {} }; }
}
function saveState(s) { fs.writeFileSync(STATE, JSON.stringify(s)); }
// getEvents may return topic/value as xdr.ScVal objects or base64 strings depending on SDK version.
const toScVal = (x) => (typeof x === "string" ? xdr.ScVal.fromXDR(x, "base64") : x);

async function disburse(loanIdHex) {
  const account = await server.getAccount(kp.publicKey());
  const loanScVal = nativeToScVal(Buffer.from(loanIdHex, "hex"), { type: "bytes" });
  const tx = new TransactionBuilder(account, { fee: "1000000", networkPassphrase: NET })
    .addOperation(new Contract(ESCROW).call("disburse", loanScVal))
    .setTimeout(60)
    .build();
  const prepared = await server.prepareTransaction(tx); // simulates; throws if the loan is not Open
  prepared.sign(kp);
  const sent = await server.sendTransaction(prepared);
  if (sent.status === "ERROR") throw new Error("submit error " + JSON.stringify(sent.errorResult));
  let got = await server.getTransaction(sent.hash);
  const t0 = Date.now();
  while (got.status === "NOT_FOUND" && Date.now() - t0 < 40000) { await sleep(1500); got = await server.getTransaction(sent.hash); }
  if (got.status !== "SUCCESS") throw new Error("tx " + got.status);
  return sent.hash;
}

async function tick(state) {
  if (!state.startLedger) {
    const latest = await server.getLatestLedger();
    state.startLedger = Math.max(1, latest.sequence - LOOKBACK);
    saveState(state);
  }
  const base = { filters: [{ type: "contract", contractIds: [ESCROW] }], limit: 100 };
  const req = state.cursor ? { ...base, cursor: state.cursor } : { ...base, startLedger: state.startLedger };
  const res = await server.getEvents(req);
  for (const ev of res.events || []) {
    let sym = "";
    try { sym = scValToNative(toScVal(ev.topic[0])); } catch { /* not a symbol topic */ }
    if (sym !== "deposit") continue;
    let val;
    try { val = scValToNative(toScVal(ev.value)); } catch { continue; }
    const loanBuf = Array.isArray(val) ? val[0] : null; // (loan_id, collateral, principal)
    if (!loanBuf) continue;
    const loanHex = Buffer.from(loanBuf).toString("hex");
    if (state.done[loanHex]) continue;
    try {
      const hash = await disburse(loanHex);
      log("DISBURSED", loanHex, "tx", hash);
      state.done[loanHex] = { at: Date.now(), tx: hash };
    } catch (e) {
      const msg = String(e && e.message ? e.message : e);
      // Already funded / withdrawn / missing -> stop retrying this loan.
      if (/#8|#6|BadStatus|LoanMissing/.test(msg)) { state.done[loanHex] = { skipped: msg }; log("skip", loanHex, msg); }
      else log("disburse failed (will retry)", loanHex, msg);
    }
    saveState(state);
  }
  if (res.cursor) { state.cursor = res.cursor; saveState(state); }
}

async function main() {
  log("auto-disburser start — treasury", kp.publicKey(), "escrow", ESCROW, "rpc", RPC);
  const state = loadState();
  for (;;) {
    try { await tick(state); } catch (e) { log("tick error", String(e && e.message ? e.message : e)); }
    await sleep(POLL_MS);
  }
}
main();
