import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Barretenberg, BackendType, flattenChonkProofFields } from "@aztec-foundation/bb.js";
import { Noir } from "@noir-lang/noir_js";
import { beforeAll, describe, expect, it } from "vitest";
import { privateValueProfile } from "../src/constants/privateValueProfiles.ts";
import { field32 } from "../src/utils/bytes.ts";
import { fieldToHex } from "../src/crypto/field.ts";
import { createChonkCircuitResolver } from "../src/node/chonkMaterial.ts";
import { isProverAvailable, nativeChonkBackend, proverReleaseConfig } from "../src/node/nativeProver.ts";
import { decodeTransaction, WIRE_PROOF_BYTES, privateValuePublicInputs } from "../src/protocol/codec.ts";
import { applicationNullifier } from "../src/protocol/notes.ts";
import { SlotClass } from "../src/protocol/transaction.ts";
import { computeChonkVk, proveChonkStack, type NativeChonkStep } from "../src/prover/chonk.ts";
import { transferTransactionStack, type ChonkCircuitMaterial } from "../src/prover/stacks.ts";
import { proverAssetsDir } from "./circuitBundle.ts";
import { markerAuthorityFixture } from "./markerAuthorityFixtures.ts";
import { expectRecursiveProofRejection } from "./proofRejection.ts";

const available = isProverAvailable();
/** The transfer kernel's position: the rule and the no-op event application precede it. */
const KERNEL = 2;
if (process.env.PCASH_REQUIRE_PROVER === "1" && !available) {
  throw new Error("PCASH_REQUIRE_PROVER=1 but the release-pinned proving stack is unavailable");
}

(available ? describe : describe.skip)("installed marker-only authority CHONK proofs", () => {
  let application: ChonkCircuitMaterial;
  beforeAll(async () => {
    // Compile only this test application with the pinned toolchain; production
    // no-op event application, kernels, and hiding kernel still come from the release bundle.
    const directory = mkdtempSync(join(tmpdir(), "pcash-marker-authority-"));
    try {
      mkdirSync(join(directory, "src"));
      copyFileSync(fileURLToPath(new URL("./markerAuthority.nr", import.meta.url)), join(directory, "src/main.nr"));
      const protocol = fileURLToPath(new URL("../../circuits/protocol/lib", import.meta.url));
      const rules = fileURLToPath(new URL("../../circuits/rules/lib", import.meta.url));
      writeFileSync(join(directory, "Nargo.toml"), `[package]\nname = "marker_authority"\ntype = "bin"\ncompiler_version = "=1.0.0"\n\n[dependencies]\npcash_protocol = { path = ${JSON.stringify(protocol)} }\nreference_rule_common = { path = ${JSON.stringify(rules)} }\n`);
      execFileSync(proverReleaseConfig().nargo, ["compile", "--deny-warnings"], { cwd: directory, stdio: "pipe" });
      const artifact = JSON.parse(readFileSync(join(directory, "target/marker_authority.json"), "utf8")) as ChonkCircuitMaterial["artifact"];
      const vk = await computeChonkVk("marker_authority", artifact, "app", nativeChonkBackend(1));
      application = { kind: "app", artifact, verificationKey: vk.bytes, vkFields: vk.vkFields, vkHash: vk.vkHash };
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 120_000);

  describe.each([0, 1] as const)("profile %s", (shape) => {
    let fixture: ReturnType<typeof markerAuthorityFixture>;
    let steps: NativeChonkStep[];
    beforeAll(async () => {
      const resolve = createChonkCircuitResolver({ artifactDirectory: proverAssetsDir(),
        verificationKeyDirectory: join(process.env.PCASH_CIRCUIT_BUNDLE!, "vks") });
      fixture = markerAuthorityFixture(shape, BigInt(application.vkHash));
      const { build } = fixture;
      const profile = privateValueProfile(shape);
      expect(build.resolvedInputs.every(input => input.amount === 0n)).toBe(true);
      expect(build.transaction.inputs.map(input => input.slotClass)).toEqual([
        ...Array(profile.inputs - 1).fill(SlotClass.DUMMY), SlotClass.APPLICATION,
      ]);
      expect(build.transaction.inputs.at(-1)!.nullifier).toBe(applicationNullifier(
        build.address, fixture.selectedEntryCommitment, fixture.replayId,
      ));
      expect(build.transaction.outputs.every(output => output.slotClass === SlotClass.DUMMY)).toBe(true);
      expect(build.outputAmounts).toEqual(Array(profile.outputs).fill(0n));
      expect(fixture.rules.accountRuleSetCommitment).toBe(fixture.contract.functionSetCommitment);
      ({ steps } = await transferTransactionStack({
        build,
        authorizationPackage: "marker_authority",
        authorizationWitnessMap: fixture.witnessMap,
        resolve: (name, kind) => name === "marker_authority" ? Promise.resolve(application) : resolve(name, kind),
      }));
      const ruleResult = await new Noir(application.artifact as never).execute(fixture.witnessMap as never);
      expect((ruleResult.returnValue as string[]).map(BigInt)).toEqual(
        (steps[KERNEL]!.witnessMap.rule_statement as string[]).map(BigInt),
      );
    }, 120_000);

    it("proves the installed rule, no-op event application, transfer kernel, and hiding kernel with no notes or payouts", async () => {
      const { build } = fixture;
      const proof = await proveChonkStack(steps, build.publicInputs, nativeChonkBackend(1));
      expect(proof.proof).toHaveLength(WIRE_PROOF_BYTES);
      const decoded = decodeTransaction(build.encodeTransaction(proof.proof));
      if (decoded.kind !== 0) throw new Error("unexpected entry kind");
      expect(privateValuePublicInputs(decoded)).toEqual(build.publicInputs);
      const release = proverReleaseConfig();
      const api = await Barretenberg.new({ backend: BackendType.NativeUnixSocket, bbPath: release.bb, threads: 1 });
      try {
        const decompressed = await api.chonkDecompressProof({ compressedProof: Uint8Array.from([...build.publicInputs.flatMap(value => [...field32(value)]), ...proof.proof]) });
        const fields = flattenChonkProofFields(decompressed.proof);
        expect(fields.slice(0, build.publicInputs.length).map(field => BigInt(`0x${Buffer.from(field).toString("hex")}`))).toEqual(build.publicInputs);
        expect((await api.chonkVerify({ proof: decompressed.proof, vk: proof.hidingVerificationKey })).valid).toBe(true);
      } finally {
        await api.destroy();
      }
    }, 900_000);

    it("rejects a valid installed-rule statement spliced into the marker-only stack", async () => {
      const changed = steps.map(step => ({ ...step, witnessMap: structuredClone(step.witnessMap) }));
      const application = changed[0]!.witnessMap;
      application.recent_pcash_block_hash = fieldToHex(BigInt(application.recent_pcash_block_hash as string) + 1n);
      // Every circuit remains satisfiable in isolation. Only recursive databus
      // linkage can reject the application's different recent-block statement.
      for (const [index, step] of changed.entries()) {
        const result = await new Noir(step.artifact as never).execute(step.witnessMap as never);
        if (index === 0) {
          const expected = (steps[KERNEL]!.witnessMap.rule_statement as string[]).map(BigInt);
          expect((result.returnValue as string[]).map(BigInt)).toEqual(expected.map((field, i) => i === 2 ? field + 1n : field));
        }
      }
      await expectRecursiveProofRejection(changed, fixture.build.publicInputs, nativeChonkBackend(1));
    }, 900_000);
  });
});
