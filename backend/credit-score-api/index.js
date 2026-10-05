// Credit score lookup API. Scoring logic (computeDebtCycles, scoreWalletBase)
// is lifted verbatim from run-new-formula.js on the indexer machine - already
// tested against real sampled data earlier this project, not reimplemented
// here. Only the data source changed: that script read raw GCS files
// directly; this reads from the BigQuery credit_events_normalized view,
// which is clustered by userAddress, so a single-wallet lookup is cheap.
const express = require("express");
const cors = require("cors");
const { BigQuery } = require("@google-cloud/bigquery");
const { createPortfolioService, resolveVaultTicker } = require("./portfolio");
const { computeOffers } = require("./credit-line");
const { getClassicActivity, classicPoints } = require("./classic-activity");

const bq = new BigQuery();
const app = express();
app.use(cors());

// ---- borrowRepayCycles (verbatim from run-new-formula.js) ----
const CLOSE_EPSILON = 1e-4;

function computeDebtCycles(events) {
  const relevant = events
    .filter(
      (e) =>
        e.protocolName === "blend" &&
        (e.eventType === "borrow" || e.eventType === "repay") &&
        (e.poolShareTokensAfter !== undefined && e.poolShareTokensAfter !== null ||
          e.collateralRatioAfter !== undefined && e.collateralRatioAfter !== null)
    )
    .sort((a, b) => new Date(a.blockCloseTime).getTime() - new Date(b.blockCloseTime).getTime());

  const open = new Map();
  const cycles = [];

  for (const e of relevant) {
    const shareTokens =
      e.poolShareTokensAfter !== undefined && e.poolShareTokensAfter !== null
        ? e.poolShareTokensAfter
        : e.collateralRatioAfter;
    const key = e.userAddress + "|" + e.contractId + "|" + (e.assetContractId || "");
    const delta = e.eventType === "borrow" ? shareTokens : -shareTokens;

    let cur = open.get(key);
    if (!cur) {
      if (e.eventType === "repay") continue;
      cur = { openedAt: e.blockCloseTime, balance: 0, peakBalance: 0, eventCount: 0 };
      open.set(key, cur);
    }

    cur.balance += delta;
    cur.peakBalance = Math.max(cur.peakBalance, cur.balance);
    cur.eventCount++;

    if (e.eventType === "repay" && cur.balance <= CLOSE_EPSILON) {
      const parts = key.split("|");
      const userAddress = parts[0];
      const contractId = parts[1];
      const assetContractId = parts[2];
      const durationSeconds = (new Date(e.blockCloseTime).getTime() - new Date(cur.openedAt).getTime()) / 1000;
      if (durationSeconds > 0) {
        cycles.push({
          userAddress: userAddress,
          contractId: contractId,
          assetContractId: assetContractId || undefined,
          openedAt: cur.openedAt,
          closedAt: e.blockCloseTime,
          durationSeconds: durationSeconds,
          eventCount: cur.eventCount,
          peakBalance: cur.peakBalance
        });
      }
      open.delete(key);
    }
  }
  return cycles;
}

// ---- income scoring (added 2026-09-29 - see project_bigquery_pipeline /
// income-scoring design memory for the asset_prices + vault_assets tables
// this depends on) ----
//
// Replaces the old binary "hasYield ? +10 : 0" flags with a graduated
// signal based on REALIZED income: net USD a wallet actually withdrew above
// what it deposited into a yield_savings-category position (DeFindex,
// Upshift/Gami, Stellar DeFi Hub). Deliberately NOT based on current vault
// balance growth, since that needs a live on-chain read - this stays pure
// event-replay like the rest of the scorer, at the cost of scoring a
// still-parked (never-withdrawn) position as having zero realized income.
// A small flat "participation" component (see PARTICIPATION_PTS below)
// keeps that case from scoring identically to a wallet with no yield
// activity at all.
//
// assetCode resolution: populated directly on the event for
// stellar_defi_hub/gami_upshift, but NULL for every DeFindex event (the
// assetContractId captured there is the vault's OWN share-token contract,
// not the underlying asset) - resolved instead via vaultAssetMap, keyed by
// contractId, built from `credit_bureau.vault_assets`.
const YIELD_CATEGORY = "yield_savings";
const INCOME_MONTHS_SATURATION = 8; // distinct months of realized income for full consistency credit
const INCOME_RATE_SATURATION = 0.2; // 20% total realized return for full magnitude credit
const PARTICIPATION_PTS = { lending: 2, activity: 2 };
const INCOME_CONSISTENCY_MAX = { lending: 4, activity: 5 };
const INCOME_MAGNITUDE_MAX = { lending: 4, activity: 5 };

// mass_distribution claims (e.g. Fundable's payroll/mass-distribution
// platform) ARE real income when they're genuine - added 2026-10-02 after
// reconsidering an earlier "exclude entirely" call. But a `claim` event
// has no deposit side to net against (unlike yield_savings' realized-gain
// model: withdrawn minus deposited) - it's a pure receipt, so there's no
// cost basis to measure a "return" against. The only real claims observed
// so far (2, from one single distribution) can't be told apart from a
// one-time airdrop windfall versus recurring verified salary using
// on-chain data alone. So this scores CONSISTENCY (distinct months with a
// claim) much more heavily than magnitude - a wallet claiming something
// every month looks like real income, one claim ever looks like luck -
// with a noticeably smaller total point budget than proven DeFi yield,
// reflecting that real uncertainty rather than pretending it isn't there.
const DISTRIBUTION_CATEGORY = "mass_distribution";
const DISTRIBUTION_MONTHS_SATURATION = 6; // distinct months claiming for full consistency credit
const DISTRIBUTION_MAGNITUDE_SATURATION_USD = 500; // total USD claimed for full magnitude credit
const DISTRIBUTION_PARTICIPATION_PTS = { lending: 1, activity: 1 };
const DISTRIBUTION_CONSISTENCY_MAX = { lending: 2, activity: 3 };
const DISTRIBUTION_MAGNITUDE_MAX = { lending: 1, activity: 2 };

function resolveAssetCode(event, vaultAssetMap) {
  if (event.assetCode) return event.assetCode;
  if (event.protocolName === "defindex") return vaultAssetMap[event.contractId];
  return undefined;
}

