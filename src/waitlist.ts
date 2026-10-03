const API_URL = import.meta.env.VITE_CREDIT_SCORE_API_URL as string | undefined;

export async function joinWaitlist(email: string, website: string): Promise<void> {
  if (!API_URL) throw new Error("VITE_CREDIT_SCORE_API_URL is not configured - see .env.example");
  const res = await fetch(`${API_URL.replace(/\/$/, "")}/waitlist`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, website, source: "credit-line" }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error || `Couldn't join the waitlist (${res.status})`);
}
