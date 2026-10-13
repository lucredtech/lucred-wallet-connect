#!/usr/bin/env bash
# Deploy collateral-escrow to Stellar testnet and run an end-to-end loan, using throwaway test tokens
# (a mock dfToken "COLL" + a mock "USDC") so it needs no real DeFindex vault. Testnet only.
#
# Prereqs: stellar CLI, rustup target wasm32v1-none, node (for attestation.js). All free; testnet XLM
# comes from friendbot. Run from anywhere:  bash contracts/collateral-escrow/scripts/deploy-testnet.sh
set -euo pipefail
export PATH="/opt/homebrew/bin:$PATH"

HERE="$(cd "$(dirname "$0")/.." && pwd)"
WASM="$HERE/target/wasm32v1-none/release/collateral_escrow.wasm"
ATT="$HERE/../../backend/credit-score-api/attestation.js"
NET=testnet
LOAN_ID="04$(printf '04%.0s' $(seq 1 31))"   # 32 bytes of 0x04 as 64 hex chars
ENGINE_SEED="$(python3 -c "print('07'*32)")"  # demo engine key seed (use Secret Manager/KMS for real)

echo "==> build wasm"
( cd "$HERE" && stellar contract build >/dev/null )

echo "==> engine public key (ed25519, from attestation.js)"
ENGINE_PUB=$(node -e "const a=require('$ATT');console.log(a.publicKeyRaw(a.engineKeyFromSeed('$ENGINE_SEED')).toString('hex'))")
echo "    engine_key=$ENGINE_PUB"

echo "==> create + fund testnet identities (friendbot)"
for id in esc_admin esc_treasury esc_borrower esc_issuer; do
  stellar keys generate "$id" --network $NET --fund --overwrite >/dev/null 2>&1 || stellar keys generate "$id" --network $NET --fund >/dev/null
done
ADMIN=$(stellar keys address esc_admin)
TREASURY=$(stellar keys address esc_treasury)
BORROWER=$(stellar keys address esc_borrower)
ISSUER=$(stellar keys address esc_issuer)
echo "    admin=$ADMIN treasury=$TREASURY borrower=$BORROWER issuer=$ISSUER"

echo "==> deploy test tokens (wrapped classic assets): USDC + COLL (mock dfToken)"
USDC=$(stellar contract asset deploy --asset "USDC:$ISSUER" --source esc_issuer --network $NET)
COLL=$(stellar contract asset deploy --asset "COLL:$ISSUER" --source esc_issuer --network $NET)
echo "    USDC=$USDC COLL=$COLL"

echo "==> trustlines (wrapped classic-asset SACs need them for G-account holders)"
stellar tx new change-trust --source-account esc_borrower --line "COLL:$ISSUER" --network $NET >/dev/null 2>&1
stellar tx new change-trust --source-account esc_borrower --line "USDC:$ISSUER" --network $NET >/dev/null 2>&1
stellar tx new change-trust --source-account esc_treasury --line "USDC:$ISSUER" --network $NET >/dev/null 2>&1
stellar tx new change-trust --source-account esc_treasury --line "COLL:$ISSUER" --network $NET >/dev/null 2>&1

echo "==> mint: COLL to borrower, USDC to treasury"
stellar contract invoke --id "$COLL" --source esc_issuer --network $NET -- mint --to "$BORROWER" --amount 1000 >/dev/null
stellar contract invoke --id "$USDC" --source esc_issuer --network $NET -- mint --to "$TREASURY" --amount 10000 >/dev/null

echo "==> deploy + initialize escrow"
ESCROW=$(stellar contract deploy --wasm "$WASM" --source esc_admin --network $NET)
echo "    escrow=$ESCROW"
stellar contract invoke --id "$ESCROW" --source esc_admin --network $NET -- \
  initialize --admin "$ADMIN" --engine_key "$ENGINE_PUB" --treasury "$TREASURY" --usdc "$USDC" >/dev/null
stellar contract invoke --id "$ESCROW" --source esc_admin --network $NET -- \
  set_asset --token "$COLL" --allowed true >/dev/null

echo "==> deposit (borrower locks 1000 COLL, principal 600)"
stellar contract invoke --id "$ESCROW" --source esc_borrower --network $NET -- \
  deposit --loan_id "$LOAN_ID" --borrower "$BORROWER" --collateral_token "$COLL" \
  --collateral_amount 1000 --principal 600 --apr_bps 1200 --structure OpenEnded --term_days 0 >/dev/null

echo "==> disburse (treasury sends 600 USDC to borrower; loan -> Active)"
stellar contract invoke --id "$ESCROW" --source esc_treasury --network $NET -- disburse --loan_id "$LOAN_ID" >/dev/null
echo "    borrower USDC balance:"
stellar contract invoke --id "$USDC" --source esc_admin --network $NET -- balance --id "$BORROWER"

echo "==> release 200 COLL with a node-signed engine attestation"
NOW=$(date +%s); EXPIRY=$((NOW + 3600))
SIG=$(node -e "const a=require('$ATT');const k=a.engineKeyFromSeed('$ENGINE_SEED');console.log(a.sign({loanId:'$LOAN_ID',kind:'release',seq:1,expiry:$EXPIRY,amount:200},k).toString('hex'))")
stellar contract invoke --id "$ESCROW" --source esc_borrower --network $NET -- \
  release --loan_id "$LOAN_ID" --amount 200 --seq 1 --expiry "$EXPIRY" --signature "$SIG" >/dev/null
echo "    borrower COLL balance (expect 200 released):"
stellar contract invoke --id "$COLL" --source esc_admin --network $NET -- balance --id "$BORROWER"

echo "==> repay in full + close (collateral returned, no engine needed)"
stellar contract invoke --id "$ESCROW" --source esc_treasury --network $NET -- record_repayment --loan_id "$LOAN_ID" --amount 600 >/dev/null
stellar contract invoke --id "$ESCROW" --source esc_borrower --network $NET -- close --loan_id "$LOAN_ID" >/dev/null
echo "    final loan state:"
stellar contract invoke --id "$ESCROW" --source esc_admin --network $NET -- get_loan --loan_id "$LOAN_ID"

echo
echo "DONE. escrow=$ESCROW USDC=$USDC COLL=$COLL  (testnet)"
echo "View: https://stellar.expert/explorer/testnet/contract/$ESCROW"
