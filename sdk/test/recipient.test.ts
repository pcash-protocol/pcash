import { describe, expect, it } from "vitest";
import {
  looksLikeExtendedCode,
  parseLocalChainCode,
  resolveRecipientAddress,
  resolveRecipientDelivery,
} from "../src/delivery/recipient.ts";
import { buildExtendedCode } from "../src/delivery/extendedCode.ts";

describe("recipient address forms", () => {
  const address = 0x87c018ef78005f118c53fa9cadf0a4fd367a77a9n;
  const bare = address.toString(16);

  it("treats a bare or 0X-prefixed address as an address, not an extended code", () => {
    for (const form of [bare, `0X${bare.toUpperCase()}`, `0x${bare}`]) {
      expect(looksLikeExtendedCode(form)).toBe(false);
      expect(resolveRecipientAddress(form, 1n)).toEqual({ recipientAddress: address });
    }
    expect(looksLikeExtendedCode("0X1234")).toBe(false);
    expect(looksLikeExtendedCode("AQID")).toBe(true);
  });
});

describe("extended-code recipients", () => {
  const address = 0x87c018ef78005f118c53fa9cadf0a4fd367a77a9n;
  const addressHex = `0x${address.toString(16)}`;
  const mlKemPublicKey = Uint8Array.from({ length: 1_184 }, (_, index) => index & 0xff);
  const code = buildExtendedCode({ chainId: 7n, address, mlKemPublicKey });

  function directory(key: Uint8Array | null): { lookup: (address: string) => Uint8Array | null; calls: string[] } {
    const calls: string[] = [];
    return {
      lookup: (requested) => {
        calls.push(requested);
        return key;
      },
      calls,
    };
  }

  it("classifies codes, addresses, and short hex", () => {
    expect(looksLikeExtendedCode(code)).toBe(true);
    expect(looksLikeExtendedCode(addressHex)).toBe(false);
    // Hex up to one field is never read as a code, so it fails as a malformed address.
    expect(looksLikeExtendedCode(`0x${"f".repeat(64)}`)).toBe(false);
    expect(looksLikeExtendedCode(`0x${"f".repeat(65)}`)).toBe(true);
    expect(looksLikeExtendedCode("0x")).toBe(true);
  });

  it("accepts a code for this chain and rejects one for another", () => {
    expect(parseLocalChainCode(code, 7n).address).toBe(address);
    expect(() => parseLocalChainCode(code, 8n))
      .toThrow("extended code chain id 0x7 does not match this PCASH chain 0x8");
    expect(resolveRecipientAddress(code, 7n)).toEqual({ recipientAddress: address });
    expect(() => resolveRecipientAddress(code, 8n)).toThrow(/does not match this PCASH chain/);
  });

  it("rejects hex that is not a 20-byte address", () => {
    expect(() => resolveRecipientAddress("0x1234", 7n))
      .toThrow("recipient 0x1234 is neither a 20-byte address nor an extended code");
    expect(() => resolveRecipientAddress("nonsense", 7n)).toThrow();
  });

  it("delivers to an extended code without a directory lookup", async () => {
    const { lookup, calls } = directory(null);
    await expect(resolveRecipientDelivery(code, 7n, lookup)).resolves.toEqual({
      recipientAddress: address,
      recipientExtendedCode: code,
    });
    expect(calls).toEqual([]);
  });

  it("reads the published receive key for an address from the directory", async () => {
    const { lookup, calls } = directory(mlKemPublicKey);
    const delivery = await resolveRecipientDelivery(addressHex.toUpperCase().replace("0X", ""), 7n, lookup);
    expect(calls).toEqual([addressHex]);
    expect(delivery.recipientAddress).toBe(address);
    expect(delivery.recipientReceiveKey).toEqual(mlKemPublicKey);
  });

  it("rejects an address with no published receive key", async () => {
    await expect(resolveRecipientDelivery(addressHex, 7n, directory(null).lookup))
      .rejects.toThrow(`recipient ${addressHex} has no published ML-KEM receive key`);
  });
});
