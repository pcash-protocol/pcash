// Append-only output tree that keeps only the append frontier plus the
// authentication paths of marked leaves. Same hashing and orientation as
// ./merkle.ts: internal node = poseidon2(left, right), empty leaf = 0,
// siblings leaf-level upward, bit h of the index = 0 means the node at height h
// is the left child.
//
// A marked leaf's left siblings are the ommers at the moment it is appended and
// never change. Its right siblings are recorded when the carry of a later
// append completes them; until then `witness` derives them from the frontier.

import { MERKLE_DEPTH } from "../constants/params.ts";
import { fieldToHex } from "./field.ts";
import { emptyLadder, rootFromIndex } from "./merkle.ts";
import { poseidon2 } from "./poseidon2.ts";

/** The append state of an output tree. */
export interface OutputFrontier {
  /** Leaves appended. */
  count: bigint;
  /** One node per set bit h of `count`, ascending h: node (h, (count >> h) - 1). */
  ommers: bigint[];
}

export function emptyOutputFrontier(): OutputFrontier {
  return { count: 0n, ommers: [] };
}

/** Root of the tree the frontier describes. */
export function outputFrontierRoot(frontier: OutputFrontier): bigint {
  return frontierRoot(frontier.count, ommersByHeight(frontier));
}

interface OutputWitnessTreeJson {
  count: string;
  ommers: string[];
  marks: { index: string; siblings: (string | null)[] }[];
}

export class OutputWitnessTree {
  private countValue = 0n;
  // ommers[h] is node (h, (count >> h) - 1) when bit h of count is set.
  private ommers: (bigint | undefined)[] = [];
  // Marked leaf index -> siblings leaf-level upward; undefined = right sibling not yet complete.
  private readonly marks = new Map<bigint, (bigint | undefined)[]>();
  // waiting[h]: marks whose lowest unrecorded sibling is at height h. That sibling is
  // the node the carry completes the next time it passes height h.
  private readonly waiting: Set<bigint>[] = Array.from({ length: MERKLE_DEPTH }, () => new Set<bigint>());

  constructor(frontier: OutputFrontier = emptyOutputFrontier()) {
    this.load(frontier);
  }

  get count(): bigint {
    return this.countValue;
  }

  frontier(): OutputFrontier {
    return { count: this.countValue, ommers: this.ommers.filter((ommer) => ommer !== undefined) };
  }

  root(): bigint {
    return frontierRoot(this.countValue, this.ommers);
  }

  /** Append `leaf` at index `count`; `mark` keeps its authentication path current. */
  append(leaf: bigint, mark = false): void {
    const index = this.countValue;
    if (mark) {
      const siblings = new Array<bigint | undefined>(MERKLE_DEPTH).fill(undefined);
      for (let h = 0; h < MERKLE_DEPTH; h++) if (bit(index, h)) siblings[h] = this.ommers[h];
      this.marks.set(index, siblings);
    }
    let node = leaf;
    let h = 0;
    for (; bit(index, h); h++) {
      this.complete(h, node);
      node = poseidon2(this.ommers[h]!, node);
      this.ommers[h] = undefined;
    }
    this.ommers[h] = node;
    this.countValue = index + 1n;
    if (mark) this.enqueue(index);
  }

  isMarked(index: bigint): boolean {
    return this.marks.has(index);
  }

