# credit-line — USDC lending pool with on-chain-priced credit lines (Soroban)

Stellar/Soroban port of [lcrd-arc-credit](https://lucredtech.github.io/lcrd-arc-credit/)'s `CreditLine.sol`.
Same product, Stellar instead of Arc/EVM: a USDC lending pool whose credit lines are priced **on-chain**
from an LCRD credit score, so anyone can verify a borrower's rate with `quote`.

## How it works
- **Lenders** `deposit` USDC and receive pool shares (ERC-4626-style, with virtual shares/assets to blunt
  the first-depositor inflation attack). Yield is the interest borrowers repay; a written-off line lowers
  share value. `withdraw` any time there is cash.
- **Unsecured lines** — the underwriter calls `set_line(borrower, score, limit, score_ref)`. The contract
  derives tier/APR/limit itself from the published policy; only the score-report **hash** is stored, never
  personal data. Needs a score ≥ 50; the starter line is graded by score, not a flat per-tier amount.
- **Secured lines** — `open_secured_line` against your own pool shares, up to 71.25% of their value, no
  score needed. The backing shares are locked until repaid; on default the underwriter `seize_collateral`.
- Interest accrues by the second (simple). `repay` pays interest first, then principal. A **completed
  cycle** (loan using ≥ 50% of the line, held ≥ 21 days, repaid in full) cuts the APR 0.5%/cycle (max 2%)
  and grows the limit (starter × (1 + cycles), capped at the tier ceiling), automatically.

## Pricing (policy `lcrd-unsecured-2026-10`, bps)
```
unsecured APR = 800 + score_premium + 300 + default_premium
  score_premium:   2000 at score 0  → 300 at 100
  default_premium: 4100 at score 50 → 1200 at 100  (− 250/cycle, floor 500)
secured APR   = 800 + 35% of score_premium   (1500 = 15% with no score)
both: − 50 per completed cycle (max 200), clamped to [600, 7000]
tiers: A 67-100, B 34-66, C 0-33
unsecured min score: 50
starter (graded by score): tier B (50-66) $5 → $25,  tier A (67-100) $26 → $50
ceiling: A 2500 / B 250 USDC
```

## Units & identity
Amounts are USDC base units at **7 decimals** (Stellar USDC). Identity is the borrower's own **Stellar
address** — there is no cross-chain proof step (the Arc version needed one because the chain was EVM but
the score is of a Stellar wallet).

## Build & test
```bash
cargo test                 # 19 tests: pricing, pool, accrual, cycles, secured, write-off, seize, admin
stellar contract build     # -> target/wasm32v1-none/release/credit_line.wasm
```

## Testnet
```bash
bash scripts/deploy-testnet.sh   # deploys + runs a full lend → set_line → borrow → repay lifecycle
```
Writes the deployed ids to `.credit-line-testnet.json`.

## Status
Contract + full test suite (this directory). The off-chain underwriter and the web dApp (Freighter +
`@stellar/stellar-sdk`, reusing the LCRD score API) are the next pass.
