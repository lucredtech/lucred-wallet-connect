// Income extractor for Trustless Work escrows — the shared escrow infra that GrantFox, KutanaPay,
// Boundless, a payroll operator and others all build on (trustlesswork.com/ecosystem).
//
// WHY separate from xdrParser.ts's PROTOCOL_REGISTRY path: a Trustless Work escrow is a NEW contract
// per deal, so it can never be pre-registered by contract id. They're discovered in the ledger stream
// by their unique event TOPICS (tw_init / tw_ms_approve / tw_release …), optionally verified against the
// approved escrow WASM hash. This module is pure and framework-agnostic: it consumes already-decoded
// events (scValToNative shape) so it can be unit-tested against captured mainnet data AND wired into the
// live indexer (which scValToNatives the xdr.ContractEvent first). Nothing here touches parseSingleLedger.
//
// CRITICAL: Trustless Work powers MANY platforms with different meanings — a GrantFox OSS bounty is
// income; a KutanaPay cross-border TRADE escrow or a Pacto FX swap is NOT personal income. So every
// escrow is classified by its PLATFORM (roles.platform) via the registry below, and only platforms
// marked `include` are emitted, each tagged with an `incomeType` the scorer can weight. Unknown
// platforms are skipped by default (never silently scored as income) unless `includeUnclassified` is set
// for discovery.

const KNOWN_ASSET_CONTRACTS: Record<string, string> = {
  CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75: "USDC",
  CDTKPWPLOURQA2SGTKTUQOWRCBZEORB4BWBOMJ3D3ZTQQSGE5F6JBQLV: "EURC",
};

// Approved escrow WASM hashes seen live on mainnet (discovery/verification allowlist). Empty = accept
// any contract whose events carry the tw_* topics.
export const APPROVED_ESCROW_WASM_HASHES = new Set<string>([
  "2ddb5ef1f8f029ea93313ed7a6886f763eda7287d8a08bacc0a427ab0aa1dc1f", // multi-release / milestones
  "e11805e412966610124c69ab10bfa0a45a4276c82863d6406f2481e8284068ac", // single-release
]);

// Event topics that identify a Trustless Work escrow (the discovery signal in the ledger stream).
export const TW_TOPICS = new Set(["tw_init", "tw_fund", "tw_ms_change", "tw_ms_approve", "tw_release", "tw_update", "tw_dispute", "tw_disp_resolve"]);

/** How to treat escrows from one platform (keyed by roles.platform account). */
export interface PlatformInfo {
  name: string;
  /** "oss_bounty" | "payroll" | "grant" | "gig" | "trade" | "fx" | "sale" | "deposit" | "unclassified" */
  incomeType: string;
  include: boolean;   // false => not personal income (trade/FX/sale/deposit) — never scored
  weight?: number;    // relative confidence for the scorer (income types only)
}
export type PlatformRegistry = Record<string, PlatformInfo>;

// Seeded from on-chain discovery (2026-10) + the Trustless Work ecosystem list. Accounts confirmed from
// mainnet escrows are set; SCF-stage platforms (GrantFox, Boundless, …) are left for when their
// roles.platform account is known (from the team, or when they transact on mainnet). Add a row to switch
// a platform on — no parsing changes needed.
export const TRUSTLESS_WORK_PLATFORMS: PlatformRegistry = {
  // --- confirmed on mainnet ---
  GDH3NLTXHTMAPZUX7MME2SESHRRASWHQWK7BS2MTXQ3PSAXLTXUYJFSH: { name: "KutanaPay", incomeType: "trade", include: false }, // cross-border TRADE escrow ("TDS-…") — not personal income
  GCRYH6M5YLTGZTCAALJPIJGQZY4Z6XFFUVTINCELQG4OGLADUBTAE3OU: { name: "Payroll operator", incomeType: "payroll", include: true, weight: 1.0 }, // biweekly salary escrows ("2da Quincena…") — real wage income
  GCHHIS6YEEGLRBEN3JTRJLLON2BQWFZWFZC5PZYCCEGDSZ5XU4VFQRNX: { name: "Business-sale escrow", incomeType: "sale", include: false }, // one-off asset/domain sales ("Sale of …") — not recurring personal income
  GC6T6GEPPAWOZXIOK6EMXLZ3DJDU4JBY4BV3ZWAWVSO57Q2Z2KN34RCZ: { name: "GrantFox", incomeType: "oss_bounty", include: true, weight: 0.7 }, // confirmed mainnet: titles "Third Campaign - …", 0% fee, USDC; ~$190k to 1,070 contributors (analytics.grantfox.xyz)
  // --- ecosystem platforms: fill the account when known (resolve the same way — read roles.platform from one of their mainnet escrows) ---
  // "<trustless_oss>":      { name: "Trustless-OSS", incomeType: "oss_bounty", include: true, weight: 0.7 },
  // "<boundless_platform>": { name: "Boundless",    incomeType: "grant",      include: true, weight: 0.6 },
  // "<offer_hub>":          { name: "Offer Hub",    incomeType: "gig",        include: true, weight: 0.8 },
  // "<payonproof>":         { name: "PayOnProof",   incomeType: "gig",        include: true, weight: 0.8 },
  // "<pacto_platform>":     { name: "Pacto",        incomeType: "fx",         include: false },
};

