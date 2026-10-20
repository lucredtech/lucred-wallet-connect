// LCRD Earn — deposit USDC to the pool to earn (loan interest + DeFindex vault yield), withdraw anytime.
// Wired to the deployed testnet credit-line pool.
import "./ui.css";
import "./creditWaitlist"; // shared footer + waitlist on every /credit page
import { connect, restoreSession, invoke, readCall, sAddr, sI128 } from "./soroban";

const POOL = "CDW4G2YMN5RIXFTS6CW6XVNKPHJI4WZNAMUNHVKQZBD3G7QT45HELX63";
const USDC = "CDXDVJLAYLFR2BRDHVUHM5NSVEN5EJVC5QPKW5I7LWNFKMQFX35V35ZJ";
const EXPLORER = "https://stellar.expert/explorer/testnet";
const VAULT_APR = 0.10; // the fixed-APR strategy the pool's idle USDC is invested in (deployed rate)
const ONE = 10_000_000;
// A funded testnet account used only as the source for read-only simulations before a wallet is
// connected (lets us show live pool stats pre-connect). Reads don't require its auth.
const READ_SOURCE = "GC6PEHH3UNMWN2V7LS6DRBCF7UNPX6EDZUBZ2MVFZIPHIWWWTQIJ6QBT";

const YEAR_SEC = 365 * 24 * 60 * 60;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
let address: string | null = null;
let shares = 0n; // the connected wallet's pool shares (raw)

// --- live yield counter state ---
// baseWorth/baseAt are the last on-chain reading; between reads we interpolate worth upward at the
// pool's estimated rate (deterministic for the fixed-APR vault), re-syncing on every refresh.
let baseWorth = 0;      // USD worth of the position at the last chain read
let baseAt = 0;         // performance.now() at that read
let tickRate = 0;       // fractional APY used to grow worth (the estimated pool yield)
let costBasis = 0;      // USD principal still invested (net deposits − withdrawals), from localStorage
let basisInferred = false; // true when we had no stored basis and seeded it from current worth
let rafId = 0;

// Cost basis is tracked per wallet+pool in localStorage (the pool contract doesn't store per-user
// principal). It only powers the "earned" figure; the live worth counter works without it.
const basisKey = () => `lcrd.basis.${POOL}.${address}`;
function getBasis(): number | null {
  try { const v = localStorage.getItem(basisKey()); return v == null ? null : Number(v); } catch { return null; }
}
function setBasis(n: number) {
  try { localStorage.setItem(basisKey(), String(Math.max(0, n))); } catch { /* private mode: skip */ }
}

const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
const usd = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fromBase = (b: bigint | number) => Number(b) / ONE;
const toBase = (s: string) => BigInt(Math.round((Number(s) || 0) * ONE));

let toastT: number | undefined;
function toast(msg: string, opts: { tx?: string; err?: boolean } = {}) {
  const el = $("toast");
  el.className = opts.err ? "err" : "";
  el.innerHTML = msg + (opts.tx ? ` <a href="${EXPLORER}/tx/${opts.tx}" target="_blank" rel="noopener">view ↗</a>` : "");
  el.classList.add("show");
  window.clearTimeout(toastT);
  toastT = window.setTimeout(() => el.classList.remove("show"), 3200);
}

