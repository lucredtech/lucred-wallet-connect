// LCRD Borrow-on-collateral — pick a supported vault/LP share-token (from the on-chain collateral
// registry via GET /collateral/supported), value the wallet's position on-chain, size + price the
// line, and open it by depositing the collateral into the Stage-B escrow (the auto-disburser then
// sends the USDC). Tokens the escrow doesn't yet accept show a quote only.
import "./ui.css";
import { connect, invoke, readCall, sAddr, sI128, sU32, sBytes32, sEnum } from "./soroban";

const ESCROW = "CCM4QHKGCEAE3FKNB3SGJ74ZHPHLWNAAB5BBVMDECXISB26MXAPHNFZG";
const DFTEST = "CDCW5LKOFURA3H2FN7UQNVDLHO6NGUWDZKJRKAITHFLRYG2KBSJCM6UI";
const DFUSDC = "CCMJ4NKHFHD26Z3OIXIU2MNY3IZZJK2HAIDQI5HECYOE27RXORBB6HKA";
const EXPLORER = "https://stellar.expert/explorer/testnet";
const API = import.meta.env.VITE_CREDIT_SCORE_API_URL as string | undefined;
const ONE = 10_000_000;
// Which collateral the Stage-B escrow currently accepts on-chain (its set_asset allowlist).
const ESCROW_ACCEPTS = new Set([DFTEST]);
// Indicative borrow APR by underlying risk class (the real rate comes from the engine at quote time).
const APR_BY_CLASS: Record<string, number> = { stable: 0.112, stableFx: 0.115, rwa: 0.13, major: 0.135, incentive: 0.14, curated: 0.15 };

interface Collat { shareToken: string; symbol: string; label: string; kind: string; underlyingClass: string; advanceRate: number; liquidationLtv: number; priceSource: string; parUsd: number | null; }

// Fallback mirrors the testnet registry so the page works before /collateral/supported is deployed.
const FALLBACK: Collat[] = [
  { shareToken: DFUSDC, symbol: "dfUSDC", label: "DeFindex USDC Vault", kind: "vault", underlyingClass: "stable", advanceRate: 0.75, liquidationLtv: 0.92, priceSource: "underlying", parUsd: null },
  { shareToken: DFTEST, symbol: "dfTEST", label: "Mock dfToken (escrow test)", kind: "vault", underlyingClass: "stable", advanceRate: 0.70, liquidationLtv: 0.90, priceSource: "par", parUsd: 1 },
];

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
let address: string | null = null;
let list: Collat[] = [];
let sel: Collat | null = null;
let selValue = 0; // USD value of the selected position
let selRaw = 0n; // raw balance of the selected share-token
let maxBorrow = 0;

const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
const fmt = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 0 });
const usd2 = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const css = (n: string) => getComputedStyle(document.documentElement).getPropertyValue(n);

let toastT: number | undefined;
function toast(msg: string, opts: { tx?: string; err?: boolean } = {}) {
  const el = $("toast");
  el.className = opts.err ? "err" : "";
  el.innerHTML = msg + (opts.tx ? ` <a href="${EXPLORER}/tx/${opts.tx}" target="_blank" rel="noopener">view ↗</a>` : "");
  el.classList.add("show");
  window.clearTimeout(toastT);
  toastT = window.setTimeout(() => el.classList.remove("show"), 4000);
}

async function loadList() {
  if (API) {
    try {
      const res = await fetch(`${API.replace(/\/$/, "")}/collateral/supported`);
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.collateral) && data.collateral.length) {
          list = data.collateral;
          $("src-note").textContent = `${data.network} registry · advance set by risk`;
          return;
        }
      }
    } catch { /* fall through to fallback */ }
  }
  list = FALLBACK;
  $("src-note").textContent = "advance set by asset risk";
}

function glyph(c: Collat) { return c.kind === "amm_lp" ? "LP" : c.symbol.slice(0, 2); }

