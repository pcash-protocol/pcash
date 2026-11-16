import { publicationAssetDefinition, type OfferPublication } from "@pcash/marketplace/app";
import { formatAssetDefinition, type AssetDefinition } from "@pcash/sdk/protocol";
import { PCASH_UNIT } from "../../components/pcashAmount.ts";
import type { AmountUnit } from "../../components/tokenAmount.ts";
import { tokenPath, tokenUnit } from "../tokens/model.ts";

/** What a listing sells: native PCASH, a token whose definition derives its assetId, or neither. */
export type ListingAsset =
  | { kind: "pcash"; assetId: 0n; unit: AmountUnit; label: string }
  | { kind: "token"; assetId: bigint; definition: AssetDefinition; unit: AmountUnit; label: string; href: string }
  | { kind: "unverified"; assetId: bigint };

type ListingAssetSource = Pick<OfferPublication, "terms" | "assetDefinition">;

const PCASH_ASSET: ListingAsset = { kind: "pcash", assetId: 0n, unit: PCASH_UNIT, label: "PCASH" };
const resolved = new WeakMap<object, ListingAsset>();

/**
 * A token listing's definition bytes come from the seller. Its name, symbol and
 * decimals are shown only when the bytes derive the listed assetId.
 */
export function listingAsset(publication: ListingAssetSource): ListingAsset {
  const cached = resolved.get(publication);
  if (cached !== undefined) return cached;
  let asset: ListingAsset;
  if (BigInt(publication.terms.assetId) === 0n && publication.assetDefinition === undefined) asset = PCASH_ASSET;
  else {
    const assetId = BigInt(publication.terms.assetId);
    try {
      const definition = publicationAssetDefinition(publication);
      asset = definition === null ? PCASH_ASSET : {
        kind: "token", assetId, definition, unit: tokenUnit(definition), label: definition.metadata.symbol,
        href: `${tokenPath(assetId)}#d=${formatAssetDefinition(definition)}`,
      };
    } catch {
      asset = { kind: "unverified", assetId };
    }
  }
  resolved.set(publication, asset);
  return asset;
}

/** The name a listing's amounts are counted in. */
export function listingAssetLabel(publication: ListingAssetSource): string {
  const asset = listingAsset(publication);
  return asset.kind === "unverified" ? "unverified token" : asset.label;
}

/** Amounts of an unverifiable listing are raw base units. */
export function listingUnit(publication: ListingAssetSource): AmountUnit {
  const asset = listingAsset(publication);
  return asset.kind === "unverified" ? { decimals: 0, symbol: "units" } : asset.unit;
}

export function isNativeListing(publication: ListingAssetSource): boolean {
  return listingAsset(publication).kind === "pcash";
}
