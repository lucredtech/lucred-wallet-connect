import { rpc, Contract, TransactionBuilder, Networks, scValToNative, nativeToScVal, Account, Keypair, xdr } from '@stellar/stellar-sdk';
import { ProtocolInfo } from './registry';

/**
 * Live, runtime discovery of pool/pair/vault addresses that a factory
 * deploys dynamically - the same problem DefiLlama's own TVL adapters solve
 * per protocol (see the specific references in each function below). A
 * static list in registry.ts goes stale the moment a new pool launches;
 * calling these at indexer startup (see indexer.ts) doesn't.
 *
 * Verified against real mainnet data as of 2026-09-20:
 * - Soroswap: 214 real pairs exist via all_pairs_length/all_pairs.
 * - Sushi Stellar: pool_created events exist on the real factory.
 * - DeFindex: has a real on-chain factory (see discoverDeFindexVaults below)
 *   that enumerates every vault ever deployed - their own discover API and
 *   this file's old static registry fallback together covered only 23 of
 *   117 real vaults (confirmed 2026-09-30).
 */

const RPC_URL = 'https://mainnet.sorobanrpc.com';
const STELLAR_EXPERT = 'https://api.stellar.expert/explorer/public';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** True for a rate-limit/server-side error worth retrying, false for a real
 * simulation failure (bad method name, contract reverted, ...) that would
 * just fail identically on retry. Soroban RPC's HTTP client wraps a 429/5xx
 * in an error whose message contains the status text (confirmed directly:
 * mainnet.sorobanrpc.com's Cloudflare front-end returns a 429 with "Too Many
 * Requests" in the body during a burst of calls - see the next comment for
 * why that burst is easy to trigger here specifically). */
function isTransientRpcError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /429|too many requests|5\d\d|rate.?limit/i.test(message);
}

/**
 * Read-only contract call via Soroban RPC simulation. Uses a freshly
 * generated, never-funded keypair as the transaction source - confirmed
 * against real mainnet data that simulateTransaction neither requires nor
 * checks that the source account exists on-ledger, so this has no
 * dependency on any specific real account's continued existence (unlike an
 * earlier version of this research that hardcoded one and it later 404'd).
 *
 * Retries transient (429/5xx) failures with backoff - confirmed necessary
 * live: mainnet.sorobanrpc.com sits behind Cloudflare rate-limiting, and
 * discoverSoroswapPairs (the only caller that loops this many times) makes
 * ~215 of these calls back-to-back to enumerate every pair. Before this,
 * ANY single 429 mid-loop threw and discoverAllDynamicPools's per-source
 * catch discarded the *entire* partial result - not a graceful
 * degradation, a real outage: an indexer restart during any rate-limited
 * window started with Soroswap (Stellar's highest-volume tracked protocol
 * by pair count) completely missing from the registry, silently, for that
 * process's entire lifetime, since discovery only runs once at startup.
 *
 * STRENGTHENED 2026-10-01: the original 5-attempt/linear-backoff version
 * (max ~7.5s of total retry wait) turned out to be nowhere near enough in
 * practice - confirmed on real mainnet logs across every indexer shard in
 * the fleet (~17 containers, multiple per VM, all independently running
 * this same discovery on overlapping schedules against ONE shared public
 * RPC host): DeFindex discovery (118 sequential calls) was failing with
 * 429s on essentially EVERY startup and EVERY periodic refresh, on EVERY
 * shard checked, not as an occasional blip. The real cause is a
 * thundering-herd effect this function alone can't fully fix (several
 * containers sharing one VM's outbound IP all hammer the same endpoint at
 * once, so one container backing off doesn't stop its neighbors from
 * keeping the rate limiter tripped) - but a much longer, exponential,
 * jittered retry budget (up to ~2 minutes of total wait versus ~7.5s)
 * gives a stuck call a real chance to land in a gap between other
 * containers' bursts, instead of giving up almost immediately. Jitter
 * (±30%) is specifically to stop multiple containers that got
 * rate-limited by the SAME burst from retrying in lockstep and
 * re-colliding on their very next attempt.
 */
