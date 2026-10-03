export interface PortfolioToken {
  code: string;
  kind: string;
  contractId: string | null;
  balance: number;
  usdPrice: number | null;
  usdValue: number | null;
  priceSource?: "verified" | "stellar.expert";
  note?: string;
}

export interface PositionAsset {
  code: string | null;
  amount: number;
  usdValue: number | null;
}

export interface PortfolioPosition {
  protocol: "blend" | "aquarius" | "defindex";
  pool: string;
  type: string;
  assets: PositionAsset[];
  usdValue: number | null;
  fullyPriced: boolean;
  lpToken?: boolean;
  sharePct?: number;
}

export interface Portfolio {
  wallet: string;
  asOf: string;
  tokens: PortfolioToken[];
  hiddenUnpricedTokens: number;
  positions: PortfolioPosition[];
  totals: {
    tokensUsd: number;
    positionsUsd: number;
    debtUsd: number;
    grossUsd: number;
    netUsd: number;
    unpricedAssets: string[];
  };
  notShown: string[];
  partial: boolean;
}

const API_URL = import.meta.env.VITE_CREDIT_SCORE_API_URL as string | undefined;

export async function fetchPortfolio(address: string): Promise<Portfolio> {
  if (!API_URL) throw new Error("VITE_CREDIT_SCORE_API_URL is not configured - see .env.example");
  const res = await fetch(`${API_URL.replace(/\/$/, "")}/portfolio?wallet=${encodeURIComponent(address)}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error || `Holdings lookup failed (${res.status})`);
  return data as Portfolio;
}