function renderList() {
  $("collatList").innerHTML = list.map((c, i) => {
    const accepted = ESCROW_ACCEPTS.has(c.shareToken);
    return `<button class="cposrow" data-i="${i}" aria-pressed="${sel?.shareToken === c.shareToken}">
      <span class="tok" style="background:${accepted ? "linear-gradient(135deg,var(--brand),var(--good))" : "var(--ink)"}">${glyph(c)}</span>
      <span class="grow" style="min-width:0">
        <span class="sm" style="font-weight:600;display:block">${c.label} <span class="tiny faint mono">${short(c.shareToken)}</span></span>
        <span class="tiny muted">${c.underlyingClass} · ${Math.round(c.advanceRate * 100)}% advance${accepted ? "" : " · quote only"}</span>
      </span>
      <span class="num tiny faint" style="flex:none" id="bal-${i}">${address ? "…" : ""}</span>
    </button>`;
  }).join("");
  $("collatList").querySelectorAll<HTMLButtonElement>(".cposrow").forEach((b) => {
    b.addEventListener("click", () => select(Number(b.dataset.i)));
  });
  if (address) list.forEach((_, i) => showRowBalance(i));
}

async function showRowBalance(i: number) {
  if (!address) return;
  try {
    const raw = await readCall<bigint>(list[i].shareToken, "balance", [sAddr(address)], address);
    const el = document.getElementById(`bal-${i}`);
    if (el) el.textContent = `${fmt(Number(raw) / ONE)} ${list[i].symbol}`;
  } catch { /* ignore */ }
}

async function valueOf(c: Collat, raw: bigint): Promise<number> {
  if (raw <= 0n) return 0;
  if (c.priceSource === "par") return (Number(raw) / ONE) * (c.parUsd ?? 1);
  const amounts = await readCall<bigint[]>(c.shareToken, "get_asset_amounts_per_shares", [sI128(raw)], address || c.shareToken);
  return Number(amounts[0] ?? 0n) / ONE;
}

async function select(i: number) {
  sel = list[i];
  renderList();
  $("panel").hidden = false;
  const accepted = ESCROW_ACCEPTS.has(sel.shareToken);
  if (!address) {
    $("selSummary").textContent = `Connect your wallet to size a line against ${sel.label}.`;
    setBorrowState("connect");
  }
  $("selChip").textContent = `${sel.symbol} · ${Math.round(sel.advanceRate * 100)}% advance`;
  $("aprLine").textContent = `${((APR_BY_CLASS[sel.underlyingClass] ?? 0.14) * 100).toFixed(1)}%`;
  if (address) {
    selRaw = BigInt(await readCall<bigint>(sel.shareToken, "balance", [sAddr(address)], address));
    selValue = await valueOf(sel, selRaw);
    maxBorrow = Math.floor(selValue * sel.advanceRate);
    const r = $<HTMLInputElement>("borrowRange");
    r.max = String(Math.max(0, maxBorrow)); r.value = String(Math.floor(maxBorrow * 0.6));
    $("selSummary").textContent = selValue > 0
      ? `Pledging ${sel.label} — $${usd2(selValue)} at ${Math.round(sel.advanceRate * 100)}% advance (borrow up to $${fmt(maxBorrow)}).`
      : `You hold no ${sel.symbol}. Get some from the faucet, then come back to borrow against it.`;
    calc();
    setBorrowState(selValue <= 0 ? "empty" : accepted ? "ok" : "unsupported");
  }
}

function calc() {
  if (!sel) return;
  const v = Number($<HTMLInputElement>("borrowRange").value) || 0;
  const liqLtv = sel.liquidationLtv;
  const power = maxBorrow > 0 ? Math.min(1, v / maxBorrow) : 0;
  const hf = v > 0 ? (selValue * liqLtv) / v : 99;
  const liq = v > 0 ? v / liqLtv : 0;
  $("borrowVal").textContent = "$" + fmt(v);
  $("powerPct").textContent = Math.round(power * 100) + "%";
  const bar = $("powerBar"); bar.style.width = power * 100 + "%";
  let col = css("--good"), band = "Healthy", risky = false;
  if (power >= 0.92) { col = css("--danger"); band = "At risk"; risky = true; }
  else if (power >= 0.8) { col = css("--warn"); band = "Watch"; risky = true; }
  bar.style.background = col;
  $("hf").textContent = (v > 0 ? hf.toFixed(2) : "—") + " · " + band; $("hf").style.color = col;
  $("liqPrice").textContent = "$" + fmt(Math.round(liq));
  $("lockLine").textContent = `$${usd2(selValue)} ${sel.symbol}`;
  const msg = $("riskMsg");
  if (power >= 0.8) { msg.style.background = "var(--warn-tint)"; msg.style.color = "var(--warn)"; msg.textContent = "Getting close to your limit — if this collateral dips, part of it could be sold to repay. Consider borrowing less."; }
  else { msg.style.background = "var(--brand-tint)"; msg.style.color = "var(--brand-ink)"; msg.textContent = "Your collateral keeps earning its vault/LP yield the whole time it's pledged."; }
  $("ackRow").style.display = risky ? "flex" : "none";
  if (!risky) $<HTMLInputElement>("ack").checked = false;
  syncBtn();
}