  markedIndices(): bigint[] {
    return [...this.marks.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  }

  /** The MERKLE_DEPTH siblings of a marked leaf against `root()`. */
  witness(index: bigint): bigint[] {
    const siblings = this.marks.get(index);
    if (siblings === undefined) throw new Error(`output ${index} is not marked`);
    const ladder = emptyLadder(MERKLE_DEPTH);
    return siblings.map((sibling, h) => {
      if (sibling !== undefined) return sibling;
      // The right sibling is incomplete: either the partially filled subtree
      // holding the append position, or entirely empty.
      const start = ((index >> BigInt(h)) + 1n) << BigInt(h);
      return this.countValue > start ? edgeNode(this.countValue, this.ommers, h) : ladder[h]!;
    });
  }

  /**
   * Mark a leaf appended before it was marked, from its siblings in this tree
   * or any later one. Siblings of subtrees not yet complete at this count are
   * dropped and completed by later appends, as after `rewind`. False, leaving
   * the tree unchanged, when the path does not open this tree's root.
   */
  markPath(index: bigint, leaf: bigint, siblings: readonly bigint[]): boolean {
    if (index >= this.countValue || siblings.length !== MERKLE_DEPTH || this.marks.has(index)) return false;
    this.marks.set(index, siblings.map((sibling, h) =>
      bit(index, h) || ((((index >> BigInt(h)) ^ 1n) + 1n) << BigInt(h)) <= this.countValue ? sibling : undefined));
    if (rootFromIndex(leaf, index, this.witness(index)) !== this.root()) {
      this.marks.delete(index);
      return false;
    }
    this.enqueue(index);
    return true;
  }

  unmark(index: bigint): void {
    this.marks.delete(index);
    for (const waiting of this.waiting) waiting.delete(index);
  }

  /**
   * Restore an earlier frontier of this same tree (count <= current count):
   * drop marks at index >= count, and forget right siblings whose subtree was
   * not complete at that count. Left siblings never change.
   */
  rewind(frontier: OutputFrontier): void {
    const count = frontier.count;
    for (const [index, siblings] of this.marks) {
      if (index >= count) {
        this.marks.delete(index);
        continue;
      }
      for (let h = 0; h < MERKLE_DEPTH; h++) {
        if (!bit(index, h) && ((((index >> BigInt(h)) ^ 1n) + 1n) << BigInt(h)) > count) siblings[h] = undefined;
      }
    }
    this.load(frontier);
    for (const waiting of this.waiting) waiting.clear();
    for (const index of this.marks.keys()) this.enqueue(index);
  }

  toJSON(): unknown {
    const json: OutputWitnessTreeJson = {
      count: quantityHex(this.countValue),
      ommers: this.frontier().ommers.map((ommer) => fieldToHex(ommer)),
      marks: this.markedIndices().map((index) => ({
        index: quantityHex(index),
        siblings: this.marks.get(index)!.map((sibling) => (sibling === undefined ? null : fieldToHex(sibling))),
      })),
    };
    return json;
  }

  static fromJSON(value: unknown): OutputWitnessTree {
    const json = value as OutputWitnessTreeJson;
    const tree = new OutputWitnessTree({
      count: BigInt(json.count),
      ommers: json.ommers.map((ommer) => BigInt(ommer)),
    });
    for (const mark of json.marks) {
      const index = BigInt(mark.index);
      tree.marks.set(index, mark.siblings.map((sibling) => (sibling === null ? undefined : BigInt(sibling))));
      tree.enqueue(index);
    }
    return tree;
  }

  private load(frontier: OutputFrontier): void {
    this.countValue = frontier.count;
    this.ommers = ommersByHeight(frontier);
  }

  // `node` is the just-completed node (h, index >> h), a right child: the
  // missing sibling of every mark waiting at height h.
  private complete(h: number, node: bigint): void {
    const waiting = this.waiting[h]!;
    if (waiting.size === 0) return;
    const moved = [...waiting];
    waiting.clear();
    for (const index of moved) {
      this.marks.get(index)![h] = node;
      this.enqueue(index);
    }
  }

  private enqueue(index: bigint): void {
    const height = this.marks.get(index)!.indexOf(undefined);
    if (height >= 0) this.waiting[height]!.add(index);
  }
}

function bit(value: bigint, h: number): boolean {
  return ((value >> BigInt(h)) & 1n) === 1n;
}

function quantityHex(value: bigint): string {
  return `0x${value.toString(16)}`;
}

function ommersByHeight(frontier: OutputFrontier): (bigint | undefined)[] {
  const ommers = new Array<bigint | undefined>(MERKLE_DEPTH + 1).fill(undefined);
  let next = 0;
  for (let h = 0; h <= MERKLE_DEPTH; h++) if (bit(frontier.count, h)) ommers[h] = frontier.ommers[next++];
  return ommers;
}

function frontierRoot(count: bigint, ommers: readonly (bigint | undefined)[]): bigint {
  // A full tree's only ommer is its root.
  if (bit(count, MERKLE_DEPTH)) return ommers[MERKLE_DEPTH]!;
  return edgeNode(count, ommers, MERKLE_DEPTH);
}

/** Node (height, count >> height): the subtree holding the append position, with every leaf at or after `count` empty. */
function edgeNode(count: bigint, ommers: readonly (bigint | undefined)[], height: number): bigint {
  const ladder = emptyLadder(MERKLE_DEPTH);
  let h = 0;
  while (h < height && !bit(count, h)) h++;
  let node = ladder[h]!;
  for (; h < height; h++) node = bit(count, h) ? poseidon2(ommers[h]!, node) : poseidon2(node, ladder[h]!);
  return node;
}
