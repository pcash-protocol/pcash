// Composed CHONK proofs for zero-value native payments against the circuit
// bundle: the payment rule on S and the large batch rule on L, each folded
// with the no-op event application through the transfer kernel and hiding kernel,
// then locally verified.
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PRIVATE_VALUE_PROFILES, type PrivateValueShape } from "../src/constants/privateValueProfiles.ts";
import { createChonkCircuitResolver } from "../src/node/chonkMaterial.ts";
import { isProverAvailable, nativeChonkBackend } from "../src/node/nativeProver.ts";
import { decodeTransaction, encodePrivateValueTransaction, WIRE_PROOF_BYTES, privateValuePublicInputs } from "../src/protocol/codec.ts";
import { proveTransferTransactionChonk } from "../src/prover/stacks.ts";
import { SlotClass } from "../src/protocol/transaction.ts";
import { proverAssetsDir } from "./circuitBundle.ts";
import { zeroPaymentFixture } from "./zeroPaymentFixtures.ts";

const available = isProverAvailable();
if (process.env.PCASH_REQUIRE_PROVER === "1" && !available) {
  throw new Error("PCASH_REQUIRE_PROVER=1 but the release-pinned proving stack is unavailable");
}

(available ? describe : describe.skip)("zero-value payment CHONK proofs", () => {
  const resolve = createChonkCircuitResolver({
    artifactDirectory: proverAssetsDir(),
    verificationKeyDirectory: join(process.env.PCASH_CIRCUIT_BUNDLE!, "vks"),
  });

  it.each([
    ["S payment rule, no inputs, zero fee", PRIVATE_VALUE_PROFILES.S.shapeId, [], 0n, "account_rule_payment_ecdsa"],
    ["S payment rule, fee-funded change", PRIVATE_VALUE_PROFILES.S.shapeId, [100n], 1n, "account_rule_payment_ecdsa"],
    ["L batch rule, no inputs, zero fee", PRIVATE_VALUE_PROFILES.L.shapeId, [], 0n, "account_rule_large_batch_transfer_ecdsa"],
    ["L batch rule, fee-funded change", PRIVATE_VALUE_PROFILES.L.shapeId, [100n], 1n, "account_rule_large_batch_transfer_ecdsa"],
  ] as const)("proves and verifies the %s", async (_label, shape: PrivateValueShape, inputAmounts, openFeeAmount, circuit) => {
    const { build } = zeroPaymentFixture({ shape, inputAmounts, openFeeAmount });
    expect(build.authorizationCircuit).toBe(circuit);
    expect(build.transaction.outputs[0]!.slotClass).toBe(SlotClass.DUMMY);
    const proof = await proveTransferTransactionChonk({
      build,
      authorizationPackage: build.authorizationCircuit,
      authorizationWitnessMap: build.accountRuleWitnessMap!,
      resolve,
      backend: nativeChonkBackend(),
    });
    expect(proof.proof).toHaveLength(WIRE_PROOF_BYTES);
    const decoded = decodeTransaction(encodePrivateValueTransaction({ ...build, proof: proof.proof }));
    if (decoded.kind !== 0) throw new Error("unexpected entry kind");
    expect(privateValuePublicInputs(decoded)).toEqual(build.publicInputs);
  }, 900_000);
});
