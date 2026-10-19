// LCRD Borrow-on-score — show the wallet's credit score (score-api), the on-chain repayment ladder
// and line (credit-line pool), and draw/repay against an active unsecured line.
import "./ui.css";
import { connect, invoke, readCall, sAddr, sI128, sU32 } from "./soroban";

const POOL = "CBW426LFZAFUW2YMPUFZRMEV6VCZ2XSVOMHFQS7C6VCO4DIVK6SDB5ZP";
const API = import.meta.env.VITE_CREDIT_SCORE_API_URL as string | undefined;
const EXPLORER = "https://stellar.expert/explorer/testnet";
const ONE = 10_000_000;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
let address: string | null = null;

const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
const fromBase = (b: bigint | number) => Number(b) / ONE;
const toBase = (s: string) => BigInt(Math.round((Number(s) || 0) * ONE));
const usd = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 0 });
const pctApr = (bps: number) => (bps / 100).toFixed(2) + "%";

let toastT: number | undefined;
function toast(msg: string, opts: { tx?: string; err?: boolean } = {}) {
  const el = $("toast");
  el.className = opts.err ? "err" : "";
  el.innerHTML = msg + (opts.tx ? ` <a href="${EXPLORER}/tx/${opts.tx}" target="_blank" rel="noopener">view ↗</a>` : "");
  el.classList.add("show");
  window.clearTimeout(toastT);
  toastT = window.setTimeout(() => el.classList.remove("show"), 3200);
}

