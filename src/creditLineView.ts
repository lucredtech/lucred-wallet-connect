import { fetchCreditLine, type CreditLine, type CreditModel, type CreditOffer } from "./creditLine";
import { joinWaitlist } from "./waitlist";

const $ = (id: string) => document.getElementById(id)!;
const card = $("credit-line");
const loading = $("cl-loading");
const errorEl = $("cl-error");
const locked = $("cl-locked");
const body = $("cl-body");
const tabs = $("cl-tabs");
const detail = $("cl-detail");
const collateralEl = $("cl-collateral");

const usdFmt = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const usd = (n: number) => usdFmt.format(n);
const pct = (n: number) => `${n.toFixed(2).replace(/\.?0+$/, "")}%`;

const MODEL_INFO: Record<CreditModel, { name: string; blurb: string }> = {
  secured: { name: "Secured", blurb: "Backed by the holdings the wallet could pledge" },
  unsecured: { name: "Unsecured", blurb: "Based on the LCRD score alone" },
  mix: { name: "Score + collateral", blurb: "The score sets the limit, holdings cap it" },
};
const ORDER: CreditModel[] = ["mix", "secured", "unsecured"];

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function breakdownRows(o: CreditOffer) {
  const b = o.aprBreakdown;
  if (!b) return [];
  const rows: [string, string][] = [
    ["Base rate", pct(b.basePct)],
    ["Score risk", `+${pct(b.scoreRiskPct)}`],
  ];
  if (b.securityDiscountPct !== 0) rows.push(["Collateral discount", pct(b.securityDiscountPct)]);
  if (b.unsecuredSurchargePct) rows.push(["Unsecured surcharge", `+${pct(b.unsecuredSurchargePct)}`]);
  if (b.volatileCollateralPct) rows.push(["Volatile collateral", `+${pct(b.volatileCollateralPct)}`]);
  return rows;
}

function renderDetail(data: CreditLine, model: CreditModel) {
  const o = data.offers[model];
  detail.replaceChildren();
  detail.setAttribute("aria-labelledby", `cl-tab-${model}`);

  if (!o.eligible) {
    detail.append(el("p", "cl-none", o.notes[0] || "Not available for this wallet."));
    return;
  }

  const head = el("div", "cl-head");
  const limit = el("div");
  limit.append(el("div", "stat-key", "Indicative limit"), el("div", "cl-limit", usd(o.limitUsd)));
  const apr = el("div");
  apr.append(el("div", "stat-key", "Indicative APR"), el("div", "cl-limit", pct(o.aprPct as number)));
  head.append(limit, apr);
  detail.append(head);

  for (const note of o.notes) detail.append(el("p", "cl-note", note));

  const rows = breakdownRows(o);
  if (rows.length) {
    const wrap = el("div", "cl-breakdown");
    wrap.append(el("div", "reasons-label", "How the APR is built"));
    for (const [label, value] of rows) {
      const r = el("div", "cl-row");
      r.append(el("span", undefined, label), el("span", "cl-val", value));
      wrap.append(r);
    }
    const total = el("div", "cl-row cl-total");
    total.append(el("span", undefined, "APR"), el("span", "cl-val", pct(o.aprPct as number)));
    wrap.append(total);
    if (o.aprBreakdown?.capped) wrap.append(el("p", "cl-note", "Held within the policy's minimum/maximum rate."));
    detail.append(wrap);
  }
}

