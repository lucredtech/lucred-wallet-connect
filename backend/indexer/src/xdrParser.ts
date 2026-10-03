import { xdr, Address, scValToBigInt, TransactionBuilder, Networks } from '@stellar/stellar-sdk';
import { PROTOCOL_REGISTRY, ProtocolInfo } from './registry';

// ScVal variant names scValToBigInt() can convert; deliberately excludes
// scvTimepoint/scvDuration so a timestamp field isn't mistaken for an amount.
const NUMERIC_SCVAL_TYPES = new Set([
  'scvU32',
  'scvI32',
  'scvU64',
  'scvI64',
  'scvU128',
  'scvI128',
  'scvU256',
  'scvI256'
]);

export interface CreditEvent {
  ledgerSequence: number;
  transactionHash: string;
  blockCloseTime: string;
  protocolName: string;
  category: string;
  contractId: string;
  userAddress: string;
  eventType: string;
  amount: number;
  assetContractId?: string;
  assetCode?: string;
  // NOT a collateral ratio, despite the field's old name (renamed
  // 2026-09-23) - confirmed against Blend's real contract source
  // (blend-capital/blend-contracts, pool/src/pool/actions.rs): every
  // lending event's second emitted value is a b-token/d-token share
  // count (e.g. `supply_collateral` publishes `(request.amount,
  // b_tokens_minted)`), an internal pool-accounting unit for that single
  // reserve, not a ratio - a real collateral ratio needs the pool's
  // current per-reserve exchange rate plus the user's position across
  // every reserve in the pool, none of which a single event carries.
  // Scaled by 1e7 (Blend's b/d-token minting derives from a standard
  // 7-decimal `amount`, the same convention as this record's own
  // `amount` field), not the old, equally-unverified 1e4 "ratio" scaling.
  poolShareTokensAfter?: number;
  // The second real account address in the event, if one exists. Only
  // meaningful for two-party events - confirmed on a real Ondo USDY
  // `transfer`, which carries both a sender and a receiver as real
  // `account`-type addresses. `userAddress` is always the FIRST one found
  // (the sender, for a transfer); this is the second (the receiver). Every
  // other event shape seen so far (borrow, mint, supply, ...) only ever has
  // one real account address, so this stays undefined for those.
  counterpartyAddress?: string;
  // A swap is the one event shape here with TWO assets/amounts: what the
  // trader gave up (assetContractId/assetCode/amount, same fields every
  // other event uses) and what they got back. Populated only when a swap's
  // shape was confidently resolved (see resolveSwapFromData/
  // resolveSwapFromFields in xdrParser.ts) - for any other event type, or
  // an unrecognized swap shape, this stays undefined and amount/assetCode
  // keep their normal single-asset meaning.
  assetOutContractId?: string;
  assetOutCode?: string;
  amountOut?: number;
}

// Mainnet Stellar Asset Contract (SAC) addresses for the most common assets,
// derived via Asset.contractId(Networks.PUBLIC) and cross-checked against
// real mainnet event data seen this session (e.g. this exact XLM address
// showed up as the asset in real Blend `borrow` events). A raw C... address
// is still useful on its own - this is a readability nicety on top, not a
// requirement for the underlying fix.
const KNOWN_ASSET_CONTRACTS: Record<string, string> = {
  CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA: 'XLM',
  CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75: 'USDC',
  CDTKPWPLOURQA2SGTKTUQOWRCBZEORB4BWBOMJ3D3ZTQQSGE5F6JBQLV: 'EURC',
  CAUIKL3IYGMERDRUN6YSCLWVAKIFG5Q4YJHUKM4S4NJZQIA3BAS6OJPK: 'AQUA',
  // Added 2026-09-23: real assetCode resolution was only 27.6% on a large
  // sample of completed-segment data, with `swap` (39% of all events)
  // driving most of the gap - these are the highest-frequency unresolved
  // contracts from that sample, resolved via each contract's own real
  // on-chain symbol() call (not guessed), same pattern as the original four.
  CAANCS7TKC7IFWLRACKL4T4HMNMDUWSWNOL5EV244TVQCU3O7BM7N4VD: 'BLTB',
  CCUYL75XNUTAHFE3RZAN7NEFQWZ7OIRJZNN4KUXXPA34RAHVUGLTBGT5: 'BLTA',
  CB2J5FHCJJBQE5UPQ5FPZAWIEQD5KKP4GWLZZ3QT5EFVIT3FW5CI2OGK: 'BLTC',
  CDFZUVS5YNLXU7VENKOUDEOHCJGKQNVUBWD7KMN6E7ZROKPYPFLRUJFG: 'sUSD',
  CCKCKCPHYVXQD4NECBFJTFSCU2AMSJGCNG4O6K4JVRE2BLPR7WNDBQIQ: 'SHX',
  CBH4M45TQBLDPXOK6L7VYKMEJWFITBOL64BN3WDAIIDT4LNUTWTTOCKF: 'ETH',
  CAO7DDJNGMOYQPRYDY5JVZ5YEK4UQBSMGLAEWRCUOTRMDSBMGWSAATDZ: 'BTC',
  CDOFW7HNKLUZRLFZST4EW7V3AV4JI5IHMT6BPXXSY2IEFZ4NE5TWU2P4: 'yUSDC',
  CBLLEW7HD2RWATVSMLAGWM4G3WCHSHDJ25ALP4DI6LULV5TU35N2CIZA: 'XRF',
  CAESLMGW5LYTIEJI7FJHK6SFSWRELLNVX5Q4WR4UZEALMTRWQDBKDPAG: 'VELO',
  CDIKURWHYS4FFTR5KOQK6MBFZA2K3E26WGBQI6PXBYWZ4XIOPJHDFJKP: 'USDx',
  // Soroswap LP share tokens (not a currency - the "asset" is a claim on a
  // pool's two underlying tokens) - kept identifiable rather than left
  // unresolved, since these are real symbol() responses, not a guess.
  CASDSU3PBSFYJ4ZX7I2HHFDNZBBGKJFFXT6KOALA6DPMJBUTRG7XDLZB: 'BLTB-BLTA-SOROSWAP-LP',
  CBFAK6ULL5CRTSXVB6CCDXOZEIP3BB7YQEAIFJWYNWBI5TJBDR3LQCWO: 'BLTB-BLTC-SOROSWAP-LP',
  CAM7DY53G63XA4AJRS24Z6VFYAFSSF76C3RZ45BE5YU3FQS5255OOABP: 'native-USDC-SOROSWAP-LP',
  CDJDRGUCHANJDXALZVJ5IZVB76HX4MWCON5SHF4DE5HB64CBBR7W2ZCD: 'native-USDx-SOROSWAP-LP'
};

/**
 * A Galexie export object holds a LedgerCloseMetaBatch: a contiguous range
 * of ledgers (startSequence..endSequence), not a single ledger. Decode the
 * whole batch and walk every ledger inside it.
 *
 * See SEP-54 (Ledger Metadata Storage) for the on-disk struct, and
 * https://developers.stellar.org/docs/data/galexie/admin_guide/configuring
 * for how ledgers_per_file controls how many ledgers land in one object.
 *
 * NOTE ON SDK VERSION: this targets @stellar/stellar-sdk v17's generated XDR
 * bindings, which use discriminated-union classes with plain `.type` string
 * tags and readonly properties (e.g. `meta.type === 'v1'`, `meta.v1`). Older
 * v13-style bindings used method-call accessors (`.switch()`, `.v1()`)
 * instead — the two are not interchangeable.
 */
