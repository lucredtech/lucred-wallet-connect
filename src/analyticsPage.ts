import "./style.css";
import "./analytics"; // Vercel Web Analytics (page views)

const API_URL = import.meta.env.VITE_CREDIT_SCORE_API_URL as string | undefined;

type Kpis = {
  totalEvents: number; totalWallets: number; totalProtocols: number; maxLedger: number;
  firstEvent: string; lastEvent: string; events24h: number; events7d: number;
};
type Analytics = {
  computedAt: string;
  kpis: Kpis;
  byProtocol: { name: string; events: number; wallets: number }[];
  byCategory: { name: string; events: number }[];
  topAssets: { code: string; events: number }[];
  eventsPerDay: { day: string; events: number }[];
  eventsPerDayByProtocol: { name: string; series: { day: string; events: number }[] }[];
  walletsByMonth: { month: string; newWallets: number; cumulativeWallets: number }[];
  product: { waitlist: number; acceptances: number; principalUsd: number };
};

const $ = (id: string) => document.getElementById(id) as HTMLElement;
const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 2 });
const full = new Intl.NumberFormat("en");
const usd = (n: number) => "$" + compact.format(n);

// Protocol/category slugs come through as snake_case; show them readably.
const titleCase = (s: string) => s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

function tile(label: string, value: string, sub?: string, hero = false): string {
  return `<div class="an-tile${hero ? " an-hero" : ""}"><div class="an-tile-val">${value}</div><div class="an-tile-label">${label}</div>${sub ? `<div class="an-tile-sub">${sub}</div>` : ""}</div>`;
}

function renderKpis(k: Kpis) {
  $("an-kpis").innerHTML = [
    tile("Credit events indexed", compact.format(k.totalEvents), full.format(k.totalEvents) + " on-chain events", true),
    tile("Wallets scored", compact.format(k.totalWallets)),
    tile("Protocols covered", String(k.totalProtocols)),
    tile("Events · last 24h", compact.format(k.events24h)),
    tile("Events · last 7d", compact.format(k.events7d)),
    tile("Max ledger indexed", compact.format(k.maxLedger)),
  ].join("");
}

function renderProduct(p: Analytics["product"]) {
  $("an-product").innerHTML = [
    tile("USDC advanced", usd(p.principalUsd)),
    tile("Credit acceptances", full.format(p.acceptances)),
    tile("Waitlist signups", full.format(p.waitlist)),
  ].join("");
}

// Horizontal bars for a single measure across categories; values direct-labelled (no tooltip needed).
function renderBars(id: string, items: { label: string; value: number }[]) {
  const max = items.reduce((m, it) => Math.max(m, it.value), 0) || 1;
  $(id).innerHTML = items.map((it) => `
    <div class="an-bar-row" title="${it.label}: ${full.format(it.value)}">
      <span class="an-bar-label">${it.label}</span>
      <span class="an-bar-track"><span class="an-bar-fill" style="width:${Math.max(1.5, (it.value / max) * 100)}%"></span></span>
      <span class="an-bar-val">${compact.format(it.value)}</span>
    </div>`).join("");
}

