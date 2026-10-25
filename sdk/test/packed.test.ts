// Packed application record codecs: canonical LEB128, struct bitmaps, rest
// fields, strict decoding, and a record carried through a public segment.

import { describe, expect, it } from "vitest";
import { BN254_SCALAR_MODULUS } from "../src/crypto/field.ts";
import { defineRecordSchema, packed } from "../src/protocol/packed.ts";
import { applicationSchemaId, encodeRecords, readRecord, memoSchema } from "../src/protocol/records.ts";
import { readPublicRecords } from "../src/protocol/arena.ts";
import { sealSectionDelivery } from "../src/protocol/sectionDelivery.ts";
import { ByteReader, ByteWriter } from "../src/utils/byteCursor.ts";
import { fromHex, toHex } from "../src/utils/hex.ts";

const boardPost = defineRecordSchema("org.example.board.post", packed.struct({
  encrypted: packed.flag,
  parent: packed.optional(packed.bytes(8)),
  title: packed.optional(packed.text()),
  body: packed.rest.text(),
}));

const encode = <T>(codec: { write(writer: ByteWriter, value: T): void }, value: T) => {
  const writer = new ByteWriter();
  codec.write(writer, value);
  return toHex(writer.done());
};
const decode = <T>(codec: { read(reader: ByteReader): T }, hex: string) => codec.read(new ByteReader(fromHex(hex)));

describe("uvarint", () => {
  it("encodes canonical LEB128", () => {
    for (const [value, hex] of [
      [0, "0x00"], [1, "0x01"], [127, "0x7f"], [128, "0x8001"], [300, "0xac02"],
      [16383, "0xff7f"], [16384, "0x808001"], [Number.MAX_SAFE_INTEGER, "0xffffffffffffff0f"],
    ] as const) {
      expect(encode(packed.uint, value)).toBe(hex);
      expect(decode(packed.uint, hex)).toBe(value);
    }
  });

  it("rejects noncanonical, overlong, truncated, and oversized encodings", () => {
    for (const hex of ["0x8000", "0x8100", "0xff8000", "0x80", "0xffffffffffffff7f", "0xffffffffffffffff01"]) {
      expect(() => decode(packed.uint, hex)).toThrow();
    }
    expect(() => encode(packed.uint, -1)).toThrow();
    expect(() => encode(packed.uint, 1.5)).toThrow();
    expect(() => encode(packed.uint, Number.MAX_SAFE_INTEGER + 1)).toThrow();
  });

  it("bounds big integers by their bit width", () => {
    const u128 = packed.bigUint(128);
    const max = (1n << 128n) - 1n;
    expect(decode(u128, encode(u128, max))).toBe(max);
    expect(encode(u128, max).length).toBe(2 + 2 * 19);
    expect(() => encode(u128, max + 1n)).toThrow(/2\^128/);
    const over = new ByteWriter().uvarint(max + 1n).done();
    expect(() => u128.read(new ByteReader(over))).toThrow(/2\^128/);
    // A zero-bit integer could encode 0 but never decode it, so it is not a codec.
    for (const bits of [0, -1, 1.5]) expect(() => packed.bigUint(bits)).toThrow(/positive integer/);
    expect(decode(packed.bigUint(1), encode(packed.bigUint(1), 1n))).toBe(1n);
  });
});