export function parseLedgerCloseMetaBatch(rawXdr: Buffer): CreditEvent[] {
  const events: CreditEvent[] = [];
  let batch: xdr.LedgerCloseMetaBatch;
  try {
    batch = xdr.LedgerCloseMetaBatch.fromXdr(rawXdr);
  } catch (err) {
    console.error('Failed to decode LedgerCloseMetaBatch XDR:', err);
    return events;
  }

  for (const closeMeta of batch.ledgerCloseMetas) {
    events.push(...parseSingleLedger(closeMeta));
  }
  return events;
}

// Two silent-data-loss bugs have already shipped from this parser assuming
// which XDR union arm real data uses instead of checking every arm that
// structurally exists (LedgerCloseMeta v2, then TransactionMeta v4 - see
// extractContractEvents below). The backfill's own ledger range (per the
// scoring design's "since 2024" window) spans multiple protocol versions,
// so rather than assume the *current* arm set stays complete for ledgers
// this parser hasn't been run against yet, log the first sighting of any
// combination of (LedgerCloseMeta arm, TransactionMeta arm) so an
// unexpected one shows up in the logs instead of silently returning zero
// events the way the last two bugs did. One-time (per combination, per
// process) so a live backfill doesn't get flooded.
const seenVersionCombinations = new Set<string>();
function logVersionSightingOnce(ledgerSequence: number, closeMetaType: string, txMetaType: string): void {
  const key = `${closeMetaType}/${txMetaType}`;
  if (seenVersionCombinations.has(key)) return;
  seenVersionCombinations.add(key);
  console.log(`ℹ️  First sighting of LedgerCloseMeta=${closeMetaType} / TransactionMeta=${txMetaType} at ledger ${ledgerSequence}`);
}

function parseSingleLedger(closeMeta: xdr.LedgerCloseMeta): CreditEvent[] {
  const events: CreditEvent[] = [];

  // LedgerCloseMeta is a v0/v1/v2 union - confirmed exhaustive by reading
  // the SDK's generated XDR schema directly (no v3+ arm exists at all, so
  // there is nothing beyond these three to account for). v0 is pre-Soroban,
  // dropped deliberately (structurally has no Soroban data to read - the
  // whole txProcessing/sorobanMeta chain this parser walks doesn't exist on
  // that arm). v1 and v2 both carry the txProcessing list we need, with
  // IDENTICAL shapes for every field this parser touches (ext,
  // ledgerHeader, txSet, txProcessing, upgradesProcessing, scpInfo,
  // totalByteSizeOfLiveSorobanState, evictedKeys) - v2 just drops a legacy
  // `unused` field neither arm's parsing here ever reads. Confirmed the
  // hard way that this distinction isn't cosmetic: real mainnet ledgers
  // switched from v1 to v2 at some point after Soroban's initial launch
  // (every ledger sampled from a live backfill by mid-2024 was already v2),
  // and dropping v2 here silently discarded 100% of current-era data - not
  // a sparse-activity false negative, an actual parsing gap. Confirmed real
  // Soroban activity was being replayed (stellar-core's own logs showed
  // nonzero soroban-phase components) while this indexer produced zero
  // output the whole time.
  if (closeMeta.type !== 'v1' && closeMeta.type !== 'v2') {
    // TypeScript itself proves this is always 'v0' here (LedgerCloseMeta's
    // discriminated union only has these three arms - the compiler rejects
    // even a defensive `!== 'v0'` check below this point as unreachable),
    // so there is no fourth arm to silently miss the way the last two bugs
    // did. Nothing further to log: v0 is the one arm already confirmed,
    // by direct schema inspection, to carry no Soroban data at all.
    return events;
  }
  const meta = closeMeta.type === 'v1' ? closeMeta.v1 : closeMeta.v2;
  const header = meta.ledgerHeader.header;
  const ledgerSequence = header.ledgerSeq;
  const blockCloseTime = new Date(Number(header.scpValue.closeTime) * 1000).toISOString();

  // Lazily resolves ONE transaction's own operation arguments, by real
  // transaction hash - see resolveOpArgsForTxHash below for why hash
  // matching (not tx-set position) is required, and why this has to stay
  // lazy (only paid for the transactions that actually need the fallback).
  let opArgsCache: Map<string, xdr.ScVal[] | null> | null = null;
  function getOpArgsForTxHash(txHash: string): xdr.ScVal[] | null {
    if (!opArgsCache) opArgsCache = new Map();
    if (!opArgsCache.has(txHash)) {
      opArgsCache.set(txHash, resolveOpArgsForTxHash(meta.txSet, txHash));
    }
    return opArgsCache.get(txHash) ?? null;
  }

  for (const txResultMeta of meta.txProcessing) {
    const txMeta = txResultMeta.txApplyProcessing;
    logVersionSightingOnce(ledgerSequence, closeMeta.type, txMeta.type);

    const contractEventsForTx = extractContractEvents(txMeta);
    if (contractEventsForTx.length === 0) continue;

    const txHash = txResultMeta.result.transactionHash.toString();

    // Group by contract first: most protocols emit one self-contained event
    // per action, but e.g. Phoenix DeFi Hub emits one event *per field* of a
    // single swap (separate `[swap, sender]`, `[swap, offer_amount]`, ...
    // events sharing no data of their own) - those need correlating across
    // several events before they mean anything, so they can't be parsed one
    // event at a time the way every other protocol here can.
    const eventsByContract = new Map<string, xdr.ContractEvent[]>();
    for (const event of contractEventsForTx) {
      if (!event.contractId) continue;
      const contractId = Address.contract(event.contractId.toBytes()).toString();
      if (!PROTOCOL_REGISTRY[contractId]) continue; // fast filter out untracked noise
      if (!eventsByContract.has(contractId)) eventsByContract.set(contractId, []);
      eventsByContract.get(contractId)!.push(event);
    }

    for (const [contractId, contractEvents] of eventsByContract) {
      const protocolInfo = PROTOCOL_REGISTRY[contractId];
      const { results, failedEvents } = parseContractEventGroupInternal(
        contractEvents, contractId, protocolInfo, ledgerSequence, txHash, blockCloseTime
      );
      events.push(...results);

      // Operation-args fallback, added 2026-10-01 - brings the live indexer
      // up to the same recovery the backfill scripts already had (see
      // project_operation_args_identity_gap memory): some events (confirmed
      // on real Aquarius deposit_liquidity/withdraw_liquidity data) carry NO
      // account-type address anywhere in their own topics/data - the real
      // actor is only an explicit argument on the enclosing operation's own
      // invocation, which this generic event-only parser structurally can't
      // see on its own. The data needed is already in `meta.txSet` (same
      // ledger, no extra fetch) - this was backfill-only until now because
      // nobody had wired tx-set correlation into the live path yet.
      if (failedEvents.length > 0) {
        const opArgs = getOpArgsForTxHash(txHash);
        if (opArgs) {
          const foundAddress = findAnyAddressInArgs(opArgs);
          if (foundAddress) {
            for (const failedEvent of failedEvents) {
              const recovered = parseContractEvent(
                injectSyntheticAddressTopic(failedEvent, foundAddress),
                contractId, protocolInfo, ledgerSequence, txHash, blockCloseTime
              );
              if (recovered) events.push(recovered);
            }
          }
        }
      }
    }
  }

  return events;
}

