const assert = require("assert");
const fs = require("fs");
const { classicPoints } = require("../classic-activity");

const src = fs.readFileSync(__dirname + "/../index.js", "utf8");
const ctx = {};
new Function("ctx", "classicPoints", src.slice(src.indexOf("const CLOSE_EPSILON"), src.indexOf("// ---- reference data cache")) +
  "\nctx.scoreWalletBase = scoreWalletBase; ctx.computeDebtCycles = computeDebtCycles;")(ctx, classicPoints);

const ev = (o) => ({ userAddress: "GTEST", contractId: "C1", amount: 0, ...o });
const prices = { USDC: { usdRate: 1 }, AQUA: { usdRate: 0.0004 } };
const classic = { ageYears: 6, payments: 28000, trades: 19000, yearlyActivity: "high" };

function check(label, result) {
  assert.ok(Array.isArray(result.components), label + ": components present");
  for (const c of result.components) {
    assert.ok(c.points >= 0 && c.points <= c.max, `${label}: ${c.key} ${c.points} within 0..${c.max}`);
    assert.ok(c.label && c.explain && ["core", "income", "bonus"].includes(c.group), `${label}: ${c.key} has label/explain/group`);
  }
  return result.components;
}
const byKey = (cs, k) => cs.find((c) => c.key === k);

// --- activity path: component points add up to the raw score printed in the reasons line
const events = [];
for (let m = 1; m <= 6; m++) {
  events.push(ev({ protocolName: "soroswap", category: "amm_liquidity", eventType: "swap", blockCloseTime: `2026-0${m}-05T00:00:00Z`, amount: 10 }));
  events.push(ev({ protocolName: "aquarius", category: "amm_liquidity", eventType: "swap", blockCloseTime: `2026-0${m}-15T00:00:00Z`, amount: 10 }));
  events.push(ev({ protocolName: "blend", category: "lending_pool", eventType: "deposit", blockCloseTime: `2026-0${m}-25T00:00:00Z`, amount: 10 }));
}
const act = ctx.scoreWalletBase(events, [], prices, {}, classic);
const aCs = check("activity", act);
const rawFromReasons = Number(act.reasons[0].match(/raw (\d+(\.\d+)?)/)[1]);
assert.strictEqual(aCs.reduce((s, c) => s + c.points, 0), rawFromReasons, "activity components sum to raw");
assert.strictEqual(byKey(aCs, "classic").points, 5);
assert.strictEqual(byKey(aCs, "breadth").detail, "3 protocols");
for (const k of ["income", "distribution", "rewards"]) assert.strictEqual(byKey(aCs, k).group, "income");
assert.strictEqual(byKey(aCs, "income").amountUsd, null, "no yield activity -> no amount");
console.log("activity components OK:", aCs.map((c) => `${c.key} ${c.points}/${c.max}`).join(", "));

// --- income pills carry their dollar amounts
const incomeEvents = [
  ev({ protocolName: "defindex", category: "yield_savings", eventType: "deposit", blockCloseTime: "2026-01-10T00:00:00Z", amount: 100, assetCode: "USDC", contractId: "V1" }),
  ev({ protocolName: "defindex", category: "yield_savings", eventType: "withdraw", blockCloseTime: "2026-02-10T00:00:00Z", amount: 110, assetCode: "USDC", contractId: "V1" }),
  ev({ protocolName: "aquarius", category: "amm_liquidity", eventType: "claim_reward", blockCloseTime: "2026-02-11T00:00:00Z", amount: 5000, assetCode: "AQUA", contractId: "C9" }),
  ...events
];
const inc = ctx.scoreWalletBase(incomeEvents, [], prices, {}, null);
const iCs = check("income", inc);
assert.ok(Math.abs(byKey(iCs, "income").amountUsd - 10) < 1e-6, "realized yield $10");
assert.strictEqual(byKey(iCs, "income").amountLabel, "realized");
assert.ok(byKey(iCs, "rewards").amountUsd > 0, "rewards amount present");
assert.ok(!byKey(iCs, "classic"), "no classic pill without classic data");
console.log("income amounts OK");

// --- lending path
const lend = [
  ev({ protocolName: "blend", category: "lending_pool", eventType: "borrow", blockCloseTime: "2026-01-01T00:00:00Z", poolShareTokensAfter: 100 }),
  ev({ protocolName: "blend", category: "lending_pool", eventType: "repay", blockCloseTime: "2026-01-04T00:00:00Z", poolShareTokensAfter: 100 })
];
const cycles = ctx.computeDebtCycles(lend);
assert.strictEqual(cycles.length, 1);
const ln = ctx.scoreWalletBase(lend, cycles, prices, {}, classic);
const lCs = check("lending", ln);
assert.strictEqual(ln.path, "lending");
assert.strictEqual(byKey(lCs, "cyclecount").points, 4);
assert.strictEqual(byKey(lCs, "classic").max, 3);
assert.strictEqual(lCs.reduce((s, c) => s + c.points, 0), Number(ln.reasons[0].match(/raw (\d+(\.\d+)?)/)[1]));
console.log("lending components OK:", lCs.map((c) => `${c.key} ${c.points}/${c.max}`).join(", "));

// --- floor path
const fl = ctx.scoreWalletBase([ev({ protocolName: "blend", category: "lending_pool", eventType: "fn_call", blockCloseTime: "2026-01-05T00:00:00Z" })], [], prices, {}, null);
const fCs = check("floor", fl);
assert.strictEqual(fl.path, "floor"); assert.strictEqual(fCs.length, 1); assert.strictEqual(fCs[0].key, "floor");
console.log("ALL CHECKS PASSED");
