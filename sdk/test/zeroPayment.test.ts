import { memoData } from "./memoData.ts";
// A zero-value native payment is an ordinary type-0 payment whose primary slot
// is dummy padding. Conservation is unchanged, so it may spend no notes only
// when the complete transaction, including its fee, has nothing to fund.
import { describe, expect, it } from "vitest";
import { buildNativeTransfer } from "../src/builders/nativeTransfer.ts";
import { PRIVATE_VALUE_PROFILES, type PrivateValueShape } from "../src/constants/privateValueProfiles.ts";
import { VK_LEN, computeCircuitVkHash } from "../src/protocol/account.ts";
import { fieldToHex } from "../src/crypto/field.ts";
import {
  dummyNullifier,
  noteNk,
  noteBodyCommitment,
  noteSecret,
  noteSecretSeed,
  ownerChangeNoteSecret,
  ownerCommitment,
} from "../src/protocol/notes.ts";
import { decodePayload, decryptEnvelope } from "../src/protocol/envelope.ts";
import { OUTPUT_DATA_BYTES } from "../src/constants/params.ts";
import { SlotClass } from "../src/protocol/transaction.ts";
import { addressHex } from "../src/utils/hex.ts";
import { zeroPaymentFixture, zeroPaymentParams } from "./zeroPaymentFixtures.ts";
import { deriveTestWallet } from "./testWallet.ts";
import { beBytes } from "../src/utils/bytes.ts";

const vkFields = Array.from({ length: VK_LEN }, (_, i) => fieldToHex(BigInt(i + 1)));
const authorizationVk = { vkFields, vkHash: fieldToHex(computeCircuitVkHash(vkFields)) };

function kernelMap(build: ReturnType<typeof buildNativeTransfer>) {
  return build.buildKernelWitnessMap(authorizationVk) as Record<string, unknown>;
}

function classes(slots: readonly { slotClass: number }[]): number[] {
  return slots.map((slot) => slot.slotClass);
}