/**
 * Finds the transaction in a ledger's txSet matching a specific real
 * transaction hash, then returns its ONE Soroban operation's own call
 * arguments (confirmed on real mainnet data, 2026-10-01: every
 * invokeHostFunction-containing transaction sampled had EXACTLY one
 * operation - this is a real protocol-level restriction on Soroban
 * transactions, not an assumption). Matching by HASH, not by position in
 * txSet - confirmed necessary on real data: a naive "txSet order matches
 * txProcessing order" assumption was WRONG for ~9% of transactions in a
 * real sample (3 of 32), which would have silently attributed the wrong
 * operation's arguments to an event - a correctness bug worse than not
 * attempting the fallback at all. Computing each candidate's real hash via
 * reconstructing it through TransactionBuilder.fromXDR().hash() and
 * comparing against the known target hash is the only verified-reliable
 * method found - confirmed 154/154 real matches in the same sample where
 * position-based matching got 3 wrong.
 */
function resolveOpArgsForTxHash(txSet: xdr.GeneralizedTransactionSet, txHash: string): xdr.ScVal[] | null {
  if (txSet.type !== 'v1TxSet') return null; // pre-CAP-63 ledgers have no phases to search
  for (const phase of txSet.v1TxSet.phases) {
    const components = phase.type === 'v0Components' ? phase.v0Components : [];
    for (const comp of components) {
      const txs = comp.txsMaybeDiscountedFee ? comp.txsMaybeDiscountedFee.txs : [];
      for (const txEnv of txs) {
        const tx =
          txEnv.type === 'envelopeTypeTx'
            ? txEnv.v1.tx
            : txEnv.type === 'envelopeTypeTxFeeBump'
              ? txEnv.feeBump.tx.innerTx.v1.tx
              : null;
        if (!tx) continue;
        let computedHash: string;
        try {
          computedHash = Buffer.from(
            TransactionBuilder.fromXDR(txEnv.toXDR('base64'), Networks.PUBLIC).hash()
          ).toString('hex');
        } catch {
          continue;
        }
        if (computedHash !== txHash) continue;
        for (const op of tx.operations) {
          if (op.body.type !== 'invokeHostFunction') continue;
          const hostFn = op.body.invokeHostFunctionOp.hostFunction;
          if (hostFn.type !== 'hostFunctionTypeInvokeContract') return null;
          return hostFn.invokeContract.args;
        }
        return null;
      }
    }
  }
  return null;
}

/**
 * Permissive address scan for operation-level arguments ONLY (never for
 * event topics/data - findAccountAddresses above stays strict there,
 * deliberately, since an asset/pool contract address is common and
 * genuinely not a user). An address passed as an explicit argument to the
 * operation the end user themselves submitted is a much stronger "this IS
 * the caller" signal - confirmed on real Aquarius data (an `account`-type
 * depositor argument) - and per [[project_smart_account_identity_resolution]]
 * Pattern 2, the real caller can legitimately BE a `contract`-type address
 * (a smart-wallet contract with no underlying G-keypair at all, e.g. a
 * pure WebAuthn/passkey account) - rejecting that type here the way
 * findAccountAddresses does would silently drop exactly the identity this
 * fallback exists to recover. Takes the first address-typed argument found,
 * since both confirmed real cases (Aquarius's G-address depositor arg,
 * Pattern 2's smart-wallet contract arg) had their identity as an early,
 * unambiguous argument - not verified against a real mainnet Pattern-2
 * example specifically (none confirmed yet, only a testnet one), so this
 * path should be monitored rather than assumed perfect.
 */
function findAnyAddressInArgs(args: xdr.ScVal[]): string | null {
  for (const arg of args) {
    if (arg.type !== 'scvAddress') continue;
    try {
      return Address.fromScVal(arg).toString();
    } catch {
      /* try the next arg, if any */
    }
  }
  return null;
}

/** Appends a synthetic address topic to a failed event's existing topics,
 * then hands it back to the SAME real parseContractEvent - reuses every
 * bit of its existing, tested amount/eventType extraction instead of
 * reimplementing it, exactly like the backfill scripts' own op-args
 * fallback (see resolve-hashes-and-params.js's findGAddressInParams). */
function injectSyntheticAddressTopic(event: xdr.ContractEvent, address: string): xdr.ContractEvent {
  const topics = event.body.v0.topics;
  const data = event.body.v0.data;
  const syntheticTopic = new Address(address).toScVal();
  return { body: { v0: { topics: [...topics, syntheticTopic], data } } } as xdr.ContractEvent;
}

/**
 * Pulls the raw ContractEvent list out of a TransactionMeta, whichever arm
 * it is. v3 nests them at `v3.sorobanMeta.events`.
 *
 * v4 (CAP-67) is now what real current-era mainnet transactions actually
 * use (confirmed directly: a real invoke_host_function transaction,
 * independently verified via Horizon, decoded with txApplyProcessing.type
 * === 'v4' in a live raw export) - the "not yet seen on real mainnet data"
 * assumption this code originally shipped with was wrong, and so was the
 * assumption that followed from it. v4's top-level `events:
 * TransactionEvent[]` is NOT where a contract's own published events end
 * up - on the real transaction used to confirm this, it held exactly 2
 * entries, both stage `before_all_txs`/`after_all_txs` (classic fee
 * bookkeeping, contractId = the XLM SAC), regardless of the transaction
 * invoking real application contracts. The actual application-level events
 * - the ones this indexer exists to read (a Soroswap `swap`, a Blend
 * `borrow`, ...) - are in `v4.diagnosticEvents` instead: on that same real
 * transaction, 47 of them, including real invocations of four different
 * contract addresses with inSuccessfulContractCall = true. This mirrors v3
 * DiagnosticEvent's own shape (`{event, inSuccessfulContractCall}`), so
 * filtering to successful-contract-call diagnostic events and unwrapping
 * `.event` gives the same ContractEvent list v3's sorobanMeta.events
 * always did - `inSuccessfulContractCall` excludes the diagnostic-only
 * entries (failed calls, host-function-argument dumps) that never
 * represent a real, applied CreditEvent.
 *
 * TransactionMeta's full arm set, confirmed exhaustive by reading the SDK's
 * generated XDR schema directly rather than assumed: `operations` (the
 * original, unversioned format - `.type` reads as `'operations'`, not
 * `'v0'`), `v1`, `v2`, `v3`, `v4`. The backfill's ledger range predates
 * Soroban for at least part of its span (per the scoring design's "since
 * 2024" window), so this needs a real answer for the pre-Soroban arms, not
 * just the ones a live backfill happened to surface first - same mistake
 * that shipped twice already with LedgerCloseMeta v2 and TransactionMeta
 * v4. Checked directly: `operations`/`v1`/`v2` are structurally
 * pre-Soroban - `operations` is a bare `OperationMeta[]`, `v1` is
 * `{txChanges, operations}`, `v2` is `{txChangesBefore, operations,
 * txChangesAfter}` - none of the three has a `sorobanMeta`, `events`, or
 * `diagnosticEvents` field anywhere in their schema, so there is no
 * `ContractEvent` these arms could ever carry, by construction, not by
 * absence-of-observed-data. Returning [] for them is therefore already
 * complete, not a placeholder - but logVersionSightingOnce (called on every
 * transaction, above) still records the first ledger each one is actually
 * seen on, so that claim stays checked against the real backfill rather
 * than resting on the XDR schema alone.
 */