function computeYieldIncome(events, assetPriceMap, vaultAssetMap) {
  const yieldEvents = events.filter(
    (e) => e.category === YIELD_CATEGORY && (e.eventType === "deposit" || e.eventType === "withdraw")
  );

  const hasParticipation = yieldEvents.length > 0;

  const byPosition = new Map(); // contractId -> events[]
  for (const e of yieldEvents) {
    if (!byPosition.has(e.contractId)) byPosition.set(e.contractId, []);
    byPosition.get(e.contractId).push(e);
  }

  let totalNetIncomeUsd = 0;
  let totalDepositedUsd = 0;
  const incomeMonths = new Set();

  for (const positionEvents of byPosition.values()) {
    positionEvents.sort((a, b) => new Date(a.blockCloseTime).getTime() - new Date(b.blockCloseTime).getTime());
    let deposited = 0;
    let withdrawn = 0;
    for (const e of positionEvents) {
      const assetCode = resolveAssetCode(e, vaultAssetMap);
      const price = assetCode && assetPriceMap[assetCode];
      if (!price) continue; // can't price this event (unknown asset) - skip rather than guess
      const amountUsd = (e.amount || 0) * price.usdRate;

      if (e.eventType === "deposit") {
        deposited += amountUsd;
        totalDepositedUsd += amountUsd;
      } else {
        const beforeNet = withdrawn - deposited;
        withdrawn += amountUsd;
        const afterNet = withdrawn - deposited;
        if (afterNet > 0) {
          totalNetIncomeUsd += afterNet - Math.max(0, beforeNet);
          incomeMonths.add(e.blockCloseTime.slice(0, 7));
        }
      }
    }
  }

  return { hasParticipation, totalNetIncomeUsd, totalDepositedUsd, distinctIncomeMonths: incomeMonths.size };
}

function incomeScorePoints(income, path) {
  if (!income.hasParticipation) return { points: 0, detail: "no yield activity" };

  const consistencyFraction = Math.min(1, income.distinctIncomeMonths / INCOME_MONTHS_SATURATION);
  const rate = income.totalDepositedUsd > 0 ? income.totalNetIncomeUsd / income.totalDepositedUsd : 0;
  const magnitudeFraction = Math.max(0, Math.min(1, rate / INCOME_RATE_SATURATION));

  const participationPts = PARTICIPATION_PTS[path];
  const consistencyPts = Math.round(consistencyFraction * INCOME_CONSISTENCY_MAX[path]);
  const magnitudePts = Math.round(magnitudeFraction * INCOME_MAGNITUDE_MAX[path]);
  const points = participationPts + consistencyPts + magnitudePts;

  const detail =
    "participation " + participationPts +
    ", months " + income.distinctIncomeMonths + " (" + consistencyPts + "pts)" +
    ", net $" + income.totalNetIncomeUsd.toFixed(2) + " realized (" + magnitudePts + "pts)";

  return { points, detail };
}

// mass_distribution claims as income - see DISTRIBUTION_* constants above
// for why this is scored separately from yield_savings rather than folded
// into the same computeYieldIncome/incomeScorePoints pair: no deposit side
// to net against, and real uncertainty about one-time-grant vs recurring
// income that the heavier weight on consistency (vs magnitude) accounts for.
function computeDistributionIncome(events, assetPriceMap) {
  const claimEvents = events.filter((e) => e.category === DISTRIBUTION_CATEGORY && e.eventType === "claim");
  const hasParticipation = claimEvents.length > 0;

  let totalClaimedUsd = 0;
  const claimMonths = new Set();
  for (const e of claimEvents) {
    const price = e.assetCode && assetPriceMap[e.assetCode];
    if (!price) continue; // can't price this event (unknown asset) - skip rather than guess
    totalClaimedUsd += (e.amount || 0) * price.usdRate;
    claimMonths.add(e.blockCloseTime.slice(0, 7));
  }

  return { hasParticipation, totalClaimedUsd, distinctClaimMonths: claimMonths.size };
}

function distributionScorePoints(dist, path) {
  if (!dist.hasParticipation) return { points: 0, detail: "no distribution claims" };

  const consistencyFraction = Math.min(1, dist.distinctClaimMonths / DISTRIBUTION_MONTHS_SATURATION);
  const magnitudeFraction = Math.min(1, dist.totalClaimedUsd / DISTRIBUTION_MAGNITUDE_SATURATION_USD);

  const participationPts = DISTRIBUTION_PARTICIPATION_PTS[path];
  const consistencyPts = Math.round(consistencyFraction * DISTRIBUTION_CONSISTENCY_MAX[path]);
  const magnitudePts = Math.round(magnitudeFraction * DISTRIBUTION_MAGNITUDE_MAX[path]);
  const points = participationPts + consistencyPts + magnitudePts;

  const detail =
    "participation " + participationPts +
    ", months " + dist.distinctClaimMonths + " (" + consistencyPts + "pts)" +
    ", $" + dist.totalClaimedUsd.toFixed(2) + " claimed (" + magnitudePts + "pts)";

  return { points, detail };
}

// Incentive rewards (added 2026-10-03): AQUA paid to Aquarius liquidity
// providers and BLND paid by Blend as lending/backstop emissions. Scored as a
// SEPARATE, deliberately small income signal - not folded into yield_savings
// or distribution income - because these are protocol incentives, not organic
// income: they scale with how much a wallet has staked, mercenary farmers
// rotate between incentive programs, and the tokens are volatile. So, like
// distribution income, it rewards CONSISTENCY (distinct months with a claim)
// over magnitude, on a slower scale (8 months, not 6 - 32% of claiming wallets
// already have 6+ months, so 6 would stop distinguishing anyone), and its
// whole budget is the smallest of the three income signals.
// Blend `claim` events carry no asset code in credit_events (24K rows, 0 with
// one), but Blend emissions are always BLND, so the token is fixed per source
// here rather than read off the event. Aquarius `claim` (as opposed to
// `claim_reward`) is a different event - fee claims, in XLM/USDC - and is NOT
// counted. Other protocols checked and not included: Soroswap pays LPs through
// trading fees only (no token farming), and no emissions were found for
// Peridot/Slender/Sushi/DeFindex. Phoenix pays staking rewards via separate
// staking contracts (indexed since 2026-10-03, see the registry).
// Needs AQUA/BLND rows in credit_bureau.asset_prices; an event with no
// price still counts as participation but adds no USD.
const REWARD_SOURCES = [
  { protocolName: "aquarius", eventType: "claim_reward", assetCode: "AQUA" },
  { protocolName: "blend", eventType: "claim", assetCode: "BLND" },
  // Aquarius gauge rewards are paid in whatever asset the gauge distributes
  // (USDC/XLM in practice), so the token comes off the event, not fixed here.
  { protocolName: "aquarius", eventType: "rewards_gauge_claim", assetCode: null },
  // Phoenix LP-staking reward claims. The stake contract's `withdraw_rewards`
  // event carries the user and reward token but NO AMOUNT (the payout is a
  // separate transfer on the reward token's own contract), so these count for
  // participation and months-claimed only, never USD - which suits this
  // component, where months matter more than size anyway.
  { protocolName: "phoenix_defi_hub", eventType: "withdraw_rewards", assetCode: null }
];
const REWARD_MONTHS_SATURATION = 8; // distinct months claiming for full consistency credit
const REWARD_MAGNITUDE_SATURATION_USD = 50; // total USD claimed (~p80 of claimers) for full magnitude credit
const REWARD_PARTICIPATION_PTS = { lending: 1, activity: 1 };
const REWARD_CONSISTENCY_MAX = { lending: 1, activity: 2 };
const REWARD_MAGNITUDE_MAX = { lending: 1, activity: 1 };

