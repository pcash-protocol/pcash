import { assetDefinitionFromCreated, createStandardFungibleAsset, type AssetDefinition } from "@pcash/sdk/protocol";

/** A real definition with a fresh token ID, for tests. */
export function testDefinition(name = "Harbor Credit", symbol = "HBR", decimals = 2, initialSupply = 100_000_000n): AssetDefinition {
  return assetDefinitionFromCreated(createStandardFungibleAsset({
    metadata: { name, symbol, decimals, contentDigest: new Uint8Array(32).fill(7) },
    initialSupply,
  }));
}
