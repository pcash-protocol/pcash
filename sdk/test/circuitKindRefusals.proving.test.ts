import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isProverAvailable, proverReleaseConfig } from "../src/node/nativeProver.ts";
import type { ChonkCircuitKind } from "../src/protocol/account.ts";

const available = isProverAvailable();
if (process.env.PCASH_REQUIRE_PROVER === "1" && !available) {
  throw new Error("PCASH_REQUIRE_PROVER=1 but the release-pinned proving stack is unavailable");
}

// The release check pins no circuit with gates or databus columns its kind's
// flavor leaves unconstrained only because the pinned bb's `write_vk
// --circuit_kind` refuses one: MegaKernel has no lookup or non-native-field
// relation, MegaZK additionally no elliptic or memory relation, MegaApp no
// call_data bus, and MegaZK no return_data bus and no call_data bus but the
// first. Every circuit builds as some kind and every kind builds `plain`, so
// each refusal is the kind's.
const KINDS: readonly ChonkCircuitKind[] = ["app", "kernel", "hiding"];
const CIRCUITS: Record<string, { source: string; refusedAs: readonly ChonkCircuitKind[] }> = {
  plain: {
    source: "fn main(x: Field, y: Field) -> pub Field {\n    x * y + 1\n}\n",
    refusedAs: [],
  },
  lookup: {
    source: "fn main(x: u32, y: u32) -> pub u32 {\n    x ^ y\n}\n",
    refusedAs: ["kernel", "hiding"],
  },
  non_native_field: {
    source: "fn main(x: [u8; 32], y: [u8; 32], signature: [u8; 64], hash: [u8; 32]) -> pub bool {\n"
      + "    std::ecdsa_secp256k1::verify_signature(x, y, signature, hash)\n}\n",
    refusedAs: ["kernel", "hiding"],
  },
  memory: {
    source: "fn main(values: [Field; 4], index: u32) -> pub Field {\n    values[index]\n}\n",
    refusedAs: ["hiding"],
  },
  elliptic: {
    source: "use std::embedded_curve_ops::{embedded_curve_add, EmbeddedCurvePoint};\n\n"
      + "fn main(ax: Field, ay: Field, bx: Field, by: Field) -> pub Field {\n"
      + "    embedded_curve_add(EmbeddedCurvePoint { x: ax, y: ay }, EmbeddedCurvePoint { x: bx, y: by }).x\n}\n",
    refusedAs: ["hiding"],
  },
  reads_call_data: {
    source: "fn main(x: call_data(0) Field) -> pub Field {\n    x + 1\n}\n",
    refusedAs: ["app"],
  },
  reads_second_call_data: {
    source: "fn main(x: call_data(1) Field) -> pub Field {\n    x + 1\n}\n",
    refusedAs: ["app", "hiding"],
  },
  returns_databus: {
    source: "fn main(x: Field) -> return_data Field {\n    x + 1\n}\n",
    refusedAs: ["hiding"],
  },
};

(available ? describe : describe.skip)("pinned bb circuit kinds", () => {
  let directory: string;
  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), "pcash-circuit-kinds-"));
    const names = Object.keys(CIRCUITS);
    writeFileSync(join(directory, "Nargo.toml"), `[workspace]\nmembers = ${JSON.stringify(names)}\n`);
    for (const [name, { source }] of Object.entries(CIRCUITS)) {
      mkdirSync(join(directory, name, "src"), { recursive: true });
      writeFileSync(join(directory, name, "Nargo.toml"), `[package]\nname = "${name}"\ntype = "bin"\n\n[dependencies]\n`);
      writeFileSync(join(directory, name, "src/main.nr"), source);
    }
    execFileSync(proverReleaseConfig().nargo, ["compile", "--workspace"], { cwd: directory, stdio: "pipe" });
  }, 120_000);
  afterAll(() => rmSync(directory, { recursive: true, force: true }));

  for (const [name, { refusedAs }] of Object.entries(CIRCUITS)) {
    for (const kind of KINDS) {
      const refused = refusedAs.includes(kind);
      it(`${refused ? "refuses" : "builds"} ${name} as ${kind}`, () => {
        const { bb, crs } = proverReleaseConfig();
        const result = spawnSync(bb, [
          "write_vk", "-s", "chonk", "--circuit_kind", kind, "-b", join(directory, "target", `${name}.json`),
          "-o", join(directory, "vks", `${name}-${kind}`), "-c", crs,
        ], { encoding: "utf8" });
        if (result.error) throw result.error;
        if (refused) expect(result.status, result.stderr).not.toBe(0);
        else expect(result.status, result.stderr).toBe(0);
      }, 60_000);
    }
  }
});
