import type { FieldNumberish } from "../crypto/field.ts";
import { BN254_SCALAR_MODULUS, toField } from "../crypto/field.ts";
import {
  ASSET_CORE_DOMAIN,
  ASSET_ID_DOMAIN,
  ASSET_MINT_POLICY_DOMAIN,
  ASSET_MINT_RULE_DOMAIN,
  ASSET_POLICY_DOMAIN,
  ASSET_TRANSFER_RULE_DOMAIN,
  MINT_MARKER_DOMAIN,
} from "../constants/domainTags.ts";
import { poseidon, poseidonBytes } from "../crypto/poseidon2.ts";
import {
  REFERENCE_ASSET_CONFIGURATION_DOMAIN,
  REFERENCE_FUNGIBLE_METADATA_DOMAIN,
} from "../constants/referenceRuleConstants.ts";
import { AMOUNT_BITS, ASSET_AGGREGATE_BITS, ASSET_CLASS_BITS } from "../constants/params.ts";
import { randomFieldEntropy } from "../utils/bytes.ts";

const ASSET_AMOUNT_LIMIT = 1n << BigInt(AMOUNT_BITS);
const ASSET_AGGREGATE_LIMIT = 1n << BigInt(ASSET_AGGREGATE_BITS);
const ASSET_CLASS_BOUND = 1n << BigInt(ASSET_CLASS_BITS);
/** The asset covenant's sub-tag under REFERENCE_ASSET_CONFIGURATION_DOMAIN; the shared asset claim uses 4 to 6. */
const ASSET_COVENANT_SUCCESSOR_TAG = 3n;

/**
 * A mint or transfer rule: one application VK hash per profile, zero for an
 * unsupported profile, and the configuration both read.
 */
export interface AssetRule {
  sVkHash: bigint;
  lVkHash: bigint;
  configurationCommitment: bigint;
}

/** The application that decides what may be minted of an asset. */
export type MintRule = AssetRule;
/** The application every transfer of a restricted asset folds. */
export type TransferRule = AssetRule;

/** Every value an asset ID commits to. `transferRule` is absent for an unrestricted asset. */
export interface AssetDescriptor {
  assetId: bigint;
  instanceSalt: bigint;
  metadataCommitment: bigint;
  mintRule: MintRule;
  transferRule?: TransferRule | undefined;
}

export type AssetDescriptorFields = Omit<AssetDescriptor, "assetId">;

export interface FungibleMetadata {
  name: string;
  symbol: string;
  decimals: number;
  contentDigest: Uint8Array;
}

function lengthPrefix(length: number): Uint8Array {
  return Uint8Array.from([(length >>> 8) & 0xff, length & 0xff]);
}

/** Validate portable metadata without deriving its commitment. */
export function validatedFungibleMetadata(metadata: FungibleMetadata): { name: Uint8Array; symbol: Uint8Array } {
  const encoder = new TextEncoder();
  const normalizedName = metadata.name.normalize("NFC");
  if (normalizedName !== metadata.name) throw new Error("metadata name must be UTF-8 NFC");
  const name = encoder.encode(normalizedName);
  if (name.length < 1 || name.length > 64) throw new Error("metadata name must contain 1..64 UTF-8 bytes");
  if (!/^[\x20-\x7e]{1,12}$/.test(metadata.symbol)) {
    throw new Error("metadata symbol must contain 1..12 printable ASCII bytes");
  }
  if (!Number.isInteger(metadata.decimals) || metadata.decimals < 0 || metadata.decimals > 18) {
    throw new Error("metadata decimals must be in 0..18");
  }
  if (metadata.contentDigest.length !== 32) throw new Error("metadata contentDigest must contain 32 bytes");
  const symbol = encoder.encode(metadata.symbol);
  return { name, symbol };
}

/** Canonical wallet/catalog commitment. Consensus treats the resulting field as opaque. */
export function fungibleMetadataCommitment(metadata: FungibleMetadata): bigint {
  const { name, symbol } = validatedFungibleMetadata(metadata);
  const preimage = new Uint8Array(2 + name.length + 1 + symbol.length + 1 + 32);
  let offset = 0;
  preimage.set(lengthPrefix(name.length), offset); offset += 2;
  preimage.set(name, offset); offset += name.length;
  preimage[offset++] = symbol.length;
  preimage.set(symbol, offset); offset += symbol.length;
  preimage[offset++] = metadata.decimals;
  preimage.set(metadata.contentDigest, offset);
  return poseidonBytes(REFERENCE_FUNGIBLE_METADATA_DOMAIN, preimage);
}

