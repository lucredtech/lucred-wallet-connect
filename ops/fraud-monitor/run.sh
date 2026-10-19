#!/usr/bin/env bash
# Build + run the fraud-monitor container (reads ./config.env). Testnet only.
set -euo pipefail
cd "$(dirname "$0")"
docker build -t lcrd-fraud-monitor .
docker rm -f lcrd-fraud-monitor 2>/dev/null || true
docker run -d --name lcrd-fraud-monitor --restart unless-stopped --env-file config.env \
  -v "$PWD/state.json:/app/state.json" lcrd-fraud-monitor
echo "started. logs: docker logs -f lcrd-fraud-monitor"
