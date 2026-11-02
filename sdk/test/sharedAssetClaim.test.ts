import { describe, expect, it } from "vitest";
import { sharedAssetClaimFixture } from "./sharedAssetClaimFixtures.ts";
import { SlotClass } from "../src/protocol/transaction.ts";
import { decodeContractBody, verifyContract } from "../src/protocol/contract.ts";
import { PRIVATE_VALUE_MAX_INPUTS, PRIVATE_VALUE_MAX_OUTPUTS } from "../src/constants/privateValueProfiles.ts";
import { toField } from "../src/crypto/field.ts";
import { buildSharedAssetClaimWitness, sharedAssetClaimConfigurationCommitment, sharedAssetClaimReplayId, sharedAssetClaimSecretCommitment } from "../src/builders/sharedAssetClaim.ts";

describe("one shared S/L application entry", () => {
  it("uses the same claim nullifier with different funding, shapes, and ordinary commitments", () => {
    const s = sharedAssetClaimFixture({ shape: 0, claimVkHash: 1234n });
    const l = sharedAssetClaimFixture({ shape: 1, claimVkHash: 1234n });
    expect(s.contract.body).toEqual(l.contract.body);
    expect(s.snapshot).toEqual(l.snapshot);
    expect(verifyContract(decodeContractBody(s.contract.body)).address).toBe(s.primary.address);
    const marker = (fixture: typeof s) => fixture.build.transaction.inputs.find(input => input.slotClass === SlotClass.APPLICATION)!.nullifier;
    expect(marker(s)).toBe(marker(l));
    expect(s.build.transaction.inputs[0]!.nullifier).not.toBe(l.build.transaction.inputs[0]!.nullifier);
    expect(s.build.privateValueCommitment).not.toBe(l.build.privateValueCommitment);
    const map = s.claimWitnessMap.private_value as Record<string, string[]>;
    expect(map.nullifiers).toHaveLength(PRIVATE_VALUE_MAX_INPUTS);
    expect(map.output_body_commitments).toHaveLength(PRIVATE_VALUE_MAX_OUTPUTS);
    expect(map.nullifiers!.slice(4).map(value => toField(value))).toEqual(Array(28).fill(0n));
    expect(map.output_body_commitments!.slice(5).map(value => toField(value))).toEqual(Array(27).fill(0n));
  });
  it("keeps distinct installed entries in distinct replay scopes", () => {
    const first = sharedAssetClaimFixture({ shape: 0, claimVkHash: 1234n });
    const second = sharedAssetClaimFixture({ shape: 1, claimVkHash: 1235n });
    expect(first.build.transaction.inputs.at(-1)!.nullifier).not.toBe(second.build.transaction.inputs.at(-1)!.nullifier);
  });
  for (const shape of [0, 1] as const) {
    it(`binds the ${shape} fee-payer role and full sponsor input context`, () => {
      const fixture = sharedAssetClaimFixture({ shape, claimVkHash: 1234n, feePaid: true });
      expect(fixture.signed?.witnessMap).toBeDefined();
      expect(fixture.prepared?.authorizationCircuit).toBe(shape === 0 ? "account_rule_contract_fee_sponsorship_ecdsa" : "account_rule_large_contract_fee_sponsorship_ecdsa");
      const direct = buildSharedAssetClaimWitness({
        build: fixture.build, configuration: fixture.configuration, claimSecret: fixture.claimSecret,
        selectedEntryCommitment: fixture.selectedEntryCommitment,
        outputs: fixture.build.transaction.outputs.map(output => output.slotClass === SlotClass.ASSET ? { amount: 1000n, noteSecret: 888n } : null),
      });
      // The claim computes its action from the role it is told it serves.
      expect(direct.fee_paid).toBe(false);
      expect(fixture.claimWitnessMap.fee_paid).toBe(true);
    });
  }
});

describe("shared asset claim configuration", () => {
  it("accepts a zero claim secret, recipient, and secret commitment, but not a zero asset or amount", () => {
    expect(sharedAssetClaimSecretCommitment(0n)).not.toBe(sharedAssetClaimReplayId(0n));
    const configuration = { assetId: 7n, recipient: 0n, amount: 1n, maximumFee: 0n, secretCommitment: 0n };
    expect(sharedAssetClaimConfigurationCommitment(configuration))
      .not.toBe(sharedAssetClaimConfigurationCommitment({ ...configuration, recipient: 1n }));
    expect(() => sharedAssetClaimConfigurationCommitment({ ...configuration, assetId: 0n })).toThrow(/asset and amount must be nonzero/);
    expect(() => sharedAssetClaimConfigurationCommitment({ ...configuration, amount: 0n })).toThrow(/asset and amount must be nonzero/);
  });
});
