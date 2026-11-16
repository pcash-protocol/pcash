// PCASH delivery hashing: the output-data items and the arena a private-value
// section posts, bound into its private value by one delivery commitment.

import { randomBytes } from "@noble/hashes/utils.js";
import { ARENA_HASH_DOMAIN, DELIVERY_COMMITMENT_DOMAIN, OUTPUT_DATA_HASH_DOMAIN } from "../constants/domainTags.ts";
import { privateValueProfile, type PrivateValueShape } from "../constants/privateValueProfiles.ts";
import { poseidon, poseidonBytes } from "../crypto/poseidon2.ts";

/** The canonical outputDataHash: the byte hash of the exact posted output-data item. */
export function outputDataHash(outputData: Uint8Array): bigint {
  return poseidonBytes(OUTPUT_DATA_HASH_DOMAIN, outputData);
}

/** The byte hash of the exact posted arena. */
export function arenaHash(arena: Uint8Array): bigint {
  return poseidonBytes(ARENA_HASH_DOMAIN, arena);
}

/** One hash over every output's data hash, in slot order, and the arena hash. */
export function deliveryCommitmentFromHashes(outputDataHashes: readonly bigint[], arenaHashValue: bigint): bigint {
  return poseidon([DELIVERY_COMMITMENT_DOMAIN, ...outputDataHashes, arenaHashValue]);
}

/** The delivery commitment of a section's posted output data and arena. */
export function deliveryCommitment(outputData: readonly Uint8Array[], arena: Uint8Array): bigint {
  return deliveryCommitmentFromHashes(outputData.map(outputDataHash), arenaHash(arena));
}

/** An arena with no regions: a fresh salt and random cells, all uniformly random bytes. */
export function randomArena(shape: PrivateValueShape): Uint8Array {
  return randomBytes(privateValueProfile(shape).arenaBytes);
}

/** Reject an arena whose length is not the profile's: the wire carries no length prefix. */
export function assertArena(arena: Uint8Array, shape: PrivateValueShape): void {
  const { arenaBytes } = privateValueProfile(shape);
  if (arena.length !== arenaBytes) throw new Error(`arena must have exactly ${arenaBytes} bytes`);
}