function computeRewardIncome(events, assetPriceMap) {
  let hasParticipation = false;
  let totalClaimedUsd = 0;
  const claimMonths = new Set();
  for (const e of events) {
    const source = REWARD_SOURCES.find((r) => r.protocolName === e.protocolName && r.eventType === e.eventType);
    if (!source) continue;
    hasParticipation = true;
    claimMonths.add(e.blockCloseTime.slice(0, 7));
    const rewardAsset = source.assetCode || e.assetCode;
    const price = rewardAsset && assetPriceMap[rewardAsset];
    if (!price) continue; // can't price this reward token - skip the USD, keep the participation
    totalClaimedUsd += (e.amount || 0) * price.usdRate;
  }
  return { hasParticipation, totalClaimedUsd, distinctClaimMonths: claimMonths.size };
}

function rewardScorePoints(reward, path) {
  if (!reward.hasParticipation) return { points: 0, detail: "no reward claims" };

  const consistencyFraction = Math.min(1, reward.distinctClaimMonths / REWARD_MONTHS_SATURATION);
  const magnitudeFraction = Math.min(1, reward.totalClaimedUsd / REWARD_MAGNITUDE_SATURATION_USD);

  const participationPts = REWARD_PARTICIPATION_PTS[path];
  const consistencyPts = Math.round(consistencyFraction * REWARD_CONSISTENCY_MAX[path]);
  const magnitudePts = Math.round(magnitudeFraction * REWARD_MAGNITUDE_MAX[path]);
  const points = participationPts + consistencyPts + magnitudePts;

  const detail =
    "participation " + participationPts +
    ", months " + reward.distinctClaimMonths + " (" + consistencyPts + "pts)" +
    // Past the saturation point the exact total no longer affects the score, and
    // some Blend claim amounts look unreliable (a few implausibly huge values),
    // so show "$50.00+" rather than printing an absurd dollar figure.
    ", $" + Math.min(reward.totalClaimedUsd, REWARD_MAGNITUDE_SATURATION_USD).toFixed(2) +
    (reward.totalClaimedUsd >= REWARD_MAGNITUDE_SATURATION_USD ? "+" : "") + " in rewards (" + magnitudePts + "pts)";

  return { points, detail };
}

// ---- walletScore (verbatim from run-new-formula.js, except yield scoring - see above) ----
const MIN_CYCLES_FOR_FULL_TRUST = 2;
const TIER_C_MAX_SCORE = 33;
const TIER_B_MIN_SCORE = 34;
const TIER_A_MIN_SCORE = 67;
const RAW_SCORE_MIN = 9;
const RAW_SCORE_MAX = 95;
const CONCAVE_EXPONENT = 3.0;
const ACTIVITY_TIER_A_MAX_SCORE = 90;
const RAW_ACTIVITY_MIN = 8;
const RAW_ACTIVITY_MAX = 93;
const CONCAVE_EXPONENT_ACTIVITY = 3.0;

const SPEED_BUCKETS = [
  { maxDays: 1 / 24, points: 15 },
  { maxDays: 1, points: 35 },
  { maxDays: 3, points: 42 },
  { maxDays: 7, points: 34 },
  { maxDays: 14, points: 26 },
  { maxDays: 30, points: 18 },
  { maxDays: 90, points: 10 },
  { maxDays: Infinity, points: 5 }
];
const TENURE_BUCKETS = [
  { maxDays: 7, points: 0 },
  { maxDays: 30, points: 3 },
  { maxDays: 90, points: 7 },
  { maxDays: 180, points: 11 },
  { maxDays: Infinity, points: 15 }
];
const CONSISTENCY_BUCKETS = [
  { maxDays: 2, points: 0 },
  { maxDays: 6, points: 4 },
  { maxDays: 13, points: 8 },
  { maxDays: 29, points: 14 },
  { maxDays: 89, points: 20 },
  { maxDays: Infinity, points: 26 }
];

function median(nums) {
  const sorted = nums.slice().sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}
function scaleToTierA(raw) {
  const t = Math.max(0, Math.min(1, (raw - RAW_SCORE_MIN) / (RAW_SCORE_MAX - RAW_SCORE_MIN)));
  const shaped = Math.pow(t, CONCAVE_EXPONENT);
  const scaled = TIER_A_MIN_SCORE + shaped * (100 - TIER_A_MIN_SCORE);
  return Math.max(TIER_A_MIN_SCORE, Math.min(100, scaled));
}
function scaleToActivityBand(raw) {
  const t = Math.max(0, Math.min(1, (raw - RAW_ACTIVITY_MIN) / (RAW_ACTIVITY_MAX - RAW_ACTIVITY_MIN)));
  const shaped = Math.pow(t, CONCAVE_EXPONENT_ACTIVITY);
  const scaled = TIER_B_MIN_SCORE + shaped * (ACTIVITY_TIER_A_MAX_SCORE - TIER_B_MIN_SCORE);
  return Math.max(TIER_B_MIN_SCORE, Math.min(ACTIVITY_TIER_A_MAX_SCORE, scaled));
}
function repaymentSpeedPoints(medianDurationSeconds) {
  const days = medianDurationSeconds / 86400;
  return SPEED_BUCKETS.find((b) => days <= b.maxDays).points;
}
function tenurePointsFromCycles(cycles) {
  const opened = cycles.map((c) => new Date(c.openedAt).getTime());
  const closed = cycles.map((c) => new Date(c.closedAt).getTime());
  const spanDays = (Math.max.apply(null, closed) - Math.min.apply(null, opened)) / 86400000;
  return TENURE_BUCKETS.find((b) => spanDays <= b.maxDays).points;
}
function consistencyPoints(meaningfulEvents) {
  const distinctDays = new Set(meaningfulEvents.map((e) => e.blockCloseTime.slice(0, 10)));
  return CONSISTENCY_BUCKETS.find((b) => distinctDays.size <= b.maxDays).points;
}
function activityTenurePoints(meaningfulEvents) {
  const times = meaningfulEvents.map((e) => new Date(e.blockCloseTime).getTime());
  const spanDays = (Math.max.apply(null, times) - Math.min.apply(null, times)) / 86400000;
  return TENURE_BUCKETS.find((b) => spanDays <= b.maxDays).points;
}

