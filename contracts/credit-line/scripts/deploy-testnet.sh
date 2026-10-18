#!/usr/bin/env bash
# Deploy credit-line to Stellar testnet and run an end-to-end lifecycle using a throwaway test USDC
# (a wrapped classic asset, 7 decimals — matching the contract's USDC base units). Testnet only.
#
# Prereqs: stellar CLI, rustup target wasm32v1-none. All free; testnet XLM comes from friendbot.
# Run from anywhere:  bash contracts/credit-line/scripts/deploy-testnet.sh
set -euo pipefail
export PATH="/opt/homebrew/bin:$HOME/.cargo/bin:$PATH"

HERE="$(cd "$(dirname "$0")/.." && pwd)"
WASM="$HERE/target/wasm32v1-none/release/credit_line.wasm"
NET=testnet
U=10000000                      # 1 USDC in 7-decimal base units
SCORE_REF="09$(printf '09%.0s' $(seq 1 31))"   # 32-byte hash as 64 hex chars (demo)

echo "==> build wasm"
( cd "$HERE" && stellar contract build >/dev/null )

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

echo "==> deploy test USDC (wrapped classic asset, 7 decimals)"
USDC=$(stellar contract asset deploy --asset "USDC:$ISSUER" --source cl_issuer --network $NET)
echo "    USDC=$USDC"

echo "==> trustlines + mint (2000 USDC to lender, 200 to borrower for interest)"
stellar tx new change-trust --source-account cl_lender  --line "USDC:$ISSUER" --network $NET >/dev/null 2>&1
stellar tx new change-trust --source-account cl_borrower --line "USDC:$ISSUER" --network $NET >/dev/null 2>&1
stellar contract invoke --id "$USDC" --source cl_issuer --network $NET -- mint --to "$LENDER"   --amount $((2000 * U)) >/dev/null
stellar contract invoke --id "$USDC" --source cl_issuer --network $NET -- mint --to "$BORROWER" --amount $((200 * U))  >/dev/null

echo "==> deploy + initialize credit-line"
POOL=$(stellar contract deploy --wasm "$WASM" --source cl_owner --network $NET)
echo "    pool=$POOL"
stellar contract invoke --id "$POOL" --source cl_owner --network $NET -- \
  initialize --owner "$OWNER" --underwriter "$UW" --usdc "$USDC" >/dev/null

echo "==> lender deposits 1000 USDC for shares"
stellar contract invoke --id "$POOL" --source cl_lender --network $NET -- \
  deposit --lender "$LENDER" --assets $((1000 * U)) >/dev/null
echo "    pool total_assets:"; stellar contract invoke --id "$POOL" --source cl_owner --network $NET -- total_assets

echo "==> quote(score=71, cycles=0) — tier, apr_bps, max_limit"
stellar contract invoke --id "$POOL" --source cl_owner --network $NET -- quote --score 71 --cycles_completed 0

echo "==> underwriter opens a 100-USDC unsecured line for the borrower (score 71)"
stellar contract invoke --id "$POOL" --source cl_underwriter --network $NET -- \
  set_line --borrower "$BORROWER" --score 71 --limit $((100 * U)) --score_ref "$SCORE_REF" >/dev/null

echo "==> borrower draws 50 USDC"
stellar contract invoke --id "$POOL" --source cl_borrower --network $NET -- \
  borrow --borrower "$BORROWER" --amount $((50 * U)) >/dev/null
echo "    borrower USDC balance:"; stellar contract invoke --id "$USDC" --source cl_owner --network $NET -- balance --id "$BORROWER"
echo "    owed (principal, interest):"; stellar contract invoke --id "$POOL" --source cl_owner --network $NET -- owed --borrower "$BORROWER"

echo "==> borrower repays in full (overpayment is capped at the payoff)"
stellar contract invoke --id "$POOL" --source cl_borrower --network $NET -- \
  repay --payer "$BORROWER" --borrower "$BORROWER" --amount $((60 * U)) >/dev/null
echo "    owed after repay:"; stellar contract invoke --id "$POOL" --source cl_owner --network $NET -- owed --borrower "$BORROWER"
echo "    pool total_assets (grew by repaid interest):"; stellar contract invoke --id "$POOL" --source cl_owner --network $NET -- total_assets
echo "    total_repaid_interest:"; stellar contract invoke --id "$POOL" --source cl_owner --network $NET -- total_repaid_interest

printf '{\n  "network": "testnet",\n  "pool": "%s",\n  "usdc": "%s",\n  "owner": "%s",\n  "underwriter": "%s"\n}\n' \
  "$POOL" "$USDC" "$OWNER" "$UW" > "$HERE/.credit-line-testnet.json"

echo
echo "DONE. pool=$POOL USDC=$USDC  (testnet)"
echo "View: https://stellar.expert/explorer/testnet/contract/$POOL"
