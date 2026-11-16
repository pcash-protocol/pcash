// Big-endian byte helpers for PCASH wire encodings. All multi-byte integers are
// unsigned and big-endian; field elements are 32-byte big-endian integers.

import { randomBytes } from "@noble/hashes/utils.js";
import { concatBytes as concatByteArray, numberToBytes } from "viem";
import { BN254_SCALAR_MODULUS, type FieldNumberish, toNonnegativeBigInt } from "../crypto/field.ts";
import { fromHexSized } from "./hex.ts";

/** Encode an unsigned integer as `len` big-endian bytes. Throws if it overflows. */
export function beBytes(value: FieldNumberish, len: number): Uint8Array {
  return numberToBytes(toNonnegativeBigInt(value, "beBytes value"), { size: len });
}

/** 32-byte big-endian encoding of a field element / uint256. */
export function field32(value: FieldNumberish): Uint8Array {
  return beBytes(value, 32);
}

/** Map arbitrary bytes to a nonzero BN254 scalar: 1 + (OS2IP(bytes) mod (p-1)). */
export function scalarFromBytes(bytes: Uint8Array): bigint {
  return 1n + (bytesToBigInt(bytes) % (BN254_SCALAR_MODULUS - 1n));
}

/** Fresh CSPRNG field entropy in [1, p-1]. */
export function randomFieldEntropy(): bigint {
  return scalarFromBytes(randomBytes(48));
}

/** Big-endian bytes -> bigint; empty bytes are zero (viem's bytesToBigInt throws on them). */
export function bytesToBigInt(bytes: Uint8Array): bigint {
  let acc = 0n;
  for (const b of bytes) acc = (acc << 8n) | BigInt(b);
  return acc;
}

/** Split an exact bytes32 digest into lossless big-endian 128-bit field limbs. */
export function splitHash256(hash: Uint8Array, name = "hash"): { high128: bigint; low128: bigint } {
  if (hash.length !== 32) throw new Error(`${name} must be 32 bytes`);
  return {
    high128: bytesToBigInt(hash.subarray(0, 16)),
    low128: bytesToBigInt(hash.subarray(16)),
  };
}

/**
 * Parse an exact 32-byte hexadecimal value. Unlike ./hex.ts's fromHexSized this
 * tolerates a missing `0x`, because node responses and journey fixtures both
 * carry bare digests; the decode itself is the shared one.
 */
export function bytes32FromHex(value: string, label = "bytes32"): Uint8Array {
  const clean = value.startsWith("0x") ? value.slice(2) : value;
  if (!/^[0-9a-fA-F]{64}$/.test(clean)) throw new Error(`${label} must be 32-byte hex`);
  return fromHexSized(`0x${clean}`, 32, label);
}

/** Concatenate byte chunks. */
export function concatBytes(...chunks: Uint8Array[]): Uint8Array {
  return concatByteArray(chunks);
}

/** UTF-8 encode a string. */
export function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

/** Constant-length byte-equality (exact). */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// Standard RFC 4648 base64, implemented directly (no Buffer / btoa) so this stays
// portable across Node and the browser bundle without a Buffer polyfill.
const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_LOOKUP: Record<string, number> = {};
for (let i = 0; i < B64_ALPHABET.length; i++) B64_LOOKUP[B64_ALPHABET[i]!] = i;

function base64Encode(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = i + 1 < bytes.length ? bytes[i + 1]! : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2]! : 0;
    out += B64_ALPHABET[b0 >> 2];
    out += B64_ALPHABET[((b0 & 0x03) << 4) | (b1 >> 4)];
    out += i + 1 < bytes.length ? B64_ALPHABET[((b1 & 0x0f) << 2) | (b2 >> 6)] : "=";
    out += i + 2 < bytes.length ? B64_ALPHABET[b2 & 0x3f] : "=";
  }
  return out;
}

/**
 * Decode standard base64 (padding optional) via a 6-bit accumulator. Only the
 * canonical encoding of some byte string is accepted: no dangling sextet and
 * no nonzero bits after the last byte.
 */
function base64Decode(s: string): Uint8Array {
  // A backward scan: /=+$/ retries from every '=' when the run is not at the end.
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 0x3d) end--;
  const clean = s.slice(0, end);
  if (clean.length % 4 === 1) throw new Error("invalid base64 length");
  const out = new Uint8Array((clean.length * 3) >> 2);
  let o = 0;
  let buf = 0;
  let bits = 0;
  for (const ch of clean) {
    const v = B64_LOOKUP[ch];
    if (v === undefined) throw new Error(`invalid base64 character: ${JSON.stringify(ch)}`);
    buf = (buf << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (buf >> bits) & 0xff;
    }
  }
  if ((buf & ((1 << bits) - 1)) !== 0) throw new Error("non-canonical base64: nonzero trailing bits");
  return out;
}

/** base64url encode (no padding), used by the extended code / links. */
export function toBase64Url(bytes: Uint8Array): string {
  return base64Encode(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** base64url decode; accepts padded or unpadded input. */
export function fromBase64Url(s: string): Uint8Array {
  return base64Decode(s.replace(/-/g, "+").replace(/_/g, "/"));
}
