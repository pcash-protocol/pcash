// Portable asset definition: every value an assetId commits to, with the
// metadata in full and the openings of its rules' configurations. Wallets
// deliver it beside asset notes and share it as text, so a holder can verify
// name, symbol, decimals, content digest, mint rule and transfer rule against
// the assetId alone, and can prove a restricted asset's transfers.
// Non-consensus.
//
//   version (u8, = 1) || instanceSalt (32) || mintRule || transferRule ||
//   nameLen (u8) || name || symbolLen (u8) || symbol || decimals (u8) ||
//   contentDigest (32)
//
//   mintRule     = rule
//   transferRule = 0 (u8)
//                | 1 (u8) || rule
//   rule         = sVkHash (32) || lVkHash (32) || configurationCommitment (32) ||
//                  configurationLen (u8) || configuration
//
// `configuration` is the rule's own opening of its configuration commitment,
// which a wallet interprets only for a rule it recognizes.

import { BN254_SCALAR_MODULUS, toField, type FieldNumberish } from "../crypto/field.ts";
import { bytesToBigInt, concatBytes, field32, fromBase64Url, randomFieldEntropy, toBase64Url, utf8 } from "../utils/bytes.ts";
import {
  deriveAssetDescriptor,
  fungibleMetadataCommitment,
  type AssetDescriptor,
  type AssetRule,
  type FungibleMetadata,
} from "./asset.ts";

const ASSET_DEFINITION_VERSION = 1;
const RULE_HASHES_BYTES = 96;
/** The longest configuration opening a definition carries for either rule. */
export const MAX_RULE_CONFIGURATION_BYTES = 64;
const MAX_RULE_BYTES = RULE_HASHES_BYTES + 1 + MAX_RULE_CONFIGURATION_BYTES;
/** Largest encoding: both rules with the longest configuration, a 64-byte name and a 12-byte symbol. */
export const MAX_ASSET_DEFINITION_BYTES = 1 + 32 + MAX_RULE_BYTES + 1 + MAX_RULE_BYTES + 1 + 64 + 1 + 12 + 1 + 32;

/** A rule together with the opening of its configuration. */
export interface PortableAssetRule extends AssetRule {
  configuration: Uint8Array;
}

export type PortableMintRule = PortableAssetRule;
export type PortableTransferRule = PortableAssetRule;

export interface AssetDefinition {
  instanceSalt: bigint;
  mintRule: PortableMintRule;
  transferRule?: PortableTransferRule | undefined;
  metadata: FungibleMetadata;
}

function ruleHashes(rule: PortableAssetRule): AssetRule {
  return { sVkHash: rule.sVkHash, lVkHash: rule.lVkHash, configurationCommitment: rule.configurationCommitment };
}

function checkedConfiguration(rule: PortableAssetRule, name: string): void {
  if (rule.configuration.length > MAX_RULE_CONFIGURATION_BYTES) {
    throw new Error(`${name} rule configuration exceeds ${MAX_RULE_CONFIGURATION_BYTES} bytes`);
  }
}

/** The descriptor a definition commits to, validating the metadata, the rule configuration lengths and the asset class. */
export function assetDefinitionDescriptor(definition: AssetDefinition): AssetDescriptor {
  checkedConfiguration(definition.mintRule, "mint");
  const rule = definition.transferRule;
  if (rule !== undefined) checkedConfiguration(rule, "transfer");
  return deriveAssetDescriptor({
    instanceSalt: definition.instanceSalt,
    metadataCommitment: fungibleMetadataCommitment(definition.metadata),
    mintRule: ruleHashes(definition.mintRule),
    ...(rule === undefined ? {} : { transferRule: ruleHashes(rule) }),
  });
}

/** Derive the assetId, validating the metadata, the rule configuration lengths and the asset class. */
export function assetDefinitionAssetId(definition: AssetDefinition): bigint {
  return assetDefinitionDescriptor(definition).assetId;
}

function copiedRule(rule: PortableAssetRule): PortableAssetRule {
  return { ...ruleHashes(rule), configuration: Uint8Array.from(rule.configuration) };
}

/**
 * Search instance salts from `startSalt` (CSPRNG entropy by default) until the
 * definition's asset ID lands in the class its transfer rule implies. Each class
 * holds about a third of the field, so about three tries.
 */
export function findAssetDefinition(
  fields: Omit<AssetDefinition, "instanceSalt">,
  startSalt: FieldNumberish = randomFieldEntropy(),
): AssetDefinition {
  const base = {
    mintRule: copiedRule(fields.mintRule),
    ...(fields.transferRule === undefined ? {} : { transferRule: copiedRule(fields.transferRule) }),
    metadata: { ...fields.metadata, contentDigest: Uint8Array.from(fields.metadata.contentDigest) },
  };
  let instanceSalt = toField(startSalt, "startSalt");
  for (let attempt = 0; attempt < 512; attempt += 1) {
    const definition = { instanceSalt, ...base };
    try {
      assetDefinitionDescriptor(definition);
      return definition;
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith("instance salt")) throw error;
    }
    instanceSalt = (instanceSalt + 1n) % BN254_SCALAR_MODULUS;
  }
  throw new Error("no instance salt found");
}

