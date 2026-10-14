// Ecosystem + product analytics for the /analytics page.
//
// Runs a handful of aggregate rollups over credit_bureau.credit_events_normalized (the same canonical
// view scoring uses) plus the small product tables, and caches the result in memory. The rollups are
// refreshed on a long interval (analytics move slowly) so per-request cost is zero and the whole
// refresh stays inside BigQuery's free query tier. Aggregates only — no per-address data leaves here.
const VIEW = "`credit_bureau.credit_events_normalized`";

// BigQuery returns INT64 as a number or a {value} wrapper, and TIMESTAMP/DATE as {value}; normalise.
function num(v) {
  if (v == null) return 0;
  if (typeof v === "object" && "value" in v) return Number(v.value);
  return Number(v);
}
function str(v) {
  if (v == null) return null;
  if (typeof v === "object" && "value" in v) return v.value;
  return String(v);
}

function createAnalytics(bq) {
  let cache = null;
  let computing = false;

  const q = async (sql) => (await bq.query(sql))[0];
  const qSafe = async (sql, fallback) => {
    try { return await q(sql); } catch (e) { console.error("analytics query failed:", e.message); return fallback; }
  };

  async function refresh() {
    if (computing) return;
    computing = true;
    try {
      const [kpiRows, byProtocol, byCategory, topAssets, eventsPerDay, walletsByMonth] = await Promise.all([
        q(`SELECT COUNT(*) totalEvents, COUNT(DISTINCT userAddress) totalWallets,
             COUNT(DISTINCT protocolName) totalProtocols, MAX(ledgerSequence) maxLedger,
             MIN(blockCloseTime) firstEvent, MAX(blockCloseTime) lastEvent,
             COUNTIF(blockCloseTime >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 24 HOUR)) events24h,
             COUNTIF(blockCloseTime >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 7 DAY)) events7d
           FROM ${VIEW}`),
        q(`SELECT protocolName name, COUNT(*) events, COUNT(DISTINCT userAddress) wallets
           FROM ${VIEW} WHERE protocolName IS NOT NULL GROUP BY 1 ORDER BY events DESC LIMIT 12`),
        q(`SELECT category name, COUNT(*) events
           FROM ${VIEW} WHERE category IS NOT NULL GROUP BY 1 ORDER BY events DESC LIMIT 12`),
        q(`SELECT assetCode code, COUNT(*) events
           FROM ${VIEW} WHERE assetCode IS NOT NULL AND assetCode != '' GROUP BY 1 ORDER BY events DESC LIMIT 10`),
        q(`SELECT FORMAT_DATE('%Y-%m-%d', DATE(blockCloseTime)) day, COUNT(*) events
           FROM ${VIEW} WHERE blockCloseTime >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 90 DAY)
           GROUP BY 1 ORDER BY 1`),
        q(`WITH firsts AS (
             SELECT userAddress, DATE_TRUNC(DATE(MIN(blockCloseTime)), MONTH) m
             FROM ${VIEW} WHERE userAddress IS NOT NULL GROUP BY 1)
           SELECT FORMAT_DATE('%Y-%m', m) month, COUNT(*) newWallets,
             SUM(COUNT(*)) OVER (ORDER BY m) cumulativeWallets
           FROM firsts GROUP BY m ORDER BY m`),
      ]);

      // Product tables are tiny and created on first use elsewhere — never let a missing one break the page.
      const waitlist = await qSafe("SELECT COUNT(*) n FROM `credit_bureau.waitlist`", [{ n: 0 }]);
      const accept = await qSafe(
        "SELECT COUNT(*) n, IFNULL(SUM(principalUsd), 0) principalUsd FROM `credit_bureau.df_credit_acceptances`",
        [{ n: 0, principalUsd: 0 }]);

      // Score distribution (written by batch-score.js; empty until it has run — page hides it then).
      const scoreHist = await qSafe("SELECT lo, hi, count FROM `credit_bureau.credit_score_histogram` ORDER BY lo", []);
      const scoreTiers = await qSafe("SELECT tier, count FROM `credit_bureau.credit_score_tiers` ORDER BY tier", []);

      // Per-protocol daily series for the top protocols (powers the time-series filter).
      const topNames = byProtocol.slice(0, 6).map((r) => r.name);
      let eventsPerDayByProtocol = [];
      if (topNames.length) {
        const [rows] = await bq.query({
          query: `SELECT FORMAT_DATE('%Y-%m-%d', DATE(blockCloseTime)) day, protocolName name, COUNT(*) events
                  FROM ${VIEW}
                  WHERE blockCloseTime >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 90 DAY)
                    AND protocolName IN UNNEST(@names)
                  GROUP BY 1, 2 ORDER BY 1`,
          params: { names: topNames },
        });
        const byName = {};
        for (const r of rows) (byName[r.name] = byName[r.name] || []).push({ day: str(r.day), events: num(r.events) });
        eventsPerDayByProtocol = topNames.map((n) => ({ name: n, series: byName[n] || [] }));
      }

      const k = kpiRows[0];
      cache = {
        computedAt: new Date().toISOString(),
        kpis: {
          totalEvents: num(k.totalEvents),
          totalWallets: num(k.totalWallets),
          totalProtocols: num(k.totalProtocols),
          maxLedger: num(k.maxLedger),
          firstEvent: str(k.firstEvent),
          lastEvent: str(k.lastEvent),
          events24h: num(k.events24h),
          events7d: num(k.events7d),
        },
        byProtocol: byProtocol.map((r) => ({ name: r.name, events: num(r.events), wallets: num(r.wallets) })),
        byCategory: byCategory.map((r) => ({ name: r.name, events: num(r.events) })),
        topAssets: topAssets.map((r) => ({ code: r.code, events: num(r.events) })),
        eventsPerDay: eventsPerDay.map((r) => ({ day: str(r.day), events: num(r.events) })),
        eventsPerDayByProtocol,
        walletsByMonth: walletsByMonth.map((r) => ({
          month: str(r.month), newWallets: num(r.newWallets), cumulativeWallets: num(r.cumulativeWallets),
        })),
        product: {
          waitlist: num(waitlist[0] && waitlist[0].n),
          acceptances: num(accept[0] && accept[0].n),
          principalUsd: num(accept[0] && accept[0].principalUsd),
        },
        scoreHistogram: (scoreHist || []).map((r) => ({ lo: num(r.lo), hi: num(r.hi), count: num(r.count) })),
        scoreTiers: (scoreTiers || []).map((r) => ({ tier: r.tier, count: num(r.count) })),
      };
      console.log("Analytics refreshed: " + cache.kpis.totalEvents + " events, " + cache.kpis.totalWallets + " wallets");
    } catch (e) {
      console.error("Analytics refresh failed, keeping previous values:", e.message);
    } finally {
      computing = false;
    }
  }

  return { refresh, get: () => cache };
}

module.exports = { createAnalytics };
