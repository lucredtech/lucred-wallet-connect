# Trustless Work platform monitor

Two ways new Trustless Work platforms (not yet in the `TRUSTLESS_WORK_PLATFORMS` registry in
`backend/indexer/src/escrowBounty.ts`) get surfaced for classification:

1. **In-stream (indexer):** the OSS-bounty extractor's `onUnknownPlatform` hook logs any unregistered
   platform it sees (once per platform per process) — look for `🆕 Unregistered Trustless Work platform …`
   in `docker logs lcrd-indexer-live`. Immediate, zero cost.
2. **Scheduled (`report.sh`):** a monthly BigQuery rollup of `tw_init` escrows by `roles.platform` that
   flags any not in the registry and records them to `credit_bureau.oss_unknown_platforms` (durable).
   Scans the public `crypto-stellar` dataset (~$1.8/run at 35 days) — run MONTHLY. Cron on the VM:
   `5 4 1 * * DAYS=35 /home/mac/lcrd/tw-platform-report.sh >> /home/mac/lcrd-logs/tw-platform-report.log 2>&1`

To onboard a platform found by either: read `roles.platform` from one of its escrows, add a row to
`TRUSTLESS_WORK_PLATFORMS` with `{name, incomeType, include, weight}`, redeploy the indexer, and
backfill its history (see `lcrd-oss-income-source` memory).
