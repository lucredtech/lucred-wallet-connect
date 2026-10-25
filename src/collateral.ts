// LCRD Borrow-on-collateral — pick a supported vault/LP share-token (from the on-chain collateral
// registry via GET /collateral/supported), value the wallet's position on-chain, size + price the
// line, and open it by depositing the collateral into the Stage-B escrow (the auto-disburser then
// sends the USDC). Tokens the escrow doesn't yet accept show a quote only.
import "./ui.css";
import "./creditWaitlist"; // shared footer + waitlist on every /credit page
import { connect, restoreSession, invoke, readCall, sAddr, sI128, sU32, sBytes32, sEnum, getContractEvents } from "./soroban";

const ESCROW = "CCM4QHKGCEAE3FKNB3SGJ74ZHPHLWNAAB5BBVMDECXISB26MXAPHNFZG";
const DFTEST = "CDCW5LKOFURA3H2FN7UQNVDLHO6NGUWDZKJRKAITHFLRYG2KBSJCM6UI";
const DFUSDC = "CCMJ4NKHFHD26Z3OIXIU2MNY3IZZJK2HAIDQI5HECYOE27RXORBB6HKA";
const EXPLORER = "https://stellar.expert/explorer/testnet";
const API = import.meta.env.VITE_CREDIT_SCORE_API_URL as string | undefined;
const ONE = 10_000_000;
// Which collateral the Stage-B escrow currently accepts on-chain (its set_asset allowlist).
const ESCROW_ACCEPTS = new Set([DFTEST]);
// The LCRD Earn pool — SAME contract the Earn page deposits into (src/earn.ts). A deposit there gives you
// pool shares (not a token), which back a secured line via open_secured_line — surfaced in the pool card.
const POOL = "CDW4G2YMN5RIXFTS6CW6XVNKPHJI4WZNAMUNHVKQZBD3G7QT45HELX63";
// Indicative borrow APR by underlying risk class (the real rate comes from the engine at quote time).
const APR_BY_CLASS: Record<string, number> = { stable: 0.14, stableFx: 0.145, rwa: 0.16, major: 0.165, incentive: 0.175, curated: 0.185 };

interface Collat { shareToken: string; symbol: string; label: string; kind: string; underlyingClass: string; advanceRate: number; liquidationLtv: number; priceSource: string; parUsd: number | null; }

