import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createChonkCircuitResolver } from "../src/node/chonkMaterial.ts";
import { isProverAvailable, nativeChonkBackend } from "../src/node/nativeProver.ts";
import { decodeTransaction, WIRE_PROOF_BYTES, privateValuePublicInputs } from "../src/protocol/codec.ts";
import { proveTransferTransactionChonk } from "../src/prover/stacks.ts";
import { proverAssetsDir } from "./circuitBundle.ts";
import { mineFixture } from "./mineFixtures.ts";

const available = isProverAvailable();
if (process.env.PCASH_REQUIRE_PROVER === "1" && !available) {
  throw new Error("PCASH_REQUIRE_PROVER=1 but the release-pinned proving stack is unavailable");
}

(available ? describe : describe.skip)("mine CHONK proof", () => {
  it("folds the mine application and the no-op event application through the transfer kernel and hiding kernel", async () => {
    const { build } = mineFixture();
    const resolve = createChonkCircuitResolver({ artifactDirectory: proverAssetsDir(),
      verificationKeyDirectory: join(process.env.PCASH_CIRCUIT_BUNDLE!, "vks") });
    const result = await proveTransferTransactionChonk({ build, authorizationPackage: build.authorizationCircuit,
      authorizationWitnessMap: build.accountRuleWitnessMap!, resolve, backend: nativeChonkBackend(1) });
    expect(result.proof).toHaveLength(WIRE_PROOF_BYTES);
    const decoded = decodeTransaction(build.encodeTransaction(result.proof));
    if (decoded.kind !== 0) throw new Error("unexpected entry kind");
    expect(privateValuePublicInputs(decoded)).toEqual(build.publicInputs);
  }, 900_000);
});
