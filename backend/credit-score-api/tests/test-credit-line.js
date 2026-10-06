const { computeOffers } = require("../credit-line");
const assert = require("assert");
// A score payload as /credit-line passes it: tenure 15 = more than 180 days of track record.
const sc = (score, tier, path, tenure = 15) => ({ score, tier, path, components: [{ key: "tenure", points: tenure, max: 15 }] });
const tok = (code, usd, extra = {}) => ({ code, usdValue: usd, transferable: true, priceSource: "verified", ...extra });
const show = (label, r) => { console.log("\n"+label); for (const m of ["secured","unsecured","mix"]) { const o=r.offers[m]; console.log(" ", m.padEnd(10), o.eligible ? `limit $${o.limitUsd}  apr ${o.aprPct}%` : "ineligible: "+o.notes[0]); } console.log("  collateral market/lendable:", r.inputs.collateral.marketUsd, r.inputs.collateral.lendableUsd, "avg haircut", r.inputs.collateral.averageHaircut); };

// 1. Strong wallet, USDC + XLM + a USDC vault
let r = computeOffers({ score: sc(80, "A", "lending"), portfolio: { totals: { debtUsd: 0 }, tokens: [tok("USDC", 10000), tok("XLM", 4000)], positions: [{ type: "vault", transferable: true, assets: [{ code: "USDC", usdValue: 20000, priceSource: "verified" }] }] } });
show("A / 80, $10k USDC + $4k XLM + $20k vault", r);
// USDC 10000*.95=9500; XLM 4000*.65=2600; vault 20000*.95*.9=17100 => lendable 29200
assert.strictEqual(r.inputs.collateral.lendableUsd, 29200);
assert.strictEqual(r.offers.secured.limitUsd, Math.floor(29200 * 0.75));
assert.strictEqual(r.offers.unsecured.limitUsd, 100);            // tier A starter line
assert.ok(r.offers.unsecured.growsToUsd > 2500 && r.offers.unsecured.growsToUsd <= 10000);
assert.ok(r.offers.mix.limitUsd <= 29200 && r.offers.mix.limitUsd <= 30000);
// APR ordering: secured < mix < unsecured
assert.ok(r.offers.secured.aprPct < r.offers.mix.aprPct && r.offers.mix.aprPct < r.offers.unsecured.aprPct);

// 2. Same collateral, better score => lower APR, never higher
const hi = computeOffers({ score: sc(90, "A", "lending"), portfolio: { totals: { debtUsd: 0 }, tokens: [tok("USDC", 10000)], positions: [] } });
const lo = computeOffers({ score: sc(40, "B", "activity"), portfolio: { totals: { debtUsd: 0 }, tokens: [tok("USDC", 10000)], positions: [] } });
show("A/90 vs B/40 with $10k USDC (hi)", hi); show("(lo)", lo);
for (const m of ["secured","unsecured","mix"]) assert.ok(hi.offers[m].aprPct < lo.offers[m].aprPct, m + " apr should fall with score");

// 3. Tier C / no history: unsecured ineligible, secured still works with collateral
const c = computeOffers({ score: sc(0, "C", "no-history"), portfolio: { totals: { debtUsd: 0 }, tokens: [tok("USDC", 1000)], positions: [] } });
show("C / no-history, $1k USDC", c);
assert.strictEqual(c.offers.unsecured.eligible, false);
assert.strictEqual(c.offers.secured.eligible, true);

// 4. Non-transferable / clawback / unpriced handling
const t = computeOffers({ score: sc(50, "B", "activity"), portfolio: { totals: { debtUsd: 0 }, tokens: [tok("ICE", 5000, { transferable: false, priceSource: undefined }), tok("USDC", 1000, { clawback: true }), tok("MYSTERY", null, { priceSource: undefined })], positions: [{ type: "collateral", transferable: false, assets: [{ code: "USDC", usdValue: 9000, priceSource: "verified" }] }] } });
show("Non-transferable ICE + Blend collateral ignored; clawback USDC halved", t);
assert.strictEqual(t.inputs.collateral.lendableUsd, 475); // 1000*.95*.5
assert.strictEqual(t.inputs.collateral.excludedUsd, 14000);

// 5. Existing debt reduces secured capacity
const d = computeOffers({ score: sc(50, "B", "activity"), portfolio: { totals: { debtUsd: 5000 }, tokens: [tok("USDC", 10000)], positions: [] } });
assert.strictEqual(d.offers.secured.limitUsd, Math.floor(9500 * 0.75 - 5000));

