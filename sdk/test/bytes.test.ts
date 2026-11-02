import { describe, expect, it } from "vitest";
import { BN254_SCALAR_MODULUS } from "../src/crypto/field.ts";
import {
  bytes32FromHex,
  bytesToBigInt,
  fromBase64Url,
  randomFieldEntropy,
  scalarFromBytes,
  toBase64Url,
} from "../src/utils/bytes.ts";
import { requireLength, U32_LIMIT, uintBelow } from "../src/utils/validate.ts";

describe("base64url", () => {
  it("round-trips every tail length", () => {
    for (let length = 0; length < 8; length++) {
      const bytes = Uint8Array.from({ length }, (_, index) => (index * 97 + 13) & 0xff);
      expect(fromBase64Url(toBase64Url(bytes))).toEqual(bytes);
    }
  });

  it("uses the URL-safe alphabet without padding and accepts padded input", () => {
    const bytes = Uint8Array.of(0xfb, 0xff, 0xbf);
    expect(toBase64Url(bytes)).toBe("-_-_");
    expect(fromBase64Url("-_-_")).toEqual(bytes);
    expect(toBase64Url(Uint8Array.of(1))).toBe("AQ");
    expect(fromBase64Url("AQ==")).toEqual(Uint8Array.of(1));
    expect(fromBase64Url("")).toEqual(new Uint8Array());
  });

  it("rejects characters outside the alphabet", () => {
    for (const input of ["AA A", "AA.A", "AA*A", "AAé="]) {
      expect(() => fromBase64Url(input)).toThrow(/invalid base64 character/);
    }
  });

  it("strips only trailing padding", () => {
    expect(fromBase64Url("AQ=")).toEqual(Uint8Array.of(1));
    expect(() => fromBase64Url("A=Q")).toThrow(/invalid base64 character/);
  });

  it("rejects a long run of padding before other input in linear time", () => {
    // The scan takes about a millisecond here; a /=+$/ strip takes about 30 s.
    // Vitest cannot time out a synchronous test, so the bound is explicit.
    const input = `${"=".repeat(1 << 18)}AA`;
    const started = performance.now();
    expect(() => fromBase64Url(input)).toThrow(/invalid base64 character/);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("rejects a dangling sextet", () => {
    expect(() => fromBase64Url("AAAAA")).toThrow(/length/);
  });

  it("rejects nonzero trailing bits, so each byte string has one encoding", () => {
    expect(toBase64Url(Uint8Array.of(0xff))).toBe("_w");
    expect(() => fromBase64Url("_x")).toThrow(/trailing bits/);
    expect(toBase64Url(Uint8Array.of(0xff, 0xff))).toBe("__8");
    expect(() => fromBase64Url("__9")).toThrow(/trailing bits/);
  });
});

describe("bytes32FromHex", () => {
  const hex = "0123456789abcdefABCDEF".padEnd(64, "0");

  it("accepts 32-byte hex with or without 0x, in either case", () => {
    const withPrefix = bytes32FromHex(`0x${hex}`);
    expect(withPrefix).toHaveLength(32);
    expect(bytes32FromHex(hex)).toEqual(withPrefix);
    expect(bytesToBigInt(withPrefix)).toBe(BigInt(`0x${hex}`));
  });

  it("rejects other lengths and non-hex input with its label", () => {
    expect(() => bytes32FromHex(`0x${hex.slice(2)}`, "digest")).toThrow(/digest must be 32-byte hex/);
    expect(() => bytes32FromHex(`0x${hex}00`)).toThrow(/bytes32 must be 32-byte hex/);
    expect(() => bytes32FromHex(`0x${"g".repeat(64)}`)).toThrow(/must be 32-byte hex/);
    expect(() => bytes32FromHex(`0X${hex}`)).toThrow(/must be 32-byte hex/);
  });
});

describe("scalarFromBytes and randomFieldEntropy", () => {
  it("maps bytes into [1, p - 1]", () => {
    expect(scalarFromBytes(new Uint8Array())).toBe(1n);
    expect(scalarFromBytes(Uint8Array.of(0))).toBe(1n);
    expect(scalarFromBytes(Uint8Array.of(5))).toBe(6n);
    const pMinusOne = BN254_SCALAR_MODULUS - 1n;
    const encode = (value: bigint) => Uint8Array.from({ length: 32 }, (_, i) => Number((value >> BigInt(8 * (31 - i))) & 0xffn));
    expect(scalarFromBytes(encode(pMinusOne))).toBe(1n);
    expect(scalarFromBytes(encode(pMinusOne - 1n))).toBe(pMinusOne);
    expect(scalarFromBytes(new Uint8Array(48).fill(0xff))).toBeLessThan(BN254_SCALAR_MODULUS);
  });

  it("draws fresh nonzero field elements", () => {
    const draws = Array.from({ length: 16 }, () => randomFieldEntropy());
    for (const value of draws) {
      expect(value).toBeGreaterThan(0n);
      expect(value).toBeLessThan(BN254_SCALAR_MODULUS);
    }
    expect(new Set(draws).size).toBe(draws.length);
  });
});

describe("uintBelow and requireLength", () => {
  it("accepts values strictly below the limit", () => {
    expect(uintBelow(0, U32_LIMIT, "n")).toBe(0n);
    expect(uintBelow("0xffffffff", U32_LIMIT, "n")).toBe(U32_LIMIT - 1n);
  });

  it("rejects the limit, negatives, and unsafe numbers", () => {
    expect(() => uintBelow(U32_LIMIT, U32_LIMIT, "slot")).toThrow(/slot is out of range/);
    expect(() => uintBelow(-1n, U32_LIMIT, "slot")).toThrow(/slot must be nonnegative/);
    expect(() => uintBelow(2 ** 53, U32_LIMIT, "slot")).toThrow(/slot must be a safe integer/);
  });

  it("requires an exact arity", () => {
    expect(() => requireLength([1, 2], 2, "siblings")).not.toThrow();
    expect(() => requireLength([1], 2, "siblings")).toThrow(/siblings must contain 2 values/);
    expect(() => requireLength([1, 2, 3], 2, "siblings")).toThrow(/siblings must contain 2 values/);
  });
});
