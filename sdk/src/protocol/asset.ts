import type { FieldNumberish } from "../crypto/field.ts";
import { toField } from "../crypto/field.ts";
import {
  ASSET_CREATION_MARKER_DOMAIN,
  ASSET_ID_DOMAIN,
  ASSET_SECRET_COMMITMENT_DOMAIN,
} from "../constants/domainTags.ts";
import { poseidon, poseidonBytes } from "../crypto/poseidon2.ts";
import {
  REFERENCE_ASSET_CONFIGURATION_DOMAIN,
  REFERENCE_FUNGIBLE_METADATA_DOMAIN,
} from "../constants/referenceRuleConstants.ts";
import { AMOUNT_BITS, ASSET_AGGREGATE_BITS } from "../constants/params.ts";
import { randomFieldEntropy } from "../utils/bytes.ts";

const ASSET_AMOUNT_LIMIT = 1n << BigInt(AMOUNT_BITS);
const ASSET_AGGREGATE_LIMIT = 1n << BigInt(ASSET_AGGREGATE_BITS);
const MAX_INITIAL_ASSET_SUPPLY = 5n * (ASSET_AMOUNT_LIMIT - 1n);
/** The asset covenant's sub-tag under REFERENCE_ASSET_CONFIGURATION_DOMAIN; the shared asset claim uses 4 to 6. */
const ASSET_COVENANT_SUCCESSOR_TAG = 3n;

export interface StandardFungibleAssetDescriptor {
  assetId: FieldNumberish;
  metadataCommitment: FieldNumberish;
  initialSupply: FieldNumberish;
  assetSecretCommitment: FieldNumberish;
}

export interface FungibleMetadata {
  name: string;
  symbol: string;
  decimals: number;
  contentDigest: Uint8Array;
}

export interface CreatedStandardFungibleAsset {
  descriptor: StandardFungibleAssetDescriptor;
  assetSecret: bigint;
  metadata: FungibleMetadata;
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

export function assetSecretCommitment(assetSecret: FieldNumberish): bigint {
  return poseidon([
    ASSET_SECRET_COMMITMENT_DOMAIN,
    toField(assetSecret, "assetSecret"),
  ]);
}

export function standardFungibleAssetId(args: {
  metadataCommitment: FieldNumberish;
  initialSupply: FieldNumberish;
  assetSecretCommitment: FieldNumberish;
}): bigint {
  const initialSupply = bounded(args.initialSupply, ASSET_AGGREGATE_BITS, "initialSupply");
  if (initialSupply > MAX_INITIAL_ASSET_SUPPLY) {
    throw new Error("initialSupply exceeds five maximal asset outputs");
  }
  return poseidon([
    ASSET_ID_DOMAIN,
    toField(args.metadataCommitment, "metadataCommitment"),
    initialSupply,
    toField(args.assetSecretCommitment, "assetSecretCommitment"),
  ]);
}

export function verifyAssetDescriptor(descriptor: StandardFungibleAssetDescriptor): bigint {
  const assetId = standardFungibleAssetId(descriptor);
  if (toField(descriptor.assetId, "assetId") !== assetId) {
    throw new Error("asset descriptor does not match assetId");
  }
  return assetId;
}

/** Deterministic low-level construction for vectors, recovery, and reproducible derivation. */
export function deriveStandardFungibleAssetFromEntropy(args: {
  metadata: FungibleMetadata;
  initialSupply: FieldNumberish;
  assetSecret: FieldNumberish;
}): CreatedStandardFungibleAsset {
  const assetSecret = toField(args.assetSecret, "assetSecret");
  const metadata = {
    ...args.metadata,
    contentDigest: Uint8Array.from(args.metadata.contentDigest),
  };
  const fields = {
    metadataCommitment: fungibleMetadataCommitment(metadata),
    initialSupply: bounded(args.initialSupply, ASSET_AGGREGATE_BITS, "initialSupply"),
    assetSecretCommitment: assetSecretCommitment(assetSecret),
  };
  return {
    descriptor: { assetId: standardFungibleAssetId(fields), ...fields },
    assetSecret,
    metadata,
  };
}

/** Create fresh asset identity and one-shot creation authority with CSPRNG entropy. */
export function createStandardFungibleAsset(args: {
  metadata: FungibleMetadata;
  initialSupply: FieldNumberish;
}): CreatedStandardFungibleAsset {
  return deriveStandardFungibleAssetFromEntropy({
    assetSecret: randomFieldEntropy(),
    metadata: args.metadata,
    initialSupply: args.initialSupply,
  });
}

/** The asset's one-time creation marker. */
export function assetCreationMarker(assetId: FieldNumberish, assetSecret: FieldNumberish): bigint {
  return poseidon([
    ASSET_CREATION_MARKER_DOMAIN,
    toField(assetId, "assetId"),
    toField(assetSecret, "assetSecret"),
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
