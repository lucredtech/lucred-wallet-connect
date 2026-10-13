const assert = require("assert");
const m = require("../monitor");
const att = require("../attestation");

const policy = { marginCallLtv: 0.85, liquidationLtv: 0.92, priceMaxAgeSec: 600, cureWindowSec: 600 };

// 1. Health math.
assert.strictEqual(m.healthFactor(1000, 0, 0.92), Infinity);
assert.ok(Math.abs(m.healthFactor(1000, 600, 0.92) - 1.5333) < 0.001);
assert.strictEqual(m.currentLtv(1000, 600), 0.6);

// 2. Assess thresholds.
assert.strictEqual(m.assess({ collateralUsd: 1000, debt: 600, priceAgeSec: 10 }, policy).state, "healthy");
assert.strictEqual(m.assess({ collateralUsd: 1000, debt: 860, priceAgeSec: 10 }, policy).state, "margincall");
assert.strictEqual(m.assess({ collateralUsd: 1000, debt: 930, priceAgeSec: 10 }, policy).state, "liquidatable");
assert.strictEqual(m.assess({ collateralUsd: 1000, debt: 930, priceAgeSec: 700 }, policy).state, "stale"); // stale prices never act

// 3. Liquidation gate: needs two breaches >= minGap apart; a healthy tick clears it.
const gate = new m.LiquidationGate(300);
assert.strictEqual(gate.observe("L", true, 1000), false, "first breach doesn't confirm");
assert.strictEqual(gate.observe("L", true, 1200), false, "second breach too soon (200s < 300s)");
assert.strictEqual(gate.observe("L", true, 1300), true, "breach 300s later confirms");
gate.observe("L", false, 1400); // clears
assert.strictEqual(gate.observe("L", true, 1400), false, "cleared timer restarts");

// 4. Webhook HMAC round-trip + tamper + replay window.
const secret = "whsec_test";
const body = JSON.stringify({ event: "margin_call", loanId: "ab" });
const now = 1_000_000;
const header = m.signWebhook(secret, body, now);
assert.strictEqual(m.verifyWebhook(secret, body, header, now), true);
assert.strictEqual(m.verifyWebhook(secret, body + "x", header, now), false, "tampered body rejected");
assert.strictEqual(m.verifyWebhook("wrong", body, header, now), false, "wrong secret rejected");
assert.strictEqual(m.verifyWebhook(secret, body, header, now + 10_000), false, "stale timestamp rejected");

// 5. Signed attestation verifies against the engine public key (same layout as the contract).
const engineKey = att.engineKeyFromSeed("07".repeat(32));
const pub = att.publicKeyRaw(engineKey);
const a = m.signAttestation(engineKey, { loanId: "04".repeat(32), kind: "liquidate", seq: 5, nowSec: now, ttlSec: 300, amount: 1000 });
assert.strictEqual(a.kindCode, 2);
assert.strictEqual(a.expiry, now + 300);
assert.strictEqual(
  att.verify({ loanId: "04".repeat(32), kind: 2, seq: 5, expiry: a.expiry, amount: 1000 }, Buffer.from(a.signature, "hex"), pub),
  true,
  "monitor-signed liquidate attestation verifies"
);

// 6. runOnce: a margin-call loan emits a margin_call attestation; a liquidatable loan only emits a
//    liquidate attestation on the SECOND confirming pass.
const loans = [
  { loanId: "01".repeat(32), collateralAmount: 1000, lastSeq: 0, status: "Active" },
];
const g2 = new m.LiquidationGate(300);
// Pass A: deeply underwater (ltv 0.95 > liq) -> pending, no attestation yet.
let acts = m.runOnce({ loans, observe: () => ({ collateralUsd: 1000, debt: 950, priceAgeSec: 5 }), policy, engineKey, gate: g2, nowSec: 1000 });
assert.strictEqual(acts[0].event, "liquidation_pending");
assert.ok(!acts[0].attestation, "no attestation on first breach");
// Pass B: still underwater, 300s later -> confirmed, attestation emitted.
acts = m.runOnce({ loans, observe: () => ({ collateralUsd: 1000, debt: 950, priceAgeSec: 5 }), policy, engineKey, gate: g2, nowSec: 1300 });
assert.strictEqual(acts[0].event, "liquidatable");
assert.ok(acts[0].attestation && acts[0].attestation.kindCode === 2, "liquidate attestation on confirm");

// margin call path
const g3 = new m.LiquidationGate(300);
acts = m.runOnce({ loans, observe: () => ({ collateralUsd: 1000, debt: 870, priceAgeSec: 5 }), policy, engineKey, gate: g3, nowSec: 1000 });
assert.strictEqual(acts[0].event, "margin_call");
assert.ok(acts[0].attestation && acts[0].attestation.kindCode === 3);

// 7. deliverWebhook retries then succeeds (injected fetch).
(async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return { ok: calls >= 2 }; };
  const r = await m.deliverWebhook("https://x", { event: "test" }, secret, { fetchImpl, nowSec: now, sleep: () => Promise.resolve() });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.attempts, 2, "retried once then succeeded");
  console.log("all monitor assertions passed");
})();