async function simulateReadOnlyCall(
  server: rpc.Server,
  contractId: string,
  method: string,
  args: xdr.ScVal[] = [],
  maxAttempts = 9
): Promise<unknown> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const account = new Account(Keypair.random().publicKey(), '0');
      const contract = new Contract(contractId);
      const tx = new TransactionBuilder(account, { fee: '1000000', networkPassphrase: Networks.PUBLIC })
        .addOperation(contract.call(method, ...args))
        .setTimeout(30)
        .build();
      const sim = await server.simulateTransaction(tx);
      if (rpc.Api.isSimulationError(sim)) {
        throw new Error(`${method}() on ${contractId} failed: ${sim.error}`);
      }
      if (!sim.result) {
        throw new Error(`${method}() on ${contractId} returned no result (may need state restore)`);
      }
      return scValToNative(sim.result.retval);
    } catch (err) {
      lastErr = err;
      if (!isTransientRpcError(err) || attempt === maxAttempts) throw err;
      // Exponential backoff (1s, 2s, 4s, 8s, 16s, 30s cap) with ±30% jitter,
      // not the old flat 500ms*attempt - a sustained multi-container
      // rate-limit window needs real wall-clock time to clear, and jitter
      // keeps containers that got limited by the same burst from retrying
      // in lockstep and re-colliding.
      const base = Math.min(1000 * 2 ** (attempt - 1), 30000);
      const jitter = base * 0.3 * (Math.random() * 2 - 1);
      await sleep(Math.round(base + jitter));
    }
  }
  throw lastErr;
}

/**
 * Soroswap pools are Uniswap-V2-style pairs, individually deployed by the
 * factory - confirmed real (swap/sync events with correct topic/data shape)
 * against 5 real pair addresses pulled this way. Mirrors DefiLlama's own
 * enumeration method: https://github.com/DefiLlama/DefiLlama-Adapters/blob/main/projects/soroswap/index.js
 *
 * A small delay between calls (not just retry-after-the-fact) - this loop
 * is what makes Soroswap discovery uniquely likely to get rate-limited in
 * the first place: ~215 sequential simulateTransaction calls to the same
 * RPC host with no pacing at all, versus Sushi/DeFindex's much smaller
 * request counts. Spacing calls out trades a few extra seconds of startup
 * time for not tripping the limiter to begin with, rather than relying
 * purely on retry-after-the-fact to recover from it every time.
 */
export async function discoverSoroswapPairs(
  factoryId = 'CA4HEQTL2WPEUYKYKCDOHCDNIV4QHNJ7EL4J4NQ6VADP7SYHVRYZ7AW2'
): Promise<Record<string, ProtocolInfo>> {
  const server = new rpc.Server(RPC_URL);
  const pairCount = Number(await simulateReadOnlyCall(server, factoryId, 'all_pairs_length'));

  const result: Record<string, ProtocolInfo> = {};
  for (let i = 0; i < pairCount; i++) {
    if (i > 0) await sleep(75);
    const pair = (await simulateReadOnlyCall(server, factoryId, 'all_pairs', [
      nativeToScVal(i, { type: 'u32' })
    ])) as string;
    result[pair] = { protocolName: 'soroswap', category: 'amm_pair' };
  }
  return result;
}

/** Fetches every event a contract ever emitted matching a given topic[0],
 * paginating through stellar.expert's full (non-retention-limited) history -
 * the same source DefiLlama's own Blend and Sushi adapters use for exactly
 * this reason (Soroban RPC's getEvents only keeps ~4 months). */
