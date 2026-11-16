// The consolidated hex codec, checked against viem directly.
//
// The strictness cases below are the point of the module, not decoration: a
// `parseInt`-per-byte decoder accepts malformed input and returns bytes that
// still look well-formed, so a corrupt node response reaches the protocol layers
// as data rather than as an error.

import { bytesToHex, hexToBytes, numberToHex } from "viem";
import { describe, expect, it } from "vitest";
import { bytesEqual } from "../src/utils/bytes.ts";
import {
  addressHex,
  bytes32Hex,
  fixedHex,
  fromHex,
  fromHexSized,
  parseHexQuantity,
  toHex,
} from "../src/utils/hex.ts";

const bytes = (n: number, seed = 1): Uint8Array =>
  Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed * 7) & 0xff);

describe("toHex / fromHex", () => {
  it("agrees with viem on encoding", () => {
    for (const n of [0, 1, 2, 20, 32, 33, 128]) {
      expect(toHex(bytes(n))).toBe(bytesToHex(bytes(n)));
    }
  });

  it("agrees with viem on decoding", () => {
    for (const n of [0, 1, 20, 32, 96]) {
      const hex = bytesToHex(bytes(n, 3));
      expect(bytesEqual(fromHex(hex), hexToBytes(hex))).toBe(true);
    }
  });

  it("round-trips arbitrary bytes", () => {
    for (let n = 0; n < 40; n++) {
      expect(bytesEqual(fromHex(toHex(bytes(n, n))), bytes(n, n))).toBe(true);
    }
  });

  it("emits lowercase", () => {
    expect(toHex(Uint8Array.of(0xab, 0xcd, 0xef))).toBe("0xabcdef");
  });

  it("accepts bare hex without the 0x prefix", () => {
    expect(bytesEqual(fromHex("abcd"), Uint8Array.of(0xab, 0xcd))).toBe(true);
  });

  it("rejects odd-length input instead of dropping the trailing nibble", () => {
    // A `new Uint8Array(len / 2)` loop truncates to floor(len / 2), so "0xabc"
    // decodes to [0xab] and the last digit vanishes without a word.
    expect(() => fromHex("0xabc")).toThrow(/odd length/);
    expect(() => fromHex("abc")).toThrow(/odd length/);
  });

  it("rejects non-hex characters instead of decoding them to zero", () => {
    // parseInt("zz", 16) is NaN, which a Uint8Array store coerces to 0.
    expect(() => fromHex("0xzz")).toThrow(/not valid hex/);
    expect(() => fromHex("0xabzz")).toThrow(/not valid hex/);
  });

  it("names the offending value in the error", () => {
    expect(() => fromHex("0xabc", "noteSecret")).toThrow(/noteSecret/);
  });
});

describe("fromHexSized", () => {
  it("accepts an exactly-sized value", () => {
    const hex = bytesToHex(bytes(32, 5));
    expect(bytesEqual(fromHexSized(hex, 32), bytes(32, 5))).toBe(true);
  });

  it("rejects a value of the wrong width", () => {
    expect(() => fromHexSized(bytesToHex(bytes(31)), 32, "root")).toThrow(/root must be 32-byte/);
    expect(() => fromHexSized(bytesToHex(bytes(33)), 32, "root")).toThrow(/root must be 32-byte/);
  });

  it("requires the 0x prefix", () => {
    expect(() => fromHexSized("ab".repeat(32), 32)).toThrow(/32-byte/);
  });
});

describe("fixedHex", () => {
  it("normalizes case without changing the value", () => {
    const upper = `0x${"AB".repeat(32)}`;
    expect(fixedHex(upper, 32)).toBe(`0x${"ab".repeat(32)}`);
  });

  it("rejects the wrong width", () => {
    expect(() => fixedHex(`0x${"ab".repeat(20)}`, 32, "blockHash")).toThrow(/blockHash/);
  });
});

describe("parseHexQuantity", () => {
  it("parses any nonempty 0x hex and rejects everything else", () => {
    expect(parseHexQuantity("0x0")).toBe(0n);
    expect(parseHexQuantity("0x00FF")).toBe(255n);
    for (const bad of ["12", "0x", "0xg", -1n, null]) expect(() => parseHexQuantity(bad, "q")).toThrow(/q must be 0x hex/);
  });
});

describe("integer formatting agrees with viem", () => {
  it("zero-pads addresses to 20 bytes", () => {
    for (const v of [0n, 1n, (1n << 160n) - 1n]) {
      expect(addressHex(v)).toBe(numberToHex(v, { size: 20 }));
      expect(addressHex(v).length).toBe(42);
    }
  });

  it("zero-pads field elements to 32 bytes", () => {
    for (const v of [0n, 255n, (1n << 255n) - 1n]) {
      expect(bytes32Hex(v)).toBe(numberToHex(v, { size: 32 }));
      expect(bytes32Hex(v).length).toBe(66);
    }
  });
});
