// Position monitor for dfToken-backed USDC loans (Stage B).
//
// Runs on a schedule: for each open loan it reads fresh collateral value + debt, computes health,
// and — guarded against stale prices and single-observation blips — decides whether to flag a margin
// call or authorize liquidation. Risk actions are authorized on-chain via engine attestations
// (see attestation.js) and surfaced to the partner via HMAC-signed webhooks.
//
// This module is pure/injectable so it can be unit-tested without a chain or network: the caller
// supplies the fresh observations, the clock, and (in tests) a fetch implementation.
const crypto = require("crypto");
const att = require("./attestation");

// Health factor = collateral value × liquidation LTV ÷ debt. >1 safe, <1 liquidatable. ∞ when debt-free.
function healthFactor(collateralUsd, debt, liquidationLtv) {
  if (debt <= 0) return Infinity;
  return (collateralUsd * liquidationLtv) / debt;
}
function currentLtv(collateralUsd, debt) {
  return collateralUsd > 0 ? debt / collateralUsd : Infinity;
}

// Assess one loan from a fresh observation. Never acts on stale prices.
// obs: { collateralUsd, debt, priceAgeSec }
function assess(obs, policy) {
  if (obs.priceAgeSec > policy.priceMaxAgeSec) {
    return { state: "stale", hf: null, ltv: null };
  }
  const ltv = currentLtv(obs.collateralUsd, obs.debt);
  const hf = healthFactor(obs.collateralUsd, obs.debt, policy.liquidationLtv);
  let state = "healthy";
  if (ltv >= policy.liquidationLtv) state = "liquidatable";
  else if (ltv >= policy.marginCallLtv) state = "margincall";
  return { state, hf, ltv };
}

// Liquidation requires TWO breaching observations at least `minGapSec` apart (both from fresh prices),
// so a single bad tick can never trigger a seizure. A non-breaching observation clears the timer.
class LiquidationGate {
  constructor(minGapSec) {
    this.minGapSec = minGapSec;
    this.firstBreach = new Map(); // loanId -> unix seconds of the first breach
  }
  // Returns true only when liquidation is confirmed (two breaches >= minGapSec apart).
  observe(loanId, breaching, nowSec) {
    if (!breaching) {
      this.firstBreach.delete(loanId);
      return false;
    }
    const first = this.firstBreach.get(loanId);
    if (first === undefined) {
      this.firstBreach.set(loanId, nowSec);
      return false;
    }
    return nowSec - first >= this.minGapSec;
  }
  clear(loanId) {
    this.firstBreach.delete(loanId);
  }
}

// Build a signed on-chain attestation for a risk action (kind: "margin_call" | "liquidate" | "release").
function signAttestation(engineKey, { loanId, kind, seq, nowSec, ttlSec, amount }) {
  const expiry = nowSec + ttlSec;
  const signature = att.sign({ loanId, kind, seq, expiry, amount }, engineKey);
  return { kind, kindCode: att.KIND[kind], seq, expiry, amount: String(amount), signature: signature.toString("hex") };
}

// HMAC-sign a webhook body (Stripe-style: header value `t=<unix>,v1=<hex hmac over "t.body">`).
function signWebhook(secret, bodyString, nowSec) {
  const t = Math.floor(nowSec);
  const v1 = crypto.createHmac("sha256", secret).update(`${t}.${bodyString}`).digest("hex");
  return `t=${t},v1=${v1}`;
}
function verifyWebhook(secret, bodyString, header, nowSec, toleranceSec = 300) {
  const m = /^t=(\d+),v1=([0-9a-f]+)$/.exec(header || "");
  if (!m) return false;
  const t = Number(m[1]);
  if (Math.abs(nowSec - t) > toleranceSec) return false; // replay window
  const expected = crypto.createHmac("sha256", secret).update(`${t}.${bodyString}`).digest("hex");
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(m[2], "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Deliver a webhook with exponential backoff. fetchImpl is injectable for tests.
async function deliverWebhook(url, bodyObj, secret, { fetchImpl = fetch, nowSec = Date.now() / 1000, retries = 4, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const body = JSON.stringify(bodyObj);
  const sig = signWebhook(secret, body, nowSec);
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json", "lcrd-signature": sig }, body });
      if (res.ok) return { ok: true, attempts: attempt + 1 };
      lastErr = new Error(`webhook ${res.status}`);
    } catch (e) {
      lastErr = e;
    }
    if (attempt < retries) await sleep(Math.min(250 * 2 ** attempt, 8000));
  }
  return { ok: false, attempts: retries + 1, error: lastErr && lastErr.message };
}

// Orchestrate one monitor pass. For each loan: assess, update the gate, and emit the actions to take
// (attestations to submit on-chain + webhook events to deliver). Side-effect-free: returns a plan.
function runOnce({ loans, observe, policy, engineKey, gate, nowSec, attestationTtlSec = 300 }) {
  const actions = [];
  for (const loan of loans) {
    const obs = observe(loan); // { collateralUsd, debt, priceAgeSec, collateralToken }
    const a = assess(obs, policy);
    if (a.state === "stale") { actions.push({ loanId: loan.loanId, event: "stale_price" }); continue; }

    if (a.state === "liquidatable") {
      const confirmed = gate.observe(loan.loanId, true, nowSec);
      if (confirmed) {
        const seize = loan.collateralAmount; // engine decides seize size; seize-all here, contract returns surplus
        const attestation = signAttestation(engineKey, { loanId: loan.loanId, kind: "liquidate", seq: loan.lastSeq + 1, nowSec, ttlSec: attestationTtlSec, amount: seize });
        actions.push({ loanId: loan.loanId, event: "liquidatable", hf: a.hf, attestation });
      } else {
        actions.push({ loanId: loan.loanId, event: "liquidation_pending", hf: a.hf });
      }
    } else if (a.state === "margincall") {
      gate.clear(loan.loanId);
      const attestation = signAttestation(engineKey, { loanId: loan.loanId, kind: "margin_call", seq: loan.lastSeq + 1, nowSec, ttlSec: attestationTtlSec, amount: nowSec + policy.cureWindowSec });
      actions.push({ loanId: loan.loanId, event: "margin_call", hf: a.hf, deadline: nowSec + policy.cureWindowSec, attestation });
    } else {
      // Healthy: clear any pending liquidation timer; cure a prior margin call.
      const wasBreaching = gate.firstBreach.has(loan.loanId);
      gate.clear(loan.loanId);
      if (wasBreaching || loan.status === "MarginCall") actions.push({ loanId: loan.loanId, event: "cured", hf: a.hf });
    }
  }
  return actions;
}

module.exports = { healthFactor, currentLtv, assess, LiquidationGate, signAttestation, signWebhook, verifyWebhook, deliverWebhook, runOnce };
