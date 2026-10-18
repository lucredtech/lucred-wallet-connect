#!/usr/bin/env bash
# Deploy credit-line to Stellar testnet with a self-contained test setup:
#   - a mock-token USDC (7 decimals, no trustlines needed — it's a contract token)
#   - a faucet that drips test USDC to anyone (so the web page can hand testers tokens)
#   - the pool, initialized on that USDC
# then run an end-to-end lifecycle. Testnet only; friendbot funds the accounts.
#
# Prereqs: stellar CLI, rustup target wasm32v1-none. Run from anywhere:
#   bash contracts/credit-line/scripts/deploy-testnet.sh
set -euo pipefail
export PATH="/opt/homebrew/bin:$HOME/.cargo/bin:$PATH"

HERE="$(cd "$(dirname "$0")/.." && pwd)"           # contracts/credit-line
ROOT="$(cd "$HERE/.." && pwd)"                      # contracts
NET=testnet
U=10000000                                          # 1 USDC in 7-decimal base units
SCORE_REF="09$(printf '09%.0s' $(seq 1 31))"        # 32-byte hash as 64 hex chars (demo)

WASM_POOL="$HERE/target/wasm32v1-none/release/credit_line.wasm"
WASM_TOKEN="$ROOT/mock-token/target/wasm32v1-none/release/mock_token.wasm"
WASM_FAUCET="$ROOT/token-faucet/target/wasm32v1-none/release/token_faucet.wasm"

echo "==> build wasms (pool, mock-token, faucet)"
( cd "$HERE" && stellar contract build >/dev/null )
( cd "$ROOT/mock-token" && stellar contract build >/dev/null )
( cd "$ROOT/token-faucet" && stellar contract build >/dev/null )

echo "==> create + fund testnet identities (friendbot)"
for id in cl_owner cl_underwriter cl_lender cl_borrower cl_issuer; do
  stellar keys generate "$id" --network $NET --fund --overwrite >/dev/null 2>&1 || stellar keys generate "$id" --network $NET --fund >/dev/null
done
OWNER=$(stellar keys address cl_owner)
UW=$(stellar keys address cl_underwriter)
LENDER=$(stellar keys address cl_lender)
BORROWER=$(stellar keys address cl_borrower)
ISSUER=$(stellar keys address cl_issuer)
echo "    owner=$OWNER underwriter=$UW lender=$LENDER borrower=$BORROWER"

echo "==> deploy mock USDC (contract token, 7 decimals — no trustlines)"
USDC=$(stellar contract deploy --wasm "$WASM_TOKEN" --source cl_issuer --network $NET)
stellar contract invoke --id "$USDC" --source cl_issuer --network $NET -- \
  initialize --admin "$ISSUER" --decimals 7 --name "USD Coin" --symbol USDC >/dev/null
echo "    USDC=$USDC"
stellar contract invoke --id "$USDC" --source cl_issuer --network $NET -- mint --to "$LENDER"   --amount $((2000 * U)) >/dev/null
stellar contract invoke --id "$USDC" --source cl_issuer --network $NET -- mint --to "$BORROWER" --amount $((200 * U))  >/dev/null

echo "==> deploy faucet + prefund (drips 2000 test USDC, 1h cooldown)"
FAUCET=$(stellar contract deploy --wasm "$WASM_FAUCET" --source cl_issuer --network $NET)
stellar contract invoke --id "$FAUCET" --source cl_issuer --network $NET -- \
  initialize --admin "$ISSUER" --df "$USDC" --usdc "$USDC" --df_amount 0 --usdc_amount $((2000 * U)) --cooldown_sec 3600 >/dev/null
stellar contract invoke --id "$USDC" --source cl_issuer --network $NET -- mint --to "$FAUCET" --amount $((1000000 * U)) >/dev/null
echo "    FAUCET=$FAUCET"

echo "==> deploy + initialize credit-line pool"
POOL=$(stellar contract deploy --wasm "$WASM_POOL" --source cl_owner --network $NET)
stellar contract invoke --id "$POOL" --source cl_owner --network $NET -- \
  initialize --owner "$OWNER" --underwriter "$UW" --usdc "$USDC" >/dev/null
echo "    pool=$POOL"

echo "==> lender deposits 1000 USDC for shares"
stellar contract invoke --id "$POOL" --source cl_lender --network $NET -- \
  deposit --lender "$LENDER" --assets $((1000 * U)) >/dev/null
echo "    pool total_assets:"; stellar contract invoke --id "$POOL" --source cl_owner --network $NET -- total_assets

echo "==> quote(score=71, cycles=0) — tier, apr_bps, max_limit"
stellar contract invoke --id "$POOL" --source cl_owner --network $NET -- quote --score 71 --cycles_completed 0

echo "==> underwriter opens a 100-USDC unsecured line for the borrower (score 71)"
stellar contract invoke --id "$POOL" --source cl_underwriter --network $NET -- \
  set_line --borrower "$BORROWER" --score 71 --limit $((100 * U)) --score_ref "$SCORE_REF" >/dev/null

echo "==> borrower draws 50 USDC, then repays in full (overpayment capped)"
stellar contract invoke --id "$POOL" --source cl_borrower --network $NET -- \
  borrow --borrower "$BORROWER" --amount $((50 * U)) >/dev/null
echo "    owed:"; stellar contract invoke --id "$POOL" --source cl_owner --network $NET -- owed --borrower "$BORROWER"
stellar contract invoke --id "$POOL" --source cl_borrower --network $NET -- \
  repay --payer "$BORROWER" --borrower "$BORROWER" --amount $((60 * U)) >/dev/null
echo "    owed after repay:"; stellar contract invoke --id "$POOL" --source cl_owner --network $NET -- owed --borrower "$BORROWER"
echo "    pool total_assets (grew by repaid interest):"; stellar contract invoke --id "$POOL" --source cl_owner --network $NET -- total_assets

printf '{\n  "network": "testnet",\n  "pool": "%s",\n  "usdc": "%s",\n  "faucet": "%s",\n  "owner": "%s",\n  "underwriter": "%s"\n}\n' \
  "$POOL" "$USDC" "$FAUCET" "$OWNER" "$UW" > "$HERE/.credit-line-testnet.json"

echo
echo "DONE. pool=$POOL USDC=$USDC FAUCET=$FAUCET  (testnet)"
echo "View: https://stellar.expert/explorer/testnet/contract/$POOL"
