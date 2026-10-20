// Shared site footer + waitlist for the /credit pages. Injected on every page (home / earn / score /
// collateral / portfolio / activity / faucet) so the nav-less footer stays identical everywhere without
// pasting markup into each HTML file. It reuses the SAME waitlist backend as the indicative credit-card
// view (src/waitlist.ts -> POST /waitlist -> credit_bureau.waitlist), so sign-ups land in one place.
import { joinWaitlist } from "./waitlist";

const JOINED_KEY = "lcrd-waitlist-joined"; // same per-browser flag the legacy credit-line view uses
const FINEPRINT = "We'll only use your email to tell you about LCRD credit lines, and you can ask us to delete it any time.";
const YEAR = new Date().getFullYear();

function build(): HTMLElement {
  const footer = document.createElement("footer");
  footer.className = "site-footer";
  footer.innerHTML = `
    <div class="wrap">
      <form id="foot-wl" class="foot-wl" novalidate>
        <h3>Want this when it launches?</h3>
        <p class="sm muted">Join the waitlist and we'll email you when LCRD credit lines open. Just your email.</p>
        <div class="foot-wl-row">
          <label for="foot-email" class="sr-only">Email address</label>
          <input id="foot-email" type="email" inputmode="email" autocomplete="email" placeholder="you@example.com" maxlength="254" required />
          <input id="foot-website" class="cl-hp" type="text" tabindex="-1" autocomplete="off" aria-hidden="true" />
          <button type="submit" id="foot-join" class="btn btn-primary">Join waitlist</button>
        </div>
        <p id="foot-wl-msg" class="sm muted" role="status"></p>
        <p id="foot-fineprint" class="tiny faint">${FINEPRINT}</p>
      </form>
      <p class="foot-legal tiny faint">© ${YEAR} LCRD · On-chain credit on Stellar · Testnet</p>
    </div>`;
  return footer;
}

function wire(root: HTMLElement) {
  const form = root.querySelector("#foot-wl") as HTMLFormElement;
  const email = root.querySelector("#foot-email") as HTMLInputElement;
  const honeypot = root.querySelector("#foot-website") as HTMLInputElement;
  const btn = root.querySelector("#foot-join") as HTMLButtonElement;
  const msg = root.querySelector("#foot-wl-msg") as HTMLElement;

  const markJoined = () => {
    form.dataset.joined = "true";
    msg.textContent = "You're on the list. We'll email you when credit lines open.";
    email.disabled = true;
    btn.disabled = true;
    btn.textContent = "Joined";
  };

  // Per-browser convenience: remember a visitor who already signed up (shared with the credit-line view).
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
      // No wallet is wired into the footer (it's on every page, not just score) — email only, like the
      // legacy "just your email" path. joinWaitlist tolerates a null wallet.
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

// Inject once, after the page's main content.
export function mountFooter() {
  if (document.querySelector(".site-footer")) return; // guard against double-mount
  const footer = build();
  document.body.appendChild(footer);
  wire(footer);
}

mountFooter();
