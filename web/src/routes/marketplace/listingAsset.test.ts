import { describe, expect, it } from "vitest";
import type { OfferPublication } from "@pcash/marketplace/app";
import { assetDefinitionAssetId, encodeAssetDefinition, formatAssetDefinition } from "@pcash/sdk/protocol";
import { toHex } from "@pcash/sdk/utils";
import { tokenPath } from "../tokens/model.ts";
import { testDefinition } from "../tokens/tokenTestSupport.ts";
import { isNativeListing, listingAsset, listingAssetLabel, listingUnit } from "./listingAsset.ts";

const listing = (assetId: bigint, assetDefinition?: Uint8Array) => ({
  terms: { assetId: assetId.toString(), amount: "250" },
  ...(assetDefinition === undefined ? {} : { assetDefinition: toHex(assetDefinition) }),
}) as unknown as OfferPublication;

describe("listing assets", () => {
  const definition = testDefinition("Harbor Credit", "HBR", 2);
  const assetId = assetDefinitionAssetId(definition);

  it("reads native PCASH listings as PCASH", () => {
    const native = listing(0n);
    expect(listingAsset(native).kind).toBe("pcash");
    expect(isNativeListing(native)).toBe(true);
    expect(listingUnit(native)).toEqual({ decimals: 18, symbol: "PCASH", whole: true });
  });

  it("trusts a token definition only when it derives the listed token ID", () => {
    const asset = listingAsset(listing(assetId, encodeAssetDefinition(definition)));
    expect(asset).toMatchObject({ kind: "token", assetId, label: "HBR", unit: { decimals: 2, symbol: "HBR" },
      href: `${tokenPath(assetId)}#d=${formatAssetDefinition(definition)}` });
    const forged = listing(assetId, encodeAssetDefinition(testDefinition("Harbor Credit", "HBR", 2)));
    expect(listingAsset(forged)).toEqual({ kind: "unverified", assetId });
    expect(listingAssetLabel(forged)).toBe("unverified token");
    expect(listingUnit(forged)).toEqual({ decimals: 0, symbol: "units" });
    expect(listingAsset(listing(assetId)).kind).toBe("unverified");
    expect(listingAsset(listing(0n, encodeAssetDefinition(definition))).kind).toBe("unverified");
  });
});
