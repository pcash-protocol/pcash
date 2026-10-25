// Compile alternate dimensions in a disposable source tree. This catches
// literals hidden outside generated wrappers (including typed test fixtures).
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { privateValueProfiles, profileOutputs } from "./profiles.mjs";
import { toolPaths } from "../../sdk/src/node/toolchain.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("the core compiles with one slot and Marketplace with smaller and larger S profiles", { timeout: 300_000 }, () => {
  const directory = mkdtempSync(join(tmpdir(), "pcash-profile-compile-"));
  try {
    cpSync(join(root, "circuits"), join(directory, "circuits"), {
      recursive: true,
      filter: path => !path.split("/").some(part => part === "target" || part === "Prover.toml"),
    });
    // Keep the ecosystem applications in this gate, not just the protocol stacks.
    for (const tree of ["marketplace/l2-contracts", "web/tokens/l2-contracts"]) {
      cpSync(join(root, tree), join(directory, tree), {
        recursive: true, filter: path => !path.split("/").includes("target"),
      });
    }
    for (const small of [{ inputs: 1, outputs: 1 }, { inputs: 2, outputs: 2 }, { inputs: 6, outputs: 7 }]) {
      const profiles = privateValueProfiles({ S: { shapeId: 0, ...small }, L: { shapeId: 1, inputs: 16, outputs: 8 } });
      for (const [path, source] of profileOutputs(profiles)) {
        mkdirSync(dirname(join(directory, path)), { recursive: true });
        writeFileSync(join(directory, path), source);
      }
      // Marketplace's selected relay fixtures use a second input and output slot.
      const programs = small.inputs === 1
        ? ["circuits"]
        : ["circuits", "marketplace/l2-contracts/escrow/claim", "marketplace/l2-contracts/escrow/reclaim",
          ...(small.inputs === 6 ? ["web/tokens/l2-contracts/claim-link/claim", "web/tokens/l2-contracts/drop/claim", "web/tokens/l2-contracts/drop/reclaim"] : [])];
      for (const program of programs) {
        const result = spawnSync(toolPaths().nargo, ["compile", "--program-dir", program,
          ...(program === "circuits" ? ["--workspace"] : [])], {
          cwd: directory, encoding: "utf8", timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
          env: { ...process.env, RAYON_NUM_THREADS: "1" },
        });
        assert.equal(result.status, 0, `${JSON.stringify(small)} ${program}: ${result.error ?? ""}\n${result.stderr}\n${result.stdout}`);
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
