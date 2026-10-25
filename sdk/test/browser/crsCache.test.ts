import assert from "node:assert/strict";
import { test } from "vitest";
import { sha256 } from "@noble/hashes/sha2.js";

import { GRUMPKIN_POINTS, loadPinnedCrs } from "../../src/browser-prover/crsCache.ts";
import type { SupportedSrsPoints } from "../../src/prover/profile.ts";
import { toHex } from "../../src/utils/hex.ts";

const ASSET_SOURCE = { assetSetId: "test-assets", baseUrl: "https://assets.example/proving/test-assets/" };
const SRS_POINTS: SupportedSrsPoints = 2 ** 18;
const G1_KEY = `/crs/${SRS_POINTS}/bn254_g1.dat`;
const G2_KEY = "/crs/bn254_g2.dat";
const GRUMPKIN_KEY = "/crs/grumpkin_g1_v2.flat.dat";
const PINNED = new Map<string, Uint8Array>([
  [G1_KEY, new Uint8Array(SRS_POINTS * 64).fill(1)],
  [G2_KEY, new Uint8Array(128).fill(2)],
  [GRUMPKIN_KEY, new Uint8Array(GRUMPKIN_POINTS * 64).fill(3)],
]);
const DIGESTS = Object.fromEntries([...PINNED].map(([key, bytes]) => [key, toHex(sha256(bytes)).slice(2)]));
const PROFILE = { srsPoints: SRS_POINTS, threads: 1, reuse: false };

function memoryCache(values = new Map<string, unknown>()) {
  return {
    values,
    read: async (key: string) => values.get(key),
    write: async (key: string, value: Uint8Array) => {
      values.set(key, value);
    },
    remove: async (key: string) => {
      values.delete(key);
    },
  };
}

function assetKey(url: string): string {
  return new URL(url).pathname.replace("/proving/test-assets", "");
}

test("poisoned cache entries are evicted and replaced with the pinned bytes", async () => {
  const cache = memoryCache(new Map<string, unknown>([
    [G1_KEY, new Uint8Array(SRS_POINTS * 64).fill(9)],
    [G2_KEY, "not bytes"],
    [GRUMPKIN_KEY, new Uint8Array(GRUMPKIN_POINTS * 64).fill(9)],
  ]));
  const requested: Array<[string, number]> = [];

  const crs = await loadPinnedCrs(PROFILE, DIGESTS, ASSET_SOURCE, cache, async (url, maxBytes) => {
    requested.push([assetKey(url), maxBytes]);
    return PINNED.get(assetKey(url))!;
  });

  // Each download is capped at the pinned file's size.
  assert.deepEqual(requested, [[G1_KEY, SRS_POINTS * 64], [G2_KEY, 128], [GRUMPKIN_KEY, GRUMPKIN_POINTS * 64]]);
  assert.deepEqual(crs, { bn254G1: PINNED.get(G1_KEY), bn254G2: PINNED.get(G2_KEY), grumpkinG1: PINNED.get(GRUMPKIN_KEY) });
  assert.deepEqual(cache.values, PINNED);
});

test("verified cache entries are reused without a download", async () => {
  const cache = memoryCache(new Map(PINNED));
  const crs = await loadPinnedCrs(PROFILE, DIGESTS, ASSET_SOURCE, cache, async () => {
    throw new Error("unexpected download");
  });
  assert.equal(crs.bn254G1, PINNED.get(G1_KEY));
  assert.equal(crs.bn254G2, PINNED.get(G2_KEY));
  assert.equal(crs.grumpkinG1, PINNED.get(GRUMPKIN_KEY));
});

test("a missing CRS file fails closed", async () => {
  const cache = memoryCache();
  await assert.rejects(
    loadPinnedCrs(PROFILE, DIGESTS, ASSET_SOURCE, cache, async () => {
      throw new Error("HTTP 404");
    }),
    { message: `the configured node does not host the pinned browser proving parameter ${G1_KEY}` },
  );
  assert.equal(cache.values.size, 0);
});

test("a CRS file that differs from its pin fails closed and is not cached", async () => {
  const cache = memoryCache();
  await assert.rejects(
    loadPinnedCrs(PROFILE, DIGESTS, ASSET_SOURCE, cache, async (url) =>
      assetKey(url) === GRUMPKIN_KEY ? new Uint8Array(GRUMPKIN_POINTS * 64).fill(4) : PINNED.get(assetKey(url))!),
    { message: `prover artifact ${GRUMPKIN_KEY} failed its pinned digest` },
  );
  assert.equal(cache.values.has(GRUMPKIN_KEY), false);
});
