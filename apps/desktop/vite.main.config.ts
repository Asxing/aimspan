import { builtinModules } from "node:module";
import { resolve } from "node:path";
import { defineConfig } from "vite";

const nodeExternals = builtinModules.flatMap((name) => [name, `node:${name}`]);

export default defineConfig({
  build: {
    outDir: "dist/main",
    emptyOutDir: true,
    sourcemap: true,
    lib: {
      entry: {
        index: resolve(import.meta.dirname, "src/main/index.ts"),
      },
      formats: ["cjs"],
      fileName: (_format, entryName) => `${entryName}.cjs`,
    },
    rollupOptions: {
      external: ["electron", "@aimspan/core", /^node:/, ...nodeExternals],
    },
  },
});
