import { assetDefinitionAssetId, encodeAssetDefinition, type AssetDefinition } from "@pcash/sdk/protocol";
import { deriveFixedSupplyAsset } from "@pcash/sdk/rules";

export function testToken(seed = 1n): { definition: AssetDefinition; bytes: Uint8Array; assetId: bigint } {
  const metadata = { name: "Test Token", symbol: "TT", decimals: 6, contentDigest: new Uint8Array(32).fill(Number(seed)) };
  const { definition } = deriveFixedSupplyAsset({ metadata, supply: 1_000_000_000n, secret: 0x2000n + seed, instanceSalt: 0n });
  return { definition, bytes: encodeAssetDefinition(definition), assetId: assetDefinitionAssetId(definition) };
}
