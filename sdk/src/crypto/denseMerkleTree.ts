// Index-keyed Merkle tree over leaves 0..size-1, for trees whose leaves are
// rewritten in place (the account tree). Same hashing and orientation as
// ./merkle.ts. Internal nodes are built bottom-up on the first root() or
// path() and afterwards rehashed only along the paths of changed leaves.

import { emptyLadder } from "./merkle.ts";
import { poseidon2 } from "./poseidon2.ts";

export class DenseMerkleTree {
  readonly depth: number;
  private readonly ladder: readonly bigint[];
  private readonly leaves: bigint[];
  // levels[h] holds the nodes at height h over the occupied prefix; levels[0] is `leaves`.
  // Null until first built.
  private levels: bigint[][] | null = null;
  // Leaf indexes changed since the levels were last brought up to date.
  private readonly dirty = new Set<number>();

  constructor(depth: number, leaves: readonly bigint[] = []) {
    if (!Number.isInteger(depth) || depth <= 0) throw new Error("depth must be a positive integer");
    this.depth = depth;
    this.ladder = emptyLadder(depth);
    this.leaves = [...leaves];
  }

  get size(): number {
    return this.leaves.length;
  }

  get(index: number): bigint {
    this.checkIndex(index);
    return this.leaves[index]!;
  }

  /** Overwrite the leaf at `index` < size, or append at `index` == size. */
  set(index: number, leaf: bigint): void {
    if (index < 0 || index > this.leaves.length) throw new Error("leaf index out of range");
    this.leaves[index] = leaf;
    if (this.levels !== null) this.dirty.add(index);
  }

  /** Drop the leaves at index >= size. */
  truncate(size: number): void {
    if (size < 0 || size > this.leaves.length) throw new Error("size out of range");
    this.leaves.length = size;
    if (this.levels === null) return;
    for (const index of this.dirty) if (index >= size) this.dirty.delete(index);
    let width = size;
    for (let h = 1; h <= this.depth; h++) {
      width = Math.ceil(width / 2);
      this.levels[h]!.length = width;
    }
    // The ancestors of the new last leaf lost their right-hand descendants.
    if (size > 0) this.dirty.add(size - 1);
  }

  root(): bigint {
    return this.build()[this.depth]![0] ?? this.ladder[this.depth]!;
  }

  /** Siblings of the leaf at `index`, leaf-level upward. */
  path(index: number): bigint[] {
    this.checkIndex(index);
    const levels = this.build();
    const siblings: bigint[] = [];
    let position = index;
    for (let h = 0; h < this.depth; h++) {
      siblings.push(levels[h]![position % 2 === 0 ? position + 1 : position - 1] ?? this.ladder[h]!);
      position = Math.floor(position / 2);
    }
    return siblings;
  }

  private checkIndex(index: number): void {
    if (index < 0 || index >= this.leaves.length) throw new Error("leaf index out of range");
  }

  private build(): bigint[][] {
    if (this.levels === null) {
      const levels = [this.leaves];
      for (let h = 0; h < this.depth; h++) {
        const below = levels[h]!;
        const level: bigint[] = [];
        for (let i = 0; i < below.length; i += 2) level.push(poseidon2(below[i]!, below[i + 1] ?? this.ladder[h]!));
        levels.push(level);
      }
      this.levels = levels;
      this.dirty.clear();
      return levels;
    }
    if (this.dirty.size > 0) {
      let positions = [...this.dirty].sort((a, b) => a - b);
      for (let h = 0; h < this.depth; h++) {
        const below = this.levels[h]!;
        const level = this.levels[h + 1]!;
        const parents: number[] = [];
        for (const position of positions) {
          const parent = Math.floor(position / 2);
          if (parents[parents.length - 1] === parent) continue;
          parents.push(parent);
          level[parent] = poseidon2(below[2 * parent]!, below[2 * parent + 1] ?? this.ladder[h]!);
        }
        positions = parents;
      }
      this.dirty.clear();
    }
    return this.levels;
  }
}
