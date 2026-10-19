// LCRD Activity — a live, human-readable feed of the pool's on-chain events (deposits, withdrawals,
// borrows, repayments, cycles, vault moves). Toggle between the whole pool and just your wallet.
import "./ui.css";
import { connect, getContractEvents, latestLedgerSeq, explorerTx } from "./soroban";
import type { ActivityEvent } from "./soroban";

const POOL = "CD4XBOWYMD53Y2HT5K3ICOTQ5IVATV6PZFZ77VWIUVP3IL5DZVBPXUX6";
const ONE = 10_000_000;
const LEDGER_SEC = 5; // ~5s per ledger on testnet, for age estimates

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
const usd = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fromBase = (b: bigint | number) => Number(b) / ONE;
const pct = (bps: number) => (bps / 100).toFixed(2) + "%";

let address: string | null = null;
let mode: "pool" | "you" = "pool";
let events: ActivityEvent[] = [];
let latest = 0;

let toastT: number | undefined;
function toast(msg: string, err = false) {
  const el = $("toast"); el.className = err ? "err" : ""; el.textContent = msg;
  el.classList.add("show"); window.clearTimeout(toastT);
  toastT = window.setTimeout(() => el.classList.remove("show"), 3000);
}

function ageOf(ledger: number): string {
  if (!latest || !ledger) return "";
  const secs = Math.max(0, (latest - ledger) * LEDGER_SEC);
  if (secs < 90) return "just now";
  const m = Math.round(secs / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

// per event type: badge glyph, badge colors, title text + amount, and whether it's a user action.
type Meta = { glyph: string; bg: string; fg: string; title: string; amount: string; userEvent: boolean };
function metaFor(e: ActivityEvent): Meta {
  const t = String(e.topics[0] ?? "");
  const who = typeof e.topics[1] === "string" ? (e.topics[1] as string) : "";
  const v = e.value as unknown;
  const arr = Array.isArray(v) ? (v as unknown[]) : [];
  const n = (x: unknown) => fromBase(typeof x === "bigint" ? x : BigInt((x as number | string) ?? 0));
  const tint = (c: string) => `color-mix(in srgb, var(--${c}) 16%, transparent)`;
  const base = { glyph: "•", bg: "var(--surface-2)", fg: "var(--muted)", title: t, amount: "", userEvent: !!who };
  switch (t) {
    case "deposited": return { ...base, glyph: "↓", bg: tint("good"), fg: "var(--good)", title: "Deposit", amount: `+${n(arr[0])} USDC` };
    case "withdrawn": return { ...base, glyph: "↑", bg: "var(--surface-2)", fg: "var(--muted)", title: "Withdraw", amount: `−${n(arr[0])} USDC` };
    case "borrowed": return { ...base, glyph: "→", bg: tint("brand"), fg: "var(--brand)", title: "Borrow", amount: `${n(v)} USDC` };
    case "repaid": return { ...base, glyph: "✓", bg: tint("good"), fg: "var(--good)", title: "Repay", amount: `${n(((arr[1] as bigint) ?? 0n) + ((arr[2] as bigint) ?? 0n))} USDC` };
    case "line_set": return { ...base, glyph: "◆", bg: tint("brand"), fg: "var(--brand)", title: "Line opened", amount: `${n(arr[0])} @ ${pct(Number(arr[3]))}` };
    case "secured": return { ...base, glyph: "◆", bg: tint("brand"), fg: "var(--brand)", title: "Secured line", amount: `${n(arr[0])} @ ${pct(Number(arr[1]))}` };
    case "cycle": return { ...base, glyph: "↗", bg: tint("gold"), fg: "var(--gold)", title: `Cycle ${Number(arr[0])} — limit up`, amount: `${n(arr[2])} @ ${pct(Number(arr[1]))}` };
    case "invested": return { ...base, glyph: "⇅", bg: "var(--surface-2)", fg: "var(--muted)", title: "Idle USDC → DeFindex vault", amount: `${n(v)} USDC`, userEvent: false };
    case "divested": return { ...base, glyph: "⇅", bg: "var(--surface-2)", fg: "var(--muted)", title: "DeFindex vault → pool", amount: `${n(v)} USDC`, userEvent: false };
    case "writeoff": return { ...base, glyph: "!", bg: tint("danger"), fg: "var(--danger)", title: "Written off", amount: `${n(arr[0])} USDC` };
    case "seized": return { ...base, glyph: "!", bg: tint("danger"), fg: "var(--danger)", title: "Collateral seized", amount: "" };
    case "frozen": return { ...base, glyph: "✕", bg: tint("warn"), fg: "var(--warn)", title: "Line frozen", amount: "" };
    default: return base;
  }
}

function actorOf(e: ActivityEvent): string {
  return typeof e.topics[1] === "string" ? (e.topics[1] as string) : "";
}

function render() {
  const feed = $("feed");
  const rows = events.filter((e) => mode === "pool" || (address && actorOf(e) === address));
  if (!rows.length) {
    feed.innerHTML = `<div class="sm muted">${mode === "you" ? "No on-chain activity for your wallet in the recent window." : "No recent on-chain activity."}</div>`;
    return;
  }
  feed.innerHTML = "";
  for (const e of rows) {
    const m = metaFor(e);
    const who = actorOf(e);
    const row = document.createElement("div");
    row.className = "evrow";
    const sub = [who && mode === "pool" ? short(who) : "", ageOf(e.ledger)].filter(Boolean).join(" · ");
    row.innerHTML =
      `<div class="evdot" style="background:${m.bg};color:${m.fg};">${m.glyph}</div>` +
      `<div class="evmain"><div class="evtitle">${m.title}</div><div class="evsub">${sub}</div></div>` +
      `<div class="evamt"><div>${m.amount}</div>` +
      (e.txHash ? `<a href="${explorerTx(e.txHash)}" target="_blank" rel="noopener">view ↗</a>` : "") +
      `</div>`;
    feed.append(row);
  }
}

function renderSummary() {
  const dep = events.filter((e) => e.topics[0] === "deposited")
    .reduce((s, e) => s + fromBase((e.value as unknown[])?.[0] as bigint ?? 0n), 0);
  const bor = events.filter((e) => e.topics[0] === "borrowed")
    .reduce((s, e) => s + fromBase(e.value as bigint ?? 0n), 0);
  $("sum-dep").textContent = "$" + usd(dep);
  $("sum-bor").textContent = "$" + usd(bor);
  $("sum-ct").textContent = String(events.length);
}

async function load() {
  const feed = $("feed");
  try {
    [events, latest] = await Promise.all([getContractEvents(POOL, 40), latestLedgerSeq().catch(() => 0)]);
    renderSummary();
    render();
  } catch {
    feed.innerHTML = `<div class="sm muted">Couldn't load activity right now.</div>`;
  }
}

function setMode(m: "pool" | "you") {
  mode = m;
  $("seg-pool").setAttribute("aria-selected", String(m === "pool"));
  $("seg-you").setAttribute("aria-selected", String(m === "you"));
  render();
}

function wire() {
  $("seg-pool").addEventListener("click", () => setMode("pool"));
  $("seg-you").addEventListener("click", () => { if (address) setMode("you"); });
  $("btn-refresh").addEventListener("click", load);
  $("walletBtn").addEventListener("click", async () => {
    try {
      address = await connect();
      $("walletLbl").textContent = short(address);
      ($("seg-you") as HTMLButtonElement).disabled = false;
      setMode("you");
    } catch { toast("Wallet connection cancelled", true); }
  });
  load();
}

wire();
