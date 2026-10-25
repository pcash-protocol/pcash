import { orderedRecords, recordValue, applicationDataRecords } from "./recordHelpers.ts";
import { sentEnvelopesSchema, sentOpeningsSchema, assetDefinitionSchema, claimedSenderSchema } from "@pcash/sdk/protocol";
import { applicationSchemaId, type DataRecord, encodeRecords, decodeRecords, RECORD_SCHEMA } from "../src/protocol/records.ts";
// Reference arena codec: region capacity, record lists, region layout with
// every reader reject, allocation, context and key binding, recipient regions,
// outgoing-key recovery, and a frozen vector checked against node:crypto.

import { createDecipheriv, hkdfSync } from "node:crypto";
import { gcm } from "@noble/ciphers/aes.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { describe, expect, it } from "vitest";
import arenaVector from "./arena.vector.json" with { type: "json" };
import {
  prepareArena,
  writeArena,
  validateDataRecords,
  ARENA_ANCHOR_PAYLOAD_BYTES,
  ARENA_CELL_BYTES,
  ARENA_SALT_BYTES,
  arenaBitmapBytes,
  arenaCells,
  arenaContextBytes,
  arenaRegionKeys,
  buildArena,
  decodeRecipientPayload,
  decodeSenderPayload,
  openRecipientRecords,
  openRegion,
  openSenderRecords,
  planArena,
  readPublicRecords,
  regionCapacity,
  regionCellsFor,
  type ArenaContext,
  type ArenaRole,
  type BuildArenaInput,
} from "../src/protocol/arena.ts";
import { withArenaRandom } from "../src/protocol/arenaRandom.ts";
import { PRIVATE_VALUE_PROFILES, privateValueProfile, type PrivateValueShape } from "../src/constants/privateValueProfiles.ts";
import { BN254_SCALAR_MODULUS } from "../src/crypto/field.ts";
import { deriveStandardFungibleAssetFromEntropy } from "../src/protocol/asset.ts";
import { assetDefinitionFromCreated, decodeAssetDefinition, encodeAssetDefinition } from "../src/protocol/assetDefinition.ts";
import { uvarintLength } from "../src/utils/byteCursor.ts";
import { beBytes, concatBytes, utf8 } from "../src/utils/bytes.ts";
import { fromHex, toHex } from "../src/utils/hex.ts";

const S = PRIVATE_VALUE_PROFILES.S.shapeId;
const L = PRIVATE_VALUE_PROFILES.L.shapeId;
const SHAPES = [S, L] as const;
const NONCE = new Uint8Array(12);

function contextFor(shape: PrivateValueShape, overrides: Partial<ArenaContext> = {}): ArenaContext {
  const { inputs } = privateValueProfile(shape);
  return {
    chainId: 8182n,
    transactionType: 0,
    nullifiers: Array.from({ length: inputs }, (_, index) => 0x1000n + BigInt(index)),
    ...overrides,
  };
}

const key = (byte: number) => new Uint8Array(32).fill(byte);
const outgoingKey = key(0x0e);

/** Counter-mode SHA-256 stream, so allocations are reproducible. */
function seededRandom(seed: string): (length: number) => Uint8Array {
  let counter = 0;
  let pending: Uint8Array = new Uint8Array(0);
  return (length) => {
    while (pending.length < length) pending = concatBytes(pending, sha256(utf8(`${seed}/${counter++}`)));
    const out = pending.slice(0, length);
    pending = pending.slice(length);
    return out;
  };
}
const zeros = (length: number) => new Uint8Array(length);
const seeded = <T>(seed: string, build: () => T): T => withArenaRandom(seededRandom(seed), build);

const definition = assetDefinitionFromCreated(deriveStandardFungibleAssetFromEntropy({
  assetSecret: 0x5678n,
  initialSupply: 1_000_000n,
  metadata: { name: "Arena Token", symbol: "ARN", decimals: 6, contentDigest: new Uint8Array(32).fill(0xab) },
}));

/** A memo that makes a recipient payload, type (1) ‖ uvarint length ‖ memo, exactly `payloadLength` bytes. */
function memoFor(payloadLength: number): Uint8Array {
  for (let length = payloadLength - 2; length >= 0; length--) {
    if (1 + uvarintLength(length) + length === payloadLength) return new Uint8Array(length).fill(0x4d);
  }
  throw new Error(`no memo makes a ${payloadLength}-byte payload`);
}

const offset = (cell: number) => ARENA_SALT_BYTES + ARENA_CELL_BYTES * cell;
const cellAt = (arena: Uint8Array, cell: number) => arena.subarray(offset(cell), offset(cell + 1));
const block = (bytes: Uint8Array, index: number) => bytes.subarray(65 * index, 65 * (index + 1));
const isZero = (bytes: Uint8Array) => bytes.every((byte) => byte === 0);

interface RegionRef {
  role: ArenaRole;
  ikm: Uint8Array;
  anchor: number;
}

function regionKeys(arena: Uint8Array, shape: PrivateValueShape, context: ArenaContext, role: ArenaRole, ikm: Uint8Array) {
  return arenaRegionKeys(role, ikm, arena.subarray(0, ARENA_SALT_BYTES), arenaContextBytes(shape, context));
}

function anchorPlaintext(arena: Uint8Array, shape: PrivateValueShape, context: ArenaContext, region: RegionRef): Uint8Array {
  return gcm(regionKeys(arena, shape, context, region.role, region.ikm).anchorKey, NONCE).decrypt(cellAt(arena, region.anchor));
}

function bitmapCells(bits: Uint8Array): number[] {
  const cells: number[] = [];
  for (let cell = 0; cell < bits.length * 8; cell++) if ((bits[cell >> 3]! & (0x80 >> (cell & 7))) !== 0) cells.push(cell);
  return cells;
}

/** Anchor followed by continuation cells, read from the decrypted directory. */
function regionCells(arena: Uint8Array, shape: PrivateValueShape, context: ArenaContext, region: RegionRef): number[] {
  const plaintext = anchorPlaintext(arena, shape, context, region);
  const count = plaintext[0]!;
  const continuation = count === 255
    ? bitmapCells(plaintext.subarray(1, 1 + arenaBitmapBytes(shape)))
    : Array.from(plaintext.subarray(1, 1 + count));
  return [region.anchor, ...continuation];
}

function bitmapOf(cells: readonly number[], bytes: number): Uint8Array {
  const bits = new Uint8Array(bytes);
  for (const cell of cells) bits[cell >> 3]! |= 0x80 >> (cell & 7);
  return bits;
}

/** count (1) ‖ directory ‖ payload prefix ‖ zeros: the 49-byte anchor plaintext. */
function anchorBytes(count: number, directory: ArrayLike<number>, prefix: Uint8Array): Uint8Array {
  const out = new Uint8Array(49);
  out[0] = count;
  out.set(directory, 1);
  out.set(prefix, 1 + directory.length);
  return out;
}

/** Encrypt an arbitrary anchor plaintext (and body) with the real keys, so only the layout can reject it. */
function sealRaw(
  arena: Uint8Array,
  shape: PrivateValueShape,
  context: ArenaContext,
  region: RegionRef & { plaintext: Uint8Array; continuation?: readonly number[]; body?: Uint8Array },
): void {
  const keys = regionKeys(arena, shape, context, region.role, region.ikm);
  const anchorCell = gcm(keys.anchorKey, NONCE).encrypt(region.plaintext);
  arena.set(anchorCell, offset(region.anchor));
  if (region.body === undefined) return;
  const sealed = gcm(keys.bodyKey, NONCE, anchorCell).encrypt(region.body);
  (region.continuation ?? []).forEach((cell, index) => {
    if (cell < arenaCells(shape) && cell !== region.anchor) arena.set(block(sealed, index), offset(cell));
  });
}

/** An anchor plaintext and body holding `payload` behind `directory`, split as the writer splits it. */
function regionParts(count: number, directory: ArrayLike<number>, continuation: number, payload: Uint8Array): { plaintext: Uint8Array; body?: Uint8Array } {
  const prefixLength = Math.min(payload.length, 48 - directory.length);
  const plaintext = anchorBytes(count, directory, payload.subarray(0, prefixLength));
  if (continuation === 0) return { plaintext };
  const body = new Uint8Array(65 * continuation - 16);
  body.set(payload.subarray(prefixLength));
  return { plaintext, body };
}

/** An independent writer of a well-formed region at chosen cells. */
function sealPayload(
  arena: Uint8Array,
  shape: PrivateValueShape,
  context: ArenaContext,
  region: RegionRef & { continuation: readonly number[]; payload: Uint8Array },
): void {
  const bitmapBytes = arenaBitmapBytes(shape);
  const n = region.continuation.length;
  const directory = n <= bitmapBytes ? Uint8Array.from(region.continuation) : bitmapOf(region.continuation, bitmapBytes);
  sealRaw(arena, shape, context, { ...region, ...regionParts(n <= bitmapBytes ? n : 255, directory, n, region.payload) });
}

/** AES-GCM ciphertext before the tag is plaintext XOR this keystream. */
function keystream(bodyKey: Uint8Array, length: number): Uint8Array {
  return gcm(bodyKey, NONCE).encrypt(new Uint8Array(length)).subarray(0, length);
}

