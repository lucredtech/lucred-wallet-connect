# Drips Wave income loader

Indexes **Drips Wave** OSS-contributor income into `credit_bureau.oss_bounty_events` so thin-file wallets
that earn Drips grants become scoreable (the existing income scorer, `backend/credit-score-api/oss-contribution.js`,
sums `assetCode='USDC'` rows per receiver over 12 months — no code change needed).

## Why this is different from the escrow sources
GrantFox / Trustless Work pay through **Soroban escrow contracts** (decoded from contract events by the
in-stream indexer — see `backend/indexer/src/escrowBounty.ts`). **Drips Wave is custodial**: it sends a
plain **classic Stellar payment** of Circle USDC from a fixed treasury account to each contributor (a `$1`
test, then the full grant). There is nothing to decode, so this source is just *outbound payments from one
account* — read straight from **Horizon** (free), not from the BigQuery all-operations dataset (scanning
that for this window costs ~$28).

## Source
- Treasury account: `GC2SFZ2EQ4XIPBQIXYJMQSLVG7NQSHAIGB4PVTBIVTOTJDMNS4NJD4EU` (created ~2026-01-30)
- Asset: Circle USDC (`GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN`, SAC `CCW67TSZ…SJMI75`)
- We keep grants `> $1` (the `$1` payments are withdrawal tests, not earnings).
- **Brand attribution is behavioral/inferred**: 666 recipients overlap our known OSS contributors; the
  documented Drips `$1`-test→grant flow; numeric grant-id memos; recent account. Confirm with a
  ground-truth Drips payout tx if certainty is needed.

## Run
```bash
./load-drips-income.sh --full   # backfill the whole history (one-off)
./load-drips-income.sh          # daily incremental (pages newest-first, stops once caught up)
```
Idempotent (skips payments already loaded), so overlapping runs are safe. Needs `python3` + `bq` (gcloud
auth). The loader (`load-drips-income.py`) reads already-loaded Drips rows, pages Horizon with 429 backoff,
and `bq load`s only the new grants.

## Cron (VM)
```
25 4 * * *  cd ~/lcrd/drips-income && ./load-drips-income.sh >> ~/lcrd-logs/drips-income.log 2>&1
```

## Backfill result (2026-10-21)
18,813 grant rows · 2,435 wallets · ~$776,878 USDC (grants $2–$751, since 2026-02-09). 1,717 of those
wallets were new to the income table.

## Discovering more payment-based income sources
The treasury was found by cross-referencing Circle-USDC payers against known OSS wallets
(`oss_bounty_events.receiver`) over `enriched_history_operations` (partitioned by `batch_run_date` — filter
it; ~$0.70 for a ~3.5-month window). The same scan flags other candidate payers (e.g. `GC4MRJZW`,
`GBOGVS7Q`, `GCQFPCCK`) worth classifying. This complements the escrow-platform monitor in
`ops/tw-platform-monitor`.
