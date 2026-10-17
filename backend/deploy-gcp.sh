#!/usr/bin/env bash
#
# deploy-gcp.sh — bring the credit-bureau indexer + loader back up on the new GCP VM.
#
# Context: the Azure fleet died when its subscription was disabled, freezing
# BigQuery credit_events at ledger 64,964,600. galexie is already running on the
# GCP VM `lcrd-indexer` (project lucred-715bc), exporting raw ledgers to
# gs://stellar-credit-bureau-data-index/raw. This script redeploys the SAME
# production code (backend/indexer + backend/loader) on that VM:
#
#   - one indexer container in LIVE_TIP_DYNAMIC_PREFIX mode (replaces the old
#     15-shard fleet for keeping the live tip current)
#   - the idempotent v2 loader on cron (extracted_logs -> credit_events)
#
# Differences from the old Azure setup, both simplifications:
#   - NO gcp-key.json. The VM's attached service account provides ADC via the
#     metadata server, so `new Storage()` / `new BigQuery()` authenticate with
#     nothing mounted. (Confirmed: gcs.ts uses `new Storage()` with no args.)
#   - ENABLE_DYNAMIC_POOL_DISCOVERY + LIVE_TIP_DYNAMIC_PREFIX on a single box.
#
# PREREQUISITES on the VM (verify once):
#   - docker installed and usable with sudo (galexie already runs via docker, so
#     this should already hold)
#   - this repo cloned; run this script from the repo's backend/ directory
#   - the VM's service account has roles/storage.objectAdmin on the bucket and
#     roles/bigquery.dataEditor + jobUser on project lucred-715bc
#
# SAFE BY DESIGN: this script starts the indexer and does loader --init +
# --dry-run only. It never bulk-loads. You review the dry-run count, then add
# the cron lines it prints. The loader dedups via BigQuery credit_bureau.loaded_files
# (intact on GCP), so it will only ever load files not already recorded there.
#
# Usage:
#   cd .../lucred-wallet-connect/backend
#   ./deploy-gcp.sh            # build image, start indexer, init+dry-run loader
#   ./deploy-gcp.sh indexer    # just (re)build + (re)start the indexer
#   ./deploy-gcp.sh loader     # just set up loader deps + init + dry-run
#   ./deploy-gcp.sh cron       # print the cron lines to add

set -euo pipefail

# --- config (override via env if the VM differs) ---------------------------
BUCKET="${BUCKET:-stellar-credit-bureau-data-index}"
IMAGE="${IMAGE:-stellar-credit-bureau-indexer-indexer}"   # keep the prod image name
INDEXER_CONTAINER="${INDEXER_CONTAINER:-lcrd-indexer-live}"
NODE_IMAGE="${NODE_IMAGE:-node:20-alpine}"
DATASET="${DATASET:-credit_bureau}"
EVENTS_TABLE="${EVENTS_TABLE:-credit_events}"

# Resolve paths relative to this script so it works from any clone location.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"   # .../backend
INDEXER_DIR="$HERE/indexer"
LOADER_DIR="$HERE/loader"
LOG_DIR="${LOG_DIR:-$HOME/lcrd-logs}"
mkdir -p "$LOG_DIR"

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }

build_indexer() {
  log "Building indexer image ($IMAGE) — compiles TS inside the container"
  sudo docker build -t "$IMAGE" "$INDEXER_DIR"
}

start_indexer() {
  log "Starting indexer in LIVE_TIP mode (metadata ADC, no key file)"
  sudo docker rm -f "$INDEXER_CONTAINER" >/dev/null 2>&1 || true
  sudo docker run -d --name "$INDEXER_CONTAINER" --restart unless-stopped \
    -e RAW_BUCKET_NAME="$BUCKET" \
    -e OUTPUT_BUCKET_NAME="$BUCKET" \
    -e OUTPUT_PREFIX="extracted_logs/" \
    -e CHECKPOINT_PATH="_indexer_checkpoint.json" \
    -e POLL_INTERVAL_MS="15000" \
    -e DELETE_RAW_AFTER_PROCESSING="true" \
    -e ENABLE_DYNAMIC_POOL_DISCOVERY="true" \
    -e LIVE_TIP_DYNAMIC_PREFIX="true" \
    "$IMAGE"
  log "Indexer started. Follow logs with:"
  echo "    sudo docker logs -f $INDEXER_CONTAINER"
}

