import type { AssetProver, Prover } from "@pcash/sdk/browser-prover";
import type { PcashNodeClient } from "@pcash/sdk/clients";
import { MARKETPLACE_CIRCUIT_PROFILES } from "../circuits.ts";

/** Load the heavy browser proving adapter only when an application action needs it. */
export async function defaultMarketplaceProver(node: PcashNodeClient): Promise<Prover & AssetProver> {
  const [{ createBrowserProver, resolveBrowserProverAssetSource }, status] = await Promise.all([
    import("@pcash/sdk/browser-prover"),
    node.status(),
  ]);
  const source = resolveBrowserProverAssetSource(node.rpcUrl, status.proverAssets);
  return createBrowserProver(source, MARKETPLACE_CIRCUIT_PROFILES);
}
