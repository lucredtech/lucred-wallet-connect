#!/usr/bin/env bash
# Interactive Stage B test harness on Stellar testnet.
#
#   escrow-testnet.sh up                  deploy contract + mock dfToken/USDC, fund, init (one time)
#   escrow-testnet.sh status              show the loan + balances
#   escrow-testnet.sh deposit [coll] [principal]   borrower locks collateral (default 1000 / 600)
#   escrow-testnet.sh disburse            treasury sends USDC, loan -> Active
#   escrow-testnet.sh release <amount>    partial collateral release (engine-attested)
#   escrow-testnet.sh margincall [secs]   flag margin call with a cure deadline (engine-attested)
#   escrow-testnet.sh liquidate <seize>   seize collateral to treasury, surplus back (engine-attested)
#   escrow-testnet.sh repay <amount>      treasury records a repayment (debt down)
#   escrow-testnet.sh close               full-repay exit (returns collateral; no engine needed)
#   escrow-testnet.sh reset               start a new loan id against the same deployment
#
# Attestation seq is read from on-chain state (last_seq+1), so release/margincall/liquidate just work.
# Mock tokens stand in for a real DeFindex vault + USDC. Demo engine seed. Testnet only.
set -euo pipefail
export PATH="/opt/homebrew/bin:$PATH"

HERE="$(cd "$(dirname "$0")/.." && pwd)"
WASM="$HERE/target/wasm32v1-none/release/collateral_escrow.wasm"
ATT="$HERE/../../backend/credit-score-api/attestation.js"
STATE="$HERE/.escrow-testnet.json"
NET=testnet
SEED="$(python3 -c "print('07'*32)")"

jqget() { python3 -c "import json,sys;print(json.load(open('$STATE'))['$1'])"; }
loanget() { # field from get_loan JSON on stdin
  python3 -c "import json,sys;print(json.load(sys.stdin).get('$1',''))"
}
sign() { # kind seq expiry amount -> hex sig
  node -e "const a=require('$ATT');console.log(a.sign({loanId:'$(jqget LOAN_ID)',kind:'$1',seq:$2,expiry:$3,amount:$4},a.engineKeyFromSeed('$SEED')).toString('hex'))"
}
inv() { stellar contract invoke --id "$1" --source "$2" --network $NET -- "${@:3}"; }
getloan() { stellar contract invoke --id "$(jqget ESCROW)" --source esc_admin --network $NET -- get_loan --loan_id "$(jqget LOAN_ID)" 2>/dev/null; }
nextseq() { local ls; ls=$(getloan | loanget last_seq); echo $(( ${ls:-0} + 1 )); }

cmd="${1:-help}"
case "$cmd" in
up)
  ( cd "$HERE" && stellar contract build >/dev/null )
  ENGINE_PUB=$(node -e "const a=require('$ATT');console.log(a.publicKeyRaw(a.engineKeyFromSeed('$SEED')).toString('hex'))")
  for id in esc_admin esc_treasury esc_borrower esc_issuer; do
    stellar keys generate "$id" --network $NET --fund --overwrite >/dev/null 2>&1 || stellar keys generate "$id" --network $NET --fund >/dev/null
  done
  ADMIN=$(stellar keys address esc_admin); TREASURY=$(stellar keys address esc_treasury)
  BORROWER=$(stellar keys address esc_borrower); ISSUER=$(stellar keys address esc_issuer)
  USDC=$(stellar contract asset deploy --asset "USDC:$ISSUER" --source esc_issuer --network $NET)
  COLL=$(stellar contract asset deploy --asset "COLL:$ISSUER" --source esc_issuer --network $NET)
  for pair in "esc_borrower COLL" "esc_borrower USDC" "esc_treasury USDC" "esc_treasury COLL"; do
    set -- $pair; stellar tx new change-trust --source-account "$1" --line "$2:$ISSUER" --network $NET >/dev/null 2>&1
  done
  stellar contract invoke --id "$COLL" --source esc_issuer --network $NET -- mint --to "$BORROWER" --amount 100000 >/dev/null
  stellar contract invoke --id "$USDC" --source esc_issuer --network $NET -- mint --to "$TREASURY" --amount 1000000 >/dev/null
  ESCROW=$(stellar contract deploy --wasm "$WASM" --source esc_admin --network $NET)
  inv "$ESCROW" esc_admin initialize --admin "$ADMIN" --engine_key "$ENGINE_PUB" --treasury "$TREASURY" --usdc "$USDC" >/dev/null
  inv "$ESCROW" esc_admin set_asset --token "$COLL" --allowed true >/dev/null
  LOAN_ID="04$(printf '04%.0s' $(seq 1 31))"
  python3 -c "import json;json.dump({'ESCROW':'$ESCROW','USDC':'$USDC','COLL':'$COLL','LOAN_ID':'$LOAN_ID'},open('$STATE','w'))"
  echo "deployed. escrow=$ESCROW  usdc=$USDC  coll=$COLL  loan_id=$LOAN_ID"
  echo "explorer: https://stellar.expert/explorer/testnet/contract/$ESCROW"
  ;;
