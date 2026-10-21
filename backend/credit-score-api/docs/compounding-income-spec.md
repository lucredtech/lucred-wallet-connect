# Spec: compounding income with on-chain activity (granular underwriting, phase 1)

Status: **draft for review** · Owner: Lucred · Created 2026-10-21

## Problem

Today a wallet with **both** on-chain DeFi history **and** verified earned income scores no higher than
whichever single signal is stronger. Example — `GAE6BEVE…COWUJY`: activity score **36**, Drips income
sub-score **17**, final score **36** (income did nothing). A contributor who both uses DeFi *and* earns
$125/mo of OSS income is strictly more creditworthy than one who only does one of those, but the model
can't express that.

## Why (root cause, in the code)

`underwriting-sources.js → compositeScore` combines sources as a **confidence×weight weighted average**:

```
score = Σ(wᵢ·sᵢ) / Σ(wᵢ),   wᵢ = source.weightᵢ × confidenceᵢ
```

An average is always *between* its inputs, so a lower income sub-score pulls the blend **down**:

```
GAE6BEVE: onchain(score 36, w 1.0×1.0) + oss(score 17, w 0.7×0.5)
        = (1.0·36 + 0.35·17) / (1.0 + 0.35) = 41.95 / 1.35 ≈ 31
```

Then `index.js → applyIncomeBlend` (line ~851) keeps the max: `if (composite.score > result.score)` —
31 < 36, so the income is discarded. Income can only ever *raise via replacement*, never *compound*.
This is correct for "never lower a real score," but it means income is a **floor** (helps thin-file
wallets) not an **uplift** (does nothing once activity ≥ income).

## Design principles (any solution must hold these)

1. **Monotonic** — more/stronger income never lowers a score; more on-chain history never lowers it.
2. **Bounded** — final score stays in [0, 100].
3. **Compounding** — a wallet with two independent positive signals scores **≥ the max** of them, and
   strictly higher when the second signal is material.
4. **Confidence-weighted** — a cheaply-faked or weak signal adds little; identity-verified income adds more.
5. **Diminishing returns** — stacking many signals can't run the score to 100; each adds less headroom.
6. **Solvency-aware** — the on-chain pool prices APR and sizes the limit off the score (see
   `contracts/credit-line`). Raising scores raises limits and lowers APRs, so any change ships **with** a
   recalibration of the pool's limit/PD curve, not before it.

---

## Proposal A — additive diminishing-returns uplift (interim, keeps one 0–100 score)

Replace the averaging in `compositeScore` with: **start from the strongest source, then let each
additional source consume a bounded fraction of the remaining headroom.**

```
sort contributing sources by sub-score desc
final = s₀                                   # strongest signal is the base
for each remaining source i:
    uplift = (100 − final) × kᵢ × (sᵢ / 100) × confidenceᵢ
    final += uplift                          # headroom shrinks each step → diminishing returns
```

`kᵢ` = per-source **uplift factor** (how much a secondary signal is allowed to add), e.g. income `k≈0.5`.
Guarantees all six principles: base ≥ every input is false, but `final ≥ s₀ = max`, and each uplift ≥ 0
and < remaining headroom, so bounded and monotonic.

**Worked examples (income k=0.5):**

| Wallet | activity | income (score, conf) | today | Proposal A |
|---|---|---|---|---|
| `GAE6BEVE…` (both) | 36 | 17, 0.5 | 36 | 36 + (64·0.5·0.17·0.5) ≈ **39** |
| `GAWPT2ZKKM…` (income only) | — | 73, 0.6 | 73 | **73** (one source, unchanged) |
| strong activity + strong income | 70 | 65, 0.9 | 70 | 70 + (30·0.5·0.65·0.9) ≈ **79** |

So income now nudges the first wallet up a little and meaningfully lifts the last — without ever
overriding on-chain risk.

**Changes:** `underwriting-sources.js` (new blend in `compositeScore`, add `upliftFactor` per source);
`index.js applyIncomeBlend` can drop the `> result.score` guard since the blend is monotonic by
construction (keep it as a belt-and-suspenders). No contract change — but see principle 6.

**Calibration + tests:** unit-test monotonicity (↑income ⇒ ↑score), boundedness, `final ≥ max(inputs)`,
single-source identity, and a table of fixtures. Re-run the score distribution over the existing wallet
set and diff; confirm the shift is intentional before enabling.

---

## Proposal B — separate **risk** from **capacity** (recommended target; the real "granular underwriting")

A single 0–100 score conflates two different things the pool needs:

- **Probability of default (risk)** → should drive **APR and tier**. Comes from repayment behavior and
  on-chain quality.
- **Ability to repay (capacity)** → should drive the **limit/amount**. Comes from **income** (Drips,
  GrantFox, payroll) and collateral.

Income is evidence of *capacity*, not low *default risk*. Compounding it into the risk score (Proposal A)
makes someone's APR cheaper just because they earn — which is not what income proves. The cleaner model,
and what "use all the datapoints to determine the amount they can get" asks for:

- **Risk score (PD)** stays the on-chain behavioral score → sets APR + tier (unchanged pricing).
- **Capacity** = a USD affordability figure built from the income features (trailing-12mo income,
  cadence/consistency, tenure, recency, confidence) → sets the **limit**.
- These compose cleanly onto the existing contract **without a contract change**: `set_line(borrower,
  score, limit, score_ref)` already lets the off-chain underwriter choose `limit`, capped on-chain by
  `quote(score, cycles).max_limit`. So capacity can raise the line **up to** the on-chain safety cap; the
  risk score still prices it. (To let capacity raise the line *beyond* today's starter cap, raise the cap
  formula in the contract — a deliberate, separately-reviewed change with its own solvency sign-off.)

**Mapping to today:** the graded starter line ($5→$50) is a *score*-sized floor; capacity underwriting
replaces "limit = f(score)" with "limit = min(capacityUsd, on-chain cap)", so a wallet earning $1.5k/mo
of verified income can be offered a larger line than its score alone implies — bounded by the pool's
risk cap and liquidity.

**Solvency guardrails:** cap capacity's contribution to the limit (e.g. ≤ N× trailing monthly income),
require ≥ k verified payouts and identity confidence before capacity counts, and keep per-loan + pool TVL
caps. Model the expected-loss impact before raising on-chain caps.

---

## Recommendation & rollout

1. **Now:** ship **Proposal A** behind a flag (interim compounding in the score) **with** a matched
   recalibration of the pool limit/PD curve — small, reversible, immediately fixes the "income does
   nothing" surprise. Verify the score-distribution diff + solvency on testnet.
2. **Next:** build **Proposal B** (risk/capacity split) as the durable architecture; it directly delivers
   "granular underwriting → the amount they can get," prices APR honestly, and already fits the contract's
   underwriter-chosen-limit seam. A/B the limit outcomes on testnet before any mainnet cap change.

## Decisions needed

- Interim (A) vs straight-to-capacity (B), or A-then-B as above?
- Income **uplift factor** `k` (A) / capacity **income multiple** and caps (B).
- May the risk **score itself** move for income (A), or must income affect **only the limit** (B)?
- Solvency sign-off owner before any on-chain limit-cap increase.
