import { DEFAULT_EVENT_ENTRY } from "../protocol/events.ts";
// Witness builders for the reference multisig rule.

import type { PrivateValue } from "../protocol/transaction.ts";
import { ownerActionCommitment } from "../protocol/statement.ts";

import { toAddressField, toField, type FieldNumberish } from "../crypto/field.ts";
import {
  addressFromPublicKeyXY,
  signDigest
} from "../eip712/eip712.ts";
import {
  multisigRuleConfigurationCommitment,
  referenceMultisigApprovalDigest
} from "../rules/referenceRules.ts";
import { concatBytes, field32 } from "../utils/bytes.ts";
import {
  fm,
  u8ArrayMap,
  type WitnessMap,
  privateValueMap,
} from "../protocol/witness.ts";
/** A signer's secp256k1 public key (32-byte big-endian affine coordinates). */
export interface MultisigSignerPubkey {
  pubX: Uint8Array;
  pubY: Uint8Array;
}

/**
 * One threshold approval: the approving signer's public key and a 64-byte compact
 * `r||s` (canonical low-s) secp256k1 signature over the domain-separated
 * action commitment approval digest.
 */
export interface MultisigApproval {
  pubX: Uint8Array;
  pubY: Uint8Array;
  signature: Uint8Array; // 64 bytes
}

export interface BuildMultisigRuleParams {
  transaction: PrivateValue;
  /** The ID of the asset the private value creates; the transfer action ignores it. */
  createdAssetId: FieldNumberish;
  accountAddress: FieldNumberish;
  recentPcashBlockHash: FieldNumberish;
  eventEntry?: FieldNumberish;
  pcashChainId: FieldNumberish;
  configurationSalt: FieldNumberish;
  /** Full signer set (N); any order — sorted canonically by address internally. */
  signers: readonly MultisigSignerPubkey[];
  /** Threshold K (== 2 for the reference 2-of-3 group; must equal the circuit's K). */
  threshold: FieldNumberish;
  /** Exactly K approvals over the action commitment and account address. */
  approvals: readonly MultisigApproval[];
}

export interface MultisigRuleBuild {
  witnessMap: WitnessMap;
  configurationCommitment: bigint;
  actionCommitment: bigint;
  /** The account the approvals name. */
  address: bigint;
  sortedSignerAddresses: bigint[];
}

/**
 * The action the multisig rule approves and the account it acts for: the two
 * values every approval signs. The action is the asset-creation action for
 * `createdAssetId` when the private value carries a creation marker, else the
 * transfer action.
 */
export function multisigApprovalTerms(params: {
  transaction: PrivateValue;
  createdAssetId: FieldNumberish;
  accountAddress: FieldNumberish;
  pcashChainId: FieldNumberish;
}): { actionCommitment: bigint; address: bigint } {
  return {
    actionCommitment: ownerActionCommitment(params.pcashChainId, params.transaction, params.createdAssetId),
    address: toAddressField(params.accountAddress, "accountAddress"),
  };
}

const signerAddressOf = (pubX: Uint8Array, pubY: Uint8Array): bigint =>
  addressFromPublicKeyXY(concatBytes(pubX, pubY));

/**
 * Sign a threshold approval over the action commitment and account address: a
 * canonical low-s secp256k1 signature over the 32-byte big-endian
 * serialization of the exact message the multisig application checks.
 */
export function signMultisigApproval(
  privKey: Uint8Array,
  actionCommitmentValue: FieldNumberish,
  address: FieldNumberish,
): Uint8Array {
  const message = referenceMultisigApprovalDigest(actionCommitmentValue, address);
  return signDigest(privKey, field32(message)).compact;
}

/**
 * Build the multisig authorization application witness: a canonical signer
 * set and K distinct approvals. The rule computes its statement.
 */
export function buildMultisigRule(params: BuildMultisigRuleParams): MultisigRuleBuild {
  const recentPcashBlockHash = toField(
    params.recentPcashBlockHash,
    "recentPcashBlockHash",
  );
  const pcashChainId = toField(params.pcashChainId, "pcashChainId");
  const configurationSalt = toField(params.configurationSalt, "configurationSalt");
  const { actionCommitment, address } = multisigApprovalTerms(params);
  const threshold = toField(params.threshold, "threshold");
  if (params.signers.length === 0) throw new Error("multisig requires at least one signer");
  if (threshold < 1n || threshold > BigInt(params.signers.length)) {
    throw new Error(`multisig threshold ${threshold} is invalid for ${params.signers.length} signers`);
  }
  if (params.approvals.length !== Number(threshold)) {
    throw new Error(`multisig requires exactly ${threshold} approvals`);
  }

  // Canonical signer set: sorted strictly ascending by address (matches the
  // circuit's sorted/distinct assertion and the configuration-commitment operand order).
  const descs = params.signers.map((s) => {
    if (s.pubX.length !== 32 || s.pubY.length !== 32)
      throw new Error("signer pubkey coordinates must be 32 bytes each");
    return { pubX: s.pubX, pubY: s.pubY, address: signerAddressOf(s.pubX, s.pubY) };
  });
  const sorted = [...descs].sort((a, b) =>
    a.address < b.address ? -1 : a.address > b.address ? 1 : 0,
  );
  for (let i = 1;i < sorted.length;i++) {
    if (sorted[i]!.address === sorted[i - 1]!.address)
      throw new Error("multisig signers must be distinct");
  }
  const sortedSignerAddresses = sorted.map((s) => s.address);
  const configurationCommitment = multisigRuleConfigurationCommitment(
    configurationSalt,
    threshold,
    sortedSignerAddresses,
  );
  // Each approval references its signer by position in the sorted set.
  const approvals = params.approvals.map((ap) => {
    if (ap.signature.length !== 64) throw new Error("approval signature must be 64 bytes (r||s)");
    const addr = signerAddressOf(ap.pubX, ap.pubY);
    const signerIndex = sorted.findIndex((s) => s.address === addr);
    if (signerIndex < 0) throw new Error("approval signer is not in the signer set");
    return { signerIndex, signature: ap.signature };
  });
  if (new Set(approvals.map((approval) => approval.signerIndex)).size !== approvals.length) {
    throw new Error("multisig approvals must come from distinct signers");
  }

  const witnessMap: WitnessMap = {
    pcash_chain_id: fm(pcashChainId),
    recent_pcash_block_hash: fm(recentPcashBlockHash),
    event_entry: fm(params.eventEntry ?? DEFAULT_EVENT_ENTRY),
    configuration: { configuration_salt: fm(configurationSalt) },
    private_value: privateValueMap(params.transaction),
    created_asset_id: fm(params.createdAssetId),
    account_address: fm(address),
    signers: sorted.map((s) => ({ x: u8ArrayMap(s.pubX), y: u8ArrayMap(s.pubY) })),
    approvals: approvals.map((a) => ({
      signer_index: fm(a.signerIndex),
      signature: u8ArrayMap(a.signature),
    })),
  };

  return {
    witnessMap,
    configurationCommitment,
    actionCommitment,
    address,
    sortedSignerAddresses,
  };
}