status)
  echo "loan:"; getloan | python3 -m json.tool
  echo "borrower COLL:"; inv "$(jqget COLL)" esc_admin balance --id "$(stellar keys address esc_borrower)"
  echo "borrower USDC:"; inv "$(jqget USDC)" esc_admin balance --id "$(stellar keys address esc_borrower)"
  echo "treasury COLL:"; inv "$(jqget COLL)" esc_admin balance --id "$(stellar keys address esc_treasury)"
  ;;
deposit)
  inv "$(jqget ESCROW)" esc_borrower deposit --loan_id "$(jqget LOAN_ID)" --borrower "$(stellar keys address esc_borrower)" \
    --collateral_token "$(jqget COLL)" --collateral_amount "${2:-1000}" --principal "${3:-600}" --apr_bps 1200 --structure OpenEnded --term_days 0
  ;;
disburse)  inv "$(jqget ESCROW)" esc_treasury disburse --loan_id "$(jqget LOAN_ID)" ;;
repay)     inv "$(jqget ESCROW)" esc_treasury record_repayment --loan_id "$(jqget LOAN_ID)" --amount "$2" ;;
close)     inv "$(jqget ESCROW)" esc_borrower close --loan_id "$(jqget LOAN_ID)" ;;
release)
  seq=$(nextseq); exp=$(( $(date +%s) + 3600 )); sig=$(sign release "$seq" "$exp" "$2")
  inv "$(jqget ESCROW)" esc_borrower release --loan_id "$(jqget LOAN_ID)" --amount "$2" --seq "$seq" --expiry "$exp" --signature "$sig"
  ;;
margincall)
  seq=$(nextseq); exp=$(( $(date +%s) + 3600 )); deadline=$(( $(date +%s) + ${2:-600} )); sig=$(sign margin_call "$seq" "$exp" "$deadline")
  inv "$(jqget ESCROW)" esc_borrower margin_call --loan_id "$(jqget LOAN_ID)" --deadline "$deadline" --seq "$seq" --expiry "$exp" --signature "$sig"
  ;;
liquidate)
  seq=$(nextseq); exp=$(( $(date +%s) + 3600 )); sig=$(sign liquidate "$seq" "$exp" "$2")
  inv "$(jqget ESCROW)" esc_treasury liquidate --loan_id "$(jqget LOAN_ID)" --seize_amount "$2" --seq "$seq" --expiry "$exp" --signature "$sig"
  ;;
reset)
  python3 -c "import json,os,random;d=json.load(open('$STATE'));d['LOAN_ID']=''.join(random.choice('0123456789abcdef') for _ in range(64));json.dump(d,open('$STATE','w'));print('new loan_id',d['LOAN_ID'])"
  ;;
*) sed -n '2,20p' "$0" ;;
esac
