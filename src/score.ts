export interface ScoreResult {
  wallet: string;
  linkedGAddress?: string;
  tier: "A" | "B" | "C";
  score: number;
  reasons: string[];
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