async function fetchAllContractEvents(contractId: string, topic0: string): Promise<Array<{ bodyXdr: string }>> {
  const all: Array<{ bodyXdr: string }> = [];
  let cursor: string | undefined;
  for (let page = 0; page < 200; page++) {
    const url =
      `${STELLAR_EXPERT}/contract/${contractId}/events?order=asc&limit=200` + (cursor ? `&cursor=${cursor}` : '');
    const res = await fetch(url);
    if (!res.ok) throw new Error(`stellar.expert events fetch failed: HTTP ${res.status}`);
    const data = (await res.json()) as { _embedded?: { records?: Array<{ topics?: string[]; bodyXdr: string; paging_token: string }> } };
    const records = data._embedded?.records ?? [];
    if (records.length === 0) break;
    for (const r of records) {
      if (r.topics?.[0] === topic0) all.push({ bodyXdr: r.bodyXdr });
    }
    if (records.length < 200) break;
    cursor = records[records.length - 1].paging_token;
  }
  return all;
}

/**
 * Sushi Stellar's factory emits a `pool_created` event per pool; each
 * event's body is a map/struct whose `pool_address` field is the real pool
 * contract. Mirrors DefiLlama's own enumeration method:
 * https://github.com/DefiLlama/DefiLlama-Adapters/blob/main/projects/sushi-stellar/index.js
 */
export async function discoverSushiPools(
  factoryId = 'CD3KRKGDRVWPXVB3VXLUMQKMX6XZ6Q2H334IVZD4XXNAMKSRVQL5GLYF'
): Promise<Record<string, ProtocolInfo>> {
  const events = await fetchAllContractEvents(factoryId, 'pool_created');
  const result: Record<string, ProtocolInfo> = {};
  for (const event of events) {
    const val = xdr.ScVal.fromXdr(Buffer.from(event.bodyXdr, 'base64'));
    const native = scValToNative(val) as { pool_address?: string };
    if (native?.pool_address) {
      result[native.pool_address] = { protocolName: 'sushi_stellar', category: 'amm_pool' };
    }
  }
  return result;
}

/**
 * DeFindex vaults ARE deployed through a real on-chain factory - an earlier
 * pass over this codebase assumed otherwise and relied entirely on
 * DeFindex's own discover API (api.defindex.io/vault/discover), the same
 * source DefiLlama's adapter uses. That assumption was wrong and badly
 * undercounted: confirmed 2026-09-30 that the factory
 * (CDKFHFJIET3A73A2YN4KV7NSV32S6YGQMUFH3DNJXLBWL4SKEGVRNFKI, from PaltaLabs'
 * own public deployment manifest -
 * https://github.com/paltalabs/defindex/blob/main/public/mainnet.contracts.json)
 * has deployed 117 real vaults via total_vaults()/get_vault_by_index(), while
 * the discover API returns only 14 and the old static registry fallback here
 * covered another 9 (the "Neko" family) - 94 vaults, 80% of the whole
 * protocol, were completely missing. Several aren't even DeFindex-branded:
 * other teams ("SAFU Protection", "Blockroll Nest", "Prism USTRY" confirmed
 * in the factory's own create_defindex_vault call history) white-label
 * DeFindex as vault infrastructure, and none of those show up in DeFindex's
 * API either. Every instance's WASM hash matches the factory manifest's own
 * `defindex_vault` hash (ae3409a4...f8e1468b), confirming they're all
 * genuine factory-deployed vaults, not lookalikes.
 *
 * Paginated with the same per-call delay as discoverSoroswapPairs/
 * discoverAquariusPools for the same mainnet.sorobanrpc.com rate-limit
 * reason - this makes up to ~117 sequential calls (grows over time as more
 * vaults are created).
 */
export async function discoverDeFindexVaults(
  factoryId = 'CDKFHFJIET3A73A2YN4KV7NSV32S6YGQMUFH3DNJXLBWL4SKEGVRNFKI'
): Promise<Record<string, ProtocolInfo>> {
  const server = new rpc.Server(RPC_URL);
  const total = Number(await simulateReadOnlyCall(server, factoryId, 'total_vaults'));

  const result: Record<string, ProtocolInfo> = {};
  for (let i = 0; i < total; i++) {
    if (i > 0) await sleep(75);
    const addr = (await simulateReadOnlyCall(server, factoryId, 'get_vault_by_index', [
      nativeToScVal(i, { type: 'u32' })
    ])) as string;
    result[addr] = { protocolName: 'defindex', category: 'yield_savings' };
  }
  return result;
}

