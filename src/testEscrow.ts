import "./style.css";
import { connect, invoke, readCall, sAddr, sI128, sU32, sBytes32, sEnum, explorerTx } from "./soroban";

// Current testnet deployment (editable in the page).
const DEFAULTS = {
  escrow: "CCM4QHKGCEAE3FKNB3SGJ74ZHPHLWNAAB5BBVMDECXISB26MXAPHNFZG",
  dftoken: "CDCW5LKOFURA3H2FN7UQNVDLHO6NGUWDZKJRKAITHFLRYG2KBSJCM6UI",
  usdc: "CDIZWWUALEFWBN3M75TDM6T5SKWD3NEQ5XLU4QQYQ7KJK37O3MFEZYXT",
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
  for (const id of ["te-deposit", "te-withdraw", "te-close", "te-refresh"]) ($(id) as HTMLButtonElement).disabled = b || !address;
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
    const loan = await readCall<Record<string, unknown>>($("te-escrow").value.trim(), "get_loan", [sBytes32($("te-loanid").value.trim())], address);
    $("te-loan").textContent = JSON.stringify(loan, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2);
  } catch { $("te-loan").textContent = "(no loan for this id yet — Deposit to create one)"; }
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

  $("te-withdraw").addEventListener("click", () => run("Withdraw collateral (while unfunded)", () => invoke(
    $("te-escrow").value.trim(), "withdraw", [sBytes32($("te-loanid").value.trim())], address)));

  $("te-close").addEventListener("click", () => run("Close (return collateral)", () => invoke(
    $("te-escrow").value.trim(), "close", [sBytes32($("te-loanid").value.trim())], address)));

  setBusy(false); // leaves buttons disabled until connected
}

init();
