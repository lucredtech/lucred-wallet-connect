const { computeOffers } = require("../credit-line");
const assert = require("assert");
const tok = (code, usd, extra = {}) => ({ code, usdValue: usd, transferable: true, priceSource: "verified", ...extra });
const show = (label, r) => { console.log("\n"+label); for (const m of ["secured","unsecured","mix"]) { const o=r.offers[m]; console.log(" ", m.padEnd(10), o.eligible ? `limit $${o.limitUsd}  apr ${o.aprPct}%` : "ineligible: "+o.notes[0]); } console.log("  collateral market/lendable:", r.inputs.collateral.marketUsd, r.inputs.collateral.lendableUsd, "avg haircut", r.inputs.collateral.averageHaircut); };

// 1. Strong wallet, USDC + XLM + a USDC vault
let r = computeOffers({ score: { score: 80, tier: "A", path: "lending" }, portfolio: { totals: { debtUsd: 0 }, tokens: [tok("USDC", 10000), tok("XLM", 4000)], positions: [{ type: "vault", transferable: true, assets: [{ code: "USDC", usdValue: 20000, priceSource: "verified" }] }] } });
show("A / 80, $10k USDC + $4k XLM + $20k vault", r);
// USDC 10000*.95=9500; XLM 4000*.65=2600; vault 20000*.95*.9=17100 => lendable 29200
assert.strictEqual(r.inputs.collateral.lendableUsd, 29200);
assert.strictEqual(r.offers.secured.limitUsd, Math.floor(29200 * 0.75));
assert.ok(r.offers.unsecured.limitUsd > 2500 && r.offers.unsecured.limitUsd <= 10000);
assert.ok(r.offers.mix.limitUsd <= 29200 && r.offers.mix.limitUsd <= 30000);
// APR ordering: secured < mix < unsecured
assert.ok(r.offers.secured.aprPct < r.offers.mix.aprPct && r.offers.mix.aprPct < r.offers.unsecured.aprPct);

// 2. Same collateral, better score => lower APR, never higher
const hi = computeOffers({ score: { score: 90, tier: "A", path: "lending" }, portfolio: { totals: { debtUsd: 0 }, tokens: [tok("USDC", 10000)], positions: [] } });
const lo = computeOffers({ score: { score: 40, tier: "B", path: "activity" }, portfolio: { totals: { debtUsd: 0 }, tokens: [tok("USDC", 10000)], positions: [] } });
show("A/90 vs B/40 with $10k USDC (hi)", hi); show("(lo)", lo);
for (const m of ["secured","unsecured","mix"]) assert.ok(hi.offers[m].aprPct < lo.offers[m].aprPct, m + " apr should fall with score");

// 3. Tier C / no history: unsecured ineligible, secured still works with collateral
const c = computeOffers({ score: { score: 0, tier: "C", path: "no-history" }, portfolio: { totals: { debtUsd: 0 }, tokens: [tok("USDC", 1000)], positions: [] } });
show("C / no-history, $1k USDC", c);
assert.strictEqual(c.offers.unsecured.eligible, false);
assert.strictEqual(c.offers.secured.eligible, true);

// 4. Non-transferable / clawback / unpriced handling
const t = computeOffers({ score: { score: 50, tier: "B", path: "activity" }, portfolio: { totals: { debtUsd: 0 }, tokens: [tok("ICE", 5000, { transferable: false, priceSource: undefined }), tok("USDC", 1000, { clawback: true }), tok("MYSTERY", null, { priceSource: undefined })], positions: [{ type: "collateral", transferable: false, assets: [{ code: "USDC", usdValue: 9000, priceSource: "verified" }] }] } });
show("Non-transferable ICE + Blend collateral ignored; clawback USDC halved", t);
assert.strictEqual(t.inputs.collateral.lendableUsd, 475); // 1000*.95*.5
assert.strictEqual(t.inputs.collateral.excludedUsd, 14000);

// 5. Existing debt reduces secured capacity
const d = computeOffers({ score: { score: 50, tier: "B", path: "activity" }, portfolio: { totals: { debtUsd: 5000 }, tokens: [tok("USDC", 10000)], positions: [] } });
assert.strictEqual(d.offers.secured.limitUsd, Math.floor(9500 * 0.75 - 5000));

// 6. Holdings unavailable
const n = computeOffers({ score: { score: 60, tier: "B", path: "activity" }, portfolio: null });
show("holdings unavailable", n);
assert.strictEqual(n.offers.secured.eligible, false); assert.strictEqual(n.offers.mix.eligible, false); assert.strictEqual(n.offers.unsecured.eligible, true);

// 7. Limits respect caps
const big = computeOffers({ score: { score: 100, tier: "A", path: "lending" }, portfolio: { totals: { debtUsd: 0 }, tokens: [tok("USDC", 10000000)], positions: [] } });
assert.strictEqual(big.offers.secured.limitUsd, 250000); assert.ok(big.offers.mix.limitUsd <= 30000); assert.ok(big.offers.unsecured.limitUsd <= 10000);
console.log("\nall assertions passed");
