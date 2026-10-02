import { defineConfig } from "vite";
import { resolve } from "path";

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        howItWorks: resolve(__dirname, "how-it-works.html"),
      },
    },
  },
});
