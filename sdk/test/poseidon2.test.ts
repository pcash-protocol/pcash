import { describe, expect, it } from "vitest";
import { BN254_SCALAR_MODULUS } from "../src/crypto/field.ts";
import { poseidon, poseidonBytes } from "../src/crypto/poseidon2.ts";
import { fromHex } from "../src/utils/hex.ts";
import { poseidonVectors } from "./vectors.ts";

const BN254_SCALAR_MODULUS_HEX =
  "0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001";

describe("poseidon2 length-tagged sponge", () => {
  it("identifies the exact BN254 scalar field", () => {
    expect(poseidonVectors.fieldModulus).toBe(BN254_SCALAR_MODULUS_HEX);
    expect(BigInt(poseidonVectors.fieldModulus)).toBe(BN254_SCALAR_MODULUS);
  });

  it("has vectors to check", () => {
    expect(poseidonVectors.poseidonVectors.length).toBeGreaterThan(0);
  });

  for (const [i, vector] of poseidonVectors.poseidonVectors.entries()) {
    it(`matches vector ${i} (N=${vector.inputs.length})`, () => {
      const inputs = vector.inputs.map((x) => BigInt(x));
      expect(poseidon(inputs)).toBe(BigInt(vector.output));
    });
  }
});

describe("poseidon2 byte-string hash", () => {
  for (const [i, vector] of poseidonVectors.byteHashVectors.entries()) {
    it(`matches byte vector ${i} (${(vector.bytes.length - 2) / 2} bytes)`, () => {
      expect(poseidonBytes(BigInt(vector.domain), fromHex(vector.bytes))).toBe(BigInt(vector.output));
    });
  }
});