/** The first of a bounded run of seeds whose result satisfies `found`. */
function searchSeeds<T>(prefix: string, make: (seed: string) => T, found: (value: T) => boolean): T {
  for (let index = 0; index < 4096; index++) {
    const value = make(`${prefix}-${index}`);
    if (found(value)) return value;
  }
  throw new Error(`no ${prefix} seed satisfies the search`);
}

function chiSquare(bytes: Uint8Array): number {
  const counts = new Array<number>(256).fill(0);
  for (const byte of bytes) counts[byte]!++;
  const expected = bytes.length / 256;
  return counts.reduce((sum, count) => sum + (count - expected) ** 2 / expected, 0);
}

const schema = (type: number) => Object.values(RECORD_SCHEMA)[type - 1] ?? applicationSchemaId(`com.example.record${String(type).padStart(3, "0")}`);
const record = (type: number, data: ArrayLike<number>) => encodeRecords([{ schema: schema(type), data: Uint8Array.from(data) }]);
const recordsTogether = (...records: Uint8Array[]) => encodeRecords(records.flatMap((list) => decodeRecords(list)));
const senderView = (records: readonly DataRecord[]) => ({
  records: orderedRecords(records.filter(record => record.schema !== RECORD_SCHEMA.sentEnvelopes && record.schema !== RECORD_SCHEMA.sentOpenings)),
  sentEnvelopes: recordValue(records, sentEnvelopesSchema) ?? [],
  sentOpenings: recordValue(records, sentOpeningsSchema) ?? [],
});

describe("arena writer input graph", () => {
  const recipient = { slot: 0, sharedSecret: key(1), records: [] };
  for (const [name, prepare] of [["prepareArena", prepareArena], ["buildArena", buildArena]] as const) {
    it(`${name} requires distinct, in-range integer slots even for recipients without records`, () => {
      const input = { shape: S, context: contextFor(S) };
      withArenaRandom(() => { throw new Error("must not allocate invalid input"); }, () => {
        expect(() => prepare({ ...input, recipients: [recipient, recipient] })).toThrow(/duplicate arena recipient slot/);
        for (const slot of [-1, 0.5, NaN, PRIVATE_VALUE_PROFILES.S.outputs]) {
          expect(() => prepare({ ...input, recipients: [{ ...recipient, slot }] })).toThrow(/slot is out of range/);
        }
      });
    });
  }

  it("ignores a random source passed as an input property", () => {
    const input = { shape: S, context: contextFor(S), recipients: [], random: zeros } as BuildArenaInput;
    expect(isZero(buildArena(input).salt)).toBe(false);
  });
});

describe("arena geometry", () => {
  it("derives cells, bitmap bytes, and the one-cell capacity from the profile", () => {
    expect(ARENA_SALT_BYTES).toBe(32);
    expect(ARENA_CELL_BYTES).toBe(65);
    expect(ARENA_ANCHOR_PAYLOAD_BYTES).toBe(48);
    expect([arenaCells(S), arenaBitmapBytes(S)]).toEqual([40, 5]);
    expect([arenaCells(L), arenaBitmapBytes(L)]).toEqual([256, 32]);
    for (const shape of SHAPES) {
      expect(ARENA_SALT_BYTES + ARENA_CELL_BYTES * arenaCells(shape)).toBe(privateValueProfile(shape).arenaBytes);
    }
  });

  it("matches 65k − 33 − min(k − 1, B) for every region size beyond one cell", () => {
    for (const shape of SHAPES) {
      const bitmapBytes = arenaBitmapBytes(shape);
      for (let k = 1; k <= arenaCells(shape); k++) {
        expect(regionCapacity(k, shape)).toBe(k === 1 ? 48 : 65 * k - 33 - Math.min(k - 1, bitmapBytes));
      }
      expect(() => regionCapacity(0, shape)).toThrow(/region cells/);
      expect(() => regionCapacity(arenaCells(shape) + 1, shape)).toThrow(/region cells/);
    }
    expect([1, 2, 6, 7, 40].map((k) => regionCapacity(k, S))).toEqual([48, 96, 352, 417, 2562]);
    expect([33, 34, 47, 48, 256].map((k) => regionCapacity(k, L))).toEqual([2080, 2145, 2990, 3055, 16575]);
  });

  it("chooses the fewest cells for a payload", () => {
    for (const shape of SHAPES) {
      const cells = arenaCells(shape);
      expect(regionCellsFor(0, shape)).toBe(1);
      for (let k = 1; k <= cells; k++) {
        expect(regionCellsFor(regionCapacity(k, shape), shape)).toBe(k);
        if (k < cells) expect(regionCellsFor(regionCapacity(k, shape) + 1, shape)).toBe(k + 1);
      }
      expect(() => regionCellsFor(regionCapacity(cells, shape) + 1, shape)).toThrow(/exceeds/);
    }
    expect([48, 49].map((length) => regionCellsFor(length, S))).toEqual([1, 2]);
    // A 103-byte asset-definition record takes three cells.
    expect(regionCellsFor(103, S)).toBe(3);
    expect([2990, 2991, 3055, 3056].map((length) => regionCellsFor(length, L))).toEqual([47, 48, 48, 49]);
  });

  it("plans cell usage, counting the reserved sender cell once, and reports overflow without throwing", () => {
    expect(planArena({ shape: S, sender: 0, regions: [48, 49, 2497] })).toEqual({
      cellsPerRegion: [1, 2, 39], senderCells: 1, publicCells: 0, usedCells: 43, totalCells: 40, fits: false,
    });
    expect(planArena({ shape: S, sender: 0, regions: [2497] })).toMatchObject({ usedCells: 40, fits: true });
    // Cell C − 1 stays reserved without a sender region.
    expect(planArena({ shape: S, regions: [2497] })).toMatchObject({ senderCells: 0, usedCells: 40, fits: true });
    expect(planArena({ shape: S, regions: [2498] })).toMatchObject({ usedCells: 41, fits: false });
    expect(planArena({ shape: S, regions: [100_000] }).fits).toBe(false);
    expect(planArena({ shape: L, regions: [] })).toEqual({ cellsPerRegion: [], senderCells: 0, publicCells: 0, usedCells: 1, totalCells: 256, fits: true });
  });
});

