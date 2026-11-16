import {
  assetDefinitionAssetId,
  encodeAssetDefinition,
  assetSecretCommitment,
  type AssetDefinition,
} from "@pcash/sdk/protocol";

export function testToken(seed = 1n): { definition: AssetDefinition; bytes: Uint8Array; assetId: bigint } {
  const definition: AssetDefinition = {
    initialSupply: 1_000_000_000n,
    assetSecretCommitment: assetSecretCommitment(0x2000n + seed),
    metadata: { name: "Test Token", symbol: "TT", decimals: 6, contentDigest: new Uint8Array(32).fill(Number(seed)) },
  };
  return { definition, bytes: encodeAssetDefinition(definition), assetId: assetDefinitionAssetId(definition) };
}