function bounded(value: FieldNumberish, bits: number, name: string): bigint {
  const integer = toField(value, name);
  if (integer >= (1n << BigInt(bits))) throw new Error(`${name} must be < 2^${bits}`);
  return integer;
}

function ruleCommitment(domain: bigint, rule: AssetRule): bigint {
  return poseidon([
    domain,
    toField(rule.sVkHash, "sVkHash"),
    toField(rule.lVkHash, "lVkHash"),
    toField(rule.configurationCommitment, "configurationCommitment"),
  ]);
}

export function mintRuleCommitment(rule: MintRule): bigint {
  return ruleCommitment(ASSET_MINT_RULE_DOMAIN, rule);
}

/** Zero for an asset without a transfer rule. */
export function transferRuleCommitment(rule: TransferRule | undefined): bigint {
  return rule === undefined ? 0n : ruleCommitment(ASSET_TRANSFER_RULE_DOMAIN, rule);
}

export function assetCoreCommitment(fields: Pick<AssetDescriptorFields, "instanceSalt" | "metadataCommitment" | "mintRule">): bigint {
  return poseidon([
    ASSET_CORE_DOMAIN,
    toField(fields.instanceSalt, "instanceSalt"),
    toField(fields.metadataCommitment, "metadataCommitment"),
    mintRuleCommitment(fields.mintRule),
  ]);
}

export function assetIdOf(coreCommitment: bigint, ruleCommitment: bigint): bigint {
  return poseidon([ASSET_ID_DOMAIN, coreCommitment, ruleCommitment]);
}

/** Whether an asset ID is in the restricted class; throws for an ID in neither class. */
export function isRestrictedAssetId(assetId: FieldNumberish): boolean {
  const id = toField(assetId, "assetId");
  if (id >= 2n * ASSET_CLASS_BOUND) throw new Error("asset ID is in neither asset class");
  return id >= ASSET_CLASS_BOUND;
}

function inClass(assetId: bigint, restricted: boolean): boolean {
  return restricted
    ? assetId >= ASSET_CLASS_BOUND && assetId < 2n * ASSET_CLASS_BOUND
    : assetId !== 0n && assetId < ASSET_CLASS_BOUND;
}

function normalizedRule(rule: AssetRule): AssetRule {
  return {
    sVkHash: toField(rule.sVkHash, "sVkHash"),
    lVkHash: toField(rule.lVkHash, "lVkHash"),
    configurationCommitment: toField(rule.configurationCommitment, "configurationCommitment"),
  };
}

/** Derive the asset ID of a definition, requiring it in the class its transfer rule implies. */
export function deriveAssetDescriptor(fields: AssetDescriptorFields): AssetDescriptor {
  const transferRule = fields.transferRule === undefined ? undefined : normalizedRule(fields.transferRule);
  const normalized = {
    instanceSalt: toField(fields.instanceSalt, "instanceSalt"),
    metadataCommitment: toField(fields.metadataCommitment, "metadataCommitment"),
    mintRule: normalizedRule(fields.mintRule),
    ...(transferRule === undefined ? {} : { transferRule }),
  };
  const assetId = assetIdOf(assetCoreCommitment(normalized), transferRuleCommitment(transferRule));
  if (!inClass(assetId, transferRule !== undefined)) {
    throw new Error("instance salt leaves the asset ID outside the class its transfer rule implies");
  }
  return { assetId, ...normalized };
}

/**
 * Search instance salts from a random start until the asset ID lands in its
 * class. Each class holds about a third of the field, so about three tries.
 */
export function findAssetDescriptor(fields: Omit<AssetDescriptorFields, "instanceSalt">, startSalt: FieldNumberish = randomFieldEntropy()): AssetDescriptor {
  let instanceSalt = toField(startSalt, "startSalt");
  for (let attempt = 0; attempt < 512; attempt += 1) {
    try {
      return deriveAssetDescriptor({ ...fields, instanceSalt });
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith("instance salt")) throw error;
    }
    instanceSalt = (instanceSalt + 1n) % BN254_SCALAR_MODULUS;
  }
  throw new Error("no instance salt found");
}

