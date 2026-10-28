// LCRD portfolio — the three-number header (net worth / net APY / credit health) + supplied/borrowed,
// aggregated from the credit-line pool for the connected wallet.
import "./ui.css";
import "./creditWaitlist"; // shared footer + waitlist on every /credit page
import { connect, restoreSession, invoke, readCall, sAddr, sI128, sBytes32, getContractEvents } from "./soroban";

const POOL = "CDW4G2YMN5RIXFTS6CW6XVNKPHJI4WZNAMUNHVKQZBD3G7QT45HELX63";
const ESCROW = "CCM4QHKGCEAE3FKNB3SGJ74ZHPHLWNAAB5BBVMDECXISB26MXAPHNFZG";
const DFTEST = "CDCW5LKOFURA3H2FN7UQNVDLHO6NGUWDZKJRKAITHFLRYG2KBSJCM6UI";
const DFUSDC = "CCMJ4NKHFHD26Z3OIXIU2MNY3IZZJK2HAIDQI5HECYOE27RXORBB6HKA";
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
    const [shares, assets, vaultVal, line, avail, owed] = await Promise.all([
      readCall<bigint>(POOL, "shares_of", [sAddr(address)], address),
      readCall<bigint>(POOL, "total_assets", [], address),
      readCall<bigint>(POOL, "vault_value", [], address),
      readCall<Record<string, unknown>>(POOL, "get_line", [sAddr(address)], address),
      readCall<bigint>(POOL, "available", [sAddr(address)], address).catch(() => 0n),
      readCall<[bigint, bigint]>(POOL, "owed", [sAddr(address)], address).catch(() => [0n, 0n] as [bigint, bigint]),
    ]);
    const supplied = shares > 0n ? fromBase(await readCall<bigint>(POOL, "convert_to_assets", [sI128(shares)], address)) : 0;
    const debt = fromBase(owed[0] + owed[1]);
    const limit = fromBase(line.limit as bigint);
    const net = supplied - debt;
    // Vault-yield component: vault rate × share of NAV parked in the vault (of total_assets, never >1).
    const denom = Number(assets);
    const estApy = denom > 0 ? VAULT_APR * (Number(vaultVal) / denom) : 0;

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

// ---- collateral loans (repay / close), mirrored from the Borrow-on-collateral page ----
const SYM: Record<string, string> = { [DFTEST]: "dfTEST", [DFUSDC]: "dfUSDC" };
const loansKey = () => `lcrd.collateralLoans.${address}`;
function storedLoans(): string[] { try { return JSON.parse(localStorage.getItem(loansKey()) || "[]"); } catch { return []; } }
function toHex(v: unknown): string {
  if (typeof v === "string") return v.replace(/^0x/, "");
  if (v instanceof Uint8Array || Array.isArray(v)) return Array.from(v as Uint8Array).map((b) => b.toString(16).padStart(2, "0")).join("");
  return "";
}

async function loadLoans() {
  if (!address) return;
  const box = $("pf-loansList");
  const ids = new Set<string>(storedLoans());
  try {
    const evs = await getContractEvents(ESCROW, 80);
    for (const e of evs) {
      if (String(e.topics[0]) !== "deposit") continue;
      if ((typeof e.topics[1] === "string" ? e.topics[1] : "") !== address) continue;
      const id = toHex(Array.isArray(e.value) ? (e.value as unknown[])[0] : null);
      if (id) ids.add(id);
    }
  } catch { /* stored ids only */ }

  const loans: { id: string; token: string; coll: number; debt: number; apr: number }[] = [];
  for (const id of ids) {
    try {
      const l = await readCall<Record<string, unknown>>(ESCROW, "get_loan", [sBytes32(id)], address);
      if (l && String(l.status) !== "Closed") {
        loans.push({ id, token: String(l.collateral_token), coll: Number(l.collateral_amount) / ONE, debt: Number(l.debt) / ONE, apr: Number(l.apr_bps) });
      }
    } catch { /* skip */ }
  }
  if (!loans.length) return; // keep the default "appear here" hint

  box.innerHTML = "";
  for (const l of loans) {
    const sym = SYM[l.token] || short(l.token);
    const row = document.createElement("div");
    row.style.cssText = "padding:12px 0;border-bottom:1px solid var(--line);";
    row.innerHTML =
      `<div class="between" style="margin-bottom:8px;"><div><div style="font-weight:600;">${l.coll.toLocaleString("en-US", { maximumFractionDigits: 2 })} ${sym} pledged</div><div class="tiny faint mono">${(l.apr / 100).toFixed(1)}% APR</div></div><div style="text-align:right;"><div class="sm muted">Owed</div><div class="mono" style="font-weight:700;">$${usd(l.debt)}</div></div></div>
       <div class="row" style="gap:8px;"><button class="btn btn-primary pf-repay" data-id="${l.id}" ${l.debt <= 0 ? "disabled" : ""} style="flex:1;justify-content:center;">${l.debt <= 0 ? "Repaid" : `Repay $${usd(l.debt)}`}</button><button class="btn pf-close" data-id="${l.id}" ${l.debt > 0 ? "disabled" : ""} style="flex:1;justify-content:center;">Close &amp; unlock</button></div>`;
    box.append(row);
  }
  box.querySelectorAll<HTMLButtonElement>(".pf-repay").forEach((b) => b.addEventListener("click", () => actLoan(b, "repay")));
  box.querySelectorAll<HTMLButtonElement>(".pf-close").forEach((b) => b.addEventListener("click", () => actLoan(b, "close")));
}

async function actLoan(btn: HTMLButtonElement, kind: "repay" | "close") {
  if (!address) return;
  const id = btn.dataset.id!;
  const prev = btn.textContent;
  btn.disabled = true; btn.textContent = kind === "repay" ? "Repaying…" : "Unlocking…";
  try {
    if (kind === "repay") {
      const payoff = BigInt(String(await readCall<bigint>(ESCROW, "payoff", [sBytes32(id)], address)));
      await invoke(ESCROW, "repay", [sBytes32(id), sI128(payoff + payoff / 100n + 100000n)], address);
    } else {
      await invoke(ESCROW, "close", [sBytes32(id)], address);
    }
    await load();
    await loadLoans();
  } catch {
    btn.disabled = false; btn.textContent = prev;
  }
}

(document.getElementById("lnk-pool") as HTMLAnchorElement).href = `${EXPLORER}/contract/${POOL}`;
$("walletBtn").addEventListener("click", async () => {
  try {
    address = await connect();
    $("walletLbl").textContent = short(address);
    await load();
    await loadLoans();
  } catch { /* cancelled */ }
});
restoreSession().then((a) => { if (a) { address = a; $("walletLbl").textContent = short(a); load(); loadLoans(); } });
