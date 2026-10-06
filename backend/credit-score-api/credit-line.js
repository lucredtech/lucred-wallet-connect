// Indicative credit line + APR, computed from a wallet's LCRD score and its holdings.
//
// Three lending models are always computed side by side, so a partner can embed whichever
// one it wants (or all three):
//   secured   - limit comes from the wallet's transferable, priced collateral only
//   unsecured - a small starter line for established wallets (score + track record), always lower than the
//               wallet's own secured line (a share of it); it is meant to grow toward the score ceiling as repayments are recorded
//   mix       - the score sets the limit, the collateral bounds it (established wallets only)
//   New wallets (see POLICY.established) can only get secured credit.
//
// EVERYTHING that is a business decision lives in POLICY below (haircuts, advance rates,
// score bands, pricing). The numbers are first-draft placeholders for the team to sign off,
// not calibrated against loan performance. `computeOffers(inputs, policy)` is pure, so a
// partner-specific policy is just another object passed in. Output is always "indicative".
const POLICY = {
  version: "2026-10-06-draft3",

  // Collateral: what share of a holding's market value is NOT lendable, by asset class.
  collateralClasses: {
    stable:   { label: "US-dollar stablecoins", haircut: 0.05 },   // USDC, PYUSD
    stableFx: { label: "Euro stablecoin",       haircut: 0.10 },   // EURC
    rwa:      { label: "Tokenized bonds",       haircut: 0.25 },   // Etherfuse CETES / USTRY / TESOURO
    major:    { label: "XLM",                   haircut: 0.35 },
    incentive:{ label: "Reward tokens",         haircut: 0.60 },   // AQUA, BLND
    curated:  { label: "Other priced tokens",   haircut: 0.70 }    // priced only via stellar.expert's list
  },
  verifiedClassByTicker: { USDC: "stable", PYUSD: "stable", EURC: "stableFx", CETES: "rwa", USTRY: "rwa", TESOURO: "rwa", XLM: "major", AQUA: "incentive", BLND: "incentive" },
  lpFactor: 0.90,        // extra factor on pool / vault shares (exit risk, impermanent loss)
  clawbackFactor: 0.50,  // issuer can reclaim the balance

  // Unsecured and score + collateral credit are for established wallets only. A busy wallet can be
  // created and farmed in a week, so a tier is not enough: the DeFi track record must also be long.
  // tenure points come from the score (see TENURE_BUCKETS): 11 = more than 90 days, 15 = more than 180.
  established: { minTiers: ["A", "B"], minTenurePoints: 11, minTenureLabel: "90 days" },

  models: {
    secured: { advanceRate: 0.75, minLimit: 10, maxLimit: 250000 },
    unsecured: {
      // Starter line by score within the tier (a small, bounded first exposure). `ceiling` bands are what
      // the line is meant to grow toward as repayments are recorded; they are shown, not granted.
      starter: { A: { from: 67, to: 100, min: 100, max: 100 }, B: { from: 34, to: 66, min: 50, max: 75 } },
      ceiling: { A: { from: 67, to: 100, min: 2500, max: 10000 }, B: { from: 34, to: 66, min: 250, max: 2500 } },
      allowedPaths: ["lending", "activity"],
      // The starter line is small and set by tier/score. It is always lower than the wallet's secured
      // line (what its own transferable collateral could back): at most this share of it. A wallet with
      // nothing to pledge has no unsecured line.
      maxShareOfSecured: 0.5,
      minLimit: 10,
      maxLimit: 10000
    },
    mix: {
      // score-based ceiling (larger than unsecured, because collateral stands behind it)
      bands: { A: { from: 67, to: 100, min: 5000, max: 30000 }, B: { from: 34, to: 66, min: 500, max: 5000 }, C: { from: 0, to: 33, min: 0, max: 500 } },
      advanceByTier: { A: 1.0, B: 0.85, C: 0.6 },   // share of lendable collateral the score-line may reach
      minLimit: 10,
      maxLimit: 100000
    }
  },

  apr: {
    base: 0.08,                                 // cost of funds
    scorePremiumAt0: 0.20, scorePremiumAt100: 0.03,
    securityMultiplier: { secured: 0.35, mix: 0.70, unsecured: 1.0 }, // how much of the score premium still applies
    unsecuredSurcharge: 0.03,
    volatileCollateralThreshold: 0.30,          // average haircut above this adds the surcharge below
    volatileCollateralAddOn: 0.02,
    min: 0.06, max: 0.36
  },

  disclaimer: "Indicative estimate only. Not an offer of credit, not a credit decision and not financial advice. Figures use today's balances and prices and can change."
};

const round2 = (n) => Math.round(n * 100) / 100;
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const lerp = (score, from, to, min, max) => to === from ? max : min + (max - min) * clamp((score - from) / (to - from), 0, 1);
const bandFor = (bands, tier) => bands[tier] || null;

