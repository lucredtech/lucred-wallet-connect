import "./style.css";
import { connectWallet, disconnectWallet, proveOwnership, isGAddress } from "./wallet";
import { fetchScore, type ScoreResult } from "./score";

const STELLAR_ADDRESS_PATTERN = /^[GC][A-Z2-7]{55}$/;

const connectStage = document.getElementById("connect-stage")!;
const connectedStage = document.getElementById("connected-stage")!;
const connectBtn = document.getElementById("connect-btn") as HTMLButtonElement;
const pasteForm = document.getElementById("paste-form") as HTMLFormElement;
const pasteInput = document.getElementById("paste-input") as HTMLInputElement;
const pasteBtn = document.getElementById("paste-btn") as HTMLButtonElement;
const disconnectBtn = document.getElementById("disconnect-btn") as HTMLButtonElement;
const addressLabel = document.getElementById("address-label")!;
const statusDot = document.getElementById("status-dot")!;
const unverifiedTag = document.getElementById("unverified-tag")!;
const verifyStage = document.getElementById("verify-stage")!;
const verifyBtn = document.getElementById("verify-btn") as HTMLButtonElement;
const unverifiableNote = document.getElementById("unverifiable-note")!;
const scoreStage = document.getElementById("score-stage")!;
const tierBadge = document.getElementById("tier-badge")!;
const scoreNumber = document.getElementById("score-number")!;
const scoreSub = document.getElementById("score-sub")!;
const reasonsList = document.getElementById("reasons-list")!;
const explorerLink = document.getElementById("explorer-link") as HTMLAnchorElement;
const errorBanner = document.getElementById("error-banner")!;

type Mode = "wallet" | "pasted";

let currentAddress: string | null = null;
let currentMode: Mode | null = null;

function truncate(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-6)}`;
}

function showError(message: string) {
  errorBanner.textContent = message;
  errorBanner.classList.remove("hidden");
}

function clearError() {
  errorBanner.classList.add("hidden");
  errorBanner.textContent = "";
}

function setVerified(verified: boolean) {
  statusDot.dataset.verified = String(verified);
  unverifiedTag.classList.toggle("hidden", verified);
}

function resetToDisconnected() {
  currentAddress = null;
  currentMode = null;
  connectStage.classList.remove("hidden");
  connectedStage.classList.add("hidden");
  verifyStage.classList.remove("hidden");
  unverifiableNote.classList.add("hidden");
  scoreStage.classList.add("hidden");
  pasteInput.value = "";
}

// Entered immediately on connect/paste, before anything is actually proven -
// always starts unverified. Signing (G-address wallets only) can upgrade it
// via setVerified(true) afterwards; pasted addresses and connected
// smart-contract (C...) wallets have nothing to sign, so they stay
// unverified and skip straight to the score once fetched.
function enterConnectedState(address: string, mode: Mode) {
  currentAddress = address;
  currentMode = mode;
  addressLabel.textContent = truncate(address);
  setVerified(false);
  disconnectBtn.textContent = mode === "wallet" ? "Disconnect" : "Change address";
  connectStage.classList.add("hidden");
  connectedStage.classList.remove("hidden");

  const canSign = mode === "wallet" && isGAddress(address);
  verifyStage.classList.toggle("hidden", !canSign);
  unverifiableNote.classList.toggle("hidden", !(mode === "wallet" && !canSign));
  scoreStage.classList.add("hidden");
}

function renderScore(result: ScoreResult) {
  tierBadge.textContent = `TIER ${result.tier}`;
  tierBadge.dataset.tier = result.tier;
  scoreNumber.textContent = String(result.score);
  scoreSub.textContent = `${result.eventCount} on-chain event${result.eventCount === 1 ? "" : "s"} · ${result.path} path`;

  reasonsList.innerHTML = "";
  for (const reason of result.reasons) {
    const li = document.createElement("li");
    li.textContent = reason;
    reasonsList.appendChild(li);
  }

  explorerLink.href = `https://stellar.expert/explorer/public/account/${result.wallet}`;

  verifyStage.classList.add("hidden");
  unverifiableNote.classList.add("hidden");
  scoreStage.classList.remove("hidden");
}

connectBtn.addEventListener("click", async () => {
  clearError();
  connectBtn.disabled = true;
  connectBtn.textContent = "Connecting…";
  try {
    const address = await connectWallet();
    enterConnectedState(address, "wallet");

    // A connected smart-contract wallet has no signing path yet (see
    // isGAddress) - go straight to the score instead of offering a
    // "Verify Ownership" step that would be guaranteed to fail.
    if (!isGAddress(address)) {
      const result = await fetchScore(address);
      renderScore(result);
    }
  } catch (err: any) {
    showError(err?.message || "Could not connect wallet.");
  } finally {
    connectBtn.disabled = false;
    connectBtn.textContent = "Connect Wallet";
  }
});

pasteForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  clearError();
  const address = pasteInput.value.trim().toUpperCase();

  if (!STELLAR_ADDRESS_PATTERN.test(address)) {
    showError("Enter a valid 56-character Stellar address starting with G or C.");
    return;
  }

  pasteBtn.disabled = true;
  pasteBtn.textContent = "Loading…";
  try {
    const result = await fetchScore(address);
    enterConnectedState(address, "pasted");
    renderScore(result);
  } catch (err: any) {
    showError(err?.message || "Could not fetch score for this address.");
  } finally {
    pasteBtn.disabled = false;
    pasteBtn.textContent = "View Score";
  }
});

verifyBtn.addEventListener("click", async () => {
  if (!currentAddress || currentMode !== "wallet") return;
  clearError();
  verifyBtn.disabled = true;
  verifyBtn.textContent = "Waiting for signature…";
  try {
    const verified = await proveOwnership(currentAddress);
    if (!verified) {
      showError("Signature did not match this wallet. Please try again.");
      return;
    }
    setVerified(true);
    verifyBtn.textContent = "Fetching score…";
    const result = await fetchScore(currentAddress);
    renderScore(result);
  } catch (err: any) {
    showError(err?.message || "Verification failed.");
  } finally {
    verifyBtn.disabled = false;
    verifyBtn.textContent = "Verify Ownership";
  }
});

disconnectBtn.addEventListener("click", async () => {
  if (currentMode === "wallet") {
    try {
      await disconnectWallet();
    } catch {
      // best-effort - reset the UI regardless
    }
  }
  resetToDisconnected();
});
