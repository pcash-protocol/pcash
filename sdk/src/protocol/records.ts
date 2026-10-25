import { sha256 } from "@noble/hashes/sha2.js";
import { ByteReader, ByteWriter } from "../utils/byteCursor.ts";
import { concatBytes, utf8 } from "../utils/bytes.ts";
import { fromHex, toHex } from "../utils/hex.ts";

/** Canonical lowercase hex wire identifier and opaque record content. */
export interface DataRecord {
  schema: string;
  data: Uint8Array;
}

export const RECORD_SCHEMA = {
  memo: "0x01",
  assetDefinition: "0x02",
  sender: "0x03",
  sentEnvelopes: "0x04",
  sentOpenings: "0x05",
} as const;

const BUILTIN = new Set<string>(Object.values(RECORD_SCHEMA));
/** The top bit of an identifier's first byte marks a four-byte application ID. */
const APPLICATION_FLAG = 0x80;
export const APPLICATION_ID_BYTES = 4;
export const MAX_RECORD_BYTES = 0xffff;

export function isBuiltinSchema(schema: string): boolean {
  return BUILTIN.has(schema);
}

function isApplicationSchema(schema: string): boolean {
  return /^0x[89a-f][0-9a-f]{7}$/.test(schema);
}

/** Names are local labels; only the first four SHA-256 bytes, top bit set, travel on the wire. */
export function applicationSchemaId(name: string): string {
  if (name.length > 255 || !/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/.test(name)) {
    throw new Error("application schema name must be a namespaced ASCII identifier of at most 255 bytes");
  }
  const id = sha256(utf8(name)).slice(0, APPLICATION_ID_BYTES);
  id[0]! |= APPLICATION_FLAG;
  return toHex(id);
}

/** Records are `identifier ‖ uvarint dataLength ‖ data`, ordered by identifier bytes. */
export function encodeRecords(records: readonly DataRecord[]): Uint8Array {
  const sorted = [...records].sort((a, b) => a.schema < b.schema ? -1 : a.schema > b.schema ? 1 : 0);
  return concatBytes(...sorted.map(({ schema, data }, index) => {
    if (!isBuiltinSchema(schema) && !isApplicationSchema(schema)) {
      throw new Error("record schema must be a standard ID or a four-byte application ID with its top bit set");
    }
    if (index > 0 && sorted[index - 1]!.schema === schema) throw new Error(`duplicate record schema ${schema}`);
    if (data.length > MAX_RECORD_BYTES) throw new Error(`record ${schema} exceeds ${MAX_RECORD_BYTES} bytes`);
    return concatBytes(new ByteWriter().bytes(fromHex(schema)).uvarint(data.length).done(), data);
  }));
}

/**
 * Untrusted arena bytes: validate framing once, retaining unknown application IDs as opaque data.
 * A padded list, as in a region, ends at a zero byte where the next identifier would begin, and
 * every byte after it must be zero; an unpadded list, as in the public segment, fills `payload`.
 */
export function decodeRecords(payload: Uint8Array, padded = false): DataRecord[] {
  const reader = new ByteReader(payload);
  const result: DataRecord[] = [];
  let previous = "";
  while (!reader.atEnd()) {
    if (padded && payload[reader.offset] === 0) {
      if (payload.subarray(reader.offset).some((byte) => byte !== 0)) throw new Error("record list padding must be zero");
      break;
    }
    const size = (payload[reader.offset]! & APPLICATION_FLAG) === 0 ? 1 : APPLICATION_ID_BYTES;
    const schema = toHex(reader.bytes(size));
    if (size === 1 && !isBuiltinSchema(schema)) throw new Error("unknown standard record ID");
    if (schema <= previous) throw new Error("record schemas must be unique and canonically ordered");
    const length = reader.uvarint(MAX_RECORD_BYTES);
    result.push({ schema, data: Uint8Array.from(reader.bytes(length)) });
    previous = schema;
  }
  return result;
}

export interface RecordSchema<T> {
  readonly id: string;
  encode(value: T): DataRecord;
  decode(data: Uint8Array): T;
}

/** The decoded record of `schema`, or undefined when it is absent or its untrusted data does not decode. */
export function readRecord<T>(records: readonly DataRecord[] | null | undefined, schema: RecordSchema<T>): T | undefined {
  const record = records?.find(candidate => candidate.schema === schema.id);
  if (record === undefined) return undefined;
  try {
    return schema.decode(record.data);
  } catch {
    return undefined;
  }
}

export const memoSchema: RecordSchema<string> = {
  id: RECORD_SCHEMA.memo,
  encode(text) {
    const data = utf8(text);
    if (new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data) !== text) throw new Error("memo must be valid UTF-8");
    return { schema: RECORD_SCHEMA.memo, data };
  },
  decode(data) {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data);
  },
};

export interface TransactionData {
  recipients?: readonly { to: string; records: readonly DataRecord[] }[];
  self?: readonly DataRecord[];
  /** Application records anyone can read from the arena, in plaintext. */
  public?: readonly DataRecord[];
}

export interface ResolvedTransactionData {
  recipients?: readonly { recipientAddress: bigint; receiveKey: Uint8Array; records: readonly DataRecord[] }[];
  self?: readonly DataRecord[];
  public?: readonly DataRecord[];
}
