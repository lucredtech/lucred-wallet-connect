import "./style.css";
import { connectWallet, proveOwnership, isGAddress } from "./wallet";
import { loadDfCredit } from "./dfCreditView";

const $ = (id: string) => document.getElementById(id)!;
const STELLAR_ADDRESS_RE = /^[GC][A-Z2-7]{55}$/;

const card = $("df-credit");
const connectWrap = $("borrow-connect");
const connectBtn = $("borrow-connect-btn") as HTMLButtonElement;
const connectNote = $("borrow-connect-note");
const verifyWrap = $("borrow-verify");
const addressLabel = $("borrow-address");
const verifyBtn = $("borrow-verify-btn") as HTMLButtonElement;
const errorEl = $("borrow-error");

let currentAddress = "";

const truncate = (a: string) => `${a.slice(0, 6)}…${a.slice(-6)}`;
const showErr = (m: string) => { errorEl.textContent = m; errorEl.classList.remove("hidden"); };
const clearErr = () => { errorEl.classList.add("hidden"); errorEl.textContent = ""; };

function verifiedInSession(addr: string): boolean {
  try { return sessionStorage.getItem("lcrd-verified-wallet") === addr; } catch { return false; }
}
function storeVerified(addr: string) {
  try { sessionStorage.setItem("lcrd-verified-wallet", addr); } catch { /* storage unavailable */ }
}

/** Render the terms card for an address. verified => the Accept action is enabled; otherwise preview. */
function renderCard(addr: string, verified: boolean) {
  currentAddress = addr;
  card.classList.remove("hidden");
  addressLabel.textContent = truncate(addr);
  void loadDfCredit(addr, !verified);
}

// ---- entry: an address may arrive via ?wallet= (linked from the score / holdings cards) ----
const params = new URLSearchParams(location.search);
const initial = (params.get("wallet") || "").trim().toUpperCase();

if (STELLAR_ADDRESS_RE.test(initial)) {
  if (verifiedInSession(initial)) {
    connectWrap.classList.add("hidden");
    verifyWrap.classList.add("hidden");
    renderCard(initial, true);
  } else {
    connectNote.textContent = "Connect this wallet and verify ownership to accept terms.";
    renderCard(initial, false); // preview from the passed address
  }
} else {
  connectNote.textContent = "Connect your Stellar wallet to see your terms.";
  card.classList.add("hidden");
}

connectBtn.addEventListener("click", async () => {
  clearErr();
  connectBtn.disabled = true;
  connectBtn.textContent = "Connecting…";
  try {
    const address = await connectWallet();
    if (isGAddress(address) && verifiedInSession(address)) {
      connectWrap.classList.add("hidden");
      verifyWrap.classList.add("hidden");
      renderCard(address, true);
    } else if (isGAddress(address)) {
      connectWrap.classList.add("hidden");
      verifyWrap.classList.remove("hidden");
      renderCard(address, false); // preview until verified
    } else {
      // Smart-contract wallet: no signing path yet, preview only.
      connectWrap.classList.add("hidden");
      verifyWrap.classList.add("hidden");
      connectNote.textContent = "Smart-contract wallets can't be verified yet, so this stays a preview.";
      renderCard(address, false);
    }
  } catch (err: any) {
    showErr(err?.message || "Could not connect wallet.");
  } finally {
    connectBtn.disabled = false;
    connectBtn.textContent = "Connect wallet";
  }
});

verifyBtn.addEventListener("click", async () => {
  if (!currentAddress) return;
  clearErr();
  verifyBtn.disabled = true;
  verifyBtn.textContent = "Waiting for signature…";
  try {
    const ok = await proveOwnership(currentAddress);
    if (!ok) { showErr("Signature did not match this wallet. Please try again."); return; }
    storeVerified(currentAddress);
    verifyWrap.classList.add("hidden");
    renderCard(currentAddress, true);
  } catch (err: any) {
    showErr(err?.message || "Verification failed.");
  } finally {
    verifyBtn.disabled = false;
    verifyBtn.textContent = "Verify ownership to borrow";
  }
});
