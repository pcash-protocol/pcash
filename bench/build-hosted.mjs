#!/usr/bin/env node

// Build the proof lab into the website at /lab/. The hosted page proves against
// the release asset set its node advertises, so it needs no staged assets.

import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Config } from "@pcash/sdk/bcfg";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const config = new Config("pcash");
config.load({ argv: true, env: true });
const outDir = config.str(0);
if (outDir === null || config.argv.length !== 1 || Object.keys(config.args).length !== 0) {
  throw new Error("usage: build-hosted.mjs OUT_DIR");
}
execFileSync(join(root, "node_modules", ".bin", "vite"), ["build", "--config", join(here, "app", "vite.config.ts")], {
  cwd: join(here, "app"),
  env: {
    ...process.env,
    PCASH_PROOF_LAB_DIST: resolve(outDir),
    PCASH_PROOF_LAB_BASE: "/lab/",
    // The same node the website's primary network uses.
    PCASH_PROOF_LAB_RPC_URL: config.str("rpc-url", ""),
  },
  stdio: "inherit",
});