describe.each([
  ["S", PRIVATE_VALUE_PROFILES.S.shapeId, "account_rule_payment_ecdsa"],
  ["L", PRIVATE_VALUE_PROFILES.L.shapeId, "account_rule_large_batch_transfer_ecdsa"],
] as const)("zero-value %s payment builder", (_name, shape: PrivateValueShape, circuit) => {
  const profile = shape === 0 ? PRIVATE_VALUE_PROFILES.S : PRIVATE_VALUE_PROFILES.L;

  it("spends no notes at zero fee and pads every slot", () => {
    const { build } = zeroPaymentFixture({ shape });
    expect(build.authorizationCircuit).toBe(circuit);
    expect(classes(build.transaction.inputs)).toEqual(Array(profile.inputs).fill(SlotClass.DUMMY));
    expect(classes(build.transaction.outputs)).toEqual(Array(profile.outputs).fill(SlotClass.DUMMY));
    expect(build.transaction.inputs.map((input) => input.nullifier))
      .toEqual(Array.from({ length: profile.inputs }, (_, i) => dummyNullifier(42n, i)));
    expect(build.transaction.global.openFeeAmount).toBe(0n);
    expect(build.publicInputs).toHaveLength(profile.publicInputs);
    expect(build.outputData.map((data) => data.length)).toEqual(Array(profile.outputs).fill(OUTPUT_DATA_BYTES));
    // Slot 0 is canonical padding, not a zero-valued note to the recipient.
    expect(build.transaction.outputs[0]!.outputBodyCommitment)
      .toBe(noteBodyCommitment(ownerCommitment(0n, build.outputNoteSecrets[0]!), 0n, 0n));
    const map = kernelMap(build);
    expect((map.output_dummy_secrets as string[])[0]).toBe(fieldToHex(build.outputNoteSecrets[0]!));
    expect(map.output_amounts).toEqual(Array(profile.outputs).fill(fieldToHex(0n)));
    expect((map.owner_inputs as object[]).every((input) => !("is_absent" in input))).toBe(true);
  });

  it("keeps padding private from the note key when nullifiers repeat", () => {
    const first = zeroPaymentFixture({ shape });
    const second = zeroPaymentFixture({ shape });
    const nullifiers = first.build.transaction.inputs.map((input) => input.nullifier);
    expect(second.build.transaction.inputs.map((input) => input.nullifier)).toEqual(nullifiers);
    const seed = noteSecretSeed(noteNk(first.wallet.nkRoot));
    for (let slot = 0; slot < profile.outputs; slot++) {
      const oldCandidate = noteSecret(seed, nullifiers, slot, 0n, shape);
      const oldCandidateBody = noteBodyCommitment(
        ownerCommitment(0n, oldCandidate),
        0n,
        0n,
      );
      expect(first.build.outputNoteSecrets[slot]).not.toBe(oldCandidate);
      expect(second.build.outputNoteSecrets[slot]).not.toBe(oldCandidate);
      expect(first.build.transaction.outputs[slot]!.outputBodyCommitment).not.toBe(oldCandidateBody);
      expect(second.build.transaction.outputs[slot]!.outputBodyCommitment).not.toBe(oldCandidateBody);
      expect(second.build.outputNoteSecrets[slot]).not.toBe(first.build.outputNoteSecrets[slot]);
    }
  });

  it("funds a positive fee exactly with no change", () => {
    const { build } = zeroPaymentFixture({ shape, inputAmounts: [5n], openFeeAmount: 5n });
    expect(build.transaction.inputs[0]!.slotClass).toBe(SlotClass.NATIVE);
    expect(classes(build.transaction.outputs)).toEqual(Array(profile.outputs).fill(SlotClass.DUMMY));
    expect(build.publicInputs[profile.offsets.openFeeAmount]).toBe(5n);
  });

  it.each([
    ["a positive fee", [100n], 5n, 95n],
    ["explicit inputs at zero fee", [100n, 50n], 0n, 150n],
  ] as const)("returns change after %s", (_label, inputAmounts, openFeeAmount, change) => {
    const { build, wallet } = zeroPaymentFixture({ shape, inputAmounts, openFeeAmount });
    expect(build.transaction.outputs[0]!.slotClass).toBe(SlotClass.DUMMY);
    expect(build.transaction.outputs[1]!.slotClass).toBe(SlotClass.NATIVE);
    expect(classes(build.transaction.outputs.slice(2))).toEqual(Array(profile.outputs - 2).fill(SlotClass.DUMMY));
    const nullifiers = build.transaction.inputs.map((input) => input.nullifier);
    expect(build.outputNoteSecrets[1]).toBe(ownerChangeNoteSecret(wallet.nkRoot, nullifiers, 1, shape));
    const payload = decodePayload(decryptEnvelope(wallet.mlKemSecretKey!, build.outputData[1]!)!, { chainId: build.pcashChainId });
    expect(payload).toMatchObject({ amount: change, owner: wallet.address, outputIndex: 1 });
    const rule = build.accountRuleWitnessMap!;
    if (shape === 0) {
      expect(rule.native_change_amount).toBe(fieldToHex(change));
    } else {
      expect((rule.owner_change_amounts as string[])[1]).toBe(fieldToHex(change));
    }
  });

  it("rejects a positive fee without native funding", () => {
    const { params } = zeroPaymentParams({ shape, openFeeAmount: 1n });
    expect(() => buildNativeTransfer(params)).toThrow(/sum\(inputs\) < paymentAmount/);
  });
});

