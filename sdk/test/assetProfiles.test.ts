import { describe, expect, it } from "vitest";
import { assetProfileFixture } from "./assetProfileFixtures.ts";
import { PRIVATE_VALUE_PROFILES } from "../src/constants/privateValueProfiles.ts";
import { SlotClass, privateValueCommitment } from "../src/protocol/transaction.ts";
import { decodeTransaction, WIRE_PROOF_BYTES, privateValuePublicInputs } from "../src/protocol/codec.ts";
import { decryptEnvelope } from "../src/protocol/envelope.ts";
import { assetCreationMarker, assetSecretCommitment, standardFungibleAssetId } from "../src/protocol/asset.ts";
import { applicationNullifier } from "../src/protocol/notes.ts";
import { assetActionInputNullifiers } from "../src/builders/assetAction.ts";
import { toField } from "../src/crypto/field.ts";

describe("shared S/L asset builder", () => {
  for (const profile of Object.values(PRIVATE_VALUE_PROFILES)) {
    it(`${profile.name} preserves last-slot funding, creation delivery, and authorization`, () => {
      const { build, prepared, signed, recipient, snapshot } = assetProfileFixture({ shape: profile.shapeId });
      expect(build.shape).toBe(profile.shapeId);
      expect(build.transaction.inputs).toHaveLength(profile.inputs);
      expect(build.transaction.inputs.at(-1)!.slotClass).toBe(SlotClass.NATIVE);
      expect(build.transaction.outputs.at(-1)!.slotClass).toBe(SlotClass.ASSET);
      expect(build.publicInputs).toHaveLength(profile.publicInputs);
      expect(build.privateValueCommitment).toBe(privateValueCommitment(build.transaction, profile.shapeId));
      expect(build.recentPcashBlockHash).toBe(snapshot.recentPcashBlockHash);
      expect(prepared.authorizationCircuit).toBe(profile.name === "S" ? "account_rule_asset_creation_ecdsa" : "account_rule_large_asset_creation_ecdsa");
      expect((signed.witnessMap.outputs as unknown[])).toHaveLength(profile.outputs);
      expect((signed.witnessMap.output_note_secrets as unknown[]).at(-1)).toBe("0x" + (777n).toString(16).padStart(64, "0"));
      const decoded = decodeTransaction(build.encodeTransaction(new Uint8Array(WIRE_PROOF_BYTES)));
      expect(decoded.kind).toBe(0);
      if (decoded.kind !== 0) throw new Error("wrong entry kind");
      expect(decoded.shape).toBe(profile.shapeId);
      expect(privateValuePublicInputs(decoded)).toEqual(build.publicInputs);
      expect(decryptEnvelope(recipient.mlKemSecretKey!, build.outputData.at(-1)!)).not.toBeNull();
    });
  }
  it("uses one creation-marker and real-note nullifier domain across shapes", () => {
    const s = assetProfileFixture({ shape: PRIVATE_VALUE_PROFILES.S.shapeId });
    const l = assetProfileFixture({ shape: PRIVATE_VALUE_PROFILES.L.shapeId });
    expect(s.build.assetId).toBe(l.build.assetId);
    const marker = assetCreationMarker(l.build.assetId, l.assetSecret);
    expect(toField(s.build.transaction.inputs[0]!.nullifier)).toBe(marker);
    expect(toField(l.build.transaction.inputs[0]!.nullifier)).toBe(marker);
    expect(s.build.transaction.inputs.at(-1)!.nullifier).toBe(l.build.transaction.inputs.at(-1)!.nullifier);
    expect(s.build.privateValueCommitment).not.toBe(l.build.privateValueCommitment);
  });
  it("gives an application marker one nullifier across asset creations", () => {
    const { wallet } = assetProfileFixture({ shape: PRIVATE_VALUE_PROFILES.S.shapeId });
    const owner = { address: wallet.address, nkRoot: wallet.nkRoot };
    const selectedEntryCommitment = 0x5e1en;
    const replayId = 0x7e57n;
    const markers = [987n, 988n].map((assetSecret) => {
      const assetId = standardFungibleAssetId({ metadataCommitment: 765n, initialSupply: 1_000n,
        assetSecretCommitment: assetSecretCommitment(assetSecret) });
      return assetActionInputNullifiers({ owner, assetId, assetSecret, dummyInputSeed: 345n, inputs: [
        { kind: "creation-marker" }, { kind: "application", replayId, selectedEntryCommitment }, { kind: "dummy" }, { kind: "dummy" },
      ] });
    });
    expect(markers[0]![0]).not.toBe(markers[1]![0]);
    expect(markers[0]![1]).toBe(markers[1]![1]);
    expect(markers[0]![1]).toBe(applicationNullifier(wallet.address, selectedEntryCommitment, replayId));
  });
});
