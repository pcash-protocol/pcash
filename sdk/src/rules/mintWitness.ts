// What a mint rule's witness reads of the mint it approves, shared by the
// standard mint rules' witness builders.

import { PRIVATE_VALUE_MAX_OUTPUTS, type PrivateValueShape } from "../constants/privateValueProfiles.ts";
import type { MintRule } from "../protocol/asset.ts";
import type { PrivateValue } from "../protocol/transaction.ts";
import { fieldArrayMap, type WitnessMap } from "../protocol/witness.ts";

/**
 * What a mint rule's witness reads of the mint it approves. An asset action
 * build of a mint carries every field.
 */
export interface MintWitnessInputs {
  shape: PrivateValueShape;
  pcashChainId: bigint;
  recentPcashBlockHash: bigint;
  assetId: bigint;
  /** The account that approves and pays for the mint. */
  address: bigint;
  /** The asset's mint rule; undefined for anything but a mint. */
  mintRule: MintRule | undefined;
  eventOpening: { eventEntry: bigint };
  transaction: PrivateValue;
  privateValueCommitment: bigint;
  outputOwnerCommitments: readonly bigint[];
  outputAmounts: readonly bigint[];
}

/** Throw unless `mint` mints an asset whose mint rule names `configurationCommitment`. */
export function requireMintRuleConfiguration(mint: MintWitnessInputs, configurationCommitment: bigint): void {
  if (mint.mintRule === undefined) throw new Error("only a mint folds a mint rule");
  if (mint.mintRule.configurationCommitment !== configurationCommitment) {
    throw new Error("the configuration does not open the asset's mint rule");
  }
}

/** The output owners and amounts a composite mint rule opens, padded to the largest profile. */
export function paddedOutputMap(mint: Pick<MintWitnessInputs, "outputOwnerCommitments" | "outputAmounts">): WitnessMap {
  const pad = (values: readonly bigint[]) => fieldArrayMap([...values, ...Array<bigint>(PRIVATE_VALUE_MAX_OUTPUTS - values.length).fill(0n)]);
  return {
    output_owner_commitments: pad(mint.outputOwnerCommitments),
    output_amounts: pad(mint.outputAmounts),
  };
}