describe("zero-value payment authorization", () => {
  it("signs the recipient and a zero amount under the payment rule", () => {
    const { build, wallet } = zeroPaymentFixture();
    const message = build.authorizationRequest!.typedData.message as Record<string, unknown>;
    expect(message.recipient).toBe(addressHex(wallet.address));
    expect(message.amount).toBe("0");
    expect(message.openFeeAmount).toBe("0");
    expect(build.accountRuleWitnessMap!.amount).toBe(fieldToHex(0n));
    expect(build.accountRuleWitnessMap!.recipient).toBe(fieldToHex(wallet.address));
  });

  it("declares every L slot all-zero, including the padded payment slot", () => {
    const { build } = zeroPaymentFixture({ shape: PRIVATE_VALUE_PROFILES.L.shapeId, inputAmounts: [100n], openFeeAmount: 1n });
    const message = build.authorizationRequest!.typedData.message as Record<string, unknown>;
    for (let i = 0; i < PRIVATE_VALUE_PROFILES.L.outputs; i++) {
      expect(message[`out${i}Recipient`]).toBe(addressHex(0n));
      expect(message[`out${i}Amount`]).toBe("0");
      expect(message[`out${i}AssetId`]).toBe("0");
    }
    const outputs = build.accountRuleWitnessMap!.outputs as { recipient: string; amount: string }[];
    expect(outputs.every((output) => BigInt(output.recipient) === 0n && BigInt(output.amount) === 0n)).toBe(true);
  });

  it("needs no recipient receive key and encrypts nothing to it", () => {
    const { params, wallet } = zeroPaymentParams();
    const build = buildNativeTransfer({ ...params, recipientReceiveKey: wallet.mlKemPublicKey! });
    expect(decryptEnvelope(wallet.mlKemSecretKey!, build.outputData[0]!)).toBeNull();
  });

  it("samples fresh dummy entropy for each action", () => {
    const { params } = zeroPaymentParams();
    const { dummyInputEntropy: _fixed, ...fresh } = params;
    const first = buildNativeTransfer(fresh).transaction.inputs.map((input) => input.nullifier);
    const second = buildNativeTransfer(fresh).transaction.inputs.map((input) => input.nullifier);
    expect(new Set([...first, ...second]).size).toBe(first.length + second.length);
  });

  it("rejects negative and out-of-range amounts", () => {
    const { params } = zeroPaymentParams({ inputAmounts: [10n] });
    expect(() => buildNativeTransfer({ ...params, paymentAmount: -1n })).toThrow(/paymentAmount must be nonnegative/);
    expect(() => buildNativeTransfer({ ...params, paymentAmount: 1n << 128n })).toThrow(/paymentAmount must be nonnegative/);
  });

  it("funds an additional output like any other and pads the payment slot", () => {
    const other = deriveTestWallet({ privKey: beBytes(7n, 32), mlKem: "deterministic" });
    const secondOutput = { address: other.address, amount: 40n, receiveKey: other.mlKemPublicKey! };
    const unfunded = zeroPaymentParams().params;
    expect(() => buildNativeTransfer({ ...unfunded, secondOutput })).toThrow(/sum\(inputs\) < paymentAmount/);
    const { params, wallet } = zeroPaymentParams({ inputAmounts: [100n] });
    const build = buildNativeTransfer({ ...params, secondOutput });
    expect(build.authorizationCircuit).toBe("account_rule_batch_transfer_ecdsa");
    expect(classes(build.transaction.outputs)).toEqual([
      SlotClass.DUMMY, SlotClass.NATIVE, SlotClass.NATIVE, SlotClass.DUMMY, SlotClass.DUMMY,
    ]);
    const message = build.authorizationRequest!.typedData.message as Record<string, unknown>;
    expect([message.out0Recipient, message.out0Amount]).toEqual([addressHex(0n), "0"]);
    expect([message.out1Recipient, message.out1Amount]).toEqual([addressHex(other.address), "40"]);
    expect([message.out2Recipient, message.out2Amount]).toEqual([addressHex(0n), "0"]);
    expect(decodePayload(decryptEnvelope(wallet.mlKemSecretKey!, build.outputData[2]!)!, { chainId: build.pcashChainId }).amount).toBe(60n);
  });

  it("allows a memo without creating a recipient note", () => {
    const { params } = zeroPaymentParams();
    expect(() => buildNativeTransfer({ ...params,
data: memoData(params, new Uint8Array([1]), false) })).not.toThrow();
  });

  it("builds application markers without a real input", () => {
    const { params } = zeroPaymentParams();
    const build = buildNativeTransfer({
      ...params,
      applicationMarkers: [{ slot: 0, replayId: 7n, selectedEntryCommitment: 9n }],
    });
    expect(build.transaction.inputs[0]!.slotClass).toBe(SlotClass.APPLICATION);
    expect(build.transaction.outputs.every((output) => output.slotClass === SlotClass.DUMMY)).toBe(true);
  });
});
