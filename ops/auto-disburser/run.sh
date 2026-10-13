#!/usr/bin/env bash
# Singleton launcher for the auto-disburser, safe for `@reboot` cron and manual use. Uses a PID file
# (not pgrep -f, which false-matches command strings). No root required.
set -euo pipefail
cd "$(dirname "$0")"
DIR="$(pwd)"
PIDFILE="$DIR/watch.pid"

if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE" 2>/dev/null)" 2>/dev/null; then
  echo "already running (pid $(cat "$PIDFILE"))"; exit 0
fi

if [ ! -f config.env ]; then
  echo "config.env missing — copy config.env.example to config.env and set TREASURY_SECRET"; exit 1
fi

set -a; . ./config.env; set +a
# stdbuf -oL/-eL forces line-buffered output so watch.log updates live (Node block-buffers to files).
nohup stdbuf -oL -eL node "$DIR/watch.js" >> watch.log 2>&1 &
echo $! > "$PIDFILE"
echo "started pid $! (logging to $DIR/watch.log)"
