import { describe, expect, it, vi } from "vitest";
import { authorizeNativeTransferBuild, buildMineAction } from "../src/builders/nativeTransfer.ts";
import { readPublicRecords } from "../src/protocol/arena.ts";
import { applicationSchemaId } from "../src/protocol/records.ts";
import { SlotClass } from "../src/protocol/transaction.ts";
import { mineFixture } from "./mineFixtures.ts";

describe("mine action builder", () => {
  it.each([false, true])("builds an all-padding action without registered-rule authorization (registered: %s)", async (registered) => {
    const { build, params, payout, wallet } = mineFixture(registered);
    expect(build.shape).toBe(0);
    expect(build.authorizationCircuit).toBe("account_rule_mine");
    expect(build.authorizationRequest).toBeUndefined();
    expect(build.authorizeAccountRule).toBeUndefined();
    expect(build.accountRuleWitnessMap).toBeDefined();
    expect(build.transaction.inputs.every((input) => input.slotClass === SlotClass.DUMMY)).toBe(true);
    expect(build.transaction.outputs.every((output) => output.slotClass === SlotClass.DUMMY)).toBe(true);
    expect(build.transaction.global.openFeeAmount).toBe(0n);
    expect(build.transaction.global.issuanceOwnerCommitment).toBe(payout.ownerCommitment);
    expect(build.accountRuleSetCommitment).not.toBe(params.ruleSetCommitment);
    const signTypedData = vi.fn();
    expect(await authorizeNativeTransferBuild(build, { address: wallet.address, signTypedData })).toBe(build);
    expect(signTypedData).not.toHaveBeenCalled();
  });

  it("carries public transaction data", () => {
    const { params } = mineFixture();
    const post = { schema: applicationSchemaId("com.example.post"), data: Uint8Array.of(1, 2, 3) };
    expect(readPublicRecords(buildMineAction({ ...params, data: { public: [post] } }).arena)).toEqual([post]);
    expect(readPublicRecords(buildMineAction(params).arena)).toBeNull();
  });

  it("samples fresh dummy nullifiers for separate actions", () => {
    const { params } = mineFixture();
    const { dummyInputEntropy: _entropy, designatedIssuanceOpening: _opening, ...base } = params;
    const fresh = { ...base, issuanceOwnerCommitment: 0n };
    const first = buildMineAction(fresh);
    const second = buildMineAction(fresh);
    const firstNullifiers = first.transaction.inputs.map((input) => input.nullifier);
    expect(new Set(firstNullifiers).size).toBe(firstNullifiers.length);
    expect(second.transaction.inputs.every((input) => !firstNullifiers.includes(input.nullifier))).toBe(true);
  });

  it("samples fresh padding secrets when dummy nullifiers repeat", () => {
    const { params } = mineFixture();
    const first = buildMineAction(params);
    const second = buildMineAction(params);
    expect(second.transaction.inputs.map((input) => input.nullifier))
      .toEqual(first.transaction.inputs.map((input) => input.nullifier));
    expect(second.outputNoteSecrets).not.toEqual(first.outputNoteSecrets);
    expect(second.outputNoteSecrets.every((secret, slot) => secret !== first.outputNoteSecrets[slot])).toBe(true);
    expect(second.transaction.outputs.map((output) => output.outputBodyCommitment))
      .not.toEqual(first.transaction.outputs.map((output) => output.outputBodyCommitment));
    expect(second.transaction.outputs.every((output, slot) =>
      output.outputBodyCommitment !== first.transaction.outputs[slot]!.outputBodyCommitment)).toBe(true);
  });
});
