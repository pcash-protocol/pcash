/** Release-pin keys of the CRS files (`PROVER_ARTIFACT_SHA256`), also their browser asset paths. */
export const bn254G1CrsKey = (points: number): string => `/crs/${points}/bn254_g1.dat`;
export const BN254_G2_CRS_KEY = "/crs/bn254_g2.dat";
export const GRUMPKIN_G1_CRS_KEY = "/crs/grumpkin_g1_v2.flat.dat";

export interface BinaryCache {
  read(key: string): Promise<unknown>;
  write(key: string, value: Uint8Array): Promise<void>;
  remove(key: string): Promise<void>;
}

/** Reuse only validated bytes; evict and refetch every malformed cache entry. */
export async function loadValidatedBytes(
  key: string,
  cache: BinaryCache,
  fetchValue: () => Promise<Uint8Array>,
  validate: (value: Uint8Array) => void,
): Promise<Uint8Array> {
  const cached = await cache.read(key).catch(() => undefined);
  if (cached instanceof Uint8Array) {
    try {
      validate(cached);
      return cached;
    } catch {
      await cache.remove(key);
    }
  } else if (cached !== undefined) {
    await cache.remove(key);
  }

  const fetched = await fetchValue();
  validate(fetched);
  await cache.write(key, fetched);
  return fetched;
}
