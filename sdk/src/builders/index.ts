// Witness-map builders: the exact Prover.toml shapes the reference circuits
// consume, for native transfers, asset actions, account updates, recovery, and
// contract function calls.

export {
  buildNativeTransfer,
  buildMineAction,
  authorizeNativeTransferBuild,
  defaultEcdsaRuleSet,
  type BuildNativeTransferParams,
  type BuildMineActionParams,
  type NativeTransferBuild,
  type UserRuleWitness,
  type AccountRuleMembershipWitness,
  type TransferInputNote,
  type TransferOutput,
} from "./nativeTransfer.ts";
export type { ChonkVkArtifacts } from "../protocol/account.ts";
export type { WitnessMap } from "../protocol/witness.ts";
export { fieldArrayMap, fm, privateValuePublicInputNames, privateValueMap } from "../protocol/witness.ts";
export * from "./userAccountCreation.ts";
export * from "./assetOutputs.ts";
export * from "./assetAction.ts";
export * from "./customContractAssetCreation.ts";
export * from "./accountUpdate.ts";
export * from "./feePayment.ts";
export * from "./contractCreation.ts";
export * from "./contractCall.ts";
export * from "./sponsoredTransfer.ts";

export * from "./sharedAssetClaim.ts";
