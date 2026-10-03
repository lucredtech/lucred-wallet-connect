# LCRD Wallet Connect

Connect a Stellar wallet, prove you own it, and see your LCRD on-chain credit score — pulled live from the `credit-score-api` service.

## Repository layout

- **Web app** (this folder's root): a static, client-only app. No server secrets. Shows the score, the wallet's holdings, and an indicative credit line.
- **[`backend/`](backend/README.md)**: the code behind it. The indexer that turns Stellar ledgers into credit events, and the `credit-score-api` that does the scoring, holdings and credit-line calculations.

The web app itself is static client-only code with no server secrets. Ownership is proven by having the wallet sign a throwaway transaction (never submitted to the network) and verifying the signature in the browser.

## How it works

1. **Connect** — opens [Stellar Wallets Kit](https://github.com/Creit-Tech/Stellar-Wallets-Kit)'s wallet picker (Freighter, xBull, Albedo, Rabet, LOBSTR, Hana).
2. **Verify** — builds a zero-fee, never-submitted transaction with a `manageData` op and a random nonce, has the connected wallet sign it, then verifies the signature client-side against the claimed address (`@stellar/stellar-sdk`'s `WebAuth.verifyTxSignedBy`). Proves wallet ownership without touching the network or needing a server.
3. **Score** — calls the existing `credit-score-api`'s public `GET /score?wallet=` endpoint and renders the result (tier, score, reasons, event count).

**Can't connect a wallet?** There's a "paste a wallet address" fallback right on the home screen — it skips the signature step entirely and goes straight to the score lookup. It's clearly marked **unverified** in the UI (gray dot + tag, no "Verify Ownership" step) since anyone can paste any address; it's the same public lookup `credit-score-api` already allows, just surfaced in this UI for people without a browser wallet.

## Local development

```bash
npm install
cp .env.example .env
# edit .env: set VITE_CREDIT_SCORE_API_URL to the real credit-score-api Cloud Run URL
npm run dev
```

## Build

```bash
npm run build   # outputs static files to dist/
npm run preview # serve the production build locally
```

## Deploy

This is a fully static site (no server runtime needed) — any static host works. To match the rest of the LCRD dashboards (admin/merchant/card/agent, all on Vercel):

1. Push this repo to GitHub.
2. In Vercel: **New Project → Import** this repo. Framework preset: **Vite** (auto-detected).
3. Set the environment variable `VITE_CREDIT_SCORE_API_URL` in the Vercel project settings (Project → Settings → Environment Variables) to the real `credit-score-api` Cloud Run URL. It's safe to expose client-side — the endpoint is already public/unauthenticated.
4. Deploy. Point a subdomain (e.g. `score.lucred.co` or `wallet.lucred.co`) at the Vercel deployment the same way the other `*.lucred.co` dashboards are set up.

Netlify or Cloudflare Pages work identically (build command `npm run build`, output directory `dist`, same env var).

## Scope / known limitations

- The **connect + sign** path only supports G-addresses (classic accounts) for now — Soroban smart-wallet (C-address) ownership proof isn't supported, since stellar-sdk's SEP-10-style tooling doesn't cover contract-account signing challenges yet (see the Pattern 1/2 smart-account identity notes in the main indexer project). The **paste** path accepts both G and C addresses since there's no signature to verify either way.
- No persistence — this app doesn't store anything; it's a pure connect/paste → verify (if applicable) → look-up flow against the already-public score API. Linking a wallet to a real LCRD *account* (with KYC tiers, blended scoring) is separate, larger work tracked elsewhere.
