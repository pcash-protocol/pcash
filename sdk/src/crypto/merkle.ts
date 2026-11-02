// Merkle tree rules:
// internal node = poseidon(left, right); empty leaf = 0;
// EMPTY[0]=0, EMPTY[h+1]=poseidon(EMPTY[h],EMPTY[h]); LSB-first sibling paths.

import { type FieldNumberish, toField } from "./field.ts";
import { poseidon, poseidon2 } from "./poseidon2.ts";

const emptyLadderCache = new Map<number, readonly bigint[]>();

/** EMPTY[0..depth] ladder (length depth+1). EMPTY[0]=0. */
export function emptyLadder(depth: number): readonly bigint[] {
  if (!Number.isInteger(depth) || depth < 0) throw new Error("depth must be a nonnegative integer");
  const cached = emptyLadderCache.get(depth);
  if (cached) return cached;
  const ladder: bigint[] = [0n];
  for (let h = 0; h < depth; h++) ladder.push(poseidon2(ladder[h]!, ladder[h]!));
  emptyLadderCache.set(depth, ladder);
  return ladder;
}

/** Empty root of a depth-`depth` tree = EMPTY[depth]. */
export function emptyRoot(depth: number): bigint {
  return emptyLadder(depth)[depth]!;
}

/**
 * Recompute the root from a membership proof. `siblings`
 * runs leaf-level upward (siblings[0] is the leaf's immediate sibling). The key
 * `index` selects sides LSB-first: bit 0 => current node is the LEFT child.
 */
export function rootFromIndex(
  leaf: FieldNumberish,
  index: FieldNumberish,
  siblings: readonly FieldNumberish[],
): bigint {
  let cur = toField(leaf, "leaf");
  let idx = toField(index, "index");
  const depth = siblings.length;
  if (idx >= 1n << BigInt(depth)) throw new Error("index out of range for path length");
  for (let h = 0; h < depth; h++) {
    const sibling = toField(siblings[h]!, "sibling");
    cur = (idx & 1n) === 0n ? poseidon2(cur, sibling) : poseidon2(sibling, cur);
    idx >>= 1n;
  }
  return cur;
}

/** Recompute a typed commitment-tree root whose domain is absorbed at every internal node. */
export function domainSeparatedRootFromIndex(
  domain: FieldNumberish,
  leaf: FieldNumberish,
  index: FieldNumberish,
  siblings: readonly FieldNumberish[],
): bigint {
  const typedDomain = toField(domain, "domain");
  let cur = toField(leaf, "leaf");
  let idx = toField(index, "index");
  const depth = siblings.length;
  if (idx >= 1n << BigInt(depth)) throw new Error("index out of range for path length");
  for (let h = 0; h < depth; h++) {
    const sibling = toField(siblings[h]!, "sibling");
    cur = (idx & 1n) === 0n
      ? poseidon([typedDomain, cur, sibling])
      : poseidon([typedDomain, sibling, cur]);
    idx >>= 1n;
  }
  return cur;
}

/** Verify a membership proof against a spent root. */
export function verify(
  root: FieldNumberish,
  leaf: FieldNumberish,
  index: FieldNumberish,
  siblings: readonly FieldNumberish[],
): boolean {
  return rootFromIndex(leaf, index, siblings) === toField(root, "root");
}
