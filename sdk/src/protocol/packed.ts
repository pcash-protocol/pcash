// Packed application records: one declaration yields a schema's encoder and decoder.
//
// Fields are positional and carry no tags or names; the four-byte application ID
// names the layout, so a new layout takes a new name. Integers and lengths are
// canonical unsigned LEB128. A struct gathers its flags and the presence bits of
// its optional fields into leading bitmap bytes, field i at bit 7 − (i mod 8) of
// byte ⌊i / 8⌋. A `rest` field takes no length: it runs to the end of the record,
// so it is only ever the last field. Decoding is strict, because records arrive
// from L1: a value has exactly one encoding and a record has no trailing bytes.
// A list item takes at least one byte, so decoding work is bounded by the
// record's length.

import { toAddressField, toField } from "../crypto/field.ts";
import { ByteReader, ByteWriter } from "../utils/byteCursor.ts";
import { beBytes, bytesToBigInt, utf8 } from "../utils/bytes.ts";
import { applicationSchemaId, type RecordSchema } from "./records.ts";

/** A codec with a self-delimiting encoding, usable anywhere in a record. */
export interface PackedCodec<T> {
  readonly kind: "value";
  write(writer: ByteWriter, value: T): void;
  read(reader: ByteReader): T;
}

/** A codec that consumes the rest of the record. */
export interface RestCodec<T> {
  readonly kind: "rest";
  write(writer: ByteWriter, value: T): void;
  read(reader: ByteReader): T;
}

/** A boolean struct field stored as one bitmap bit. */
export interface FlagField {
  readonly kind: "flag";
}

/** A struct field whose presence is one bitmap bit. */
export interface OptionalField<T> {
  readonly kind: "optional";
  readonly inner: PackedCodec<T>;
}

export type StructField = PackedCodec<any> | RestCodec<any> | FlagField | OptionalField<any>;

type FieldValue<F> = F extends FlagField ? boolean
  : F extends OptionalField<infer T> ? T
  : F extends PackedCodec<infer T> | RestCodec<infer T> ? T
  : never;

type Simplify<T> = { [K in keyof T]: T[K] } & {};

export type StructValue<F extends Record<string, StructField>> = Simplify<
  { [K in keyof F as F[K] extends OptionalField<any> ? never : K]: FieldValue<F[K]> }
  & { [K in keyof F as F[K] extends OptionalField<any> ? K : never]?: FieldValue<F[K]> }
>;

/** A record holds at most this many bytes, so no length or count exceeds it. */
const MAX_LENGTH = 0xffff;
const ADDRESS_BYTES = 20;
const FIELD_BYTES = 32;
const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function value<T>(write: (writer: ByteWriter, value: T) => void, read: (reader: ByteReader) => T): PackedCodec<T> {
  return { kind: "value", write, read };
}

function encodeText(text: string): Uint8Array {
  const bytes = utf8(text);
  if (UTF8.decode(bytes) !== text) throw new Error("text must be valid UTF-8");
  return bytes;
}

function assertLength(length: number): void {
  if (length > MAX_LENGTH) throw new Error(`length ${length} exceeds ${MAX_LENGTH}`);
}

const u8 = value<number>(
  (writer, input) => {
    if (!Number.isInteger(input) || input < 0 || input > 0xff) throw new Error(`u8 out of range: ${input}`);
    writer.u8(input);
  },
  (reader) => reader.u8(),
);

/** A nonnegative safe integer as a canonical LEB128 uvarint. */
const uint = value<number>(
  (writer, input) => {
    if (!Number.isSafeInteger(input) || input < 0) throw new Error(`uint must be a nonnegative safe integer: ${input}`);
    writer.uvarint(input);
  },
  (reader) => reader.uvarint(),
);

/** An unsigned integer below 2^bits as a canonical LEB128 uvarint. */
function bigUint(bits = 256): PackedCodec<bigint> {
  if (!Number.isSafeInteger(bits) || bits < 1) throw new Error(`bigUint width must be a positive integer: ${bits}`);
  const limit = 1n << BigInt(bits);
  return value(
    (writer, input) => {
      if (input < 0n || input >= limit) throw new Error(`integer must be below 2^${bits}`);
      writer.uvarint(input);
    },
    (reader) => {
      const decoded = reader.biguvarint(Math.ceil(bits / 7));
      if (decoded >= limit) throw new Error(`integer must be below 2^${bits}`);
      return decoded;
    },
  );
}

/** Exactly `length` bytes, or a uvarint length and the bytes when `length` is omitted. */
function bytes(length?: number): PackedCodec<Uint8Array> {
  if (length !== undefined) {
    return value(
      (writer, input) => {
        if (input.length !== length) throw new Error(`expected ${length} bytes, got ${input.length}`);
        writer.bytes(input);
      },
      (reader) => Uint8Array.from(reader.bytes(length)),
    );
  }
  return value(
    (writer, input) => {
      assertLength(input.length);
      writer.uvarint(input.length).bytes(input);
    },
    (reader) => Uint8Array.from(reader.bytes(reader.uvarint(MAX_LENGTH))),
  );
}

/** UTF-8 text behind a uvarint byte length. */
function text(): PackedCodec<string> {
  return value(
    (writer, input) => {
      const encoded = encodeText(input);
      assertLength(encoded.length);
      writer.uvarint(encoded.length).bytes(encoded);
    },
    (reader) => UTF8.decode(reader.bytes(reader.uvarint(MAX_LENGTH))),
  );
}

/** A BN254 field element as its canonical 32-byte big-endian encoding. */
const field = value<bigint>(
  (writer, input) => {
    writer.bytes(beBytes(toField(input), FIELD_BYTES));
  },
  (reader) => toField(bytesToBigInt(reader.bytes(FIELD_BYTES))),
);

