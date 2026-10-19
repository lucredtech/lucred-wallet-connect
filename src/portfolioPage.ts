// LCRD portfolio — the three-number header (net worth / net APY / credit health) + supplied/borrowed,
// aggregated from the credit-line pool for the connected wallet.
import "./ui.css";
import { connect, readCall, sAddr, sI128 } from "./soroban";

const POOL = "CBW426LFZAFUW2YMPUFZRMEV6VCZ2XSVOMHFQS7C6VCO4DIVK6SDB5ZP";
const EXPLORER = "https://stellar.expert/explorer/testnet";
const VAULT_APR = 0.10;
const ONE = 10_000_000;

const $ = (id: string) => document.getElementById(id) as HTMLElement;
const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
const usd = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fromBase = (b: bigint | number) => Number(b) / ONE;
let address: string | null = null;

async function load() {
  if (!address) return;
  try {
    const [shares, cash, vaultVal, line, avail, owed] = await Promise.all([
      readCall<bigint>(POOL, "shares_of", [sAddr(address)], address),
      readCall<bigint>(POOL, "cash", [], address),
      readCall<bigint>(POOL, "vault_value", [], address),
      readCall<Record<string, unknown>>(POOL, "get_line", [sAddr(address)], address),
      readCall<bigint>(POOL, "available", [sAddr(address)], address).catch(() => 0n),
      readCall<[bigint, bigint]>(POOL, "owed", [sAddr(address)], address).catch(() => [0n, 0n] as [bigint, bigint]),
    ]);
    const supplied = shares > 0n ? fromBase(await readCall<bigint>(POOL, "convert_to_assets", [sI128(shares)], address)) : 0;
    const debt = fromBase(owed[0] + owed[1]);
    const limit = fromBase(line.limit as bigint);
    const net = supplied - debt;
    const liquid = Number(cash);
    const estApy = liquid > 0 ? VAULT_APR * (Number(vaultVal) / liquid) : 0;

    $("net").textContent = "$" + usd(net);
    $("napy").textContent = supplied > 0 ? `~${(estApy * 100).toFixed(1)}%` : "—";
    // Credit health: for a line with debt, how much of the limit is used (lower = healthier).
    if ((line.active as boolean) && limit > 0 && debt > 0) {
      const used = Math.min(1, debt / limit);
      const band = used < 0.5 ? "Healthy" : used < 0.8 ? "Watch" : "At risk";
      $("health").textContent = band;
      $("health").style.color = used < 0.5 ? "var(--good)" : used < 0.8 ? "var(--warn)" : "var(--danger)";
    } else {
      $("health").textContent = debt > 0 ? "—" : "Clear";
      $("health").style.color = "var(--good)";
    }

    $("sup-pool").textContent = "$" + usd(supplied);
    $("sup-shares").textContent = shares.toString();
    $("bor-line").textContent = (line.active as boolean) && limit > 0
      ? `$${usd(debt)} owed · $${usd(limit)} limit`
      : "No active line";
    $("bor-avail").textContent = "$" + usd(fromBase(avail));
    $("connect-hint").hidden = true;
  } catch {
    $("connect-hint").textContent = "Couldn't read your portfolio right now.";
  }
}

(document.getElementById("lnk-pool") as HTMLAnchorElement).href = `${EXPLORER}/contract/${POOL}`;
$("walletBtn").addEventListener("click", async () => {
  try {
    address = await connect();
    $("walletLbl").textContent = short(address);
    await load();
  } catch { /* cancelled */ }
});
