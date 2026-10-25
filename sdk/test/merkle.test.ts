import { describe, expect, it } from "vitest";
import { BN254_SCALAR_MODULUS } from "../src/crypto/field.ts";
import { emptyLadder, emptyRoot, rootFromIndex, verify } from "../src/crypto/merkle.ts";
import { stateRoot } from "../src/protocol/block.ts";
import { merkleVectors } from "./vectors.ts";

const BN254_SCALAR_MODULUS_HEX =
  "0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001";

const DEPTH_BY_ROOT_KEY: Record<string, number> = {
  output_commitment_tree_depth_40: 40,
  address_account_state_tree_depth_40: 40,
  account_rule_set_tree_depth_8: 8,
  l1_origin_tree_depth_40: 40,
  l1_log_tree_depth_64: 64,
  pcash_history_tree_depth_40: 40,
};

describe("merkle empty ladder", () => {
  const maxDepth = merkleVectors.emptyLadder.length - 1;
  const ladder = emptyLadder(maxDepth);

  it(`ladder reaches depth 64`, () => {
    expect(maxDepth).toBe(64);
  });

  it("identifies the exact BN254 scalar field", () => {
    expect(merkleVectors.fieldModulus).toBe(BN254_SCALAR_MODULUS_HEX);
    expect(BigInt(merkleVectors.fieldModulus)).toBe(BN254_SCALAR_MODULUS);
  });

  for (const { height, value } of merkleVectors.emptyLadder) {
    it(`EMPTY[${height}] matches`, () => {
      expect(ladder[height]).toBe(BigInt(value));
    });
  }

  for (const [key, root] of Object.entries(merkleVectors.emptyRoots)) {
    it(`emptyRoot for ${key}`, () => {
      const depth = DEPTH_BY_ROOT_KEY[key];
      expect(depth).toBeDefined();
      expect(emptyRoot(depth!)).toBe(BigInt(root));
    });
  }
});

describe("merkle depth-4 membership", () => {
  for (const ex of merkleVectors.membershipExamples) {
    it(`${ex.label} (index ${ex.index}) recomputes the root`, () => {
      const leaf = BigInt(ex.leaf);
      const siblings = ex.siblings.map((x) => BigInt(x));
      const expected = BigInt(ex.expectedRoot);
      expect(rootFromIndex(leaf, ex.index, siblings)).toBe(expected);
      expect(verify(expected, leaf, ex.index, siblings)).toBe(true);
    });

    it(`${ex.label} index bits are LSB-first`, () => {
      for (const [h, bit] of ex.indexBitsLSBFirst.entries()) {
        expect(Number((BigInt(ex.index) >> BigInt(h)) & 1n)).toBe(bit);
      }
    });
  }
});

describe("typed state tree counts", () => {
  const state = {
    outputRoot: 0n,
    outputCount: 0n,
    issuedSoFar: 0n,
    lagQ: 0n,
    accountStateRoot: 0n,
    accountCount: 0n,
    nullifierRoot: 0n,
    nullifierCount: 0n,
  };

  it("accepts a terminal count of 2^40", () => {
    expect(() => stateRoot({ ...state, outputCount: 1n << 40n })).not.toThrow();
  });

  it("rejects a count above the depth-40 capacity", () => {
    expect(() => stateRoot({ ...state, outputCount: (1n << 40n) + 1n })).toThrow(/out of range/);
  });
});
