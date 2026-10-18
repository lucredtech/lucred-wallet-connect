import { defineConfig } from "vite";
import { resolve } from "path";

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        howItWorks: resolve(__dirname, "how-it-works.html"),
        borrow: resolve(__dirname, "borrow.html"),
        testEscrow: resolve(__dirname, "test-escrow.html"),
        pool: resolve(__dirname, "pool.html"),
        analytics: resolve(__dirname, "analytics.html"),
      },
    },
  },
});
