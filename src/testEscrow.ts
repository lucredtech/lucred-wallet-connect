import "./style.css";
import { connect, invoke, readCall, sAddr, sI128, sU32, sBytes32, sEnum, explorerTx } from "./soroban";

// Current testnet deployment (editable in the page).
const DEFAULTS = {
  escrow: "CCM4QHKGCEAE3FKNB3SGJ74ZHPHLWNAAB5BBVMDECXISB26MXAPHNFZG",
  dftoken: "CDCW5LKOFURA3H2FN7UQNVDLHO6NGUWDZKJRKAITHFLRYG2KBSJCM6UI",
  usdc: "CDIZWWUALEFWBN3M75TDM6T5SKWD3NEQ5XLU4QQYQ7KJK37O3MFEZYXT",
  faucet: "CB5LTMEKUKMSTRBC4CMML5YAHBCPHIDTPZ6F6INKX56FS6XA73C4Y7S3",
};

const $ = (id: string) => document.getElementById(id) as HTMLInputElement & HTMLElement;
let address = "";

function randomLoanId(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

function log(msg: string, href?: string) {
  const el = $("te-log");
  const line = document.createElement("div");
  line.className = "te-log-line";
  line.textContent = msg;
  if (href) {
    const a = document.createElement("a");
    a.href = href; a.target = "_blank"; a.rel = "noopener"; a.textContent = " ↗";
    a.className = "btn-link";
    line.append(a);
  }
  el.prepend(line);
}

function setBusy(b: boolean) {
  for (const id of ["te-deposit", "te-repay", "te-withdraw", "te-close", "te-refresh", "te-faucet"]) ($(id) as HTMLButtonElement).disabled = b || !address;
}

async function refresh() {
  if (!address) return;
  try {
    const [dft, usd] = await Promise.all([
      readCall<bigint>($("te-dftoken").value.trim(), "balance", [sAddr(address)], address),
      readCall<bigint>($("te-usdc").value.trim(), "balance", [sAddr(address)], address),
    ]);
    $("te-bal-dft").textContent = String(dft);
    $("te-bal-usdc").textContent = String(usd);
  } catch (e) { log("balance read failed: " + (e as Error).message); }
  try {
    const escrow = $("te-escrow").value.trim();
    const loanId = $("te-loanid").value.trim();
    const loan = await readCall<Record<string, unknown>>(escrow, "get_loan", [sBytes32(loanId)], address);
    // Current payoff = principal debt + accrued interest (same math the contract uses for repay).
    let payoff: bigint | null = null;
    try { payoff = await readCall<bigint>(escrow, "payoff", [sBytes32(loanId)], address); } catch { payoff = null; }
    renderLoan(loan, payoff);
    // Pre-fill the repay field with the exact payoff so "Repay" clears the loan in one go.
    if (payoff !== null && payoff > 0n) $("te-repay-amt").value = String(payoff);
    $("te-loan").textContent = JSON.stringify(loan, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2);
  } catch {
    $("te-pos").hidden = true;
    $("te-pos-empty").hidden = false;
    $("te-pos-empty").textContent = "No loan for this id yet — Deposit to open one.";
    $("te-loan").textContent = "—";
  }
}

// A unit-variant enum (Open/Active/Closed) comes back as a string; MarginCall(deadline) as an object.
function statusName(s: unknown): string {
  if (typeof s === "string") return s;
  if (s && typeof s === "object") return Object.keys(s as object)[0] || "Unknown";
  return "Unknown";
}

function tsDate(t: unknown): string {
  const n = Number(t);
  return n > 0 ? new Date(n * 1000).toLocaleString() : "—";
}

function renderLoan(loan: Record<string, unknown>, payoff: bigint | null) {
  const status = statusName(loan.status);
  const structure = String(loan.structure) === "FixedTerm" ? "Fixed term" : "Open-ended";
  $("te-pos-empty").hidden = true;
  $("te-pos").hidden = false;

  const badge = $("te-pos-status");
  badge.textContent = status;
  badge.className = "te-badge te-badge-" + status.toLowerCase();
  $("te-pos-structure").textContent = structure + (Number(loan.term_days) > 0 ? ` · ${loan.term_days}d` : "");

  $("te-pos-coll").textContent = `${loan.collateral_amount} dfTokens`;
  $("te-pos-principal").textContent = `${loan.principal} USDC`;
  $("te-pos-debt").textContent = `${loan.debt} USDC`;
  $("te-pos-apr").textContent = `${(Number(loan.apr_bps) / 100).toFixed(2)}%`;
  $("te-pos-start").textContent = tsDate(loan.start);
  $("te-pos-maturity").textContent =
    String(loan.structure) === "FixedTerm" ? tsDate(loan.maturity) : "Open-ended";

  const debt = BigInt((loan.debt as bigint | number | string) ?? 0);
  const accrued = payoff !== null ? payoff - debt : null;
  $("te-pos-accrued").textContent = accrued !== null ? `${accrued} USDC` : "—";
  $("te-pos-payoff").textContent = payoff !== null ? `${payoff} USDC` : "—";
}

async function run(label: string, fn: () => Promise<string>) {
  setBusy(true);
  log(label + "…");
  try {
    const hash = await fn();
    log(label + " ✓", explorerTx(hash));
    await refresh();
  } catch (e) {
    log(label + " ✗ " + (e as Error).message);
  } finally {
    setBusy(false);
  }
}

function init() {
  $("te-escrow").value = DEFAULTS.escrow;
  $("te-dftoken").value = DEFAULTS.dftoken;
  $("te-usdc").value = DEFAULTS.usdc;
  $("te-loanid").value = randomLoanId();

  $("te-connect").addEventListener("click", async () => {
    try {
      address = await connect();
      $("te-address").textContent = address;
      $("te-connect").textContent = "Connected";
      setBusy(false);
      await refresh();
    } catch (e) { log("connect failed: " + (e as Error).message); }
  });

  $("te-newloan").addEventListener("click", () => { $("te-loanid").value = randomLoanId(); refresh(); });
  $("te-refresh").addEventListener("click", refresh);

  $("te-faucet").addEventListener("click", () => run("Get test tokens (faucet)", () => invoke(
    DEFAULTS.faucet, "drip", [sAddr(address)], address)));

  $("te-deposit").addEventListener("click", () => run("Deposit collateral", () => invoke(
    $("te-escrow").value.trim(), "deposit",
    [
      sBytes32($("te-loanid").value.trim()),
      sAddr(address),
      sAddr($("te-dftoken").value.trim()),
      sI128($("te-coll").value.trim() || "1000"),
      sI128($("te-principal").value.trim() || "600"),
      sU32(1200),
      sEnum("OpenEnded"),
      sU32(0),
    ],
    address,
  )));

  $("te-repay").addEventListener("click", () => run("Repay debt", () => invoke(
    $("te-escrow").value.trim(), "repay",
    [sBytes32($("te-loanid").value.trim()), sI128($("te-repay-amt").value.trim() || "0")],
    address)));

  $("te-withdraw").addEventListener("click", () => run("Withdraw collateral (while unfunded)", () => invoke(
    $("te-escrow").value.trim(), "withdraw", [sBytes32($("te-loanid").value.trim())], address)));

  $("te-close").addEventListener("click", () => run("Close (return collateral)", () => invoke(
    $("te-escrow").value.trim(), "close", [sBytes32($("te-loanid").value.trim())], address)));

  setBusy(false); // leaves buttons disabled until connected
}

init();
