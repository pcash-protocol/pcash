import { describe, expect, it } from "vitest";
import { PRIVATE_VALUE_PROFILES } from "../src/constants/privateValueProfiles.ts";
import { fieldToHex, type FieldNumberish } from "../src/crypto/field.ts";
import { authorizePcashRequestWithPrivateKey, createPcashAuthorizationRequest } from "../src/eip712/authorization.ts";
import { assetBurnTypedData, batchTransferTypedData } from "../src/rules/semanticRules.ts";
import {
  buildAssetBurnRuleWitness,
  buildBatchTransferRuleWitness,
  type AssetNamespaceOpening,
} from "../src/rules/semanticWitnesses.ts";
import { DEFAULT_NETWORK_CONFIG } from "../src/protocol/network.ts";
import { SlotClass, type SlotClassValue, type PrivateValue } from "../src/protocol/transaction.ts";
import { deriveTestWallet } from "./testWallet.ts";

const wallet = deriveTestWallet();
const pcashChainId = BigInt(DEFAULT_NETWORK_CONFIG.pcashChainId);
const zeroOpening = { owner_commitment: fieldToHex(0n), amount: fieldToHex(0n), output_index: fieldToHex(0n) };
const opening = { ownerCommitment: 23n, amount: 10n, leafIndex: 7n };

// These tests exercise the exported witness boundary alone, without constructing
// a kernel witness or executing/proving a circuit.
for (const kind of ["asset-burn", "batch-transfer-S", "batch-transfer-L"] as const) {
  const profile = kind === "batch-transfer-L" ? PRIVATE_VALUE_PROFILES.L : PRIVATE_VALUE_PROFILES.S;
  function build(burn: FieldNumberish, outputClass: SlotClassValue, assetNamespaceOpening?: AssetNamespaceOpening) {
    const transaction: PrivateValue = {
      global: { openFeeAmount: 0n, issuanceOwnerCommitment: 0n, notBeforeTimestamp: 0n,
        validUntilTimestamp: 100n, carrierContextHash: 0n, assetBurnAmount: burn, deliveryCommitment: 0n },
      inputs: Array.from({ length: profile.inputs }, (_, i) => ({
        slotClass: i === 0 ? SlotClass.ASSET : SlotClass.DUMMY,
        inputCommitment: i === 0 ? 1n : 0n, nullifier: BigInt(i + 1),
      })),
      outputs: Array.from({ length: profile.outputs }, (_, i) => ({
        slotClass: i === profile.outputs - 1 ? outputClass : SlotClass.DUMMY,
        outputBodyCommitment: BigInt(i + 1),
      })),
    };
    const message = { pcashChainId, assetId: 11n, openFeeAmount: 0n, issuanceRecipient: 0n,
      issuanceOwnerCommitment: 0n, relayFeeAmount: 0n, relayFeeOwnerCommitment: 0n,
      transactionContext: 0n, notBefore: 0n, validUntil: 100n };
    const common = {
      wallet, recentPcashBlockHash: 3n, nkRoot: wallet.nkRoot, transaction,
      issuanceNoteSecret: 0n, assetNamespaceOpening,
    };
    if (kind === "asset-burn") {
      const burnMessage = { ...message, burnAmount: burn };
      const authorization = authorizePcashRequestWithPrivateKey(wallet.privKey, createPcashAuthorizationRequest({
        kind: "asset-burn", authorizingAddress: wallet.address, typedData: assetBurnTypedData(DEFAULT_NETWORK_CONFIG, burnMessage),
      }));
      return buildAssetBurnRuleWitness({ ...common, message: burnMessage, authorization,
        changeAmounts: Array.from({ length: profile.outputs }, () => 0n) });
    }
    const batchMessage = { ...message, assetBurnAmount: burn,
      outputs: Array.from({ length: profile.outputs }, () => ({ recipient: 0n, amount: 0n, assetId: 0n })) };
    const authorization = authorizePcashRequestWithPrivateKey(wallet.privKey, createPcashAuthorizationRequest({
      kind: "batch-transfer", authorizingAddress: wallet.address,
      typedData: batchTransferTypedData(DEFAULT_NETWORK_CONFIG, batchMessage, profile.shapeId),
    }));
    return buildBatchTransferRuleWitness({ ...common, shape: profile.shapeId, message: batchMessage, authorization,
      outputNoteSecrets: Array.from({ length: profile.outputs }, () => 0n),
      ownerChangeAmounts: Array.from({ length: profile.outputs }, () => 0n) });
  }

  describe(`${kind} namespace-opening boundary`, () => {
    it.each([10n, 10, "10", "0x0a"])("rejects omitted full-burn opening for burn %s", burn => {
      expect(() => build(burn, SlotClass.DUMMY)).toThrow(
        "assetNamespaceOpening is required for a burn with no ASSET output",
      );
    });

    it("still requires an opening when there is only a native output", () => {
      expect(() => build(10n, SlotClass.NATIVE)).toThrow(/assetNamespaceOpening is required/);
    });

    it("maps a supplied full-burn opening", () => {
      expect(build(10n, SlotClass.DUMMY, opening).witnessMap.asset_namespace_opening).toEqual({
        owner_commitment: fieldToHex(23n), amount: fieldToHex(10n), output_index: fieldToHex(7n),
      });
    });

    it("allows a partial burn without an opening when an ASSET output exists", () => {
      expect(build(10n, SlotClass.ASSET).witnessMap.asset_namespace_opening).toEqual(zeroOpening);
    });

    it.each([0n, 0, "0", "0x00"])("allows an inactive zero burn %s without an opening", burn => {
      expect(build(burn, SlotClass.DUMMY).witnessMap.asset_namespace_opening).toEqual(zeroOpening);
    });
  });
}
