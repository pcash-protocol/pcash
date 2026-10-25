// SDK helpers for the repository's ECDSA and multisig account rules.

import { domainSeparator, type TypedDataDomain } from "viem";
import { type FieldNumberish, toAddressField, toField } from "../crypto/field.ts";
import { poseidon } from "../crypto/poseidon2.ts";
import { pcashTypedDataDomain } from "../eip712/eip712.ts";
import {
  buildAccountRuleSet,
  accountRuleEntryCommitment,
} from "../protocol/account.ts";
import { nullifierKeyCommitment } from "../protocol/notes.ts";
import type { WalletProfile } from "../protocol/types.ts";
import { randomBytes } from "@noble/hashes/utils.js";
import { scalarFromBytes } from "../utils/bytes.ts";
import {
  DEFAULT_NETWORK_CONFIG,
  type NetworkConfigLike,
  resolveNetworkConfig,
} from "../protocol/network.ts";
import {
  REFERENCE_CONFIGURATION_DOMAIN,
  REFERENCE_MULTISIG_APPROVAL_DOMAIN,
} from "../constants/referenceRuleConstants.ts";

import {
  ADMIN_RULE_VK_HASH,
  ASSET_BURN_RULE_VK_HASH,
  ASSET_CREATION_RULE_VK_HASH,
  ASSET_PAYMENT_RULE_VK_HASH,
  BATCH_TRANSFER_RULE_VK_HASH,
  CONTRACT_FEE_SPONSORSHIP_RULE_VK_HASH,
  LARGE_ASSET_CREATION_RULE_VK_HASH,
  LARGE_BATCH_TRANSFER_RULE_VK_HASH,
  LARGE_CONTRACT_FEE_SPONSORSHIP_RULE_VK_HASH,
  PAYMENT_RULE_VK_HASH,
} from "../constants/rulePins.ts";

/** Default user set slots. Consensus assigns no capability meaning to these indices. */
export const DEFAULT_USER_RULE_ENTRY_INDEX = 0;
export const DEFAULT_ASSET_PAYMENT_RULE_ENTRY_INDEX = 1;
export const DEFAULT_ASSET_BURN_RULE_ENTRY_INDEX = 2;
export const DEFAULT_BATCH_TRANSFER_RULE_ENTRY_INDEX = 3;
export const DEFAULT_ACCOUNT_ADMIN_RULE_ENTRY_INDEX = 4;
export const DEFAULT_CONTRACT_FEE_RULE_ENTRY_INDEX = 5;
export const DEFAULT_ASSET_CREATION_RULE_ENTRY_INDEX = 6;
export const DEFAULT_LARGE_BATCH_TRANSFER_RULE_ENTRY_INDEX = 7;
export const DEFAULT_LARGE_ASSET_CREATION_RULE_ENTRY_INDEX = 8;
export const DEFAULT_LARGE_CONTRACT_FEE_RULE_ENTRY_INDEX = 9;

/** Every index the product rule set reserves. */
export const DEFAULT_RULE_ENTRY_INDICES = [
  DEFAULT_USER_RULE_ENTRY_INDEX,
  DEFAULT_ASSET_PAYMENT_RULE_ENTRY_INDEX,
  DEFAULT_ASSET_BURN_RULE_ENTRY_INDEX,
  DEFAULT_BATCH_TRANSFER_RULE_ENTRY_INDEX,
  DEFAULT_ACCOUNT_ADMIN_RULE_ENTRY_INDEX,
  DEFAULT_CONTRACT_FEE_RULE_ENTRY_INDEX,
  DEFAULT_ASSET_CREATION_RULE_ENTRY_INDEX,
  DEFAULT_LARGE_BATCH_TRANSFER_RULE_ENTRY_INDEX,
  DEFAULT_LARGE_ASSET_CREATION_RULE_ENTRY_INDEX,
  DEFAULT_LARGE_CONTRACT_FEE_RULE_ENTRY_INDEX,
] as const;

/**
 * The EIP-712 domain separator the reference rules verify signatures under,
 * as the two 128-bit halves their configuration commits. It is the separator
 * of the domain every PCASH typed-data payload carries.
 */
export function referenceDomainSeparatorHalves(network: NetworkConfigLike): { high: bigint; low: bigint } {
  const domain = pcashTypedDataDomain(resolveNetworkConfig(network));
  const separator = BigInt(domainSeparator({ domain: domain as TypedDataDomain }));
  return { high: separator >> 128n, low: separator & ((1n << 128n) - 1n) };
}

/**
 * configurationCommitment = poseidon(REFERENCE_CONFIGURATION_DOMAIN,
 * domainSeparatorHigh128, domainSeparatorLow128, nullifierKeyCommitment): the
 * signing domain of an ECDSA reference rule and the account nullifier key its
 * owner change and self-designated issuance derive from. The rule opens it with
 * the `nkRoot` it witnesses; the signer is the account the kernel authenticates.
 */
