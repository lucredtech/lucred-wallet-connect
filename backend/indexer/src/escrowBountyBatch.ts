// Bridge from a Galexie LedgerCloseMetaBatch to OSS-bounty income events — the piece that lets the live
// indexer emit a second stream alongside credit_events without touching the hot parseLedgerCloseMetaBatch
// path. It walks the same ledgers, decodes each contract event to the native (scValToNative) shape, and
// hands it to the pure, unit-tested extractBountyIncome (which applies the Trustless Work platform
// registry: keep GrantFox/payroll income, drop KutanaPay trade / Pacto FX / sales).
//
// Version handling mirrors xdrParser.ts exactly (LedgerCloseMeta v1/v2; TransactionMeta v3 sorobanMeta
// vs v4 diagnosticEvents filtered by inSuccessfulContractCall) — kept in sync with that file.
import { xdr, Address, scValToNative } from '@stellar/stellar-sdk';
import { extractBountyIncome, TW_TOPICS, type OssBountyEvent, type DecodedEvent } from './escrowBounty';

function extractContractEvents(txMeta: xdr.TransactionMeta): xdr.ContractEvent[] {
  if (txMeta.type === 'v3') return txMeta.v3.sorobanMeta?.events ?? [];
  if (txMeta.type === 'v4') {
    return (txMeta.v4.diagnosticEvents ?? [])
      .filter((d) => d.inSuccessfulContractCall)
      .map((d) => d.event);
  }
  return []; // operations | v1 | v2: pre-Soroban, no ContractEvent
}

/** Returns OSS-bounty income records for every included Trustless Work escrow milestone released in this
 *  batch. Returns [] for anything undecodable (never throws — a bad batch must not stall the indexer). */
export function parseEscrowBountyBatch(rawXdr: Buffer): OssBountyEvent[] {
  const out: OssBountyEvent[] = [];
  let batch: xdr.LedgerCloseMetaBatch;
  try {
    batch = xdr.LedgerCloseMetaBatch.fromXdr(rawXdr);
  } catch {
    return out;
  }

  for (const closeMeta of batch.ledgerCloseMetas) {
    if (closeMeta.type !== 'v1' && closeMeta.type !== 'v2') continue;
    const meta = closeMeta.type === 'v1' ? closeMeta.v1 : closeMeta.v2;
    const header = meta.ledgerHeader.header;
    const ledgerSequence = header.ledgerSeq;
    const blockCloseTime = new Date(Number(header.scpValue.closeTime) * 1000).toISOString();

    for (const txResultMeta of meta.txProcessing) {
      const events = extractContractEvents(txResultMeta.txApplyProcessing);
      if (events.length === 0) continue;
      let txHash: string;
      try {
        // transactionHash is an xdr Hash (a Buffer subclass) — hex-encode it directly.
        txHash = (txResultMeta.result.transactionHash as unknown as Buffer).toString('hex');
      } catch {
        txHash = '';
      }

      for (const event of events) {
        if (!event.contractId) continue;
        let contractId: string;
        try {
          contractId = Address.contract(event.contractId.toBytes()).toString();
        } catch {
          continue;
        }
        const body = event.body.v0;
        const topics = body.topics;
        // TW escrow events lead with the event-name symbol (tw_init / tw_ms_approve / …).
        const symTopic = topics.find((t) => t.type === 'scvSymbol');
        const topic = symTopic && symTopic.type === 'scvSymbol' ? symTopic.sym.toString() : null;
        if (!topic || !TW_TOPICS.has(topic)) continue;

        let value: unknown;
        try {
          value = scValToNative(body.data);
        } catch {
          continue;
        }
        const decoded: DecodedEvent = { contractId, topic, value, ledgerSequence, transactionHash: txHash, blockCloseTime };
        // Default registry (TRUSTLESS_WORK_PLATFORMS) decides include/incomeType per platform.
        out.push(...extractBountyIncome(decoded));
      }
    }
  }
  return out;
}
