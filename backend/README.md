# LCRD backend

The code behind [LCRD](../README.md): a Stellar on-chain credit score, a wallet holdings view and an indicative credit line, all computed from public chain data.

```
Stellar ledgers ──► indexer ──► BigQuery (credit_events) ──► credit-score-api ──► LCRD web app
 (Galexie exports   parses        one row per                 /score  /portfolio
  in Cloud Storage) Soroban       on-chain action             /credit-line  /waitlist
                    events
```

## `indexer/` — turns raw ledgers into credit events

TypeScript. Reads Stellar ledger exports (Galexie, stored in Cloud Storage), finds the Soroban contract events that matter for credit, and writes one normalised row per action (who, which protocol, what, how much, which asset, when).

| File | What it does |
|---|---|
| `src/registry.ts` | Which contracts to watch, and which protocol/category each belongs to: lending (Blend, Slender, Templar, Peridot, Alula), AMMs (Soroswap, Aquarius, Phoenix, Sushi), yield and vaults (DeFindex, Gami/Upshift, Untangled), RWA and distribution (Etherfuse, Spiko, Fundable, …). |
| `src/xdrParser.ts` | Decodes ledger XDR into events. Each protocol emits events differently, so there are per-protocol readers for amounts, assets and the acting wallet. |
| `src/poolDiscovery.ts` | Finds new pools and vaults (Aquarius, Soroswap, DeFindex) at runtime so coverage grows without a redeploy. |
| `src/gcs.ts`, `src/indexer.ts` | Reads the raw files, writes the extracted events, and tracks progress. A "live-tip" mode follows the newest ledger folder automatically. |

Run with Docker (`docker-compose.indexer-shard.yml`). Credentials are never in the repo: the container mounts a Google service-account key at runtime.

## `credit-score-api/` — scoring, holdings and credit line

Node.js (Express) on Cloud Run, reading the BigQuery table the indexer feeds.

| File | What it does |
|---|---|
| `index.js` | The HTTP API and the **score**: a lending path (completed borrow → repay cycles) and an activity path (breadth, volume, consistency, tenure), plus income signals (realized yield, distributions, incentive rewards). Methodology: `public/how-it-works.html`. Also `POST /waitlist` (email, plus the connected wallet when the app has one). |
| `portfolio.js` | **Holdings.** Reads a wallet's balances live from Horizon and Soroban RPC (free, read-only), values Blend, Aquarius, DeFindex and Untangled positions, prices tokens by contract id (never by ticker), and flags which holdings are transferable. |
| `classic-activity.js` | A small, capped scoring bonus for account age and long classic Stellar history (stellar.expert, Horizon fallback), added only alongside DeFi activity. |
| `credit-line.js` | **Indicative credit line and APR** for three lending models (secured, unsecured, score + collateral). Pure functions: every business parameter sits in one `POLICY` object, so a partner can supply its own. |

### Endpoints

| Endpoint | Returns |
|---|---|
| `GET /score?wallet=G…` | Tier A/B/C, 0–100 score, the reasons behind it, and a structured `components` list (each term's points, maximum, plain-English explanation and, for income terms, the dollar amount) |
| `GET /portfolio?wallet=G…` | Tokens and DeFi positions, value, debt, net value, transferability |
| `GET /credit-line?wallet=G…` | Limit and APR under each lending model, with the full breakdown |
| `POST /waitlist` | `{ "email": "…", "wallet": "G…" }` (wallet optional): join the credit-line waitlist. Stored per email + wallet pair. |

### Tests

The credit-line policy, the reward-income scoring and the classic-history bonus have self-contained tests (no network, no credentials):

```bash
cd credit-score-api
node tests/test-credit-line.js
node tests/test-rewards.js
node tests/test-classic.js
node tests/test-components.js
```

Running the API itself needs `npm install` and Google application-default credentials with read access to the BigQuery dataset.

## Notes for reviewers

- **Everything is read from public chain data.** No off-chain or self-reported input.
- **The credit line is an estimate**, not an offer. The policy numbers are a first draft, not calibrated against loan performance.
- Not included here: the scheduled job that loads extracted events into BigQuery, one-off backfill scripts, and deployment credentials.
