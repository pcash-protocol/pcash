// In-memory sparse Merkle tree. Empty leaves are 0;
// EMPTY[h+1] = poseidon(EMPTY[h], EMPTY[h]); internal node = poseidon(l, r);
// LSB-first sibling paths. Used by the witness builders to append note and
// account leaves and produce membership openings whose root the circuits
// recompute.

import { type FieldNumberish, toField } from "./field.ts";
import { emptyLadder } from "./merkle.ts";
import { poseidon2 } from "./poseidon2.ts";

export interface MembershipProof {
  leafIndex: number;
  siblings: bigint[]; // length = depth, leaf-level upward
  root: bigint;
}

/**
 * A depth-`depth` binary Merkle tree backed by a map of explicitly-set nodes;
 * any node not present defaults to the empty-subtree root at that height.
 */
export class SparseMerkleTree {
  readonly depth: number;
  private readonly ladder: readonly bigint[];
  // nodes[level] maps index -> value for non-empty nodes. level 0 = leaves.
  private readonly nodes: Array<Map<bigint, bigint>>;

  constructor(depth: number) {
    if (!Number.isInteger(depth) || depth <= 0) throw new Error("depth must be a positive integer");
    this.depth = depth;
    this.ladder = emptyLadder(depth);
    this.nodes = Array.from({ length: depth + 1 }, () => new Map<bigint, bigint>());
  }

  private nodeAt(level: number, index: bigint): bigint {
    const v = this.nodes[level]!.get(index);
    return v === undefined ? this.ladder[level]! : v;
  }

  /** Set the leaf at `index` and recompute the path to the root. */
  setLeaf(index: FieldNumberish, value: FieldNumberish): void {
    let idx = toField(index, "leaf index");
    if (idx >= 1n << BigInt(this.depth)) throw new Error("leaf index out of range");
    const leafIdx = idx;
    this.nodes[0]!.set(leafIdx, toField(value, "leaf value"));
    let cur = leafIdx;
    for (let level = 0; level < this.depth; level++) {
      const left = (cur & ~1n) as bigint;
      const right = left + 1n;
      const parent = this.poseidonNode(level, left, right);
      cur >>= 1n;
      this.nodes[level + 1]!.set(cur, parent);
    }
  }

  private poseidonNode(level: number, left: bigint, right: bigint): bigint {
    return poseidon2(this.nodeAt(level, left), this.nodeAt(level, right));
  }

  get root(): bigint {
    return this.nodeAt(this.depth, 0n);
  }

  /** Membership opening for the leaf at `index`. */
  proof(index: FieldNumberish): MembershipProof {
    let idx = toField(index, "leaf index");
    if (idx >= 1n << BigInt(this.depth)) throw new Error("leaf index out of range");
    const siblings: bigint[] = [];
    let cur = idx;
    for (let level = 0; level < this.depth; level++) {
      const sibIndex = (cur & 1n) === 0n ? cur + 1n : cur - 1n;
      siblings.push(this.nodeAt(level, sibIndex));
      cur >>= 1n;
    }
    return { leafIndex: Number(idx), siblings, root: this.root };
  }
}

/**
 * Append a single leaf into an otherwise-empty depth-`depth` tree and return the
 * opening. Convenience for the common builder case (one relevant leaf).
 */
export function singleLeafProof(
  depth: number,
  leafIndex: FieldNumberish,
  value: FieldNumberish,
): MembershipProof {
  const tree = new SparseMerkleTree(depth);
  tree.setLeaf(leafIndex, value);
  return tree.proof(leafIndex);
}
