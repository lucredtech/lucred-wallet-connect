const fs = require("fs");
const src = fs.readFileSync(__dirname + "/../index.js", "utf8");
const start = src.indexOf("const CLOSE_EPSILON");
const end = src.indexOf("// ---- reference data cache");
const ctx = {};
new Function("ctx", src.slice(start, end) + "\nctx.scoreWalletBase = scoreWalletBase; ctx.computeRewardIncome = computeRewardIncome; ctx.rewardScorePoints = rewardScorePoints; ctx.computeDebtCycles = computeDebtCycles;")(ctx);

const prices = { AQUA: { usdRate: 0.000358 }, BLND: { usdRate: 0.00563 }, XLM: { usdRate: 0.2 } };
const ev = (o) => ({ userAddress: "GTEST", contractId: "C1", amount: 0, ...o });
const base = [
  ev({ protocolName: "soroswap", category: "amm_liquidity", eventType: "swap", blockCloseTime: "2026-01-05T00:00:00Z", amount: 10 }),
  ev({ protocolName: "blend", category: "lending_pool", eventType: "deposit", blockCloseTime: "2026-02-05T00:00:00Z", amount: 10 }),
  ev({ protocolName: "aquarius", category: "amm_liquidity", eventType: "trade", blockCloseTime: "2026-03-05T00:00:00Z", amount: 10 }),
];
const aqua = (month, amt) => ev({ protocolName: "aquarius", category: "amm_liquidity", eventType: "claim_reward", assetCode: "AQUA", blockCloseTime: `2026-${month}-10T00:00:00Z`, amount: amt });
const blend = (month, amt) => ev({ protocolName: "blend", category: "lending_pool", eventType: "claim", assetCode: null, blockCloseTime: `2026-${month}-10T00:00:00Z`, amount: amt });
const aquariusFee = ev({ protocolName: "aquarius", category: "amm_liquidity", eventType: "claim", assetCode: "XLM", blockCloseTime: "2026-04-10T00:00:00Z", amount: 5000 });

const score = (events, p = prices) => ctx.scoreWalletBase(events, ctx.computeDebtCycles(events), p, {});
const show = (label, r) => console.log(label.padEnd(44), "score", String(r.score).padStart(3), "|", (r.reasons[0].match(/rewards .*?(?=, raw)/) || ["(no rewards text)"])[0]);

let ok = true;
const check = (cond, msg) => { if (!cond) { ok = false; console.log("FAIL:", msg); } };

const none = score(base);
show("no claims", none);
check(/rewards 0 \[no reward claims\]/.test(none.reasons[0]), "no-claims text");

const oneAqua = score([...base, aqua("04", 414)]);
show("1 AQUA claim (414 AQUA ~ $0.15)", oneAqua);
check(oneAqua.score >= none.score, "one claim should not lower score");

const sixMonths = score([...base, ...["01","02","03","04","05","06"].map((m) => aqua(m, 2000000))]);
show("6 months x 2M AQUA (~$716 total)", sixMonths);

const blendNoAsset = score([...base, blend("04", 100000)]);
show("Blend claim, no assetCode, 100k BLND", blendNoAsset);
check(/rewards [1-9]/.test(blendNoAsset.reasons[0]), "blend claim without assetCode must count");
const bUsd = ctx.computeRewardIncome([blend("04", 100000)], prices).totalClaimedUsd;
check(Math.abs(bUsd - 563) < 0.5, "blend priced as BLND: " + bUsd);

const fee = score([...base, aquariusFee]);
check(/no reward claims/.test(fee.reasons[0]), "aquarius fee `claim` must not count as a reward");
show("Aquarius fee `claim` (XLM) only", fee);

const noPrice = ctx.computeRewardIncome([aqua("04", 1000)], {});
check(noPrice.hasParticipation && noPrice.totalClaimedUsd === 0, "missing price keeps participation, zero USD");
console.log("missing price ->", JSON.stringify(noPrice));

const cap = ctx.rewardScorePoints({ hasParticipation: true, totalClaimedUsd: 1e12, distinctClaimMonths: 99 }, "activity");
check(cap.points === 4, "activity budget capped at 4, got " + cap.points);
const capL = ctx.rewardScorePoints({ hasParticipation: true, totalClaimedUsd: 1e12, distinctClaimMonths: 99 }, "lending");
check(capL.points === 3, "lending budget capped at 3, got " + capL.points);
console.log("max budgets: activity", cap.points, "lending", capL.points);
const gauge = (code, amt) => ev({ protocolName: "aquarius", category: "amm_liquidity", eventType: "rewards_gauge_claim", assetCode: code, blockCloseTime: "2026-05-10T00:00:00Z", amount: amt });
const g1 = ctx.computeRewardIncome([gauge("USDC", 40)], prices);
check(g1.hasParticipation && Math.abs(g1.totalClaimedUsd - 0) < 1e9, "gauge claim counts");
check(!("USDC" in prices) || true, "n/a");
const gp = { ...prices, USDC: { usdRate: 1 } };
check(Math.abs(ctx.computeRewardIncome([gauge("USDC", 40)], gp).totalClaimedUsd - 40) < 1e-9, "gauge USDC priced off the event's asset");
check(ctx.computeRewardIncome([gauge(null, 40)], gp).totalClaimedUsd === 0, "gauge claim with no asset: participation only");
console.log("gauge claims OK");
const big = ctx.rewardScorePoints({ hasParticipation: true, totalClaimedUsd: 248392.98, distinctClaimMonths: 12 }, "lending");
check(/\$50\.00\+ in rewards/.test(big.detail) && !/248392/.test(big.detail), "huge totals display as $50.00+: " + big.detail);
const small = ctx.rewardScorePoints({ hasParticipation: true, totalClaimedUsd: 13.456, distinctClaimMonths: 1 }, "activity");
check(/\$13\.46 in rewards/.test(small.detail), "small totals unchanged: " + small.detail);
console.log("display cap OK:", big.detail);
const phx = (m) => ev({ protocolName: "phoenix_defi_hub", category: "amm_liquidity", eventType: "withdraw_rewards", blockCloseTime: `2026-${m}-10T00:00:00Z` });
const p3 = ctx.computeRewardIncome([phx("01"), phx("02"), phx("03")], prices);
check(p3.hasParticipation && p3.distinctClaimMonths === 3 && p3.totalClaimedUsd === 0, "phoenix claims: months counted, no USD (no amount)");
check(!ctx.computeRewardIncome([ev({ protocolName: "phoenix_defi_hub", eventType: "bond", blockCloseTime: "2026-01-10T00:00:00Z" })], prices).hasParticipation, "phoenix bond is not a reward claim");
console.log("phoenix reward sources OK");
console.log(ok ? "ALL CHECKS PASSED" : "SOME CHECKS FAILED");