describe("arena record lists", () => {
  const applicationRecords = [{ schema: applicationSchemaId("com.example.record007"), data: Uint8Array.of(1) }, { schema: applicationSchemaId("com.example.record200"), data: Uint8Array.of(2, 3) }];
  const senderRecords: readonly DataRecord[] = [sentEnvelopesSchema.encode([
      { slot: 3, sharedSecret: key(3), recipientAddress: 0x33n },
      { slot: 0, sharedSecret: key(1), recipientAddress: (1n << 160n) - 1n },
    ]), sentOpeningsSchema.encode([{ slot: 2, recipientAddress: 0x22n, assetId: BN254_SCALAR_MODULUS - 1n, amount: (1n << 128n) - 1n, noteSecret: 7n }]), assetDefinitionSchema.encode(definition), ...applicationRecords];

  it("round-trips each region kind", () => {
    const records: readonly DataRecord[] = [{ schema: RECORD_SCHEMA.memo, data: utf8("hello") }, assetDefinitionSchema.encode(definition), claimedSenderSchema.encode(0xabcdefn), ...applicationRecords];
    expect(decodeRecipientPayload(encodeRecords(records))).toEqual(orderedRecords(records));
    expect(decodeSenderPayload(encodeRecords(senderRecords), S).sentEnvelopes.map(entry => entry.slot)).toEqual([0, 3]);
    expect(decodeSenderPayload(encodeRecords([]), S)).toEqual({ records: [], sentEnvelopes: [], sentOpenings: [] });
    expect(decodeRecipientPayload(encodeRecords([{ schema: RECORD_SCHEMA.memo, data: new Uint8Array(0) }]))).toEqual([{ schema: RECORD_SCHEMA.memo, data: new Uint8Array(0) }]);
  });

  it("ends a padded list only at a zero identifier byte", () => {
    // Zero bytes inside lengths and data are data: an empty memo, a zero-filled sender, a native-style asset ID.
    const records: readonly DataRecord[] = [
      { schema: RECORD_SCHEMA.memo, data: new Uint8Array(0) },
      claimedSenderSchema.encode(0n),
      { schema: applicationSchemaId("com.example.zeros"), data: new Uint8Array(40) },
    ];
    const list = encodeRecords(records);
    expect(decodeRecipientPayload(list)).toEqual(orderedRecords(records));
    expect(decodeRecipientPayload(concatBytes(list, zeros(30)))).toEqual(orderedRecords(records));
    expect(decodeRecipientPayload(zeros(48))).toEqual([]);
    expect(decodeRecipientPayload(new Uint8Array(0))).toEqual([]);
    // The terminator is the zero at the tail's first byte; anything after it must be zero too.
    for (const position of [1, 29]) {
      const tail = zeros(30);
      tail[position] = 1;
      expect(() => decodeRecipientPayload(concatBytes(list, tail))).toThrow(/padding/);
    }
    // An unpadded list, as in the public segment, has no terminator.
    expect(() => decodeRecords(concatBytes(list, zeros(1)))).toThrow(/unknown standard record ID/);
    expect(decodeRecords(list, true)).toEqual(decodeRecords(list));
  });

  it("lays out compact records in ascending schema order", () => {
    const payload = encodeRecords([{ schema: RECORD_SCHEMA.memo, data: Uint8Array.of(0xaa) }, claimedSenderSchema.encode(0x01n), { schema: applicationSchemaId("com.example.record007"), data: Uint8Array.of(0xbb) }]);
    expect(decodeRecords(payload).map(record => record.schema)).toEqual([RECORD_SCHEMA.memo, RECORD_SCHEMA.sender, applicationSchemaId("com.example.record007")]);
    const sender = encodeRecords([sentEnvelopesSchema.encode([{ slot: 1, sharedSecret: key(6), recipientAddress: 2n }]), sentOpeningsSchema.encode([{ slot: 0, recipientAddress: 3n, assetId: 4n, amount: 5n, noteSecret: 6n }])]);
    const word = (value: number, bytes: number) => [...new Uint8Array(bytes - 1), value];
    expect(toHex(sender)).toBe(toHex(concatBytes(
      record(4, [1, ...key(6), ...word(2, 20)]),
      record(5, [0, ...word(3, 20), ...word(4, 32), ...word(5, 16), ...word(6, 32)]),
    )));
  });

  it("measures payloads with the encoders", () => {
    const records: readonly DataRecord[] = [{ schema: RECORD_SCHEMA.memo, data: new Uint8Array(10) }, claimedSenderSchema.encode(1n)];
    // type (1) ‖ uvarint length (1) ‖ data: 2 + 10 and 2 + 20.
    expect(encodeRecords(records).length).toBe(34);
    expect(encodeRecords([]).length).toBe(0);
    expect(encodeAssetDefinition(definition).length).toBe(99);
    expect(encodeRecords([assetDefinitionSchema.encode(definition)]).length).toBe(2 + encodeAssetDefinition(definition).length);
  });

  it("rejects malformed record lists", () => {
    for (const payload of [
      Uint8Array.of(1),
      Uint8Array.of(1, 5, 1, 2),
      Uint8Array.of(7, 0),
      Uint8Array.of(6, 1, 0),
      Uint8Array.of(1, 0x80, 0x00),
      Uint8Array.of(1, 0x81, 0x00, 1),
      Uint8Array.of(1, 0x80, 0x80, 0x04),
      Uint8Array.of(0x80, 1, 2),
      concatBytes(record(3, new Uint8Array(20)), record(1, [1])),
      concatBytes(record(1, [1]), record(1, [2])),
      Uint8Array.of(1, 120, 0, 1, 1),
    ]) {
      expect(() => decodeRecipientPayload(payload)).toThrow();
    }
  });

  it("allows each record type only in its region kind", () => {
    const sentEnvelope = record(4, [0, ...key(1), ...new Uint8Array(20)]);
    const sentOpening = record(5, [0, ...new Uint8Array(100)]);
    for (const payload of [sentEnvelope, sentOpening]) expect(() => decodeRecipientPayload(payload)).toThrow(/not allowed/);
    expect(applicationDataRecords(decodeSenderPayload(record(7, [1]), S).records ?? [])).toEqual(orderedRecords([{ schema: applicationSchemaId("com.example.record007"), data: Uint8Array.of(1) }]));
  });

  it("drops an asset definition that does not decode, not the region", () => {
    expect(decodeRecipientPayload(recordsTogether(record(1, [9]), record(2, [0xff])))).toEqual(orderedRecords([{ schema: RECORD_SCHEMA.memo, data: Uint8Array.of(9) }]));
    expect(decodeSenderPayload(record(2, [0xff]), S)).toEqual({ records: [], sentEnvelopes: [], sentOpenings: [] });
  });

  it("rejects malformed fixed-size records", () => {
    expect(() => decodeRecipientPayload(record(3, new Uint8Array(19)))).toThrow(/claimed sender/);
    const entry = (slot: number) => [slot, ...key(1), ...new Uint8Array(20)];
    expect(() => decodeSenderPayload(record(4, entry(0).slice(1)), S)).toThrow(/malformed/);
    expect(() => decodeSenderPayload(record(4, [...entry(2), ...entry(1)]), S)).toThrow(/ascending/);
    expect(() => decodeSenderPayload(record(4, [...entry(1), ...entry(1)]), S)).toThrow(/ascending/);
    expect(() => decodeSenderPayload(record(4, entry(5)), S)).toThrow(/below 5/);
    expect(decodeSenderPayload(record(4, entry(5)), L).sentEnvelopes.map(({ slot }) => slot)).toEqual([5]);
    expect(() => decodeSenderPayload(record(5, new Uint8Array(100)), S)).toThrow(/malformed/);
    for (const offset of [21, 69]) {
      const opening = new Uint8Array(101); opening.set(beBytes(BN254_SCALAR_MODULUS, 32), offset);
      expect(() => decodeSenderPayload(record(5, opening), S)).toThrow(/field/);
    }
  });

  it("rejects writer inputs it cannot encode", () => {
    for (const schema of [RECORD_SCHEMA.sentEnvelopes, RECORD_SCHEMA.sentOpenings]) {
      expect(() => validateDataRecords([{ schema, data: Uint8Array.of(1) }])).toThrow(/managed by the SDK/);
    }
    expect(() => encodeRecords([{ schema: applicationSchemaId("com.example.record009"), data: Uint8Array.of(1) }, { schema: applicationSchemaId("com.example.record009"), data: Uint8Array.of(1) }])).toThrow(/duplicate/);
    expect(decodeRecipientPayload(encodeRecords([{ schema: applicationSchemaId("com.example.record009"), data: new Uint8Array(0) }]))).toEqual([{ schema: applicationSchemaId("com.example.record009"), data: new Uint8Array(0) }]);
    expect(() => encodeRecords([{ schema: RECORD_SCHEMA.memo, data: new Uint8Array(0x10000) }])).toThrow(/65535/);
    expect(() => encodeRecords([claimedSenderSchema.encode(1n << 160n)])).toThrow(/160 bits/);
    const envelope = { slot: 1, sharedSecret: key(1), recipientAddress: 1n };
    expect(() => encodeRecords([sentEnvelopesSchema.encode([envelope, envelope])])).toThrow(/repeat slot/);
    expect(() => encodeRecords([sentEnvelopesSchema.encode([{ ...envelope, sharedSecret: new Uint8Array(31) }])])).toThrow(/32 bytes/);
    expect(() => encodeRecords([sentOpeningsSchema.encode([{ slot: 0, recipientAddress: 1n, assetId: BN254_SCALAR_MODULUS, amount: 1n, noteSecret: 1n }])])).toThrow(/assetId/);
  });
});