// Plain-English description of every scoring term, shown as tooltips next to the score.
// `max` is the term's ceiling on each path, so the UI can show "points / max".
const COMPONENT_INFO = {
  speed:       { label: "Repayment speed", group: "core", explain: "How quickly you usually repay a loan (the median across your completed loans). Faster repayment scores higher." },
  cyclecount:  { label: "Completed loans", group: "core", explain: "Borrow-then-repay cycles you have completed. Up to 5 count, 4 points each, so repeat borrowing and repaying is rewarded." },
  breadth:     { label: "Protocols used", group: "core", explain: "How many different DeFi protocols you have used: 5 points each, up to 3 protocols." },
  volume:      { label: "Activity", group: "core", explain: "How many meaningful on-chain actions you have taken, capped at 25 so very busy wallets don't dominate." },
  consistency: { label: "Active days", group: "core", explain: "How many different days you have been active, so steady use counts for more than a one-day burst." },
  tenure:      { label: "Track record", group: "core", explain: "How long your DeFi activity spans, from your first to your latest action. Longer is better." },
  income:      { label: "Yield income", group: "income", explain: "Real yield from vaults and savings products: what you withdrew above what you deposited. Paper gains on a balance you haven't withdrawn don't count." },
  distribution:{ label: "Payroll / distributions", group: "income", explain: "Recurring claims from payroll or mass-distribution contracts. Claiming every month counts for more than one big claim." },
  rewards:     { label: "Protocol rewards", group: "income", explain: "Incentive rewards you have claimed (AQUA, BLND, Phoenix, gauge rewards). The smallest income signal, since rewards are incentives rather than organic income." },
  classic:     { label: "Account age", group: "bonus", explain: "A small bonus for how long the account has existed and its classic Stellar history. Only added alongside DeFi activity." },
  floor:       { label: "Limited activity", group: "core", explain: "Not enough DeFi activity yet to score on breadth, volume and consistency, so the score is capped in tier C." }
};

function spanText(days) {
  if (!isFinite(days) || days < 1) return "under a day";
  if (days < 60) return Math.round(days) + " days";
  if (days < 730) return Math.round(days / 30.4) + " months";
  return (days / 365.25).toFixed(1) + " years";
}

function component(key, points, max, detail, extra) {
  const info = COMPONENT_INFO[key];
  return { key, label: info.label, group: info.group, points, max, explain: info.explain, detail: detail || null, ...(extra || {}) };
}