function setBorrowState(state: "connect" | "empty" | "unsupported" | "ok") {
  const btn = $<HTMLButtonElement>("borrowBtn");
  const note = $("borrowNote");
  if (state === "connect") { btn.disabled = true; btn.textContent = "Connect wallet"; }
  else if (state === "empty") { btn.disabled = true; btn.textContent = "Get collateral first"; }
  else if (state === "unsupported") {
    btn.disabled = true; btn.textContent = "On-chain borrow coming soon";
    note.textContent = "This token is priced and sized here, but the escrow doesn't accept it on-chain yet. dfTEST is enabled end-to-end today.";
  } else {
    syncBtn();
    note.textContent = "Your pledged tokens are held in the on-chain collateral escrow and returned when you repay.";
  }
}

function syncBtn() {
  const btn = $<HTMLButtonElement>("borrowBtn");
  if (!address || !sel || !ESCROW_ACCEPTS.has(sel.shareToken) || selValue <= 0) return;
  const risky = $("ackRow").style.display === "flex";
  const v = Number($<HTMLInputElement>("borrowRange").value) || 0;
  btn.disabled = v <= 0 || (risky && !$<HTMLInputElement>("ack").checked);
  btn.textContent = `Review & borrow $${fmt(v)}`;
}

function randomLoanId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32))).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function borrow() {
  if (!address || !sel) return;
  const v = Number($<HTMLInputElement>("borrowRange").value) || 0;
  if (v <= 0) return;
  const btn = $<HTMLButtonElement>("borrowBtn");
  btn.disabled = true; btn.textContent = "Pledging collateral…";
  const loanId = randomLoanId();
  const aprBps = Math.round((APR_BY_CLASS[sel.underlyingClass] ?? 0.14) * 10000);
  try {
    const tx = await invoke(ESCROW, "deposit", [
      sBytes32(loanId), sAddr(address), sAddr(sel.shareToken),
      sI128(selRaw), sI128(BigInt(Math.round(v * ONE))), sU32(aprBps), sEnum("OpenEnded"), sU32(0),
    ], address);
    toast("Collateral pledged — funding your USDC…", { tx });
    btn.textContent = "Waiting for disbursement…";
    const funded = await waitForDisburse(loanId);
    if (funded) toast("Borrowed! USDC is in your wallet.", {});
    else toast("Collateral locked; disbursement is pending (treasury).", {});
    await select(list.indexOf(sel));
  } catch (e) {
    toast(friendly((e as Error)?.message), { err: true });
    syncBtn();
  }
}

async function waitForDisburse(loanId: string): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < 45000) {
    try {
      const loan = await readCall<Record<string, unknown>>(ESCROW, "get_loan", [sBytes32(loanId)], address || ESCROW);
      if (String(loan.status) === "Active") return true;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 3000));
  }
  return false;
}

function friendly(msg = ""): string {
  if (/AssetNotAllowed|#\s*3\b/i.test(msg)) return "The escrow doesn't accept this collateral token yet.";
  if (/getAccount|not.*found|404/i.test(msg)) return "Fund XLM for fees first (use the faucet).";
  if (/reject|denied|cancel/i.test(msg)) return "You cancelled the signature.";
  if (/BadAmount|#\s*/i.test(msg)) return "Check the amount and try again.";
  return "Couldn't open the line right now. Try again.";
}

function wire() {
  $("walletBtn").addEventListener("click", async () => {
    try {
      address = await connect();
      $("walletLbl").textContent = short(address);
      renderList();
      if (sel) await select(list.indexOf(sel));
    } catch { toast("Wallet connection cancelled", { err: true }); }
  });
  $("borrowRange").addEventListener("input", calc);
  $("ack").addEventListener("change", syncBtn);
  $("borrowBtn").addEventListener("click", borrow);
  loadList().then(renderList);
}

wire();
