import { defineConfig } from "vite";
import { resolve } from "path";

// The rebuilt LCRD frontend (home / earn / collateral / score / portfolio / activity / faucet).
// Shipped on its own under stellar.lcrd.fi/credit via `npm run build:credit` (base "/credit/",
// output to dist/credit, home emitted as the index). The default `npm run build` keeps the full
// legacy multipage site at the root.
const creditPages = {
  home: resolve(__dirname, "home.html"),
  earn: resolve(__dirname, "earn.html"),
  collateral: resolve(__dirname, "collateral.html"),
  score: resolve(__dirname, "score.html"),
  portfolio: resolve(__dirname, "portfolio.html"),
  activity: resolve(__dirname, "activity.html"),
  faucet: resolve(__dirname, "faucet.html"),
};

export default defineConfig(({ mode }) => {
  if (mode === "credit") {
    return {
      base: "/credit/",
      build: {
        outDir: "dist/credit",
        emptyOutDir: true,
        rollupOptions: { input: creditPages },
      },
    };
  }
  // default: full legacy site at the root
  return {
    build: {
      rollupOptions: {
        input: {
          main: resolve(__dirname, "index.html"),
          howItWorks: resolve(__dirname, "how-it-works.html"),
          borrow: resolve(__dirname, "borrow.html"),
          testEscrow: resolve(__dirname, "test-escrow.html"),
          pool: resolve(__dirname, "pool.html"),
          analytics: resolve(__dirname, "analytics.html"),
          ...creditPages,
        },
      },
    },
  };
});