async function refresh() {
  try {
    const src = address || READ_SOURCE;
    const [assets, cash, vaultVal, idle] = await Promise.all([
      readCall<bigint>(POOL, "total_assets", [], src),
      readCall<bigint>(POOL, "cash", [], src),
      readCall<bigint>(POOL, "vault_value", [], src),
      readCall<bigint>(POOL, "idle_cash", [], src),
    ]);
    $("pool-assets").textContent = usd(fromBase(assets));
    $("pool-idle").textContent = usd(fromBase(idle));
    $("pool-invested").textContent = usd(fromBase(vaultVal));

    // Estimated APY: vault strategy rate × invested fraction (the vault component), plus borrower
    // interest (variable — labelled separately). Derived from live on-chain composition.
    const liquid = Number(cash);
    const investedFrac = liquid > 0 ? Number(vaultVal) / liquid : 0;
    const estVault = VAULT_APR * investedFrac;
    $("apy").textContent = `~${(estVault * 100).toFixed(1)}%`;
    $("chip-vault").textContent = `+ ${(estVault * 100).toFixed(1)}% DeFindex vault`;
    $("chip-loan").textContent = "+ borrower interest";
    renderProjection(estVault);

    if (address) {
      const [bal, sh] = await Promise.all([
        readCall<bigint>(USDC, "balance", [sAddr(address)], address),
        readCall<bigint>(POOL, "shares_of", [sAddr(address)], address),
      ]);
      $("usdc-bal").textContent = usd(fromBase(bal));
      shares = BigInt(sh);
      const worth = shares > 0n ? await readCall<bigint>(POOL, "convert_to_assets", [sI128(shares)], address) : 0n;
      $("pos-shares").textContent = shares.toString();
      ($("pos-chip") as HTMLElement).hidden = shares === 0n;
      syncCounter(fromBase(worth));
    }
  } catch (e) {
    toast("Couldn't read the pool right now.", { err: true });
  }
}

// Re-anchor the live counter to a fresh on-chain worth, (re)establish the cost basis, and (re)start
// the animation. Called after every refresh/deposit/withdraw.
function syncCounter(worthUsd: number) {
  baseWorth = worthUsd;
  baseAt = performance.now();
  tickRate = estApy; // the estimated pool yield shown in the headline
  $("pos-bal").textContent = "$" + usd(worthUsd); // reflect current worth now (incl. $0 after a full exit)
  const wrap = $("earned-wrap") as HTMLElement;
  if (shares <= 0n || worthUsd <= 0) { wrap.hidden = true; stopTicker(); return; }
  let b = getBasis();
  if (b == null) { b = worthUsd; setBasis(b); basisInferred = true; } // seed from current worth
  else { basisInferred = b > worthUsd + 1e-9 ? true : basisInferred; }
  costBasis = b;
  $("earned-since").textContent = basisInferred ? "since this session" : "since you deposited";
  const perDay = (baseWorth * tickRate) / 365;
  $("earned-rate").textContent = tickRate > 0 ? `≈ +$${perDay.toFixed(4)} / day at the current rate` : "";
  wrap.hidden = false;
  startTicker();
}

function frame() {
  const elapsed = (performance.now() - baseAt) / 1000;
  const worth = baseWorth * (1 + tickRate * (elapsed / YEAR_SEC));
  $("pos-bal").textContent = "$" + usd(worth);
  const earned = Math.max(0, worth - costBasis);
  $("pos-earned").textContent = "+$" + earned.toFixed(6);
  rafId = requestAnimationFrame(frame);
}
function startTicker() { if (!rafId) rafId = requestAnimationFrame(frame); }
function stopTicker() { if (rafId) { cancelAnimationFrame(rafId); rafId = 0; } }

let estApy = 0;
function renderProjection(apy: number) {
  estApy = apy;
  const amt = Number($<HTMLInputElement>("dep-amt").value) || 0;
  $("proj").textContent = "+$" + usd(amt * apy);
  $("shares-out").textContent = "≈ " + amt.toLocaleString("en-US", { maximumFractionDigits: 0 }) + " pool shares";
  $("routed").textContent = "$" + usd(amt * 0.8) + " → vault";
}

async function deposit() {
  if (!address) return;
  const amt = $<HTMLInputElement>("dep-amt").value;
  const base = toBase(amt);
  if (base <= 0n) return toast("Enter an amount to deposit.", { err: true });
  const btn = $<HTMLButtonElement>("btn-deposit");
  const bal = await readCall<bigint>(USDC, "balance", [sAddr(address)], address);
  if (BigInt(bal) < base) return toast(`Not enough test USDC — you have ${usd(fromBase(bal))}. Get some from the faucet.`, { err: true });
  btn.disabled = true; btn.textContent = "Depositing…";
  try {
    const tx = await invoke(POOL, "deposit", [sAddr(address), sI128(base)], address);
    toast(`Deposited ${usd(fromBase(base))} USDC`, { tx });
    setBasis((getBasis() || 0) + fromBase(base)); // a tracked deposit → cost basis is now known
    basisInferred = false;
    await refresh();
  } catch (e) {
    toast(friendly((e as Error)?.message), { err: true });
  }
  btn.disabled = false; btn.textContent = "Deposit & start earning";
}