export function ecdsaRuleConfigurationCommitment(
  network: NetworkConfigLike,
  nullifierKeyCommitment: FieldNumberish,
): bigint {
  const separator = referenceDomainSeparatorHalves(network);
  return poseidon([
    REFERENCE_CONFIGURATION_DOMAIN,
    separator.high,
    separator.low,
    toField(nullifierKeyCommitment, "nullifierKeyCommitment"),
  ]);
}

export interface DefaultUserAccountRule {
  applicationVkHash: bigint;
  configurationCommitment: bigint;
  commitmentBlinder: bigint;
  entryIndex: number;
  accountRuleEntryCommitment: bigint;
  siblings: bigint[];
}

export interface DefaultUserAccountRuleSet {
  entries: readonly DefaultUserAccountRule[];
  accountRuleSetCommitment: bigint;
  /** The native payment rule — the wallet's default interactive signing path. */
  rule: DefaultUserAccountRule;
  assetPaymentRule: DefaultUserAccountRule;
  assetCreationRule: DefaultUserAccountRule;
  assetBurnRule: DefaultUserAccountRule;
  /** The general batch rule for shapes the narrow messages cannot cover. */
  batchTransferRule: DefaultUserAccountRule;
  largeBatchTransferRule: DefaultUserAccountRule;
  largeAssetCreationRule: DefaultUserAccountRule;
  largeContractFeeSponsorshipRule: DefaultUserAccountRule;
  accountAdminRule: DefaultUserAccountRule;
  contractFeeSponsorshipRule: DefaultUserAccountRule;
}

export interface DefaultUserRuleSecrets {
  paymentCommitmentBlinder: FieldNumberish;
  assetCreationCommitmentBlinder: FieldNumberish;
  assetPaymentCommitmentBlinder: FieldNumberish;
  assetBurnCommitmentBlinder: FieldNumberish;
  batchTransferCommitmentBlinder: FieldNumberish;
  largeBatchTransferCommitmentBlinder: FieldNumberish;
  largeAssetCreationCommitmentBlinder: FieldNumberish;
  largeContractFeeCommitmentBlinder: FieldNumberish;
  accountAdminCommitmentBlinder: FieldNumberish;
  contractFeeCommitmentBlinder: FieldNumberish;
}

/**
 * Sample one independent commitment blinder per default rule.
 *
 * This is the SDK-only path. The website never uses it: a browser holds no
 * durable secret, so `wallet/` derives the rule secrets by HKDF from the single
 * profile signature instead, and an architecture test keeps this function out
 * of `wallet/src`.
 */
export function generateDefaultUserRuleSecrets(): DefaultUserRuleSecrets {
  return {
    paymentCommitmentBlinder: scalarFromBytes(randomBytes(48)),
    assetCreationCommitmentBlinder: scalarFromBytes(randomBytes(48)),
    assetPaymentCommitmentBlinder: scalarFromBytes(randomBytes(48)),
    assetBurnCommitmentBlinder: scalarFromBytes(randomBytes(48)),
    batchTransferCommitmentBlinder: scalarFromBytes(randomBytes(48)),
    largeBatchTransferCommitmentBlinder: scalarFromBytes(randomBytes(48)),
    largeAssetCreationCommitmentBlinder: scalarFromBytes(randomBytes(48)),
    largeContractFeeCommitmentBlinder: scalarFromBytes(randomBytes(48)),
    accountAdminCommitmentBlinder: scalarFromBytes(randomBytes(48)),
    contractFeeCommitmentBlinder: scalarFromBytes(randomBytes(48)),
  };
}

/**
 * Build the reference user-account rule set used by the wallet. Creation
 * installs the semantic product rules under the wallet's nullifier key.
 */
