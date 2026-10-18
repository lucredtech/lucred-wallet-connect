import "./style.css";
import { connect, invoke, readCall, sAddr, sI128, explorerTx, TESTNET_RPC } from "./soroban";
import { StellarWalletsKit } from "@creit.tech/stellar-wallets-kit";
import { Networks } from "@stellar/stellar-sdk";

// Testnet deployment (editable in the page). See contracts/credit-line/.credit-line-testnet.json.
const DEFAULTS = {
  pool: "CDGNXAAA2MM5V7Z6CJ6SHQNMKFQR5VRBHDF6Z3DAUXXJJBQ3CG73IXE4",
  usdc: "CD53BY6I76MPTYAX7OUQSGGNJK4IZ5OQI7PTPLI62WFYHU6KB6YDNQJQ",
  faucet: "CAHIFIKDOPVJOIQ5OXNYUHLPC4F3PKU7Z5HCTUGSWB3UC6AJXP25SO4P", // test-USDC faucet (drip)
  underwriter: "", // e.g. http://localhost:8080 — the credit-line-underwriter service
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

    const [bal, shares, worth, line, hist, owed, avail] = await Promise.all([
      readCall<bigint>(usdc(), "balance", [sAddr(address)], address),
      readCall<bigint>(P, "shares_of", [sAddr(address)], address),
      readCall<bigint>(P, "collateral_value", [sAddr(address)], address),
      readCall<Record<string, unknown>>(P, "get_line", [sAddr(address)], address),
      readCall<Record<string, unknown>>(P, "get_history", [sAddr(address)], address),
      readCall<[bigint, bigint]>(P, "owed", [sAddr(address)], address),
      readCall<bigint>(P, "available", [sAddr(address)], address),
    ]);
    $("pl-bal").textContent = fromBase(bal);
    $("pl-shares").textContent = shares.toString();
    $("pl-worth").textContent = fromBase(worth);

    const active = line.active as boolean;
    const secured = line.secured as boolean;
    const tier = Number(line.tier);
    $("pl-line").textContent = active
      ? `${secured ? "Secured" : "Unsecured"} · tier ${["—", "A", "B", "C"][tier] ?? "—"} · ${pct(Number(line.apr_bps))} APR · limit ${fromBase(line.limit as bigint)} USDC`
      : "No line yet";
    $("pl-owed").textContent = `${fromBase(owed[0])} principal + ${fromBase(owed[1])} interest`;
    $("pl-avail").textContent = fromBase(avail);
    const cycles = Number(hist.cycles_completed);
    $("pl-record").textContent = `${Number(hist.repayments)} repayments · ${cycles} cycle${cycles === 1 ? "" : "s"} · ${Number(hist.write_offs)} write-offs`;
  } catch (e) {
    log("read failed: " + (e as Error).message);
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
    log("table load failed: " + (e as Error).message);
  }
}

// ---- actions ----
async function run(label: string, fn: () => Promise<string>) {
  if (!address) return;
  setBusy(true);
  try {
    const hash = await fn();
    log(label + " ✓", explorerTx(hash));
    await refresh();
    await loadTable();
  } catch (e) {
    log(label + " failed: " + (e as Error).message);
  } finally {
    setBusy(false);
  }
}

async function requestUnsecuredLine() {
  if (!address) return;
  const url = $("pl-underwriter").value.trim();
  if (!url) { log("Set the underwriter URL first (the credit-line-underwriter service)."); return; }
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
      log("Not eligible: " + out.reason);
    }
    await refresh();
    await loadTable();
  } catch (e) {
    log("request failed: " + (e as Error).message);
  } finally {
    setBusy(false);
  }
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
    } catch (e) {
      log("connect failed: " + (e as Error).message);
    }
  });

  $("pl-refresh").addEventListener("click", () => { refresh(); loadTable(); });
  $("pl-faucet").addEventListener("click", () =>
    run("Claim test USDC (faucet)", () => invoke(DEFAULTS.faucet, "drip", [sAddr(address)], address)));
  $("pl-deposit").addEventListener("click", () =>
    run("Deposit " + $("pl-deposit-amt").value + " USDC", () =>
      invoke(pool(), "deposit", [sAddr(address), sI128(toBase($("pl-deposit-amt").value))], address)));
  $("pl-withdraw").addEventListener("click", async () => {
    // Convert the requested USDC back to shares, then withdraw those shares.
    const shares = await readCall<bigint>(pool(), "convert_to_shares", [sI128(toBase($("pl-withdraw-amt").value))], address);
    await run("Withdraw " + $("pl-withdraw-amt").value + " USDC", () =>
      invoke(pool(), "withdraw", [sAddr(address), sI128(shares)], address));
  });
  $("pl-borrow").addEventListener("click", () =>
    run("Borrow " + $("pl-borrow-amt").value + " USDC", () =>
      invoke(pool(), "borrow", [sAddr(address), sI128(toBase($("pl-borrow-amt").value))], address)));
  $("pl-repay").addEventListener("click", () =>
    run("Repay " + $("pl-repay-amt").value + " USDC", () =>
      invoke(pool(), "repay", [sAddr(address), sAddr(address), sI128(toBase($("pl-repay-amt").value))], address)));
  $("pl-open-secured").addEventListener("click", () =>
    run("Open secured line", () => invoke(pool(), "open_secured_line", [sAddr(address)], address)));
  $("pl-request").addEventListener("click", requestUnsecuredLine);

  setBusy(false);
}

wire();