function scoreWalletBase(events, cycles, assetPriceMap, vaultAssetMap, classic = null) {
  const userAddress = (events[0] && events[0].userAddress) || (cycles[0] && cycles[0].userAddress) || "unknown";
  const reasons = [];
  const income = computeYieldIncome(events, assetPriceMap, vaultAssetMap);
  const distIncome = computeDistributionIncome(events, assetPriceMap);
  const rewardIncome = computeRewardIncome(events, assetPriceMap);

  if (cycles.length > 0) {
    const durations = cycles.map((c) => c.durationSeconds);
    const med = median(durations);
    const speedPts = repaymentSpeedPoints(med);
    const cycleCountPts = Math.min(cycles.length, 5) * 4;
    const { points: yieldPts, detail: yieldDetail } = incomeScorePoints(income, "lending");
    const { points: distPts, detail: distDetail } = distributionScorePoints(distIncome, "lending");
    const { points: rewardPts, detail: rewardDetail } = rewardScorePoints(rewardIncome, "lending");
    const tenurePts = tenurePointsFromCycles(cycles);
    const { points: classicPts, detail: classicDetail } = classic ? classicPoints(classic, "lending") : { points: 0, detail: "" };
    const raw = speedPts + cycleCountPts + yieldPts + distPts + rewardPts + tenurePts + classicPts;
    let scaled = scaleToTierA(raw);
    if (cycles.length < MIN_CYCLES_FOR_FULL_TRUST) {
      const provisionalCap = TIER_A_MIN_SCORE + 15;
      if (scaled > provisionalCap) scaled = provisionalCap;
    }
    reasons.push(
      "LENDING path: " + cycles.length + " cycles, speed " + speedPts + ", cyclecount " + cycleCountPts +
        ", income " + yieldPts + " [" + yieldDetail + "], distribution " + distPts + " [" + distDetail + "]" +
        ", rewards " + rewardPts + " [" + rewardDetail + "]" +
        (classic ? ", classic " + classicPts + " [" + classicDetail + "]" : "") +
        ", tenure " + tenurePts + ", raw " + raw.toFixed(1)
    );
    const medDays = med / 86400;
    const components = [
      component("speed", speedPts, 42, "median repayment " + (medDays < 1 ? Math.max(1, Math.round(medDays * 24)) + " hours" : medDays.toFixed(1) + " days")),
      component("cyclecount", cycleCountPts, 20, cycles.length + " completed loan" + (cycles.length === 1 ? "" : "s")),
      component("tenure", tenurePts, 15, "loan activity spans " + spanText((Math.max.apply(null, cycles.map((c) => new Date(c.closedAt).getTime())) - Math.min.apply(null, cycles.map((c) => new Date(c.openedAt).getTime()))) / 86400000)),
      component("income", yieldPts, 10, yieldDetail, { amountUsd: income.hasParticipation ? income.totalNetIncomeUsd : null, amountLabel: "realized" }),
      component("distribution", distPts, 4, distDetail, { amountUsd: distIncome.hasParticipation ? distIncome.totalClaimedUsd : null, amountLabel: "claimed" }),
      component("rewards", rewardPts, 3, rewardDetail, { amountUsd: rewardIncome.hasParticipation ? Math.min(rewardIncome.totalClaimedUsd, REWARD_MAGNITUDE_SATURATION_USD) : null, amountLabel: rewardIncome.totalClaimedUsd >= REWARD_MAGNITUDE_SATURATION_USD ? "in rewards (and more)" : "in rewards" })
    ];
    if (classic) components.push(component("classic", classicPts, 3, classicDetail));
    return { userAddress: userAddress, tier: "A", score: Math.round(scaled), reasons: reasons, path: "lending", components: components };
  }

  // mass_distribution claims (e.g. Fundable's Merkle-drop payroll/distribution
  // platform) are excluded from breadth/volume/consistency/tenure here the
  // same way fn_call diagnostic noise already is - a deliberate choice, not
  // an oversight: passively receiving an allocation doesn't demonstrate
  // protocol-diversity/sophistication the way actively using a swap/deposit/
  // loan product does. That does NOT mean claims carry zero weight, though -
  // see distributionScorePoints below, which scores them as a real but
  // separately-tracked income signal instead (added 2026-10-02 - an earlier
  // pass zero-weighted this entirely, which was too dismissive of genuine
  // payroll/distribution income just because it doesn't fit the yield_savings
  // deposit/withdraw model).
  const distinctProtocols = new Set(
    events.filter((e) => e.category !== "mass_distribution").map((e) => e.protocolName)
  );
  const meaningfulEvents = events.filter((e) => e.eventType !== "fn_call" && e.category !== "mass_distribution");
  const meaningfulEventCount = meaningfulEvents.length;

  // Gate also admits sustained distribution income on its own (>= 2 distinct
  // claim months) - without this, a wallet with real, recurring claimed
  // income but no other DeFi activity could never reach this path at all,
  // since meaningfulEventCount/distinctProtocols both exclude
  // mass_distribution by design above. A single one-off claim still doesn't
  // qualify alone - consistent with scoring consistency over magnitude.
  if (meaningfulEventCount >= 3 || distinctProtocols.size >= 2 || distIncome.distinctClaimMonths >= 2) {
    const breadthPts = Math.min(distinctProtocols.size * 5, 15);
    const volumePts = Math.min(meaningfulEventCount, 25);
    const consistencyPts = consistencyPoints(meaningfulEvents);
    const tenurePts = activityTenurePoints(meaningfulEvents);
    const { points: lpYieldPts, detail: lpYieldDetail } = incomeScorePoints(income, "activity");
    const { points: distPts, detail: distDetail } = distributionScorePoints(distIncome, "activity");
    const { points: rewardPts, detail: rewardDetail } = rewardScorePoints(rewardIncome, "activity");
    const { points: classicPts, detail: classicDetail } = classic ? classicPoints(classic, "activity") : { points: 0, detail: "" };
    const raw = breadthPts + volumePts + consistencyPts + tenurePts + lpYieldPts + distPts + rewardPts + classicPts;
    const scaled = scaleToActivityBand(raw);
    const score = Math.round(scaled);
    const tier = score >= TIER_A_MIN_SCORE ? "A" : "B";
    reasons.push(
      "ACTIVITY path: protocols " + distinctProtocols.size + ", events " + meaningfulEventCount +
        ", days " + new Set(meaningfulEvents.map((e) => e.blockCloseTime.slice(0, 10))).size +
        ", breadth " + breadthPts + ", volume " + volumePts + ", consistency " + consistencyPts +
        ", tenure " + tenurePts + ", income " + lpYieldPts + " [" + lpYieldDetail + "]" +
        ", distribution " + distPts + " [" + distDetail + "]" +
        ", rewards " + rewardPts + " [" + rewardDetail + "]" +
        (classic ? ", classic " + classicPts + " [" + classicDetail + "]" : "") + ", raw " + raw
    );
    const activeDays = new Set(meaningfulEvents.map((e) => e.blockCloseTime.slice(0, 10))).size;
    const components = [
      component("breadth", breadthPts, 15, distinctProtocols.size + " protocol" + (distinctProtocols.size === 1 ? "" : "s")),
      component("volume", volumePts, 25, meaningfulEventCount + " meaningful actions"),
      component("consistency", consistencyPts, 26, activeDays + " active day" + (activeDays === 1 ? "" : "s")),
      component("tenure", tenurePts, 15, "first to latest action: " + spanText((Math.max.apply(null, meaningfulEvents.map((e) => new Date(e.blockCloseTime).getTime())) - Math.min.apply(null, meaningfulEvents.map((e) => new Date(e.blockCloseTime).getTime()))) / 86400000)),
      component("income", lpYieldPts, 12, lpYieldDetail, { amountUsd: income.hasParticipation ? income.totalNetIncomeUsd : null, amountLabel: "realized" }),
      component("distribution", distPts, 6, distDetail, { amountUsd: distIncome.hasParticipation ? distIncome.totalClaimedUsd : null, amountLabel: "claimed" }),
      component("rewards", rewardPts, 4, rewardDetail, { amountUsd: rewardIncome.hasParticipation ? Math.min(rewardIncome.totalClaimedUsd, REWARD_MAGNITUDE_SATURATION_USD) : null, amountLabel: rewardIncome.totalClaimedUsd >= REWARD_MAGNITUDE_SATURATION_USD ? "in rewards (and more)" : "in rewards" })
    ];
    if (classic) components.push(component("classic", classicPts, 5, classicDetail));
    return { userAddress: userAddress, tier: tier, score: score, reasons: reasons, path: "activity", components: components };
  }

  reasons.push("floor: " + events.length + " events, mostly fn_call noise");
  const floorScore = Math.min(TIER_C_MAX_SCORE, events.length);
  return { userAddress: userAddress, tier: "C", score: floorScore, reasons: reasons, path: "floor", components: [component("floor", floorScore, TIER_C_MAX_SCORE, events.length + " events, mostly plain contract calls")] };
}

// ---- reference data cache (asset_prices, vault_assets) ----
// Both tables are small and change slowly (prices refresh every 6h via
// cron, vaults are added rarely) - loaded once at startup and refreshed on
// an interval rather than queried per-request, to keep /score latency down.
const REFERENCE_DATA_REFRESH_MS = 15 * 60 * 1000;
let assetPriceMap = {};
let vaultAssetMap = {};
let tokenPriceMap = {}; // contractId -> {usdRate, volume7dUsd, updatedAt}, from credit_bureau.token_prices

