import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createChonkCircuitResolver } from "../src/node/chonkMaterial.ts";
import { nativeChonkBackend } from "../src/node/nativeProver.ts";
import { proveTransferTransactionChonk } from "../src/prover/stacks.ts";
import { WIRE_PROOF_BYTES } from "../src/protocol/codec.ts";
import { allDummyFixture } from "./allDummyFixtures.ts";
import { proverAssetsDir } from "./circuitBundle.ts";

describe.each([0, 1] as const)("ordinary unregistered transfer proof %s", (shape) => {
  const resolve = createChonkCircuitResolver({ artifactDirectory: proverAssetsDir(), verificationKeyDirectory: join(process.env.PCASH_CIRCUIT_BUNDLE!, "vks") });
  it("folds the normal application, no-op event application, transfer kernel, and hiding kernel", async () => {
    const { build } = allDummyFixture({ shape });
    const result = await proveTransferTransactionChonk({ build, authorizationPackage: build.authorizationCircuit,
      authorizationWitnessMap: build.accountRuleWitnessMap!, resolve, backend: nativeChonkBackend(1) });
    expect(result.proof.length).toBe(WIRE_PROOF_BYTES);
  }, 900_000);
  if (shape === 0) it("still binds the application's actual VK to its claimed hash", async () => {
    const { build } = allDummyFixture({ shape });
    const altered = { ...build, buildKernelWitnessMap: (application: Parameters<typeof build.buildKernelWitnessMap>[0]) => {
      const witness = build.buildKernelWitnessMap(application);
      const vk = witness.authorization_vk as { key: string[]; hash: string };
      vk.key = [...vk.key];
      vk.key[0] = String(BigInt(vk.key[0]!) + 1n);
      return witness;
    } };
    await expect(proveTransferTransactionChonk({ build: altered, authorizationPackage: build.authorizationCircuit,
      authorizationWitnessMap: build.accountRuleWitnessMap!, resolve, backend: nativeChonkBackend(1) }))
      .rejects.toThrow(/verification key hash must match the key/);
  }, 900_000);
});
