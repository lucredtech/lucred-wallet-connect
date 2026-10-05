// Classic Stellar history: account age and how much a G... account has paid/traded outside
// Soroban. The score is built from Soroban DeFi events (since 2024), so a wallet that has been
// active on Stellar since 2020 would otherwise get no credit for its track record.
//
// Deliberately SMALL and bounded (see classicPoints): account age is hard to fake, but payments
// and trades cost a fraction of a cent each, so volume counts for one point at most. Classic
// activity never lifts a wallet that has no DeFi history; it only adds to one that does.
//
// Free reads only: stellar.expert's account summary (one call), with Horizon's first operation
// as an age-only fallback. Results are cached per address; any failure means "no bonus", never
// an error.
const EXPERT_URL = "https://api.stellar.expert/explorer/public/account/";
const HORIZON_URL = "https://horizon.stellar.org";
const TTL_MS = 6 * 60 * 60 * 1000;
const FAIL_TTL_MS = 5 * 60 * 1000;
const TIMEOUT_MS = 4000;
const YEAR_MS = 365.25 * 24 * 60 * 60 * 1000;

const cache = new Map(); // address -> { at, value }

async function getJson(url) {
  const res = await fetch(url, { headers: { "User-Agent": "LCRD-credit-score/1.0", Accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.json();
}

async function fetchClassicActivity(address) {
  try {
    const d = await getJson(EXPERT_URL + address);
    if (typeof d.created === "number" && d.created > 0) {
      return {
        createdAt: new Date(d.created * 1000).toISOString(),
        payments: Number(d.payments) || 0,
        trades: Number(d.trades) || 0,
        yearlyActivity: (d.activity && d.activity.yearly) || null,
        source: "stellar.expert"
      };
    }
  } catch (e) { /* fall through to Horizon */ }
  try {
    // The account's first operation is its creation, so its date is the account's age.
    const d = await getJson(HORIZON_URL + "/accounts/" + address + "/operations?order=asc&limit=1");
    const first = d && d._embedded && d._embedded.records && d._embedded.records[0];
    if (first && first.created_at) return { createdAt: first.created_at, payments: null, trades: null, yearlyActivity: null, source: "horizon" };
  } catch (e) { /* no bonus */ }
  return null;
}

// -> { createdAt, ageYears, payments, trades, yearlyActivity, source } | null. G... addresses only.
async function getClassicActivity(address) {
  if (!address || address[0] !== "G") return null;
  const hit = cache.get(address);
  if (hit && Date.now() - hit.at < (hit.value ? TTL_MS : FAIL_TTL_MS)) return hit.value;
  const raw = await fetchClassicActivity(address);
  const value = raw ? { ...raw, ageYears: Math.max(0, (Date.now() - new Date(raw.createdAt).getTime()) / YEAR_MS) } : null;
  cache.set(address, { at: Date.now(), value });
  if (cache.size > 2000) cache.delete(cache.keys().next().value);
  return value;
}

// Age: 90 days +1, 1 year +2, 2 years +3, 4 years +4.
// Activity: +1 only for a real classic footprint (>= 1,000 payments or >= 100 trades) that is still
// active this year. Capped at 5 on the activity path and 3 on the lending path, where repayment
// history already carries the score.
function classicPoints(classic, path) {
  if (!classic) return { points: 0, detail: "unavailable" };
  const y = classic.ageYears;
  const agePts = y >= 4 ? 4 : y >= 2 ? 3 : y >= 1 ? 2 : y >= 0.25 ? 1 : 0;
  const active = classic.yearlyActivity && classic.yearlyActivity !== "none";
  const footprint = (classic.payments || 0) >= 1000 || (classic.trades || 0) >= 100;
  const activityPts = footprint && active ? 1 : 0;
  const cap = path === "lending" ? 3 : 5;
  const points = Math.min(cap, agePts + activityPts);
  const bits = ["age " + y.toFixed(1) + "y (+" + agePts + ")"];
  if (classic.payments !== null) bits.push((classic.payments || 0).toLocaleString("en-US") + " payments, " + (classic.trades || 0).toLocaleString("en-US") + " trades (+" + activityPts + ")");
  return { points, detail: bits.join(", ") + (agePts + activityPts > cap ? ", capped at " + cap : "") };
}

module.exports = { getClassicActivity, classicPoints };
