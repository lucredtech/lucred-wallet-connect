// Wallet portfolio: current token balances and DeFi positions, read live from
// the chain at no cost (Horizon + public Soroban RPC read-only calls).
//
// The wallet's own indexed history (credit_events, clustered by userAddress, so
// one cheap query) tells us WHICH contracts to ask, instead of scanning every
// pool on the network. Supported today: classic + Soroban token balances,
// Blend (collateral / supply / debt), Aquarius LP, DeFindex vaults. Anything
// else the wallet has history in is reported as `notShown`, never silently
// dropped.
//
// Pricing is deliberately an ALLOWLIST BY CONTRACT ID, not by ticker: a scam
// token calling itself "USDC" must never be valued at $1. Only the contracts
// below get a USD price; every other token is listed but unpriced and excluded
// from totals.
const { rpc, Contract, TransactionBuilder, Networks, Account, Keypair, Address, Asset, nativeToScVal, scValToNative } = require("@stellar/stellar-sdk");

const RPC_URLS = [
  "https://mainnet.sorobanrpc.com",
  "https://soroban-rpc.mainnet.stellar.gateway.fm",
  "https://rpc.lightsail.network"
];
const HORIZON_URL = "https://horizon.stellar.org";

// token contract id -> ticker (verified against on-chain data: events' assetContractId
// for USDC/XLM/AQUA/EURC, and `symbol()` == "BLND" for BLND). Price comes from
// credit_bureau.asset_prices by ticker.
const PRICED_TOKENS = {
  CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA: "XLM",
  CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75: "USDC",
  CDTKPWPLOURQA2SGTKTUQOWRCBZEORB4BWBOMJ3D3ZTQQSGE5F6JBQLV: "EURC",
  CAUIKL3IYGMERDRUN6YSCLWVAKIFG5Q4YJHUKM4S4NJZQIA3BAS6OJPK: "AQUA",
  CD25MNVTZDL4Y3XBCPCJXGXATV5WUHHOWMYFF4YBEGU5FCPGMYTVG5JY: "BLND",
  // PYUSD: name() = PYUSD:GDQE7IXJ...TU2V5, issuer home_domain token-metadata.paxos.com, SAC id matches.
  CCCRWH6Q3FNP3I2I57BDLM5AFAT7O6OF6GKQOC6SSJNDAVRZ57SPHGU2: "PYUSD",
  // Etherfuse stablebonds: contract ids from stellar.expert's curated list (domain etherfuse.com);
  // priced from Etherfuse's own API (asset_prices), cross-checked against stellar.expert's market price.
  CAL6ER2TI6CTRAY6BFXWNWA7WTYXUXTQCHUBCIBU5O6KM3HJFG6Z6VXV: "CETES",
  CBLV4ATSIWU67CFSQU2NVRKINQIKUZ2ODSZBUJTJ43VJVRSBTZYOPNUR: "USTRY",
  // TESOURO (Brazil treasury bond, Etherfuse): issuer home_domain etherfuse.com, contract id
  // matches stellar.expert's record, Etherfuse live price within 0.1% of its market price.
  CD6M4R2322BYCY2LNWM74PEBQAQ63SA3DUJLI3L4225U4ZVCLMSCBCIS: "TESOURO"
};

// Everything NOT on the verified list above can still be priced if it is on stellar.expert's
// curated top-50 asset list (matched by CONTRACT ID, never ticker - that list contains two
// different "EURC"s) AND actually trades: a thin market's last price is not a value.
// The rows come from credit_bureau.token_prices (refreshed every 6h by the price job).
const MIN_TOKEN_VOLUME_USD = 100000; // 7-day USD volume
const MAX_TOKEN_PRICE_AGE_MS = 48 * 60 * 60 * 1000;

// Untangled vaults that mint a transferable share token we can read (see untangledPosition).
const UNTANGLED_TOKEN_VAULTS = new Set(["CDDDLSQAR6EVIBFU6KMHA6WLIZJ5PDPXKJCEADD6YJ3HJ3S775XHVEE4"]);
const MAX_AQUARIUS_POOLS = 15;
const MAX_EXTRA_TOKENS = 8;
const CONCURRENCY = 6;
const CALL_TIMEOUT_MS = 9000;
const BUDGET_MS = 28000;
const CACHE_TTL_MS = 60 * 1000;