# The loader needs @google-cloud/bigquery, which the indexer image does NOT have.
# Install the loader's own node_modules once (inside a node container — no node on
# the host), then we run loader.js in a throwaway node container with ADC.
setup_loader_deps() {
  if [ ! -d "$LOADER_DIR/node_modules" ]; then
    log "Installing loader dependencies into loader/node_modules (via $NODE_IMAGE)"
    sudo docker run --rm -v "$LOADER_DIR":/app -w /app \
      --user "$(id -u):$(id -g)" -e HOME=/tmp \
      "$NODE_IMAGE" npm install --omit=dev
  else
    log "loader/node_modules already present — skipping install"
  fi
}

# Run the loader in a throwaway container. ADC comes from the VM metadata server,
# which is reachable from the container's network by default — no key file.
run_loader() {
  sudo docker run --rm \
    --user "$(id -u):$(id -g)" -e HOME=/tmp \
    -e BUCKET="$BUCKET" -e DATASET="$DATASET" -e EVENTS_TABLE="$EVENTS_TABLE" \
    -v "$LOADER_DIR":/app -w /app \
    --entrypoint node "$NODE_IMAGE" loader.js "$@"
}

loader_init_and_dryrun() {
  setup_loader_deps
  log "Loader: --init (create loaded_files ledger table if missing; idempotent)"
  run_loader --init
  log "Loader: --dry-run (shows how many NEW files would load; changes nothing)"
  run_loader --dry-run
  cat <<EOF

Review the dry-run count above.
  - If it looks sane (new live-tip files only), do a first real load:
        $0 loadonce
  - loaded_files already knows every previously-loaded file, so existing
    ~11M rows will NOT be reloaded.
EOF
}

load_once() {
  setup_loader_deps
  log "Loader: real targeted run (atomic, idempotent)"
  run_loader | tee -a "$LOG_DIR/bq-loader-v2.log"
}

print_cron() {
  local wrapper="$HERE/loader-run-gcp.sh"
  cat > "$wrapper" <<EOF
#!/usr/bin/env bash
# Thin wrapper so cron runs the loader with the right env + single-run lock.
set -euo pipefail
exec 9>/tmp/bq-loader-v2.lock
flock -n 9 || { echo "\$(date -u +%FT%TZ) previous run in progress, skipping"; exit 0; }
sudo docker run --rm --user "\$(id -u):\$(id -g)" -e HOME=/tmp \\
  -e BUCKET="$BUCKET" -e DATASET="$DATASET" -e EVENTS_TABLE="$EVENTS_TABLE" \\
  -v "$LOADER_DIR":/app -w /app --entrypoint node "$NODE_IMAGE" loader.js "\$@"
EOF
  chmod +x "$wrapper"
  log "Wrote cron wrapper: $wrapper"
  cat <<EOF

Add these to crontab (crontab -e):

  */30 * * * * $wrapper            >> $LOG_DIR/bq-loader-v2.log 2>&1
  10 3  * * * $wrapper --full      >> $LOG_DIR/bq-loader-v2.log 2>&1

The first is the normal targeted run; the second is the daily full-scan safety net.
EOF
}

case "${1:-all}" in
  indexer)  build_indexer; start_indexer ;;
  loader)   loader_init_and_dryrun ;;
  loadonce) load_once ;;
  cron)     print_cron ;;
  all)
    build_indexer
    start_indexer
    loader_init_and_dryrun
    print_cron
    log "Done. Indexer is live; review the loader dry-run, run '$0 loadonce', then add the cron lines."
    ;;
  *) echo "usage: $0 [all|indexer|loader|loadonce|cron]"; exit 2 ;;
esac
