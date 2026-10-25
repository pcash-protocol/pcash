import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, test } from "vitest";

import { isProverAvailable, proverReleaseConfig } from "../src/node/nativeProver.ts";
import {
  TOOLCHAIN,
  pinnedComponents,
  platformKey,
  staleToolchainComponents,
  toolPaths,
  toolRoot,
} from "../src/node/toolchain.ts";

const inheritedToolRoot = process.env.PCASH_TOOL_ROOT;
const pinnedBinaries = { nargo: pinnedComponents().nargo.binarySha256, bb: pinnedComponents().barretenberg.binarySha256 };
const directories: string[] = [];

afterEach(() => {
  if (inheritedToolRoot === undefined) delete process.env.PCASH_TOOL_ROOT;
  else process.env.PCASH_TOOL_ROOT = inheritedToolRoot;
  pinnedComponents().nargo.binarySha256 = pinnedBinaries.nargo;
  pinnedComponents().barretenberg.binarySha256 = pinnedBinaries.bb;
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const PINNED_VERSIONS = {
  nargo: `nargo version = ${TOOLCHAIN.nargo.version}\nnoirc version = ${TOOLCHAIN.nargo.version}+${TOOLCHAIN.nargo.noircCommit}`,
  bb: TOOLCHAIN.barretenberg.version,
};

/**
 * A temporary tool root with stand-in binaries, which the manifest pins for
 * the rest of the test, and a receipt of the pinned downloads overridden by
 * `receipt`. The binary named by `replaced` is instead a different file that
 * reports the pinned version.
 */
function useToolRoot(install?: { replaced?: "nargo" | "bb"; receipt?: Record<string, string> }): string {
  const root = mkdtempSync(join(tmpdir(), "pcash-native-prover-"));
  directories.push(root);
  process.env.PCASH_TOOL_ROOT = root;
  if (install === undefined) return root;
  const paths = toolPaths(root);
  const pins = pinnedComponents();
  for (const [name, archive] of [["nargo", pins.nargo], ["bb", pins.barretenberg]] as const) {
    const binary = `the pinned ${name}`;
    archive.binarySha256 = createHash("sha256").update(binary).digest("hex");
    mkdirSync(dirname(paths[name]), { recursive: true });
    writeFileSync(
      paths[name],
      install.replaced === name ? `#!/bin/sh\ncat <<'EOF'\n${PINNED_VERSIONS[name]}\nEOF\n` : binary,
      { mode: 0o755 },
    );
  }
  const pinned = Object.fromEntries(Object.entries(pins).map(([component, pin]) => [component, pin.sha256]));
  writeFileSync(paths.receipt, JSON.stringify({ ...pinned, ...install.receipt }));
  return root;
}

test("PCASH_TOOL_ROOT is the one override of the checkout-local tool root", () => {
  delete process.env.PCASH_TOOL_ROOT;
  expect(toolRoot()).toMatch(/\/\.pcash-tools$/);
  process.env.PCASH_TOOL_ROOT = "/somewhere/tools";
  expect(toolRoot()).toBe("/somewhere/tools");
  expect(toolPaths().bb).toBe("/somewhere/tools/bb/bb");
});

test("names the supported prover platforms", () => {
  expect(platformKey("darwin", "arm64")).toBe("darwin-arm64");
  expect(platformKey("linux", "x64")).toBe("linux-x64");
  expect(() => platformKey("win32", "x64")).toThrow("unsupported prover platform win32-x64");
  expect(() => platformKey("linux", "ia32")).toThrow("unsupported prover platform linux-ia32");
});

test("a root nothing was installed in has no prover and names the bootstrap", () => {
  const root = useToolRoot();
  expect(isProverAvailable()).toBe(false);
  expect(() => proverReleaseConfig()).toThrow(
    `the prover toolchain at ${root} is not the pinned release `
      + "(nargo, barretenberg, bn254G1, bn254G2, grumpkinG1); run `just tools`",
  );
});

test("the pinned receipt and binaries are the prover release", () => {
  const root = useToolRoot({});
  expect(isProverAvailable()).toBe(true);
  expect(proverReleaseConfig()).toEqual({
    nargo: join(root, "nargo", "nargo"),
    bb: join(root, "bb", "bb"),
    crs: join(root, "crs"),
  });
});

test("an installation left behind by a re-pin is an error, not an absent prover", () => {
  useToolRoot({ receipt: { barretenberg: "0".repeat(64) } });
  expect(staleToolchainComponents()).toEqual(["barretenberg"]);
  expect(() => isProverAvailable()).toThrow(/not the pinned release \(barretenberg\); run `just tools`/);
});

test("a binary with other bytes is stale whatever it reports and whatever its receipt says", () => {
  useToolRoot({ replaced: "bb" });
  expect(staleToolchainComponents()).toEqual(["barretenberg"]);
  expect(() => proverReleaseConfig()).toThrow(/not the pinned release \(barretenberg\); run `just tools`/);
  useToolRoot({ replaced: "nargo" });
  expect(staleToolchainComponents()).toEqual(["nargo"]);
});