describe("structs", () => {
  it("packs flags and optional presence into leading bitmap bytes", () => {
    // encrypted = bit 0, parent = bit 1, title = bit 2: 0b0100_0000.
    const post = { encrypted: false, parent: new Uint8Array(8).fill(0x11), body: "hi" };
    const record = boardPost.encode(post);
    expect(record.schema).toBe(applicationSchemaId("org.example.board.post"));
    expect(toHex(record.data)).toBe("0x40" + "11".repeat(8) + "6869");
    expect(boardPost.decode(record.data)).toEqual(post);
    // Record framing adds ID (4) and a one-byte length: 16 bytes for this reply.
    expect(encodeRecords([record])).toHaveLength(16);
    const thread = { encrypted: true, title: "Hello", body: "" };
    expect(toHex(boardPost.encode(thread).data)).toBe("0xa0" + "05" + "48656c6c6f");
    expect(boardPost.decode(boardPost.encode(thread).data)).toEqual(thread);
  });

  it("uses one bitmap bit per flag or optional field, across bytes", () => {
    const fields = Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`f${index}`, packed.flag]));
    const nine = packed.struct(fields);
    const value = Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`f${index}`, index === 0 || index === 8]));
    expect(encode(nine, value)).toBe("0x8080");
    expect(decode(nine, "0x8080")).toEqual(value);
    expect(() => decode(nine, "0x8040")).toThrow(/unused bits/);
    expect(encode(packed.struct({ a: packed.u8 }), { a: 7 })).toBe("0x07");
  });

  it("bounds list items by the record's bytes, rejecting items that take none", () => {
    // 25 bytes declaring 8 × 65,535 empty structs: refused at the first item, not allocated.
    const writer = new ByteWriter().uvarint(8);
    for (let index = 0; index < 8; index++) writer.uvarint(65_535);
    const nested = defineRecordSchema("com.example.rows", packed.list(packed.list(packed.struct({}))));
    expect(() => nested.decode(writer.done())).toThrow(/at least one byte/);
    expect(() => decode(packed.list(packed.bytes(0)), "0x02")).toThrow(/at least one byte/);
    // The encoder refuses what the decoder would, so every encoded record decodes.
    expect(() => nested.encode([[{}]])).toThrow(/at least one byte/);
    expect(() => encode(packed.list(packed.bytes(0)), [new Uint8Array(0)])).toThrow(/at least one byte/);
    // An empty list of them still takes its count byte.
    expect(nested.decode(nested.encode([[]]).data)).toEqual([[]]);
  });

  it("allows a rest field only last, and only a rest-ended struct at the end", () => {
    expect(() => packed.struct({ body: packed.rest.text(), after: packed.u8 })).toThrow(/last field/);
    const outer = packed.struct({ head: packed.u8, tail: packed.struct({ id: packed.u8, rest: packed.rest.bytes() }) });
    expect(outer.kind).toBe("rest");
    expect(encode(outer, { head: 1, tail: { id: 2, rest: Uint8Array.of(3, 4) } })).toBe("0x01020304");
  });

  it("round-trips lists, addresses, field elements, and length-prefixed bytes", () => {
    const codec = packed.struct({ owners: packed.list(packed.address), blob: packed.bytes(), note: packed.text() });
    const value = { owners: [1n, (1n << 160n) - 1n], blob: Uint8Array.of(9, 9), note: "é" };
    const hex = encode(codec, value);
    expect(hex).toBe("0x02" + "00".repeat(19) + "01" + "ff".repeat(20) + "020909" + "02c3a9");
    expect(decode(codec, hex)).toEqual(value);
    expect(() => encode(packed.address, 1n << 160n)).toThrow();
    const top = BN254_SCALAR_MODULUS - 1n;
    expect(decode(packed.field, encode(packed.field, top))).toBe(top);
    expect(encode(packed.field, 5n)).toBe("0x" + "00".repeat(31) + "05");
    expect(() => encode(packed.field, BN254_SCALAR_MODULUS)).toThrow(/field element/);
    expect(() => decode(packed.field, "0x" + BN254_SCALAR_MODULUS.toString(16).padStart(64, "0"))).toThrow(/field element/);
    expect(() => encode(packed.bytes(8), new Uint8Array(7))).toThrow(/8 bytes/);
    expect(() => encode(packed.u8, 256)).toThrow(/u8/);
  });
});

describe("record schemas", () => {
  it("decode strictly: trailing bytes, truncation, and invalid UTF-8 all fail", () => {
    const pair = defineRecordSchema("com.example.pair", packed.struct({ a: packed.u8, b: packed.text() }));
    expect(pair.decode(Uint8Array.of(1, 1, 0x61))).toEqual({ a: 1, b: "a" });
    expect(() => pair.decode(Uint8Array.of(1, 1, 0x61, 0))).toThrow(/trailing/);
    expect(() => pair.decode(Uint8Array.of(1, 2, 0x61))).toThrow();
    expect(() => pair.decode(Uint8Array.of(1, 1, 0xff))).toThrow();
    expect(() => boardPost.decode(Uint8Array.of(0, 0xc3))).toThrow();
    expect(() => pair.encode({ a: 1, b: "\ud800" })).toThrow(/UTF-8/);
  });

  it("reads a typed record from a list, treating malformed data as absent", () => {
    const reply = boardPost.encode({ encrypted: false, parent: new Uint8Array(8), body: "ok" });
    expect(readRecord([memoSchema.encode("x"), reply], boardPost)).toEqual({ encrypted: false, parent: new Uint8Array(8), body: "ok" });
    expect(readRecord([memoSchema.encode("x")], boardPost)).toBeUndefined();
    expect(readRecord([{ schema: boardPost.id, data: Uint8Array.of(0x01) }], boardPost)).toBeUndefined();
    expect(readRecord(null, boardPost)).toBeUndefined();
  });

  it("publishes a packed record that any reader decodes from the arena alone", () => {
    const context = { chainId: 1n, transactionType: 0 as const, nullifiers: [1n, 2n, 3n, 4n] };
    const post = { encrypted: false, title: "Thread", body: "First post" };
    const sealed = sealSectionDelivery({ shape: 0, context, envelopes: [], data: { public: [boardPost.encode(post)] } });
    expect(readRecord(readPublicRecords(sealed.arena), boardPost)).toEqual(post);
  });
});