function renderGauge(score: number | null) {
  const pct = score == null ? 0 : Math.max(0, Math.min(1, score / 100));
  const cx = 110, cy = 110, r = 86;
  const pt = (a: number): [number, number] => [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  const [sx, sy] = pt(Math.PI), [ex, ey] = pt(2 * Math.PI), [px, py] = pt(Math.PI * (1 + pct));
  // the colored arc is only drawn once we have a score; pre-connect we show just the track + a muted dash
  const fill = score == null ? "" :
    `<path d="M${sx} ${sy} A${r} ${r} 0 0 1 ${px} ${py}" fill="none" stroke="var(--brand)" stroke-width="14" stroke-linecap="round"/>`;
  $("gauge").innerHTML =
    `<svg viewBox="0 0 220 128" width="220" style="max-width:100%">
      <path d="M${sx} ${sy} A${r} ${r} 0 0 1 ${ex} ${ey}" fill="none" stroke="var(--line)" stroke-width="14" stroke-linecap="round"/>
      ${fill}
    </svg>` +
    `<div style="font-family:var(--font-d);font-weight:800;font-size:52px;line-height:1;margin-top:-26px;color:${score == null ? "var(--faint)" : "var(--ink)"};">${score == null ? "—" : score}</div>`;
}

async function fetchScore(): Promise<{ score: number; tier: string } | null> {
  if (!API || !address) return null;
  try {
    const res = await fetch(`${API.replace(/\/$/, "")}/credit-line?wallet=${encodeURIComponent(address)}`);
    if (!res.ok) return null;
    const data = await res.json();
    // /credit-line returns the score + tier under `inputs`; fall back to a flat/object `score`.
    const s = (data.inputs && typeof data.inputs === "object" ? data.inputs
      : data.score && typeof data.score === "object" ? data.score
      : data);
    return { score: Math.round(Number(s.score) || 0), tier: String(s.tier || "—") };
  } catch {
    return null;
  }
}

async function renderLadder(score: number, cyclesDone: number) {
  // quote(score, cycles) -> [tier, apr_bps, max_limit]; show the limit at each cycle count.
  try {
    const rungs = await Promise.all([0, 1, 2, 3].map((c) =>
      readCall<[number, number, bigint]>(POOL, "quote", [sU32(score), sU32(c)], address || POOL)));
    const limits = rungs.map((r) => fromBase(r[2]));
    if (limits[0] <= 0) {
      $("ladder").innerHTML = `<span class="muted">This score doesn't support an unsecured line yet. Build history with a secured line first.</span>`;
      $("ladder-note").hidden = true;
      return;
    }
    const max = Math.max(...limits, 1);
    $("ladder").innerHTML = `<div style="display:flex;align-items:flex-end;gap:8px;height:120px;">` +
      limits.map((l, i) => {
        const h = Math.max(18, Math.round((l / max) * 110));
        const on = i <= cyclesDone;
        const bg = on ? "var(--brand)" : "var(--brand-tint)";
        return `<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:7px;justify-content:flex-end;">
          <div style="width:100%;height:${h}px;border-radius:7px 7px 0 0;background:${bg};"></div>
          <div class="tiny" style="color:${on ? "var(--brand)" : "var(--muted)"};font-weight:600;">$${usd(l)}</div>
          <div class="tiny faint">cycle ${i}</div></div>`;
      }).join("") + `</div>`;
    const next = limits[Math.min(cyclesDone + 1, limits.length - 1)];
    const cur = limits[Math.min(cyclesDone, limits.length - 1)];
    if (next > cur) {
      $("ladder-note").hidden = false;
      $("ladder-note").innerHTML = `Repay this cycle on time → your limit rises <b>$${usd(cur)} → $${usd(next)}</b>.`;
    } else $("ladder-note").hidden = true;
  } catch {
    $("ladder").innerHTML = `<span class="muted">Couldn't read the ladder right now.</span>`;
  }
}

async function renderLine() {
  if (!address) return;
  try {
    const [line, avail, owed] = await Promise.all([
      readCall<Record<string, unknown>>(POOL, "get_line", [sAddr(address)], address),
      readCall<bigint>(POOL, "available", [sAddr(address)], address),
      readCall<[bigint, bigint]>(POOL, "owed", [sAddr(address)], address),
    ]);
    const active = line.active as boolean;
    const limit = fromBase(line.limit as bigint);
    const hasLine = active && limit > 0;
    if (hasLine) {
      const tier = ["—", "A", "B", "C"][Number(line.tier)] ?? "—";
      $("line-chip").hidden = false;
      $("line-chip").textContent = `${line.secured ? "Secured" : "Unsecured"} · tier ${tier}`;
      $("line-body").innerHTML = `${pctApr(Number(line.apr_bps))} APR · limit <b>$${usd(limit)}</b>`;
      $("draw-wrap").hidden = false;
      $("avail").textContent = "$" + usd(fromBase(avail));
      $("owed").textContent = "$" + usd(fromBase(owed[0] + owed[1]));
      $("fallback").hidden = true;
    } else {
      $("line-chip").hidden = true;
      $("line-body").textContent = "You don't have an active unsecured line on this pool yet.";
      $("draw-wrap").hidden = true;
      $("fallback").hidden = false;
    }
  } catch {
    $("line-body").textContent = "Couldn't read your line right now.";
  }
}

async function load() {
  if (!address) return;
  const sc = await fetchScore();
  const score = sc ? sc.score : 0;
  renderGauge(score);
  $("score-chips").innerHTML =
    `<span class="chip good">Tier ${sc ? sc.tier : "—"}</span><span class="chip">Updated ${new Date().toLocaleDateString()}</span>`;
  const hist = await readCall<Record<string, unknown>>(POOL, "get_history", [sAddr(address)], address).catch(() => ({ cycles_completed: 0 }));
  await renderLadder(score, Number((hist as Record<string, unknown>).cycles_completed || 0));
  await renderLine();
}

async function act(kind: "borrow" | "repay") {
  if (!address) return;
  const base = toBase($<HTMLInputElement>("amt").value);
  if (base <= 0n) return toast("Enter an amount.", { err: true });
  const btn = $<HTMLButtonElement>(kind === "borrow" ? "btn-borrow" : "btn-repay");
  const prev = btn.textContent;
  btn.disabled = true; btn.textContent = "…";
  try {
    const args = kind === "borrow"
      ? [sAddr(address), sI128(base)]
      : [sAddr(address), sAddr(address), sI128(base)];
    const tx = await invoke(POOL, kind, args, address);
    toast(kind === "borrow" ? "Drawn to your wallet" : "Repaid", { tx });
    $<HTMLInputElement>("amt").value = "";
    await load();
  } catch (e) {
    toast(friendly((e as Error)?.message), { err: true });
  }
  btn.disabled = false; btn.textContent = prev || (kind === "borrow" ? "Draw" : "Repay");
}

function friendly(msg = ""): string {
  if (/#\s*11|OverLimit/i.test(msg)) return "That's more than your limit — complete a cycle to grow it.";
  if (/#\s*12|InsufficientLiquidity/i.test(msg)) return "The pool is short on liquid USDC — try less.";
  if (/#\s*10|LineInactive/i.test(msg)) return "Your line isn't active.";
  if (/#\s*14|NothingOwed/i.test(msg)) return "Nothing is owed on this line.";
  if (/getAccount|not.*found|404/i.test(msg)) return "Fund XLM for fees first (use the faucet).";
  if (/reject|denied|cancel/i.test(msg)) return "You cancelled the signature.";
  return "Couldn't complete that right now.";
}

function wire() {
  $("walletBtn").addEventListener("click", async () => {
    try {
      address = await connect();
      $("walletLbl").textContent = short(address);
      await load();
    } catch { toast("Wallet connection cancelled", { err: true }); }
  });
  $("btn-borrow").addEventListener("click", () => act("borrow"));
  $("btn-repay").addEventListener("click", () => act("repay"));
}

renderGauge(null); // placeholder so the score card keeps its shape before a wallet connects
wire();
