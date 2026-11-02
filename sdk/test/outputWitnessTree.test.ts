// OutputWitnessTree against the full SparseMerkleTree at depth 40: roots and
// every marked witness must agree through appends, unmarks, rewinds, JSON
// round-trips, and resumption from a bare frontier.

import { describe, expect, it } from "vitest";
import { MERKLE_DEPTH } from "../src/constants/params.ts";
import { emptyRoot } from "../src/crypto/merkle.ts";
import {
  emptyOutputFrontier,
  outputFrontierRoot,
  OutputWitnessTree,
  type OutputFrontier,
} from "../src/crypto/outputWitnessTree.ts";
import { SparseMerkleTree } from "../src/crypto/tree.ts";

function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomLeaf(random: () => number): bigint {
  return (BigInt(Math.floor(random() * 2 ** 52)) << 64n) + BigInt(Math.floor(random() * 2 ** 52)) + 1n;
}

function randomInt(random: () => number, below: number): number {
  return Math.floor(random() * below);
}

function sorted(indices: Iterable<bigint>): bigint[] {
  return [...indices].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** A witness tree and the full reference tree it must agree with. */
class Pair {
  readonly reference = new SparseMerkleTree(MERKLE_DEPTH);
  readonly marked = new Set<bigint>();
  readonly tree: OutputWitnessTree;
  readonly frontiers: OutputFrontier[];

  constructor(tree = new OutputWitnessTree()) {
    this.tree = tree;
    this.frontiers = [tree.frontier()];
  }

  append(leaf: bigint, mark: boolean): void {
    const index = this.tree.count;
    this.tree.append(leaf, mark);
    this.reference.setLeaf(index, leaf);
    if (mark) this.marked.add(index);
    this.frontiers[Number(index) + 1] = this.tree.frontier();
  }

  appendRandom(random: () => number, count: number, markRate = 0.15): void {
    for (let i = 0; i < count; i++) this.append(randomLeaf(random), random() < markRate);
  }

  rewind(count: number): void {
    for (let index = BigInt(count); index < this.tree.count; index++) this.reference.setLeaf(index, 0n);
    this.tree.rewind(this.frontiers[count]!);
    this.frontiers.length = count + 1;
    for (const index of this.marked) if (index >= BigInt(count)) this.marked.delete(index);
  }

  check(indices: Iterable<bigint> = this.marked): void {
    expect(this.tree.root()).toBe(this.reference.root);
    expect(this.tree.markedIndices()).toEqual(sorted(this.marked));
    for (const index of indices) expect(this.tree.witness(index)).toEqual(this.reference.proof(index).siblings);
  }
}

describe("OutputWitnessTree", () => {
  it("starts empty", () => {
    const tree = new OutputWitnessTree();
    expect(tree.count).toBe(0n);
    expect(tree.frontier()).toEqual(emptyOutputFrontier());
    expect(tree.root()).toBe(emptyRoot(MERKLE_DEPTH));
    expect(outputFrontierRoot(emptyOutputFrontier())).toBe(emptyRoot(MERKLE_DEPTH));
    expect(() => tree.witness(0n)).toThrow("not marked");
  });

  it("takes a full tree's root from its single ommer", () => {
    expect(outputFrontierRoot({ count: 1n << BigInt(MERKLE_DEPTH), ommers: [7n] })).toBe(7n);
  });

  it("matches a sparse tree root and every marked witness while appending", () => {
    const random = prng(1);
    const pair = new Pair();
    pair.check();
    for (let step = 0; step < 300; step++) {
      pair.append(randomLeaf(random), random() < 0.15);
      if (pair.marked.size > 0 && random() < 0.05) {
        const victim = sorted(pair.marked)[randomInt(random, pair.marked.size)]!;
        pair.tree.unmark(victim);
        pair.marked.delete(victim);
        expect(pair.tree.isMarked(victim)).toBe(false);
      }
      expect(pair.tree.count).toBe(BigInt(step + 1));
      if (step < 70 || step % 16 === 0 || step === 299) {
        pair.check();
        expect(outputFrontierRoot(pair.tree.frontier())).toBe(pair.reference.root);
      } else {
        const marked = sorted(pair.marked);
        pair.check(marked.length === 0 ? [] : [marked[randomInt(random, marked.length)]!]);
      }
    }
    expect(pair.marked.size).toBeGreaterThan(20);
  });

  it("rewinds to earlier frontiers and re-appends a different suffix", () => {
    const random = prng(2);
    const pair = new Pair();
    pair.appendRandom(random, 200);
    pair.check();
    const size = () => Number(pair.tree.count);
    const targets = [
      () => randomInt(random, size() + 1),
      () => size(),
      () => Math.max(0, size() - 1 - randomInt(random, 40)),
      () => Math.max(0, size() - 1 - randomInt(random, 40)),
      () => 0,
    ];
    for (const target of targets) {
      pair.rewind(target());
      pair.check();
      pair.appendRandom(random, 1 + randomInt(random, 60));
      pair.check();
    }
  });

  it("round-trips through JSON", () => {
    const random = prng(3);
    const pair = new Pair();
    pair.appendRandom(random, 100);
    const copy = new Pair(OutputWitnessTree.fromJSON(JSON.parse(JSON.stringify(pair.tree))));
    expect(copy.tree.toJSON()).toEqual(pair.tree.toJSON());
    expect(copy.tree.count).toBe(pair.tree.count);
    expect(copy.tree.markedIndices()).toEqual(sorted(pair.marked));
    for (let step = 0; step < 60; step++) {
      const leaf = randomLeaf(random);
      const mark = random() < 0.2;
      pair.append(leaf, mark);
      copy.tree.append(leaf, mark);
    }
    pair.check();
    expect(copy.tree.root()).toBe(pair.tree.root());
    expect(copy.tree.toJSON()).toEqual(pair.tree.toJSON());
    for (const index of pair.marked) expect(copy.tree.witness(index)).toEqual(pair.tree.witness(index));
  });

  it("continues from a frontier taken mid-stream", () => {
    const random = prng(4);
    const full = new Pair();
    full.appendRandom(random, 97);
    const resumed = new OutputWitnessTree(full.tree.frontier());
    expect(resumed.root()).toBe(full.reference.root);
    expect(outputFrontierRoot(full.tree.frontier())).toBe(full.reference.root);
    const resumedMarks: bigint[] = [];
    for (let step = 0; step < 120; step++) {
      const leaf = randomLeaf(random);
      const mark = random() < 0.2;
      if (mark) resumedMarks.push(resumed.count);
      full.append(leaf, mark);
      resumed.append(leaf, mark);
    }
    full.check();
    expect(resumed.root()).toBe(full.reference.root);
    expect(resumed.markedIndices()).toEqual(resumedMarks);
    for (const index of resumedMarks) expect(resumed.witness(index)).toEqual(full.reference.proof(index).siblings);
  });
});