/** Throw unless `descriptor.assetId` is the hash of its definition. */
export function verifyAssetDescriptor(descriptor: AssetDescriptor): bigint {
  const derived = deriveAssetDescriptor(descriptor);
  if (toField(descriptor.assetId, "assetId") !== derived.assetId) {
    throw new Error("asset descriptor does not match assetId");
  }
  return derived.assetId;
}

/** What a restricted transfer opens of its asset's definition: the core and the transfer rule. */
export interface RestrictedAssetOpening {
  coreCommitment: bigint;
  transferRule: TransferRule;
}

/** The opening a restricted transfer of `descriptor`'s asset needs, or undefined for an unrestricted asset. */
export function restrictedAssetOpening(descriptor: AssetDescriptor): RestrictedAssetOpening | undefined {
  if (descriptor.transferRule === undefined) return undefined;
  return { coreCommitment: assetCoreCommitment(descriptor), transferRule: descriptor.transferRule };
}

/** One mint of an asset. The asset's mint rule decides which replay IDs it accepts. */
export function mintMarker(assetId: FieldNumberish, replayId: FieldNumberish): bigint {
  return poseidon([
    MINT_MARKER_DOMAIN,
    toField(assetId, "assetId"),
    toField(replayId, "replayId"),
  ]);
}

/** The first word of the statement a restricted asset's transfer rule returns. */
export function policyContext(args: {
  assetId: FieldNumberish;
  configurationCommitment: FieldNumberish;
  ownerAddress: FieldNumberish;
  validUntilTimestamp: FieldNumberish;
}): bigint {
  return poseidon([
    ASSET_POLICY_DOMAIN,
    toField(args.assetId, "assetId"),
    toField(args.configurationCommitment, "configurationCommitment"),
    bounded(args.ownerAddress, 160, "ownerAddress"),
    bounded(args.validUntilTimestamp, 64, "validUntilTimestamp"),
  ]);
}

/** The first word of the statement an asset's mint rule returns: the asset, its configuration, the minting account, and the deadline. */
export function mintContext(args: {
  assetId: FieldNumberish;
  configurationCommitment: FieldNumberish;
  accountAddress: FieldNumberish;
  validUntilTimestamp: FieldNumberish;
}): bigint {
  return poseidon([
    ASSET_MINT_POLICY_DOMAIN,
    toField(args.assetId, "assetId"),
    toField(args.configurationCommitment, "configurationCommitment"),
    bounded(args.accountAddress, 160, "accountAddress"),
    bounded(args.validUntilTimestamp, 64, "validUntilTimestamp"),
  ]);
}

export function assertAssetAmount(amount: bigint, name = "asset amount"): void {
  if (amount <= 0n || amount >= ASSET_AMOUNT_LIMIT) {
    throw new Error(`${name} must be in 1..2^${AMOUNT_BITS}-1`);
  }
}

export function assertAssetAggregate(amount: bigint, name = "asset aggregate"): void {
  if (amount < 0n || amount >= ASSET_AGGREGATE_LIMIT) {
    throw new Error(`${name} must be in 0..2^${ASSET_AGGREGATE_BITS}-1`);
  }
}

export function assetCovenantSuccessorConfigurationCommitment(args: {
  maxNativeOpenFeeAmount: FieldNumberish;
  successorAddress: FieldNumberish;
  successorNullifierKeyCommitment: FieldNumberish;
  successorRuleSetCommitment: FieldNumberish;
  successorAccountRevision: FieldNumberish;
  successorReceiveKeyHash: FieldNumberish;
}): bigint {
  return poseidon([
    REFERENCE_ASSET_CONFIGURATION_DOMAIN,
    ASSET_COVENANT_SUCCESSOR_TAG,
    bounded(args.maxNativeOpenFeeAmount, AMOUNT_BITS, "maxNativeOpenFeeAmount"),
    toField(args.successorAddress, "successorAddress"),
    toField(args.successorNullifierKeyCommitment, "successorNullifierKeyCommitment"),
    toField(args.successorRuleSetCommitment, "successorRuleSetCommitment"),
    toField(args.successorAccountRevision, "successorAccountRevision"),
    toField(args.successorReceiveKeyHash, "successorReceiveKeyHash"),
  ]);
}