// -> collateral class name for one priced slice of a holding
function classify(code, priceSource, policy) {
  const cls = priceSource === "verified" && policy.verifiedClassByTicker[code] ? policy.verifiedClassByTicker[code] : "curated";
  return cls;
}

// Turn a portfolio into lendable collateral. Only holdings the wallet can actually move,
// and that have a trusted USD price, count. Debt is handled separately.
function buildCollateral(portfolio, policy) {
  const byClass = {};
  const add = (cls, marketUsd, factor) => {
    const haircut = policy.collateralClasses[cls].haircut;
    const lendable = marketUsd * (1 - haircut) * factor;
    const b = (byClass[cls] = byClass[cls] || { class: cls, label: policy.collateralClasses[cls].label, marketUsd: 0, lendableUsd: 0 });
    b.marketUsd += marketUsd; b.lendableUsd += lendable;
  };
  let excludedUsd = 0;
  if (portfolio) {
    for (const t of portfolio.tokens || []) {
      if (t.usdValue === null || t.usdValue === undefined) continue;
      if (t.transferable !== true) { excludedUsd += t.usdValue; continue; }
      add(classify(t.code, t.priceSource, policy), t.usdValue, t.clawback ? policy.clawbackFactor : 1);
    }
    for (const p of portfolio.positions || []) {
      if (p.type === "debt") continue;
      for (const a of p.assets || []) {
        if (a.usdValue === null || a.usdValue === undefined) continue;
        if (p.transferable !== true) { excludedUsd += a.usdValue; continue; }
        add(classify(a.code, a.priceSource, policy), a.usdValue, policy.lpFactor);
      }
    }
  }
  const classes = Object.values(byClass).map((c) => ({ ...c, marketUsd: round2(c.marketUsd), lendableUsd: round2(c.lendableUsd) }));
  const marketUsd = classes.reduce((s, c) => s + c.marketUsd, 0);
  const lendableUsd = classes.reduce((s, c) => s + c.lendableUsd, 0);
  return {
    classes,
    marketUsd: round2(marketUsd),
    lendableUsd: round2(lendableUsd),
    averageHaircut: marketUsd > 0 ? round2(1 - lendableUsd / marketUsd) : 0,
    excludedUsd: round2(excludedUsd)
  };
}

// -> null when the wallet is established, else the reason it is not (new wallets only get secured credit).
function notEstablishedReason(score, policy) {
  const e = policy.established;
  if (!e.minTiers.includes(score.tier)) return "Unsecured and score + collateral credit need tier B or better. New wallets can use secured credit.";
  const tenure = (score.components || []).find((c) => c.key === "tenure");
  if (!tenure || tenure.points < e.minTenurePoints) return `Unsecured and score + collateral credit need more than ${e.minTenureLabel} of on-chain track record. New wallets can use secured credit.`;
  return null;
}

function priceApr(model, score, collateral, policy) {
  const a = policy.apr;
  const scorePremium = a.scorePremiumAt0 - (a.scorePremiumAt0 - a.scorePremiumAt100) * (clamp(score, 0, 100) / 100);
  const securityAdjusted = scorePremium * a.securityMultiplier[model];
  const unsecuredSurcharge = model === "unsecured" ? a.unsecuredSurcharge : 0;
  const volatile = model !== "unsecured" && collateral.averageHaircut > a.volatileCollateralThreshold ? a.volatileCollateralAddOn : 0;
  const raw = a.base + securityAdjusted + unsecuredSurcharge + volatile;
  const apr = clamp(raw, a.min, a.max);
  return {
    apr: Math.round(apr * 10000) / 10000,                   // fraction, e.g. 0.108
    aprPct: round2(apr * 100),                              // percent, e.g. 10.8
    breakdown: {
      basePct: round2(a.base * 100),
      scoreRiskPct: round2(scorePremium * 100),
      securityDiscountPct: round2(-(scorePremium - securityAdjusted) * 100),
      unsecuredSurchargePct: round2(unsecuredSurcharge * 100),
      volatileCollateralPct: round2(volatile * 100),
      capped: raw !== apr
    }
  };
}

function offer(model, limit, minLimit, maxLimit, score, collateral, policy, notes, ineligibleReason) {
  const capped = Math.min(Math.max(0, limit), maxLimit);
  const eligible = !ineligibleReason && capped >= minLimit;
  const pricing = eligible ? priceApr(model, score, collateral, policy) : null;
  return {
    model,
    eligible,
    limitUsd: eligible ? Math.floor(capped) : 0,
    aprPct: pricing ? pricing.aprPct : null,
    aprBreakdown: pricing ? pricing.breakdown : null,
    notes: eligible ? notes : [ineligibleReason || `Below the minimum line of $${minLimit}.`]
  };
}

