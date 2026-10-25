import { DEFAULT_EVENT_ENTRY } from "../protocol/events.ts";
import { PRIVATE_VALUE_PROFILES, privateValueProfile, type PrivateValueShape } from "../constants/privateValueProfiles.ts";
// Witness builders for the semantic default account rules.
//
// Each builder turns a verified typed-data signature plus the private openings
// the wallet already holds into the circuit's witness map. The signed message
// fields and the private openings are kept visibly separate: everything under
// `message` is what the user saw, everything else is what the circuit proves.

import { toField, type FieldNumberish } from "../crypto/field.ts";
import { fieldArrayMap, fm, privateValueMap, u8ArrayMap } from "../protocol/witness.ts";
import {
  requireWalletAuthorization,
  type VerifiedPcashAuthorization,
} from "../eip712/authorization.ts";
import {
  type NetworkConfigLike,
  networkForChain,
} from "../protocol/network.ts";
import { referenceDomainSeparatorHalves } from "./referenceRules.ts";
import { SlotClass, type PrivateValue } from "../protocol/transaction.ts";
import type { WalletProfile } from "../protocol/types.ts";
import type {
  AssetBurnMessage,
  AssetPaymentMessage,
  BatchTransferMessage,
  ContractFeeSponsorshipMessage,
} from "./semanticRules.ts";

/** The first asset input, needed only for a burn with no asset output. */
export interface AssetNamespaceOpening {
  ownerCommitment: FieldNumberish;
  amount: FieldNumberish;
  leafIndex: FieldNumberish;
}

const UNUSED_NAMESPACE_OPENING: AssetNamespaceOpening = { ownerCommitment: 0n, amount: 0n, leafIndex: 0n };

function requireFive(name: string, values: readonly FieldNumberish[]): void {
  if (values.length !== 5) throw new Error(`${name} must contain 5 values`);
}

/**
 * The configuration every ECDSA reference rule opens: the EIP-712 domain
 * separator it verifies signatures under, high 128 bits first. The rule
 * derives the signer from the public key.
 */
export function configurationMap(network: NetworkConfigLike): Record<string, unknown> {
  const separator = referenceDomainSeparatorHalves(network);
  return {
    domain_separator_high: fm(separator.high),
    domain_separator_low: fm(separator.low),
  };
}

/**
 * The witnesses that lead every ECDSA reference rule: the chain the signed
 * message names and the recent block the kernel reads. The rule computes the
 * rest of its statement.
 */
function ruleContextMap(
  pcashChainId: FieldNumberish,
  recentPcashBlockHash: FieldNumberish,
  network: NetworkConfigLike,
  eventEntry: FieldNumberish = DEFAULT_EVENT_ENTRY,
): Record<string, unknown> {
  return {
    pcash_chain_id: fm(pcashChainId),
    recent_pcash_block_hash: fm(recentPcashBlockHash),
    event_entry: fm(eventEntry),
    configuration: configurationMap(network),
  };
}

/** A verified ECDSA signature and public key as rule-circuit inputs. */
export function signatureMap(authorization: VerifiedPcashAuthorization): Record<string, unknown> {
  return {
    signature: { signature: u8ArrayMap(authorization.compact) },
    pubkey: { x: u8ArrayMap(authorization.pubX), y: u8ArrayMap(authorization.pubY) },
  };
}

function namespaceOpeningMap(transaction: PrivateValue, opening?: AssetNamespaceOpening) {
  // Direct SDK callers must supply the input opening when no asset output
  // binds the burn's namespace, matching assert_asset_namespace in the rule.
  if (toField(transaction.global.assetBurnAmount) !== 0n
    && !transaction.outputs.some(output => output.slotClass === SlotClass.ASSET)
    && opening === undefined) {
    throw new Error("assetNamespaceOpening is required for a burn with no ASSET output");
  }
  const value = opening ?? UNUSED_NAMESPACE_OPENING;
  return {
    owner_commitment: fm(value.ownerCommitment),
    amount: fm(value.amount),
    output_index: fm(value.leafIndex),
  };
}

export interface BatchTransferWitnessParams {
  shape?: PrivateValueShape;
  wallet: WalletProfile;
  network?: NetworkConfigLike;
  recentPcashBlockHash: FieldNumberish;
  eventEntry?: FieldNumberish;
  nkRoot: FieldNumberish;
  message: BatchTransferMessage;
  transaction: PrivateValue;
  issuanceNoteSecret: FieldNumberish;
  /**
   * Note secret per directed output slot; zero for owner change and padding.
   * The circuit derives owner-change secrets itself.
   */
  outputNoteSecrets: readonly FieldNumberish[];
  /** Owner change per output slot; zero where the slot is directed or padding. */
  ownerChangeAmounts: readonly FieldNumberish[];
  /** Required when the transaction burns assets and has no ASSET output. */
  assetNamespaceOpening?: AssetNamespaceOpening | undefined;
  authorization: VerifiedPcashAuthorization;
}

