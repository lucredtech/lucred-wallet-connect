#!/usr/bin/env bash
# Thin cron wrapper around load-drips-income.py (loads Drips Wave grant income from Horizon — free — into
# credit_bureau.oss_bounty_events). The Python loader is idempotent, so overlapping runs are safe.
#
#   Backfill (whole history):  ./load-drips-income.sh --full
#   Daily incremental (cron):  ./load-drips-income.sh
#
# Cron (daily; free — Horizon paging + tiny BQ read):
#   25 4 * * *  cd /path/ops/drips-income && ./load-drips-income.sh >> ~/lcrd-logs/drips-income.log 2>&1
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
echo "$(date -u +%FT%TZ) drips-income: start ${1:-incremental}"
exec python3 "$HERE/load-drips-income.py" "$@"
