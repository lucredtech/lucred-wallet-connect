# Loader: extracted events → BigQuery

Loads the event files the indexer writes to `extracted_logs/` into `credit_bureau.credit_events`.
It is **idempotent**: running it twice, losing its checkpoint, or re-exporting a ledger can never load a file twice.

## Why it was rewritten
The first loader chose files by GCS creation time and saved its checkpoint only after *every* chunk had loaded.
That produced about 1.49 million duplicate rows (12.8% of the table) in 2026:

- A re-exported ledger rewrites its event file under the **same name** with a **newer timestamp**, so it was loaded again.
- A run that failed on chunk 3 of 5 had already loaded chunks 1–2, and the next run loaded them again.
- It lived inside a worker container, so recreating that container deleted the loader and caused a day-long outage
  followed by a 45,000-file catch-up run.

## How it works
1. **Ledger.** `credit_bureau.loaded_files` records every event file by **name**. A name in the ledger is never loaded again,
   even if the object is rewritten or the checkpoint is lost.
2. **Atomic chunks.** Each chunk of up to 5,000 files is **one BigQuery transaction** that inserts the event rows *and* the
   ledger rows together (the files are read through a temporary external table). A failure leaves nothing half-done.
3. **Checkpoint is only a hint.** `_bq_loader_v2_state.json` remembers where to start looking; correctness never depends on it.
4. **Cheap listing.** Normal runs list only the live partition's files (the old loader listed all ~1.4M objects, about 280
   list calls, every 30 minutes). A **daily full scan** is the safety net for stragglers; the ledger makes it harmless.
5. **Guards.** One run at a time (`flock`); refuses a single run of more than 150,000 files; seeding twice is refused.

## Files
| File | Purpose |
|---|---|
| `loader.js` | the loader |
| `run-loader.sh` | runs it in a throwaway container (no Node on the host), one run at a time |
| `package.json` | dependencies (installed once into `~/jobs/node_modules`) |

## Commands
```bash
run-loader.sh --init                 # create the ledger table (safe to repeat)
run-loader.sh --seed [--before ISO]  # one-off: record every file created at/before the cutoff as already loaded
run-loader.sh --dry-run              # show what would load, change nothing
run-loader.sh                        # normal targeted run (cron, every 30 minutes)
run-loader.sh --full                 # scan the whole prefix (cron, daily)
```
Cron:
```
*/30 * * * * /home/stellar/jobs/loader/run-loader.sh >> /home/stellar/bq-loader-v2.log 2>&1
10 3 * * *   /home/stellar/jobs/loader/run-loader.sh --full >> /home/stellar/bq-loader-v2.log 2>&1
```

## Cutting over from the old loader
1. Comment out the old cron line (`docker exec gcp_ts_worker node /app/bq-incremental-loader.js`) and wait for any run to finish.
2. `run-loader.sh --seed` (cutoff = the old loader's checkpoint, read automatically).
3. `run-loader.sh --dry-run`: it should list only the files newer than the old checkpoint.
4. `run-loader.sh`, then run the duplicate check (`~/jobs/dup-check.sh`).
5. Add the two cron lines above.

**Rolling back.** Comment out the new cron lines, set `lastWatermark` in `_bq_loader_checkpoint.json` to `watermark` from
`_bq_loader_v2_state.json`, then re-enable the old line. (Otherwise the old loader would reload what the new one loaded.)

## Tested
End to end on scratch tables and a private copy of real event files: seed cutoff, dry run, real load (rows match the source
files exactly), an immediate re-run (loads nothing), and a re-exported file (loads nothing, zero duplicates).

## Settings (environment)
`BUCKET`, `PREFIX`, `DATASET`, `EVENTS_TABLE`, `LEDGER_TABLE`, `STATE_PATH`, `CHUNK_SIZE` (5000), `OVERLAP_HOURS` (12),
`MAX_FILES_PER_RUN` (150000).