export interface OssBountyEvent {
  ledgerSequence: number;
  transactionHash: string;
  blockCloseTime: string;
  escrowContract: string;
  platform: string;          // roles.platform — the paying platform
  platformName?: string;     // human label from the registry, when known
  incomeType: string;        // oss_bounty | payroll | grant | gig | unclassified | …
  weight?: number;           // relative confidence for the scorer
  receiver: string;          // the paid wallet (milestone.receiver, falling back to roles.receiver)
  milestoneIndex: number;
  amount: number;            // GROSS milestone amount (units); net is derived in the feature
  platformFeeBps: number;    // platform_fee (bps) — lets the feature compute net income
  assetContractId?: string;
  assetCode?: string;
  engagementId: string;      // GitHub issue / campaign / pay-period ref — the IDENTITY/context link
  title?: string;
}

/** A decoded contract event (already scValToNative'd). `value` is native JS:
 *  - tw_init / tw_ms_approve / tw_ms_change: [EscrowObject]
 *  - tw_release: an address string */
export interface DecodedEvent {
  contractId: string;
  wasmHash?: string;
  topic: string;
  value: unknown;
  ledgerSequence: number;
  transactionHash: string;
  blockCloseTime: string;
}

export interface ExtractOptions {
  /** platform account -> policy. Defaults to TRUSTLESS_WORK_PLATFORMS. */
  registry?: PlatformRegistry;
  /** Legacy single-platform convenience: treat this one account as an included oss_bounty platform. */
  platformFilter?: string;
  /** Emit escrows from platforms NOT in the registry, tagged incomeType "unclassified" (for discovery).
   *  Off by default so unknown platforms are never scored as income. */
  includeUnclassified?: boolean;
}

interface Milestone {
  amount?: number | bigint | string;
  flags?: { approved?: boolean; disputed?: boolean; released?: boolean; resolved?: boolean };
  receiver?: string;
  status?: string;
}
interface Escrow {
  engagement_id?: string;
  title?: string;
  amount?: number | bigint | string;
  platform_fee?: number;
  milestones?: Milestone[];
  roles?: { platform?: string; receiver?: string; service_provider?: string };
  trustline?: { address?: string };
}

const SCALE = 10 ** 7;
const toUnits = (v: unknown): number => {
  try { return Number(typeof v === "bigint" ? v : BigInt(String(v ?? 0))) / SCALE; } catch { return 0; }
};
function escrowFromValue(value: unknown): Escrow | null {
  const v = Array.isArray(value) ? value[0] : value;
  if (!v || typeof v !== "object") return null;
  return v as Escrow;
}

/** Resolve the policy for an escrow's platform. Returns null to skip (excluded / unknown-and-not-discovering). */
function resolvePolicy(platform: string, opts: ExtractOptions): PlatformInfo | null {
  if (opts.platformFilter) {
    return platform === opts.platformFilter ? { name: "", incomeType: "oss_bounty", include: true, weight: 0.7 } : null;
  }
  const registry = opts.registry ?? TRUSTLESS_WORK_PLATFORMS;
  const info = registry[platform];
  if (info) return info.include ? info : null;        // known platform: honor include flag
  if (opts.includeUnclassified) return { name: "", incomeType: "unclassified", include: true };
  return null;                                          // unknown platform: skip (don't score as income)
}

/**
 * Extract income records from ONE decoded escrow event. Only the snapshot-bearing events
 * (tw_ms_approve / tw_ms_change / tw_init) are read; a milestone is emitted when it is `released`.
 */
export function extractBountyIncome(ev: DecodedEvent, opts: ExtractOptions = {}): OssBountyEvent[] {
  if (!TW_TOPICS.has(ev.topic)) return [];
  if (ev.topic !== "tw_ms_approve" && ev.topic !== "tw_ms_change" && ev.topic !== "tw_init") return [];
  if (ev.wasmHash && APPROVED_ESCROW_WASM_HASHES.size && !APPROVED_ESCROW_WASM_HASHES.has(ev.wasmHash)) return [];

  const escrow = escrowFromValue(ev.value);
  if (!escrow) return [];
  const platform = escrow.roles?.platform;
  if (!platform) return [];

  const policy = resolvePolicy(platform, opts);
  if (!policy) return [];

  const assetContractId = escrow.trustline?.address;
  const assetCode = assetContractId ? KNOWN_ASSET_CONTRACTS[assetContractId] : undefined;
  const engagementId = escrow.engagement_id ?? "";
  const platformFeeBps = Number(escrow.platform_fee ?? 0);
  const base = (receiver: string, milestoneIndex: number, amount: number): OssBountyEvent => ({
    ledgerSequence: ev.ledgerSequence, transactionHash: ev.transactionHash, blockCloseTime: ev.blockCloseTime,
    escrowContract: ev.contractId, platform,
    ...(policy.name && { platformName: policy.name }),
    incomeType: policy.incomeType, ...(policy.weight !== undefined && { weight: policy.weight }),
    receiver, milestoneIndex, amount, platformFeeBps,
    ...(assetContractId && { assetContractId }), ...(assetCode && { assetCode }),
    engagementId, ...(escrow.title && { title: escrow.title }),
  });

  const out: OssBountyEvent[] = [];
  const milestones = Array.isArray(escrow.milestones) ? escrow.milestones : [];
  milestones.forEach((m, i) => {
    const released = m.flags?.released === true || m.status === "released";
    if (!released) return;
    const receiver = m.receiver || escrow.roles?.receiver || escrow.roles?.service_provider;
    if (receiver) out.push(base(receiver, i, toUnits(m.amount)));
  });

  if (!milestones.length) {
    const flagsReleased = (escrow as unknown as { flags?: { released?: boolean } }).flags?.released === true;
    const receiver = escrow.roles?.receiver || escrow.roles?.service_provider;
    if (flagsReleased && receiver) out.push(base(receiver, 0, toUnits(escrow.amount)));
  }
  return out;
}