describe("arena regions", () => {
  it("round-trips sender and recipient regions", () => {
    for (const shape of SHAPES) {
      const context = contextFor(shape);
      const sender: readonly DataRecord[] = [sentEnvelopesSchema.encode([{ slot: 1, sharedSecret: key(1), recipientAddress: 0x11n }])];
      const own: readonly DataRecord[] = [{ schema: RECORD_SCHEMA.memo, data: new Uint8Array(300).fill(7) }, assetDefinitionSchema.encode(definition)];
      const built = buildArena({ shape, context, sender: { outgoingKey, records: sender }, recipients: [{ slot: 1, sharedSecret: key(1), records: own }] });
      expect(built.arena.length).toBe(privateValueProfile(shape).arenaBytes);
      expect(built.salt).toEqual(built.arena.subarray(0, ARENA_SALT_BYTES));
      expect(openSenderRecords({ arena: built.arena, shape, context, outgoingKey })).toEqual(senderView(sender));
      const anchor = built.recipientAnchors.get(1)!;
      expect(openRecipientRecords({ arena: built.arena, shape, context, sharedSecret: key(1), anchor })).toEqual(orderedRecords(own));
      // The region's payload is its record list, then zeros.
      const payload = openRegion({ arena: built.arena, shape, context, role: "recipient", ikm: key(1), anchor })!;
      const list = encodeRecords(own);
      expect(payload.subarray(0, list.length)).toEqual(list);
      expect(isZero(payload.subarray(list.length))).toBe(true);
    }
  });

  it("fits 48 payload bytes in one cell and 49 in two", () => {
    const context = contextFor(S);
    for (const [payloadLength, cells] of [[48, 1], [49, 2]] as const) {
      const records = [{ schema: RECORD_SCHEMA.memo, data: memoFor(payloadLength) }];
      expect(encodeRecords(records).length).toBe(payloadLength);
      const built = buildArena({ shape: S, context, recipients: [{ slot: 0, sharedSecret: key(1), records }] });
      const region = { role: "recipient" as const, ikm: key(1), anchor: built.recipientAnchors.get(0)! };
      expect(regionCells(built.arena, S, context, region)).toHaveLength(cells);
      expect(openRecipientRecords({ arena: built.arena, shape: S, context, sharedSecret: key(1), anchor: region.anchor })).toEqual(orderedRecords(records));
    }
  });

  it("round-trips a region at every cell count in both profiles", () => {
    for (const shape of SHAPES) {
      const context = contextFor(shape);
      const step = shape === S ? 1 : 17;
      for (let cells = 1; cells < arenaCells(shape); cells += step) {
        for (const payloadLength of [regionCapacity(cells, shape), Math.max(0, regionCapacity(cells, shape) - 40)]) {
          if (payloadLength < 2) continue;
          const records = [{ schema: RECORD_SCHEMA.memo, data: memoFor(payloadLength) }];
          const built = buildArena({ shape, context, recipients: [{ slot: 0, sharedSecret: key(1), records }] });
          const anchor = built.recipientAnchors.get(0)!;
          expect(regionCells(built.arena, shape, context, { role: "recipient", ikm: key(1), anchor })).toHaveLength(regionCellsFor(payloadLength, shape));
          expect(openRecipientRecords({ arena: built.arena, shape, context, sharedSecret: key(1), anchor })).toEqual(records);
        }
      }
    }
  });

  it("switches from a list to a bitmap directory past B continuation cells", () => {
    for (const [shape, bitmapBytes] of [[S, 5], [L, 32]] as const) {
      const context = contextFor(shape);
      for (const [cells, count] of [[bitmapBytes + 1, bitmapBytes], [bitmapBytes + 2, 255]] as const) {
        const records = [{ schema: RECORD_SCHEMA.memo, data: memoFor(regionCapacity(cells, shape)) }];
        const built = buildArena({ shape, context, recipients: [{ slot: 0, sharedSecret: key(1), records }] });
        const anchor = built.recipientAnchors.get(0)!;
        expect(anchorPlaintext(built.arena, shape, context, { role: "recipient", ikm: key(1), anchor })[0]).toBe(count);
        expect(regionCells(built.arena, shape, context, { role: "recipient", ikm: key(1), anchor })).toHaveLength(cells);
        expect(openRecipientRecords({ arena: built.arena, shape, context, sharedSecret: key(1), anchor })).toEqual(orderedRecords(records));
      }
    }
  });

  it("anchors the sender region at the last cell and never deals that cell to a recipient", () => {
    for (const shape of SHAPES) {
      const context = contextFor(shape);
      const last = arenaCells(shape) - 1;
      const records: readonly DataRecord[] = [sentEnvelopesSchema.encode([{ slot: 0, sharedSecret: key(1), recipientAddress: 1n }]), { schema: applicationSchemaId("com.example.record009"), data: new Uint8Array(200) }];
      const built = buildArena({ shape, context, sender: { outgoingKey, records }, recipients: [] });
      expect(regionCells(built.arena, shape, context, { role: "sender", ikm: outgoingKey, anchor: last })[0]).toBe(last);
      expect(openSenderRecords({ arena: built.arena, shape, context, outgoingKey })).toEqual(senderView(records));
    }
    // Recipient regions filling every other cell of S, with and without a sender region.
    const context = contextFor(S);
    const recipients = Array.from({ length: 3 }, (_, slot) => ({ slot, sharedSecret: key(slot + 1), records: [{ schema: RECORD_SCHEMA.memo, data: memoFor(regionCapacity(13, S)) }] }));
    for (const sender of [undefined, { outgoingKey, records: [] }]) {
      const built = buildArena({ shape: S, context, ...(sender === undefined ? {} : { sender }), recipients });
      const cells = recipients.flatMap(({ slot, sharedSecret }) => regionCells(built.arena, S, context, { role: "recipient", ikm: sharedSecret, anchor: built.recipientAnchors.get(slot)! }));
      expect([...cells].sort((a, b) => a - b)).toEqual(Array.from({ length: 39 }, (_, cell) => cell));
      // Without an outgoing key the reserved cell is filler, never left zero.
      expect(isZero(cellAt(built.arena, 39))).toBe(false);
      expect(openSenderRecords({ arena: built.arena, shape: S, context, outgoingKey }) !== null).toBe(sender !== undefined);
    }
  });

  it("uses cell 254 as an anchor and as a continuation cell in L", () => {
    const context = contextFor(L);
    const recipients = Array.from({ length: 32 }, (_, slot) => ({ slot, sharedSecret: key(slot + 1), records: [{ schema: RECORD_SCHEMA.memo, data: Uint8Array.of(slot) }] }));
    const withAnchor = searchSeeds(
      "anchor",
      (seed) => seeded(seed, () => buildArena({ shape: L, context, recipients })),
      (built) => [...built.recipientAnchors.values()].includes(254),
    );
    const slot = [...withAnchor.recipientAnchors].find(([, anchor]) => anchor === 254)![0];
    expect(openRecipientRecords({ arena: withAnchor.arena, shape: L, context, sharedSecret: key(slot + 1), anchor: 254 })).toEqual([{ schema: RECORD_SCHEMA.memo, data: Uint8Array.of(slot) }]);

    const records = [{ schema: RECORD_SCHEMA.memo, data: new Uint8Array(3000).fill(5) }];
    const cellsOf = (arena: Uint8Array, anchor: number) => regionCells(arena, L, context, { role: "recipient", ikm: key(1), anchor });
    const built = searchSeeds(
      "continuation",
      (seed) => seeded(seed, () => buildArena({ shape: L, context, recipients: [{ slot: 0, sharedSecret: key(1), records }] })),
      (built) => cellsOf(built.arena, built.recipientAnchors.get(0)!).slice(1).includes(254),
    );
    expect(cellsOf(built.arena, built.recipientAnchors.get(0)!).at(-1)).toBe(254);
    expect(openRecipientRecords({ arena: built.arena, shape: L, context, sharedSecret: key(1), anchor: built.recipientAnchors.get(0)! })).toEqual(orderedRecords(records));
  });

  describe("crafted directories", () => {
    const shape = S;
    const context = contextFor(shape);
    const anchor = 10;
    const ikm = key(0x21);
    const base = seeded("crafted", () => buildArena({ shape, context, recipients: [] })).arena;
    const payload = Uint8Array.from({ length: 60 }, (_, index) => index + 1);
    const open = (arena: Uint8Array) => openRegion({ arena, shape, context, role: "recipient", ikm, anchor });
    /** The opened plaintext is `bytes` followed by zeros. */
    const holds = (area: Uint8Array | null, bytes = payload) =>
      area !== null && toHex(area.subarray(0, bytes.length)) === toHex(bytes) && isZero(area.subarray(bytes.length));
    const craft = (parts: { plaintext: Uint8Array; body?: Uint8Array }, continuation: readonly number[] = []) => {
      const arena = base.slice();
      sealRaw(arena, shape, context, { role: "recipient", ikm, anchor, continuation, ...parts });
      return arena;
    };
    const listed = (directory: number[], count = directory.length, bytes = payload) =>
      craft(regionParts(count, directory, directory.length, bytes), directory);
    const mapped = (cells: number[], bitmapBytes = 5) =>
      craft(regionParts(255, bitmapOf(cells, bitmapBytes), cells.length, payload), cells);

    it("accepts well-formed list and bitmap directories", () => {
      expect(holds(open(listed([3, 20])))).toBe(true);
      expect(holds(open(listed([1, 39])))).toBe(true);
      expect(holds(open(listed([0, 39])))).toBe(true);
      expect(holds(open(mapped([1, 2, 3, 4, 5, 6])))).toBe(true);
      const short = payload.subarray(0, 48);
      expect(holds(open(craft(regionParts(0, [], 0, short))), short)).toBe(true);
    });

    it("rejects malformed directories", () => {
      expect(open(listed([20, 3]))).toBeNull();
      expect(open(listed([3, 3]))).toBeNull();
      expect(open(listed([3, anchor]))).toBeNull();
      expect(open(listed([3, 40]))).toBeNull();
      expect(open(listed([1, 2, 3, 4, 5, 6]))).toBeNull();
      expect(open(listed([3, 20], 254))).toBeNull();
      expect(open(mapped([1, 2, 3, 4, 5]))).toBeNull();
      expect(open(mapped([1, 2, 3, 4, 5, 6, anchor]))).toBeNull();
    });

    /**
     * The writer of a region chooses its body plaintext, so it can make any
     * non-final body cell hold chosen ciphertext: a copy of the anchor cell or
     * of another body cell. The body still verifies, so only the directory
     * rule rejects the region.
     */
    const forged = (continuation: readonly number[], count: number, directory: Uint8Array, copies: readonly (readonly ["anchor" | number, number])[]) => {
      const arena = base.slice();
      const keys = regionKeys(arena, shape, context, "recipient", ikm);
      const bodyLength = 65 * continuation.length - 16;
      const anchorCell = gcm(keys.anchorKey, NONCE).encrypt(anchorBytes(count, directory, new Uint8Array(48 - directory.length).fill(0x42)));
      const stream = keystream(keys.bodyKey, bodyLength);
      // A zero plaintext block encrypts to the keystream, so a copy of block i needs plaintext stream_i XOR stream_target.
      const body = new Uint8Array(bodyLength);
      for (const [source, target] of copies) {
        const wanted = source === "anchor" ? anchorCell : block(stream, source);
        body.set(wanted.map((byte, index) => byte ^ stream[65 * target + index]!), 65 * target);
      }
      const sealed = gcm(keys.bodyKey, NONCE, anchorCell).encrypt(body);
      for (const [source, target] of copies) expect(block(sealed, target)).toEqual(source === "anchor" ? anchorCell : block(sealed, source));
      arena.set(anchorCell, offset(anchor));
      continuation.forEach((cell, index) => arena.set(block(sealed, index), offset(cell)));
      return arena;
    };

    it("rejects a directory naming the anchor or a cell twice even when the body verifies", () => {
      expect(open(forged([anchor, 20], 2, Uint8Array.of(anchor, 20), [["anchor", 0]]))).toBeNull();
      const cells = [1, 2, 3, 4, 5, anchor, 20];
      expect(open(forged(cells, 255, bitmapOf(cells, 5), [["anchor", 5]]))).toBeNull();
      expect(open(forged([3, 3, 20], 3, Uint8Array.of(3, 3, 20), [[0, 1]]))).toBeNull();
    });

    it("rejects a cell past the arena even when the remaining body verifies", () => {
      // Cell 40 does not exist in S; a 49-byte body seals into cell 3 alone.
      const body = new Uint8Array(49);
      body.set(payload.subarray(46));
      expect(open(craft({ plaintext: anchorBytes(2, [3, 40], payload.subarray(0, 46)), body }, [3]))).toBeNull();
    });

    it("rejects a list-sized bitmap and an oversize count in L", () => {
      const contextL = contextFor(L);
      const baseL = seeded("crafted-L", () => buildArena({ shape: L, context: contextL, recipients: [] })).arena;
      const openL = (arena: Uint8Array) => openRegion({ arena, shape: L, context: contextL, role: "recipient", ikm, anchor: 200 });
      const write = (count: number, directory: Uint8Array, cells: number[]) => {
        const arena = baseL.slice();
        sealRaw(arena, L, contextL, { role: "recipient", ikm, anchor: 200, continuation: cells, ...regionParts(count, directory, cells.length, payload) });
        return arena;
      };
      const cells = (count: number) => Array.from({ length: count }, (_, index) => index * 3 + 1);
      expect(holds(openL(write(32, Uint8Array.from(cells(32)), cells(32))))).toBe(true);
      expect(holds(openL(write(255, bitmapOf(cells(33), 32), cells(33))))).toBe(true);
      expect(openL(write(255, bitmapOf(cells(32), 32), cells(32)))).toBeNull();
      expect(openL(write(33, Uint8Array.from(cells(33)), cells(33)))).toBeNull();
    });

    it("rejects nonzero bytes after the record list, not inside it", () => {
      const records = (arena: Uint8Array) => openRecipientRecords({ arena, shape, context, sharedSecret: ikm, anchor });
      const memo = { schema: RECORD_SCHEMA.memo, data: new Uint8Array(70) };
      // 72 list bytes: 47 in the anchor beside a one-cell directory, 25 in the 49-byte body.
      const parts = regionParts(1, [3], 1, encodeRecords([memo]));
      expect(records(craft(parts, [3]))).toEqual([memo]);
      // Position 25 is the terminator; the bytes after it are padding.
      for (const position of [26, 48]) {
        const body = parts.body!.slice();
        body[position] = 1;
        expect(records(craft({ ...parts, body }, [3]))).toBeNull();
      }
      // Padding in the anchor of a one-cell region.
      const short = regionParts(0, [], 0, encodeRecords([{ schema: RECORD_SCHEMA.memo, data: Uint8Array.of(0) }]));
      expect(records(craft(short))).toEqual([{ schema: RECORD_SCHEMA.memo, data: Uint8Array.of(0) }]);
      const plaintext = short.plaintext.slice();
      plaintext[48] = 1;
      expect(records(craft({ plaintext }))).toBeNull();
      // A list that fills its region exactly has no terminator.
      const exact = encodeRecords([{ schema: RECORD_SCHEMA.memo, data: memoFor(regionCapacity(2, S)) }]);
      expect(exact.length).toBe(regionCapacity(2, S));
      expect(records(craft(regionParts(1, [3], 1, exact), [3]))).toHaveLength(1);
    });
  });

  it("rejects a change to any byte of any of its cells", () => {
    const context = contextFor(S);
    const records = [{ schema: RECORD_SCHEMA.memo, data: new Uint8Array(200).fill(3) }];
    const built = buildArena({ shape: S, context, recipients: [{ slot: 2, sharedSecret: key(2), records }] });
    const anchor = built.recipientAnchors.get(2)!;
    const cells = regionCells(built.arena, S, context, { role: "recipient", ikm: key(2), anchor });
    expect(cells).toHaveLength(4);
    const open = (arena: Uint8Array) => openRecipientRecords({ arena, shape: S, context, sharedSecret: key(2), anchor });
    expect(open(built.arena)).toEqual(orderedRecords(records));
    for (const cell of cells) {
      for (const position of [0, 1, 6, 48, 49, 64]) {
        const arena = built.arena.slice();
        arena[offset(cell) + position]! ^= 1;
        expect(open(arena)).toBeNull();
      }
    }
    const swapped = built.arena.slice();
    swapped.set(cellAt(built.arena, cells[1]!), offset(cells[2]!));
    swapped.set(cellAt(built.arena, cells[2]!), offset(cells[1]!));
    expect(open(swapped)).toBeNull();
  });

  it("returns null for an anchor outside the arena and for an arena of the wrong length", () => {
    const context = contextFor(S);
    const built = buildArena({ shape: S, context, sender: { outgoingKey, records: [] }, recipients: [{ slot: 0, sharedSecret: key(1), records: [{ schema: RECORD_SCHEMA.memo, data: Uint8Array.of(1) }] }] });
    for (const anchor of [40, 255, -1, 1.5]) {
      expect(openRecipientRecords({ arena: built.arena, shape: S, context, sharedSecret: key(1), anchor })).toBeNull();
    }
    for (const arena of [built.arena.subarray(1), concatBytes(built.arena, Uint8Array.of(0))]) {
      expect(openSenderRecords({ arena, shape: S, context, outgoingKey })).toBeNull();
      expect(openRecipientRecords({ arena, shape: S, context, sharedSecret: key(1), anchor: built.recipientAnchors.get(0)! })).toBeNull();
    }
    expect(openSenderRecords({ arena: built.arena, shape: L, context: contextFor(L), outgoingKey })).toBeNull();
  });
});