async function refreshReferenceData() {
  try {
    const [priceRows] = await bq.query("SELECT assetCode, usdRate, isStable, isResearched FROM `credit_bureau.asset_prices`");
    const newPriceMap = {};
    for (const r of priceRows) newPriceMap[r.assetCode] = { usdRate: r.usdRate, isStable: r.isStable, isResearched: r.isResearched };
    assetPriceMap = newPriceMap;

    const [vaultRows] = await bq.query("SELECT vaultContractId, assetCode FROM `credit_bureau.vault_assets`");
    const newVaultMap = {};
    for (const r of vaultRows) newVaultMap[r.vaultContractId] = r.assetCode;
    vaultAssetMap = newVaultMap;

    // Separate try: a missing/!ready token_prices table must not stop prices or vault maps refreshing.
    try {
      const [tokenRows] = await bq.query("SELECT contractId, code, usdRate, volume7dUsd, updatedAt FROM `credit_bureau.token_prices`");
      const newTokenMap = {};
      for (const r of tokenRows) newTokenMap[r.contractId] = { code: r.code, usdRate: r.usdRate, volume7dUsd: r.volume7dUsd, updatedAt: r.updatedAt };
      tokenPriceMap = newTokenMap;
    } catch (err) {
      console.error("Could not load token_prices, keeping previous values:", err.message);
    }

    console.log("Reference data refreshed: " + Object.keys(assetPriceMap).length + " asset prices, " + Object.keys(vaultAssetMap).length + " vault mappings");
  } catch (err) {
    console.error("Failed to refresh reference data, keeping previous values:", err.message);
  }
}

// ---- C-address -> G-address identity resolution (Pattern 1 only - see
// project_smart_account_identity_resolution.md) ----
// Some Soroban smart wallets (e.g. Veil passkey wallets) are self-deployed:
// stellar.expert's own contract.creator field IS the G-address that
// deployed them, and that G-address often keeps acting directly too - so
// the same person's real activity can be split across two addresses in
// credit_events today. This is NOT universal (a shared-relayer/aggregator
// contract's creator is irrelevant - Pattern 2, not solved by this) - it's
// a best-effort enrichment for the one case that's cheap and reliable to
// check, so a lookup failure falls back to scoring the C-address alone
// rather than erroring the whole request. Cached per-process since a
// contract's creator is immutable once deployed - never needs re-checking.
const creatorCache = new Map(); // C-address -> G-address string, or null if none/unresolved
const GACCOUNT_RE = /^G[A-Z2-7]{55}$/;

// DANGER CASE, confirmed on real data (2026-10-01): not every smart-wallet
// SDK follows Veil's self-deployed pattern. stellar/passkey-kit - the
// official SDF-backed passkey wallet SDK, "Used by 100" projects per its own
// GitHub - deploys EVERY wallet (across every app built on it) using one
// single hardcoded deployer keypair by default: its own README states "The
// default deployer is a shared, public keypair... It never controls the
// wallet," derived as Keypair.fromRawEd25519Seed(sha256("kalepail")).
// Computed and confirmed that resolves to
// GC2C7AWLS2FMFTQAHW3IBUB4ZXVP4E37XNLEF2IK7IVXBB6CMEPCSXFO - a real address
// with a real but telling footprint (10 lifetime payments, "monthly: none"
// activity per stellar.expert) despite being the creator of who-knows-how-
// many wallets across the whole ecosystem. Blindly trusting `creator` here
// would silently pool THOUSANDS of unrelated passkey-kit users' activity
// into one shared ghost identity - the opposite of what this resolver
// exists to do. Explicitly excluded by address; see KNOWN_SHARED_DEPLOYERS.
const KNOWN_SHARED_DEPLOYERS = new Set([
  "GC2C7AWLS2FMFTQAHW3IBUB4ZXVP4E37XNLEF2IK7IVXBB6CMEPCSXFO" // passkey-kit's canonical deployer (sha256("kalepail"))
]);

// Generic safety net for shared-deployer patterns not explicitly named
// above (any future or unresearched smart-wallet provider): a real
// end-user's own G-address keeps transacting on its own, ongoing basis -
// confirmed on the real Veil example (74 payments, 5 trades, "monthly:
// moderate"). A bare signing-only deployer key typically shows no RECENT
// activity of its own even if it has some lifetime payment count (confirmed
// on the passkey-kit deployer above: 10 payments total, but "monthly:
// none") - it never pays fees or acts as a transaction's own source
// account, since it only contributes one signature to someone else's auth
// entry. Not foolproof (a brand-new genuine user could also look quiet),
// but a real, cheap signal rather than nothing. Fails CLOSED (treats the
// link as untrusted) on any uncertainty, since silently pooling two
// unrelated people's activity is a worse failure than occasionally missing
// a valid link.
async function looksLikeIndependentlyActiveWallet(gAddress) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);
    let response;
    try {
      response = await fetch("https://api.stellar.expert/explorer/public/account/" + gAddress, {
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) return false;
    const data = await response.json();
    return !!(data.activity && data.activity.monthly && data.activity.monthly !== "none");
  } catch (err) {
    console.error("Failed to check own-activity for " + gAddress + ":", err.message);
    return false;
  }
}

async function resolveLinkedGAddress(contractAddress) {
  if (creatorCache.has(contractAddress)) return creatorCache.get(contractAddress);
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);
    let response;
    try {
      response = await fetch("https://api.stellar.expert/explorer/public/contract/" + contractAddress, {
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) {
      creatorCache.set(contractAddress, null);
      return null;
    }
    const data = await response.json();
    const candidate = typeof data.creator === "string" && GACCOUNT_RE.test(data.creator) ? data.creator : null;

    if (!candidate || KNOWN_SHARED_DEPLOYERS.has(candidate)) {
      creatorCache.set(contractAddress, null);
      return null;
    }

    const trusted = await looksLikeIndependentlyActiveWallet(candidate);
    const linked = trusted ? candidate : null;
    creatorCache.set(contractAddress, linked);
    return linked;
  } catch (err) {
    console.error("Failed to resolve creator for " + contractAddress + ":", err.message);
    // Cache the failure too (not just successes) - a lookup that's down or
    // 524ing right now shouldn't get retried on every single request for
    // the same wallet; worst case this contract's link is missed until the
    // process restarts (reference data already refreshes on an interval,
    // same tradeoff).
    creatorCache.set(contractAddress, null);
    return null;
  }
}

