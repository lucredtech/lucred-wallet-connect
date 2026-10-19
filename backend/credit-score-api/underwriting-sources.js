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
