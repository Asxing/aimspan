import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  // Electron loads production assets through file://, so absolute /assets URLs
  // would resolve outside the packaged renderer directory and render a blank window.
  base: "./",
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: "dist/renderer",
    emptyOutDir: false,
    rollupOptions: {
      input: {
        index: resolve(import.meta.dirname, "index.html"),
        capture: resolve(import.meta.dirname, "capture.html"),
        bubble: resolve(import.meta.dirname, "bubble.html"),
        compact: resolve(import.meta.dirname, "compact.html"),
      },
    },
  },
});