// Fallback mirrors the testnet registry so the page works before /collateral/supported is deployed.
const FALLBACK: Collat[] = [
  { shareToken: DFUSDC, symbol: "dfUSDC", label: "DeFindex USDC Vault", kind: "vault", underlyingClass: "stable", advanceRate: 0.75, liquidationLtv: 0.92, priceSource: "underlying", parUsd: null },
  { shareToken: DFTEST, symbol: "dfTEST", label: "Test dfToken", kind: "vault", underlyingClass: "stable", advanceRate: 0.70, liquidationLtv: 0.90, priceSource: "par", parUsd: 1 },
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
  // Actionable toasts (with a "view" link) linger longer; pause the dismiss while hovered so the link
  // stays clickable.
  const ms = opts.tx ? 6000 : 5000;
  const arm = () => { window.clearTimeout(toastT); toastT = window.setTimeout(() => el.classList.remove("show"), ms); };
  arm();
  el.onmouseenter = () => window.clearTimeout(toastT);
  el.onmouseleave = arm;
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
    rememberLoan(loanId); // so it shows under "Your open loans" for repay/close
    toast("Collateral pledged — funding your USDC…", { tx });
    btn.textContent = "Waiting for disbursement…";
    const funded = await waitForDisburse(loanId);
    if (funded) toast("Borrowed! USDC is in your wallet.", {});
    else toast("Collateral locked; disbursement is pending (treasury).", {});
    await select(list.indexOf(sel));
    await loadLoans();
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

// ---------- Your open loans (repay / close) ----------
// The escrow has no "loans by borrower" view, so we discover the wallet's loan ids from its own
// deposit events (within the RPC retention window) and merge any we've saved locally on pledge.
const loansKey = () => `lcrd.collateralLoans.${address}`;
function storedLoans(): string[] {
  try { return JSON.parse(localStorage.getItem(loansKey()) || "[]"); } catch { return []; }
}
function rememberLoan(id: string) {
  try { const s = new Set(storedLoans()); s.add(id); localStorage.setItem(loansKey(), JSON.stringify([...s])); } catch { /* private mode */ }
}
function toHex(v: unknown): string {
  if (typeof v === "string") return v.replace(/^0x/, "");
  if (v instanceof Uint8Array || Array.isArray(v)) return Array.from(v as Uint8Array).map((b) => b.toString(16).padStart(2, "0")).join("");
  return "";
}

interface Loan { id: string; status: string; collateral_token: string; collateral_amount: bigint; debt: bigint; apr_bps: number; }

async function loadLoans() {
  if (!address) return;
  const card = $("loansCard");
  const box = $("loansList");
  const ids = new Set<string>(storedLoans());
  try {
    const evs = await getContractEvents(ESCROW, 80);
    for (const e of evs) {
      if (String(e.topics[0]) !== "deposit") continue;
      if ((typeof e.topics[1] === "string" ? e.topics[1] : "") !== address) continue;
      const id = toHex(Array.isArray(e.value) ? (e.value as unknown[])[0] : null);
      if (id) ids.add(id);
    }
  } catch { /* fall back to stored ids only */ }

  const loans: Loan[] = [];
  for (const id of ids) {
    try {
      const l = await readCall<Record<string, unknown>>(ESCROW, "get_loan", [sBytes32(id)], address);
      if (l && String(l.status) !== "Closed") {
        loans.push({ id, status: String(l.status), collateral_token: String(l.collateral_token),
          collateral_amount: BigInt(String(l.collateral_amount)), debt: BigInt(String(l.debt)), apr_bps: Number(l.apr_bps) });
      }
    } catch { /* unreadable/old id — skip */ }
  }

  if (!loans.length) { card.hidden = true; return; }
  card.hidden = false;
  box.innerHTML = "";
  for (const l of loans) {
    const tok = list.find((c) => c.shareToken === l.collateral_token);
    const sym = tok ? tok.symbol : short(l.collateral_token);
    const owed = Number(l.debt) / ONE;
    const coll = Number(l.collateral_amount) / ONE;
    const row = document.createElement("div");
    row.className = "lv";
    row.style.cssText = "display:block;padding:14px 0;";
    row.innerHTML =
      `<div class="between" style="margin-bottom:8px;">
         <div><div style="font-weight:600;">${coll.toLocaleString("en-US", { maximumFractionDigits: 2 })} ${sym} pledged</div>
         <div class="tiny faint mono">loan ${l.id.slice(0, 6)}… · ${(l.apr_bps / 100).toFixed(1)}% APR</div></div>
         <div style="text-align:right;"><div class="sm muted">Owed</div><div class="mono" style="font-weight:700;">$${usd2(owed)}</div></div>
       </div>
       <div class="row" style="gap:8px;">
         <button class="btn btn-primary ln-repay" data-id="${l.id}" ${owed <= 0 ? "disabled" : ""} style="flex:1;justify-content:center;">${owed <= 0 ? "Repaid" : `Repay $${usd2(owed)}`}</button>
         <button class="btn ln-close" data-id="${l.id}" ${owed > 0 ? "disabled" : ""} style="flex:1;justify-content:center;">Close &amp; unlock</button>
       </div>`;
    box.append(row);
  }
  box.querySelectorAll<HTMLButtonElement>(".ln-repay").forEach((b) => b.addEventListener("click", () => repayLoan(b.dataset.id!, b)));
  box.querySelectorAll<HTMLButtonElement>(".ln-close").forEach((b) => b.addEventListener("click", () => closeLoan(b.dataset.id!, b)));
}

async function repayLoan(id: string, btn: HTMLButtonElement) {
  if (!address) return;
  const prev = btn.textContent;
  btn.disabled = true; btn.textContent = "Repaying…";
  try {
    const payoff = BigInt(String(await readCall<bigint>(ESCROW, "payoff", [sBytes32(id)], address)));
    // Overpay by a small buffer: interest keeps accruing between this read and the tx landing, which
    // would leave a dust debt that blocks `close`. The contract caps the pull at the true debt, so
    // overpaying never overcharges.
    const amount = payoff + payoff / 100n + 100000n;
    const tx = await invoke(ESCROW, "repay", [sBytes32(id), sI128(amount)], address);
    toast("Loan repaid — you can now unlock your collateral.", { tx });
    await loadLoans();
  } catch (e) {
    toast(friendly((e as Error)?.message), { err: true });
    btn.disabled = false; btn.textContent = prev;
  }
}

async function closeLoan(id: string, btn: HTMLButtonElement) {
  if (!address) return;
  const prev = btn.textContent;
  btn.disabled = true; btn.textContent = "Unlocking…";
  try {
    const tx = await invoke(ESCROW, "close", [sBytes32(id)], address);
    toast("Collateral returned to your wallet.", { tx });
    if (sel) await select(list.indexOf(sel)); // refresh the balance of the pledged token
    await loadLoans();
  } catch (e) {
    toast(friendly((e as Error)?.message), { err: true });
    btn.disabled = false; btn.textContent = prev;
  }
}

// ---------- Your LCRD pool position (secured line via open_secured_line) ----------
// A deposit in the Earn pool mints internal pool SHARES (not a token the escrow above can see), so it
// can't appear in the dfToken list. Instead it backs a SECURED line on the pool itself — opened here.
async function renderPoolCard() {
  const body = $("poolBody");
  if (!address) { $("poolCard").hidden = true; return; }
  $("poolCard").hidden = false;
  body.innerHTML = `<p class="sm muted">Loading your pool position…</p>`;
  try {
    const shares = BigInt(await readCall<bigint>(POOL, "shares_of", [sAddr(address)], address));
    if (shares <= 0n) {
      body.innerHTML = `<p class="sm muted">You haven't deposited in the Earn pool yet. Deposit USDC to earn yield and unlock a <b>secured credit line</b> against it — no score needed.</p>
        <a class="btn btn-primary" href="earn.html" style="margin-top:12px;display:inline-flex;justify-content:center;">Go to Earn →</a>`;
      return;
    }
    const [valueRaw, capRaw, line, owedArr, availRaw] = await Promise.all([
      readCall<bigint>(POOL, "collateral_value", [sAddr(address)], address),
      readCall<bigint>(POOL, "secured_capacity", [sAddr(address)], address),
      readCall<Record<string, unknown>>(POOL, "get_line", [sAddr(address)], address),
      readCall<[bigint, bigint]>(POOL, "owed", [sAddr(address)], address),
      readCall<bigint>(POOL, "available", [sAddr(address)], address),
    ]);
    const value = Number(valueRaw) / ONE;
    const cap = Number(capRaw) / ONE;
    const owed = (Number(owedArr[0]) + Number(owedArr[1])) / ONE;
    const avail = Number(availRaw) / ONE;
    const active = (line.active as boolean) && (line.secured as boolean);
    const apr = Number(line.apr_bps) / 100;

    if (!active) {
      body.innerHTML =
        `<div class="lv"><span class="muted">Earn pool position</span><span class="mono" style="font-weight:700">$${usd2(value)}</span></div>
         <div class="lv"><span class="muted">Borrow up to (71.25%)</span><span class="mono" style="font-weight:700">$${fmt(cap)}</span></div>
         <p class="sm muted" style="margin:10px 0 14px">Open a secured line against your pool deposit — no score needed. Your deposit keeps earning yield while it backs the line.</p>
         <button class="btn btn-primary" id="poolOpen" style="width:100%;justify-content:center">Open secured line</button>`;
      $("poolOpen").addEventListener("click", poolOpenLine);
      return;
    }
    body.innerHTML =
      `<div class="lv"><span class="muted">Secured line</span><span class="mono" style="font-weight:700">$${fmt(Number(line.limit) / ONE)} @ ${apr.toFixed(1)}%</span></div>
       <div class="lv"><span class="muted">Owed</span><span class="mono" style="font-weight:700">$${usd2(owed)}</span></div>
       <div class="lv"><span class="muted">Available to draw</span><span class="mono" style="font-weight:700">$${fmt(avail)}</span></div>
       <div class="row" style="gap:8px;margin-top:14px">
         <input id="poolAmt" class="field" type="number" min="0" placeholder="Amount USDC" style="flex:1;min-width:0" />
         <button class="btn btn-primary" id="poolBorrow">Borrow</button>
       </div>
       <button class="btn" id="poolRepay" style="width:100%;justify-content:center;margin-top:8px" ${owed <= 0 ? "disabled" : ""}>${owed <= 0 ? "Nothing owed" : `Repay $${usd2(owed)}`}</button>`;
    $("poolBorrow").addEventListener("click", poolBorrow);
    $("poolRepay").addEventListener("click", poolRepay);
  } catch (e) {
    body.innerHTML = `<p class="sm muted">Couldn't read your pool position — ${friendly((e as Error)?.message)}</p>`;
  }
}

async function poolOpenLine() {
  if (!address) return;
  const btn = $<HTMLButtonElement>("poolOpen"); btn.disabled = true; btn.textContent = "Opening…";
  try {
    const tx = await invoke(POOL, "open_secured_line", [sAddr(address)], address);
    toast("Secured line opened against your pool position.", { tx });
    await renderPoolCard();
  } catch (e) { toast(friendly((e as Error)?.message), { err: true }); btn.disabled = false; btn.textContent = "Open secured line"; }
}

async function poolBorrow() {
  if (!address) return;
  const v = Number($<HTMLInputElement>("poolAmt").value) || 0;
  if (v <= 0) { toast("Enter an amount to borrow.", { err: true }); return; }
  const btn = $<HTMLButtonElement>("poolBorrow"); btn.disabled = true; btn.textContent = "Borrowing…";
  try {
    const tx = await invoke(POOL, "borrow", [sAddr(address), sI128(BigInt(Math.round(v * ONE)))], address);
    toast("Borrowed! USDC is in your wallet.", { tx });
    await renderPoolCard();
  } catch (e) { toast(friendly((e as Error)?.message), { err: true }); btn.disabled = false; btn.textContent = "Borrow"; }
}

async function poolRepay() {
  if (!address) return;
  const btn = $<HTMLButtonElement>("poolRepay"); btn.disabled = true; btn.textContent = "Repaying…";
  try {
    const owedArr = await readCall<[bigint, bigint]>(POOL, "owed", [sAddr(address)], address);
    const payoff = BigInt(owedArr[0]) + BigInt(owedArr[1]);
    // Overpay by a small buffer; interest accrues between this read and the tx, and the contract caps the
    // pull at the true debt, so overpaying never overcharges.
    const amount = payoff + payoff / 100n + 100000n;
    const tx = await invoke(POOL, "repay", [sAddr(address), sAddr(address), sI128(amount)], address);
    toast("Secured line repaid.", { tx });
    await renderPoolCard();
  } catch (e) { toast(friendly((e as Error)?.message), { err: true }); await renderPoolCard(); }
}

function wire() {
  $("walletBtn").addEventListener("click", async () => {
    try {
      address = await connect();
      $("walletLbl").textContent = short(address);
      renderList();
      await renderPoolCard();
      if (sel) await select(list.indexOf(sel));
      await loadLoans();
    } catch { toast("Wallet connection cancelled", { err: true }); }
  });
  $("borrowRange").addEventListener("input", calc);
  $("ack").addEventListener("change", syncBtn);
  $("borrowBtn").addEventListener("click", borrow);
  loadList().then(() => {
    renderList();
    restoreSession().then((a) => { if (a) { address = a; $("walletLbl").textContent = short(a); renderList(); renderPoolCard(); loadLoans(); } });
  });
}

wire();
