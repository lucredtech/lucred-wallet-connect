#!/usr/bin/env bash
# Deploy the underwriter on a host with Docker (e.g. the GCP VM lcrd-indexer). Runs two containers:
# the underwriter and Caddy (auto-HTTPS via an <ip-with-dashes>.sslip.io domain). The signing key is
# GENERATED here into ./secrets/uw.secret and only mounted — it never passes through env or args, and
# the operator re-points the pool to the printed public key with `set_underwriter` (owner-authorized).
#
# Run from this directory on the host:
#   POOL=C... UW_DOMAIN=34-57-119-191.sslip.io ./deploy-vm.sh
# Then, from wherever the owner key lives:
#   stellar contract invoke --id $POOL --source <owner> --network testnet -- set_underwriter --underwriter <printed pubkey>
#
# The host also needs ports 80+443 reachable (on GCP's default network, tag the VM http-server,https-server).
set -euo pipefail

POOL="${POOL:?set POOL to the pool contract id}"
UW_DOMAIN="${UW_DOMAIN:?set UW_DOMAIN to an <ip-with-dashes>.sslip.io name}"
SCORE_API="${SCORE_API:-https://credit-score-api-d4jskyskga-uc.a.run.app}"
SOROBAN_RPC="${SOROBAN_RPC:-https://soroban-testnet.stellar.org}"
ALLOWED_ORIGINS="${ALLOWED_ORIGINS:-https://stellar.lcrd.fi}"
AUTO_MAX_LIMIT_USDC="${AUTO_MAX_LIMIT_USDC:-100}"
FUND="${FUND:-true}" # friendbot-fund the generated account (testnet)
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"
mkdir -p secrets data

echo "==> build image"
sudo docker build -t lcrd-underwriter . >/dev/null

if [ ! -f secrets/uw.secret ]; then
  echo "==> generate underwriter key (written to secrets/uw.secret, never printed)"
  sudo docker run --rm -v "$PWD/secrets:/secrets" lcrd-underwriter \
    node -e 'const {Keypair}=require("@stellar/stellar-sdk");require("fs").writeFileSync("/secrets/uw.secret",Keypair.random().secret());'
fi
UWPUB=$(sudo docker run --rm -v "$PWD/secrets:/secrets" lcrd-underwriter \
  node -e 'const {Keypair}=require("@stellar/stellar-sdk");console.log(Keypair.fromSecret(require("fs").readFileSync("/secrets/uw.secret","utf8").trim()).publicKey())')
echo "    underwriter public key: $UWPUB"
[ "$FUND" = "true" ] && curl -s "https://friendbot.stellar.org/?addr=$UWPUB" -o /dev/null -w "    friendbot=%{http_code}\n" || true

echo "==> (re)start containers"
sudo docker network create lcrd-net 2>/dev/null || true
sudo docker rm -f lcrd-underwriter lcrd-caddy 2>/dev/null || true
sudo docker run -d --name lcrd-underwriter --restart unless-stopped --network lcrd-net --network-alias underwriter \
  -e POOL="$POOL" -e SCORE_API="$SCORE_API" -e SOROBAN_RPC="$SOROBAN_RPC" \
  -e ALLOWED_ORIGINS="$ALLOWED_ORIGINS" -e AUTO_MAX_LIMIT_USDC="$AUTO_MAX_LIMIT_USDC" \
  -e UNDERWRITER_SECRET_FILE=/secrets/uw.secret -e PORT=8080 \
  -v "$PWD/secrets/uw.secret:/secrets/uw.secret:ro" -v "$PWD/data:/app/data" \
  lcrd-underwriter >/dev/null
sudo docker run -d --name lcrd-caddy --restart unless-stopped --network lcrd-net \
  -p 80:80 -p 443:443 -e UW_DOMAIN="$UW_DOMAIN" \
  -v "$PWD/Caddyfile:/etc/caddy/Caddyfile:ro" -v caddy_data:/data -v caddy_config:/config \
  caddy:2-alpine >/dev/null

echo
echo "DONE. underwriter at https://$UW_DOMAIN (health: /health)"
echo "Next: set_underwriter --underwriter $UWPUB  (owner-authorized), then point the web page's Underwriter URL at https://$UW_DOMAIN"