describe("arena binding", () => {
  const records: readonly DataRecord[] = [sentEnvelopesSchema.encode([{ slot: 0, sharedSecret: key(1), recipientAddress: 1n }])];

  it("encodes the transaction context and derives an anchor and a body key from it per role", () => {
    const context = contextFor(S, { chainId: 0x01020304n, transactionType: 3, nullifiers: [1n, 2n, 3n, BN254_SCALAR_MODULUS - 1n] });
    const contextBytes = arenaContextBytes(S, context);
    expect(toHex(contextBytes)).toBe(toHex(concatBytes(
      Uint8Array.of(1, 2, 3, 4, 3, 0),
      ...[1n, 2n, 3n, BN254_SCALAR_MODULUS - 1n].map((value) => fromHex(value.toString(16).padStart(64, "0"))),
    )));
    const salt = key(0x5a);
    for (const role of ["recipient", "sender"] as const) {
      const keys = arenaRegionKeys(role, outgoingKey, salt, contextBytes);
      for (const part of ["anchor", "body"] as const) {
        const info = concatBytes(utf8(`pcash.arena.${role}.${part}`), contextBytes);
        expect(toHex(keys[`${part}Key`])).toBe(toHex(new Uint8Array(hkdfSync("sha256", outgoingKey, salt, info, 32))));
      }
    }
  });

  it("derives different keys from a repeated salt in another spend", () => {
    const salt = key(0x5a);
    const keyIn = (context: ArenaContext, role: ArenaRole) => {
      const keys = arenaRegionKeys(role, outgoingKey, salt, arenaContextBytes(S, context));
      return `${toHex(keys.anchorKey)}/${toHex(keys.bodyKey)}`;
    };
    const base = contextFor(S);
    for (const role of ["recipient", "sender"] as const) {
      const keys = [
        base,
        contextFor(S, { nullifiers: [...base.nullifiers.slice(0, 3), 1n] }),
        contextFor(S, { nullifiers: [base.nullifiers[1]!, base.nullifiers[0]!, ...base.nullifiers.slice(2)] }),
        contextFor(S, { transactionType: 3 }),
        contextFor(S, { chainId: 8183n }),
      ].map((context) => keyIn(context, role));
      expect(new Set(keys).size).toBe(keys.length);
    }
    expect(keyIn(base, "recipient")).not.toBe(keyIn(base, "sender"));
  });

  it("rejects a salt and sender region copied into another context", () => {
    const context = contextFor(S);
    const built = buildArena({ shape: S, context, sender: { outgoingKey, records }, recipients: [] });
    expect(openSenderRecords({ arena: built.arena, shape: S, context, outgoingKey })).toEqual(senderView(records));
    const nullifiers = context.nullifiers;
    for (const other of [
      contextFor(S, { nullifiers: [nullifiers[0]!, nullifiers[1]!, nullifiers[2]!, 1n] }),
      contextFor(S, { nullifiers: [nullifiers[1]!, nullifiers[0]!, nullifiers[2]!, nullifiers[3]!] }),
      contextFor(S, { transactionType: 3 }),
      contextFor(S, { transactionType: 2 }),
      contextFor(S, { chainId: 8183n }),
    ]) {
      expect(openSenderRecords({ arena: built.arena, shape: S, context: other, outgoingKey })).toBeNull();
    }
    // The same salt and sender cell moved into an L arena's sender cell.
    expect(regionCells(built.arena, S, context, { role: "sender", ikm: outgoingKey, anchor: 39 })).toHaveLength(2);
    const arenaL = buildArena({ shape: L, context: contextFor(L), recipients: [] }).arena;
    arenaL.set(built.salt);
    arenaL.set(cellAt(built.arena, 39), offset(255));
    expect(openSenderRecords({ arena: arenaL, shape: L, context: contextFor(L, { nullifiers: [...nullifiers, ...new Array(28).fill(0n)] }), outgoingKey })).toBeNull();
  });

  it("gives identical contexts unrelated ciphertexts through a fresh salt", () => {
    const context = contextFor(S);
    const build = (memo: Uint8Array) => buildArena({ shape: S, context, sender: { outgoingKey, records }, recipients: [{ slot: 0, sharedSecret: key(1), records: [{ schema: RECORD_SCHEMA.memo, data: memo }] }] });
    const first = build(new Uint8Array(40).fill(1));
    const second = build(new Uint8Array(40).fill(2));
    expect(toHex(first.salt)).not.toBe(toHex(second.salt));
    const keyOf = (built: typeof first) => regionKeys(built.arena, S, context, "recipient", key(1)).anchorKey;
    expect(toHex(keyOf(first))).not.toBe(toHex(keyOf(second)));
    // One-cell regions: 49 ciphertext bytes and a tag.
    const sealedCell = (built: typeof first) => cellAt(built.arena, built.recipientAnchors.get(0)!);
    const plaintext = (built: typeof first) => gcm(keyOf(built), NONCE).decrypt(sealedCell(built));
    // Under a reused key and nonce, the ciphertext XOR would equal the plaintext XOR.
    const xor = (a: Uint8Array, b: Uint8Array) => toHex(a.subarray(0, 49).map((byte, index) => byte ^ b[index]!));
    expect(xor(sealedCell(first), sealedCell(second))).not.toBe(xor(plaintext(first), plaintext(second)));
    expect(openRecipientRecords({ arena: concatBytes(first.salt, second.arena.subarray(ARENA_SALT_BYTES)), shape: S, context, sharedSecret: key(1), anchor: second.recipientAnchors.get(0)! })).toBeNull();
    const cells = new Set(Array.from({ length: 40 }, (_, cell) => toHex(cellAt(first.arena, cell))));
    expect(Array.from({ length: 40 }, (_, cell) => toHex(cellAt(second.arena, cell))).some((cell) => cells.has(cell))).toBe(false);
  });

  it("isolates keys by role and secret", () => {
    const context = contextFor(S);
    const built = buildArena({
      shape: S, context,
      sender: { outgoingKey, records },
      recipients: [
        { slot: 0, sharedSecret: key(1), records: [{ schema: RECORD_SCHEMA.memo, data: Uint8Array.of(1) }] },
        { slot: 1, sharedSecret: key(2), records: [{ schema: RECORD_SCHEMA.memo, data: Uint8Array.of(2) }] },
      ],
    });
    const { arena } = built;
    const anchor0 = built.recipientAnchors.get(0)!;
    const anchor1 = built.recipientAnchors.get(1)!;
    const open = (role: ArenaRole, ikm: Uint8Array, anchor: number) => openRegion({ arena, shape: S, context, role, ikm, anchor });

    expect(open("sender", outgoingKey, 39)).not.toBeNull();
    expect(open("recipient", key(1), anchor0)).not.toBeNull();
    // A recipient's secret opens neither the sender region nor another recipient's region.
    expect(open("sender", key(1), 39)).toBeNull();
    expect(open("recipient", key(1), 39)).toBeNull();
    expect(open("recipient", key(2), anchor0)).toBeNull();
    // Roles cannot be swapped under the right secret.
    expect(open("recipient", outgoingKey, 39)).toBeNull();
    expect(open("sender", key(1), anchor0)).toBeNull();
    expect(openRecipientRecords({ arena, shape: S, context, sharedSecret: key(1), anchor: anchor1 })).toBeNull();
    expect(openRecipientRecords({ arena, shape: S, context, sharedSecret: key(2), anchor: anchor1 })).toEqual([{ schema: RECORD_SCHEMA.memo, data: Uint8Array.of(2) }]);
  });
});