export function buildBatchTransferRuleWitness(
  params: BatchTransferWitnessParams,
): { witnessMap: Record<string, unknown> } {
  const profile = privateValueProfile(params.shape ?? PRIVATE_VALUE_PROFILES.S.shapeId);
  if (params.transaction.inputs.length !== profile.inputs || params.transaction.outputs.length !== profile.outputs) {
    throw new Error("batch transfer witness does not fit the selected profile");
  }
  for (const values of [params.outputNoteSecrets, params.ownerChangeAmounts, params.message.outputs]) {
    if (values.length !== profile.outputs) throw new Error(`batch transfer requires ${profile.outputs} output slots`);
  }
  requireWalletAuthorization(params.wallet, params.authorization, "batch-transfer");
  const network = networkForChain(params.message.pcashChainId, params.network);
  return {
    witnessMap: {
      ...ruleContextMap(params.message.pcashChainId, params.recentPcashBlockHash, network, params.eventEntry),
      nk_root: fm(params.nkRoot),
      asset_id: fm(params.message.assetId),
      outputs: params.message.outputs.map((output) => ({
        recipient: fm(output.recipient),
        amount: fm(output.amount),
        asset_id: fm(output.assetId),
      })),
      relay_fee_amount: fm(params.message.relayFeeAmount),
      relay_fee_owner_commitment: fm(params.message.relayFeeOwnerCommitment),
      private_value: privateValueMap(params.transaction),
      issuance_recipient: fm(params.message.issuanceRecipient),
      issuance_note_secret: fm(params.issuanceNoteSecret),
      output_note_secrets: fieldArrayMap(params.outputNoteSecrets),
      owner_change_amounts: fieldArrayMap(params.ownerChangeAmounts),
      asset_namespace_opening: namespaceOpeningMap(params.transaction, params.assetNamespaceOpening),
      ...signatureMap(params.authorization),
    },
  };
}

export interface AssetPaymentWitnessParams {
  wallet: WalletProfile;
  network?: NetworkConfigLike;
  recentPcashBlockHash: FieldNumberish;
  eventEntry?: FieldNumberish;
  nkRoot: FieldNumberish;
  message: AssetPaymentMessage;
  transaction: PrivateValue;
  issuanceNoteSecret: FieldNumberish;
  recipientNoteSecret: FieldNumberish;
  changeAmounts: readonly FieldNumberish[];
  authorization: VerifiedPcashAuthorization;
}

export function buildAssetPaymentRuleWitness(
  params: AssetPaymentWitnessParams,
): { witnessMap: Record<string, unknown> } {
  requireFive("changeAmounts", params.changeAmounts);
  requireWalletAuthorization(params.wallet, params.authorization, "asset-payment");
  const network = networkForChain(params.message.pcashChainId, params.network);
  return {
    witnessMap: {
      ...ruleContextMap(params.message.pcashChainId, params.recentPcashBlockHash, network, params.eventEntry),
      nk_root: fm(params.nkRoot),
      asset_id: fm(params.message.assetId),
      recipient: fm(params.message.recipient),
      amount: fm(params.message.amount),
      relay_fee_amount: fm(params.message.relayFeeAmount),
      relay_fee_owner_commitment: fm(params.message.relayFeeOwnerCommitment),
      private_value: privateValueMap(params.transaction),
      issuance_recipient: fm(params.message.issuanceRecipient),
      issuance_note_secret: fm(params.issuanceNoteSecret),
      recipient_note_secret: fm(params.recipientNoteSecret),
      owner_change_amounts: fieldArrayMap(params.changeAmounts),
      ...signatureMap(params.authorization),
    },
  };
}

export interface AssetBurnWitnessParams {
  wallet: WalletProfile;
  network?: NetworkConfigLike;
  recentPcashBlockHash: FieldNumberish;
  eventEntry?: FieldNumberish;
  nkRoot: FieldNumberish;
  message: AssetBurnMessage;
  transaction: PrivateValue;
  issuanceNoteSecret: FieldNumberish;
  changeAmounts: readonly FieldNumberish[];
  /** Required when the transaction burns assets and has no ASSET output. */
  assetNamespaceOpening?: AssetNamespaceOpening | undefined;
  authorization: VerifiedPcashAuthorization;
}