// 6. Holdings unavailable
const n = computeOffers({ score: sc(60, "B", "activity"), portfolio: null });
show("holdings unavailable", n);
assert.strictEqual(n.offers.secured.eligible, false); assert.strictEqual(n.offers.mix.eligible, false); assert.strictEqual(n.offers.unsecured.eligible, false); // capacity unknown => no unsecured line

// 7. Limits respect caps
const big = computeOffers({ score: sc(100, "A", "lending"), portfolio: { totals: { debtUsd: 0 }, tokens: [tok("USDC", 10000000)], positions: [] } });
assert.strictEqual(big.offers.secured.limitUsd, 250000); assert.ok(big.offers.mix.limitUsd <= 30000); assert.ok(big.offers.unsecured.limitUsd <= 10000);
// 8. Unsecured is capped by what the wallet holds: busy but nearly empty wallet (the reported case)
const thin = computeOffers({ score: sc(60, "B", "activity"), portfolio: { totals: { debtUsd: 0 }, tokens: [tok("USDC", 227)], positions: [] } });
show("B / 60 holding $227", thin);
assert.strictEqual(thin.offers.unsecured.eligible, true);                // $227 holds enough for a $50-75 starter
assert.ok(thin.offers.unsecured.limitUsd >= 50 && thin.offers.unsecured.limitUsd <= 75);
const mid = computeOffers({ score: sc(60, "B", "activity"), portfolio: { totals: { debtUsd: 0 }, tokens: [tok("USDC", 900)], positions: [] } });
assert.ok(mid.offers.unsecured.limitUsd <= 75);                          // starter line, never the old $2,078
const rich = computeOffers({ score: sc(60, "B", "activity"), portfolio: { totals: { debtUsd: 0 }, tokens: [tok("USDC", 50000)], positions: [] } });
assert.ok(rich.offers.unsecured.limitUsd >= 50 && rich.offers.unsecured.limitUsd <= 75); // plenty of holdings: the starter line applies
assert.ok(rich.offers.unsecured.growsToUsd > 2000);
// non-transferable holdings still show capacity, debt reduces it
const nt = computeOffers({ score: sc(60, "B", "activity"), portfolio: { totals: { debtUsd: 1000 }, tokens: [tok("ICE", 3000, { transferable: false })], positions: [] } });
assert.ok(nt.offers.unsecured.limitUsd <= 75);
// 9. Capacity cap still bites below the starter line
const tiny = computeOffers({ score: sc(60, "B", "activity"), portfolio: { totals: { debtUsd: 0 }, tokens: [tok("USDC", 40)], positions: [] } });
assert.strictEqual(tiny.offers.unsecured.eligible, false);               // holds $40 < $50 minimum
const capped = computeOffers({ score: sc(60, "B", "activity"), portfolio: { totals: { debtUsd: 0 }, tokens: [tok("USDC", 60)], positions: [] } });
assert.strictEqual(capped.offers.unsecured.limitUsd, 60);                // capped at the $60 held, below the ~$68 starter

// 10. New wallets get secured credit only: tier B but a short track record, or tier C
const fresh = computeOffers({ score: sc(60, "B", "activity", 7), portfolio: { totals: { debtUsd: 0 }, tokens: [tok("USDC", 5000)], positions: [] } });
show("B / 60 but only ~1-3 months of history", fresh);
assert.strictEqual(fresh.offers.unsecured.eligible, false); assert.strictEqual(fresh.offers.mix.eligible, false); assert.strictEqual(fresh.offers.secured.eligible, true);
assert.ok(/track record/.test(fresh.offers.unsecured.notes[0]));
const edge = computeOffers({ score: sc(60, "B", "activity", 11), portfolio: { totals: { debtUsd: 0 }, tokens: [tok("USDC", 5000)], positions: [] } });
assert.strictEqual(edge.offers.unsecured.eligible, true); assert.strictEqual(edge.offers.mix.eligible, true);   // >90 days qualifies
const tierC = computeOffers({ score: sc(30, "C", "activity"), portfolio: { totals: { debtUsd: 0 }, tokens: [tok("USDC", 5000)], positions: [] } });
assert.strictEqual(tierC.offers.unsecured.eligible, false); assert.strictEqual(tierC.offers.mix.eligible, false); assert.strictEqual(tierC.offers.secured.eligible, true);
// a payload without components (cannot show a track record) is treated as new
const bare = computeOffers({ score: { score: 60, tier: "B", path: "activity" }, portfolio: { totals: { debtUsd: 0 }, tokens: [tok("USDC", 5000)], positions: [] } });
assert.strictEqual(bare.offers.unsecured.eligible, false);
console.log("\nall assertions passed");