function extractContractEvents(txMeta: xdr.TransactionMeta): xdr.ContractEvent[] {
  if (txMeta.type === 'v3') {
    return txMeta.v3.sorobanMeta?.events ?? [];
  }
  if (txMeta.type === 'v4') {
    return (txMeta.v4.diagnosticEvents ?? [])
      .filter((diagnosticEvent) => diagnosticEvent.inSuccessfulContractCall)
      .map((diagnosticEvent) => diagnosticEvent.event);
  }
  // 'operations' | 'v1' | 'v2': pre-Soroban, structurally no ContractEvent to read.
  return [];
}

/** A field-fragment event: topics are exactly [event_name, field_name], both
 * strings, and the event's whole payload is that one field's value - e.g.
 * Phoenix's `[swap, sender] -> address` / `[swap, offer_amount] -> i128`. */
function asFieldFragment(event: xdr.ContractEvent): { eventType: string; fieldName: string; value: xdr.ScVal } | null {
  const topics = event.body.v0.topics;
  if (topics.length !== 2) return null;
  const eventType = topicText(topics[0]);
  const fieldName = topicText(topics[1]);
  if (eventType === null || fieldName === null) return null;
  // A real field name is an identifier (`user`, `offer_amount`, `reward_token`,
  // and Phoenix's hyphenated `token_a-amount` - hyphens MUST stay allowed).
  // Free-text "topics" are log lines, not fields - e.g. Phoenix's stake
  // contract migration logs `["Stake: Migration: ", "Start of migration for
  // user: "]` (data = the user address), which otherwise assembled into junk
  // rows with eventType "Stake: Migration: " / "Stake" and amount 0.
  if (!/^[A-Za-z0-9_-]+$/.test(fieldName)) return null;
  const value = event.body.v0.data;
  // A genuine field-fragment's value IS the one field - always a scalar
  // (an address, a number - confirmed on every real Phoenix fragment, e.g.
  // `[swap, sender] -> address`, `[swap, offer_amount] -> i128`), never a
  // vec/map. A vec/map value here means this is really ONE complete,
  // self-contained event that just happens to also have 2 text topics -
  // confirmed on real Soroswap Router `swap` events: topics are
  // ["SoroswapRouter", "swap"] (a contract-name label, then the real event
  // name), but the data is a full {amounts, path, to} map, not one field's
  // value. Let it fall through to the normal single-event path instead,
  // where that map gets unwrapped correctly and the real event name
  // ("swap") gets found regardless of which topic it's in.
  if (value.type === 'scvVec' || value.type === 'scvMap') return null;
  return { eventType, fieldName, value };
}

/** scvSymbol and scvString both show up as topic labels across protocols
 * (e.g. Aquarius/Peridot use symbols, Phoenix uses plain strings) - this
 * reads either into a JS string, or returns null for anything else. */
function topicText(scVal: xdr.ScVal): string | null {
  if (scVal.type === 'scvSymbol') return scVal.sym.toString();
  if (scVal.type === 'scvString') return scVal.str.toString();
  return null;
}

/**
 * Unwraps one level of vec/map from each input ScVal, so a value like
 * Stellar DeFi Hub's data map `{amount, deposit_id, owner: <address>, ...}`
 * becomes individually searchable entries instead of one opaque scvMap that
 * findAccountAddresses/pickAmount would otherwise skip outright (neither is a
 * scvAddress or numeric type on its own). Non-vec/map values pass through
 * unchanged. Only one level deep - real cases found so far never nest
 * further, and going deeper risks pulling in unrelated nested data.
 */
function flattenOneLevel(scVals: xdr.ScVal[]): { values: xdr.ScVal[]; named: [string, xdr.ScVal][] } {
  const values: xdr.ScVal[] = [];
  const named: [string, xdr.ScVal][] = [];
  for (const scVal of scVals) {
    if (scVal.type === 'scvVec') {
      values.push(...(scVal.vec ?? []));
    } else if (scVal.type === 'scvMap') {
      for (const entry of scVal.map ?? []) {
        values.push(entry.val);
        if (entry.key.type === 'scvSymbol') named.push([entry.key.sym.toString(), entry.val]);
      }
    } else {
      values.push(scVal);
    }
  }
  return { values, named };
}

/**
 * Finds every real *person* among a set of address-typed candidates (event
 * topics, or field values for a fragment group), in the order encountered -
 * not just "the first address, whatever it points to". This matters because
 * plenty of events carry an address that isn't a user at all - confirmed on
 * real mainnet data: Blend's `borrow` event's only topic address is the
 * *borrowed asset's own contract* (the reserve token), with no user address
 * anywhere in the event; the actual borrower is the transaction's source
 * account, which isn't in scope here (xdrParser.ts only reads
 * sorobanMeta.events - see README's "known gap" note on Blend borrow/repay
 * attribution). Similarly, a Phoenix swap's "sender" can be Phoenix's own
 * multihop router rather than a person, when the swap was routed rather than
 * sent directly to the pool.
 *
 * So: accept only `account`/`muxedAccount` addresses (real Stellar
 * accounts) as "a user" and reject `contract`/`liquidityPool`/
 * `claimableBalance` addresses outright. Most events have exactly one -
 * confirmed on a real Ondo USDY `transfer` that some have two (sender AND
 * receiver, both real accounts) - callers take `[0]` as userAddress and
 * `[1]` (if present) as CreditEvent.counterpartyAddress.
 */
function findAccountAddresses(scVals: xdr.ScVal[]): string[] {
  const addresses: string[] = [];
  for (const scVal of scVals) {
    if (scVal.type !== 'scvAddress') continue;
    try {
      const address = Address.fromScVal(scVal);
      if (address.type === 'account' || address.type === 'muxedAccount') {
        addresses.push(address.toString());
      }
    } catch {
      /* try the next address-typed candidate, if any */
    }
  }
  return addresses;
}

/**
 * Finds which asset an amount is denominated in - the mirror image of
 * findAccountAddresses. Real events carry both: e.g. Blend's `borrow` topics are
 * [event_name, asset_contract, user_account] - the SAME scan that skips the
 * asset to find the user (because it resolves to `contract`, not `account`)
 * would otherwise just discard that address entirely. Returns the first
 * `contract`-type address found, since for every single-asset event seen
 * so far (Blend borrow/supply_collateral/withdraw_collateral, Peridot
 * mint/redeem, Stellar DeFi Hub deposit/withdraw) there's exactly one.
 * KNOWN CAVEAT: multi-asset events (Aquarius's swap topics carry BOTH
 * token_a and token_b; Soroswap's pair data carries both sides too) have
 * more than one contract-type address, and this reports only the first one
 * encountered - which asset that is depends on protocol-specific ordering,
 * not something verified generically. Treat assetContractId as reliable for
 * single-asset lending/vault events and best-effort for AMM swaps.
 *
 * `excludeContractId` skips the emitting contract's own address - confirmed
 * on real data that this matters specifically for `fn_call` (a real on-chain
 * event name many contracts emit as a generic diagnostic, not something this
 * project invents), which has no reliable asset shape at all: a large sample
 * of real `fn_call`-derived assetContractId values turned out to just equal
 * the event's own contractId, i.e. this scan was reporting "the asset is the
 * contract itself" - never a real answer for any event shape actually seen
 * (borrow, swap, supply_collateral, ...). A contract can't legitimately be
 * its own traded/deposited asset, so this exclusion is safe generically, not
 * just for fn_call.
 */
function findAssetContract(scVals: xdr.ScVal[], excludeContractId?: string): string | null {
  for (const scVal of scVals) {
    if (scVal.type !== 'scvAddress') continue;
    try {
      const address = Address.fromScVal(scVal);
      if (address.type === 'contract') {
        const candidate = address.toString();
        if (candidate === excludeContractId) continue;
        return candidate;
      }
    } catch {
      /* try the next address-typed candidate, if any */
    }
  }
  return null;
}

