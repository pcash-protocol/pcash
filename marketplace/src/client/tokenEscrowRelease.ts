// Token escrow release. A token escrow pays out in full and never funds a
// network fee. Its transfer role carries no native value: self-publication or a
// zero-fee open route. Its sponsored role has the claimant's or seller's own
// account pay the open fee or selected relay output through the
// sponsored-transfer kernel, with the escrow function authorizing only the
// contract's side.

import {
  buildAssetAction,
  contractFunctionAuthorization,
  openedAssetActionOutput,
  snapshotFromAccountProof,
  type AssetAccountAuthorization,
  type AssetActionBuild,
  type AssetActionInput,
  type AssetActionOutput,
} from "@pcash/sdk/builders";
import {
  PRIVATE_VALUE_PROFILES,
  type AccountProofResult,
  type DesignatedIssuanceOpening,
  type FunctionSelector,
} from "@pcash/sdk/browser";
import type { AssetDefinition } from "@pcash/sdk/protocol";
import { randomFieldEntropy } from "@pcash/sdk/utils";
import type { VerifiedL2ContractMaterial } from "./verifiedContractMaterial.ts";

/** The escrow note is input slot 0 and the payout is output slot 0 in either role. */
export const ESCROW_INPUT_SLOT = 0;
export const ESCROW_PAYOUT_SLOT = 0;

export interface TokenEscrowRelease {
  pcashChainId: bigint;
  l2Contract: VerifiedL2ContractMaterial;
  selector: FunctionSelector;
  contractAccount: Extract<AccountProofResult, { status: "present" }>;
  escrow: { noteSecret: bigint; assetId: bigint; amount: bigint; leafIndex: number; siblings: readonly bigint[] };
  /** The listing's verified definition; the payout delivers it so the recipient's wallet learns the token. */
  assetDefinition: AssetDefinition;
  payout: { recipientAddress: bigint; receiveKey: Uint8Array; noteSecret?: bigint };
}

/** The escrow contract's side of a token release. */
export function tokenEscrowReleaseSide(release: TokenEscrowRelease): {
  authorization: AssetAccountAuthorization;
  input: Extract<AssetActionInput, { kind: "asset" }>;
  output: AssetActionOutput;
} {
  if (release.escrow.assetId === 0n) throw new Error("a token release requires a token escrow");
  return {
    authorization: contractFunctionAuthorization({
      contract: release.l2Contract.body,
      selector: release.selector,
      accountIndex: Number(release.contractAccount.account.index),
      accountSiblings: release.contractAccount.accountSiblings,
    }),
    input: {
      kind: "asset",
      amount: release.escrow.amount,
      noteSecret: release.escrow.noteSecret,
      leafIndex: release.escrow.leafIndex,
      siblings: release.escrow.siblings,
    },
    output: openedAssetActionOutput({
      kind: "asset",
      pcashChainId: release.pcashChainId,
      assetId: release.escrow.assetId,
      outputIndex: ESCROW_PAYOUT_SLOT,
      noteSecret: release.payout.noteSecret ?? randomFieldEntropy(),
      amount: release.escrow.amount,
      assetDefinition: release.assetDefinition,
      recipientAddress: release.payout.recipientAddress,
      recipientMlKemPublicKey: release.payout.receiveKey,
      authenticatedRecipient: true,
      // The payout returns to whichever wallet sponsors the release, so its sender region does not record it as paid.
      change: true,
    }),
  };
}

/** A transfer-role token release: the escrow input and payout, every other slot a dummy. */
export function buildUnsponsoredTokenEscrowRelease(release: TokenEscrowRelease & {
  issuanceOwnerCommitment: bigint;
  designatedIssuanceOpening?: DesignatedIssuanceOpening;
  notBeforeTimestamp?: bigint;
  validUntilTimestamp: bigint;
  /** The carrier context the release requires; a claim names the router's payment event. */
  carrierContextHash?: bigint;
  dummyInputSeed: bigint;
}): AssetActionBuild {
  const side = tokenEscrowReleaseSide(release);
  const profile = PRIVATE_VALUE_PROFILES.S;
  const inputs: AssetActionInput[] = Array.from({ length: profile.inputs }, () => ({ kind: "dummy" }));
  inputs[ESCROW_INPUT_SLOT] = side.input;
  const outputs: AssetActionOutput[] = Array.from({ length: profile.outputs }, () => ({
    kind: "dummy", dummySecret: randomFieldEntropy(), amount: 0n,
  }));
  outputs[ESCROW_PAYOUT_SLOT] = side.output;
  return buildAssetAction({
    shape: profile.shapeId,
    pcashChainId: release.pcashChainId,
    snapshot: snapshotFromAccountProof(release.contractAccount),
    owner: side.authorization,
    assetId: release.escrow.assetId,
    inputs,
    outputs,
    openFeeAmount: 0n,
    issuanceOwnerCommitment: release.issuanceOwnerCommitment,
    ...(release.designatedIssuanceOpening === undefined ? {} : { designatedIssuanceOpening: release.designatedIssuanceOpening }),
    ...(release.notBeforeTimestamp === undefined ? {} : { notBeforeTimestamp: release.notBeforeTimestamp }),
    validUntilTimestamp: release.validUntilTimestamp,
    ...(release.carrierContextHash === undefined ? {} : { carrierContextHash: release.carrierContextHash }),
    dummyInputSeed: release.dummyInputSeed,
  });
}
