import type { ScoreComponent } from "./score";

const GROUPS: { id: ScoreComponent["group"]; title: string }[] = [
  { id: "core", title: "What drives your score" },
  { id: "income", title: "Income" },
  { id: "bonus", title: "Bonus" },
];

let activeClose: (() => void) | null = null;
let clickAwayInstalled = false;

const usdFmt = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function amountText(c: ScoreComponent): string | null {
  if (c.amountUsd === null || c.amountUsd === undefined) return null;
  return `${usdFmt.format(c.amountUsd)} ${c.amountLabel ?? ""}`.trim();
}

/**
 * Renders each scoring term as a pill (points out of its maximum) with an explanation tooltip.
 * One shared tooltip element sits inside the container and is positioned under the active pill,
 * spanning the container's width, so it can never run off the card or the screen. It opens on
 * hover/focus, and a tap or click pins it (touch devices have no hover).
 */
export function renderFactors(components: ScoreComponent[], container: HTMLElement, tip: HTMLElement) {
  container.replaceChildren();
  container.append(tip);
  let pinned: HTMLElement | null = null;

  const show = (pill: HTMLElement, c: ScoreComponent) => {
    tip.replaceChildren();
    tip.append(el("strong", undefined, `${c.label}: ${c.points} of ${c.max}`));
    tip.append(el("p", undefined, c.explain));
    if (c.detail) tip.append(el("p", "factor-tip-detail", c.detail));
    tip.style.top = `${pill.offsetTop + pill.offsetHeight + 6}px`;
    tip.classList.remove("hidden");
    container.querySelectorAll("[aria-describedby]").forEach((p) => p.removeAttribute("aria-describedby"));
    pill.setAttribute("aria-describedby", tip.id);
  };
  const hide = () => {
    if (pinned) return;
    tip.classList.add("hidden");
  };

  for (const g of GROUPS) {
    const items = components.filter((c) => c.group === g.id);
    if (items.length === 0) continue;
    const section = el("div", "factor-group");
    section.append(el("div", "factor-group-title", g.title));
    const row = el("div", "factor-row");
    for (const c of items) {
      const pill = el("button", "factor-pill") as HTMLButtonElement;
      pill.type = "button";
      pill.dataset.state = c.points === 0 ? "zero" : c.points >= c.max ? "full" : "partial";
      pill.style.setProperty("--fill", `${Math.max(0, Math.min(100, (c.points / c.max) * 100))}%`);
      pill.append(el("span", "factor-name", c.label), el("span", "factor-pts", `${c.points}/${c.max}`));
      const amt = amountText(c);
      if (amt) pill.append(el("span", "factor-amt", amt));
      pill.addEventListener("pointerenter", (e) => { if ((e as PointerEvent).pointerType === "mouse") show(pill, c); });
      pill.addEventListener("pointerleave", (e) => { if ((e as PointerEvent).pointerType === "mouse") hide(); });
      pill.addEventListener("focus", () => show(pill, c));
      pill.addEventListener("blur", hide);
      pill.addEventListener("click", () => {
        if (pinned === pill) { pinned = null; tip.classList.add("hidden"); return; }
        pinned = pill;
        show(pill, c);
      });
      row.append(pill);
    }
    section.append(row);
    container.append(section);
  }

  // Tapping anywhere else closes a pinned tooltip (listener installed once; it always acts on the latest render).
  activeClose = () => { pinned = null; tip.classList.add("hidden"); };
  if (!clickAwayInstalled) {
    clickAwayInstalled = true;
    document.addEventListener("click", (e) => {
      if (!(e.target as HTMLElement).closest(".factor-pill")) activeClose?.();
    });
  }
}
