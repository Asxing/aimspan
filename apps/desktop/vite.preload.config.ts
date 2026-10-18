import { builtinModules } from "node:module";
import { resolve } from "node:path";
import { defineConfig } from "vite";

const nodeExternals = builtinModules.flatMap((name) => [name, `node:${name}`]);

export default defineConfig({
  build: {
    outDir: "dist/preload",
    emptyOutDir: false,
    sourcemap: true,
    lib: {
      // Separate bundles keep each sandboxed window's authority narrow.
      entry: Object.fromEntries(["index", "capture", "bubble", "compact"].map(name => [name, resolve(import.meta.dirname, `src/preload/${name}.ts`)])),
      formats: ["cjs"],
      fileName: (_format, entryName) => `${entryName}.cjs`,
    },
    rollupOptions: {
      external: ["electron", ...nodeExternals],
    },
  },
});