/**
 * Aquarius pools are NOT internal state of one shared AMM contract - an
 * earlier pass over this codebase assumed that (see the old comment in
 * registry.ts) and it was wrong, discovered 2026-09-29 by reading
 * DefiLlama's actual Aquarius adapter source rather than re-deriving it:
 * https://github.com/DefiLlama/DefiLlama-Adapters/blob/main/projects/aqua-network/index.js
 *
 * The registered "aquarius" address (CBQDHN...C6QUK) is Aquarius's
 * LiquidityPoolRouter, not a pool itself. Pools are individually deployed
 * contracts, exactly like Soroswap's pairs - the router just enumerates
 * them via get_tokens_sets_count + get_pools_for_tokens_range. Confirmed by
 * direct example: CA6PUJ...CJBE ("[Aquarius Pool]" per stellar.expert,
 * ~$3.9m balance, swapping every few seconds since 2024-07-29) had exactly
 * ONE event in our entire indexed history before this fix - picked up only
 * incidentally as an asset reference inside an aggregator's swap path, never
 * tracked as its own pool. This almost certainly means years of missed
 * direct-pool activity on our #2-by-TVL protocol - see
 * project_missed_contracts_backfill_list memory for the reindex list this
 * feeds.
 *
 * Paginated in batches (same rate-limit rationale as discoverSoroswapPairs)
 * since the real token-set count is unknown until the first call.
 */
export async function discoverAquariusPools(
  routerId = 'CBQDHNBFBZYE4MKPWBSJOPIYLW4SFSXAXUTSXJN76GNKYVYPCKWC6QUK',
  pageSize = 25
): Promise<Record<string, ProtocolInfo>> {
  const server = new rpc.Server(RPC_URL);
  const totalSets = Number(await simulateReadOnlyCall(server, routerId, 'get_tokens_sets_count'));

  const result: Record<string, ProtocolInfo> = {};
  for (let start = 0; start < totalSets; start += pageSize) {
    if (start > 0) await sleep(75);
    const end = Math.min(start + pageSize, totalSets);
    const batch = (await simulateReadOnlyCall(server, routerId, 'get_pools_for_tokens_range', [
      nativeToScVal(start, { type: 'u128' }),
      nativeToScVal(end, { type: 'u128' })
    ])) as Array<[unknown, Record<string, string>]>;
    for (const [, poolsMap] of batch) {
      for (const poolAddr of Object.values(poolsMap)) {
        result[poolAddr] = { protocolName: 'aquarius', category: 'amm_liquidity' };
      }
    }
  }
  return result;
}

/**
 * Runs every discovery source, merges the results, and never throws: one
 * source failing (a factory changing its interface, an API going down)
 * shouldn't stop the indexer from starting with whatever it already has in
 * the static registry. Call this once at startup - see indexer.ts.
 */
export async function discoverAllDynamicPools(): Promise<Record<string, ProtocolInfo>> {
  const sources: Array<[string, () => Promise<Record<string, ProtocolInfo>>]> = [
    ['Soroswap pairs', discoverSoroswapPairs],
    ['Sushi Stellar pools', discoverSushiPools],
    ['DeFindex vaults', discoverDeFindexVaults],
    ['Aquarius pools', discoverAquariusPools]
  ];

  const merged: Record<string, ProtocolInfo> = {};
  for (const [label, fn] of sources) {
    try {
      const found = await fn();
      Object.assign(merged, found);
      console.log(`🔎 Discovered ${Object.keys(found).length} ${label}`);
    } catch (err) {
      console.error(`Pool discovery failed for ${label}, continuing without it:`, err);
    }
  }
  return merged;
}