export function buildAssetBurnRuleWitness(
  params: AssetBurnWitnessParams,
): { witnessMap: Record<string, unknown> } {
  requireFive("changeAmounts", params.changeAmounts);
  requireWalletAuthorization(params.wallet, params.authorization, "asset-burn");
  const network = networkForChain(params.message.pcashChainId, params.network);
  return {
    witnessMap: {
      ...ruleContextMap(params.message.pcashChainId, params.recentPcashBlockHash, network, params.eventEntry),
      nk_root: fm(params.nkRoot),
      asset_id: fm(params.message.assetId),
      relay_fee_amount: fm(params.message.relayFeeAmount),
      relay_fee_owner_commitment: fm(params.message.relayFeeOwnerCommitment),
      private_value: privateValueMap(params.transaction),
      issuance_recipient: fm(params.message.issuanceRecipient),
      issuance_note_secret: fm(params.issuanceNoteSecret),
      owner_change_amounts: fieldArrayMap(params.changeAmounts),
      asset_namespace_opening: namespaceOpeningMap(params.transaction, params.assetNamespaceOpening),
      ...signatureMap(params.authorization),
    },
  };
}

export interface ContractFeeSponsorshipWitnessParams {
  wallet: WalletProfile;
  network?: NetworkConfigLike;
  recentPcashBlockHash: FieldNumberish;
  eventEntry?: FieldNumberish;
  nkRoot: FieldNumberish;
  message: ContractFeeSponsorshipMessage;
  nativeChangeAmount: FieldNumberish;
  transaction: PrivateValue;
  issuanceNoteSecret: FieldNumberish;
  authorization: VerifiedPcashAuthorization;
}

export function buildContractFeeSponsorshipRuleWitness(
  params: ContractFeeSponsorshipWitnessParams,
): { witnessMap: Record<string, unknown> } {
  requireWalletAuthorization(params.wallet, params.authorization, "contract-fee-sponsorship");
  const network = networkForChain(params.message.pcashChainId, params.network);
  return {
    witnessMap: {
      ...ruleContextMap(params.message.pcashChainId, params.recentPcashBlockHash, network, params.eventEntry),
      nk_root: fm(params.nkRoot),
      sponsored_contract: fm(params.message.sponsoredContract),
      native_change_amount: fm(params.nativeChangeAmount),
      relay_fee_amount: fm(params.message.relayFeeAmount),
      relay_fee_owner_commitment: fm(params.message.relayFeeOwnerCommitment),
      private_value: privateValueMap(params.transaction),
      issuance_recipient: fm(params.message.issuanceRecipient),
      issuance_note_secret: fm(params.issuanceNoteSecret),
      ...signatureMap(params.authorization),
    },
  };
}

export interface AssetCreationWitnessParams extends Omit<BatchTransferWitnessParams, "message" | "assetNamespaceOpening"> {
  message: import("./semanticRules.ts").AssetCreationMessage;
}

export function buildAssetCreationRuleWitness(params: AssetCreationWitnessParams): { witnessMap: Record<string, unknown> } {
  const profile = privateValueProfile(params.shape ?? PRIVATE_VALUE_PROFILES.S.shapeId);
  if (params.transaction.inputs.length !== profile.inputs || params.transaction.outputs.length !== profile.outputs) {
    throw new Error("asset creation witness does not fit the selected profile");
  }
  for (const values of [params.outputNoteSecrets, params.ownerChangeAmounts, params.message.outputs]) {
    if (values.length !== profile.outputs) throw new Error(`asset creation requires ${profile.outputs} output slots`);
  }
  requireWalletAuthorization(params.wallet, params.authorization, "asset-creation");
  const network = networkForChain(params.message.pcashChainId, params.network);
  return { witnessMap: {
    ...ruleContextMap(params.message.pcashChainId, params.recentPcashBlockHash, network, params.eventEntry),
    nk_root: fm(params.nkRoot),
    metadata_commitment: fm(params.message.metadataCommitment),
    initial_supply: fm(params.message.initialSupply),
    asset_secret_commitment: fm(params.message.assetSecretCommitment),
    outputs: params.message.outputs.map((output) => ({ recipient: fm(output.recipient), amount: fm(output.amount), asset_id: fm(output.assetId) })),
    relay_fee_amount: fm(params.message.relayFeeAmount),
    relay_fee_owner_commitment: fm(params.message.relayFeeOwnerCommitment),
    private_value: privateValueMap(params.transaction),
    issuance_recipient: fm(params.message.issuanceRecipient),
    issuance_note_secret: fm(params.issuanceNoteSecret),
    output_note_secrets: fieldArrayMap(params.outputNoteSecrets),
    owner_change_amounts: fieldArrayMap(params.ownerChangeAmounts),
    ...signatureMap(params.authorization),
  }};
}
