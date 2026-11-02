// The SDK's single hex codec, built on viem.
//
// Decoding is strict: malformed input throws rather than decoding to something
// plausible. A hand-rolled `parseInt`-per-byte loop silently turns an invalid
// digit into `0` and silently drops a trailing nibble on odd-length input, and
// either one corrupts a node response into bytes that still look well-formed.
//
// Hex is a boundary representation here — JSON-RPC payloads, wallet documents,
// addresses. Field elements and commitments stay `bigint`/`Uint8Array` inside the
// protocol layers, because those are circuit witnesses rather than EVM words.

import { bytesToHex, hexToBigInt, hexToBytes, isHex, numberToHex, type Hex } from "viem";

export type { Hex };

/** Lowercase 0x-hex of a byte string. */
export function toHex(bytes: Uint8Array): Hex {
  return bytesToHex(bytes);
}

/**
 * Parse 0x-prefixed (or bare) hex into bytes. Rejects odd length and non-hex
 * characters — an odd-length string is a caller bug, never a zero byte (viem
 * would silently left-pad it).
 */
export function fromHex(value: string, label = "value"): Uint8Array {
  const hex = value.startsWith("0x") ? value : `0x${value}`;
  if (hex.length % 2 !== 0) throw new Error(`${label} hex string has odd length`);
  if (!isHex(hex, { strict: true })) throw new Error(`${label} is not valid hex`);
  return hexToBytes(hex);
}

/** Parse hex that must decode to exactly `bytes` bytes. */
export function fromHexSized(value: string, bytes: number, label = "value"): Uint8Array {
  if (!isFixedHex(value, bytes)) throw new Error(`${label} must be ${bytes}-byte 0x hex`);
  return hexToBytes(value);
}

/** Validate a fixed-width 0x-hex string and normalize it to lowercase. */
export function fixedHex(value: unknown, bytes: number, label = "value"): string {
  if (!isFixedHex(value, bytes)) throw new Error(`${label} must be a ${bytes}-byte 0x hex string`);
  return value.toLowerCase();
}

function isFixedHex(value: unknown, bytes: number): value is Hex {
  return isHex(value, { strict: true }) && value.length === 2 + 2 * bytes;
}

/** Parse a JSON-RPC quantity: nonempty 0x-hex. */
export function parseHexQuantity(value: unknown, label = "quantity"): bigint {
  if (!isHex(value, { strict: true }) || value === "0x") throw new Error(`${label} must be 0x hex`);
  return hexToBigInt(value);
}

/** Case-insensitive equality of two hex strings; a non-string never matches. */
export function sameHex(left: unknown, right: string): boolean {
  return typeof left === "string" && left.toLowerCase() === right.toLowerCase();
}

/** A uint160 address value as a zero-padded, lowercase 20-byte 0x string. */
export function addressHex(value: bigint): Hex {
  return numberToHex(value, { size: 20 });
}

/** A field element as a zero-padded, lowercase 32-byte 0x string. */
export function bytes32Hex(value: bigint): Hex {
  return numberToHex(value, { size: 32 });
}
