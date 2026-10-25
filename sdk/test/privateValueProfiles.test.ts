import { describe, expect, it, vi } from "vitest";
import { PRIVATE_VALUE_PROFILES, privateValueProfile } from "../src/constants/privateValueProfiles.ts";
import { SlotClass, privateValueCommitment, type PrivateValue } from "../src/protocol/transaction.ts";
import { noteSecret } from "../src/protocol/notes.ts";
import { payoutTransactionContext } from "../src/protocol/payout.ts";
import { batchTransferEip712Type, batchTransferTypedData } from "../src/rules/semanticRules.ts";
import { pcashSigningHash } from "../src/eip712/eip712.ts";
import { fetchPinnedArtifact } from "../src/browser-prover/artifacts.ts";

function transaction(shape: 0 | 1): PrivateValue {
  const profile = privateValueProfile(shape);
  return {
    global: { openFeeAmount: 1n, issuanceOwnerCommitment: 0n,
      notBeforeTimestamp: 0n, validUntilTimestamp: 100n, carrierContextHash: 0n, assetBurnAmount: 0n, deliveryCommitment: 300n },
    inputs: Array.from({ length: profile.inputs }, (_, i) => ({ slotClass: SlotClass.NATIVE,
      inputCommitment: BigInt(i + 1), nullifier: BigInt(i + 100) })),
    outputs: Array.from({ length: profile.outputs }, (_, i) => ({ slotClass: SlotClass.NATIVE,
      outputBodyCommitment: BigInt(i + 200) })),
  };
}

describe("private-value compile-time profiles", () => {
  it("defines exactly two shapes and rejects unassigned selectors", () => {
    expect(Object.keys(PRIVATE_VALUE_PROFILES)).toEqual(["S", "L"]);
    expect(privateValueProfile(0)).toMatchObject({
      publicInputs: 18,
      wireInputs: 16,
      arenaBytes: 2632,
      offsets: { deliveryCommitment: 11, openFeeAmount: 12, issuanceOwner: 13, notBefore: 14, validUntil: 15, carrierContextHash: 16, eventsCommitment: 17 },
    });
    expect(privateValueProfile(1)).toMatchObject({
      publicInputs: 73,
      wireInputs: 71,
      arenaBytes: 16672,
      offsets: { deliveryCommitment: 66, openFeeAmount: 67, issuanceOwner: 68, notBefore: 69, validUntil: 70, carrierContextHash: 71, eventsCommitment: 72 },
    });
    for (const shape of [-1, 2, 255, 0.5, NaN]) expect(() => privateValueProfile(shape)).toThrow(/unknown/);
  });
  it("does not infer a profile from untrusted vector lengths", () => {
    const large = transaction(1);
    expect(() => privateValueCommitment(large)).toThrow(/4 input/);
    expect(() => privateValueCommitment(transaction(0), 1)).toThrow(/32 input/);
    expect(() => privateValueCommitment({ ...large, outputs: large.outputs.slice(0, 31) }, 1)).toThrow(/32 output/);
  });
  it("binds late input and output slots using the shared commitment implementation", () => {
    const tx = transaction(1);
    const base = privateValueCommitment(tx, 1);
    const inputs = [...tx.inputs];
    inputs[31] = { ...inputs[31]!, nullifier: 999n };
    expect(privateValueCommitment({ ...tx, inputs }, 1)).not.toBe(base);
    const outputs = [...tx.outputs];
    outputs[31] = { ...outputs[31]!, outputBodyCommitment: 999n };
    expect(privateValueCommitment({ ...tx, outputs }, 1)).not.toBe(base);
  });
  // A preallocated array has the profile's length but no slots; array iteration skips its holes.
  it.each([0, 1] as const)("rejects sparse slot arrays instead of hashing a shorter preimage (shape %i)", (shape) => {
    const tx = transaction(shape);
    const profile = privateValueProfile(shape);
    const sparse = <T,>(slots: readonly T[], index: number): T[] => {
      const holes = new Array<T>(slots.length);
      holes[index] = slots[index]!;
      return holes;
    };
    for (const index of [0, profile.inputs - 1]) {
      const missing = index === 0 ? 1 : 0;
      expect(() => privateValueCommitment({ ...tx, inputs: sparse(tx.inputs, index) }, shape))
        .toThrow(new RegExp(`input slot ${missing} is missing`));
    }
    for (const index of [0, profile.outputs - 1]) {
      const missing = index === 0 ? 1 : 0;
      expect(() => privateValueCommitment({ ...tx, outputs: sparse(tx.outputs, index) }, shape))
        .toThrow(new RegExp(`output slot ${missing} is missing`));
    }
  });
  it("recovers slot 31 and binds all nullifiers in both recovery contexts", () => {
    const nullifiers = transaction(1).inputs.map((input) => input.nullifier);
    const context = payoutTransactionContext(1n, nullifiers, 1);
    const secret = noteSecret(7n, nullifiers, 31n, 0n, 1);
    const changed = [...nullifiers];
    changed[31] = 999n;
    expect(payoutTransactionContext(1n, changed, 1)).not.toBe(context);
    expect(noteSecret(7n, changed, 31n, 0n, 1)).not.toBe(secret);
    expect(noteSecret(7n, nullifiers, 30n, 0n, 1)).not.toBe(secret);
    expect(() => payoutTransactionContext(1n, nullifiers)).toThrow(/4 nullifiers/);
  });
  it("displays and authorizes every large recipient", () => {
    const message = { pcashChainId: 1n, assetId: 0n, assetBurnAmount: 0n,
      outputs: Array.from({ length: 32 }, (_, i) => ({ recipient: BigInt(i + 1), amount: 1n, assetId: 0n })),
      openFeeAmount: 1n, issuanceRecipient: 0n, issuanceOwnerCommitment: 0n,
      relayFeeAmount: 0n, relayFeeOwnerCommitment: 0n,
      transactionContext: 9n, notBefore: 0n, validUntil: 100n };
    const typed = batchTransferTypedData(undefined, message, 1);
    expect(typed.types.PcashBatchTransfer!.some((field) => field.name === "out31Amount")).toBe(true);
    expect(batchTransferEip712Type(1)).toContain("out31Recipient");
    const digest = pcashSigningHash(typed);
    message.outputs[31]!.amount = 2n;
    expect(pcashSigningHash(batchTransferTypedData(undefined, message, 1))).not.toEqual(digest);
    expect(() => batchTransferTypedData(undefined, message)).toThrow(/5 output/);
  });
  it("rejects native-only artifacts before making a browser request", async () => {
    const fetch = vi.fn();
    const source = { assetSetId: "test", baseUrl: "https://assets.invalid/proving/test/" };
    vi.stubGlobal("fetch", fetch);
    try {
      await expect(fetchPinnedArtifact("/prover/account_rule_large_batch_transfer_ecdsa.json", {}, source))
        .rejects.toThrow(/requires native proving/);
      await expect(fetchPinnedArtifact("/chonk-vks/private_value_large_transfer_kernel.vk", {}, source))
        .rejects.toThrow(/requires native proving/);
      expect(fetch).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });
});
