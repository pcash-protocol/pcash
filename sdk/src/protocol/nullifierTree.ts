// The spent-nullifier set: an append-only, depth-41 indexed Poseidon tree.
// Leaf 0 is the sentinel and leaf `i > 0` holds the `i`-th nullifier inserted.
// Every allocated leaf hashes its value with the smallest larger value in the
// set and that value's leaf index, both 0 at the end of the list; an
// unallocated slot is 0. Internal nodes are ordinary Poseidon Merkle nodes.

import { NULLIFIER_LEAF_DOMAIN } from "../constants/domainTags.ts";
import { BN254_SCALAR_MODULUS } from "../crypto/field.ts";
import { rootFromIndex } from "../crypto/merkle.ts";
import { poseidon } from "../crypto/poseidon2.ts";
import { fromHexSized } from "../utils/hex.ts";

export const NULLIFIER_TREE_DEPTH = 41;

/** The preimage of one allocated leaf. The sentinel is all zero. */
export interface NullifierLeaf {
  value: bigint;
  nextValue: bigint;
  nextIndex: bigint;
}

/** The leaf holding `nullifier`, or its low leaf, opened at `leafIndex`. */
export interface NullifierProof {
  nullifier: bigint;
  leaf: NullifierLeaf;
  leafIndex: bigint;
  siblings: readonly bigint[];
}

export function parseCanonicalNullifier(value: string | Uint8Array): Uint8Array {
  let bytes: Uint8Array;
  if (typeof value === "string") {
    bytes = fromHexSized(value, 32, "nullifier");
  } else {
    if (value.length !== 32) throw new Error("nullifier must be 32 bytes");
    bytes = Uint8Array.from(value);
  }
  let integer = 0n;
  for (const byte of bytes) integer = (integer << 8n) | BigInt(byte);
  if (integer === 0n || integer >= BN254_SCALAR_MODULUS) {
    throw new Error("nullifier must be a nonzero canonical BN254 encoding");
  }
  return bytes;
}

export function nullifierLeafHash(leaf: NullifierLeaf): bigint {
  return poseidon([NULLIFIER_LEAF_DOMAIN, leaf.value, leaf.nextValue, leaf.nextIndex]);
}

/**
 * Whether `value` lies in the gap after `leaf`: above its value, and below its
 * next value unless the leaf ends the list.
 */
export function isLowNullifierLeaf(leaf: NullifierLeaf, value: bigint): boolean {
  return leaf.value < value && (value < leaf.nextValue || (leaf.nextValue === 0n && leaf.nextIndex === 0n));
}

/** The nullifier root the proof's leaf and path open under. */
export function nullifierProofRoot(proof: NullifierProof): bigint {
  if (proof.siblings.length !== NULLIFIER_TREE_DEPTH) {
    throw new Error(`nullifier path must have depth ${NULLIFIER_TREE_DEPTH}`);
  }
  return rootFromIndex(nullifierLeafHash(proof.leaf), proof.leafIndex, proof.siblings);
}

/**
 * True when the leaf holds the nullifier, false when it is the nullifier's low
 * leaf, and null when it neither holds nor brackets it. Only meaningful once
 * `nullifierProofRoot(proof)` equals the committed root.
 */
export function nullifierProofSpent(proof: NullifierProof): boolean | null {
  if (proof.leaf.value === proof.nullifier) return true;
  return isLowNullifierLeaf(proof.leaf, proof.nullifier) ? false : null;
}
