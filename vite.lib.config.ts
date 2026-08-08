import { defineConfig } from "vite";
import { resolve } from "node:path";

// Library build (Phase 4): the embeddable engine, separate from the demo
// pages. Emits an ESM build for bundler/npm consumers and a self-contained
// IIFE for CDN <script> use (window.DecimenOptical). Both inline the decode
// worker + zxing WASM so a consumer needs no special asset wiring; the WASM
// is ~940 KB and lives only in the receiver path.
export default defineConfig({
  build: {
    outDir: "dist-lib",
    lib: {
      entry: resolve(__dirname, "lib/index.ts"),
      name: "DecimenOptical",
      formats: ["es", "iife"],
      fileName: (fmt) => (fmt === "es" ? "decimen-optical.js" : "decimen-optical.iife.js"),
    },
    rollupOptions: {
      output: { inlineDynamicImports: false },
    },
  },
  worker: { format: "es" },
});
