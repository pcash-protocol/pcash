import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { PROVER_ARTIFACT_SHA256 } from "../src/constants/proverArtifacts.ts";
import { TOOLCHAIN, TOOLCHAIN_PLATFORMS } from "../src/node/toolchain.ts";

const read = (path: string): string => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

describe("prover toolchain manifest", () => {
  it("authenticates every supported release archive and the binary it installs", () => {
    for (const archives of [TOOLCHAIN.nargo.archives, TOOLCHAIN.barretenberg.archives]) {
      expect(Object.keys(archives).sort()).toEqual([...TOOLCHAIN_PLATFORMS].sort());
      for (const platform of TOOLCHAIN_PLATFORMS) {
        const archive = archives[platform];
        expect(new URL(archive.url).hostname).toBe("github.com");
        expect(archive.url).toContain("/releases/download/");
        expect(archive.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(archive.binarySha256).toMatch(/^[0-9a-f]{64}$/);
      }
    }
    expect(new URL(TOOLCHAIN.crs.bn254G2.url).hostname).toBe("crs.aztec.network");
    expect(new URL(TOOLCHAIN.crs.grumpkinG1.url).hostname).toBe("crs.aztec-cdn.foundation");
  });

  // Package managers need literal versions; these are the copies the manifest cannot generate.
  it("is the release the npm and Cargo packages pin", () => {
    const { dependencies } = JSON.parse(read("sdk/package.json")) as { dependencies: Record<string, string> };
    expect(dependencies["@aztec-foundation/bb.js"]).toBe(TOOLCHAIN.barretenberg.version);
    for (const name of ["@noir-lang/acvm_js", "@noir-lang/noir_js", "@noir-lang/noirc_abi"]) {
      expect(dependencies[name], name).toBe(TOOLCHAIN.nargo.version);
    }
    const crate = /^barretenberg-rs\s*=\s*\{\s*version\s*=\s*"=([^"]+)"/m.exec(read("node/crates/verify/Cargo.toml"));
    expect(crate?.[1]).toBe(TOOLCHAIN.barretenberg.version);
  });

  // Spec §16 restates the release, CRS, and hiding-kernel VK pins for readers.
  it("is the release the protocol spec pins", () => {
    const spec = read("docs/protocol-spec.md");
    const section = spec.slice(spec.indexOf("\n## 16. "), spec.indexOf("\n## 17. "));
    const pins = new Map([...section.matchAll(/^\| (.+) \| `([^`]+)` \|$/gm)].map(([, pin, value]) => [pin, value]));
    expect(pins.get("Barretenberg release")).toBe(TOOLCHAIN.barretenberg.version);
    expect(pins.get("BN254 `[x]_2` element compiled into the verifier, SHA-256")).toBe(`0x${TOOLCHAIN.crs.bn254G2.sha256}`);
    expect(pins.get("Grumpkin SRS, first 65,536 points, SHA-256")).toBe(`0x${TOOLCHAIN.crs.grumpkinG1.sha256}`);
    const hidingKernels = Object.keys(PROVER_ARTIFACT_SHA256)
      .flatMap((url) => /^\/chonk-vks\/(\w+_hiding_kernel)\.vk$/.exec(url)?.[1] ?? []);
    expect([...section.matchAll(/^\| [^|]+ \| [^|]+ \| `(\w+_hiding_kernel)` \|/gm)].map(([, kernel]) => kernel).sort())
      .toEqual([...hidingKernels].sort());
    for (const kernel of hidingKernels) {
      expect(pins.get(`\`${kernel}\` VK, SHA-256`), kernel).toBe(`0x${PROVER_ARTIFACT_SHA256[`/chonk-vks/${kernel}.vk`]}`);
    }
  });
});
