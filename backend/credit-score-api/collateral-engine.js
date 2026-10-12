// Collateral engine for dfToken-backed USDC credit.
//
// Stage A (this file, off-chain, demoable): value a wallet's DeFindex vault positions (the dfTokens
// it could pledge), compute an advance (50-75% of position value) and an APR, and return a terms
// object the user can review and accept. NO funds move and nothing is locked on-chain here.
//
// This is a SPECIALIZATION of the general collateral engine (see ~/.claude/plans/resilient-skipping-curry.md),
// narrowed to one collateral type (DeFindex share tokens) and one disbursed asset (USDC). It reuses the
// exact collateral math from credit-line.js (buildCollateral: per-class haircut + lpFactor) and the exact
// indicative APR (priceApr, model "secured") so the numbers line up with /credit-line's secured line.
//
// `attest`/`health` are stubs here; they become real in Stage B (the Soroban escrow + engine attestations),
// so the engine's surface matches the parent plan.
const { buildCollateral, priceApr, POLICY } = require("./credit-line");

const round2 = (n) => Math.round(n * 100) / 100;
const round4 = (n) => Math.round(n * 10000) / 10000;
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

const DISCLAIMER =
  "Indicative terms only. No funds move in this demo — nothing is locked and nothing is disbursed. " +
  "Not an offer of credit, not a credit decision and not financial advice. Figures use today's balances and prices and can change.";

// Filter a portfolio to its DeFindex vault positions and value just those as collateral, reusing
// buildCollateral so the haircut/lpFactor logic is identical to the main credit line. Returns an
// overall total plus a per-vault breakdown (each vault's share token is the collateral token).
function defindexCollateral(portfolio, policy = POLICY) {
  const positions = (((portfolio && portfolio.positions) || []).filter(
    (p) => p.protocol === "defindex" && p.type !== "debt" && p.transferable === true
  ));
  const allow = (policy.dfCredit && policy.dfCredit.eligibleVaults) || [];
  const eligible = allow.length ? positions.filter((p) => allow.includes(p.pool)) : positions;

  const overall = buildCollateral({ tokens: [], positions: eligible }, policy);
  const vaults = eligible
    .map((p) => {
      const one = buildCollateral({ tokens: [], positions: [p] }, policy);
      return {
        shareToken: p.pool,
        underlying: (p.assets || [])
          .filter((a) => a.usdValue !== null && a.usdValue !== undefined)
          .map((a) => ({ contractId: a.contractId || null, code: a.code || null, amount: a.amount, usdValue: round2(a.usdValue), priceSource: a.priceSource || null })),
        marketUsd: one.marketUsd,
        lendableUsd: one.lendableUsd,
        haircutPct: round2(one.averageHaircut * 100)
      };
    })
    .filter((v) => v.marketUsd > 0);

  return { vaults, marketUsd: overall.marketUsd, lendableUsd: overall.lendableUsd, averageHaircut: overall.averageHaircut };
}

// Compute the full quote/terms for a dfToken-backed USDC advance. Pure given the inputs + policy.
// structure: "open_ended" (default) | "fixed_term"; termDays only used for fixed_term.
function quote({ portfolio, score, structure, termDays }, policy = POLICY) {
  const cfg = policy.dfCredit;
  const wallet = (score && score.wallet) || (portfolio && portfolio.wallet) || null;
  const s = score && typeof score.score === "number" ? score.score : 0;
  const collateral = defindexCollateral(portfolio, policy);

  if (!collateral.vaults.length || collateral.lendableUsd <= 0) {
    return {
      version: cfg.version,
      policyVersion: policy.version,
      wallet,
      asOf: new Date().toISOString(),
      eligible: false,
      reason: !(portfolio && portfolio.positions)
        ? "Holdings couldn't be read, so DeFindex collateral can't be valued."
        : "No priced, transferable DeFindex vault position found for this wallet.",
      demo: true,
      disclaimer: DISCLAIMER
    };
  }

  // Structure + term.
  const structures = cfg.structures;
  const struct = structures.includes(structure) ? structure : "open_ended";
  let td = null;
  if (struct === "fixed_term") td = cfg.termDaysOptions.includes(Number(termDays)) ? Number(termDays) : cfg.termDaysOptions[0];

  // Advance: a share of the position's MARKET value (so the UI reads "X% of your position"),
  // hard-capped at the risk-adjusted lendable value (the haircut/lpFactor is a safety ceiling).
  const rate = clamp(cfg.advance.defaultRate, cfg.advance.minRate, cfg.advance.maxRate);
  const principalUsd = round2(Math.min(collateral.marketUsd * rate, collateral.lendableUsd));

  // APR = the existing indicative SECURED credit-line rate, plus an optional per-structure/term
  // adjustment (policy.dfCredit.termAdjust, empty = no-op until the team supplies real rate logic).
  const pricing = priceApr("secured", s, collateral, policy);
  const adj = struct === "open_ended" ? (cfg.termAdjust.open_ended || 0) : (cfg.termAdjust[td] || 0);
  const aprRaw = pricing.apr + adj;
  const apr = round4(clamp(aprRaw, policy.apr.min, policy.apr.max));

  // Simple-interest growth preview (the open-ended risk the user should see before accepting).
  const debtAfter = (days) => round2(principalUsd * (1 + apr * (days / 365)));

  return {
    version: cfg.version,
    policyVersion: policy.version,
    wallet,
    asOf: new Date().toISOString(),
    eligible: true,
    collateral,
    advance: {
      rate,
      minRate: cfg.advance.minRate,
      maxRate: cfg.advance.maxRate,
      principalUsd,
      principalAsset: { code: "USDC", contractId: null }, // resolved to a real contract id in Stage B
      principalAmount: principalUsd.toFixed(7)            // USDC is USD-pegged, 7dp
    },
    terms: {
      structure: struct,
      termDays: td,
      apr,
      aprPct: round2(apr * 100),
      aprBreakdown: {
        basePct: pricing.breakdown.basePct,
        scoreRiskPct: pricing.breakdown.scoreRiskPct,
        securityDiscountPct: pricing.breakdown.securityDiscountPct,
        volatileCollateralPct: pricing.breakdown.volatileCollateralPct,
        structurePct: round2(adj * 100),
        capped: aprRaw !== apr
      },
      interestAccrual: "simple_per_second",
      maturityDate: td ? new Date(Date.now() + td * 86400000).toISOString() : null
    },
    disbursement: { asset: "USDC", source: "company_treasury", amount: principalUsd.toFixed(7) },
    ltv: {
      originationLtv: collateral.marketUsd > 0 ? round4(principalUsd / collateral.marketUsd) : 0,
      marginCallLtv: cfg.liquidation.marginCallLtv,
      liquidationLtv: cfg.liquidation.liquidationLtv,
      cureWindowSec: cfg.liquidation.cureWindowSec
    },
    projectedDebt: { d30: debtAfter(30), d90: debtAfter(90), d365: debtAfter(365) },
    demo: true,
    disclaimer: DISCLAIMER
  };
}

// Stage B surface (not enabled in the demo).
function attest() {
  throw new Error("Engine attestations are enabled in the on-chain stage (Stage B), not in this demo.");
}
function health() {
  throw new Error("On-chain health tracking is enabled in the on-chain stage (Stage B), not in this demo.");
}

module.exports = { defindexCollateral, quote, attest, health };
