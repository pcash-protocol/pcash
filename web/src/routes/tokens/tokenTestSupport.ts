import type { AssetDefinition } from "@pcash/sdk/protocol";
import { createFixedSupplyAsset } from "@pcash/sdk/rules";

/** A real definition with a fresh token ID, for tests. */
export function testDefinition(name = "Harbor Credit", symbol = "HBR", decimals = 2, supply = 100_000_000n): AssetDefinition {
  return createFixedSupplyAsset({
    metadata: { name, symbol, decimals, contentDigest: new Uint8Array(32).fill(7) },
    supply,
  }).definition;
}
