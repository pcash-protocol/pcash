// Portable standard-asset definition: every value its assetId commits to
// except the asset secret. Wallets deliver it beside asset notes and share
// it as text so a holder can verify name, symbol, decimals, content digest, and
// fixed initial supply against the assetId alone. Non-consensus.
//
//   version (u8, = 1) || initialSupply (u136) || assetSecretCommitment (32) ||
//   nameLen (u8) || name || symbolLen (u8) || symbol || decimals (u8) ||
//   contentDigest (32)

import { toField } from "../crypto/field.ts";
import { beBytes, bytesToBigInt, concatBytes, field32, fromBase64Url, toBase64Url, utf8 } from "../utils/bytes.ts";
import {
  fungibleMetadataCommitment,
  standardFungibleAssetId,
  type CreatedStandardFungibleAsset,
  type FungibleMetadata,
} from "./asset.ts";

const ASSET_DEFINITION_VERSION = 1;
const INITIAL_SUPPLY_BYTES = 17;
/** Largest encoding: a 64-byte name and a 12-byte symbol. */
export const MAX_ASSET_DEFINITION_BYTES = 1 + INITIAL_SUPPLY_BYTES + 32 + 1 + 64 + 1 + 12 + 1 + 32;

export interface AssetDefinition {
  initialSupply: bigint;
  assetSecretCommitment: bigint;
  metadata: FungibleMetadata;
}

/** Derive the assetId, validating the metadata profile and supply bounds. */
export function assetDefinitionAssetId(definition: AssetDefinition): bigint {
  return standardFungibleAssetId({
    metadataCommitment: fungibleMetadataCommitment(definition.metadata),
    initialSupply: definition.initialSupply,
    assetSecretCommitment: definition.assetSecretCommitment,
  });
}

export function assetDefinitionFromCreated(created: CreatedStandardFungibleAsset): AssetDefinition {
  return {
    initialSupply: toField(created.descriptor.initialSupply, "initialSupply"),
    assetSecretCommitment: toField(created.descriptor.assetSecretCommitment, "assetSecretCommitment"),
    metadata: { ...created.metadata, contentDigest: Uint8Array.from(created.metadata.contentDigest) },
  };
}

export function encodeAssetDefinition(definition: AssetDefinition): Uint8Array {
  assetDefinitionAssetId(definition);
  const name = utf8(definition.metadata.name);
  const symbol = utf8(definition.metadata.symbol);
  return concatBytes(
    Uint8Array.of(ASSET_DEFINITION_VERSION),
    beBytes(definition.initialSupply, INITIAL_SUPPLY_BYTES),
    field32(definition.assetSecretCommitment),
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
  const version = take(1, "version")[0]!;
  if (version !== ASSET_DEFINITION_VERSION) throw new Error(`unknown asset definition version ${version}`);
  const initialSupply = bytesToBigInt(take(INITIAL_SUPPLY_BYTES, "initialSupply"));
  const assetSecretCommitment = toField(bytesToBigInt(take(32, "assetSecretCommitment")), "assetSecretCommitment");
  const name = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(take(take(1, "nameLen")[0]!, "name"));
  const symbol = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(take(take(1, "symbolLen")[0]!, "symbol"));
  const decimals = take(1, "decimals")[0]!;
  const contentDigest = Uint8Array.from(take(32, "contentDigest"));
  if (offset !== bytes.length) throw new Error("asset definition has trailing bytes");
  const definition = { initialSupply, assetSecretCommitment, metadata: { name, symbol, decimals, contentDigest } };
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