function resolveAsset(
  scVals: xdr.ScVal[],
  protocolInfo: ProtocolInfo,
  excludeContractId?: string
): { assetContractId?: string; assetCode?: string } {
  const assetContractId = findAssetContract(scVals, excludeContractId);
  if (assetContractId) {
    const assetCode = KNOWN_ASSET_CONTRACTS[assetContractId];
    return { assetContractId, ...(assetCode && { assetCode }) };
  }
  // Nothing in the event itself (e.g. Peridot's mint/redeem, Stellar DeFi
  // Hub's DEPOSIT/WITHDRAW - confirmed on real data neither carries an
  // asset address at all): fall back to the contract-level default, if the
  // registry has one, for per-asset-vault protocols.
  if (protocolInfo.defaultAssetCode) {
    return { assetCode: protocolInfo.defaultAssetCode };
  }
  return {};
}

interface SwapResolution {
  assetContractId: string;
  assetCode?: string;
  amount: number;
  assetOutContractId: string;
  assetOutCode?: string;
  amountOut: number;
}

function isAddressScVal(v: xdr.ScVal): boolean {
  return v.type === 'scvAddress';
}

function buildSwapResolution(
  tokenIn: xdr.ScVal,
  amountIn: xdr.ScVal,
  tokenOut: xdr.ScVal,
  amountOut: xdr.ScVal
): SwapResolution | null {
  if (!isAddressScVal(tokenIn) || !isAddressScVal(tokenOut) || !NUMERIC_SCVAL_TYPES.has(amountIn.type) || !NUMERIC_SCVAL_TYPES.has(amountOut.type)) {
    return null;
  }
  try {
    const assetContractId = Address.fromScVal(tokenIn).toString();
    const assetOutContractId = Address.fromScVal(tokenOut).toString();
    return {
      assetContractId,
      ...(KNOWN_ASSET_CONTRACTS[assetContractId] && { assetCode: KNOWN_ASSET_CONTRACTS[assetContractId] }),
      amount: Number(scValToBigInt(amountIn)) / 10 ** 7,
      assetOutContractId,
      ...(KNOWN_ASSET_CONTRACTS[assetOutContractId] && { assetOutCode: KNOWN_ASSET_CONTRACTS[assetOutContractId] }),
      amountOut: Number(scValToBigInt(amountOut)) / 10 ** 7
    };
  } catch {
    return null;
  }
}

/**
 * A swap event genuinely involves TWO assets and TWO amounts - what the
 * trader gave up, what they received - unlike every other event type
 * here, which has exactly one of each. The generic single-asset pickers
 * above (findAssetContract, pickAmount) can't tell which side is which for
 * a swap, and are confirmed wrong or lossy on real mainnet events:
 *
 * - Aquarius: sampled 50 real swaps from CBQDHNBFBZYE4MKPWBSJOPIYLW4SFSXAXUTSXJN76GNKYVYPCKWC6QUK -
 *   topics[1]'s token *pair* is NOT reliably [tokenIn, tokenOut]: 20/50
 *   (40%) had it reversed, so findAssetContract's "first contract address
 *   wins" picks the wrong side nearly half the time. The event's own DATA
 *   vec is trustworthy instead: always [pool, tokenIn, tokenOut, amountIn,
 *   amountOut], in that fixed order, confirmed across all 50 samples.
 * - Soroswap Router: emits its own `swap` event directly from
 *   CAG5LRYQ5JVEUI5TEID72EYOVX44TTUJT5BQR2J6J77FH65PCCFAJDDH (real mainnet
 *   data - this corrects the earlier assumption in registry.ts that only
 *   the individual pair contracts emit trade events) as a {amounts, path,
 *   to} map, where `amounts`/`path` are PARALLEL arrays describing a
 *   (possibly multi-hop) route: path[0]/amounts[0] is what the trader put
 *   in, path[last]/amounts[last] is what they received. Every real event
 *   sampled was a single 2-token hop, but the parallel-array shape
 *   supports more, hence taking first/last rather than assuming length 2.
 *
 * Tries both known shapes against the raw, unflattened data payload;
 * returns null (caller falls back to the generic single-asset logic) for
 * anything else.
 */
function resolveSwapFromData(dataVal: xdr.ScVal): SwapResolution | null {
  if (dataVal.type === 'scvVec') {
    const items = dataVal.vec ?? [];
    if (items.length === 5) {
      const [, tokenIn, tokenOut, amountIn, amountOut] = items;
      const resolved = buildSwapResolution(tokenIn, amountIn, tokenOut, amountOut);
      if (resolved) return resolved;
    }
  }
  if (dataVal.type === 'scvMap') {
    const named = new Map<string, xdr.ScVal>();
    for (const entry of dataVal.map ?? []) {
      if (entry.key.type === 'scvSymbol') named.set(entry.key.sym.toString(), entry.val);
    }
    const amounts = named.get('amounts');
    const path = named.get('path');
    if (amounts?.type === 'scvVec' && path?.type === 'scvVec') {
      const amountItems = amounts.vec ?? [];
      const pathItems = path.vec ?? [];
      if (amountItems.length === pathItems.length && amountItems.length >= 2) {
        const resolved = buildSwapResolution(
          pathItems[0],
          amountItems[0],
          pathItems[pathItems.length - 1],
          amountItems[amountItems.length - 1]
        );
        if (resolved) return resolved;
      }
    }
  }
  return null;
}

/**
 * Phoenix's swap fragments use named fields instead of positional data -
 * confirmed against real mainnet fragment groups (see registry.ts's
 * Phoenix DeFi Hub entry): `sell_token`/`offer_amount` for what the trader
 * gave up, `buy_token`/`return_amount` for what they actually received.
 * (There's also an `actual received amount` field - note the spaces, not
 * an underscore - but it duplicates offer_amount's value on every sample
 * checked, not return_amount's; return_amount is the one that matches the
 * buy_token side.)
 */
function resolveSwapFromFields(fields: Map<string, xdr.ScVal>): SwapResolution | null {
  const tokenIn = fields.get('sell_token');
  const amountIn = fields.get('offer_amount');
  const tokenOut = fields.get('buy_token');
  const amountOut = fields.get('return_amount');
  if (!tokenIn || !amountIn || !tokenOut || !amountOut) return null;
  return buildSwapResolution(tokenIn, amountIn, tokenOut, amountOut);
}

// Alula's core lending events each wrap their real amount inside a
// `<verb>_result` map keyed by a specific field - confirmed against real
// mainnet events for all 7 types (contract
// CBP76I2FRMUKYKIYYBKN3DH7TSWMFAJF2WTDC7Q2OHQFBIVWP7CAAI5Q).
const ALULA_RESULT_FIELDS: Record<string, { resultKey: string; amountField: string }> = {
  deposit_event: { resultKey: 'deposit_result', amountField: 'deposited' },
  borrow_event: { resultKey: 'borrow_result', amountField: 'borrower_to_receive' },
  withdraw_event: { resultKey: 'withdraw_result', amountField: 'withdrawer_to_receive' },
  repay_event: { resultKey: 'repay_result', amountField: 'debt_repaid' },
  liquidate_event: { resultKey: 'liquidation_result', amountField: 'debt_repaid' },
  add_collateral_event: { resultKey: 'add_collateral_result', amountField: 'added_collateral' },
  remove_collateral_event: { resultKey: 'remove_collateral_result', amountField: 'collateral_decrease' }
};

