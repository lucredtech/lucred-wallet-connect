export type CreditModel = "secured" | "unsecured" | "mix";

export interface CreditOffer {
  model: CreditModel;
  eligible: boolean;
  limitUsd: number;
  aprPct: number | null;
  aprBreakdown: {
    basePct: number;
    scoreRiskPct: number;
    securityDiscountPct: number;
    unsecuredSurchargePct: number;
    volatileCollateralPct: number;
    capped: boolean;
  } | null;
  notes: string[];
}

export interface CreditCollateralClass {
  class: string;
  label: string;
  marketUsd: number;
  lendableUsd: number;
}

export interface CreditLine {
  wallet: string;
  indicative: true;
  policyVersion: string;
  disclaimer: string;
  inputs: {
    score: number;
    tier: string;
    path: string;
    debtUsd: number;
    collateral: {
      classes: CreditCollateralClass[];
      marketUsd: number;
      lendableUsd: number;
      averageHaircut: number;
      excludedUsd: number;
    };
  };
  offers: Record<CreditModel, CreditOffer>;
}

const API_URL = import.meta.env.VITE_CREDIT_SCORE_API_URL as string | undefined;

export async function fetchCreditLine(address: string): Promise<CreditLine> {
  if (!API_URL) throw new Error("VITE_CREDIT_SCORE_API_URL is not configured - see .env.example");
  const res = await fetch(`${API_URL.replace(/\/$/, "")}/credit-line?wallet=${encodeURIComponent(address)}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error || `Credit line lookup failed (${res.status})`);
  return data as CreditLine;
}