describe("recipient regions", () => {
  const context = contextFor(S);
  const open = (arena: Uint8Array, sharedSecret: Uint8Array, anchor: number) =>
    openRecipientRecords({ arena, shape: S, context, sharedSecret, anchor });

  it("gives each recipient its own copy of a record several recipients read", () => {
    const recipients = [1, 2, 3].map((slot) => ({ slot, sharedSecret: key(slot), records: [{ schema: RECORD_SCHEMA.memo, data: Uint8Array.of(slot) }, assetDefinitionSchema.encode(definition)] }));
    const built = buildArena({ shape: S, context, recipients });
    for (const { slot, sharedSecret, records } of recipients) {
      expect(open(built.arena, sharedSecret, built.recipientAnchors.get(slot)!)).toEqual(orderedRecords(records));
    }
    const cells = recipients.map(({ slot, sharedSecret }) => regionCells(built.arena, S, context, { role: "recipient", ikm: sharedSecret, anchor: built.recipientAnchors.get(slot)! }));
    expect(new Set(cells.flat()).size).toBe(cells.flat().length);
    expect(cells.map((region) => region.length)).toEqual(planArena({ shape: S, regions: recipients.map(({ records }) => encodeRecords(records).length) }).cellsPerRegion);
  });

  it("returns null for a recipient payload carrying a sender record or a duplicate type", () => {
    const built = seeded("duplicate", () => buildArena({ shape: S, context, recipients: [{ slot: 0, sharedSecret: key(1), records: [{ schema: RECORD_SCHEMA.memo, data: Uint8Array.of(1) }] }] }));
    const anchor0 = built.recipientAnchors.get(0)!;
    const used = new Set(regionCells(built.arena, S, context, { role: "recipient", ikm: key(1), anchor: anchor0 }));
    const free = Array.from({ length: 39 }, (_, cell) => cell).filter((cell) => !used.has(cell));
    const write = (payload: Uint8Array) => {
      const copy = built.arena.slice();
      sealPayload(copy, S, context, { role: "recipient", ikm: key(9), anchor: free[0]!, continuation: [free[1]!], payload });
      return open(copy, key(9), free[0]!);
    };
    expect(write(record(1, [7]))).toEqual([{ schema: RECORD_SCHEMA.memo, data: Uint8Array.of(7) }]);
    expect(write(concatBytes(record(1, [7]), record(1, [8])))).toBeNull();
    expect(write(record(4, [0, ...key(1), ...new Uint8Array(20)]))).toBeNull();
  });

  it("recovers a transaction from the outgoing key alone", () => {
    const recipients = [
      { slot: 0, sharedSecret: key(1), records: [{ schema: RECORD_SCHEMA.memo, data: utf8("rent") }, claimedSenderSchema.encode(0xaan), assetDefinitionSchema.encode(definition)] },
      { slot: 3, sharedSecret: key(4), records: [{ schema: RECORD_SCHEMA.memo, data: utf8("change") }] },
      { slot: 4, sharedSecret: key(5), records: [assetDefinitionSchema.encode(definition)] },
    ];
    const opening = { slot: 2, recipientAddress: 0xccn, assetId: 9n, amount: 100n, noteSecret: 11n };
    const records: readonly DataRecord[] = [sentEnvelopesSchema.encode(recipients.map(({ slot, sharedSecret }) => ({ slot, sharedSecret, recipientAddress: BigInt(slot + 0x100) }))), sentOpeningsSchema.encode([opening]), assetDefinitionSchema.encode(definition)];
    const built = buildArena({ shape: S, context, sender: { outgoingKey, records }, recipients });
    // Only the arena, the context, and the outgoing key; the anchors stand in for the envelopes the shared secrets open.
    const recovered = openSenderRecords({ arena: built.arena, shape: S, context, outgoingKey })!;
    expect(recovered).toEqual(senderView(records));
    expect(openSenderRecords({ arena: built.arena, shape: S, context, outgoingKey: key(0x0f) })).toBeNull();
    const views = recovered.sentEnvelopes.map(({ slot, sharedSecret }) => open(built.arena, sharedSecret, built.recipientAnchors.get(slot)!));
    expect(views).toEqual(recipients.map(({ records }) => orderedRecords(records)));
    expect(recovered.sentOpenings).toEqual([opening]);
  });
});