async function withdraw(all: boolean) {
  if (!address) return;
  const btn = $<HTMLButtonElement>(all ? "btn-withdraw-all" : "btn-withdraw");
  let sh: bigint;
  if (all) {
    sh = shares;
  } else {
    const amt = toBase($<HTMLInputElement>("wd-amt").value);
    if (amt <= 0n) return toast("Enter an amount to withdraw.", { err: true });
    sh = BigInt(await readCall<bigint>(POOL, "convert_to_shares", [sI128(amt)], address));
    if (sh > shares) sh = shares;
  }
  if (sh <= 0n) return toast("You have nothing to withdraw.", { err: true });
  const prev = btn.textContent;
  btn.disabled = true; btn.textContent = "Withdrawing…";
  try {
    const tx = await invoke(POOL, "withdraw", [sAddr(address), sI128(sh)], address);
    toast("Withdrawn to your wallet", { tx });
    $<HTMLInputElement>("wd-amt").value = "";
    // reduce the basis pro-rata to the shares pulled out (full exit clears it)
    if (all || sh >= shares) setBasis(0);
    else setBasis((getBasis() || 0) * Number(shares - sh) / Number(shares));
    await refresh();
  } catch (e) {
    toast(friendly((e as Error)?.message), { err: true });
  }
  btn.disabled = false; btn.textContent = prev || "Withdraw";
}

function friendly(msg = ""): string {
  if (/#\s*12|InsufficientLiquidity/i.test(msg)) return "The pool is short on liquid USDC right now — try a smaller amount.";
  if (/#\s*13|InsufficientShares/i.test(msg)) return "You don't have that many pool shares.";
  if (/#\s*18|CollateralLocked/i.test(msg)) return "That deposit backs an open loan — repay it first.";
  if (/getAccount|not.*found|404/i.test(msg)) return "Fund XLM for fees first (use the faucet).";
  if (/reject|denied|cancel/i.test(msg)) return "You cancelled the signature.";
  return "Couldn't complete that right now. Try again.";
}

function setConnected(on: boolean) {
  (["btn-deposit", "btn-withdraw", "btn-withdraw-all"] as const).forEach((id) => { $<HTMLButtonElement>(id).disabled = !on; });
  $("btn-deposit").textContent = on ? "Deposit & start earning" : "Connect wallet to deposit";
}

function wire() {
  ($("lnk-pool") as HTMLAnchorElement).href = `${EXPLORER}/contract/${POOL}`;
  $("walletBtn").addEventListener("click", async () => {
    try {
      address = await connect();
      $("walletLbl").textContent = short(address);
      setConnected(true);
      await refresh();
    } catch {
      toast("Wallet connection cancelled", { err: true });
    }
  });
  $("dep-amt").addEventListener("input", () => renderProjection(estApy));
  $("dep-max").addEventListener("click", async () => {
    if (!address) return;
    const bal = await readCall<bigint>(USDC, "balance", [sAddr(address)], address);
    $<HTMLInputElement>("dep-amt").value = String(fromBase(bal));
    renderProjection(estApy);
  });
  $("btn-deposit").addEventListener("click", deposit);
  $("btn-withdraw").addEventListener("click", () => withdraw(false));
  $("btn-withdraw-all").addEventListener("click", () => withdraw(true));
  refresh(); // show live pool stats before connect (browse before connect)
  // Resume a prior wallet session silently so navigating here keeps you connected.
  restoreSession().then((a) => { if (a) { address = a; $("walletLbl").textContent = short(a); setConnected(true); refresh(); } });
}

wire();
