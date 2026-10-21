// Per-wallet OSS-contributor bounty income feature, read from `credit_bureau.oss_bounty_events`
// (populated by the indexer's escrowBounty extractor: Trustless Work / GrantFox milestone releases).
// Shapes the `ossContribution` object consumed by the `oss_contribution` source in
// underwriting-sources.js. Returns null when the wallet has no OSS bounty income (source then no-ops).
//
// Net income = gross milestone amount minus the platform fee (platform_fee bps) and Trustless Work's
// ~0.3% fee, matching the real on-chain transfer split. Only USD-pegged trustlines are counted (USDC
// ≈ $1); other assets would need price normalization before they can be summed as USD.
const { BigQuery } = require("@google-cloud/bigquery");
const bq = new BigQuery();

const TABLE = "`credit_bureau.oss_bounty_events`";
let tableReady = null;
function ensureTable() {
  if (!tableReady) {
    tableReady = bq
      .query(
        "CREATE TABLE IF NOT EXISTS " + TABLE + " (" +
          "escrowContract STRING NOT NULL, milestoneIndex INT64 NOT NULL, receiver STRING NOT NULL, " +
          "platform STRING, platformName STRING, incomeType STRING, weight FLOAT64, " +
          "amount FLOAT64, platformFeeBps INT64, assetCode STRING, assetContractId STRING, " +
          "engagementId STRING, title STRING, ledgerSequence INT64, transactionHash STRING, blockCloseTime TIMESTAMP)"
      )
      .then(() => true)
      // Best-effort: the Cloud Run service account can query BigQuery but may lack table-CREATE perms.
      // The table is provisioned by the backfill/loader anyway, so a CREATE failure must NOT block reads —
      // the SELECT below surfaces a real "table not found" only if it genuinely doesn't exist.
      .catch(() => true);
  }
  return tableReady;
}

/**
 * @param {string} wallet  G-address of the borrower (= escrow milestone receiver)
 * @returns {Promise<null | {bountyUsd12mo:number, payouts12mo:number, tenureDays:number, lastPaidDaysAgo:number, githubEngagementVerified:boolean}>}
 */
async function fetchOssContribution(wallet) {
  if (!/^G[A-Z2-7]{55}$/.test(wallet || "")) return null;
  await ensureTable();
  const [rows] = await bq.query({
    query:
      "WITH paid AS (" +
      "  SELECT engagementId, blockCloseTime, " +
      "         amount * (1 - SAFE_DIVIDE(platformFeeBps, 10000) - 0.003) AS netUsd " +
      "  FROM " + TABLE +
      "  WHERE receiver = @wallet AND assetCode = 'USDC' " + // USD-pegged only (1:1); extend when more priced
      "    AND blockCloseTime >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 365 DAY)) " +
      "SELECT COUNT(*) AS payouts12mo, ROUND(SUM(netUsd), 2) AS bountyUsd12mo, " +
      "       TIMESTAMP_DIFF(CURRENT_TIMESTAMP(), MIN(blockCloseTime), DAY) AS tenureDays, " +
      "       TIMESTAMP_DIFF(CURRENT_TIMESTAMP(), MAX(blockCloseTime), DAY) AS lastPaidDaysAgo, " +
      "       COUNT(DISTINCT engagementId) AS distinctEngagements " +
      "FROM paid",
    params: { wallet },
  });
  const r = rows[0] || {};
  const payouts = Number(r.payouts12mo || 0);
  if (!payouts) return null;
  return {
    bountyUsd12mo: Number(r.bountyUsd12mo || 0),
    payouts12mo: payouts,
    tenureDays: Number(r.tenureDays || 0),
    lastPaidDaysAgo: Number(r.lastPaidDaysAgo || 0),
    // Every GrantFox/TW escrow carries a GitHub engagement_id, so a non-empty distinct count means the
    // income is tied to a verifiable off-chain contributor identity (the anti-self-funding signal).
    githubEngagementVerified: Number(r.distinctEngagements || 0) >= 1,
  };
}

module.exports = { fetchOssContribution };
