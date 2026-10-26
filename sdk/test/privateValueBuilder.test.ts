import { describe, expect, it } from "vitest";
import { buildNativeTransfer } from "../src/builders/nativeTransfer.ts";
import { PRIVATE_VALUE_PROFILES } from "../src/constants/privateValueProfiles.ts";
import { decodeTransaction, encodePrivateValueTransaction, privateValuePublicInputs, transactionOpenFee, privateValueTransactionSize, WIRE_PROOF_BYTES } from "../src/protocol/codec.ts";
import { SlotClass, privateValueCommitment } from "../src/protocol/transaction.ts";
import { decodePayload, decryptEnvelope } from "../src/protocol/envelope.ts";
import { ownerChangeNoteSecret } from "../src/protocol/notes.ts";
import { privateValueProfileFixture } from "./privateValueProfileFixtures.ts";
import {
  ACCOUNT_UPDATE_PUBLIC_INPUT_NAMES,
  TYPE0_PUBLIC_INPUT_NAMES,
} from "../src/browser-prover/proverClient.ts";

describe("shared native S/L builder", () => {
  it("maps browser prover statements through open fee and issuance before account extras", () => {
    expect(TYPE0_PUBLIC_INPUT_NAMES).toHaveLength(19);
    expect(TYPE0_PUBLIC_INPUT_NAMES[11]).toBe("delivery_commitment");
    expect(TYPE0_PUBLIC_INPUT_NAMES.slice(12)).toEqual([
      "open_fee_amount",
      "issuance_owner_commitment",
      "not_before_timestamp",
      "valid_until_timestamp",
      "carrier_context_hash",
      "events_commitment",
      "account_creation_commitment",
    ]);
    expect(ACCOUNT_UPDATE_PUBLIC_INPUT_NAMES[19]).toBe("account_update_commitment");
  });

  it.each(["minimal", "consolidation", "distribution"] as const)("builds an L %s", (scenario) => {
    const { build, wallet, recipients } = privateValueProfileFixture({ shape: 1, scenario });
    const profile = PRIVATE_VALUE_PROFILES.L;
    expect(build.shape).toBe(1);
    expect(build.publicInputs).toHaveLength(profile.publicInputs);
    expect(build.transaction.inputs).toHaveLength(profile.inputs);
    expect(build.transaction.outputs).toHaveLength(profile.outputs);
    expect(build.authorizationCircuit).toBe("account_rule_large_batch_transfer_ecdsa");
    expect(build.accountRuleWitnessMap).toBeDefined();
    expect(build.privateValueCommitment).toBe(privateValueCommitment(build.transaction, 1));
    expect(new Set(build.transaction.inputs.map((i) => i.nullifier)).size).toBe(profile.inputs);
    const realInputs = build.transaction.inputs.filter((i) => i.slotClass === SlotClass.NATIVE);
    expect(realInputs).toHaveLength(scenario === "consolidation" ? profile.inputs : 1);
    for (const [i, recipient] of recipients.entries()) {
      const plaintext = decryptEnvelope(recipient.mlKemSecretKey!, build.outputData[i]!);
      expect(plaintext).not.toBeNull();
      const payload = decodePayload(plaintext!, { chainId: build.pcashChainId });
      expect(payload.outputIndex).toBe(i);
      expect(payload.owner).toBe(recipient.address);
      expect(payload.noteSecret).toBe(build.outputNoteSecrets[i]);
    }
    if (scenario === "distribution") {
      const slot = profile.outputs - 1;
      const payload = decodePayload(decryptEnvelope(wallet.mlKemSecretKey!, build.outputData[slot]!)!, { chainId: build.pcashChainId });
      expect(payload.outputIndex).toBe(slot);
      expect(payload.noteSecret).toBe(ownerChangeNoteSecret(wallet.nkRoot, build.transaction.inputs.map((i) => i.nullifier), slot, 1));
      const message = build.authorizationRequest!.typedData.message as Record<string, unknown>;
      expect(message.out30Amount).toBe("100");
      expect(message.out31Amount).toBe("0");
    }
  });
  it("serializes L under kind 0 and reconstructs all late-slot public inputs", () => {
    const { build } = privateValueProfileFixture({ shape: 1, scenario: "distribution" });
    const entry = build.encodeTransaction(new Uint8Array(WIRE_PROOF_BYTES));
    expect(entry[0]).toBe(0);
    expect(entry[5]).toBe(1);
    expect(entry.length).toBe(80_199);
    expect(entry.length).toBe(privateValueTransactionSize(1));
    const decoded = decodeTransaction(entry);
    if (decoded.kind !== 0) throw new Error("kind");
    expect(decoded.shape).toBe(1);
    expect(privateValuePublicInputs(decoded)).toEqual(build.publicInputs);
    expect(transactionOpenFee(entry)).toBe(1n);
    for (const selector of [2, 255]) {
      const changed = entry.slice(); changed[5] = selector;
      expect(() => decodeTransaction(changed)).toThrow(/unknown private-value shape/);
    }
    expect(() => decodeTransaction(entry.slice(0, -1))).toThrow(/unexpected end/);
    expect(() => decodeTransaction(new Uint8Array([...entry, 0]))).toThrow(/trailing/);
    expect(() => encodePrivateValueTransaction({ ...build, shape: 0, proof: new Uint8Array(WIRE_PROOF_BYTES) }))
      .toThrow(/requires 5 outputData/);
  });
  it("uses the same builder for S without adding L slots", () => {
    const { build } = privateValueProfileFixture({ shape: 0, scenario: "distribution" });
    expect(build.publicInputs).toHaveLength(PRIVATE_VALUE_PROFILES.S.publicInputs);
    expect(build.authorizationCircuit).toBe("account_rule_batch_transfer_ecdsa");
    expect(build.outputData).toHaveLength(PRIVATE_VALUE_PROFILES.S.outputs);
  });
  it("reserves space for change and rejects oversubscribed outputs", () => {
    const { params } = privateValueProfileFixture({ shape: 1, scenario: "distribution" });
    expect(() => buildNativeTransfer({ ...params, additionalOutputs: [...params.additionalOutputs!, params.additionalOutputs![0]!] }))
      .toThrow(/too many real outputs/);
  });
});
