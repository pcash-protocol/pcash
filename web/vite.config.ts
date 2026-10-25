/// <reference types="vitest" />
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Config } from "@pcash/sdk/bcfg";
import { Logger } from "@pcash/sdk/blgr";
import { BROWSER_PROVER_ASSET_SET_ID } from "@pcash/sdk/constants/prover-artifacts";
import { toolRoot } from "@pcash/sdk/node/toolchain";
import { defineConfig, type Connect, type Plugin } from "vite";
import { explorerBoundaryPlugin } from "../scripts/explorer_boundary_plugin.mjs";
import { createBrowserProverManifest } from "../scripts/circuits/browser_assets.mjs";
import {
  browserProverAssetsMiddleware,
  resolveBrowserProverAssets,
} from "./scripts/prover_assets.mjs";
import { parseL1ChainId } from "./src/lib/l1Chain.ts";
import { aiTexts } from "./src/routes/docs/bundles.ts";
import { publicDocuments } from "./src/routes/docs/publicDocuments.ts";
import { resolveExplorerConfig } from "./src/routes/explorer/config.ts";
import { configuredNetwork } from "./src/lib/networks.ts";
import { resolveMarketplaceRouterConfiguration } from "./src/routes/marketplace/configuration.ts";
import { proverRuntimePlugin } from "./scripts/proverRuntime.ts";

const WEB_ROOT = fileURLToPath(new URL(".", import.meta.url));
const REPOSITORY_ROOT = resolve(WEB_ROOT, "..");
const EXPLORER_ENTRY = join(WEB_ROOT, "src", "routes", "explorer", "ExplorerRoute.tsx");
const logger = new Logger("info");
await logger.open();

export const VITE_OPTIMIZE_DEPS_EXCLUDE = ["@aztec-foundation/bb.js"] as const;
export const VITE_OPTIMIZE_DEPS_INCLUDE = [
  "@noir-lang/acvm_js",
  "@noir-lang/noirc_abi",
] as const;
export const VITE_FS_DENY = [
  ".env",
  ".env.*",
  "*.{crt,pem}",
  "**/.git/**",
  ".envrc",
  ".envrc.*",
  "**/.envrc",
  "**/.envrc.*",
  "**/.direnv/**",
  "**/.cache/**",
] as const;

function browserProverAssetsPlugin(config: Config): Plugin {
  const bundle = config.str("circuit-bundle") ?? undefined;
  const plan = resolveBrowserProverAssets({ bundle, toolRoot: toolRoot(), required: true });
  if (plan === undefined) throw new Error("browser prover asset plan is required");
  const manifest = createBrowserProverManifest(plan);
  if (manifest.assetSetId !== BROWSER_PROVER_ASSET_SET_ID) {
    throw new Error("local browser prover assets do not match this frontend release");
  }
  return {
    name: "pcash-browser-prover-assets",
    configureServer(server) {
      server.middlewares.use(browserProverAssetsMiddleware(plan, `/${manifest.assetSetId}`));
    },
  };
}

/**
 * Each published document as raw Markdown, beside its page at the page path
 * plus ".md", and the AI texts: `/llms.txt`, `/llms-full.txt` and the bundles.
 * The dev server reads the files from the repository; the build writes them
 * into the output.
 */
function markdownDocumentsPlugin(): Plugin {
  const files = new Set(publicDocuments.map(({ file }) => file));
  const read = (file: string) => readFileSync(join(REPOSITORY_ROOT, file), "utf8");
  const texts = aiTexts(read);
  const serve: Connect.NextHandleFunction = (request, response, next) => {
    const path = (request.url ?? "").split("?")[0]!;
    const text = texts.get(path);
    if (text !== undefined) {
      response.setHeader("Content-Type", "text/plain; charset=utf-8");
      response.end(text());
      return;
    }
    if (!files.has(path.slice(1))) return next();
    response.setHeader("Content-Type", "text/markdown; charset=utf-8");
    response.end(read(path.slice(1)));
  };
  return {
    name: "pcash-markdown-documents",
    configureServer(server) {
      server.middlewares.use(serve);
    },
    configurePreviewServer(server) {
      server.middlewares.use(serve);
    },
    generateBundle() {
      for (const file of files) this.emitFile({ type: "asset", fileName: file, source: read(file) });
      for (const [path, text] of texts) this.emitFile({ type: "asset", fileName: path.slice(1), source: text() });
    },
  };
}

const headers = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "same-origin",
};

