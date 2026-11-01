# LCRD Roadmap

Forward-looking work for the LCRD credit product — scoring, on-chain credit lines,
the indexer, and the developer surface that feeds them.

LCRD's core is **reputation-based credit**: an on-chain score built from a wallet's
Stellar footprint, turned into borrow-on-score and borrow-on-collateral credit lines.
This file is the single plan of record. It consolidates the product/data items we've been
tracking internally, the developer-surface work prompted by a review of SCF #41 "Orion",
and the deadline-bound deliverables from our SCF Build submission (Open Track, $100k) —
the latter tagged **(SCF T1/T2/T3)** for the tranche that funds them. Items are marked
**[done]**, **[in flight]**, or **[planned]**; verify against current code before treating
any line as live state.

## What already exists (build on, don't rebuild)

- **Multi-protocol indexer** — 21+ Stellar DeFi protocols into `credit_bureau.credit_events`
  (Blend, Aquarius, Soroswap, DeFindex, XOXNO, Ondo, Huma, Slender, Phoenix, Sushi, etc.);
  galexie → BigQuery, P30-ready (`@stellar/stellar-sdk` 17.4.0) on GCP VM `lcrd-indexer`.
- **Live position reads** — `backend/credit-score-api/portfolio.js` `getPortfolio(wallet)`:
  token + DeFi positions, USD valuation, transferability. LP/vault decomposition already
  implemented for Aquarius and DeFindex; Blend via `get_positions`.
- **Scoring + credit layer** — `/score`, `/credit-line`, on-chain Soroban credit-line pool
  (`contracts/credit-line/src/lib.rs`) with per-second interest, `quote()`-bounded
  tiers/limits/APR, graded starter line (gate score ≥ 50), secured lines, LTV/liquidation.
- **Borrow-on-collateral** — `src/collateral.ts` + `contracts/collateral-escrow/` on testnet.
- **`simulateTransaction` is healthy** on current pubnet incl. Soroswap (verified 2026-11-01).

---

> **SCF Build (Open Track, $100k)** funds specific items below, tagged **(SCF T1/T2/T3)**.
> Fixed schedule: 10% on acceptance (no deliverable), then 20 / 30 / 40% against deliverables.
> Audit excluded (SCF Audit Bank). Full wording: the SCF Build Proposal doc.

## Credit-product depth

- [ ] **[planned] Granular credit-amount underwriting. (SCF T1)** Size the line from *all* the
      datapoints that make up the wallet score (tenure, protocol breadth, volume, repayment
      cycles, income), not score alone. The contract already separates the underwriter-chosen
      `limit` (capped by on-chain `quote`) from the cap, so richer per-datapoint sizing can be
      computed off-chain in the score-api and passed as `limit` — or the on-chain cap formula
      itself takes more inputs.
- [ ] **[planned] Score-variable APR for collateral lines (mainnet). (SCF T1 — on-chain, Phase 2)** Today `src/collateral.ts`
      prices flat by asset class (`APR_BY_CLASS`, stable 14% → curated 18.5%), ignoring score,
      and passes that `aprBps` straight into the on-chain open call. Secured lines are *already*
      score-variable (`secured_quote`). Fix: `collateralApr = base + classRiskPremium +
      0.35×scorePremium(score) − cycleDiscount`, floored — keep the score weight light
      (collateral is the protection). Phase 1: compute in `collateral.ts`. Phase 2 (durable):
      derive APR in the collateral contract from an attested score like `secured_quote` does —
      also removes the soft spot where the contract trusts a frontend-passed `aprBps`. Reconcile
      why collateral rates (14–18.5%) sit above secured-line rates (9–15%).
