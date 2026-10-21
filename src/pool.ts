import "./siteChrome"; // shared /credit banner + waitlist footer on every legacy page
import "./style.css";
import { connect, invoke, readCall, sAddr, sI128, explorerTx, getContractEvents, TESTNET_RPC } from "./soroban";
import type { ActivityEvent } from "./soroban";
import { StellarWalletsKit } from "@creit.tech/stellar-wallets-kit";
import { Networks } from "@stellar/stellar-sdk";

// Testnet deployment (editable in the page). See contracts/credit-line/.credit-line-testnet.json.
const DEFAULTS = {
  pool: "CDGNXAAA2MM5V7Z6CJ6SHQNMKFQR5VRBHDF6Z3DAUXXJJBQ3CG73IXE4",
  usdc: "CD53BY6I76MPTYAX7OUQSGGNJK4IZ5OQI7PTPLI62WFYHU6KB6YDNQJQ",
  faucet: "CAHIFIKDOPVJOIQ5OXNYUHLPC4F3PKU7Z5HCTUGSWB3UC6AJXP25SO4P", // test-USDC faucet (drip)
  underwriter: "https://34-57-119-191.sslip.io", // the credit-line-underwriter service (GCP VM, auto-HTTPS)
};

const $ = (id: string) => document.getElementById(id) as HTMLInputElement & HTMLElement;
const ONE = 10_000_000; // 1 USDC at 7 decimals
let address = "";

// ---- units ----
const toBase = (usdc: string): bigint => BigInt(Math.round(Number(usdc) * ONE));
const fromBase = (base: bigint | number): string => {
  const n = Number(base) / ONE;
  return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
};
const pct = (bps: number) => (bps / 100).toFixed(2) + "%";
const short = (a: string) => (a ? a.slice(0, 4) + "…" + a.slice(-4) : "—");

function log(msg: string, href?: string) {
  const el = $("pl-log");
  const line = document.createElement("div");
  line.className = "te-log-line";
  line.textContent = msg;
  if (href) {
    const a = document.createElement("a");
    a.href = href; a.target = "_blank"; a.rel = "noopener"; a.textContent = " ↗"; a.className = "btn-link";
    line.append(a);
  }
  el.prepend(line);
}

