# credit-line-underwriter

Automated underwriter for the Stellar [`credit-line`](../../contracts/credit-line) pool. Stellar port of
lcrd-arc-credit's `underwriter/`.

A borrower proves control of their Stellar wallet with one signed message; LCRD scores that wallet's
on-chain history; if the tier qualifies, this service opens the unsecured line on the Soroban pool with
its own **underwriter key**. The contract derives tier/APR/limit from the score and caps them by policy,
so the underwriter key can never grant a cheaper or larger line than policy allows. Only the hash of the
score report goes on-chain.

Simpler than the Arc/EVM original: on Stellar the borrower's wallet **is** the scored identity and the
on-chain borrower — no second chain, no cross-wallet link, no SEP-53 base32/CRC by hand (`@stellar/stellar-sdk`
`Keypair.verify` does it).

## Endpoints
- `GET /health` — pool id, underwriter address, whether it is the pool's current underwriter, the auto limit.
- `POST /request-line` `{ message, signature }` — verifies the signature, scores the wallet, and (if eligible)
  submits `set_line`. Returns `{ eligible, score, tier, aprBps, limit?, scoreRef?, txHash?, reason? }`.

The signed message must be exactly:
```
LCRD credit on Stellar
Stellar wallet: G...
Issued: <ISO-8601, within 10 minutes>
```

## Env
`UNDERWRITER_SECRET` (S… seed), `POOL` (C… contract id), `SOROBAN_RPC` (default testnet),
`NETWORK_PASSPHRASE` (default Test SDF Network), `SCORE_API`, `AUTO_MAX_LIMIT_USDC` (default 1),
`ALLOWED_ORIGINS` (comma-separated), `PORT` (default 8080), `DATA_DIR` (default ./data).

The auto limit caps what opens automatically; a human/ops can open larger lines directly on the contract
up to the tier maximum.

## Run / test
```bash
npm install
node test.mjs          # offline: signature verification + message parsing (no network)
POOL=C... UNDERWRITER_SECRET=S... node server.mjs
```

## Status
Service + offline tests. Wired to the testnet pool; the web dApp calls `/request-line`. For production the
underwriter key belongs in Secret Manager/KMS, not an env var.
