// Pluggable underwriting sources — the extension point for blending multiple credit signals.
//
// Today LCRD scores purely from on-chain Stellar activity (the indexer → BigQuery → score). This
// module is the seam for adding OFF-CHAIN sources over time (connected wallets, gig-income platforms,
// open banking, traditional credit bureaus) WITHOUT changing the on-chain contract: the credit-line
// pool only ever receives a final 0–100 `score` plus a `score_ref` (a hash of the underwriting report
// that produced it), so the report can be composed from any mix of these sources and still be
// attestable on-chain.
//
// Each source implements the same interface and is combined by `compositeScore`. On-chain is the only
// one enabled now; the rest are declared-but-disabled stubs so the shape — weights, provenance, the
// blend — is settled and a future integration is a drop-in. Nothing here is wired into the live
// scoring path yet; wire it in once a real off-chain provider exists.

/**
 * @typedef {Object} SourceResult
 * @property {boolean} available  did this source have data for the wallet/subject?
 * @property {number}  score      0–100 sub-score from this source (ignored when !available)
 * @property {number}  confidence 0–1, how much to trust this source's score for this subject
 * @property {Object}  [signals]  raw features, for the report + audits (no PII leaves the API)
 */

/** A source = { id, label, weight, enabled, kind, fetch(subject) => Promise<SourceResult> }. */
const SOURCES = [
  {
    id: "onchain_stellar",
    label: "On-chain Stellar activity",
    kind: "onchain",
    weight: 1.0,
    enabled: true,
    // Wraps the existing scorer. `subject.onchainScore` is the 0–100 the current pipeline computes,
    // so this stays a thin adapter rather than a re-implementation.
    async fetch(subject) {
      const s = Number(subject && subject.onchainScore);
      if (!Number.isFinite(s)) return { available: false, score: 0, confidence: 0 };
      return { available: true, score: Math.max(0, Math.min(100, s)), confidence: 1, signals: subject.onchainSignals || {} };
    },
  },

  // ---- Future off-chain sources (declared, disabled). Flip `enabled` + implement `fetch` when live. ----
  {
    id: "connected_wallets", label: "Other connected wallets / chains", kind: "offchain_wallet",
    weight: 0.6, enabled: false,
    async fetch(_subject) { return { available: false, score: 0, confidence: 0 }; },
  },
  {
    id: "gig_income", label: "Gig-income platforms", kind: "income",
    weight: 0.9, enabled: false,
    async fetch(_subject) { return { available: false, score: 0, confidence: 0 }; },
  },
  // On-chain OSS-contributor income via Trustless Work escrows (the rail GrantFox pays bounties on).
  // Not a single contract: every bounty is its own escrow contract, so the indexer DISCOVERS them by
  // approved escrow WASM hash (Trustless Work's own indexer does the same) — mainnet hashes seen live:
  //   2ddb5ef1f8f029ea93313ed7a6886f763eda7287d8a08bacc0a427ab0aa1dc1f (multi-release / milestones)
  //   e11805e412966610124c69ab10bfa0a45a4276c82863d6406f2481e8284068ac (single-release)
  // then reads these contract events: tw_release / tw_ms_approve (payout), tw_fund, tw_init/tw_update.
  // Each event carries the Escrow struct: roles.receiver + roles.service_provider (the paid contributor),
  // amount, trustline.address (USDC), milestones[].evidence (PR link) and engagement_id (GitHub issue/
  // campaign = the IDENTITY link). GrantFox-only payouts are the subset where roles.platform == GrantFox's
  // platform account. The indexer emits a per-wallet `ossContribution` feature that this source scores;
  // it stays disabled until that feature is populated. Confirmed live on mainnet (low volume, early stage).
  {
    id: "oss_contribution", label: "OSS-contributor bounty income (Trustless Work / GrantFox)", kind: "income",
    weight: 0.7, enabled: false,
    async fetch(subject) {
      const f = subject && subject.ossContribution;
      // Need at least one real bounty payout in the trailing window to count.
      if (!f || !(Number(f.payouts12mo) >= 1)) return { available: false, score: 0, confidence: 0 };
      const usd = Math.max(0, Number(f.bountyUsd12mo) || 0);
      // Log-scaled on annualized bounty USD: ~$200 -> ~40, ~$2k -> ~70, >=$10k -> ~90.
      const base = usd <= 0 ? 0 : Math.min(90, Math.round(26 * Math.log10(1 + usd / 20)));
      // Decay if the last payout is stale (>180d => heavy discount); boost sustained tenure.
      const lastDays = Number(f.lastPaidDaysAgo);
      const recency = Number.isFinite(lastDays) ? Math.max(0.3, 1 - lastDays / 365) : 0.6;
      const tenure = Math.min(1, (Number(f.tenureDays) || 0) / 180);
      const score = Math.max(0, Math.min(100, Math.round(base * recency * (0.7 + 0.3 * tenure))));
      // GitHub-linked engagement_id makes this hard to self-fund -> higher confidence.
      const confidence = Math.min(1, (f.githubEngagementVerified ? 0.9 : 0.5) * Math.min(1, Number(f.payouts12mo) / 3));
      return {
        available: true, score, confidence,
        signals: { bountyUsd12mo: usd, payouts12mo: Number(f.payouts12mo), tenureDays: Number(f.tenureDays) || 0, githubEngagementVerified: !!f.githubEngagementVerified },
      };
    },
  },
  {
    id: "open_banking", label: "Open banking (cash-flow underwriting)", kind: "cashflow",
    weight: 1.0, enabled: false,
    async fetch(_subject) { return { available: false, score: 0, confidence: 0 }; },
  },
  {
    id: "credit_bureau", label: "Traditional credit bureau", kind: "bureau",
    weight: 1.0, enabled: false,
    async fetch(_subject) { return { available: false, score: 0, confidence: 0 }; },
  },
];

// Confidence- and weight-weighted blend of whatever sources returned data. Returns the final 0–100
// score plus provenance (which sources contributed, and how much) for the on-chain `score_ref` report.
async function compositeScore(subject) {
  const results = await Promise.all(
    SOURCES.filter((s) => s.enabled).map(async (s) => ({ source: s, res: await s.fetch(subject).catch(() => ({ available: false })) })),
  );
  const contributing = results.filter((r) => r.res && r.res.available);
  if (!contributing.length) return { score: 0, sources: [], note: "no underwriting data" };

  let num = 0, den = 0;
  const provenance = [];
  for (const { source, res } of contributing) {
    const w = source.weight * (res.confidence == null ? 1 : res.confidence);
    num += w * res.score;
    den += w;
    provenance.push({ id: source.id, label: source.label, kind: source.kind, weight: source.weight, confidence: res.confidence, score: res.score });
  }
  const score = Math.round(den > 0 ? num / den : 0);
  return { score, sources: provenance };
}

module.exports = { SOURCES, compositeScore };