const sourceAccount = new Account(Keypair.random().publicKey(), "0");
const rpcServers = RPC_URLS.map((u) => new rpc.Server(u));
let rpcRotation = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const addrVal = (a) => new Address(a).toScVal();
const i128Val = (n) => nativeToScVal(BigInt(n), { type: "i128" });

function withTimeout(promise, ms) {
  let t;
  return Promise.race([promise, new Promise((_, rej) => { t = setTimeout(() => rej(new Error("timeout")), ms); })]).finally(() => clearTimeout(t));
}

// Read-only contract call via simulation. Rotates across public RPC servers and
// retries (they rate-limit by IP). Returns the native value, or throws.
async function callContract(contractId, fn, args = []) {
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    const server = rpcServers[(rpcRotation + attempt) % rpcServers.length];
    try {
      const tx = new TransactionBuilder(sourceAccount, { fee: "100", networkPassphrase: Networks.PUBLIC })
        .addOperation(new Contract(contractId).call(fn, ...args)).setTimeout(30).build();
      const sim = await withTimeout(server.simulateTransaction(tx), CALL_TIMEOUT_MS);
      if (sim.error) { const e = new Error(String(sim.error).split("\n")[0].slice(0, 160)); e.contractError = true; throw e; }
      rpcRotation = (rpcRotation + attempt) % rpcServers.length;
      return scValToNative(sim.result.retval);
    } catch (err) {
      lastErr = err;
      if (err.contractError) throw err; // the contract itself said no - retrying elsewhere won't help
      await sleep(250 * (attempt + 1));
    }
  }
  throw lastErr;
}

// Tiny concurrency limiter.
function limiter(max) {
  let active = 0;
  const queue = [];
  const next = () => { if (active >= max || !queue.length) return; active++; const { fn, resolve, reject } = queue.shift(); fn().then(resolve, reject).finally(() => { active--; next(); }); };
  return (fn) => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); next(); });
}

// Static facts about a contract never change - cache them for the process lifetime.
const staticCache = new Map();
async function cachedStatic(key, loader) {
  if (!staticCache.has(key)) staticCache.set(key, loader().catch((e) => { staticCache.delete(key); throw e; }));
  return staticCache.get(key);
}
const tokenMeta = (contractId) => cachedStatic("meta:" + contractId, async () => {
  const [symbol, decimals] = await Promise.all([
    callContract(contractId, "symbol").catch(() => null),
    callContract(contractId, "decimals").catch(() => 7)
  ]);
  return { symbol: PRICED_TOKENS[contractId] || (typeof symbol === "string" ? symbol : null), decimals: Number(decimals) };
});

const scale = (raw, decimals) => Number(raw) / 10 ** decimals;

// Can the wallet actually move this token (i.e. pledge it as collateral)?
//   true  - a normal token the holder controls
//   false - the issuer has NOT authorized this holder (e.g. Aquarius ICE/governICE/upvoteICE:
//           issuer-controlled balances that can't be sent), or pool/lending shares that live inside a protocol
//   null  - we can't tell (unlisted Soroban token)
// `clawback` is reported separately: the issuer can claw the balance back, which a lender should know.
function tokenTransferability(t) {
  if (t.kind === "classic_lp_shares") return { transferable: true, reason: "Classic pool shares can be withdrawn and moved" };
  if (t.unauthorized) return { transferable: false, reason: "The issuer hasn't authorized this wallet to move it" };
  if (t.issuer || PRICED_TOKENS[t.contractId]) return { transferable: true };
  return { transferable: null, reason: "Couldn't confirm this token is transferable" };
}

// Positions: Blend deposits/loans are bookkeeping inside the pool (nothing to send; it must be withdrawn first).
// Aquarius LP tokens, DeFindex dfTokens and Untangled USDyc are standard transferable share tokens.
function positionTransferability(p) {
  if (p.protocol === "blend") return { transferable: false, reason: "Held inside the Blend pool as a lending position" };
  return { transferable: true, reason: "Share token the wallet can transfer" };
}

