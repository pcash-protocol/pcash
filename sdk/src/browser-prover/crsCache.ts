import type { ChonkCrs } from "../prover/chonk.ts";
import type { ProverProfile } from "../prover/profile.ts";
import {
  BN254_G2_CRS_KEY,
  bn254G1CrsKey,
  GRUMPKIN_G1_CRS_KEY,
  loadValidatedBytes,
  type BinaryCache,
} from "../prover/crs.ts";
import {
  requireArtifactDigest,
  resolveBrowserProverAssetUrl,
  type BrowserProverAssetSource,
} from "./artifacts.ts";

/** IndexedDB database of the browser prover's verified CRS files, keyed by release-pin key. */
export const BROWSER_CRS_DATABASE = "pcash-prover-crs";

const POINT_BYTES = 64;
const BN254_G2_BYTES = 128;
/** The pinned Grumpkin G1 file holds 2^16 points. */
export const GRUMPKIN_POINTS = 2 ** 16;

export type BrowserCrsCache = BinaryCache;

/**
 * Load the release-pinned CRS for `profile` from the cache or, failing that,
 * the node's asset source. Cached and fetched bytes must both match their pins,
 * so an entry written by an older or compromised deployment never bypasses
 * release pins.
 */
export async function loadPinnedCrs(
  profile: ProverProfile,
  digests: Readonly<Record<string, string>>,
  assetSource: BrowserProverAssetSource,
  cache: BrowserCrsCache,
  fetchBytes: (url: string, maxBytes: number) => Promise<Uint8Array>,
  onG1Fetch?: () => void,
): Promise<ChonkCrs> {
  const load = (key: string, maxBytes: number, onFetch?: () => void): Promise<Uint8Array> =>
    loadValidatedBytes(
      key,
      cache,
      async () => {
        onFetch?.();
        try {
          return await fetchBytes(resolveBrowserProverAssetUrl(assetSource, key), maxBytes);
        } catch (error) {
          throw new Error(`the configured node does not host the pinned browser proving parameter ${key}`, {
            cause: error,
          });
        }
      },
      (value) => requireArtifactDigest(key, value, digests),
    );
  return {
    bn254G1: await load(bn254G1CrsKey(profile.srsPoints), profile.srsPoints * POINT_BYTES, onG1Fetch),
    bn254G2: await load(BN254_G2_CRS_KEY, BN254_G2_BYTES),
    grumpkinG1: await load(GRUMPKIN_G1_CRS_KEY, GRUMPKIN_POINTS * POINT_BYTES),
  };
}
