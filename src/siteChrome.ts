// Shared site chrome for the legacy stellar.lcrd.fi root pages: a top banner linking to the embedded
// credit app (/credit) and a footer waitlist — injected on EVERY page so they stay identical without
// editing each HTML file. The waitlist reuses the SAME backend as the /credit app and the indicative
// credit-card view (src/waitlist.ts -> POST /waitlist -> credit_bureau.waitlist), so all sign-ups land
// in one place and the "already joined" flag is shared across the whole site.
import { joinWaitlist } from "./waitlist";

const JOINED_KEY = "lcrd-waitlist-joined"; // shared with creditWaitlist.ts / creditLineView.ts
const FINEPRINT = "We'll only use your email to tell you about LCRD credit lines, and you can ask us to delete it any time.";
const YEAR = new Date().getFullYear();

function injectBanner() {
  // A page may already hard-code the banner (index.html does) — don't add a second one.
  if (document.querySelector(".credit-banner")) return;
  const a = document.createElement("a");
  a.className = "credit-banner";
  a.href = "/credit/";
  a.innerHTML =
    '<span class="credit-banner-tag">New</span>' +
    "<span>Try our embedded credit app on testnet — supply USDC, borrow on your score, and earn.</span>" +
    '<span class="credit-banner-cta">Test it&nbsp;&rarr;</span>';
  document.body.insertBefore(a, document.body.firstChild);
}

function injectFooter() {
  if (document.querySelector(".site-footer")) return;
  const footer = document.createElement("footer");
  footer.className = "site-footer";
  footer.innerHTML =
    '<div class="site-footer-inner">' +
    '  <form class="site-wl" novalidate>' +
    "    <h3>Want this when it launches?</h3>" +
    "    <p>Join the waitlist and we'll email you when LCRD credit lines open. Just your email.</p>" +
    '    <div class="site-wl-row">' +
    '      <label for="site-wl-email" class="sr-only">Email address</label>' +
    '      <input id="site-wl-email" type="email" inputmode="email" autocomplete="email" placeholder="you@example.com" maxlength="254" required />' +
    '      <input id="site-wl-website" class="cl-hp" type="text" tabindex="-1" autocomplete="off" aria-hidden="true" />' +
    '      <button type="submit" class="btn-secondary site-wl-btn">Join waitlist</button>' +
    "    </div>" +
    '    <p class="site-wl-msg" role="status"></p>' +
    '    <p class="site-wl-fine">' + FINEPRINT + "</p>" +
    "  </form>" +
    '  <p class="site-footer-legal"><a href="/credit/" class="footer-link-credit">Try the credit app (testnet) &rarr;</a>' +
    "   &middot; © " + YEAR + " LCRD &middot; On-chain credit on Stellar &middot; Testnet</p>" +
    "</div>";
  document.body.appendChild(footer);

  const form = footer.querySelector(".site-wl") as HTMLFormElement;
  const email = footer.querySelector("#site-wl-email") as HTMLInputElement;
  const honeypot = footer.querySelector("#site-wl-website") as HTMLInputElement;
  const btn = footer.querySelector(".site-wl-btn") as HTMLButtonElement;
  const msg = footer.querySelector(".site-wl-msg") as HTMLElement;

  const markJoined = () => {
    form.dataset.joined = "true";
    msg.textContent = "You're on the list. We'll email you when credit lines open.";
    email.disabled = true;
    btn.disabled = true;
    btn.textContent = "Joined";
  };
  try { if (localStorage.getItem(JOINED_KEY) === "1") markJoined(); } catch { /* storage unavailable */ }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const value = email.value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)) {
      msg.textContent = "Enter a valid email address.";
      email.focus();
      return;
    }
    btn.disabled = true;
    btn.textContent = "Joining…";
    msg.textContent = "";
    try {
      await joinWaitlist(value, honeypot.value, null);
      try { localStorage.setItem(JOINED_KEY, "1"); } catch { /* storage unavailable */ }
      markJoined();
    } catch (err) {
      msg.textContent = (err as Error)?.message || "Couldn't join the waitlist right now. Please try again.";
      btn.disabled = false;
      btn.textContent = "Join waitlist";
    }
  });
}

/** Inject the banner + waitlist footer once per page (guards against double-mount when two entry
 *  scripts on the same page both import this). */
export function mountSiteChrome() {
  if (!document.body) {
    document.addEventListener("DOMContentLoaded", mountSiteChrome, { once: true });
    return;
  }
  injectBanner();
  injectFooter();
}

mountSiteChrome();
