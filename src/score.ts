export interface ScoreComponent {
  key: string;
  label: string;
  group: "core" | "income" | "bonus";
  points: number;
  max: number;
  explain: string;
  detail: string | null;
  amountUsd?: number | null;
  amountLabel?: string;
}

export interface ScoreResult {
  wallet: string;
  linkedGAddress?: string;
  tier: "A" | "B" | "C";
  score: number;
  reasons: string[];
  components?: ScoreComponent[];
  path: string;
  eventCount: number;
}

const API_URL = import.meta.env.VITE_CREDIT_SCORE_API_URL as string | undefined;

export async function fetchScore(address: string): Promise<ScoreResult> {
  if (!API_URL) {
    throw new Error("VITE_CREDIT_SCORE_API_URL is not configured - see .env.example");
  }

  const res = await fetch(`${API_URL.replace(/\/$/, "")}/score?wallet=${encodeURIComponent(address)}`);
  const data = await res.json();

  if (!res.ok) {
    throw new Error(data?.error || `Score lookup failed (${res.status})`);
  }

  return data as ScoreResult;
}