/** The portable definition of a descriptor, given its metadata and the openings of its rules' configurations. */
export function assetDefinitionOf(
  descriptor: AssetDescriptor,
  metadata: FungibleMetadata,
  configurations: { mintRule: Uint8Array; transferRule?: Uint8Array },
): AssetDefinition {
  if ((descriptor.transferRule === undefined) !== (configurations.transferRule === undefined)) {
    throw new Error("a restricted asset's definition needs its transfer rule configuration, and only then");
  }
  const definition: AssetDefinition = {
    instanceSalt: descriptor.instanceSalt,
    mintRule: { ...descriptor.mintRule, configuration: Uint8Array.from(configurations.mintRule) },
    metadata: { ...metadata, contentDigest: Uint8Array.from(metadata.contentDigest) },
    ...(descriptor.transferRule === undefined ? {} : {
      transferRule: { ...descriptor.transferRule, configuration: Uint8Array.from(configurations.transferRule!) },
    }),
  };
  if (assetDefinitionAssetId(definition) !== descriptor.assetId) {
    throw new Error("metadata does not match the descriptor's metadata commitment");
  }
  return definition;
}

function encodeRule(rule: PortableAssetRule): Uint8Array {
  return concatBytes(
    field32(rule.sVkHash),
    field32(rule.lVkHash),
    field32(rule.configurationCommitment),
    Uint8Array.of(rule.configuration.length),
    rule.configuration,
  );
}

export function encodeAssetDefinition(definition: AssetDefinition): Uint8Array {
  assetDefinitionAssetId(definition);
  const name = utf8(definition.metadata.name);
  const symbol = utf8(definition.metadata.symbol);
  return concatBytes(
    Uint8Array.of(ASSET_DEFINITION_VERSION),
    field32(definition.instanceSalt),
    encodeRule(definition.mintRule),
    definition.transferRule === undefined ? Uint8Array.of(0) : concatBytes(Uint8Array.of(1), encodeRule(definition.transferRule)),
    Uint8Array.of(name.length),
    name,
    Uint8Array.of(symbol.length),
    symbol,
    Uint8Array.of(definition.metadata.decimals),
    definition.metadata.contentDigest,
  );
}

/** Strict canonical parse of untrusted bytes; throws on any deviation. */
export function decodeAssetDefinition(bytes: Uint8Array): AssetDefinition {
  let offset = 0;
  const take = (length: number, label: string): Uint8Array => {
    if (offset + length > bytes.length) throw new Error(`asset definition is truncated at ${label}`);
    const value = bytes.subarray(offset, offset + length);
    offset += length;
    return value;
  };
  const byte = (label: string): number => take(1, label)[0]!;
  const field = (label: string): bigint => toField(bytesToBigInt(take(32, label)), label);
  const rule = (name: string): PortableAssetRule => {
    const sVkHash = field(`${name} sVkHash`);
    const lVkHash = field(`${name} lVkHash`);
    const configurationCommitment = field(`${name} configurationCommitment`);
    const configuration = Uint8Array.from(take(byte(`${name} configurationLen`), `${name} configuration`));
    return { sVkHash, lVkHash, configurationCommitment, configuration };
  };
  const version = byte("version");
  if (version !== ASSET_DEFINITION_VERSION) throw new Error(`unknown asset definition version ${version}`);
  const instanceSalt = field("instanceSalt");
  const mintRule = rule("mint rule");
  const ruleTag = byte("transferRule");
  let transferRule: PortableTransferRule | undefined;
  if (ruleTag === 1) {
    transferRule = rule("transfer rule");
  } else if (ruleTag !== 0) {
    throw new Error(`unknown transfer rule tag ${ruleTag}`);
  }
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const name = decoder.decode(take(byte("nameLen"), "name"));
  const symbol = decoder.decode(take(byte("symbolLen"), "symbol"));
  const decimals = byte("decimals");
  const contentDigest = Uint8Array.from(take(32, "contentDigest"));
  if (offset !== bytes.length) throw new Error("asset definition has trailing bytes");
  const definition: AssetDefinition = {
    instanceSalt,
    mintRule,
    ...(transferRule === undefined ? {} : { transferRule }),
    metadata: { name, symbol, decimals, contentDigest },
  };
  assetDefinitionAssetId(definition);
  return definition;
}

/** Share text: base64url of the encoded definition. */
export function formatAssetDefinition(definition: AssetDefinition): string {
  return toBase64Url(encodeAssetDefinition(definition));
}

/** Parse share text, or a share URL whose fragment carries `d=<base64url>`. */
export function parseAssetDefinition(text: string): AssetDefinition {
  const trimmed = text.trim();
  const fragment = trimmed.indexOf("#");
  if (fragment < 0) return decodeAssetDefinition(fromBase64Url(trimmed));
  const encoded = new URLSearchParams(trimmed.slice(fragment + 1)).get("d");
  if (encoded === null) throw new Error("asset definition link has no d= fragment parameter");
  return decodeAssetDefinition(fromBase64Url(encoded));
}