- [ ] **[planned] Tokenize the pool share → SEP-41 "LCRD LP token."** The pool share is an
      internal balance today (`shares_of`/`set_shares`) — not transferable, invisible to other
      platforms, usable only to back a secured line on LCRD's own pool. Make the pool contract
      SEP-41 (or a wrapper) so shares become transferable + composable + usable as collateral on
      other Stellar DeFi. Caveats: external platforms must whitelist + price it (expose a
      share-price read); and a share pledged for an LCRD secured line must be locked so it can't
      also be transferred (double-spend) — the contract already blocks withdrawing shares behind
      an open loan (err #18), so add a lock/escrow-on-pledge.
- [~] **[in flight] dfToken collateral credit — USDC against DeFindex positions.** A borrower
      pledges DeFindex vault shares (dfTokens) and draws 50–75% as USDC at the indicative secured
      APR. **Stage A (off-chain, demoable) done** — `collateral-engine.js`
      (`defindexCollateral`/`quote`), `dfCredit` policy (`df-credit-2026-10-draft1`), both
      `GET /df-credit/quote` and `POST /df-credit/accept` live on Cloud Run (verified 2026-11-01),
      and frontend UI (`src/dfCredit.ts`, `src/dfCreditView.ts`, `borrow.html`). **Remaining:**
      **Stage B** testnet end-to-end (Soroban escrow + engine attestation + treasury
      disbursement), then **Stage C** embeddable widget for fintechs. See the staged plan in
      session notes.
- [ ] **[planned] Privy embedded-wallet onboarding. (SCF T2; live on mainnet in T3)** Email/social-
      login smart wallets (gasless) via Privy alongside Stellar Wallets Kit, so non-crypto-native
      users onboard and draw a line without seed phrases. Acceptance: a non-crypto user onboards +
      draws on testnet (T2); then live with DeFindex on mainnet (T3), vault yield verifiable.

## Scoring & data expansion

- [ ] **[planned] Multi-chain scoring.** Expand scoring signal beyond Stellar. Scoring-signal
      chains (deep lending history): **Ethereum, Base, Solana** — index for the score.
      Lending/disbursement chains (clean USDC): **Arc, Base**. Scoring chain ≠ lending chain;
      one identity spans chains via a **multi-wallet profile**. Cost-sensitive: evaluate data
      providers (Dune / Allium / Goldsky / Covalent / Envio HyperSync / The Graph) vs self-index
      per chain. **Decision taken:** index **Arc** light now — not for scoring signal (no history
      yet) but operationally (LCRD already lends on Arc), as first-mover on Circle's chain, and to
      accumulate Arc credit history from genesis.
- [ ] **[planned] Off-chain underwriting + Basilic data partnership.** The "coming soon" off-chain
      engine (`credit-data-analyser`: `services/pdf_reader` + `services/analysis`) adds a
      cash-flow sub-score alongside the on-chain score. **Basilic** (warm lead) brings reconciled
      **B2B payment history** (who pays on time, how much, how often) — maps directly onto the
      off-chain engine. Next step: when off-chain underwriting is built, scope a pilot for how
      Basilic's reconciled payment data feeds the cash-flow sub-score.
- [ ] **[planned] Outcome instrumentation — loan performance by tier. (SCF T2)** A loan-performance
      pipeline keyed by score tier (documented schema + dashboard queries), feeding repayment
      outcomes back into scoring.
- [ ] **[planned] Cross-chain collateral & USDC (exploratory, not funded).** From the Integration-
      Track variant we did *not* submit: assets bridged via LayerZero as eligible collateral, Circle
      CCTP for native cross-chain USDC (frontend notes: deferred to mainnet), NEAR Intents for
      intent-based execution. Not an SCF deliverable; promote if prioritized.

## Developer surface (cheap, serves the embeddable-underwriting goal)

These make the existing API adoptable by partners and cost days, not weeks.

- [ ] **[planned] OpenAPI spec** for the existing endpoints (`/score`, `/portfolio`,
      `/credit-line`, `/df-credit/*`, `/collateral/supported`, `/analytics`). Single source of
      truth for docs + client generation.
- [ ] **[planned] Generated client SDKs** (TypeScript, Go, Python) from the OpenAPI spec via
      openapi-generator; versioned with the spec. **(SCF T3** ships the SDK on npm + a docs site +
      a first external demo, plus an outcome dataset.)
- [ ] **[planned] Parity / snapshot fixtures** — ledger-pinned JSON snapshots for a few sample
      addresses, independently verifiable against the live endpoint. Trust artifact for scoring +
      portfolio outputs.
- [ ] **[planned] Response metadata** — expose `last_indexed_ledger` / data-staleness on
      portfolio/score responses so consumers can assess freshness programmatically.
- [ ] **[planned] MCP-compatible agent skills** over the API so wallets/neobanks/AI agents can
      call scoring and credit without building a bureau.

## Positions-API depth (only if productizing positions)

This is the space SCF #41 "Orion" (DeFi Positions API, awarded $122.2K) is funded to build.
LCRD's moat is the **credit/reputation layer on top**, not raw positions — pursue these only to
offer a public positions API; otherwise Orion is a candidate data source/partner.

- [ ] **[planned] Cross-protocol health factor** — per-wallet HF for third-party lending
      protocols (Blend, FxDAO), reusing positions we already read. (We compute LTV/liquidation for
      our own pool today.)
- [ ] **[planned] CDP / FxDAO adapter** — enumerate vaults, read collateral vs minted-stablecoin
      debt, compute collateral ratio. New adapter (FxDAO not currently indexed).
- [ ] **[planned] Soroswap LP decomposition per wallet** — the indexer already discovers pairs
      (~216); add constant-product LP-share → underlying decomposition in `portfolio.js`, matching
      the Aquarius/DeFindex pattern.

## Infrastructure & protocol

- [ ] **[planned] Protocol 30 "Bell" — residual items.** SDK bump to 17.4.0 is **done** across
      frontend + indexer (the required provisions; mainnet vote 2026-11-23). Left, all optional:
      skim RPC v30 / Horizon v30 release notes; W-addresses (SEP-23 muxed contract addresses,
      CAP-84) — switch user-facing params to `MuxedAddress` to accept both (needs rebuild+upgrade);
      migrate to `SOROBAN_CREDENTIALS_ADDRESS_V2` at convenience.
- [ ] **[planned] Home-page pool metrics fix.** Pool APY/liquidity/markets show "—" (empty testnet
      pool + a catch in `src/home.ts` that dashes markets on read failure) → harden the UI and seed
      the pool. (From Basilic feedback.)
- [x] **[done] Pre-connect "what builds your score" surface.** `score.html` explainer in place and
      now links to live cross-Stellar scores at `stellar.lcrd.fi/analytics.html`. (From Basilic
      feedback.)
- [ ] **[planned] SDK version tidy-up.** Align the score-api's stellar-sdk (17.2.1) with the
      indexer's (17.4.0).
- [ ] **[planned] Open-source the Soroban contracts (pool + escrow), Apache-2.0. (SCF T1)** Public
      repo + README + reproducible build.
- [ ] **[planned] STRIDE threat model + on-chain monitoring. (SCF T2)** Both docs in the public repo
      per Stellar templates; extend the live fraud monitor so alerts fire on a simulated attack.
- [ ] **[planned] End-to-end test suite + CI. (SCF T2)** CI green + coverage report in the public repo.
- [ ] **[planned] Audited mainnet deployment (pool + escrow). (SCF T3)** Audit via the SCF Audit Bank;
      contracts live on mainnet with addresses on Stellar Expert and the audit report linked.
- [ ] **[planned] Mainnet product live — real USDC, monitoring on. (SCF T3)** Real mainnet loans with
      hashes + a 7-day log; SLOs: score-api p95 < 400ms under load, indexer < 15 min behind tip.

## Related repos / parallel tracks

- **`lcrd-arc-credit`** (separate repo, `lucredtech/lcrd-arc-credit`) — Lucred's Arc-chain (EVM L1,
  chain 5042, USDC-native gas) implementation of the credit product. Shares the credit concept and
  the LCRD score API with this repo but no on-chain code. Live on Arc mainnet; the Soroban replica
  (`contracts/credit-line/`) already lives here. Tracked as the next-phase product expansion.

## Context

Consolidated from internal planning notes and prompted in part by a review of SCF #41
"Orion — DeFi Positions API" (awarded $122.2K): narrower protocol coverage than LCRD (4 vs 21+)
but a more polished developer surface. The developer-surface items close that gap for LCRD's own
API; the positions-API-depth items are optional and only worth it if LCRD competes in the public
positions-API space rather than treating it as a complementary data layer.