/**
 * Alula's core lending events (deposit/borrow/withdraw/repay/liquidate/
 * add_collateral/remove_collateral) all carry their real amount TWO map
 * levels deep - e.g. a real `deposit_event`'s data is
 * `{deposit_result: {deposited: i128, j_tokens_to_issue: i128,
 * operation_fees: {...}}, obligation: {...}}` - past what the generic
 * flattenOneLevel/pickAmount (one level, "first numeric value found")
 * reaches. Going a level deeper generically was deliberately avoided
 * elsewhere in this file (risk of pulling in unrelated nested data); here
 * it's scoped tightly instead, since each event type has one predictable
 * `<verb>_result` map with a specific named field holding the real amount.
 * `repay_event`'s result map also has an `amount_to_send_back` field that
 * sorts alphabetically ahead of `debt_repaid` (Soroban maps serialize
 * sorted by key) - relying on "first numeric value", the way the generic
 * fallback does, would have silently picked that leftover-refund field
 * instead of the actual repay amount. That's confirmed on real data, not
 * assumed, which is why this is explicit per event type rather than a
 * second generic pass.
 */
function resolveAlulaAmount(dataVal: xdr.ScVal, eventType: string): number | null {
  const config = ALULA_RESULT_FIELDS[eventType];
  if (!config || dataVal.type !== 'scvMap') return null;
  const outer = new Map<string, xdr.ScVal>();
  for (const entry of dataVal.map ?? []) {
    if (entry.key.type === 'scvSymbol') outer.set(entry.key.sym.toString(), entry.val);
  }
  const resultMap = outer.get(config.resultKey);
  if (!resultMap || resultMap.type !== 'scvMap') return null;
  for (const entry of resultMap.map ?? []) {
    if (entry.key.type === 'scvSymbol' && entry.key.sym.toString() === config.amountField) {
      if (!NUMERIC_SCVAL_TYPES.has(entry.val.type)) return null;
      try {
        return Number(scValToBigInt(entry.val)) / 10 ** 7;
      } catch {
        return null;
      }
    }
  }
  return null;
}

/**
 * Alula's `liquidate_event` is the one Alula event with two assets in it -
 * the collateral seized and the debt repaid - confirmed on the one real
 * liquidation seen so far: its topics carry both asset addresses,
 * collateral first, then debt. `resolveAlulaAmount`'s `debt_repaid` figure
 * for this event is denominated in the debt asset (the second one), so the
 * generic resolveAsset's "first contract-type address wins" would report
 * the wrong side here - same class of bug as the swap disambiguation
 * above, just for one specific event type on one protocol instead of a
 * whole event category. Takes the LAST contract-type address instead of
 * the first, only for this one case.
 */
function findLastAssetContract(scVals: xdr.ScVal[], excludeContractId?: string): string | null {
  let last: string | null = null;
  for (const scVal of scVals) {
    if (scVal.type !== 'scvAddress') continue;
    try {
      const address = Address.fromScVal(scVal);
      if (address.type === 'contract') {
        const candidate = address.toString();
        if (candidate !== excludeContractId) last = candidate;
      }
    } catch {
      /* try the next address-typed candidate, if any */
    }
  }
  return last;
}

function resolveAlulaAsset(
  values: xdr.ScVal[],
  eventType: string,
  excludeContractId?: string
): { assetContractId?: string; assetCode?: string } | null {
  if (eventType !== 'liquidate_event') return null;
  const assetContractId = findLastAssetContract(values, excludeContractId);
  if (!assetContractId) return null;
  const assetCode = KNOWN_ASSET_CONTRACTS[assetContractId];
  return { assetContractId, ...(assetCode && { assetCode }) };
}

/**
 * Normal's `mint`/`redeem` events carry a real amount in their data vec,
 * but the generic pickAmount heuristic gets it wrong two separate ways -
 * confirmed on all 33 real `mint` events and the one real `redeem` event
 * found on the factory contract (CD5LOWLRQXTG5ZTNU4NA4NNLGGKNRJNRX45PVINVY7VCTOFQAAOYLTF5):
 * `mint`'s data is `[reserved, amount, timestamp]` where `reserved` was
 * "0" in every single sample - "first numeric value found" picks that
 * always-zero field, not the real amount at index 1. `redeem`'s data has
 * no such leading field - just `[amount, timestamp]`. Both also carry
 * their timestamp as a plain `scvU64` rather than `scvTimepoint` (which
 * NUMERIC_SCVAL_TYPES deliberately excludes for exactly this reason) - it
 * slips through the generic numeric-type filter and would otherwise land
 * in the unrelated `poolShareTokensAfter` slot as a second bogus number.
 */
function resolveNormalAmount(dataVal: xdr.ScVal, eventType: string): number | null {
  if (dataVal.type !== 'scvVec') return null;
  const items = dataVal.vec ?? [];
  const index = eventType === 'mint' ? 1 : eventType === 'redeem' ? 0 : null;
  if (index === null || items.length <= index) return null;
  const amountVal = items[index];
  if (!NUMERIC_SCVAL_TYPES.has(amountVal.type)) return null;
  try {
    return Number(scValToBigInt(amountVal)) / 10 ** 7;
  } catch {
    return null;
  }
}

/**
 * Normal identifies which wrapped asset a mint/redeem is for with a plain
 * ticker symbol topic (e.g. `BTC`, `XRP`, confirmed on real events)
 * alongside the pair contract's own address - not a Stellar Asset
 * Contract, so KNOWN_ASSET_CONTRACTS can't resolve a code from that
 * address the way it does elsewhere. Read the ticker straight off the
 * topic instead of leaving assetCode empty.
 */
function resolveNormalAsset(
  values: xdr.ScVal[],
  remainingTopics: xdr.ScVal[],
  excludeContractId?: string
): { assetContractId?: string; assetCode?: string } | null {
  const assetContractId = findAssetContract(values, excludeContractId);
  if (!assetContractId) return null;
  const tickerTopic = remainingTopics.find((t) => t.type === 'scvSymbol');
  const assetCode = tickerTopic && tickerTopic.type === 'scvSymbol' ? tickerTopic.sym.toString() : undefined;
  return { assetContractId, ...(assetCode && { assetCode }) };
}

/**
 * DeFindex's deposit/withdraw events carry an explicitly-named, correctly-
 * scoped per-action share count in their own data map - `df_tokens_minted`
 * on deposit, `df_tokens_burned` on withdraw - confirmed on real mainnet
 * events (2026-09-30): one real withdraw had `amounts_withdrawn`=100050235
 * vs `df_tokens_burned`=99998710, a genuinely different number reflecting a
 * share price above 1.0, not a duplicate.
 *
 * The generic pickAmount heuristic gets BOTH halves wrong for DeFindex:
 * `amounts`/`amounts_withdrawn` is itself a one-element vec, and whatever
 * numeric value pickAmount happens to find second in the flattened map (in
 * practice `total_supply_before`, confirmed by direct query) lands in
 * poolShareTokensAfter - the opposite of a per-position field, since
 * `total_supply_before` is vault-wide and grows monotonically across
 * DIFFERENT wallets' deposits on the same vault, never resetting per user.
 */
