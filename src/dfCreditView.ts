import { fetchDfQuote, acceptDfTerms, type DfTerms, type DfStructure } from "./dfCredit";

const $ = (id: string) => document.getElementById(id)!;
const card = $("df-credit");
const loading = $("df-loading");
const errorEl = $("df-error");
const ineligibleEl = $("df-ineligible");
const previewEl = $("df-preview");
const asofEl = $("df-asof");
const body = $("df-body");
const controls = $("df-controls");
const summary = $("df-summary");
const collateralEl = $("df-collateral");
const acceptWrap = $("df-accept-wrap");

const usdFmt = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const usd = (n: number) => usdFmt.format(n);
const usd2 = (n: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(n);
const pct = (n: number) => `${n.toFixed(2).replace(/\.?0+$/, "")}%`;
const shortId = (id: string) => `${id.slice(0, 4)}…${id.slice(-4)}`;

const TERM_OPTIONS = [30, 90, 180, 365];
const TERM_LABEL: Record<number, string> = { 30: "30 days", 90: "90 days", 180: "180 days", 365: "1 year" };

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function row(label: string, value: string, cls = "df-row") {
  const r = el("div", cls);
  r.append(el("span", undefined, label), el("span", "df-val", value));
  return r;
}

// ---- view state ----
let requestId = 0;
let state: { address: string; preview: boolean; structure: DfStructure; termDays: number } = {
  address: "", preview: true, structure: "open_ended", termDays: 90,
};

function renderControls() {
  controls.replaceChildren();
  const seg = el("div", "df-seg");
  (["open_ended", "fixed_term"] as DfStructure[]).forEach((s) => {
    const b = el("button", "df-seg-btn");
    b.type = "button";
    b.textContent = s === "open_ended" ? "Open-ended" : "Fixed term";
    b.setAttribute("aria-pressed", String(state.structure === s));
    b.addEventListener("click", () => { if (state.structure !== s) { state.structure = s; refresh(); } });
    seg.append(b);
  });
  controls.append(seg);

  const termWrap = el("label", "df-term");
  termWrap.append(el("span", "df-term-label", "Repay within"));
  const sel = el("select", "df-term-select") as HTMLSelectElement;
  for (const d of TERM_OPTIONS) {
    const opt = document.createElement("option");
    opt.value = String(d);
    opt.textContent = TERM_LABEL[d];
    if (d === state.termDays) opt.selected = true;
    sel.append(opt);
  }
  sel.disabled = state.structure !== "fixed_term";
  sel.addEventListener("change", () => { state.termDays = Number(sel.value); if (state.structure === "fixed_term") refresh(); });
  termWrap.append(sel);
  controls.append(termWrap);
}

function renderTerms(data: DfTerms) {
  renderControls();

  // Summary: advance + APR + structure.
  summary.replaceChildren();
  const head = el("div", "df-head");
  const adv = el("div");
  adv.append(el("div", "stat-key", "You could draw"), el("div", "df-amount", usd(data.advance!.principalUsd)), el("div", "df-sub", "USDC to your wallet"));
  const apr = el("div");
  const termText = data.terms!.structure === "fixed_term"
    ? `${TERM_LABEL[data.terms!.termDays as number] || data.terms!.termDays + " days"} term`
    : "Open-ended";
  apr.append(el("div", "stat-key", "Indicative APR"), el("div", "df-amount", pct(data.terms!.aprPct)), el("div", "df-sub", termText));
  head.append(adv, apr);
  summary.append(head);

  summary.append(row(`Advance rate (${pct(data.advance!.rate * 100)} of position)`, `${usd(data.advance!.principalUsd)} of ${usd(data.collateral!.marketUsd)}`));
  if (data.terms!.maturityDate) {
    summary.append(row("Repay by", new Date(data.terms!.maturityDate).toLocaleDateString()));
  } else {
    summary.append(row("Repayment", "No fixed date — interest accrues until you repay"));
  }

  // Interest-growth projection (the open-ended risk, made legible).
  const proj = el("div", "df-proj");
  proj.append(el("div", "reasons-label", "What you'd owe if unpaid (interest only)"));
  proj.append(row("After 30 days", usd2(data.projectedDebt!.d30)));
  proj.append(row("After 90 days", usd2(data.projectedDebt!.d90)));
  proj.append(row("After 1 year", usd2(data.projectedDebt!.d365)));
  summary.append(proj);

  // Health / liquidation ladder (disclosure only in this stage).
  const health = el("div", "df-proj");
  health.append(el("div", "reasons-label", "Collateral health"));
  health.append(row("Starting loan-to-value", pct(data.ltv!.originationLtv * 100)));
  health.append(row("Margin call at", pct(data.ltv!.marginCallLtv * 100)));
  health.append(row("Liquidation at", pct(data.ltv!.liquidationLtv * 100)));
  summary.append(health);

  // Collateral: per-vault.
  collateralEl.replaceChildren();
  collateralEl.append(el("div", "reasons-label", "Collateral locked (your DeFindex position)"));
  for (const v of data.collateral!.vaults) {
    const under = v.underlying.map((u) => `${u.code || "?"}`).join(", ");
    collateralEl.append(row(`Vault ${shortId(v.shareToken)}${under ? ` · ${under}` : ""}`, `${usd(v.marketUsd)} → ${usd(v.lendableUsd)} lendable`));
  }
  const total = row("Total position", `${usd(data.collateral!.marketUsd)} → ${usd(data.collateral!.lendableUsd)}`, "df-row df-total");
  collateralEl.append(total);

  // Accept.
  acceptWrap.replaceChildren();
  if (state.preview) {
    acceptWrap.append(el("p", "df-note", "Connect your wallet and verify ownership to accept these terms."));
  } else {
    const btn = el("button", "btn-primary df-accept-btn", "Review & accept terms") as HTMLButtonElement;
    const msg = el("p", "df-note");
    msg.id = "df-accept-msg";
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      btn.textContent = "Recording…";
      msg.textContent = "";
      try {
        const r = await acceptDfTerms({
          wallet: data.wallet as string,
          walletVerified: !state.preview,
          structure: data.terms!.structure,
          termDays: data.terms!.termDays,
          quote: data,
        });
        btn.textContent = "Accepted";
        msg.textContent = r.demo
          ? "Terms accepted (demo — no funds have moved). On testnet this will lock your dfTokens and disburse USDC."
          : "Terms accepted.";
      } catch (err) {
        btn.disabled = false;
        btn.textContent = "Review & accept terms";
        msg.textContent = (err as Error)?.message || "Couldn't record acceptance right now.";
      }
    });
    acceptWrap.append(btn, msg);
  }

  $("df-disclaimer").textContent = data.disclaimer;
}

