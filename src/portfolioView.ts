import { fetchPortfolio, type Portfolio, type PortfolioPosition } from "./portfolio";

const $ = (id: string) => document.getElementById(id)!;
const card = $("portfolio");
const loading = $("portfolio-loading");
const errorEl = $("portfolio-error");
const body = $("portfolio-body");
const asOf = $("portfolio-asof");

const usdFmt = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const usd = (n: number) => (n > 0 && n < 0.01 ? "<$0.01" : usdFmt.format(n));
const amount = (n: number) =>
  new Intl.NumberFormat("en-US", { maximumFractionDigits: n >= 1000 ? 2 : n >= 1 ? 4 : 6 }).format(n);

const PROTOCOL_NAMES: Record<string, string> = {
  blend: "Blend",
  aquarius: "Aquarius",
  defindex: "DeFindex",
  soroswap: "Soroswap",
  phoenix_defi_hub: "Phoenix",
  sushi_stellar: "Sushi",
  etherfuse: "Etherfuse",
  spiko: "Spiko",
};
const protocolName = (p: string) => {
  if (PROTOCOL_NAMES[p]) return PROTOCOL_NAMES[p];
  // Already a readable phrase (e.g. "aquarius concentrated-liquidity pools") - only capitalise it.
  if (p.includes(" ")) return p.charAt(0).toUpperCase() + p.slice(1);
  return p.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
};

const POSITION_LABELS: Record<string, string> = {
  collateral: "Collateral",
  supply: "Supplied",
  debt: "Borrowed",
  liquidity: "Liquidity pool",
  vault: "Vault",
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function row(left: string, middle: string, right: string, rightClass = "") {
  const r = el("div", "pf-row");
  r.append(el("span", "pf-name", left), el("span", "pf-amount", middle), el("span", `pf-usd ${rightClass}`.trim(), right));
  return r;
}

function renderPosition(p: PortfolioPosition) {
  const assets = p.assets.map((a) => `${amount(a.amount)} ${a.code ?? "?"}`).join(" + ");
  const isDebt = p.type === "debt";
  const value = p.usdValue === null ? "unpriced" : `${isDebt ? "−" : ""}${usd(p.usdValue)}`;
  const r = el("div", "pf-row pf-position");
  const name = el("span", "pf-name");
  name.append(el("span", "pf-proto", protocolName(p.protocol)), document.createTextNode(` ${POSITION_LABELS[p.type] ?? p.type}`));
  if (!p.fullyPriced && p.usdValue !== null) name.append(el("span", "pf-partial", "partly priced"));
  r.append(name, el("span", "pf-amount", assets), el("span", `pf-usd ${isDebt ? "pf-debt" : ""}`.trim(), value));
  return r;
}

function render(p: Portfolio) {
  loading.classList.add("hidden");
  errorEl.classList.add("hidden");
  body.classList.remove("hidden");
  asOf.textContent = `as of ${new Date(p.asOf).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;

  // Portfolio value = everything the wallet holds (tokens + DeFi positions). When it
  // owes anything, debt and the resulting net value get their own rows so the
  // headline number can't be mistaken for what is actually theirs.
  $("pf-gross").textContent = usd(p.totals.grossUsd);
  const hasDebt = p.totals.debtUsd > 0;
  $("pf-summary").classList.toggle("hidden", !hasDebt);
  if (hasDebt) {
    $("pf-debt").textContent = `−${usd(p.totals.debtUsd)}`;
    $("pf-net").textContent = usd(p.totals.netUsd);
  }

  const subs = $("pf-subtotals");
  subs.replaceChildren();
  const stat = (value: string, key: string) => {
    const s = el("div", "stat");
    s.append(el("div", "stat-value", value), el("div", "stat-key", key));
    return s;
  };
  subs.append(stat(usd(p.totals.tokensUsd), "Tokens"), stat(usd(p.totals.positionsUsd), "In DeFi"));

  const priced = p.tokens.filter((t) => t.usdValue !== null);
  const unpriced = p.tokens.filter((t) => t.usdValue === null);

  const tokensEl = $("pf-tokens");
  tokensEl.replaceChildren();
  if (priced.length === 0) tokensEl.append(el("p", "pf-empty", "No priced token balances."));
  for (const t of priced) tokensEl.append(row(t.code, amount(t.balance), usd(t.usdValue as number)));

  const wrap = $("pf-unpriced-wrap") as HTMLDetailsElement;
  const unpricedEl = $("pf-unpriced");
  unpricedEl.replaceChildren();
  const unpricedTotal = unpriced.length + p.hiddenUnpricedTokens;
  wrap.classList.toggle("hidden", unpricedTotal === 0);
  wrap.open = false;
  $("pf-unpriced-summary").textContent = `${unpricedTotal} other token${unpricedTotal === 1 ? "" : "s"} we can't price`;
  for (const t of unpriced) unpricedEl.append(row(t.code, amount(t.balance), "—", "pf-muted"));
  if (p.hiddenUnpricedTokens > 0) unpricedEl.append(el("p", "pf-empty", `…and ${p.hiddenUnpricedTokens} more`));

  // Dust (under a cent) is still in the totals but isn't worth a row.
  const shownPositions = p.positions.filter((pos) => pos.usdValue === null || pos.usdValue >= 0.01);
  const posEl = $("pf-positions");
  posEl.replaceChildren();
  $("pf-positions-section").classList.toggle("hidden", shownPositions.length === 0 && p.notShown.length === 0);
  if (shownPositions.length === 0) posEl.append(el("p", "pf-empty", "No open positions found in the protocols we can read."));
  for (const pos of shownPositions) posEl.append(renderPosition(pos));

  const notes: string[] = [
    "Estimates use live prices for verified tokens (XLM, USDC, EURC, PYUSD, AQUA, BLND, Etherfuse bonds) and for tokens on stellar.expert's curated list that trade at least $100K a week. Other tokens are listed but not counted, and a pool with one unpriced side counts only the priced side.",
  ];
  if (p.notShown.length) notes.push(`Not shown yet: ${p.notShown.map(protocolName).join(", ")}.`);
  if (p.partial) notes.push("Some positions couldn't be read just now, so totals may be incomplete.");
  $("pf-notes").textContent = notes.join(" ");
}

let requestId = 0;

export function resetPortfolio() {
  requestId++;
  card.classList.add("hidden");
}

export async function loadPortfolio(address: string) {
  const mine = ++requestId;
  card.classList.remove("hidden");
  loading.classList.remove("hidden");
  errorEl.classList.add("hidden");
  body.classList.add("hidden");
  asOf.textContent = "";
  try {
    const portfolio = await fetchPortfolio(address);
    if (mine === requestId) render(portfolio);
  } catch (err) {
    if (mine !== requestId) return;
    loading.classList.add("hidden");
    errorEl.textContent = (err as Error)?.message || "Couldn't load holdings right now.";
    errorEl.classList.remove("hidden");
  }
}