// ---- API ----
// G = classic account. C = contract address, including Soroban smart
// accounts (passkey/smart wallets) - their on-chain activity is indexed
// under their own C address (see xdrParser.ts: identity comes from each
// contract event's own arguments, not the tx envelope's source_account),
// so a C-address lookup hits real rows the same way a G-address one does.
// For self-deployed smart wallets (Pattern 1 above) it ALSO pulls in the
// linked G-address's own history, so the same person isn't scored as two
// disconnected partial identities.
// KNOWN LIMITATION: this can't tell "a personal smart wallet" apart from
// any other contract whose own creator happens to pass the activity check -
// e.g. querying a DeFi protocol's own contract address (not a wallet at
// all) would still merge in whichever G-address deployed it, if that
// address looks sufficiently active. Not fixed here: doing so would mean
// cross-checking against the indexer's PROTOCOL_REGISTRY, which this
// standalone service doesn't share code with. Low real-world impact since
// the expected input is a user's own wallet address, not an arbitrary
// contract, but worth knowing if a lookup result ever looks surprising.
const STELLAR_ADDRESS_RE = /^[GC][A-Z2-7]{55}$/;

app.use(express.static("public"));

// ---- /portfolio: current token balances + DeFi positions (see portfolio.js) ----
// The wallet's own indexed history says which contracts to ask (clustered by
// userAddress, so both queries are a few KB); the rest is free public Horizon /
// Soroban-RPC reads. Read-only public chain data, so it works for any address.
const portfolioService = createPortfolioService({
  queryTouched: async (wallet) => {
    const [[contractRows], [assetRows]] = await Promise.all([
      bq.query({
        query: "SELECT protocolName, category, contractId, MAX(blockCloseTime) AS last FROM `credit_bureau.credit_events_normalized` WHERE userAddress = @wallet GROUP BY 1, 2, 3 ORDER BY last DESC LIMIT 120",
        params: { wallet }
      }),
      bq.query({
        query: "SELECT DISTINCT assetContractId FROM `credit_bureau.credit_events_normalized` WHERE userAddress = @wallet AND assetContractId IS NOT NULL LIMIT 40",
        params: { wallet }
      })
    ]);
    return { contracts: contractRows, assetContracts: assetRows.map((r) => r.assetContractId) };
  },
  getAssetPriceMap: () => assetPriceMap,
  getVaultAssetMap: () => vaultAssetMap,
  getTokenPriceMap: () => tokenPriceMap
});

app.get("/portfolio", async (req, res) => {
  const wallet = (req.query.wallet || "").trim().toUpperCase();
  if (!STELLAR_ADDRESS_RE.test(wallet)) {
    return res.status(400).json({ error: "Invalid Stellar address. Expected a 56-character address starting with G (account) or C (contract/smart wallet)." });
  }
  try {
    res.json(await portfolioService.getPortfolio(wallet));
  } catch (err) {
    console.error("Portfolio error:", err);
    res.status(500).json({ error: "Could not load this wallet's holdings right now. Please try again." });
  }
});

// Shared by /score and /credit-line. Returns the score payload; throws on query timeout/errors.
async function computeWalletScore(wallet) {
    let linkedGAddress = null;
    if (wallet[0] === "C") {
      linkedGAddress = await resolveLinkedGAddress(wallet);
    }
    const lookupAddresses = linkedGAddress ? [wallet, linkedGAddress] : [wallet];

    const queryPromise = bq.query({
      query: "SELECT * FROM `credit_bureau.credit_events_normalized` WHERE userAddress IN UNNEST(@wallets) LIMIT 50000",
      params: { wallets: lookupAddresses }
    });
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("QUERY_TIMEOUT")), 25000)
    );
    const [rows] = await Promise.race([queryPromise, timeoutPromise]);

    if (rows.length === 0) {
      return {
        wallet: wallet,
        ...(linkedGAddress && { linkedGAddress: linkedGAddress }),
        tier: "C",
        score: 0,
        reasons: ["No Soroban DeFi activity found for this wallet" + (linkedGAddress ? " or its linked G-address (" + linkedGAddress + ")" : "") + " in the indexed history. Classic Stellar payments and trades aren't scored on their own."],
        path: "no-history",
        eventCount: 0,
        components: []
      };
    }

    const events = rows.map((r) => ({
      ledgerSequence: r.ledgerSequence,
      transactionHash: r.transactionHash,
      blockCloseTime: r.blockCloseTime.value || r.blockCloseTime,
      protocolName: r.protocolName,
      category: r.category,
      contractId: r.contractId,
      userAddress: r.userAddress,
      eventType: r.eventType,
      amount: r.amount,
      assetContractId: r.assetContractId,
      assetCode: r.assetCode,
      assetOutContractId: r.assetOutContractId,
      assetOutCode: r.assetOutCode,
      amountOut: r.amountOut,
      counterpartyAddress: r.counterpartyAddress,
      poolShareTokensAfter: r.poolShareTokensAfter,
      collateralRatioAfter: r.collateralRatioAfter
    }));

    const cycles = computeDebtCycles(events);
    // Account age / classic Stellar activity (G... accounts, or a smart wallet's linked G...). Runs
    // alongside the vault lookup below; any failure just means no bonus.
    const classicAddress = wallet[0] === "G" ? wallet : linkedGAddress;
    const classicPromise = classicAddress
      ? Promise.race([getClassicActivity(classicAddress), new Promise((resolve) => setTimeout(() => resolve(null), 6000))]).catch(() => null)
      : Promise.resolve(null);
    // Ask each DeFindex vault what it actually holds (cached per process) and let that answer win
    // over the vault_assets table: the table is hand-curated, missed newer vaults, and one row
    // (the biggest vault, ~24K wallets) was found mislabelled XLM instead of USDC. Anything the
    // vault can't answer unambiguously (multi-asset, unverified asset, RPC trouble) falls back
    // to the table. Never allowed to fail or slow scoring much.
    let effectiveVaultMap = vaultAssetMap;
    try {
      const vaults = [...new Set(events.filter((e) => e.protocolName === "defindex" && !e.assetCode).map((e) => e.contractId))].slice(0, 12);
      if (vaults.length) {
        const tickers = await Promise.race([Promise.all(vaults.map(resolveVaultTicker)), new Promise((resolve) => setTimeout(() => resolve([]), 6000))]);
        effectiveVaultMap = { ...vaultAssetMap };
        vaults.forEach((v, i) => { if (tickers[i]) effectiveVaultMap[v] = tickers[i]; });
      }
    } catch (e) { /* fall back to the table-only map */ }
    const classic = await classicPromise;
    const result = scoreWalletBase(events, cycles, assetPriceMap, effectiveVaultMap, classic);
    result.wallet = wallet;
    if (classic && (result.path === "lending" || result.path === "activity")) {
      result.classic = { ageYears: Math.round(classic.ageYears * 10) / 10, payments: classic.payments, trades: classic.trades, source: classic.source };
    }
    if (linkedGAddress) {
      result.linkedGAddress = linkedGAddress;
      result.reasons.push("Includes activity merged from linked G-address " + linkedGAddress + " (self-deployed smart wallet).");
    }
    result.eventCount = events.length;

    return result;
}

