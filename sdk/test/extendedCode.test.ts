import { describe, expect, it } from "vitest";
import { buildExtendedCode, EXTENDED_CODE_VERSION, parseExtendedCode } from "../src/delivery/extendedCode.ts";
import { concatBytes, fromBase64Url, toBase64Url } from "../src/utils/bytes.ts";
import { keccak256 } from "../src/utils/keccak.ts";

const mlKemPublicKey = Uint8Array.from({ length: 1_184 }, (_, index) => (index * 7) & 0xff);
const code = buildExtendedCode({ chainId: 0x01020304n, address: 0xabn, mlKemPublicKey });

/** Re-checksum a modified body so only the field under test is wrong. */
function withBody(body: Uint8Array): string {
  return toBase64Url(concatBytes(body, keccak256(body).subarray(0, 4)));
}

describe("extended code framing", () => {
  it("encodes version, chain id, address, key, and a 4-byte checksum", () => {
    const bytes = fromBase64Url(code);
    expect(bytes).toHaveLength(1 + 4 + 20 + 1_184 + 4);
    expect(bytes[0]).toBe(EXTENDED_CODE_VERSION);
    expect(Array.from(bytes.subarray(1, 5))).toEqual([1, 2, 3, 4]);
    expect(parseExtendedCode(code)).toMatchObject({ chainId: 0x01020304n, address: 0xabn });
  });

  it("rejects an unknown version even with a valid checksum", () => {
    const body = fromBase64Url(code).slice(0, -4);
    body[0] = EXTENDED_CODE_VERSION - 1;
    expect(() => parseExtendedCode(withBody(body))).toThrow(`unknown extended code version ${EXTENDED_CODE_VERSION - 1}`);
    expect(() => buildExtendedCode({ version: 1, chainId: 1n, address: 1n, mlKemPublicKey }))
      .toThrow(`extended code version must be ${EXTENDED_CODE_VERSION}`);
  });

  it("rejects a truncated or extended code", () => {
    const bytes = fromBase64Url(code);
    expect(() => parseExtendedCode(toBase64Url(bytes.subarray(0, -1)))).toThrow("extended code has wrong length");
    expect(() => parseExtendedCode(toBase64Url(concatBytes(bytes, Uint8Array.of(0))))).toThrow("extended code has wrong length");
    expect(() => parseExtendedCode("")).toThrow("extended code has wrong length");
  });

  it("rejects chain ids and addresses that overflow their widths", () => {
    expect(() => buildExtendedCode({ chainId: 1n << 32n, address: 1n, mlKemPublicKey })).toThrow(/32-bit unsigned integer range/);
    expect(() => buildExtendedCode({ chainId: 1n, address: 1n << 160n, mlKemPublicKey })).toThrow(/160-bit unsigned integer range/);
  });
});
