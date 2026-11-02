import { access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { runSuccessfulCommand } from "./command.ts";

export const E2E_WORKSPACE_BUILDS = [
  "@pcash/sdk",
  "@pcash/wallet",
  "@pcash/relayer",
  "@pcash/marketplace",
  "@pcash/tokens",
  "@pcash/lineage",
  "@pcash/board",
] as const;

export interface BuiltBinaries {
  node: string;
  nodeCli: string;
  toolRoot: string;
  sourceVerificationReproducer: string;
}

let buildPromise: Promise<BuiltBinaries> | undefined;

export function buildRequiredBinaries(repoRoot: string): Promise<BuiltBinaries> {
  buildPromise ??= build(repoRoot).catch((error) => {
    buildPromise = undefined;
    throw error;
  });
  return buildPromise;
}

async function build(repoRoot: string): Promise<BuiltBinaries> {
  // The launcher runs before the workspace packages are built, so it reads its
  // PCASH_E2E_* settings from the environment directly rather than through bcfg.
  const env = { ...process.env, RUSTC_WRAPPER: "" };
  const profile = process.env.PCASH_E2E_NODE_PROFILE?.trim() || "debug";
  if (profile !== "debug" && profile !== "release") throw new Error("PCASH_E2E_NODE_PROFILE must be debug or release");
  await runSuccessfulCommand(process.execPath, ["scripts/bootstrap_prover_toolchain.mjs", "--check"], {
    cwd: repoRoot,
    env,
    timeoutMs: 60_000,
  });
  for (const workspace of E2E_WORKSPACE_BUILDS) {
    await runSuccessfulCommand("npm", ["run", "build", "--workspace", workspace], {
      cwd: repoRoot,
      env,
      timeoutMs: 10 * 60_000,
    });
  }
  await runSuccessfulCommand("cargo", [
    "build",
    ...(profile === "release" ? ["--release"] : []),
    "-p", "pcash-node", "--bin", "pcash-node",
    "-p", "pcash-cli", "--bin", "pcash-cli",
  ], { cwd: repoRoot, env, timeoutMs: 20 * 60_000 });
  const { toolRoot } = await import("@pcash/sdk/node/toolchain");
  const targetRoot = process.env.CARGO_TARGET_DIR ? resolve(repoRoot, process.env.CARGO_TARGET_DIR) : join(repoRoot, "target");
  const binaries = {
    node: join(targetRoot, profile, "pcash-node"),
    nodeCli: join(targetRoot, profile, "pcash-cli"),
    toolRoot: toolRoot(),
    sourceVerificationReproducer: resolve(
      process.env.PCASH_E2E_SOURCE_VERIFICATION_REPRODUCER?.trim()
        || join(repoRoot, "scripts", "source-verification", "index.mts"),
    ),
  };
  await Promise.all([
    access(binaries.node),
    access(binaries.nodeCli),
    access(binaries.sourceVerificationReproducer),
  ]);
  return binaries;
}