// Turn a raw Soroban/wallet error into one plain sentence. Contract error numbers come back inside the
// message as "Error(Contract, #N)"; N maps to the credit-line contract's error enum.
const CONTRACT_ERRORS: Record<string, string> = {
  "3": "Only the pool owner can do that.",
  "4": "Only the underwriter can open an unsecured line — use “Request unsecured line”.",
  "6": "Enter an amount greater than zero.",
  "8": "That credit score isn’t valid.",
  "9": "This wallet isn’t eligible for an unsecured line yet (needs a credit score of 50 or higher). You can borrow with a secured line instead.",
  "10": "This credit line is frozen, so you can’t draw on it right now.",
  "11": "That’s more than your limit. Lower the amount, or complete a repayment cycle to grow your line.",
  "12": "The pool doesn’t have enough available USDC right now — try a smaller amount.",
  "13": "You don’t have that many pool shares to withdraw.",
  "14": "There’s nothing owed on this line.",
  "15": "You already have an open loan — repay it before changing the line.",
  "16": "Deposit USDC first, then you can open a secured line against it.",
  "17": "This isn’t a secured line.",
  "18": "You can’t withdraw the deposit backing an open loan — repay the loan first.",
};
function friendlyError(e: unknown): string {
  const raw = (e instanceof Error ? e.message : String(e)) || "Something went wrong.";
  const m = raw.toLowerCase();
  if (m.includes("declined") || m.includes("reject") || m.includes("cancel") || m.includes("denied")) return "Request cancelled in your wallet.";
  const cm = /error\(contract,\s*#(\d+)\)/i.exec(raw);
  if (cm && CONTRACT_ERRORS[cm[1]]) return CONTRACT_ERRORS[cm[1]];
  if (m.includes("insufficient balance") || m.includes("unreachablecodereached")) return "Not enough USDC in your wallet. Click “Get test USDC” to top up.";
  if (m.includes("insufficientliquidity")) return "The pool doesn’t have enough available USDC right now — try a smaller amount.";
  if (m.includes("unauthorized") || (m.includes("invalidaction") && m.includes("auth"))) return "Couldn’t authorize that — reconnect your wallet and try again.";
  if (m.includes("simulation") || m.includes("timeout") || m.includes("network") || m.includes("fetch") || m.includes("http")) return "Couldn’t reach Stellar just now — please try again.";
  if (m.includes("trap") || m.includes("hosterror") || m.includes("wasmvm") || m.includes("invalidaction")) return "That transaction couldn’t go through. Check your amount and balance, then try again.";
  return raw.split("\n")[0].slice(0, 160);
}

const pool = () => $("pl-pool").value.trim();
const usdc = () => $("pl-usdc").value.trim();

function setBusy(b: boolean) {
  for (const id of ["pl-deposit", "pl-withdraw", "pl-borrow", "pl-repay", "pl-open-secured", "pl-request", "pl-refresh", "pl-faucet"]) {
    const el = $(id) as HTMLButtonElement; if (el) el.disabled = b || !address;
  }
}

// ---- reads ----
async function refresh() {
  if (!address) return;
  setBusy(true);
  try {
    const P = pool();
    const [assets, cash, principal, interest, written] = await Promise.all([
      readCall<bigint>(P, "total_assets", [], address),
      readCall<bigint>(P, "cash", [], address),
      readCall<bigint>(P, "total_principal_view", [], address),
      readCall<bigint>(P, "total_repaid_interest", [], address),
      readCall<bigint>(P, "total_written_off", [], address),
    ]);
    $("pl-assets").textContent = fromBase(assets);
    $("pl-cash").textContent = fromBase(cash);
    $("pl-lent").textContent = fromBase(principal);
    $("pl-interest").textContent = fromBase(interest);
    $("pl-written").textContent = fromBase(written);

    const [bal, worth, line, hist, owed, avail] = await Promise.all([
      readCall<bigint>(usdc(), "balance", [sAddr(address)], address),
      readCall<bigint>(P, "collateral_value", [sAddr(address)], address),
      readCall<Record<string, unknown>>(P, "get_line", [sAddr(address)], address),
      readCall<Record<string, unknown>>(P, "get_history", [sAddr(address)], address),
      readCall<[bigint, bigint]>(P, "owed", [sAddr(address)], address),
      readCall<bigint>(P, "available", [sAddr(address)], address),
    ]);
    $("pl-bal").textContent = fromBase(bal);
    $("pl-worth").textContent = fromBase(worth);

    const active = line.active as boolean;
    const secured = line.secured as boolean;
    const tier = Number(line.tier);
    $("pl-line").textContent = active
      ? `${secured ? "Secured" : "Unsecured"} · tier ${["—", "A", "B", "C"][tier] ?? "—"} · ${pct(Number(line.apr_bps))} APR · limit ${fromBase(line.limit as bigint)} USDC`
      : "No line yet";
    $("pl-owed").textContent = fromBase(owed[0] + owed[1]);
    $("pl-avail").textContent = fromBase(avail);
    const cycles = Number(hist.cycles_completed);
    $("pl-record").textContent = `${Number(hist.repayments)} · ${cycles} · ${Number(hist.write_offs)}`;
  } catch (e) {
    log("Couldn’t refresh pool data — " + friendlyError(e));
  } finally {
    setBusy(false);
  }
}

async function loadTable() {
  if (!address) return;
  try {
    const P = pool();
    const list = await readCall<string[]>(P, "borrowers", [], address);
    const tbody = $("pl-tbody");
    tbody.innerHTML = "";
    for (const b of list.slice(0, 50)) {
      const [line, hist, owed] = await Promise.all([
        readCall<Record<string, unknown>>(P, "get_line", [sAddr(b)], address),
        readCall<Record<string, unknown>>(P, "get_history", [sAddr(b)], address),
        readCall<[bigint, bigint]>(P, "owed", [sAddr(b)], address),
      ]);
      const tr = document.createElement("tr");
      const tier = ["—", "A", "B", "C"][Number(line.tier)] ?? "—";
      const cells = [
        short(b),
        (line.secured as boolean) ? "secured" : "unsecured",
        line.active ? tier : "—",
        fromBase(line.limit as bigint),
        pct(Number(line.apr_bps)),
        fromBase(owed[0]),
        fromBase(owed[1]),
        `${Number(hist.repayments)} · ${Number(hist.cycles_completed)}`,
      ];
      for (const c of cells) {
        const td = document.createElement("td");
        td.textContent = c;
        tr.append(td);
      }
      tbody.append(tr);
    }
    if (list.length === 0) tbody.innerHTML = '<tr><td colspan="8" class="te-muted">No lines yet.</td></tr>';
  } catch (e) {
    log("Couldn’t load credit lines — " + friendlyError(e));
  }
}

// ---- actions ----
// One human line for an on-chain pool event (topics[0]=event name, topics[1]=the wallet, value=data).
function activityLine(e: ActivityEvent): string {
  const t = String(e.topics[0] ?? "");
  const who = typeof e.topics[1] === "string" ? short(e.topics[1] as string) : "";
  const v = e.value as unknown;
  const arr = Array.isArray(v) ? (v as unknown[]) : [];
  const n = (x: unknown) => fromBase(typeof x === "bigint" ? x : BigInt((x as number | string) ?? 0));
  const by = who ? ` · ${who}` : "";
  switch (t) {
    case "deposited": return `Deposited ${n(arr[0])} USDC${by}`;
    case "withdrawn": return `Withdrew ${n(arr[0])} USDC${by}`;
    case "borrowed": return `Borrowed ${n(v)} USDC${by}`;
    case "repaid": return `Repaid ${n(((arr[1] as bigint) ?? 0n) + ((arr[2] as bigint) ?? 0n))} USDC${by}`;
    case "line_set": return `Line opened ${n(arr[0])} USDC @ ${pct(Number(arr[3]))}${by}`;
    case "secured": return `Secured line ${n(arr[0])} USDC @ ${pct(Number(arr[1]))}${by}`;
    case "cycle": return `Cycle ${Number(arr[0])} — limit ${n(arr[2])} USDC @ ${pct(Number(arr[1]))}${by}`;
    case "writeoff": return `Written off ${n(arr[0])} USDC${by}`;
    case "seized": return `Collateral seized${by}`;
    case "frozen": return `Line frozen${by}`;
    default: return `${t}${by}`;
  }
}

async function loadActivity() {
  if (!address) return;
  const el = $("pl-activity");
  try {
    const evs = await getContractEvents(pool(), 20);
    el.innerHTML = "";
    if (!evs.length) {
      el.innerHTML = '<div class="te-muted">No recent on-chain activity.</div>';
      return;
    }
    for (const e of evs) {
      const row = document.createElement("div");
      row.className = "te-log-line";
      row.textContent = activityLine(e);
      if (e.txHash) {
        const a = document.createElement("a");
        a.href = explorerTx(e.txHash);
        a.target = "_blank";
        a.rel = "noopener";
        a.textContent = " ↗";
        a.className = "btn-link";
        row.append(a);
      }
      el.append(row);
    }
  } catch (err) {
    el.innerHTML = '<div class="te-muted">Couldn’t load activity — ' + friendlyError(err) + "</div>";
  }
}

async function run(label: string, fn: () => Promise<string>) {
  if (!address) return;
  setBusy(true);
  try {
    const hash = await fn();
    log(label + " ✓", explorerTx(hash));
    await refresh();
    await loadTable();
    await loadActivity();
  } catch (e) {
    log(label + " failed — " + friendlyError(e));
  } finally {
    setBusy(false);
  }
}

async function requestUnsecuredLine() {
  if (!address) return;
  const url = $("pl-underwriter").value.trim();
  if (!url) { log("Unsecured lines aren’t available here right now. You can still borrow with a secured line (deposit USDC, then “Open secured line”)."); return; }
  setBusy(true);
  try {
    const message = `LCRD credit on Stellar\nStellar wallet: ${address}\nIssued: ${new Date().toISOString()}`;
    const { signedMessage } = await StellarWalletsKit.signMessage(message, { address, networkPassphrase: Networks.TESTNET });
    log("Scoring your wallet and opening a line…");
    const res = await fetch(url.replace(/\/$/, "") + "/request-line", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message, signature: signedMessage }),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(out.error ?? `HTTP ${res.status}`);
    if (out.eligible) {
      log(`Line opened: ${out.limit} USDC, tier ${out.tier}, ${pct(out.aprBps)} APR`, out.txHash ? explorerTx(out.txHash) : undefined);
    } else {
      log("No line opened — " + out.reason);
    }
    await refresh();
    await loadTable();
    await loadActivity();
  } catch (e) {
    log("Couldn’t open a line — " + friendlyError(e));
  } finally {
    setBusy(false);
  }
}