describe("arena allocation", () => {
  const context = contextFor(S);

  it("allocates exactly the planned cells", () => {
    const senderRecords: readonly DataRecord[] = [sentEnvelopesSchema.encode([{ slot: 0, sharedSecret: key(1), recipientAddress: 1n }]), { schema: applicationSchemaId("com.example.record007"), data: new Uint8Array(150) }];
    const recipients = [
      { slot: 0, sharedSecret: key(1), records: [{ schema: RECORD_SCHEMA.memo, data: new Uint8Array(400) }, assetDefinitionSchema.encode(definition)] },
      { slot: 1, sharedSecret: key(2), records: [{ schema: RECORD_SCHEMA.memo, data: new Uint8Array(10) }] },
      { slot: 2, sharedSecret: key(3), records: [assetDefinitionSchema.encode(definition)] },
    ];
    const built = buildArena({ shape: S, context, sender: { outgoingKey, records: senderRecords }, recipients });
    const plan = planArena({ shape: S, sender: encodeRecords(senderRecords).length, regions: recipients.map(({ records }) => encodeRecords(records).length) });
    const regions = recipients.map(({ slot, sharedSecret }) => regionCells(built.arena, S, context, { role: "recipient", ikm: sharedSecret, anchor: built.recipientAnchors.get(slot)! }));
    const sender = regionCells(built.arena, S, context, { role: "sender", ikm: outgoingKey, anchor: 39 });
    expect(regions.map((cells) => cells.length)).toEqual(plan.cellsPerRegion);
    expect(sender.length).toBe(plan.senderCells);
    expect(new Set([...sender, ...regions.flat()]).size).toBe(plan.usedCells);
  });

  it("builds an exact fit and rejects one byte more", () => {
    const recipient = (memoLength: number) => [{ slot: 0, sharedSecret: key(1), records: [{ schema: RECORD_SCHEMA.memo, data: new Uint8Array(memoLength).fill(1) }] }];
    const exact = 2497 - 3;
    expect(planArena({ shape: S, sender: 0, regions: [2497] })).toMatchObject({ usedCells: 40, fits: true });
    const built = buildArena({ shape: S, context, sender: { outgoingKey, records: [] }, recipients: recipient(exact) });
    const cells = regionCells(built.arena, S, context, { role: "recipient", ikm: key(1), anchor: built.recipientAnchors.get(0)! });
    expect(new Set([...cells, 39]).size).toBe(40);
    expect(openRecipientRecords({ arena: built.arena, shape: S, context, sharedSecret: key(1), anchor: built.recipientAnchors.get(0)! })).toEqual(orderedRecords(recipient(exact)[0]!.records));
    expect(openSenderRecords({ arena: built.arena, shape: S, context, outgoingKey })).toEqual({ records: [], sentEnvelopes: [], sentOpenings: [] });
    expect(planArena({ shape: S, sender: 0, regions: [2498] }).fits).toBe(false);
    expect(() => buildArena({ shape: S, context, sender: { outgoingKey, records: [] }, recipients: recipient(exact + 1) }))
      .toThrow(/need 41 cells; the S arena has 40/);
  });

  it("writes a region only for a recipient with something to deliver", () => {
    const built = buildArena({
      shape: S, context,
      recipients: [
        { slot: 0, sharedSecret: key(1), records: [] },
        { slot: 1, sharedSecret: key(2), records: [{ schema: RECORD_SCHEMA.memo, data: new Uint8Array(0) }] },
        { slot: 2, sharedSecret: key(3), records: [{ schema: RECORD_SCHEMA.memo, data: Uint8Array.of(1) }] },
      ],
    });
    expect([...built.recipientAnchors.keys()]).toEqual([1, 2]);
    expect(() => buildArena({ shape: S, context, sender: { outgoingKey, records: [] }, recipients: [] })).not.toThrow();
  });

  it("fills unused cells with uniform random bytes", () => {
    const contextL = contextFor(L);
    const filler: Uint8Array[] = [];
    const used: Uint8Array[] = [];
    for (let round = 0; round < 20; round++) {
      const recipients = [
        { slot: 0, sharedSecret: key(1), records: [{ schema: RECORD_SCHEMA.memo, data: new Uint8Array(6000) }] },
        { slot: 1, sharedSecret: key(2), records: [{ schema: RECORD_SCHEMA.memo, data: new Uint8Array(1) }] },
      ];
      const built = buildArena({ shape: L, context: contextL, sender: { outgoingKey, records: [] }, recipients });
      expect(built.arena.length).toBe(PRIVATE_VALUE_PROFILES.L.arenaBytes);
      const regionCellSet = new Set([
        ...regionCells(built.arena, L, contextL, { role: "sender", ikm: outgoingKey, anchor: 255 }),
        ...recipients.flatMap(({ slot, sharedSecret }) => regionCells(built.arena, L, contextL, { role: "recipient", ikm: sharedSecret, anchor: built.recipientAnchors.get(slot)! })),
      ]);
      for (let cell = 0; cell < 256; cell++) (regionCellSet.has(cell) ? used : filler).push(cellAt(built.arena, cell));
    }
    // 255 degrees of freedom: mean 255, standard deviation about 22.6.
    for (const cells of [filler, used]) {
      expect(cells.every((cell) => cell.length === ARENA_CELL_BYTES)).toBe(true);
      const statistic = chiSquare(concatBytes(...cells));
      expect(statistic).toBeGreaterThan(120);
      expect(statistic).toBeLessThan(390);
    }
  });

  it("deals anchors uniformly over every cell but the sender's", () => {
    const counts = new Array<number>(40).fill(0);
    const rounds = 2000;
    for (let round = 0; round < rounds; round++) {
      const built = buildArena({ shape: S, context, recipients: [{ slot: 0, sharedSecret: key(1), records: [{ schema: RECORD_SCHEMA.memo, data: Uint8Array.of(1) }] }] });
      counts[built.recipientAnchors.get(0)!]!++;
    }
    expect(counts[39]).toBe(0);
    const expected = rounds / 39;
    expect(counts[0]).toBeGreaterThan(0);
    // 38 degrees of freedom: mean 38, standard deviation about 8.7.
    expect(counts.slice(0, 39).reduce((sum, count) => sum + (count - expected) ** 2 / expected, 0)).toBeLessThan(100);
  });
});

describe("arena vector", () => {
  const vector = arenaVector;
  const vectorContext: ArenaContext = { chainId: BigInt(vector.chainId), transactionType: 0, nullifiers: vector.nullifiers.map((value) => BigInt(value)) };
  const vectorDefinition = assetDefinitionSchema.encode(decodeAssetDefinition(fromHex(vector.assetDefinition)));
  const vectorSender: readonly DataRecord[] = [sentEnvelopesSchema.encode(vector.sentEnvelopes.map((entry) => ({ slot: entry.slot, sharedSecret: fromHex(entry.sharedSecret), recipientAddress: BigInt(entry.recipientAddress) }))), sentOpeningsSchema.encode(vector.sentOpenings.map((entry) => ({
      slot: entry.slot, recipientAddress: BigInt(entry.recipientAddress), assetId: BigInt(entry.assetId), amount: BigInt(entry.amount), noteSecret: BigInt(entry.noteSecret),
    }))), { schema: vector.applicationRecord.schema, data: fromHex(vector.applicationRecord.data) }];
  const recipientRecords = (recipient: typeof vector.recipients[number]): DataRecord[] => [
    ...(recipient.memo === "" ? [] : [{ schema: RECORD_SCHEMA.memo, data: fromHex(recipient.memo) }]),
    ...(recipient.sender === "" ? [] : [claimedSenderSchema.encode(BigInt(recipient.sender))]),
    ...(recipient.definition ? [vectorDefinition] : []),
  ];
  const vectorInput = (): BuildArenaInput => ({
    shape: S,
    context: vectorContext,
    sender: { outgoingKey: fromHex(vector.outgoingKey), records: vectorSender },
    recipients: vector.recipients.map((recipient) => ({ slot: recipient.slot, sharedSecret: fromHex(recipient.sharedSecret), records: recipientRecords(recipient) })),
    public: [{ schema: vector.publicRecord.schema, data: fromHex(vector.publicRecord.data) }],
  });

  it("matches a frozen arena", () => {
    const built = seeded(vector.seed, () => buildArena(vectorInput()));
    expect(toHex(built.salt)).toBe(`0x${vector.expected.salt}`);
    expect([...built.recipientAnchors]).toEqual(vector.expected.recipientAnchors);
    expect(toHex(built.arena)).toBe(`0x${vector.expected.arena}`);

    const arena = fromHex(vector.expected.arena);
    expect(vector.publicRecord.schema).toBe(applicationSchemaId("com.example.public"));
    expect(readPublicRecords(arena)).toEqual([{ schema: vector.publicRecord.schema, data: fromHex(vector.publicRecord.data) }]);
    expect(openSenderRecords({ arena, shape: S, context: vectorContext, outgoingKey: fromHex(vector.outgoingKey) })).toEqual(senderView(vectorSender));
    for (const recipient of vector.recipients) {
      const records = openRecipientRecords({
        arena, shape: S, context: vectorContext, sharedSecret: fromHex(recipient.sharedSecret),
        anchor: new Map(vector.expected.recipientAnchors as [number, number][]).get(recipient.slot)!,
      });
      expect(records).toEqual(orderedRecords(recipientRecords(recipient)));
    }
  });

  it("seals the planned bytes without reading record data again", () => {
    const input = vectorInput();
    const plan = prepareArena(input);
    for (const recipient of input.recipients) {
      for (const record of recipient.records) record.data.fill(0xff);
    }
    for (const record of input.public ?? []) record.data.fill(0xff);
    expect(toHex(seeded(vector.seed, () => writeArena(plan)).arena)).toBe(`0x${vector.expected.arena}`);
  });

  it("opens the frozen sender region with node:crypto alone", () => {
    const arena = Buffer.from(vector.expected.arena, "hex");
    const salt = arena.subarray(0, 32);
    const ikm = Buffer.from(vector.outgoingKey, "hex");
    const chainId = Buffer.alloc(4);
    chainId.writeUInt32BE(Number(vector.chainId));
    const txContext = Buffer.concat([chainId, Buffer.of(0, 0), ...vector.nullifiers.map((value) => Buffer.from(BigInt(value).toString(16).padStart(64, "0"), "hex"))]);
    const keyFor = (part: string) => Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.concat([Buffer.from(`pcash.arena.sender.${part}`), txContext]), 32));
    const cell = (index: number) => arena.subarray(32 + 65 * index, 32 + 65 * (index + 1));
    const decrypt = (key: Buffer, aad: Buffer, sealed: Buffer) => {
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.alloc(12));
      decipher.setAAD(aad);
      decipher.setAuthTag(sealed.subarray(sealed.length - 16));
      return Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]);
    };
    // The sender anchor is the last of 40 cells.
    const anchorCell = cell(39);
    const plaintext = decrypt(keyFor("anchor"), Buffer.alloc(0), anchorCell);
    const count = plaintext[0]!;
    expect(count).toBeLessThanOrEqual(5);
    const directory = [...plaintext.subarray(1, 1 + count)];
    const body = count === 0 ? Buffer.alloc(0) : decrypt(keyFor("body"), anchorCell, Buffer.concat(directory.map(cell)));
    const payload = Buffer.concat([plaintext.subarray(1 + count), body]);
    const list = encodeRecords(vectorSender);
    expect(toHex(payload.subarray(0, list.length))).toBe(toHex(list));
    expect(isZero(payload.subarray(list.length))).toBe(true);
  });

  it("lays the public segment out in plaintext at cell zero", () => {
    const arena = Buffer.from(vector.expected.arena, "hex");
    const data = Buffer.from(vector.publicRecord.data, "hex");
    // "PCASHPUB" ‖ list length (2) ‖ application ID (4) ‖ uvarint data length (1) ‖ data, zero to the end of cell 0.
    const segment = Buffer.concat([
      Buffer.from("PCASHPUB"), Buffer.of(0, 5 + data.length),
      Buffer.from(vector.publicRecord.schema.slice(2), "hex"), Buffer.of(data.length), data,
    ]);
    expect(arena.subarray(32, 32 + 65)).toEqual(Buffer.concat([segment, Buffer.alloc(65 - segment.length)]));
    expect(vector.expected.recipientAnchors.every(([, anchor]) => anchor !== 0)).toBe(true);
  });
});