export function defaultUserAccountRuleSet(params: {
  wallet: WalletProfile;
  network?: NetworkConfigLike;
  secrets: DefaultUserRuleSecrets;
}): DefaultUserAccountRuleSet {
  const configurationCommitment = ecdsaRuleConfigurationCommitment(
    params.network ?? DEFAULT_NETWORK_CONFIG,
    nullifierKeyCommitment(params.wallet.nkRoot),
  );
  const buildRule = (
    entryIndex: number,
    applicationVkHash: bigint,
    commitmentBlinderValue: FieldNumberish,
  ): Omit<DefaultUserAccountRule, "siblings"> => {
    const commitmentBlinder = toField(commitmentBlinderValue, "commitmentBlinder");
    return {
      applicationVkHash,
      configurationCommitment,
      commitmentBlinder,
      entryIndex,
      accountRuleEntryCommitment: accountRuleEntryCommitment(
        applicationVkHash,
        configurationCommitment,
        commitmentBlinder,
      ),
    };
  };
  const payment = buildRule(
    DEFAULT_USER_RULE_ENTRY_INDEX,
    PAYMENT_RULE_VK_HASH,
    params.secrets.paymentCommitmentBlinder,
  );
  const assetPayment = buildRule(
    DEFAULT_ASSET_PAYMENT_RULE_ENTRY_INDEX,
    ASSET_PAYMENT_RULE_VK_HASH,
    params.secrets.assetPaymentCommitmentBlinder,
  );
  const assetBurn = buildRule(
    DEFAULT_ASSET_BURN_RULE_ENTRY_INDEX,
    ASSET_BURN_RULE_VK_HASH,
    params.secrets.assetBurnCommitmentBlinder,
  );
  const batchTransfer = buildRule(
    DEFAULT_BATCH_TRANSFER_RULE_ENTRY_INDEX,
    BATCH_TRANSFER_RULE_VK_HASH,
    params.secrets.batchTransferCommitmentBlinder,
  );
  const largeBatchTransfer = buildRule(
    DEFAULT_LARGE_BATCH_TRANSFER_RULE_ENTRY_INDEX,
    LARGE_BATCH_TRANSFER_RULE_VK_HASH,
    params.secrets.largeBatchTransferCommitmentBlinder,
  );
  const accountAdmin = buildRule(
    DEFAULT_ACCOUNT_ADMIN_RULE_ENTRY_INDEX,
    ADMIN_RULE_VK_HASH,
    params.secrets.accountAdminCommitmentBlinder,
  );
  const contractFeeSponsorship = buildRule(
    DEFAULT_CONTRACT_FEE_RULE_ENTRY_INDEX,
    CONTRACT_FEE_SPONSORSHIP_RULE_VK_HASH,
    params.secrets.contractFeeCommitmentBlinder,
  );
  const assetCreation = buildRule(
    DEFAULT_ASSET_CREATION_RULE_ENTRY_INDEX,
    ASSET_CREATION_RULE_VK_HASH,
    params.secrets.assetCreationCommitmentBlinder,
  );
  const largeAssetCreation = buildRule(
    DEFAULT_LARGE_ASSET_CREATION_RULE_ENTRY_INDEX,
    LARGE_ASSET_CREATION_RULE_VK_HASH,
    params.secrets.largeAssetCreationCommitmentBlinder,
  );
  const largeContractFeeSponsorship = buildRule(
    DEFAULT_LARGE_CONTRACT_FEE_RULE_ENTRY_INDEX,
    LARGE_CONTRACT_FEE_SPONSORSHIP_RULE_VK_HASH,
    params.secrets.largeContractFeeCommitmentBlinder,
  );
  const entries = [largeAssetCreation, largeContractFeeSponsorship, payment, assetPayment, assetBurn, batchTransfer, largeBatchTransfer, accountAdmin, contractFeeSponsorship, assetCreation];
  const set = buildAccountRuleSet(entries.map((entry) => ({
    entryIndex: entry.entryIndex,
    accountRuleEntryCommitment: entry.accountRuleEntryCommitment,
  })));
  const withMembership = (entry: Omit<DefaultUserAccountRule, "siblings">) => ({
    ...entry,
    siblings: set.membership(entry.entryIndex).siblings,
  });
  return {
    accountRuleSetCommitment: set.accountRuleSetCommitment,
    entries: [...entries].sort((a, b) => a.entryIndex - b.entryIndex).map(withMembership),
    rule: withMembership(payment),
    assetPaymentRule: withMembership(assetPayment),
    assetCreationRule: withMembership(assetCreation),
    assetBurnRule: withMembership(assetBurn),
    batchTransferRule: withMembership(batchTransfer),
    largeBatchTransferRule: withMembership(largeBatchTransfer),
    largeAssetCreationRule: withMembership(largeAssetCreation),
    largeContractFeeSponsorshipRule: withMembership(largeContractFeeSponsorship),
    accountAdminRule: withMembership(accountAdmin),
    contractFeeSponsorshipRule: withMembership(contractFeeSponsorship),
  };
}

export function multisigRuleConfigurationCommitment(
  configurationSalt: FieldNumberish,
  threshold: FieldNumberish,
  signerAddresses: readonly FieldNumberish[],
): bigint {
  const addrs = signerAddresses.map((address) => toField(address, "signerAddress"));
  const sorted = [...addrs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === sorted[i - 1]) throw new Error("multisig signer addresses must be distinct");
  }
  return referenceConfigurationCommitment(configurationSalt, [
    toField(threshold, "threshold"),
    ...sorted,
  ]);
}

/** What each multisig signer approves. The action commitment carries the chain ID. */
export function referenceMultisigApprovalDigest(
  actionCommitment: FieldNumberish,
  address: FieldNumberish,
): bigint {
  return poseidon([
    REFERENCE_MULTISIG_APPROVAL_DOMAIN,
    toField(actionCommitment, "actionCommitment"),
    toAddressField(address),
  ]);
}

/** Optional configuration-opening formula used by the repository's reference rules. */
export function referenceConfigurationCommitment(
  configurationSalt: FieldNumberish,
  fields: readonly FieldNumberish[],
): bigint {
  return poseidon([
    REFERENCE_CONFIGURATION_DOMAIN,
    toField(configurationSalt, "configurationSalt"),
    ...fields.map((value, index) => toField(value, `configuration[${index}]`)),
  ]);
}