function createPortfolioService({ queryTouched, getAssetPriceMap, getVaultAssetMap, getTokenPriceMap = () => ({}) }) {
  const resultCache = new Map(); // wallet -> { at, promise }

  // -> { price, source } or null. Never guesses from a ticker string.
  function priceOf(contractId, priceMap, tokenPrices) {
    const ticker = PRICED_TOKENS[contractId];
    if (ticker && priceMap[ticker]) return { price: priceMap[ticker].usdRate, source: "verified" };
    const t = tokenPrices[contractId];
    if (t && t.usdRate > 0 && t.volume7dUsd >= MIN_TOKEN_VOLUME_USD) {
      const age = t.updatedAt ? Date.now() - new Date(t.updatedAt.value || t.updatedAt).getTime() : 0;
      if (!(age > MAX_TOKEN_PRICE_AGE_MS)) return { price: t.usdRate, source: "stellar.expert" };
    }
    return null;
  }

  async function tokenBalances(wallet, touchedAssetContracts, deadline, excludeContracts) {
    const out = [];
    const limit = limiter(CONCURRENCY);
    const isG = wallet[0] === "G";
    const seen = new Set();

    if (isG) {
      // Horizon: every classic balance in one free call (incl. classic assets' SACs).
      try {
        const res = await withTimeout(fetch(`${HORIZON_URL}/accounts/${wallet}`), CALL_TIMEOUT_MS);
        if (res.ok) {
          const acct = await res.json();
          for (const b of acct.balances || []) {
            if (b.asset_type === "liquidity_pool_shares") { out.push({ kind: "classic_lp_shares", code: "LP shares", balance: Number(b.balance), contractId: null, note: "Classic liquidity-pool shares (not valued)" }); continue; }
            const code = b.asset_type === "native" ? "XLM" : b.asset_code;
            let contractId = null;
            try { contractId = b.asset_type === "native" ? Asset.native().contractId(Networks.PUBLIC) : new Asset(b.asset_code, b.asset_issuer).contractId(Networks.PUBLIC); } catch (e) {}
            if (contractId) seen.add(contractId);
            out.push({ kind: "token", code, issuer: b.asset_issuer || null, contractId, balance: Number(b.balance), ...(b.is_authorized === false && { unauthorized: true }), ...(b.is_clawback_enabled && { clawback: true }) });
          }
        }
      } catch (e) { /* Horizon down: the Soroban reads below still run */ }
    }

    // Soroban token balances: allowlisted tokens a classic account can't show
    // (BLND is Soroban-native) or that a C... wallet holds, plus any other token
    // the wallet's history touched.
    // Horizon already listed every classic asset (incl. those with a Soroban
    // contract) - only ask the RPC about allowlisted tokens it didn't show.
    const toCheck = Object.keys(PRICED_TOKENS).filter((c) => !seen.has(c));
    // A DeFindex vault IS its own share token (and pools' LP tokens likewise); those
    // holdings are reported as positions, so listing them here would double-count.
    const extras = touchedAssetContracts.filter((c) => !PRICED_TOKENS[c] && !seen.has(c) && !excludeContracts.has(c)).slice(0, MAX_EXTRA_TOKENS);
    await Promise.all([...toCheck, ...extras].map((contractId) => limit(async () => {
      if (Date.now() > deadline) return;
      try {
        const raw = await callContract(contractId, "balance", [addrVal(wallet)]);
        if (BigInt(raw) === 0n) return;
        const meta = await tokenMeta(contractId);
        out.push({ kind: "token", code: meta.symbol || contractId.slice(0, 6) + "…", issuer: null, contractId, balance: scale(raw, meta.decimals) });
      } catch (e) { /* a token without a standard balance(): skip */ }
    })));
    return out.filter((t) => t.balance > 0 || t.kind === "classic_lp_shares");
  }

  async function blendPositions(pool, wallet) {
    const pos = await callContract(pool, "get_positions", [addrVal(wallet)]);
    const buckets = [["collateral", pos.collateral, "b"], ["supply", pos.supply, "b"], ["debt", pos.liabilities, "d"]];
    if (!buckets.some(([, m]) => m && Object.keys(m).length)) return [];
    const list = await cachedStatic("blendlist:" + pool, () => callContract(pool, "get_reserve_list"));
    const out = [];
    for (const [type, map, rateKind] of buckets) {
      for (const [idx, raw] of Object.entries(map || {})) {
        const asset = list[Number(idx)];
        if (!asset || BigInt(raw) === 0n) continue;
        const res = await callContract(pool, "get_reserve", [addrVal(asset)]);
        const rate = BigInt(rateKind === "b" ? res.data.b_rate : res.data.d_rate);
        const underlying = Number((BigInt(raw) * rate) / 10n ** 12n) / 10 ** Number(res.config.decimals);
        const meta = await tokenMeta(asset);
        out.push({ protocol: "blend", pool, type, assets: [{ contractId: asset, code: meta.symbol, amount: underlying }] });
      }
    }
    return out;
  }

  async function aquariusPosition(pool, wallet) {
    // Aquarius has constant_product, stable and concentrated pools. Only the first two
    // issue fungible LP tokens we can read a balance of; a concentrated pool's
    // positions are price ranges, not tokens, and need a different read - say so
    // instead of silently reporting "no position".
    const poolType = await cachedStatic("aqtype:" + pool, () => callContract(pool, "pool_type"));
    if (poolType === "concentrated") { const e = new Error("concentrated"); e.unsupported = "aquarius concentrated-liquidity pools"; throw e; }
    const shareId = await cachedStatic("aqshare:" + pool, () => callContract(pool, "share_id"));
    const shares = await callContract(shareId, "balance", [addrVal(wallet)]);
    if (BigInt(shares) === 0n) return [];
    const [reserves, tokens, total] = await Promise.all([callContract(pool, "get_reserves"), callContract(pool, "get_tokens"), callContract(pool, "get_total_shares")]);
    const assets = [];
    for (let i = 0; i < tokens.length; i++) {
      const meta = await tokenMeta(tokens[i]);
      const amount = scale((BigInt(reserves[i]) * BigInt(shares)) / BigInt(total), meta.decimals);
      assets.push({ contractId: tokens[i], code: meta.symbol, amount });
    }
    return [{ protocol: "aquarius", pool, type: "liquidity", lpToken: true, assets, sharePct: Number(shares) / Number(total) * 100 }];
  }

  // A DeFindex vault's underlying asset(s) come straight from the vault (get_assets), so
  // every vault - including ones newer than the BigQuery vault_assets table, and
  // multi-asset vaults - is read the same way. vaultAssets (ticker by vault) is only a
  // fallback label if the call fails.
  async function defindexPosition(vault, wallet, vaultAssets) {
    const shares = await callContract(vault, "balance", [addrVal(wallet)]);
    if (BigInt(shares) === 0n) return [];
    const amounts = await callContract(vault, "get_asset_amounts_per_shares", [i128Val(shares)]);
    let underlying = [];
    try {
      const list = await cachedStatic("dfassets:" + vault, () => callContract(vault, "get_assets"));
      underlying = (list || []).map((a) => (typeof a === "string" ? a : a && a.address)).filter(Boolean);
    } catch (e) { /* fall back to the table's label below */ }
    const assets = [];
    for (let i = 0; i < amounts.length; i++) {
      const contractId = underlying[i] || null;
      const meta = contractId ? await tokenMeta(contractId) : { symbol: null, decimals: 7 };
      assets.push({ contractId, code: meta.symbol || vaultAssets[vault] || null, amount: scale(amounts[i], meta.decimals) });
    }
    return [{ protocol: "defindex", pool: vault, type: "vault", lpToken: true, assets }];
  }

  // Untangled's USDyc II vault is an ERC-4626-style vault whose share token (USDyc) is a normal
  // transferable token: balance -> convert_to_assets gives the underlying USDC. The other three
  // Untangled vaults (adf28ca3 build) keep deposits as internal requests, have no token and no
  // balance(), so they are not readable here and stay in `notShown`.
  async function untangledPosition(vault, wallet) {
    const shares = await callContract(vault, "balance", [addrVal(wallet)]);
    if (BigInt(shares) === 0n) return [];
    const assetId = await cachedStatic("untangled-asset:" + vault, () => callContract(vault, "query_asset"));
    const raw = await callContract(vault, "convert_to_assets", [i128Val(shares)]);
    const meta = await tokenMeta(assetId);
    return [{ protocol: "untangled_rwa", pool: vault, type: "vault", lpToken: true, assets: [{ contractId: assetId, code: meta.symbol, amount: scale(raw, meta.decimals) }] }];
  }

  async function compute(wallet) {
    const started = Date.now();
    const deadline = started + BUDGET_MS;
    const priceMap = getAssetPriceMap();
    const vaultAssets = getVaultAssetMap();
    const tokenPrices = getTokenPriceMap();
    const { contracts, assetContracts } = await queryTouched(wallet);

    const excludeContracts = new Set([...contracts.map((c) => c.contractId), ...Object.keys(vaultAssets)]);
    const limit = limiter(CONCURRENCY);
    const errors = [];
    const unsupported = new Set();
    // A contract-level error (e.g. Aquarius's router, which is not a pool) means "this isn't
    // that kind of contract" - skip it quietly. Only real failures (timeouts, RPC
    // trouble) make the result `partial`.
    const run = (label, fn) => limit(async () => { if (Date.now() > deadline) { errors.push(label + ": skipped (time budget)"); return []; } try { return await fn(); } catch (e) { if (e.unsupported) unsupported.add(e.unsupported); else if (!e.contractError) errors.push(label + ": " + e.message); return []; } });

    const jobs = [];
    const byProto = {};
    for (const c of contracts) { (byProto[c.protocolName] = byProto[c.protocolName] || []).push(c); }

    for (const c of (byProto.blend || []).filter((x) => x.category === "lending_pool")) jobs.push(run("blend " + c.contractId.slice(0, 6), () => blendPositions(c.contractId, wallet)));
    for (const c of (byProto.aquarius || []).slice(0, MAX_AQUARIUS_POOLS)) jobs.push(run("aquarius " + c.contractId.slice(0, 6), () => aquariusPosition(c.contractId, wallet)));
    for (const c of (byProto.untangled_rwa || []).filter((x) => UNTANGLED_TOKEN_VAULTS.has(x.contractId))) jobs.push(run("untangled " + c.contractId.slice(0, 6), () => untangledPosition(c.contractId, wallet)));
    for (const c of (byProto.defindex || [])) jobs.push(run("defindex " + c.contractId.slice(0, 6), () => defindexPosition(c.contractId, wallet, vaultAssets)));

    const [tokens, ...positionLists] = await Promise.all([tokenBalances(wallet, assetContracts, deadline, excludeContracts), ...jobs]);
    const positions = positionLists.flat();

    // Valuation.
    const unpriced = new Set();
    let tokensUsd = 0;
    const tokenRows = tokens.map((t) => {
      const priced = t.contractId ? priceOf(t.contractId, priceMap, tokenPrices) : null;
      const price = priced ? priced.price : null;
      const usd = price !== null ? t.balance * price : null;
      if (usd !== null) tokensUsd += usd; else if (t.kind === "token") unpriced.add(t.code);
      const transfer = tokenTransferability(t);
      return { code: t.code, kind: t.kind, contractId: t.contractId, issuer: t.issuer || null, balance: t.balance, usdPrice: price, usdValue: usd, transferable: transfer.transferable, ...(transfer.reason && { transferNote: transfer.reason }), ...(t.clawback && { clawback: true }), ...(priced && { priceSource: priced.source }), ...(t.note && { note: t.note }) };
    }).sort((a, b) => (b.usdValue || 0) - (a.usdValue || 0));
    const tokenTransferableUsd = tokenRows.reduce((sum, r) => sum + (r.transferable === true && r.usdValue !== null ? r.usdValue : 0), 0);
    // A classic account can carry hundreds of airdropped/dust trustlines. Keep every priced
    // token, but cap the unpriced tail and say how many were left out.
    const pricedRows = tokenRows.filter((t) => t.usdValue !== null);
    const unpricedRows = tokenRows.filter((t) => t.usdValue === null);
    const UNPRICED_CAP = 25;
    const shownTokens = [...pricedRows, ...unpricedRows.slice(0, UNPRICED_CAP)];
    const hiddenUnpricedTokens = Math.max(0, unpricedRows.length - UNPRICED_CAP);

    let suppliedUsd = 0, debtUsd = 0, transferableUsd = 0;
    const positionRows = positions.map((p) => {
      let usd = 0, complete = true;
      const assets = p.assets.map((a) => {
        const priced = a.contractId ? priceOf(a.contractId, priceMap, tokenPrices) : null;
        const price = priced ? priced.price : (!a.contractId && a.code && priceMap[a.code] ? priceMap[a.code].usdRate : null);
        const v = price !== null ? a.amount * price : null;
        if (v === null) { complete = false; if (a.code) unpriced.add(a.code); } else usd += v;
        return { ...a, usdValue: v, ...(priced && { priceSource: priced.source }), ...(!priced && price !== null && { priceSource: "verified" }) };
      });
      if (complete || usd > 0) { if (p.type === "debt") debtUsd += usd; else suppliedUsd += usd; }
      const posTransfer = positionTransferability(p);
      const posUsd = complete ? usd : (usd > 0 ? usd : null);
      if (p.type !== "debt" && posUsd !== null && posTransfer.transferable) transferableUsd += posUsd;
      return { ...p, assets, usdValue: posUsd, fullyPriced: complete, transferable: posTransfer.transferable, transferNote: posTransfer.reason };
    });

    const supported = new Set(["blend", "aquarius", "defindex"]);
    const notShown = [...new Set([
      ...contracts.filter((c) => !supported.has(c.protocolName) && !(c.protocolName === "untangled_rwa" && UNTANGLED_TOKEN_VAULTS.has(c.contractId))).map((c) => c.protocolName),
      ...unsupported
    ])];

    return {
      wallet,
      asOf: new Date().toISOString(),
      tokens: shownTokens,
      hiddenUnpricedTokens,
      positions: positionRows,
      totals: {
        tokensUsd: Math.round(tokensUsd * 100) / 100,
        positionsUsd: Math.round(suppliedUsd * 100) / 100,
        grossUsd: Math.round((tokensUsd + suppliedUsd) * 100) / 100,
        debtUsd: Math.round(debtUsd * 100) / 100,
        transferableUsd: Math.round((tokenTransferableUsd + transferableUsd) * 100) / 100,
        netUsd: Math.round((tokensUsd + suppliedUsd - debtUsd) * 100) / 100,
        unpricedAssets: [...unpriced].slice(0, 30)
      },
      notShown,
      partial: errors.length > 0,
      errors: errors.slice(0, 8),
      tookMs: Date.now() - started
    };
  }

  // One computation per wallet per minute (also dedupes simultaneous requests) -
  // protects the free public RPC servers.
  return {
    getPortfolio(wallet) {
      const hit = resultCache.get(wallet);
      if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.promise;
      const promise = compute(wallet);
      resultCache.set(wallet, { at: Date.now(), promise });
      promise.catch(() => resultCache.delete(wallet));
      if (resultCache.size > 500) resultCache.delete(resultCache.keys().next().value);
      return promise;
    }
  };
}

// Ticker of a DeFindex vault's underlying asset, read from the vault itself, for vaults missing
// from credit_bureau.vault_assets. Only a SINGLE-asset vault whose asset is on the verified
// contract-id allowlist resolves (a vault creator can't pass off a fake "USDC"); anything else
// returns null and the caller skips it, exactly as an unmapped vault was skipped before.
// Results (including "no") are cached for the process lifetime.
const vaultTickerCache = new Map();
function resolveVaultTicker(vault) {
  if (!vaultTickerCache.has(vault)) {
    vaultTickerCache.set(vault, (async () => {
      const list = await callContract(vault, "get_assets");
      const ids = (list || []).map((a) => (typeof a === "string" ? a : a && a.address)).filter(Boolean);
      return ids.length === 1 ? (PRICED_TOKENS[ids[0]] || null) : null;
    })().catch((e) => { vaultTickerCache.delete(vault); return null; }));
  }
  return vaultTickerCache.get(vault);
}

module.exports = { createPortfolioService, PRICED_TOKENS, resolveVaultTicker };