export function browserEnvironment(config: Config): Record<string, string | undefined> {
  const value = (name: string) => config.str(name) ?? undefined;
  return {
    // "fixtures" renders the explorer from generated data with no node. Trimmed
    // here because the value is compared exactly in code that `define` inlines.
    VITE_PCASH_MODE: config.str("mode")?.trim(),
    VITE_PCASH_RPC_URL: value("rpc-url"),
    VITE_PCASH_PSCAN_URL: value("pscan-url"),
    VITE_PCASH_CHAIN_ID: value("chain-id"),
    VITE_PCASH_GENESIS_HASH: value("genesis-hash"),
    // The browser must follow the same L1 the node does, so this reuses the
    // node's own PCASH_L1_CHAIN_ID rather than a second variable that could drift.
    VITE_L1_CHAIN_ID: value("l1-chain-id"),
    // A comma-separated list, serialized into browser JavaScript. Never substitute
    // the operator-side PCASH_L1_RPC, which may contain provider credentials.
    VITE_L1_RPC_URLS: value("browser-l1-rpc-urls"),
    VITE_PAYMENT_ROUTER_ADDRESS: value("payment-router-address"),
    VITE_ENS_RPC_URL: value("ens-rpc-url"),
  };
}

/** Presence only: build logs must never contain environment values. */
export function marketplaceBuildEnvironmentDiagnostics(config: Config): string[] {
  return ["PCASH_PAYMENT_ROUTER_ADDRESS", "PCASH_PAYMENT_ROUTER_FEE_RECIPIENT", "PCASH_PAYMENT_ROUTER_FEE_BPS"].map(name => {
    const state = config.has(name.slice("PCASH_".length).replace(/_/g, "")) ? "set" : "unset";
    return `[pcash build env] ${name}: ${state}`
      + (name === "PCASH_PAYMENT_ROUTER_ADDRESS" ? "" : "; not used by browser (fees are read from the router)");
  });
}

export function assertProductionBrowserEnvironment(configured: Record<string, string | undefined>): void {
  if (!configured.VITE_L1_RPC_URLS?.trim()) {
    throw new Error("Browser production builds require PCASH_BROWSER_L1_RPC_URLS.");
  }
  parseL1ChainId(configured.VITE_L1_CHAIN_ID?.trim(), "PCASH_L1_CHAIN_ID");
  if (configured.VITE_PAYMENT_ROUTER_ADDRESS !== undefined) {
    const marketplace = resolveMarketplaceRouterConfiguration(configured);
    if (marketplace.configuration === undefined) {
      throw new Error(marketplace.error ?? "Marketplace router configuration is invalid.");
    }
  }
}

export default defineConfig(({ command }) => {
  // Environment only: Vite's own command-line flags are not PCASH settings.
  const config = new Config("pcash");
  config.load({ env: true });
  const fresh = command === "serve" && config.bool("web-fresh", false);
  const browserConfig = browserEnvironment(config);
  const explorerBoundary = (requireExplorerEntry: boolean) => explorerBoundaryPlugin({
    repositoryRoot: REPOSITORY_ROOT,
    webRoot: WEB_ROOT,
    explorerEntry: EXPLORER_ENTRY,
    requireExplorerEntry,
  });
  if (command === "build") {
    for (const line of marketplaceBuildEnvironmentDiagnostics(config)) logger.info(line);
    assertProductionBrowserEnvironment(browserConfig);
    const explorer = resolveExplorerConfig(browserConfig, true);
    if (explorer.status === "invalid") throw new Error(explorer.message);
  }
  configuredNetwork(browserConfig);
  return {
    root: WEB_ROOT,
    envDir: false,
    // bb.js creates its WASM workers with URLs relative to its own browser
    // modules. Vite's dependency optimizer collapses those modules into one
    // file without copying the relative workers, so serve the package through
    // Vite's normal module transform instead.
    optimizeDeps: {
      force: fresh,
      exclude: [...VITE_OPTIMIZE_DEPS_EXCLUDE],
      include: [...VITE_OPTIMIZE_DEPS_INCLUDE],
    },
    define: {
      ...Object.fromEntries(Object.entries(browserConfig)
        .map(([name, value]) => [`import.meta.env.${name}`, value === undefined ? "undefined" : JSON.stringify(value)])),
      "import.meta.env.VITE_PCASH_FRESH_START": fresh ? JSON.stringify(randomUUID()) : "undefined",
    },
    plugins: [
      proverRuntimePlugin(),
      markdownDocumentsPlugin(),
      ...(command === "serve" && config.bool("require-prover-assets", false)
        ? [browserProverAssetsPlugin(config)]
        : []),
      explorerBoundary(true),
    ],
    // Public routes ship prerendered markup. Keep one blocking application
    // stylesheet in the document head so that markup cannot paint before CSS
    // from the dynamically bootstrapped React tree arrives.
    build: { cssCodeSplit: false },
    worker: { format: "es", plugins: () => [explorerBoundary(false)] },
    server: {
      headers: { ...headers, ...(fresh ? { "Cache-Control": "no-store" } : {}) },
      fs: { allow: [REPOSITORY_ROOT], deny: [...VITE_FS_DENY] },
    },
    preview: { headers },
    test: {
      // board/ and tokens/ are their own packages with their own node:test suites.
      include: ["src/**/*.{test,spec}.?(c|m)[jt]s?(x)"],
      // Node's own localStorage (on by default since Node 25) shadows jsdom's
      // and is undefined without --localstorage-file, breaking storage tests.
      poolOptions: { forks: { execArgv: ["--no-experimental-webstorage"] } },
    },
  };
});
