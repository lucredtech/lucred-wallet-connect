// LCRD testnet faucet — drip test USDC + dfTEST (and fund XLM via Friendbot) to a connected wallet.
// Wired to the live testnet faucet contracts. Our USDC/dfTEST are Soroban contract tokens, so there
// are no trustlines to establish — a claim is just one `drip` signature.
import "./ui.css";
import "./creditWaitlist"; // shared footer + waitlist on every /credit page
import { connect, restoreSession, invoke, readCall, sAddr } from "./soroban";

// --- deployed testnet contracts ---
const POOL = "CDW4G2YMN5RIXFTS6CW6XVNKPHJI4WZNAMUNHVKQZBD3G7QT45HELX63";
const USDC = "CDXDVJLAYLFR2BRDHVUHM5NSVEN5EJVC5QPKW5I7LWNFKMQFX35V35ZJ"; // pool USDC
const POOL_FAUCET = "CAQWIO5LBNYTM6ZOPUB57WXDDXTJCKROAWBRBQY4V67GZQJIKQ4RXDYV"; // drips pool USDC
const VAULT = "CCMJ4NKHFHD26Z3OIXIU2MNY3IZZJK2HAIDQI5HECYOE27RXORBB6HKA";
const DFTEST = "CDCW5LKOFURA3H2FN7UQNVDLHO6NGUWDZKJRKAITHFLRYG2KBSJCM6UI"; // mock dfToken (escrow flow)
const ESCROW_FAUCET = "CB5LTMEKUKMSTRBC4CMML5YAHBCPHIDTPZ6F6INKX56FS6XA73C4Y7S3"; // drips dfTEST (+ escrow USDC)
const EXPLORER = "https://stellar.expert/explorer/testnet";
const COOLDOWN_MS = 3600 * 1000; // faucet cooldown is 1h per asset

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
let address: string | null = null;

// ---- toast ----
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

const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
const fmt = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 2 });

async function tokenBalance(token: string, who: string): Promise<number> {
  try {
    const raw = await readCall<bigint | number>(token, "balance", [sAddr(who)], who);
    return Number(raw) / 1e7;
  } catch {
    return 0;
  }
}

async function xlmBalance(who: string): Promise<number | null> {
  try {
    const res = await fetch(`https://horizon-testnet.stellar.org/accounts/${who}`);
    if (!res.ok) return res.status === 404 ? null : 0; // 404 = account not funded yet
    const data = await res.json();
    const native = (data.balances || []).find((b: { asset_type: string }) => b.asset_type === "native");
    return native ? Number(native.balance) : 0;
  } catch {
    return 0;
  }
}

async function refresh() {
  if (!address) return;
  $("bal-usdc").textContent = "…";
  $("bal-df").textContent = "…";
  $("bal-xlm").textContent = "…";
  const [u, d, x] = await Promise.all([tokenBalance(USDC, address), tokenBalance(DFTEST, address), xlmBalance(address)]);
  $("bal-usdc").textContent = fmt(u);
  $("bal-df").textContent = fmt(d);
  $("bal-xlm").textContent = x === null ? "not funded" : fmt(x);
}

// ---- cooldown: remember last claim per asset (per viewer), show a countdown instead of a dead button ----
function cooldownKey(asset: string) {
  return `lcrd.faucet.${asset}.${address}`;
}
function startCooldown(btn: HTMLButtonElement, asset: string, label: string) {
  try { localStorage.setItem(cooldownKey(asset), String(Date.now())); } catch { /* ignore */ }
  tickCooldown(btn, asset, label);
}
function tickCooldown(btn: HTMLButtonElement, asset: string, label: string) {
  let last = 0;
  try { last = Number(localStorage.getItem(cooldownKey(asset)) || 0); } catch { /* ignore */ }
  const left = last + COOLDOWN_MS - Date.now();
  if (left <= 0) {
    btn.disabled = false;
    btn.textContent = label;
    return;
  }
  btn.disabled = true;
  const m = Math.ceil(left / 60000);
  btn.textContent = `Again in ${m}m`;
  window.setTimeout(() => tickCooldown(btn, asset, label), 30000);
}

async function claim(btn: HTMLButtonElement, faucet: string, asset: string, label: string) {
  if (!address) return;
  btn.disabled = true;
  const prev = btn.textContent;
  btn.textContent = "Claiming…";
  try {
    const tx = await invoke(faucet, "drip", [sAddr(address)], address);
    toast(`${asset} sent to your wallet`, { tx });
    startCooldown(btn, asset, label);
    await refresh();
  } catch (e) {
    const msg = (e as Error)?.message || "";
    if (/Cooldown|#\s*\d/.test(msg) && /ooldown/i.test(msg)) {
      toast("On cooldown — try again later", { err: true });
      startCooldown(btn, asset, label);
    } else {
      toast(friendlyError(msg), { err: true });
      btn.disabled = false;
      btn.textContent = prev;
    }
  }
}

function friendlyError(msg: string): string {
  if (/Cooldown/i.test(msg)) return "On cooldown — one claim per asset each hour.";
  if (/getAccount|not.*found|404/i.test(msg)) return "Fund XLM first so you can pay the network fee.";
  if (/reject|denied|cancel/i.test(msg)) return "You cancelled the signature.";
  return "Couldn't claim right now. Try again in a moment.";
}

async function fundXlm() {
  if (!address) return;
  const btn = $<HTMLButtonElement>("btn-xlm");
  btn.disabled = true;
  btn.textContent = "Funding…";
  try {
    const res = await fetch(`https://friendbot.stellar.org/?addr=${encodeURIComponent(address)}`);
    if (res.ok) toast("XLM funded via Friendbot");
    else toast("This account already has XLM", {});
  } catch {
    toast("Couldn't reach Friendbot", { err: true });
  }
  btn.disabled = false;
  btn.textContent = "Fund XLM";
  await refresh();
}

function enableButtons(on: boolean) {
  (["btn-usdc", "btn-df", "btn-xlm"] as const).forEach((id) => {
    $<HTMLButtonElement>(id).disabled = !on;
  });
  if (on && address) {
    tickCooldown($<HTMLButtonElement>("btn-usdc"), "usdc", "Get 2,000 USDC");
    tickCooldown($<HTMLButtonElement>("btn-df"), "df", "Get dfTEST");
  }
}

function initLinks() {
  const set = (id: string, c: string) => { ($(id) as HTMLAnchorElement).href = `${EXPLORER}/contract/${c}`; };
  set("lnk-pool", POOL); set("lnk-usdc", USDC); set("lnk-vault", VAULT); set("lnk-df", DFTEST);
  $("addr-usdc").textContent = short(USDC);
  $("addr-df").textContent = short(DFTEST);
}

function wire() {
  initLinks();
  $("walletBtn").addEventListener("click", async () => {
    try {
      address = await connect();
      $("walletLbl").textContent = short(address);
      enableButtons(true);
      await refresh();
    } catch {
      toast("Wallet connection cancelled", { err: true });
    }
  });
  $("btn-usdc").addEventListener("click", () => claim($<HTMLButtonElement>("btn-usdc"), POOL_FAUCET, "usdc", "Get 2,000 USDC"));
  $("btn-df").addEventListener("click", () => claim($<HTMLButtonElement>("btn-df"), ESCROW_FAUCET, "df", "Get dfTEST"));
  $("btn-xlm").addEventListener("click", fundXlm);
  restoreSession().then((a) => { if (a) { address = a; $("walletLbl").textContent = short(a); enableButtons(true); refresh(); } });
}

wire();