// One-series area chart (SVG) with a hover crosshair + tooltip.
function renderArea(id: string, points: { label: string; value: number }[]) {
  const host = $(id);
  if (points.length < 2) { host.innerHTML = `<p class="an-empty">Not enough data yet.</p>`; return; }
  const W = 640, H = 200, PAD_L = 8, PAD_R = 8, PAD_T = 12, PAD_B = 22;
  const iw = W - PAD_L - PAD_R, ih = H - PAD_T - PAD_B;
  const max = points.reduce((m, p) => Math.max(m, p.value), 0) || 1;
  const x = (i: number) => PAD_L + (points.length === 1 ? iw / 2 : (i / (points.length - 1)) * iw);
  const y = (v: number) => PAD_T + ih - (v / max) * ih;
  const line = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)} ${y(p.value).toFixed(1)}`).join(" ");
  const area = `${line} L${x(points.length - 1).toFixed(1)} ${(PAD_T + ih).toFixed(1)} L${x(0).toFixed(1)} ${(PAD_T + ih).toFixed(1)} Z`;
  const first = points[0].label, last = points[points.length - 1].label;
  // Faint horizontal grid lines at 25/50/75/100% of the plot height.
  const grid = [0.25, 0.5, 0.75, 1].map((f) => {
    const gy = (PAD_T + ih - f * ih).toFixed(1);
    return `<line x1="${PAD_L}" y1="${gy}" x2="${W - PAD_R}" y2="${gy}" stroke="var(--color-border-subtle)" stroke-width="1" vector-effect="non-scaling-stroke"/>`;
  }).join("");
  host.innerHTML = `
    <svg class="an-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="time series">
      <defs>
        <linearGradient id="${id}-g" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="var(--indigo-600)" stop-opacity="0.45"/>
          <stop offset="1" stop-color="var(--indigo-600)" stop-opacity="0"/>
        </linearGradient>
        <linearGradient id="${id}-s" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stop-color="var(--indigo-600)"/>
          <stop offset="1" stop-color="var(--cyan-300)"/>
        </linearGradient>
        <filter id="${id}-glow" x="-20%" y="-50%" width="140%" height="200%">
          <feGaussianBlur stdDeviation="3" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
        </filter>
      </defs>
      ${grid}
      <path d="${area}" fill="url(#${id}-g)"/>
      <path d="${line}" fill="none" stroke="url(#${id}-s)" stroke-width="2.5" stroke-linejoin="round" vector-effect="non-scaling-stroke" filter="url(#${id}-glow)"/>
      <line class="an-cross" x1="0" y1="${PAD_T}" x2="0" y2="${PAD_T + ih}" stroke="var(--color-border-strong)" stroke-width="1" vector-effect="non-scaling-stroke" style="opacity:0"/>
      <circle class="an-dot" r="4" fill="var(--cyan-300)" stroke="var(--navy-950)" stroke-width="1.5" style="opacity:0"/>
      <rect class="an-hit" x="0" y="0" width="${W}" height="${H}" fill="transparent"/>
    </svg>
    <div class="an-axis"><span>${first}</span><span>${last}</span></div>
    <div class="an-tip" style="opacity:0"></div>`;

  const svg = host.querySelector("svg") as SVGSVGElement;
  const cross = host.querySelector(".an-cross") as SVGLineElement;
  const dot = host.querySelector(".an-dot") as SVGCircleElement;
  const tip = host.querySelector(".an-tip") as HTMLElement;
  const hit = host.querySelector(".an-hit") as SVGRectElement;
  const move = (ev: PointerEvent | MouseEvent) => {
    const r = svg.getBoundingClientRect();
    const px = ((ev.clientX - r.left) / r.width) * W;
    let i = Math.round(((px - PAD_L) / iw) * (points.length - 1));
    i = Math.max(0, Math.min(points.length - 1, i));
    const p = points[i];
    cross.setAttribute("x1", String(x(i))); cross.setAttribute("x2", String(x(i))); cross.style.opacity = "1";
    dot.setAttribute("cx", String(x(i))); dot.setAttribute("cy", String(y(p.value))); dot.style.opacity = "1";
    tip.innerHTML = `<strong>${full.format(p.value)}</strong><span>${p.label}</span>`;
    tip.style.opacity = "1";
    const leftPct = (x(i) / W) * 100;
    tip.style.left = Math.max(4, Math.min(96, leftPct)) + "%";
  };
  const leave = () => { cross.style.opacity = "0"; dot.style.opacity = "0"; tip.style.opacity = "0"; };
  hit.addEventListener("pointermove", move);
  hit.addEventListener("pointerleave", leave);
}

// Events-per-day filter: "All" plus the top protocols, swapping the series client-side.
function renderEventsFilter(d: Analytics) {
  const host = $("an-events-filter");
  if (!host) return;
  const days = d.eventsPerDay.map((e) => e.day);
  // Align each protocol's sparse series to the full day axis (missing days -> 0).
  const aligned = (d.eventsPerDayByProtocol || []).map((p) => {
    const m = new Map(p.series.map((s) => [s.day, s.events]));
    return { name: p.name, series: days.map((day) => ({ day, events: m.get(day) || 0 })) };
  });
  const options = [{ name: "All", series: d.eventsPerDay }, ...aligned];
  host.innerHTML = options
    .map((o, i) => `<button type="button" class="an-chip${i === 0 ? " is-active" : ""}" data-i="${i}">${titleCase(o.name)}</button>`)
    .join("");
  const draw = (pts: { day: string; events: number }[]) =>
    renderArea("an-events-chart", pts.map((p) => ({ label: p.day, value: p.events })));
  draw(options[0].series);
  host.querySelectorAll(".an-chip").forEach((btn) => {
    btn.addEventListener("click", () => {
      host.querySelectorAll(".an-chip").forEach((b) => b.classList.remove("is-active"));
      btn.classList.add("is-active");
      draw(options[Number((btn as HTMLElement).dataset.i)].series);
    });
  });
}

async function load() {
  if (!API_URL) { $("an-status").textContent = "Analytics API is not configured."; return; }
  try {
    const res = await fetch(`${API_URL}/analytics`, { headers: { accept: "application/json" } });
    if (res.status === 503) { // still warming the cache on a cold start
      $("an-status").textContent = "Analytics are warming up — retrying…";
      setTimeout(load, 4000);
      return;
    }
    if (!res.ok) throw new Error("HTTP " + res.status);
    const d = (await res.json()) as Analytics;

    renderKpis(d.kpis);
    renderProduct(d.product);
    renderBars("an-protocol-bars", d.byProtocol.map((p) => ({ label: titleCase(p.name), value: p.events })));
    renderBars("an-category-bars", d.byCategory.map((c) => ({ label: titleCase(c.name), value: c.events })));
    renderBars("an-asset-bars", d.topAssets.map((a) => ({ label: a.code, value: a.events })));
    renderArea("an-wallets-chart", d.walletsByMonth.map((m) => ({ label: m.month, value: m.cumulativeWallets })));
    renderEventsFilter(d);

    const when = new Date(d.computedAt);
    $("an-freshness").textContent =
      `Data through ledger ${full.format(d.kpis.maxLedger)} · updated ${when.toLocaleString()}`;

    $("an-status").hidden = true;
    $("an-content").hidden = false;
  } catch (e) {
    $("an-status").textContent = "Couldn't load analytics right now. " + (e as Error).message;
  }
}

load();