describe("public segment", () => {
  const app = (name: string, data: Uint8Array): DataRecord => ({ schema: applicationSchemaId(`com.example.${name}`), data });
  /** A public record list of exactly `length` bytes: ID (4) ‖ uvarint length ‖ data. */
  function publicOf(length: number): DataRecord[] {
    for (let size = length - 5; size >= 0; size--) {
      if (4 + uvarintLength(size) + size === length) return [app("sized", new Uint8Array(size).fill(0x50))];
    }
    throw new Error(`no record makes a ${length}-byte list`);
  }
  const context = contextFor(S);

  it("round-trips at one, two, and every cell but the sender's beside private regions", () => {
    // 65k − 10 list bytes fit k cells; cell 39 is the sender's.
    for (const sender of [undefined, { outgoingKey, records: [] }]) {
      for (const [length, cells] of [[55, 1], [56, 2], [120, 2], [121, 3], [2525, 39]] as const) {
        const records = publicOf(length);
        const plan = prepareArena({ shape: S, context, ...(sender === undefined ? {} : { sender }), recipients: [], public: records });
        expect(plan.allocation.publicCells).toBe(cells);
        const built = writeArena(plan);
        expect(readPublicRecords(built.arena)).toEqual(records);
        if (sender !== undefined) expect(openSenderRecords({ ...built, shape: S, context, outgoingKey })).toEqual({ records: [], sentEnvelopes: [], sentOpenings: [] });
      }
      expect(prepareArena({ shape: S, context, ...(sender === undefined ? {} : { sender }), recipients: [], public: publicOf(2526) }).allocation.fits).toBe(false);
    }
    const records = [app("first", Uint8Array.of(1)), app("second", new Uint8Array(200).fill(2))];
    const own = [{ schema: RECORD_SCHEMA.memo, data: new Uint8Array(300).fill(7) }, assetDefinitionSchema.encode(definition)];
    for (const shape of SHAPES) {
      const built = buildArena({
        shape, context: contextFor(shape), sender: { outgoingKey, records: [] }, public: records,
        recipients: [{ slot: 1, sharedSecret: key(1), records: own }],
      });
      expect(readPublicRecords(built.arena)).toEqual(orderedRecords(records));
      const anchor = built.recipientAnchors.get(1)!;
      // The 212-byte public list takes cells 0..3.
      expect(anchor).toBeGreaterThanOrEqual(4);
      expect(openRecipientRecords({ ...built, shape, context: contextFor(shape), sharedSecret: key(1), anchor })).toEqual(orderedRecords(own));
      expect(openSenderRecords({ ...built, shape, context: contextFor(shape), outgoingKey })).not.toBeNull();
    }
  });

  it("reserves no cell without public records", () => {
    expect(prepareArena({ shape: S, context, recipients: [], public: [] }).allocation).toMatchObject({ publicCells: 0, usedCells: 1 });
    const built = withArenaRandom(zeros, () => buildArena({ shape: S, context, recipients: [{ slot: 0, sharedSecret: key(1), records: [claimedSenderSchema.encode(1n)] }] }));
    expect(built.recipientAnchors.get(0)).toBe(0);
    expect(readPublicRecords(built.arena)).toBeNull();
  });

  it("accepts only application records", () => {
    for (const record of [{ schema: RECORD_SCHEMA.memo, data: utf8("hi") }, claimedSenderSchema.encode(1n), assetDefinitionSchema.encode(definition)]) {
      expect(() => prepareArena({ shape: S, context, recipients: [], public: [record] })).toThrow(/application records/);
    }
  });

  it("reads null from every malformed or absent segment", () => {
    const records = [app("valid", utf8("ok"))];
    const valid = buildArena({ shape: S, context, recipients: [], public: records }).arena;
    expect(readPublicRecords(valid)).toEqual(records);
    const listLength = encodeRecords(records).length;
    const mutate = (change: (arena: Uint8Array) => void) => {
      const copy = valid.slice();
      change(copy);
      return readPublicRecords(copy);
    };
    expect(mutate(arena => { arena[32] = 0x51; })).toBeNull();
    expect(mutate(arena => { arena.set([0, 0], 40); })).toBeNull();
    expect(mutate(arena => { arena.set(beBytes(40 * 65 - 9, 2), 40); })).toBeNull();
    expect(mutate(arena => { arena[42 + listLength] = 1; })).toBeNull();
    expect(mutate(arena => { arena[96] = 1; })).toBeNull();
    expect(mutate(arena => { arena.set(beBytes(listLength - 1, 2), 40); })).toBeNull();
    expect(mutate(arena => { arena.set(encodeRecords([{ schema: RECORD_SCHEMA.memo, data: utf8("ok") }, ...records]).subarray(0, listLength), 42); })).toBeNull();
    expect(readPublicRecords(valid.subarray(1))).toBeNull();
    // A segment may fill every cell but the sender's, 65 · 39 − 10 list bytes; one that reaches cell 39 is invalid.
    const filled = (length: number) => {
      const arena = new Uint8Array(privateValueProfile(S).arenaBytes);
      arena.set(utf8("PCASHPUB"), 32);
      arena.set(beBytes(length, 2), 40);
      arena.set(encodeRecords(publicOf(length)), 42);
      return readPublicRecords(arena);
    };
    expect(filled(2525)).toEqual(publicOf(2525));
    expect(filled(2526)).toBeNull();
    expect(filled(2590)).toBeNull();
    for (const seed of ["random-a", "random-b"]) expect(readPublicRecords(seededRandom(seed)(privateValueProfile(S).arenaBytes))).toBeNull();
    const zero = withArenaRandom(zeros, () => buildArena({ shape: S, context, recipients: [{ slot: 0, sharedSecret: key(1), records: [claimedSenderSchema.encode(1n)] }] }));
    expect(readPublicRecords(zero.arena)).toBeNull();
  });
});

describe("whole-arena regions", () => {
  it.each([S, L])("uses every cell for the sender region in shape %s", shape => {
    // Whole-arena capacity less type (1) and uvarint length: 2562 − 3 in S, 16575 − 4 in L.
    const records = [{ schema: RECORD_SCHEMA.memo, data: new Uint8Array(shape === S ? 2559 : 16571).fill(7) }];
    const context = contextFor(shape);
    const built = buildArena({ shape, context, recipients: [], sender: { outgoingKey, records } });
    const cells = regionCells(built.arena, shape, context, { role: "sender", ikm: outgoingKey, anchor: arenaCells(shape) - 1 });
    expect([...cells].sort((a, b) => a - b)).toEqual(Array.from({ length: arenaCells(shape) }, (_, i) => i));
    expect(openSenderRecords({ ...built, shape, context, outgoingKey })!.records).toEqual(records);
    expect(() => buildArena({ shape, context, recipients: [], sender: { outgoingKey, records: [{ schema: RECORD_SCHEMA.memo, data: new Uint8Array(records[0]!.data.length + 1) }] } })).toThrow(/arena/);
  });
});
