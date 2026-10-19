// LCRD Earn — deposit USDC to the pool to earn (loan interest + DeFindex vault yield), withdraw anytime.
// Wired to the deployed testnet credit-line pool.
import "./ui.css";
import { connect, invoke, readCall, sAddr, sI128 } from "./soroban";

const POOL = "CBW426LFZAFUW2YMPUFZRMEV6VCZ2XSVOMHFQS7C6VCO4DIVK6SDB5ZP";
const USDC = "CDXDVJLAYLFR2BRDHVUHM5NSVEN5EJVC5QPKW5I7LWNFKMQFX35V35ZJ";
const EXPLORER = "https://stellar.expert/explorer/testnet";
const VAULT_APR = 0.10; // the fixed-APR strategy the pool's idle USDC is invested in (deployed rate)
const ONE = 10_000_000;
// A funded testnet account used only as the source for read-only simulations before a wallet is
// connected (lets us show live pool stats pre-connect). Reads don't require its auth.
const READ_SOURCE = "GC6PEHH3UNMWN2V7LS6DRBCF7UNPX6EDZUBZ2MVFZIPHIWWWTQIJ6QBT";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
let address: string | null = null;
let shares = 0n; // the connected wallet's pool shares (raw)

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
      $("pos-bal").textContent = "$" + usd(fromBase(worth));
      $("pos-shares").textContent = shares.toString();
      ($("pos-chip") as HTMLElement).hidden = shares === 0n;
    }
  } catch (e) {
    toast("Couldn't read the pool right now.", { err: true });
  }
}

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
}

wire();
