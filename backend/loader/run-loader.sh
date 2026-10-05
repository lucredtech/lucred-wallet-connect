#!/bin/bash
# Runs loader.js in a throwaway container (no Node on the host, independent of gcp_ts_worker), one run at a time.
# Dependencies live in /home/stellar/jobs/node_modules, shared with the other host jobs.
#   run-loader.sh            targeted run (cron, every 30 minutes)
#   run-loader.sh --full     scan the whole prefix (cron, once a day)
#   run-loader.sh --dry-run  show what it would load, change nothing
exec 9>/tmp/bq-loader-v2.lock
flock -n 9 || { echo "$(date -u +%FT%TZ) previous run still in progress, skipping"; exit 0; }
echo "$(date -u +%FT%TZ) start $*"
sudo docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp \
  -e GOOGLE_APPLICATION_CREDENTIALS=/secrets/gcp-key.json \
  ${LOADER_ENV:-} \
  -v /home/stellar/stellar-credit-bureau-indexer/secrets/gcp-key.json:/secrets/gcp-key.json:ro \
  -v /home/stellar/jobs:/jobs -w /jobs/loader --entrypoint node \
  stellar-credit-bureau-indexer-indexer loader.js "$@"