function showIneligible(reason: string) {
  loading.classList.add("hidden");
  errorEl.classList.add("hidden");
  body.classList.add("hidden");
  ineligibleEl.textContent = reason;
  ineligibleEl.classList.remove("hidden");
}

function setPreview(preview: boolean) {
  previewEl.textContent = preview
    ? "Preview for this address, estimated from its public DeFindex position. Connect and verify your wallet to borrow against your own."
    : "";
  previewEl.classList.toggle("hidden", !preview);
  asofEl.textContent = preview ? "preview" : "demo";
}

async function refresh() {
  const mine = ++requestId;
  loading.classList.remove("hidden");
  errorEl.classList.add("hidden");
  ineligibleEl.classList.add("hidden");
  body.classList.add("hidden");
  renderControls(); // reflect the toggle immediately
  try {
    const data = await fetchDfQuote(state.address, state.structure, state.termDays);
    if (mine !== requestId) return;
    loading.classList.add("hidden");
    if (!data.eligible) { showIneligible(data.reason || "No eligible DeFindex position found for this wallet."); return; }
    body.classList.remove("hidden");
    renderTerms(data);
  } catch (err) {
    if (mine !== requestId) return;
    loading.classList.add("hidden");
    errorEl.textContent = (err as Error)?.message || "Couldn't load credit terms right now.";
    errorEl.classList.remove("hidden");
  }
}

export function resetDfCredit() {
  requestId++;
  card.classList.add("hidden");
}

/** preview = anything not a verified, owned wallet (pasted address or unverifiable C-wallet). */
export async function loadDfCredit(address: string, preview: boolean) {
  state = { address, preview, structure: "open_ended", termDays: 90 };
  card.classList.remove("hidden");
  setPreview(preview);
  await refresh();
}