/** A 20-byte address as a bigint. */
const address = value<bigint>(
  (writer, input) => {
    writer.bytes(beBytes(toAddressField(input, "address"), ADDRESS_BYTES));
  },
  (reader) => bytesToBigInt(reader.bytes(ADDRESS_BYTES)),
);

/**
 * A uvarint count followed by each item. Every item takes at least one byte,
 * so a record's length bounds how many items it decodes, nested lists included.
 */
function list<T>(item: PackedCodec<T>): PackedCodec<T[]> {
  return value(
    (writer, items) => {
      assertLength(items.length);
      writer.uvarint(items.length);
      for (const entry of items) {
        const start = writer.length;
        item.write(writer, entry);
        if (writer.length === start) throw new Error("a list item must take at least one byte");
      }
    },
    (reader) => {
      const count = reader.uvarint(MAX_LENGTH);
      const items: T[] = [];
      while (items.length < count) {
        const start = reader.offset;
        items.push(item.read(reader));
        if (reader.offset === start) throw new Error("a list item must take at least one byte");
      }
      return items;
    },
  );
}

const flag: FlagField = { kind: "flag" };

function optional<T>(inner: PackedCodec<T>): OptionalField<T> {
  return { kind: "optional", inner };
}

/**
 * Fields in declaration order behind a bitmap of the flag and optional fields.
 * A struct whose last field is a `rest` codec is itself a `rest` codec.
 */
function struct<F extends Record<string, StructField>>(fields: F): [Extract<F[keyof F], RestCodec<any>>] extends [never]
  ? PackedCodec<StructValue<F>>
  : RestCodec<StructValue<F>>;
function struct<F extends Record<string, StructField>>(fields: F): PackedCodec<StructValue<F>> | RestCodec<StructValue<F>> {
  const entries = Object.entries(fields);
  entries.forEach(([name, field], index) => {
    if (field.kind === "rest" && index !== entries.length - 1) throw new Error(`rest field ${name} must be the last field`);
  });
  const bitFields = entries.filter(([, field]) => field.kind === "flag" || field.kind === "optional").map(([name]) => name);
  const bitmapBytes = Math.ceil(bitFields.length / 8);
  const bitOf = new Map(bitFields.map((name, index) => [name, index]));
  const write = (writer: ByteWriter, input: StructValue<F>) => {
    const record = input as Record<string, unknown>;
    const bitmap = new Uint8Array(bitmapBytes);
    for (const [name, field] of entries) {
      const set = field.kind === "flag" ? record[name] === true : field.kind === "optional" && record[name] !== undefined;
      if (set) bitmap[bitOf.get(name)! >> 3]! |= 0x80 >> (bitOf.get(name)! & 7);
    }
    writer.bytes(bitmap);
    for (const [name, field] of entries) {
      if (field.kind === "optional") {
        if (record[name] !== undefined) field.inner.write(writer, record[name]);
      } else if (field.kind !== "flag") {
        field.write(writer, record[name]);
      }
    }
  };
  const read = (reader: ByteReader) => {
    const bitmap = reader.bytes(bitmapBytes);
    const unused = bitmapBytes * 8 - bitFields.length;
    if (unused > 0 && (bitmap[bitmapBytes - 1]! & ((1 << unused) - 1)) !== 0) throw new Error("struct bitmap sets unused bits");
    const isSet = (name: string) => (bitmap[bitOf.get(name)! >> 3]! & (0x80 >> (bitOf.get(name)! & 7))) !== 0;
    const result: Record<string, unknown> = {};
    for (const [name, field] of entries) {
      if (field.kind === "flag") result[name] = isSet(name);
      else if (field.kind === "optional") {
        if (isSet(name)) result[name] = field.inner.read(reader);
      } else result[name] = field.read(reader);
    }
    return result as StructValue<F>;
  };
  const last = entries.at(-1)?.[1];
  return last?.kind === "rest" ? { kind: "rest", write, read } : { kind: "value", write, read };
}

/** The remaining record bytes, with no length. */
function restBytes(): RestCodec<Uint8Array> {
  return {
    kind: "rest",
    write: (writer, input) => {
      writer.bytes(input);
    },
    read: (reader) => Uint8Array.from(reader.bytes(reader.remaining)),
  };
}

/** The remaining record bytes as UTF-8 text, with no length. */
function restText(): RestCodec<string> {
  return {
    kind: "rest",
    write: (writer, input) => {
      writer.bytes(encodeText(input));
    },
    read: (reader) => UTF8.decode(reader.bytes(reader.remaining)),
  };
}

export const packed = {
  u8,
  uint,
  bigUint,
  bytes,
  text,
  field,
  address,
  list,
  flag,
  optional,
  struct,
  rest: { bytes: restBytes, text: restText },
};

/**
 * An application record schema: the four-byte ID derived from `name`, and the
 * codec's encoder and decoder. `decode` throws on malformed or noncanonical
 * data, including trailing bytes; `readRecord` turns that into `undefined`.
 */
export function defineRecordSchema<T>(name: string, codec: PackedCodec<T> | RestCodec<T>): RecordSchema<T> {
  const id = applicationSchemaId(name);
  return {
    id,
    encode(input) {
      const writer = new ByteWriter();
      codec.write(writer, input);
      const data = writer.done();
      assertLength(data.length);
      return { schema: id, data };
    },
    decode(data) {
      const reader = new ByteReader(data);
      const decoded = codec.read(reader);
      if (!reader.atEnd()) throw new Error(`${name} record has trailing bytes`);
      return decoded;
    },
  };
}