function resolveDeFindexAmountAndShares(
  dataVal: xdr.ScVal,
  eventType: string
): { amount: number; poolShareTokensAfter?: number } | null {
  if (dataVal.type !== 'scvMap') return null;
  const config =
    eventType === 'deposit'
      ? { amountsKey: 'amounts', sharesKey: 'df_tokens_minted' }
      : eventType === 'withdraw'
        ? { amountsKey: 'amounts_withdrawn', sharesKey: 'df_tokens_burned' }
        : null;
  if (!config) return null;

  const outer = new Map<string, xdr.ScVal>();
  for (const entry of dataVal.map ?? []) {
    if (entry.key.type === 'scvSymbol') outer.set(entry.key.sym.toString(), entry.val);
  }

  const amountsVal = outer.get(config.amountsKey);
  if (!amountsVal || amountsVal.type !== 'scvVec' || (amountsVal.vec ?? []).length === 0) return null;
  const firstAmount = amountsVal.vec![0];
  if (!NUMERIC_SCVAL_TYPES.has(firstAmount.type)) return null;

  let amount: number;
  try {
    amount = Number(scValToBigInt(firstAmount)) / 10 ** 7;
  } catch {
    return null;
  }

  const sharesVal = outer.get(config.sharesKey);
  let poolShareTokensAfter: number | undefined;
  if (sharesVal && NUMERIC_SCVAL_TYPES.has(sharesVal.type)) {
    try {
      poolShareTokensAfter = Number(scValToBigInt(sharesVal)) / 10 ** 7;
    } catch {
      poolShareTokensAfter = undefined;
    }
  }

  return { amount, poolShareTokensAfter };
}

/**
 * Fundable's `claim`/`distribution_created` events both carry the
 * distribution_id as a second numeric TOPIC (not data) - confirmed on real
 * mainnet events (contract CD6G3UTDV4XPDMVNYTPQ6UCL7FWSYG5LXYAZXBDDSKY5YOQ6HLDBPYRY,
 * 2026-10-01): a real `claim` event's topics are [claim, distribution_id]
 * with data = [claimant_address, amount] (2 elements); `distribution_created`'s
 * topics are [distribution_created, distribution_id] with data =
 * [admin_address, asset_contract, amount, reserved(always "0" so far)] (4
 * elements). The generic pickAmount heuristic flattens topics and data
 * together, so distribution_id (a small integer, unrelated to any amount)
 * becomes the FIRST numeric value found and gets wrongly picked as `amount`
 * - confirmed this shifts the real amount into poolShareTokensAfter (claim)
 * or drops it entirely (distribution_created, which has 3 numeric
 * candidates once flattened). Reading a fixed index directly off the raw,
 * unflattened dataVal (never mixed with topics) avoids this for both types.
 */
function resolveFundableAmount(dataVal: xdr.ScVal, eventType: string): number | null {
  if (dataVal.type !== 'scvVec') return null;
  const items = dataVal.vec ?? [];
  const index = eventType === 'claim' ? 1 : eventType === 'distribution_created' ? 2 : null;
  if (index === null || items.length <= index) return null;
  const amountVal = items[index];
  if (!NUMERIC_SCVAL_TYPES.has(amountVal.type)) return null;
  try {
    return Number(scValToBigInt(amountVal)) / 10 ** 7;
  } catch {
    return null;
  }
}

/**
 * Parses one contract's events for a single transaction, handling both event
 * shapes seen so far: normal self-contained events (one event = one action,
 * handled by parseContractEvent) and field-fragment groups (several events
 * that together describe one action, e.g. Phoenix's per-field swap events).
 * A fragment group ends whenever the event-name changes or a field name
 * repeats (a repeat means a second action of the same kind started).
 */
// Exported (alongside parseContractEvent below) so an audit script can feed
// real, independently-fetched events through the exact same logic the
// indexer runs, instead of a hand-reimplemented copy that could drift from
// it - see the "systematic audit" note in README.md's registry notes. Kept
// as a thin wrapper with its original signature/behavior UNCHANGED (just
// the successful results) - parseSingleLedger calls the richer internal
// version below directly instead, so adding the op-args-fallback failure
// tracking (2026-10-01) can't break this external contract.
export function parseContractEventGroup(
  contractEvents: xdr.ContractEvent[],
  contractId: string,
  protocolInfo: ProtocolInfo,
  ledgerSequence: number,
  transactionHash: string,
  blockCloseTime: string
): CreditEvent[] {
  return parseContractEventGroupInternal(
    contractEvents, contractId, protocolInfo, ledgerSequence, transactionHash, blockCloseTime
  ).results;
}

/**
 * Same logic as parseContractEventGroup, but also reports which raw events
 * from the plain (non-fragment) path came back null - the operation-args
 * fallback in parseSingleLedger needs the ORIGINAL ContractEvent to retry,
 * not just a count. Fragment-group failures (Phoenix-style) are
 * deliberately NOT included - that's a structurally different failure mode
 * (a field never arrived to complete the group), not "no account address
 * found", so the op-args fallback isn't the right tool for it.
 */
function parseContractEventGroupInternal(
  contractEvents: xdr.ContractEvent[],
  contractId: string,
  protocolInfo: ProtocolInfo,
  ledgerSequence: number,
  transactionHash: string,
  blockCloseTime: string
): { results: CreditEvent[]; failedEvents: xdr.ContractEvent[] } {
  const results: CreditEvent[] = [];
  const failedEvents: xdr.ContractEvent[] = [];
  let pendingGroup: { eventType: string; fields: Map<string, xdr.ScVal> } | null = null;

  const flushPending = () => {
    if (!pendingGroup) return;
    const record = assembleFromFields(
      pendingGroup.eventType,
      pendingGroup.fields,
      contractId,
      protocolInfo,
      ledgerSequence,
      transactionHash,
      blockCloseTime
    );
    if (record) results.push(record);
    pendingGroup = null;
  };

  for (const event of contractEvents) {
    const fragment = asFieldFragment(event);
    if (fragment) {
      if (!pendingGroup || pendingGroup.eventType !== fragment.eventType || pendingGroup.fields.has(fragment.fieldName)) {
        flushPending();
        pendingGroup = { eventType: fragment.eventType, fields: new Map() };
      }
      pendingGroup.fields.set(fragment.fieldName, fragment.value);
      continue;
    }
    // Not a fragment: flush whatever field-group was in progress, then parse
    // this event the normal, self-contained way.
    flushPending();
    const record = parseContractEvent(event, contractId, protocolInfo, ledgerSequence, transactionHash, blockCloseTime);
    if (record) results.push(record);
    else failedEvents.push(event);
  }
  flushPending();

  return { results, failedEvents };
}

function assembleFromFields(
  eventType: string,
  fields: Map<string, xdr.ScVal>,
  contractId: string,
  protocolInfo: ProtocolInfo,
  ledgerSequence: number,
  transactionHash: string,
  blockCloseTime: string
): CreditEvent | null {
  // A "field" here isn't always a leaf value: some protocols coincidentally
  // match the field-fragment shape (2 text topics) without actually being
  // one - e.g. Stellar DeFi Hub's `[DEPOSIT, create]` is really one
  // complete, self-contained event whose data is a map holding `owner`,
  // `amount`, etc., not a per-field fragment to correlate with siblings.
  // flattenOneLevel unwraps that map (or a vec) so its real contents are
  // searchable, exactly like the data payload is for a normal event below.
  const { values, named } = flattenOneLevel([...fields.values()]);

  const accountAddresses = findAccountAddresses(values);
  const userAddress = accountAddresses[0];
  if (!userAddress) return null;

  const swap = eventType === 'swap' ? resolveSwapFromFields(fields) : null;
  const { amount, poolShareTokensAfter } = swap
    ? { amount: swap.amount, poolShareTokensAfter: undefined }
    : pickAmount(values, named);
  const { assetContractId, assetCode } = swap ?? resolveAsset(values, protocolInfo, contractId);

  return {
    ledgerSequence,
    transactionHash,
    blockCloseTime,
    protocolName: protocolInfo.protocolName,
    category: protocolInfo.category,
    contractId,
    userAddress,
    eventType,
    amount,
    ...(accountAddresses[1] && { counterpartyAddress: accountAddresses[1] }),
    ...(assetContractId && { assetContractId }),
    ...(assetCode && { assetCode }),
    ...(swap && { assetOutContractId: swap.assetOutContractId, amountOut: swap.amountOut }),
    ...(swap?.assetOutCode && { assetOutCode: swap.assetOutCode }),
    ...(poolShareTokensAfter !== undefined && { poolShareTokensAfter })
  };
}

