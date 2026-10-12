// Client for the dfToken-backed USDC credit feature (see backend/credit-score-api/collateral-engine.js).
// Off-chain / indicative in this stage: quote the USDC a wallet could draw against its DeFindex vault
// position, and record an acceptance. No funds move.

export type DfStructure = "open_ended" | "fixed_term";

export interface DfUnderlying {
  contractId: string | null;
  code: string | null;
  amount: number;
  usdValue: number;
  priceSource: string | null;
}

export interface DfVault {
  shareToken: string;
  underlying: DfUnderlying[];
  marketUsd: number;
  lendableUsd: number;
  haircutPct: number;
}

export interface DfTerms {
  wallet: string | null;
  version: string;
  policyVersion: string;
  asOf: string;
  eligible: boolean;
  reason?: string;
  collateral?: {
    vaults: DfVault[];
    marketUsd: number;
    lendableUsd: number;
    averageHaircut: number;
  };
  advance?: {
    rate: number;
    minRate: number;
    maxRate: number;
    principalUsd: number;
    principalAsset: { code: string; contractId: string | null };
    principalAmount: string;
  };
  terms?: {
    structure: DfStructure;
    termDays: number | null;
    apr: number;
    aprPct: number;
    aprBreakdown: {
      basePct: number;
      scoreRiskPct: number;
      securityDiscountPct: number;
      volatileCollateralPct: number;
      structurePct: number;
      capped: boolean;
    };
    interestAccrual: string;
    maturityDate: string | null;
  };
  disbursement?: { asset: string; source: string; amount: string };
  ltv?: { originationLtv: number; marginCallLtv: number; liquidationLtv: number; cureWindowSec: number };
  projectedDebt?: { d30: number; d90: number; d365: number };
  demo: boolean;
  disclaimer: string;
}

export interface DfAcceptResult {
  ok: boolean;
  id?: string;
  demo: boolean;
  terms?: DfTerms;
}

const API_URL = import.meta.env.VITE_CREDIT_SCORE_API_URL as string | undefined;
const base = () => {
  if (!API_URL) throw new Error("VITE_CREDIT_SCORE_API_URL is not configured - see .env.example");
  return API_URL.replace(/\/$/, "");
};

export async function fetchDfQuote(address: string, structure: DfStructure, termDays?: number): Promise<DfTerms> {
  const params = new URLSearchParams({ wallet: address, structure });
  if (structure === "fixed_term" && termDays) params.set("termDays", String(termDays));
  const res = await fetch(`${base()}/df-credit/quote?${params.toString()}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error || `Credit terms lookup failed (${res.status})`);
  return data as DfTerms;
}

export async function acceptDfTerms(payload: {
  wallet: string;
  walletVerified: boolean;
  structure: DfStructure;
  termDays: number | null;
  quote: DfTerms;
}): Promise<DfAcceptResult> {
  const res = await fetch(`${base()}/df-credit/accept`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...payload, website: "" }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error || `Couldn't record acceptance (${res.status})`);
  return data as DfAcceptResult;
}
