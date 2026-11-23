// The standard account-mint rule: its configuration, the asset it creates, and
// the witness of `mint_rule_account_mint`. One configured account mints the
// asset whenever its own rule approves, as often as it chooses replay IDs. One
// VK serves both profiles.

import { ACCOUNT_MINT_RULE_VK_HASH } from "../constants/rulePins.ts";
import { REFERENCE_ACCOUNT_MINT_CONFIGURATION_DOMAIN } from "../constants/referenceRuleConstants.ts";
import { toAddressField, type FieldNumberish } from "../crypto/field.ts";
import { poseidon } from "../crypto/poseidon2.ts";
import type { AssetDescriptor, FungibleMetadata } from "../protocol/asset.ts";
import {
  assetDefinitionDescriptor,
  findAssetDefinition,
  type AssetDefinition,
  type PortableMintRule,
  type PortableTransferRule,
} from "../protocol/assetDefinition.ts";
import { mintActionCommitment } from "../protocol/statement.ts";
import { fm, type WitnessMap } from "../protocol/witness.ts";
import { beBytes, bytesToBigInt } from "../utils/bytes.ts";
import { requireMintRuleConfiguration, type MintWitnessInputs } from "./mintWitness.ts";

export const ACCOUNT_MINT_RULE_CIRCUIT = "mint_rule_account_mint";

/** The configuration opening: the minting account's 20-byte address. */
export const ACCOUNT_MINT_CONFIGURATION_BYTES = 20;

export interface AccountMintConfiguration {
  accountAddress: bigint;
}

export function accountMintConfigurationCommitment(configuration: AccountMintConfiguration): bigint {
  return poseidon([
    REFERENCE_ACCOUNT_MINT_CONFIGURATION_DOMAIN,
    toAddressField(configuration.accountAddress, "accountAddress"),
  ]);
}

export function encodeAccountMintConfiguration(configuration: AccountMintConfiguration): Uint8Array {
  return beBytes(toAddressField(configuration.accountAddress, "accountAddress"), ACCOUNT_MINT_CONFIGURATION_BYTES);
}

/** The configuration a canonical opening encodes, or undefined. */
export function decodeAccountMintConfiguration(bytes: Uint8Array): AccountMintConfiguration | undefined {
  if (bytes.length !== ACCOUNT_MINT_CONFIGURATION_BYTES) return undefined;
  return { accountAddress: bytesToBigInt(bytes) };
}

/** The mint rule of an asset the configured account mints at its discretion. */
export function accountMintRule(configuration: AccountMintConfiguration): PortableMintRule {
  return {
    sVkHash: ACCOUNT_MINT_RULE_VK_HASH,
    lVkHash: ACCOUNT_MINT_RULE_VK_HASH,
    configurationCommitment: accountMintConfigurationCommitment(configuration),
    configuration: encodeAccountMintConfiguration(configuration),
  };
}

/** Create an asset that `accountAddress` mints whenever its own rule approves. */
export function createAccountMintAsset(args: {
  metadata: FungibleMetadata;
  accountAddress: FieldNumberish;
  transferRule?: PortableTransferRule;
  startSalt?: FieldNumberish;
}): { definition: AssetDefinition; descriptor: AssetDescriptor } {
  const definition = findAssetDefinition({
    mintRule: accountMintRule({ accountAddress: toAddressField(args.accountAddress, "accountAddress") }),
    ...(args.transferRule === undefined ? {} : { transferRule: args.transferRule }),
    metadata: args.metadata,
  }, args.startSalt);
  return { definition, descriptor: assetDefinitionDescriptor(definition) };
}

/**
 * The witness of `mint_rule_account_mint`. The rule reads no private value: the
 * minting account's own rule approves the whole mint action.
 */
export function accountMintWitness(params: {
  mint: MintWitnessInputs;
  configuration: AccountMintConfiguration;
}): WitnessMap {
  const { mint, configuration } = params;
  requireMintRuleConfiguration(mint, accountMintConfigurationCommitment(configuration));
  if (toAddressField(configuration.accountAddress, "accountAddress") !== mint.address) {
    throw new Error("only the asset's configured account mints it");
  }
  return {
    recent_pcash_block_hash: fm(mint.recentPcashBlockHash),
    asset_id: fm(mint.assetId),
    account_address: fm(mint.address),
    valid_until_timestamp: fm(mint.transaction.global.validUntilTimestamp),
    action_commitment: fm(mintActionCommitment(mint.pcashChainId, mint.privateValueCommitment, mint.assetId)),
    event_entry: fm(mint.eventOpening.eventEntry),
  };
}
