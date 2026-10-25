import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import { e2eSettings } from "../../src/settings.ts";

const root = fileURLToPath(new URL(".", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const settings = e2eSettings();
const publicDir = settings.str("asset-browser-public");
if (!publicDir) throw new Error("PCASH_E2E_ASSET_BROWSER_PUBLIC is required");
const outDir = settings.str("asset-browser-dist");
if (!outDir) throw new Error("PCASH_E2E_ASSET_BROWSER_DIST is required");

export default defineConfig({
  root,
  envDir: false,
  publicDir,
  worker: { format: "es" },
  build: { outDir, emptyOutDir: true },
  server: {
    fs: { allow: [repositoryRoot] },
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Cross-Origin-Resource-Policy": "same-origin",
    },
  },
  preview: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Cross-Origin-Resource-Policy": "same-origin",
    },
  },
});
