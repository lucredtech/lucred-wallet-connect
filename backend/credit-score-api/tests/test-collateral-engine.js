const assert = require("assert");
const { buildCollateral, priceApr, POLICY } = require("../credit-line");
const { defindexCollateral, quote } = require("../collateral-engine");

// Builders matching portfolio.js output shapes.
const ua = (code, usd, extra = {}) => ({ code, contractId: "C" + code, amount: usd, usdValue: usd, priceSource: "verified", ...extra });
const dfPos = (pool, assets, extra = {}) => ({ protocol: "defindex", type: "vault", pool, lpToken: true, transferable: true, assets, ...extra });
const score = (s, tier = "A", path = "lending") => ({ wallet: "GTESTWALLET", score: s, tier, path, components: [{ key: "tenure", points: 15, max: 15 }] });

// A wallet with a $20k USDC DeFindex vault, plus noise that must be ignored:
// a plain token, a non-transferable Blend position, and a non-DeFindex (Aquarius) vault.
const portfolio = {
  wallet: "GTESTWALLET",
  totals: { debtUsd: 0 },
  tokens: [ua("USDC", 10000)],
  positions: [
    dfPos("CVAULTUSDC", [ua("USDC", 20000)]),
    { protocol: "blend", type: "collateral", pool: "CBLEND", transferable: false, assets: [ua("USDC", 9000)] },
    { protocol: "aquarius", type: "vault", pool: "CAQUA", transferable: true, assets: [ua("AQUA", 5000, { priceSource: "curated" })] }
  ]
};

// 1. Filter: only the DeFindex position is counted. USDC vault: 20000 * 0.95 (stable) * 0.90 (lpFactor) = 17100.
const col = defindexCollateral(portfolio, POLICY);
assert.strictEqual(col.vaults.length, 1, "only the defindex vault should count");
assert.strictEqual(col.vaults[0].shareToken, "CVAULTUSDC");
assert.strictEqual(col.marketUsd, 20000);
assert.strictEqual(col.lendableUsd, 17100);
assert.strictEqual(col.averageHaircut, 0.15); // buildCollateral rounds to 2dp (1 - 17100/20000 = 0.145 -> 0.15)

// 2. Parity: defindexCollateral == buildCollateral on the same DeFindex-only sub-portfolio.
const parity = buildCollateral({ tokens: [], positions: [dfPos("CVAULTUSDC", [ua("USDC", 20000)])] }, POLICY);
assert.strictEqual(col.lendableUsd, parity.lendableUsd, "lendable must match buildCollateral");
assert.strictEqual(col.marketUsd, parity.marketUsd, "market must match buildCollateral");

// 3. Advance: share of MARKET value, capped at lendable. rate 0.60 -> min(20000*0.60, 17100) = 12000.
const q = quote({ portfolio, score: score(80), structure: "open_ended" }, POLICY);
assert.strictEqual(q.eligible, true);
assert.strictEqual(q.advance.rate, 0.60);
assert.strictEqual(q.advance.principalUsd, 12000);
assert.ok(q.advance.principalUsd <= q.collateral.lendableUsd, "principal must not exceed lendable");
assert.ok(q.advance.rate >= POLICY.dfCredit.advance.minRate && q.advance.rate <= POLICY.dfCredit.advance.maxRate);
assert.strictEqual(q.disbursement.asset, "USDC");
assert.strictEqual(q.advance.principalAmount, "12000.0000000");

// 4. APR equals the existing indicative SECURED rate for the same collateral/score.
const expectedApr = priceApr("secured", 80, q.collateral, POLICY).apr;
assert.strictEqual(q.terms.apr, expectedApr, "APR should equal the secured priceApr");

// 5. APR is monotonic non-increasing in score.
const qHi = quote({ portfolio, score: score(95), structure: "open_ended" }, POLICY);
const qLo = quote({ portfolio, score: score(40, "B", "activity"), structure: "open_ended" }, POLICY);
assert.ok(qHi.terms.aprPct <= qLo.terms.aprPct, "higher score should not cost more");

