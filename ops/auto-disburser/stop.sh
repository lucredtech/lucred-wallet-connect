#!/usr/bin/env bash
# Stop the auto-disburser started by run.sh (via its PID file).
set -euo pipefail
cd "$(dirname "$0")"
PIDFILE="./watch.pid"
if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE" 2>/dev/null)" 2>/dev/null; then
  kill "$(cat "$PIDFILE")" && echo "stopped pid $(cat "$PIDFILE")"
  rm -f "$PIDFILE"
else
  echo "not running"
  rm -f "$PIDFILE" 2>/dev/null || true
fi
