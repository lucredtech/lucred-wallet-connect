// Offline batch scorer -> ecosystem score distribution.
//
// Streams every event (ordered by wallet) once, scores each wallet with the EXACT production scorer
// reused from index.js (event-based path, classic=null), and writes a tiny histogram + tier breakdown
// to BigQuery for the /analytics page. One ~full-table scan per run; meant to run on a schedule (e.g.
// weekly) on a host with BigQuery credentials. Aggregates only — the per-wallet scores are not stored.
const { BigQuery } = require("@google-cloud/bigquery");
const { refreshReferenceData, scoreEventsForWallet } = require("./index");

const bq = new BigQuery();
const VIEW = "`credit_bureau.credit_events_normalized`";
const MAX_EVENTS_PER_WALLET = 50000; // mirror the LIMIT in /score so whales score the same way
const BINS = 10; // 0-9, 10-19, ... , 90-100

function rowToEvent(r) {
  return {
    ledgerSequence: r.ledgerSequence, transactionHash: r.transactionHash,
    blockCloseTime: (r.blockCloseTime && r.blockCloseTime.value) || r.blockCloseTime,
    protocolName: r.protocolName, category: r.category, contractId: r.contractId,
    userAddress: r.userAddress, eventType: r.eventType, amount: r.amount,
    assetContractId: r.assetContractId, assetCode: r.assetCode,
    assetOutContractId: r.assetOutContractId, assetOutCode: r.assetOutCode, amountOut: r.amountOut,
    counterpartyAddress: r.counterpartyAddress, poolShareTokensAfter: r.poolShareTokensAfter,
    collateralRatioAfter: r.collateralRatioAfter,
  };
}

async function main() {
  console.log(new Date().toISOString(), "batch-score start; loading reference data…");
  await refreshReferenceData();

  const hist = new Array(BINS).fill(0);
  const tiers = { A: 0, B: 0, C: 0 };
  let wallets = 0, truncated = 0;

  let current = null;       // current userAddress
  let events = [];          // its events (capped)
  let capped = false;

  const scoreCurrent = () => {
    if (!current || events.length === 0) return;
    let result;
    try { result = scoreEventsForWallet(events); } catch (e) { events = []; capped = false; return; }
    const score = Math.max(0, Math.min(100, Math.round(result.score || 0)));
    hist[Math.min(BINS - 1, Math.floor(score / 10))]++;
    if (result.tier && tiers[result.tier] !== undefined) tiers[result.tier]++;
    wallets++;
    if (capped) truncated++;
    if (wallets % 10000 === 0) console.log(`  …scored ${wallets} wallets`);
  };

  await new Promise((resolve, reject) => {
    bq.createQueryStream({ query: `SELECT * FROM ${VIEW} WHERE userAddress IS NOT NULL ORDER BY userAddress` })
      .on("error", reject)
      .on("data", (r) => {
        if (r.userAddress !== current) { scoreCurrent(); current = r.userAddress; events = []; capped = false; }
        if (events.length < MAX_EVENTS_PER_WALLET) events.push(rowToEvent(r));
        else capped = true;
      })
      .on("end", () => { scoreCurrent(); resolve(); });
  });

  console.log(`scored ${wallets} wallets (${truncated} truncated at ${MAX_EVENTS_PER_WALLET} events)`);
  console.log("histogram:", hist, "tiers:", tiers);

  const computedAt = new Date().toISOString();
  const bucketRows = hist.map((count, i) => ({ lo: i * 10, hi: i === BINS - 1 ? 100 : i * 10 + 9, count, computedAt }));
  const tierRows = Object.entries(tiers).map(([tier, count]) => ({ tier, count, computedAt }));

  const ds = bq.dataset("credit_bureau");
  await bq.query("CREATE TABLE IF NOT EXISTS `credit_bureau.credit_score_histogram` (lo INT64, hi INT64, count INT64, computedAt TIMESTAMP)");
  await bq.query("CREATE TABLE IF NOT EXISTS `credit_bureau.credit_score_tiers` (tier STRING, count INT64, computedAt TIMESTAMP)");
  await bq.query("TRUNCATE TABLE `credit_bureau.credit_score_histogram`");
  await bq.query("TRUNCATE TABLE `credit_bureau.credit_score_tiers`");
  await ds.table("credit_score_histogram").insert(bucketRows);
  await ds.table("credit_score_tiers").insert(tierRows);
  console.log(new Date().toISOString(), "batch-score done; wrote histogram + tiers");
}

main().catch((e) => { console.error("batch-score failed:", e); process.exit(1); });