export function parseContractEvent(
  event: xdr.ContractEvent,
  contractId: string,
  protocolInfo: ProtocolInfo,
  ledgerSequence: number,
  transactionHash: string,
  blockCloseTime: string
): CreditEvent | null {
  // ContractEvent.body is a v0-only union today: { topics: ScVal[], data: ScVal }.
  const eventBody = event.body.v0;
  const topics = eventBody.topics;
  if (topics.length < 2) return null;

  // The event name is usually topics[0], but not always: real Soroswap
  // Router `swap` events lead with a plain scvString contract-name label
  // ("SoroswapRouter") before the actual event name at topics[1] - so scan
  // for the first scvSymbol topic (every real event name seen across every
  // protocol here is a symbol) instead of assuming position 0.
  const eventTypeIndex = topics.findIndex((t) => t.type === 'scvSymbol');
  if (eventTypeIndex === -1) return null;
  const eventType = (topics[eventTypeIndex] as xdr.ScVal & { type: 'scvSymbol' }).sym.toString();

  // Search topics AND the data payload together for both the address and
  // the amount, flattened one level deep. Protocols don't agree on where
  // either lives: many put (event_name, user_address, ...) in topics with
  // amounts in the data vec/map (e.g. Aquarius's real mainnet `swap` event
  // is (event_name, vec[token_a, token_b], user_address, ...) - the address
  // isn't always topics[1]), but e.g. Stellar DeFi Hub's real `[DEPOSIT,
  // create]` event has NO address in its topics at all - `owner` and
  // `amount` are both keys inside its data map instead. flattenOneLevel
  // unwraps one level of vec/map from each candidate so entries like that
  // are visible, and findAccountAddresses/pickAmount then scan everything
  // together rather than assuming a fixed position or a fixed location.
  const dataVal = eventBody.data;
  const remainingTopics = topics.filter((_, i) => i !== eventTypeIndex);
  const { values, named } = flattenOneLevel([...remainingTopics, dataVal]);

  const accountAddresses = findAccountAddresses(values);
  const userAddress = accountAddresses[0];
  if (!userAddress) return null;

  const swap = eventType === 'swap' ? resolveSwapFromData(dataVal) : null;
  const isAlula = protocolInfo.protocolName === 'alula';
  const isNormal = protocolInfo.protocolName === 'normal';
  const isDeFindex = protocolInfo.protocolName === 'defindex';
  const isFundable = protocolInfo.protocolName === 'fundable';
  const alulaAmount = !swap && isAlula ? resolveAlulaAmount(dataVal, eventType) : null;
  const alulaAsset = !swap && isAlula ? resolveAlulaAsset(values, eventType, contractId) : null;
  const normalAmount = !swap && isNormal ? resolveNormalAmount(dataVal, eventType) : null;
  const normalAsset = !swap && isNormal ? resolveNormalAsset(values, remainingTopics, contractId) : null;
  const defindexResult = !swap && isDeFindex ? resolveDeFindexAmountAndShares(dataVal, eventType) : null;
  const fundableAmount = !swap && isFundable ? resolveFundableAmount(dataVal, eventType) : null;
  const { amount, poolShareTokensAfter } = swap
    ? { amount: swap.amount, poolShareTokensAfter: undefined }
    : alulaAmount !== null
      ? { amount: alulaAmount, poolShareTokensAfter: undefined }
      : normalAmount !== null
        ? { amount: normalAmount, poolShareTokensAfter: undefined }
        : defindexResult
          ? defindexResult
          : fundableAmount !== null
            ? { amount: fundableAmount, poolShareTokensAfter: undefined }
            : pickAmount(values, named);
  const { assetContractId, assetCode } = swap ?? alulaAsset ?? normalAsset ?? resolveAsset(values, protocolInfo, contractId);

  return {
    ledgerSequence,
    transactionHash,
    blockCloseTime,
    protocolName: protocolInfo.protocolName,
    category: protocolInfo.category,
    contractId,
    userAddress,
    eventType,
    amount,
    ...(accountAddresses[1] && { counterpartyAddress: accountAddresses[1] }),
    ...(assetContractId && { assetContractId }),
    ...(assetCode && { assetCode }),
    ...(swap && { assetOutContractId: swap.assetOutContractId, amountOut: swap.amountOut }),
    ...(swap?.assetOutCode && { assetOutCode: swap.assetOutCode }),
    ...(poolShareTokensAfter !== undefined && { poolShareTokensAfter })
  };
}

/**
 * Shared amount-picking heuristic used by both the normal single-event path
 * and the fragment-group path: prefer a value explicitly keyed "amount" (a
 * map entry, or a Phoenix-style field name), else fall back to the first
 * numeric-typed value found at all, and a second one (if any) as the
 * pool-share-token count. Confirmed against Blend's real contract source
 * (blend-capital/blend-contracts, pool/src/pool/actions.rs) that this
 * second value, for every lending event this parser reads, really is a
 * b-token/d-token count derived from the SAME `request.amount` via
 * `to_b_token_down`/`to_d_token_up` etc. - i.e. the same 7-decimal
 * fixed-point convention as `amount` itself, not a separate 4-decimal
 * "ratio" scaling (the field's previous name and scaling were both wrong -
 * this isn't a collateral ratio at all, see CreditEvent.poolShareTokensAfter's
 * own comment for what it actually is and why a real ratio needs data this
 * parser can't get from a single event).
 */
function pickAmount(
  candidates: xdr.ScVal[],
  namedEntries: [string, xdr.ScVal][]
): { amount: number; poolShareTokensAfter?: number } {
  try {
    // Match by name pattern, not an exact list: real deployed contracts use
    // "amount", "offer_amount" (Phoenix), and per Peridot's own source also
    // "borrow_amount"/"repay_amount"/"mint_amount"/"redeem_amount" - matching
    // any key that IS "amount" or ENDS with "_amount" covers all of these
    // (and future ones) without hardcoding each protocol's vocabulary.
    const namedAmount = namedEntries.find(([key]) => key === 'amount' || key.endsWith('_amount'));
    const numeric = namedAmount
      ? [namedAmount[1]]
      : candidates.filter((v) => NUMERIC_SCVAL_TYPES.has(v.type));

    const amount = numeric.length > 0 ? Number(scValToBigInt(numeric[0])) / 10 ** 7 : 0;
    const poolShareTokensAfter = numeric.length > 1 ? Number(scValToBigInt(numeric[1])) / 10 ** 7 : undefined;
    return { amount, poolShareTokensAfter };
  } catch {
    return { amount: 0 };
  }
}
