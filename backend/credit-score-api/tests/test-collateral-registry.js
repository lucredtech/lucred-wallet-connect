const assert = require("assert");
const { POLICY } = require("../credit-line");
const { defindexCollateral, quote } = require("../collateral-engine");
const { supportedCollateral, getCollateralRegistry } = require("../collateral-registry");

// Builders matching portfolio.js output shapes (same as test-collateral-engine.js).
const ua = (code, usd, extra = {}) => ({ code, contractId: "C" + code, amount: usd, usdValue: usd, priceSource: "verified", ...extra });
const dfPos = (pool, assets, extra = {}) => ({ protocol: "defindex", type: "vault", pool, lpToken: true, transferable: true, assets, ...extra });
const score = (s) => ({ wallet: "GTESTWALLET", score: s, tier: "A", path: "lending", components: [{ key: "tenure", points: 15, max: 15 }] });

// A wallet holding two DeFindex vaults: one is in the supported registry, one is not.
const portfolio = {
  wallet: "GTESTWALLET",
  totals: { debtUsd: 0 },
  tokens: [],
  positions: [
    dfPos("CSUPPORTED", [ua("USDC", 20000)]),
    dfPos("CUNLISTED", [ua("USDC", 5000)]),
  ],
};

// A test registry: only CSUPPORTED is accepted, sized at 70% advance.
const testReg = {
  CSUPPORTED: { protocol: "defindex", kind: "vault", label: "Test USDC Vault", symbol: "tdUSDC", underlyingClass: "stable", advanceBps: 7000, liquidationLtvBps: 9000, enabled: true },
  CDISABLED: { protocol: "defindex", kind: "vault", label: "Paused", symbol: "x", underlyingClass: "stable", advanceBps: 7000, liquidationLtvBps: 9000, enabled: false },
};

// 1. Eligibility: only the registry-listed, enabled vault counts; the unlisted one is dropped.
const col = defindexCollateral(portfolio, POLICY, testReg);
assert.strictEqual(col.vaults.length, 1, "only the supported vault should count");
assert.strictEqual(col.vaults[0].shareToken, "CSUPPORTED");
assert.strictEqual(col.marketUsd, 20000, "unlisted vault's 5000 must be excluded");

// 2. Per-token metadata is attached from the registry.
assert.strictEqual(col.vaults[0].advanceRate, 0.70);
assert.strictEqual(col.vaults[0].liquidationLtv, 0.90);
assert.strictEqual(col.vaults[0].label, "Test USDC Vault");
assert.strictEqual(col.vaults[0].symbol, "tdUSDC");

// 3. Per-token sizing: principal uses the vault's own 70% advance, capped at its lendable.
//    market 20000, lendable = 20000*0.95*0.90 = 17100, min(20000*0.70, 17100) = 14000.
const q = quote({ portfolio, score: score(80), structure: "open_ended" }, POLICY, testReg);
assert.strictEqual(q.eligible, true);
assert.strictEqual(q.advance.principalUsd, 14000, "principal should use the per-vault 70% advance");
assert.strictEqual(q.advance.rate, 0.70, "blended rate should reflect the per-vault advance");

// 4. An advance above maxRate is clamped to the policy max (0.75), still capped at lendable.
const hiReg = { CSUPPORTED: { ...testReg.CSUPPORTED, advanceBps: 9500 } };
const qHi = quote({ portfolio, score: score(80), structure: "open_ended" }, POLICY, hiReg);
assert.strictEqual(qHi.advance.principalUsd, 15000, "0.95 clamps to maxRate 0.75 -> min(15000, 17100)");

// 5. Backward-compatible: with no registry, behaviour is the pre-registry "any priced" one (both vaults).
const colNoReg = defindexCollateral(portfolio, POLICY);
assert.strictEqual(colNoReg.vaults.length, 2, "no registry -> any priced defindex position is eligible");
assert.strictEqual(colNoReg.marketUsd, 25000);

// 6. supportedCollateral() exposes the active-network list with human-ready advance/liq rates.
const testnetList = supportedCollateral("testnet");
assert.ok(testnetList.length >= 2, "testnet should ship the DeFindex vault + the mock dfToken");
const dfUsdc = testnetList.find((c) => c.symbol === "dfUSDC");
assert.ok(dfUsdc, "the deployed DeFindex USDC vault should be in the testnet list");
assert.strictEqual(dfUsdc.advanceRate, 0.75);
assert.strictEqual(dfUsdc.liquidationLtv, 0.92);
assert.strictEqual(dfUsdc.kind, "vault");

// The escrow-flow mock dfToken: present, priced at par, with its faucet surfaced.
const dfTest = testnetList.find((c) => c.symbol === "dfTEST");
assert.ok(dfTest, "the mock dfToken should be in the testnet list");
assert.strictEqual(dfTest.priceSource, "par");
assert.strictEqual(dfTest.parUsd, 1);
assert.ok(dfTest.faucet && dfTest.faucet.startsWith("C"), "mock dfToken should carry its faucet address");

// 7. Mainnet is an empty placeholder today (filled in at launch) — must not throw.
assert.deepStrictEqual(getCollateralRegistry("mainnet"), {});
assert.deepStrictEqual(supportedCollateral("mainnet"), []);

console.log("all collateral-registry assertions passed");
