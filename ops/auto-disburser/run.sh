#!/usr/bin/env bash
# Singleton launcher for the auto-disburser. Safe to call from `@reboot` cron and by hand:
# if an instance is already running it exits; otherwise it loads config.env and starts the watcher,
# appending to watch.log. No root required.
set -euo pipefail
cd "$(dirname "$0")"

if pgrep -f "node .*auto-disburser/watch.js" >/dev/null 2>&1; then
  echo "already running"; exit 0
fi

if [ ! -f config.env ]; then
  echo "config.env missing — copy config.env.example to config.env and set TREASURY_SECRET"; exit 1
fi

set -a; . ./config.env; set +a
nohup node watch.js >> watch.log 2>&1 &
echo "started pid $! (logging to $(pwd)/watch.log)"
