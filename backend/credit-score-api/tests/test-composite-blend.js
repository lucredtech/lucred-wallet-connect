// Tests the compounding underwriting blend (underwriting-sources.js → compositeScore):
//   - income alone is capped at 50 (no tier A on income alone),
//   - DeFi + income compounds ABOVE the DeFi score,
//   - income never lowers a real on-chain score (floor),
//   - monotonic in income.
// Run: node tests/test-composite-blend.js
const assert = require("assert");
const { compositeScore } = require("../underwriting-sources");

// Build an ossContribution feature block that yields a chosen income strength.
const income = (bountyUsd12mo, { payouts = 5, lastPaidDaysAgo = 0, tenureDays = 180, gh = false } = {}) => ({
  ossContribution: { bountyUsd12mo, payouts12mo: payouts, lastPaidDaysAgo, tenureDays, githubEngagementVerified: gh },
});

(async () => {
  // 1. Income ALONE is capped at 50 — even an enormous income can't reach tier A on its own.
  const incomeOnlyHuge = await compositeScore(income(1_000_000));
  assert.strictEqual(incomeOnlyHuge.score, 50, "income-only is capped at 50, got " + incomeOnlyHuge.score);

  // 2. Income-only BELOW the cap scores at its own sub-score (no on-chain floor to beat).
  const incomeOnlyMid = await compositeScore(income(265)); // tuned to a ~30 sub-score
  assert.ok(incomeOnlyMid.score >= 28 && incomeOnlyMid.score <= 32, "mid income-only ~30, got " + incomeOnlyMid.score);
  assert.ok(incomeOnlyMid.score < 50, "mid income-only under the cap");

  // 3. DeFi + income COMPOUNDS above the DeFi score (the whole point).
  const both = await compositeScore({ onchainScore: 36, ...income(125, { payouts: 5 }) });
  assert.ok(both.score > 36, "DeFi 36 + income should exceed 36, got " + both.score);
  assert.ok(both.score < 50, "small income shouldn't rocket a 36 up, got " + both.score);

  // 4. Floor: income NEVER lowers a real on-chain score, even with weak/low income.
  const strongDefi = await compositeScore({ onchainScore: 70, ...income(5) }); // tiny income
  assert.ok(strongDefi.score >= 70, "income must never lower the DeFi score, got " + strongDefi.score);

  // 5. A capped-income wallet with weak DeFi still compounds (DeFi adds on top of the 50 base).
  const weakDefiBigIncome = await compositeScore({ onchainScore: 30, ...income(1_000_000) });
  assert.ok(weakDefiBigIncome.score > 50, "weak DeFi + capped income should exceed 50 via DeFi uplift, got " + weakDefiBigIncome.score);
  assert.ok(weakDefiBigIncome.score >= 30, "never below DeFi");

  // 6. Monotonic in income: more income never lowers the blended score (same on-chain).
  let prev = -1;
  for (const usd of [0.000001, 50, 200, 1000, 5000, 50000]) {
    const s = (await compositeScore({ onchainScore: 40, ...income(usd) })).score;
    assert.ok(s >= prev, `monotonic: income $${usd} gave ${s} < previous ${prev}`);
    assert.ok(s >= 40, "floor at DeFi 40");
    prev = s;
  }

  // 7. DeFi only (no income) is unchanged by the blend.
  const defiOnly = await compositeScore({ onchainScore: 58 });
  assert.strictEqual(defiOnly.score, 58, "DeFi-only passes through, got " + defiOnly.score);

  // 8. Bounded to 100.
  const maxed = await compositeScore({ onchainScore: 98, ...income(1_000_000, { gh: true }) });
  assert.ok(maxed.score <= 100, "bounded at 100");

  console.log("test-composite-blend: all assertions passed");
})().catch((e) => { console.error(e); process.exit(1); });
