// The pinned prover toolchain: what `assets/prover-toolchain.json` pins, where
// it is installed, and whether what is installed there is what is pinned.

import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { arch, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Config } from "../bcfg/index.ts";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

export const TOOLCHAIN_PLATFORMS = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"] as const;
export type ToolchainPlatform = (typeof TOOLCHAIN_PLATFORMS)[number];

/** One pinned download. With `bytes`, only that prefix of the file is pinned. */
export interface ToolchainPin {
  url: string;
  sha256: string;
  bytes?: number;
}

/** A pinned release archive and the binary it installs: `nargo` or `bb`. */
export interface ToolchainArchive extends ToolchainPin {
  binarySha256: string;
}

export const TOOLCHAIN = JSON.parse(readFileSync(join(REPO_ROOT, "assets", "prover-toolchain.json"), "utf8")) as {
  nargo: { version: string; noircCommit: string; archives: Record<ToolchainPlatform, ToolchainArchive> };
  barretenberg: { version: string; archives: Record<ToolchainPlatform, ToolchainArchive> };
  crs: { bn254G1: ToolchainPin; bn254G2: ToolchainPin; grumpkinG1: ToolchainPin };
};

const TOOLCHAIN_COMPONENTS = ["nargo", "barretenberg", "bn254G1", "bn254G2", "grumpkinG1"] as const;
export type ToolchainComponent = (typeof TOOLCHAIN_COMPONENTS)[number];

export function platformKey(os: string = platform(), cpu: string = arch()): ToolchainPlatform {
  const key = TOOLCHAIN_PLATFORMS.find((candidate) => candidate === `${os}-${cpu}`);
  if (key === undefined) throw new Error(`unsupported prover platform ${os}-${cpu}`);
  return key;
}

/** The pinned download of every component for one platform. */
export function pinnedComponents(
  key: ToolchainPlatform = platformKey(),
): Record<"nargo" | "barretenberg", ToolchainArchive> & Record<ToolchainComponent, ToolchainPin> {
  return { nargo: TOOLCHAIN.nargo.archives[key], barretenberg: TOOLCHAIN.barretenberg.archives[key], ...TOOLCHAIN.crs };
}

/**
 * The primary checkout root when `repoRoot` is a linked git worktree;
 * otherwise `repoRoot`.
 */
export function primaryRepositoryRoot(repoRoot: string = REPO_ROOT): string {
  try {
    const gitPath = join(repoRoot, ".git");
    if (!existsSync(gitPath)) return repoRoot;
    const stat = lstatSync(gitPath);
    if (!stat.isFile()) return repoRoot;
    const content = readFileSync(gitPath, "utf8");
    const match = content.match(/^gitdir:\s*(.+)$/m);
    if (!match || !match[1]) return repoRoot;
    const gitDir = resolve(repoRoot, match[1].trim());
    const commonDirFile = join(gitDir, "commondir");
    if (!existsSync(commonDirFile)) return repoRoot;
    const commonDirRel = readFileSync(commonDirFile, "utf8").trim();
    const commonDir = resolve(gitDir, commonDirRel);
    return dirname(commonDir);
  } catch {
    return repoRoot;
  }
}

/** The one tool root: `PCASH_TOOL_ROOT`, else `.pcash-tools` in this checkout. */
export function toolRoot(): string {
  const config = new Config("pcash");
  config.load({ env: true });
  return resolve(config.str("tool-root", join(REPO_ROOT, ".pcash-tools")));
}

export interface ToolPaths {
  root: string;
  nargo: string;
  bb: string;
  /** The directory bb reads through `--crs_path`; it holds the three files below. */
  crs: string;
  bn254G1: string;
  bn254G2: string;
  grumpkinG1: string;
  receipt: string;
}

export function toolPaths(root: string = toolRoot()): ToolPaths {
  const crs = join(root, "crs");
  return {
    root,
    nargo: join(root, "nargo", "nargo"),
    bb: join(root, "bb", "bb"),
    crs,
    bn254G1: join(crs, "bn254_g1.dat"),
    bn254G2: join(crs, "bn254_g2.dat"),
    grumpkinG1: join(crs, "grumpkin_g1_v2.flat.dat"),
    receipt: join(root, "installed.json"),
  };
}

/** The installer's record: the pinned SHA-256 each installed component was authenticated against. */
export type ToolchainReceipt = Partial<Record<ToolchainComponent, string>>;

/** The install receipt at `root`, or `undefined` when nothing was ever installed there. */
export function readToolchainReceipt(root: string = toolRoot()): ToolchainReceipt | undefined {
  const { receipt } = toolPaths(root);
  return existsSync(receipt) ? JSON.parse(readFileSync(receipt, "utf8")) as ToolchainReceipt : undefined;
}

/** Whether the file at `path` is, byte for byte, the binary `archive` installs. */
function isPinnedBinary(path: string, archive: ToolchainArchive): boolean {
  return existsSync(path) && createHash("sha256").update(readFileSync(path)).digest("hex") === archive.binarySha256;
}

/**
 * The components at `root` that are not the pinned ones: those the receipt
 * does not record at the pinned digest, and a nargo or bb whose bytes are not
 * the binary its archive installs. The binaries are hashed, not asked for
 * their version: a tool root is restored from caches, and bb receives spending
 * secrets when it proves.
 */
export function staleToolchainComponents(root: string = toolRoot()): ToolchainComponent[] {
  const paths = toolPaths(root);
  const receipt = readToolchainReceipt(root) ?? {};
  const pins = pinnedComponents();
  const pinnedBinary: Partial<Record<ToolchainComponent, boolean>> = {
    nargo: isPinnedBinary(paths.nargo, pins.nargo),
    barretenberg: isPinnedBinary(paths.bb, pins.barretenberg),
  };
  return TOOLCHAIN_COMPONENTS.filter((component) =>
    receipt[component] !== pins[component].sha256 || pinnedBinary[component] === false);
}

const asserted = new Set<string>();

/** The paths of the pinned toolchain at `root`; throws unless every component there is the pinned one. */
export function assertToolchain(root: string = toolRoot()): ToolPaths {
  if (!asserted.has(root)) {
    const stale = staleToolchainComponents(root);
    if (stale.length !== 0) {
      throw new Error(`the prover toolchain at ${root} is not the pinned release (${stale.join(", ")}); run \`just tools\``);
    }
    asserted.add(root);
  }
  return toolPaths(root);
}