app.get("/score", async (req, res) => {
  const wallet = (req.query.wallet || "").trim().toUpperCase();

  if (!STELLAR_ADDRESS_RE.test(wallet)) {
    return res.status(400).json({ error: "Invalid Stellar address. Expected a 56-character address starting with G (account) or C (contract/smart wallet)." });
  }

  try {
    res.json(await computeWalletScore(wallet));
  } catch (err) {
    console.error("Scoring error:", err);
    if (err.message === "QUERY_TIMEOUT") {
      return res.status(504).json({ error: "This wallet has unusually high transaction volume and timed out while scoring. Please try again." });
    }
    res.status(500).json({ error: "Internal error computing score." });
  }
});

// Indicative credit line + APR for all three lending models (secured / unsecured / mix),
// from the wallet's score and its holdings. See credit-line.js for the policy.
app.get("/credit-line", async (req, res) => {
  const wallet = (req.query.wallet || "").trim().toUpperCase();
  if (!STELLAR_ADDRESS_RE.test(wallet)) {
    return res.status(400).json({ error: "Invalid Stellar address. Expected a 56-character address starting with G (account) or C (contract/smart wallet)." });
  }
  try {
    const [score, portfolio] = await Promise.all([
      computeWalletScore(wallet),
      portfolioService.getPortfolio(wallet).catch((e) => { console.error("Credit-line: portfolio unavailable:", e.message); return null; })
    ]);
    res.json({ wallet, ...computeOffers({ score, portfolio }), holdingsAsOf: portfolio ? portfolio.asOf : null, holdingsPartial: portfolio ? portfolio.partial : null });
  } catch (err) {
    console.error("Credit-line error:", err);
    if (err.message === "QUERY_TIMEOUT") {
      return res.status(504).json({ error: "This wallet has unusually high transaction volume and timed out while scoring. Please try again." });
    }
    res.status(500).json({ error: "Could not compute an indicative credit line right now." });
  }
});

// ---- Credit-line waitlist: email (+ the connected wallet), stored in credit_bureau.waitlist ----
// Created on first use (the service account owns the dataset). No IP is stored; it is used only for
// an in-memory rate limit. Duplicates are ignored, and the response never reveals
// whether an address was already on the list.
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
const waitlistHits = new Map(); // ip -> [timestamps]
const WAITLIST_PER_HOUR = 5;
let waitlistTableReady = null;

function ensureWaitlistTable() {
  if (!waitlistTableReady) {
    waitlistTableReady = (async () => {
      await bq.query("CREATE TABLE IF NOT EXISTS `credit_bureau.waitlist` (email STRING NOT NULL, source STRING, createdAt TIMESTAMP NOT NULL)");
      // Added later: the wallet the person had connected when they signed up. `walletVerified` is
      // reported by the web app (the signature check happens in the browser), so treat it as a hint.
      await bq.query("ALTER TABLE `credit_bureau.waitlist` ADD COLUMN IF NOT EXISTS wallet STRING, ADD COLUMN IF NOT EXISTS walletVerified BOOL");
    })().catch((e) => { waitlistTableReady = null; throw e; });
  }
  return waitlistTableReady;
}

function waitlistRateLimited(ip) {
  const now = Date.now();
  const recent = (waitlistHits.get(ip) || []).filter((t) => now - t < 60 * 60 * 1000);
  if (recent.length >= WAITLIST_PER_HOUR) { waitlistHits.set(ip, recent); return true; }
  recent.push(now);
  waitlistHits.set(ip, recent);
  if (waitlistHits.size > 5000) waitlistHits.delete(waitlistHits.keys().next().value);
  return false;
}

app.post("/waitlist", express.json({ limit: "2kb" }), async (req, res) => {
  const body = req.body || {};
  // Hidden "website" field: real people leave it empty, bots fill it. Pretend success, store nothing.
  if (body.website) return res.json({ ok: true });
  const email = String(body.email || "").trim().toLowerCase();
  if (email.length > 254 || !EMAIL_RE.test(email)) {
    return res.status(400).json({ error: "Enter a valid email address." });
  }
  const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
  if (waitlistRateLimited(ip)) {
    return res.status(429).json({ error: "Too many sign-ups from this connection. Please try again later." });
  }
  const source = "credit-line";
  // The wallet is optional (the web app sends it for a connected wallet, so people never type it).
  let wallet = null;
  if (body.wallet !== undefined && body.wallet !== null && body.wallet !== "") {
    wallet = String(body.wallet).trim().toUpperCase();
    if (!STELLAR_ADDRESS_RE.test(wallet)) return res.status(400).json({ error: "That wallet address isn't valid." });
  }
  const walletVerified = wallet ? body.walletVerified === true : null;
  try {
    await ensureWaitlistTable();
    // One row per email + wallet pair; signing up again changes nothing, except that a wallet
    // later proven by signature upgrades its flag.
    await bq.query({
      query: `MERGE \`credit_bureau.waitlist\` T
              USING (SELECT @email AS email, @source AS source, @wallet AS wallet, @walletVerified AS walletVerified) S
              ON T.email = S.email AND IFNULL(T.wallet, '') = IFNULL(S.wallet, '')
              WHEN MATCHED AND S.walletVerified AND NOT IFNULL(T.walletVerified, FALSE) THEN UPDATE SET walletVerified = TRUE
              WHEN NOT MATCHED THEN INSERT (email, source, createdAt, wallet, walletVerified) VALUES (S.email, S.source, CURRENT_TIMESTAMP(), S.wallet, S.walletVerified)`,
      params: { email, source, wallet, walletVerified },
      types: { email: "STRING", source: "STRING", wallet: "STRING", walletVerified: "BOOL" }
    });
    res.json({ ok: true });
  } catch (err) {
    console.error("Waitlist error:", err.message);
    res.status(500).json({ error: "Couldn't save your email right now. Please try again." });
  }
});

const port = process.env.PORT || 8080;
refreshReferenceData().then(() => {
  setInterval(refreshReferenceData, REFERENCE_DATA_REFRESH_MS);
  app.listen(port, () => console.log("credit-score-api listening on " + port));
});
