import { inject } from "@vercel/analytics";

// Vercel Web Analytics: page views only (no cookies). A no-op outside Vercel,
// so local dev and previews without analytics enabled are unaffected.
inject();
