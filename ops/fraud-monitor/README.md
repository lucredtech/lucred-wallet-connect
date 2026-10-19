# LCRD fraud / ladder-gaming monitor (testnet)

Catches the borrowing patterns that slip through the credit-line contract's on-chain guards
(≥50% utilization, ≥21-day hold, ≤1 ladder step / 30 days, 90-day pause after a write-off):

- **Wash-cycling** — cycles that hug the minimum duration *and* the utilization floor *and* are
  self-funded (no third-party payer): robotic ladder-grinding with no real use.
- **Sybil lockstep** — many distinct wallets completing cycles in the same hourly windows.

It reconstructs each borrower's cycles from the pool's own `borrowed` / `repaid` / `line_set` /
`cycle` events, scores the behaviour, and flags on a repeated signature confirmed across ≥2 polls.
State persists to `state.json`, so history accrues past the RPC's ~24h event-retention window.

## Safety
`DRY_RUN=true` is the **default** — it logs and (optionally) webhooks, but does **not** freeze. Only
set `DRY_RUN=false` (with `UNDERWRITER_SECRET`) to actually call `freeze(borrower)` on confirmed
offenders. Freezing also zeroes the borrower's on-chain ladder progress.

## Run
```
cp config.env.example config.env   # fill UNDERWRITER_SECRET only if enforcing
./run.sh                           # docker build + run (restart unless-stopped)
docker logs -f lcrd-fraud-monitor
```
Deploy alongside the auto-disburser (e.g. the GCP VM). Testnet only — mock tokens, no real value.
