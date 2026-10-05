const assert = require("assert");
const fs = require("fs");
const { classicPoints, getClassicActivity } = require("../classic-activity");

// --- classicPoints thresholds and caps
const c = (ageYears, payments = 0, trades = 0, yearlyActivity = "high") => ({ ageYears, payments, trades, yearlyActivity });
assert.strictEqual(classicPoints(null, "activity").points, 0);
assert.strictEqual(classicPoints(c(0.1), "activity").points, 0);              // brand new
assert.strictEqual(classicPoints(c(0.3), "activity").points, 1);
assert.strictEqual(classicPoints(c(1.5), "activity").points, 2);
assert.strictEqual(classicPoints(c(3), "activity").points, 3);
assert.strictEqual(classicPoints(c(6), "activity").points, 4);                // age alone tops out at 4
assert.strictEqual(classicPoints(c(6, 28000, 19000), "activity").points, 5);  // + footprint = the cap
assert.strictEqual(classicPoints(c(6, 28000, 19000), "lending").points, 3);   // lending path cap
assert.strictEqual(classicPoints(c(6, 28000, 19000, "none"), "activity").points, 4); // dormant footprint doesn't count
assert.strictEqual(classicPoints(c(6, 10, 5), "activity").points, 4);         // a few payments isn't a footprint
assert.strictEqual(classicPoints({ ageYears: 6, payments: null, trades: null, yearlyActivity: null }, "activity").points, 4); // Horizon fallback: age only
console.log("classicPoints OK");

// --- effect on the score, using the real scoreWalletBase
const src = fs.readFileSync(__dirname + "/../index.js", "utf8");
const start = src.indexOf("const CLOSE_EPSILON");
const end = src.indexOf("// ---- reference data cache");
const ctx = {};
new Function("ctx", "classicPoints", src.slice(start, end) + "\nctx.scoreWalletBase = scoreWalletBase;")(ctx, classicPoints);
const ev = (o) => ({ userAddress: "GTEST", contractId: "C1", amount: 0, ...o });
const events = [];
for (let m = 1; m <= 6; m++) {
  events.push(ev({ protocolName: "soroswap", category: "amm_liquidity", eventType: "swap", blockCloseTime: `2026-0${m}-05T00:00:00Z`, amount: 10 }));
  events.push(ev({ protocolName: "aquarius", category: "amm_liquidity", eventType: "swap", blockCloseTime: `2026-0${m}-15T00:00:00Z`, amount: 10 }));
  events.push(ev({ protocolName: "blend", category: "lending_pool", eventType: "deposit", blockCloseTime: `2026-0${m}-25T00:00:00Z`, amount: 10 }));
}
const prices = { USDC: { usdRate: 1 } };
const without = ctx.scoreWalletBase(events, [], prices, {}, null);
const withClassic = ctx.scoreWalletBase(events, [], prices, {}, c(6, 28000, 19000));
console.log("activity path:", without.score, "->", withClassic.score, "|", withClassic.reasons[0].match(/classic[^,]*\[[^\]]*\]/)[0]);
assert.strictEqual(without.path, "activity"); assert.strictEqual(withClassic.path, "activity");
assert.ok(withClassic.score > without.score, "classic history should add something");
assert.ok(withClassic.score - without.score <= 12, "but only a bounded amount");
assert.ok(!/classic/.test(without.reasons[0]), "no classic term when there is no classic data");
assert.strictEqual(withClassic.tier, withClassic.score >= 67 ? "A" : "B");

// A wallet below the activity gate (floor path) gets nothing from classic history.
const few = ctx.scoreWalletBase([ev({ protocolName: "blend", category: "lending_pool", eventType: "fn_call", blockCloseTime: "2026-01-05T00:00:00Z" })], [], prices, {}, c(6, 28000, 19000));
assert.strictEqual(few.path, "floor"); assert.ok(few.score <= 33);
console.log("floor path unaffected OK");

// --- non-G addresses are skipped without any network call
getClassicActivity("CABC").then((r) => { assert.strictEqual(r, null); console.log("C address skipped OK"); console.log("ALL CHECKS PASSED"); });