// Friendly guard: the pool pulls USDC from the wallet, so a deposit/repay with too little USDC would
// trap deep in the token contract. Check first and point at the faucet instead.
async function hasUsdc(amount: bigint): Promise<boolean> {
  const bal = await readCall<bigint>(usdc(), "balance", [sAddr(address)], address);
  if (bal < amount) {
    log(`Not enough test USDC — you have ${fromBase(bal)}. Click "Get test USDC" to top up (drips 2,000).`);
    return false;
  }
  return true;
}

function wire() {
  $("pl-pool").value = DEFAULTS.pool;
  $("pl-usdc").value = DEFAULTS.usdc;
  $("pl-underwriter").value = DEFAULTS.underwriter;

  $("pl-connect").addEventListener("click", async () => {
    try {
      address = await connect();
      $("pl-address").textContent = short(address);
      ($("pl-connect") as HTMLButtonElement).disabled = true;
      log("Connected " + short(address) + " (testnet, " + TESTNET_RPC + ")");
      await refresh();
      await loadTable();
      await loadActivity();
    } catch (e) {
      log("Couldn’t connect your wallet — " + friendlyError(e));
    }
  });

  $("pl-refresh").addEventListener("click", () => { refresh(); loadTable(); loadActivity(); });
  $("pl-faucet").addEventListener("click", () =>
    run("Claim test USDC (faucet)", () => invoke(DEFAULTS.faucet, "drip", [sAddr(address)], address)));
  $("pl-deposit").addEventListener("click", async () => {
    const amt = toBase($("pl-deposit-amt").value);
    if (!address || !(await hasUsdc(amt))) return;
    await run("Deposit " + $("pl-deposit-amt").value + " USDC", () =>
      invoke(pool(), "deposit", [sAddr(address), sI128(amt)], address));
  });
  $("pl-withdraw").addEventListener("click", async () => {
    // Convert the requested USDC back to shares, then withdraw those shares.
    const shares = await readCall<bigint>(pool(), "convert_to_shares", [sI128(toBase($("pl-withdraw-amt").value))], address);
    await run("Withdraw " + $("pl-withdraw-amt").value + " USDC", () =>
      invoke(pool(), "withdraw", [sAddr(address), sI128(shares)], address));
  });
  $("pl-borrow").addEventListener("click", () =>
    run("Borrow " + $("pl-borrow-amt").value + " USDC", () =>
      invoke(pool(), "borrow", [sAddr(address), sI128(toBase($("pl-borrow-amt").value))], address)));
  $("pl-repay").addEventListener("click", async () => {
    const amt = toBase($("pl-repay-amt").value);
    if (!address || !(await hasUsdc(amt))) return;
    await run("Repay " + $("pl-repay-amt").value + " USDC", () =>
      invoke(pool(), "repay", [sAddr(address), sAddr(address), sI128(amt)], address));
  });
  $("pl-open-secured").addEventListener("click", () =>
    run("Open secured line", () => invoke(pool(), "open_secured_line", [sAddr(address)], address)));
  $("pl-request").addEventListener("click", requestUnsecuredLine);

  setBusy(false);
}

wire();