// 6. Deterministic for the same inputs (ignoring the asOf timestamp).
const q2 = quote({ portfolio, score: score(80), structure: "open_ended" }, POLICY);
assert.strictEqual(q.advance.principalUsd, q2.advance.principalUsd);
assert.strictEqual(q.terms.apr, q2.terms.apr);

// 7. Fixed-term records the term + maturity; default termAdjust is a no-op so APR matches open-ended.
const qFixed = quote({ portfolio, score: score(80), structure: "fixed_term", termDays: 90 }, POLICY);
assert.strictEqual(qFixed.terms.structure, "fixed_term");
assert.strictEqual(qFixed.terms.termDays, 90);
assert.ok(qFixed.terms.maturityDate, "fixed term should set a maturity date");
assert.strictEqual(qFixed.terms.apr, q.terms.apr, "no term adjust configured -> same APR");
assert.strictEqual(q.terms.maturityDate, null, "open-ended has no maturity");

// 8. Projected-debt preview grows with time (open-ended interest accrual).
assert.ok(q.projectedDebt.d30 < q.projectedDebt.d90 && q.projectedDebt.d90 < q.projectedDebt.d365);
assert.ok(q.projectedDebt.d30 >= q.advance.principalUsd);

// 9. Multi-vault wallet: both counted, totals are the sum.
const multi = quote({ portfolio: { wallet: "GX", totals: { debtUsd: 0 }, tokens: [], positions: [dfPos("CV1", [ua("USDC", 10000)]), dfPos("CV2", [ua("USDC", 5000)])] }, score: score(70), structure: "open_ended" }, POLICY);
assert.strictEqual(multi.collateral.vaults.length, 2);
assert.strictEqual(multi.collateral.marketUsd, 15000);
assert.strictEqual(multi.collateral.lendableUsd, buildCollateral({ tokens: [], positions: [dfPos("CV1", [ua("USDC", 10000)]), dfPos("CV2", [ua("USDC", 5000)])] }, POLICY).lendableUsd);

// 10. No DeFindex position -> ineligible (not an error).
const none = quote({ portfolio: { wallet: "GY", totals: { debtUsd: 0 }, tokens: [ua("USDC", 5000)], positions: [] }, score: score(80) }, POLICY);
assert.strictEqual(none.eligible, false);
assert.ok(/DeFindex/.test(none.reason));

// 11. Holdings unavailable -> ineligible with a clear reason.
const noHoldings = quote({ portfolio: null, score: score(80) }, POLICY);
assert.strictEqual(noHoldings.eligible, false);

// 12. eligibleVaults allowlist restricts which vaults count.
const restricted = { ...POLICY, dfCredit: { ...POLICY.dfCredit, eligibleVaults: ["CV1"] } };
const onlyCV1 = quote({ portfolio: { wallet: "GZ", totals: { debtUsd: 0 }, tokens: [], positions: [dfPos("CV1", [ua("USDC", 10000)]), dfPos("CV2", [ua("USDC", 5000)])] }, score: score(70) }, restricted);
assert.strictEqual(onlyCV1.collateral.vaults.length, 1);
assert.strictEqual(onlyCV1.collateral.vaults[0].shareToken, "CV1");

// 13. A volatile-underlying vault is still eligible ("any priced vault") and valued via its haircut.
const xlmVault = quote({ portfolio: { wallet: "GV", totals: { debtUsd: 0 }, tokens: [], positions: [dfPos("CVXLM", [ua("XLM", 10000)])] }, score: score(80) }, POLICY);
// XLM: 10000 * 0.65 (major haircut 0.35) * 0.90 = 5850 lendable.
assert.strictEqual(xlmVault.eligible, true);
assert.strictEqual(xlmVault.collateral.lendableUsd, 5850);
assert.ok(xlmVault.advance.principalUsd <= 5850);

console.log("all collateral-engine assertions passed");