// inputs: { score: {score, tier, path}, portfolio } -> all three offers.
function computeOffers({ score, portfolio }, policy = POLICY) {
  const s = score.score, tier = score.tier, path = score.path;
  const collateral = buildCollateral(portfolio, policy);
  const debtUsd = portfolio ? portfolio.totals.debtUsd || 0 : 0;
  const haveHoldings = !!portfolio;

  // Secured
  const sm = policy.models.secured;
  const securedBase = collateral.lendableUsd * sm.advanceRate - debtUsd;
  const secured = offer("secured", securedBase, sm.minLimit, sm.maxLimit, s, collateral, policy,
    [`${Math.round(sm.advanceRate * 100)}% of lendable collateral ($${collateral.lendableUsd.toLocaleString("en-US")})${debtUsd > 0 ? `, less $${round2(debtUsd).toLocaleString("en-US")} already borrowed` : ""}.`],
    !haveHoldings ? "Holdings couldn't be read, so collateral can't be counted." : collateral.lendableUsd <= 0 ? "No transferable, priced collateral found." : null);

  // Unsecured
  const um = policy.models.unsecured;
  const sb = bandFor(um.starter, tier);
  const cb = bandFor(um.ceiling, tier);
  let unsecuredIneligible = notEstablishedReason(score, policy);
  if (!unsecuredIneligible && !um.allowedPaths.includes(path)) unsecuredIneligible = "Not enough on-chain history to score for unsecured credit.";
  if (!unsecuredIneligible && !haveHoldings) unsecuredIneligible = "Holdings couldn't be read, so the wallet's capacity can't be checked.";
  const starterLimit = sb ? lerp(s, sb.from, sb.to, sb.min, sb.max) : 0;
  const ceilingLimit = cb ? Math.min(lerp(s, cb.from, cb.to, cb.min, cb.max), um.maxLimit) : 0;
  const securedLimitUsd = secured.eligible ? secured.limitUsd : 0;
  const securedShareCap = Math.floor(securedLimitUsd * um.maxShareOfSecured);
  const unsecuredLimit = Math.min(starterLimit, securedShareCap);
  if (!unsecuredIneligible && !secured.eligible) unsecuredIneligible = "Unsecured credit is always lower than the wallet's secured line, and this wallet has no secured line (nothing transferable and priced to pledge, or too little of it).";
  else if (!unsecuredIneligible && unsecuredLimit < um.minLimit) unsecuredIneligible = `Unsecured credit is held to ${Math.round(um.maxShareOfSecured * 100)}% of the secured line ($${securedLimitUsd.toLocaleString("en-US")}), which is below the $${um.minLimit} minimum line.`;
  const unsecuredNotes = [`A starter line set by the LCRD score and track record, always lower than the wallet's secured line. As repayments are recorded it is meant to grow, up to about $${Math.floor(ceilingLimit).toLocaleString("en-US")} at today's score.`];
  if (sb && securedLimitUsd > 0 && securedShareCap < starterLimit) unsecuredNotes.push(`Held to ${Math.round(um.maxShareOfSecured * 100)}% of the $${securedLimitUsd.toLocaleString("en-US")} secured line.`);
  const unsecured = offer("unsecured", unsecuredLimit, um.minLimit, um.maxLimit, s, collateral, policy, unsecuredNotes, unsecuredIneligible);
  unsecured.growsToUsd = unsecured.eligible ? Math.floor(ceilingLimit) : null;

  // Mix
  const mm = policy.models.mix;
  const mb = bandFor(mm.bands, tier);
  const scoreLine = mb ? lerp(s, mb.from, mb.to, mb.min, mb.max) : 0;
  const advance = mm.advanceByTier[tier] || 0;
  const collateralCap = collateral.lendableUsd * advance - debtUsd;
  const mixLimit = Math.min(scoreLine, collateralCap);
  const mixNotes = [`The score allows up to $${Math.floor(scoreLine).toLocaleString("en-US")}; collateral allows up to $${Math.floor(Math.max(0, collateralCap)).toLocaleString("en-US")}. The lower of the two applies.`];
  const mix = offer("mix", mixLimit, mm.minLimit, mm.maxLimit, s, collateral, policy, mixNotes,
    notEstablishedReason(score, policy) || (!haveHoldings ? "Holdings couldn't be read, so collateral can't be counted." : collateral.lendableUsd <= 0 ? "No transferable, priced collateral found." : scoreLine <= 0 ? "The score doesn't support a line yet." : null));

  return {
    indicative: true,
    policyVersion: policy.version,
    disclaimer: policy.disclaimer,
    inputs: {
      score: s, tier, path,
      debtUsd: round2(debtUsd),
      collateral
    },
    offers: { secured, unsecured, mix }
  };
}

module.exports = { computeOffers, buildCollateral, priceApr, POLICY };
