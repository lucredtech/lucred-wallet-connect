# Auto-disburser (testnet)

Watches the Stage B collateral escrow for `deposit` events and auto-submits the treasury-signed
`disburse` for each new loan in the `Open` state. Removes the manual "ping to fund" step while testing.

Testnet only, mock tokens, no real value. Idempotent (records every handled loan id; `disburse`
also guards `status == Open`).

## Runs on
`chief-aztec` (has Node). Lives in `~/disburser/`.

## Deploy / update
From the repo root:
```bash
rsync -a ops/auto-disburser/ chief-aztec:~/disburser/ --exclude node_modules --exclude config.env --exclude state.json --exclude watch.log
ssh chief-aztec 'cd ~/disburser && npm install --omit=dev'
```

## One-time config (secret — run by the key owner)
Create `~/disburser/config.env` from the template and drop in the treasury secret. Do NOT echo the
secret to stdout; pipe it straight to the file:
```bash
# on your mac (esc_treasury must exist in the stellar CLI):
scp ops/auto-disburser/config.env.example chief-aztec:~/disburser/config.env
printf 'TREASURY_SECRET=%s\n' "$(stellar keys show esc_treasury)" | ssh chief-aztec 'umask 077; cat >> ~/disburser/config.env'
```

## Start + survive reboot (no root)
```bash
ssh chief-aztec 'chmod +x ~/disburser/run.sh && ~/disburser/run.sh'
ssh chief-aztec '(crontab -l 2>/dev/null | grep -v auto-disburser/run.sh; echo "@reboot '"'"'$HOME'"'"'/disburser/run.sh") | crontab -'
```

## Operate
```bash
ssh chief-aztec 'tail -f ~/disburser/watch.log'          # watch activity
ssh chief-aztec 'pgrep -af auto-disburser/watch.js'      # is it running?
ssh chief-aztec 'pkill -f auto-disburser/watch.js'       # stop
```

## Config (`config.env`)
- `ESCROW_ID` — escrow contract id (default = current testnet deploy)
- `RPC_URL` — Soroban testnet RPC
- `POLL_MS` — poll interval (default 10000)
- `LOOKBACK_LEDGERS` — on first run, how far back to scan for deposits (default 500)
- `TREASURY_SECRET` — esc_treasury secret (`S...`); the only secret, kept out of git
