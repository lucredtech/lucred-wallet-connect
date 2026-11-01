# LCRD Roadmap

Forward-looking work for the credit-score API, indexer, and developer surface.
LCRD's core is **reputation-based credit** (scoring + on-chain credit lines); the items
below extend the data and developer layers that feed it. They do not change the shipped
product's direction — they make the position/data layer we already run reusable by others.

## What already exists (build on, don't rebuild)

- **Multi-protocol indexer** — 21+ Stellar DeFi protocols into `credit_bureau.credit_events`
  (Blend, Aquarius, Soroswap, DeFindex, XOXNO, Ondo, Huma, Slender, Phoenix, Sushi, etc.).
- **Live position reads** — `backend/credit-score-api/portfolio.js` `getPortfolio(wallet)`:
  token + DeFi positions, USD valuation, transferability.
  - **LP / vault decomposition already implemented** for Aquarius (`get_reserves` /
    `get_total_shares`) and DeFindex (`get_asset_amounts_per_shares`).
  - Blend positions read via `get_positions`.
- **Credit layer** — `/score`, `/credit-line`, `/df-credit/*`, on-chain pool with
  per-second interest, `quote()`-bounded tiers/limits/APR, LTV + liquidation thresholds.
- **`simulateTransaction` is healthy** on current pubnet incl. Soroswap (verified
  2026-11-01) — no `getLedgerEntries` fallback needed. (Optional tidy-up: align the API's
  stellar-sdk 17.2.1 with the indexer's 17.4.0.)

## Near-term — developer surface (cheap, serves the embeddable-SDK goal)

These make the existing API adoptable by partners (the embeddable underwriting SDK in the
SCF proposal) and cost days, not weeks.

- [ ] **OpenAPI spec** for the existing endpoints (`/score`, `/portfolio`, `/credit-line`,
      `/df-credit/*`, `/collateral/supported`, `/analytics`). Single source of truth for
      docs + client generation.
- [ ] **Generated client SDKs** (TypeScript, Go, Python) from the OpenAPI spec via
      openapi-generator; versioned with the spec.
- [ ] **Parity / snapshot fixtures** — ledger-pinned JSON snapshots for a few sample
      addresses, independently verifiable against the live endpoint. Trust artifact for the
      scoring + portfolio outputs.
- [ ] **Response metadata** — expose `last_indexed_ledger` / data-staleness on
      portfolio/score responses so consumers can assess freshness programmatically.

## Later — positions-API depth (only if productizing positions)

This is the space SCF #41 "Orion" (DeFi Positions API, awarded $122.2K) is funded to build.
LCRD's moat is the **credit/reputation layer on top**, not raw positions, so pursue these
only to offer a public positions API — otherwise Orion is a candidate data source/partner.

- [ ] **Cross-protocol health factor** — expose a per-wallet HF readout for third-party
      lending protocols (Blend, FxDAO), reusing positions we already read. (We compute
      LTV/liquidation for our own pool today.)
- [ ] **CDP / FxDAO adapter** — enumerate vaults, read collateral vs minted-stablecoin
      debt, compute collateral ratio. New adapter (FxDAO not currently indexed).
- [ ] **Soroswap LP decomposition per wallet** — the indexer already discovers pairs
      (~216); add constant-product LP-share → underlying decomposition in `portfolio.js`,
      matching the Aquarius/DeFindex pattern.

## Context

Prompted by a review of SCF #41 "Orion — DeFi Positions API" (awarded $122.2K): narrower
protocol coverage than LCRD (4 vs 21+) but deeper on lending-position semantics and a
polished developer surface. The near-term items close the developer-surface gap for LCRD's
own API; the later items are optional and only worth it if LCRD chooses to compete in the
public positions-API space rather than treat it as a complementary data layer.
