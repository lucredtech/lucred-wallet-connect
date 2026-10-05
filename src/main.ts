import "./style.css";
import { connectWallet, disconnectWallet, proveOwnership, isGAddress } from "./wallet";
import { fetchScore, type ScoreResult } from "./score";
import { renderFactors } from "./factors";
import { loadPortfolio, resetPortfolio } from "./portfolioView";
import { loadCreditLine, resetCreditLine, showCreditLineLocked, setWaitlistWallet } from "./creditLineView";

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
const scoreCard = scoreStage.querySelector<HTMLElement>(".score-card")!;
const tierBadge = document.getElementById("tier-badge")!;
const scoreNumber = document.getElementById("score-number")!;
const scoreFill = document.getElementById("score-fill")!;
const resultWallet = document.getElementById("result-wallet")!;
const copyBtn = document.getElementById("copy-btn") as HTMLButtonElement;
const pathLabel = document.getElementById("path-label")!;
const statEvents = document.getElementById("stat-events")!;
const statTier = document.getElementById("stat-tier")!;
const reasonLines = document.getElementById("reason-lines")!;
const srAnnounce = document.getElementById("sr-announce")!;
const explorerLink = document.getElementById("explorer-link") as HTMLAnchorElement;
const errorBanner = document.getElementById("error-banner")!;
const loadingNote = document.getElementById("loading-note")!;

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

// Smart wallets (C...) are slower: the API also checks whether the contract
// has a linked owner account to merge in, which can take 10+ seconds. Say so,
// otherwise a bare "Loading…" reads like a hang.
async function fetchScoreWithNotice(address: string): Promise<ScoreResult> {
  loadingNote.textContent = isGAddress(address)
    ? "Scoring this wallet from its on-chain history… usually a few seconds."
    : "Scoring this smart wallet… this can take up to 15 seconds while we check for a linked owner account.";
  loadingNote.classList.remove("hidden");
  try {
    return await fetchScore(address);
  } finally {
    loadingNote.classList.add("hidden");
    loadingNote.textContent = "";
  }
}

function setVerified(verified: boolean) {
  statusDot.dataset.verified = String(verified);
  unverifiedTag.classList.toggle("hidden", verified);
}

function resetToDisconnected() {
  resetPortfolio();
  resetCreditLine();
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

const PATH_TEXT: Record<string, string> = {
  lending: "Scored via lending history",
  activity: "Scored via broad DeFi activity",
  floor: "Limited on-chain history",
  "no-history": "No activity found",
};

function renderScore(result: ScoreResult) {
  const tier = result.tier || "C";
  const score = Math.max(0, Math.min(100, result.score));
  const pathText = PATH_TEXT[result.path] || result.path;

  scoreCard.dataset.tier = tier;
  tierBadge.textContent = tier;
  scoreNumber.textContent = String(result.score);
  scoreFill.style.width = `${score}%`;
  resultWallet.textContent = result.wallet;
  pathLabel.textContent = pathText;
  statEvents.textContent = (result.eventCount ?? 0).toLocaleString();
  statTier.textContent = `Tier ${tier}`;

  // Scoring terms as pills with tooltips. An API response without components (or a wallet with no
  // history) falls back to the raw breakdown, which is then shown open.
  const factorGroups = document.getElementById("factor-groups")!;
  const factorTip = document.getElementById("factor-tip")!;
  const factorHint = document.getElementById("factor-hint")!;
  const rawBreakdown = document.getElementById("raw-breakdown") as HTMLDetailsElement;
  const components = result.components ?? [];
  factorTip.id = "factor-tip";
  if (components.length > 0) {
    renderFactors(components, factorGroups, factorTip);
    factorGroups.classList.remove("hidden");
    factorHint.classList.remove("hidden");
    rawBreakdown.open = false;
  } else {
    factorGroups.classList.add("hidden");
    factorHint.classList.add("hidden");
    rawBreakdown.open = true;
  }

  reasonLines.innerHTML = "";
  for (const reason of result.reasons ?? []) {
    const div = document.createElement("div");
    div.className = "reason-line";
    div.textContent = reason;
    reasonLines.appendChild(div);
  }

  srAnnounce.textContent = `Score ${result.score} out of 100, tier ${tier}. ${pathText}.`;
  explorerLink.href = `https://stellar.expert/explorer/public/account/${result.wallet}`;

  verifyStage.classList.add("hidden");
  unverifiableNote.classList.add("hidden");
  scoreStage.classList.remove("hidden");

  // Holdings load in the background - the score never waits on them.
  void loadPortfolio(result.wallet);

  // An indicative credit line is only shown for a wallet whose owner has proven it - a
  // pasted address is somebody else's public data. Flip this if a partner embed wants it open.
  // A connected wallet is saved with the waitlist email (so nobody retypes it); a pasted address is
  // someone else's public data and is never attached.
  const verified = statusDot.dataset.verified === "true";
  setWaitlistWallet(currentMode === "wallet" ? { address: result.wallet, verified } : null);
  if (verified) {
    void loadCreditLine(result.wallet);
  } else {
    showCreditLineLocked(
      currentMode === "pasted"
        ? "Connect your wallet and verify ownership to see an indicative credit line. A pasted address is read-only."
        : "Smart-contract wallets can't be verified yet, so an indicative credit line isn't available for this one.",
    );
  }
}

copyBtn.addEventListener("click", async () => {
  const wallet = resultWallet.textContent;
  if (!wallet) return;
  try {
    await navigator.clipboard.writeText(wallet);
    copyBtn.textContent = "Copied";
  } catch {
    copyBtn.textContent = "Select to copy";
  }
  setTimeout(() => {
    copyBtn.textContent = "Copy";
  }, 1500);
});

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
      connectBtn.textContent = "Scoring…";
      const result = await fetchScoreWithNotice(address);
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
  pasteBtn.textContent = "Scoring…";
  try {
    const result = await fetchScoreWithNotice(address);
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
    verifyBtn.textContent = "Scoring…";
    const result = await fetchScoreWithNotice(currentAddress);
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