function render(data: CreditLine) {
  loading.classList.add("hidden");
  errorEl.classList.add("hidden");
  locked.classList.add("hidden");
  body.classList.remove("hidden");

  let selected: CreditModel = ORDER.find((m) => data.offers[m].eligible) ?? "mix";
  const paint = () => {
    tabs.replaceChildren();
    for (const m of ORDER) {
      const o = data.offers[m];
      const t = el("button", "cl-tab");
      t.type = "button";
      t.id = `cl-tab-${m}`;
      t.setAttribute("role", "tab");
      t.setAttribute("aria-selected", String(m === selected));
      t.append(el("span", "cl-tab-name", MODEL_INFO[m].name));
      t.append(el("span", "cl-tab-limit", o.eligible ? usd(o.limitUsd) : "Not available"));
      t.append(el("span", "cl-tab-blurb", MODEL_INFO[m].blurb));
      t.addEventListener("click", () => { selected = m; paint(); });
      tabs.append(t);
    }
    renderDetail(data, selected);
  };
  paint();

  // What counted as collateral (and what didn't).
  const c = data.inputs.collateral;
  collateralEl.replaceChildren();
  collateralEl.append(el("div", "reasons-label", "Collateral counted"));
  if (c.classes.length === 0) collateralEl.append(el("p", "cl-note", "No transferable, priced holdings were found."));
  for (const k of c.classes) {
    const r = el("div", "cl-row");
    r.append(el("span", undefined, k.label), el("span", "cl-val", `${usd(k.marketUsd)} → ${usd(k.lendableUsd)}`));
    collateralEl.append(r);
  }
  if (c.classes.length) {
    const total = el("div", "cl-row cl-total");
    total.append(el("span", undefined, "Lendable collateral"), el("span", "cl-val", usd(c.lendableUsd)));
    collateralEl.append(total);
  }
  if (data.inputs.debtUsd > 0) collateralEl.append(el("p", "cl-note", `Existing borrowing of ${usd(data.inputs.debtUsd)} is deducted from the limit.`));
  if (c.excludedUsd > 0) collateralEl.append(el("p", "cl-note", `${usd(c.excludedUsd)} of holdings can't be pledged (not transferable), so they aren't counted.`));

  $("cl-disclaimer").textContent = data.disclaimer;
}

let requestId = 0;

export function resetCreditLine() {
  requestId++;
  card.classList.add("hidden");
}

/** Wallets that haven't proven ownership only see why the section is locked. */
export function showCreditLineLocked(reason: string) {
  requestId++;
  card.classList.remove("hidden");
  loading.classList.add("hidden");
  errorEl.classList.add("hidden");
  body.classList.add("hidden");
  locked.textContent = reason;
  locked.classList.remove("hidden");
}

export async function loadCreditLine(address: string) {
  const mine = ++requestId;
  card.classList.remove("hidden");
  loading.classList.remove("hidden");
  errorEl.classList.add("hidden");
  locked.classList.add("hidden");
  body.classList.add("hidden");
  try {
    const data = await fetchCreditLine(address);
    if (mine === requestId) render(data);
  } catch (err) {
    if (mine !== requestId) return;
    loading.classList.add("hidden");
    errorEl.textContent = (err as Error)?.message || "Couldn't compute an indicative credit line right now.";
    errorEl.classList.remove("hidden");
  }
}

// ---- Waitlist: just an email ----
const JOINED_KEY = "lcrd-waitlist-joined";
const wlForm = $("cl-waitlist") as HTMLFormElement;
const wlEmail = $("cl-email") as HTMLInputElement;
const wlHoneypot = $("cl-website") as HTMLInputElement;
const wlBtn = $("cl-join") as HTMLButtonElement;
const wlMsg = $("cl-waitlist-msg");

function markJoined() {
  wlForm.dataset.joined = "true";
  wlMsg.textContent = "You're on the list. We'll email you when credit lines open.";
  wlEmail.disabled = true;
  wlBtn.disabled = true;
  wlBtn.textContent = "Joined";
}

// A per-browser convenience only: remembering that this visitor already signed up.
try { if (localStorage.getItem(JOINED_KEY) === "1") markJoined(); } catch { /* storage unavailable */ }

wlForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = wlEmail.value.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    wlMsg.textContent = "Enter a valid email address.";
    wlEmail.focus();
    return;
  }
  wlBtn.disabled = true;
  wlBtn.textContent = "Joining…";
  wlMsg.textContent = "";
  try {
    await joinWaitlist(email, wlHoneypot.value);
    try { localStorage.setItem(JOINED_KEY, "1"); } catch { /* storage unavailable */ }
    markJoined();
  } catch (err) {
    wlMsg.textContent = (err as Error)?.message || "Couldn't join the waitlist right now. Please try again.";
    wlBtn.disabled = false;
    wlBtn.textContent = "Join waitlist";
  }
});
