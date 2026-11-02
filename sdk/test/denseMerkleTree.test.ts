// DenseMerkleTree against the full SparseMerkleTree at depth 40 through random
// overwrites, appends, and truncates, with paths checked by ./merkle.ts.

import { describe, expect, it } from "vitest";
import { MERKLE_DEPTH } from "../src/constants/params.ts";
import { DenseMerkleTree } from "../src/crypto/denseMerkleTree.ts";
import { emptyRoot, rootFromIndex, verify } from "../src/crypto/merkle.ts";
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

function expectAgrees(tree: DenseMerkleTree, reference: SparseMerkleTree, indices: readonly number[]): void {
  const root = tree.root();
  expect(root).toBe(reference.root);
  for (const index of indices) {
    const path = tree.path(index);
    expect(path).toEqual(reference.proof(index).siblings);
    expect(verify(root, tree.get(index), index, path)).toBe(true);
    expect(rootFromIndex(tree.get(index), index, path)).toBe(root);
  }
}

describe("DenseMerkleTree", () => {
  it("builds from initial leaves", () => {
    const random = prng(11);
    const leaves = Array.from({ length: 37 }, () => randomLeaf(random));
    const reference = new SparseMerkleTree(MERKLE_DEPTH);
    leaves.forEach((leaf, index) => reference.setLeaf(index, leaf));
    const tree = new DenseMerkleTree(MERKLE_DEPTH, leaves);
    expect(tree.size).toBe(37);
    expect(tree.get(36)).toBe(leaves[36]);
    expectAgrees(tree, reference, [0, 1, 17, 31, 32, 36]);
  });

  it("tracks random overwrites, appends, and truncates", () => {
    const random = prng(12);
    const reference = new SparseMerkleTree(MERKLE_DEPTH);
    const tree = new DenseMerkleTree(MERKLE_DEPTH);
    let checks = 0;
    for (let step = 0; step < 220; step++) {
      const size = tree.size;
      const op = random();
      if (op < 0.35 && size > 0) {
        const index = randomInt(random, size);
        const leaf = randomLeaf(random);
        tree.set(index, leaf);
        reference.setLeaf(index, leaf);
      } else if (op < 0.9) {
        const leaf = randomLeaf(random);
        tree.set(size, leaf);
        reference.setLeaf(size, leaf);
      } else {
        const next = size - randomInt(random, Math.min(size, 8) + 1);
        for (let index = next; index < size; index++) reference.setLeaf(index, 0n);
        tree.truncate(next);
      }
      // Leave several changes pending between some reads so they rehash together.
      if (step >= 8 && random() < 0.5) {
        checks++;
        const indices = tree.size === 0 ? [] : [0, tree.size - 1, randomInt(random, tree.size)];
        expectAgrees(tree, reference, indices);
      }
    }
    expect(checks).toBeGreaterThan(80);
    expect(tree.size).toBeGreaterThan(32);
  });

  it("returns to the empty root after truncating every leaf", () => {
    const random = prng(13);
    const tree = new DenseMerkleTree(MERKLE_DEPTH);
    expect(tree.root()).toBe(emptyRoot(MERKLE_DEPTH));
    for (let index = 0; index < 5; index++) tree.set(index, randomLeaf(random));
    expect(tree.root()).not.toBe(emptyRoot(MERKLE_DEPTH));
    tree.truncate(0);
    expect(tree.size).toBe(0);
    expect(tree.root()).toBe(emptyRoot(MERKLE_DEPTH));
    const leaf = randomLeaf(random);
    tree.set(0, leaf);
    const reference = new SparseMerkleTree(MERKLE_DEPTH);
    reference.setLeaf(0, leaf);
    expectAgrees(tree, reference, [0]);
  });

  it("rejects gaps and reads past the end", () => {
    const tree = new DenseMerkleTree(MERKLE_DEPTH, [1n, 2n]);
    expect(() => tree.set(3, 4n)).toThrow("out of range");
    expect(() => tree.get(2)).toThrow("out of range");
    expect(() => tree.path(2)).toThrow("out of range");
    expect(() => tree.truncate(3)).toThrow("out of range");
  });
});
