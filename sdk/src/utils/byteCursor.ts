// Cursor-style byte writer and reader shared by the wire codec and record codecs.
// Fixed-width integers are unsigned big-endian; uvarint is canonical unsigned LEB128.

import { type FieldNumberish, toField } from "../crypto/field.ts";
import { beBytes, bytesToBigInt, field32 } from "./bytes.ts";

export class ByteWriter {
  private chunks: number[] = [];
  get length(): number {
    return this.chunks.length;
  }
  u8(v: number): this {
    this.chunks.push(v & 0xff);
    return this;
  }
  u16(v: number): this {
    if (!Number.isInteger(v) || v < 0 || v > 0xffff) throw new Error(`u16 out of range: ${v}`);
    this.chunks.push((v >>> 8) & 0xff, v & 0xff);
    return this;
  }
  u32(v: number): this {
    if (!Number.isInteger(v) || v < 0 || v > 0xffffffff) throw new Error(`u32 out of range: ${v}`);
    this.chunks.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
    return this;
  }
  u64(v: bigint): this {
    if (v < 0n || v >= 1n << 64n) throw new Error(`u64 out of range: ${v}`);
    return this.bytes(beBytes(v, 8));
  }
  bytes(b: Uint8Array): this {
    for (const x of b) this.chunks.push(x);
    return this;
  }
  field(v: FieldNumberish): this {
    return this.bytes(field32(toField(v, "public input")));
  }
  word(v: Uint8Array): this {
    if (v.length !== 32) throw new Error("word must be 32 bytes");
    return this.bytes(v);
  }
  uvarint(v: number | bigint): this {
    let rest = BigInt(v);
    if (rest < 0n) throw new Error(`uvarint must be nonnegative: ${v}`);
    while (rest >= 0x80n) {
      this.chunks.push(Number(rest & 0x7fn) | 0x80);
      rest >>= 7n;
    }
    this.chunks.push(Number(rest));
    return this;
  }
  done(): Uint8Array {
    return Uint8Array.from(this.chunks);
  }
}

export class ByteReader {
  private o = 0;
  private readonly buf: Uint8Array;

  constructor(buf: Uint8Array) {
    this.buf = buf;
  }
  get offset(): number {
    return this.o;
  }
  get remaining(): number {
    return this.buf.length - this.o;
  }
  private need(n: number): void {
    if (this.o + n > this.buf.length) throw new Error("unexpected end of input");
  }
  u8(): number {
    this.need(1);
    return this.buf[this.o++]!;
  }
  u16(): number {
    this.need(2);
    const v = (this.buf[this.o]! << 8) | this.buf[this.o + 1]!;
    this.o += 2;
    return v;
  }
  u32(): number {
    this.need(4);
    const v =
      this.buf[this.o]! * 0x1000000 +
      (this.buf[this.o + 1]! << 16) +
      (this.buf[this.o + 2]! << 8) +
      this.buf[this.o + 3]!;
    this.o += 4;
    return v;
  }
  u64(): bigint {
    return bytesToBigInt(this.bytes(8));
  }
  bytes(n: number): Uint8Array {
    this.need(n);
    const out = this.buf.subarray(this.o, this.o + n);
    this.o += n;
    return out;
  }
  word(): Uint8Array {
    return Uint8Array.from(this.bytes(32));
  }
  /** A canonical uvarint of at most `maxBytes` bytes: no trailing zero group. */
  biguvarint(maxBytes: number): bigint {
    let value = 0n;
    for (let index = 0; index < maxBytes; index++) {
      const byte = this.u8();
      value |= BigInt(byte & 0x7f) << BigInt(7 * index);
      if ((byte & 0x80) === 0) {
        if (byte === 0 && index > 0) throw new Error("uvarint is not canonical");
        return value;
      }
    }
    throw new Error(`uvarint exceeds ${maxBytes} bytes`);
  }
  /** A canonical uvarint no larger than `max`. */
  uvarint(max = Number.MAX_SAFE_INTEGER): number {
    const value = this.biguvarint(uvarintLength(max));
    if (value > BigInt(max)) throw new Error(`uvarint exceeds ${max}`);
    return Number(value);
  }
  slice(start: number, end: number): Uint8Array {
    if (start < 0 || end < start || end > this.buf.length) throw new Error("invalid reader slice");
    return Uint8Array.from(this.buf.subarray(start, end));
  }
  atEnd(): boolean {
    return this.o === this.buf.length;
  }
}

/** Bytes of the canonical uvarint encoding of `value`. */
export function uvarintLength(value: number | bigint): number {
  let rest = BigInt(value);
  if (rest < 0n) throw new Error(`uvarint must be nonnegative: ${value}`);
  let length = 1;
  while (rest >= 0x80n) {
    rest >>= 7n;
    length++;
  }
  return length;
}
