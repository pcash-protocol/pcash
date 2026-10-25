// PCASH reference arena: the records of one private-value section.
// Non-consensus: the node checks only its exact length and hash.
//
//   arena     = salt (32) ‖ cell_0 ‖ ... ‖ cell_(C-1)            C = 8 · outputs, 65-byte cells
//   public    = "PCASHPUB" ‖ length (2) ‖ record list ‖ zeros, in plaintext over cells 0..k−1, when present
//   region    = an anchor cell plus n continuation cells outside the public segment; the
//               sender region's anchor is cell C − 1, reserved in every build
//   anchor    = AES-256-GCM(anchorKey, count (1) ‖ directory ‖ records ‖ zeros)
//   body      = AES-256-GCM(bodyKey, remaining records ‖ zeros, aad = anchor cell), split over
//               the continuation cells in ascending index order
//   key       = HKDF-SHA-256(ikm, salt, "pcash.arena." ‖ role ‖ "." ‖ part ‖ txContext, 32)
//               for part "anchor" and "body"
//   txContext = chainId (4) ‖ transactionType (1) ‖ shapeId (1) ‖ nullifiers
//
// Unused cells are uniformly random bytes; encrypted region sizes are hidden.
// Every payload is a record list. Readers return null on any failure and never
// throw on arena bytes.

import { encodeRecords, decodeRecords, RECORD_SCHEMA, isBuiltinSchema, type DataRecord } from "./records.ts";
import { gcm } from "@noble/ciphers/aes.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { PRIVATE_VALUE_PROFILES, privateValueProfile, type PrivateValueShape } from "../constants/privateValueProfiles.ts";
import { type FieldNumberish, toAddressField, toField } from "../crypto/field.ts";
import { beBytes, bytesEqual, bytesToBigInt, concatBytes, field32, utf8 } from "../utils/bytes.ts";
import { arenaRandom } from "./arenaRandom.ts";
import { decodeAssetDefinition, encodeAssetDefinition, type AssetDefinition } from "./assetDefinition.ts";
import { TX_KIND_CONTRACT_ACCOUNT_CREATION, TX_KIND_PRIVATE_VALUE, TX_KIND_USER_ACCOUNT_UPDATE } from "./codec.ts";

export const ARENA_SALT_BYTES = 32;
export const ARENA_CELL_BYTES = 65;
const TAG_BYTES = 16;
const NONCE = new Uint8Array(12);
const ANCHOR_PLAINTEXT_BYTES = ARENA_CELL_BYTES - TAG_BYTES;
/** The directory count (1). */
const COUNT_BYTES = 1;
/** Payload bytes a one-cell region carries. */
export const ARENA_ANCHOR_PAYLOAD_BYTES = ANCHOR_PLAINTEXT_BYTES - COUNT_BYTES;
/** Directory count marking a bitmap directory. */
const BITMAP_COUNT = 255;
const KEY_BYTES = 32;
const ADDRESS_BYTES = 20;
/** Opens a public segment at cell 0. Random cells match it with probability 2⁻⁶⁴. */
const PUBLIC_MARKER = utf8("PCASHPUB");
/** marker (8) + length (2). */
const PUBLIC_HEADER_BYTES = PUBLIC_MARKER.length + 2;

export type ArenaRole = "recipient" | "sender";

/** Standard schema identifiers for region codecs. */
export const ARENA_RECORD = RECORD_SCHEMA;
/** slot (1) ‖ sharedSecret (32) ‖ recipientAddress (20). */
const SENT_ENVELOPE_BYTES = 1 + KEY_BYTES + ADDRESS_BYTES;
/** slot (1) ‖ recipientAddress (20) ‖ assetId (32) ‖ amount (16) ‖ noteSecret (32). */
const SENT_OPENING_BYTES = 1 + ADDRESS_BYTES + 32 + 16 + 32;
/** Standard records an application supplies and a recipient region carries. */
const DATA_TYPES: ReadonlySet<string> = new Set([ARENA_RECORD.memo, ARENA_RECORD.assetDefinition, ARENA_RECORD.sender]);
const SENDER_TYPES: ReadonlySet<string> = new Set([...DATA_TYPES, ARENA_RECORD.sentEnvelopes, ARENA_RECORD.sentOpenings]);

const ARENA_TRANSACTION_TYPES: ReadonlySet<number> = new Set([TX_KIND_PRIVATE_VALUE, TX_KIND_CONTRACT_ACCOUNT_CREATION, TX_KIND_USER_ACCOUNT_UPDATE]);
export type ArenaTransactionType =
  | typeof TX_KIND_PRIVATE_VALUE
  | typeof TX_KIND_CONTRACT_ACCOUNT_CREATION
  | typeof TX_KIND_USER_ACCOUNT_UPDATE;

// ===========================================================================
// Geometry and capacity
// ===========================================================================

export function arenaCells(shape: PrivateValueShape): number {
  return (privateValueProfile(shape).arenaBytes - ARENA_SALT_BYTES) / ARENA_CELL_BYTES;
}

/** Bytes of a bitmap directory, one bit per cell. */
export function arenaBitmapBytes(shape: PrivateValueShape): number {
  return arenaCells(shape) / 8;
}

function directoryBytes(continuationCells: number, bitmapBytes: number): number {
  return Math.min(continuationCells, bitmapBytes);
}

/** Anchor prefix plus body plaintext of a k-cell region. Unbounded in k so the planner can report overflow. */
function capacity(cells: number, bitmapBytes: number): number {
  const continuation = cells - 1;
  const body = continuation === 0 ? 0 : ARENA_CELL_BYTES * continuation - TAG_BYTES;
  return ARENA_ANCHOR_PAYLOAD_BYTES - directoryBytes(continuation, bitmapBytes) + body;
}

function minimumCells(payloadLength: number, bitmapBytes: number): number {
  if (!Number.isSafeInteger(payloadLength) || payloadLength < 0) throw new Error("payload length must be a nonnegative integer");
  let cells = 1;
  while (capacity(cells, bitmapBytes) < payloadLength) cells++;
  return cells;
}

/** Payload bytes a region of `cells` cells carries: 48 for one cell, 65k − 33 − min(k − 1, B) beyond. */
export function regionCapacity(cells: number, shape: PrivateValueShape): number {
  if (!Number.isInteger(cells) || cells < 1 || cells > arenaCells(shape)) {
    throw new Error(`region cells must be in 1..${arenaCells(shape)}`);
  }
  return capacity(cells, arenaBitmapBytes(shape));
}

/** The fewest cells whose region carries `payloadLength` bytes. Throws when no region in the arena can. */
export function regionCellsFor(payloadLength: number, shape: PrivateValueShape): number {
  const cells = minimumCells(payloadLength, arenaBitmapBytes(shape));
  if (cells > arenaCells(shape)) {
    throw new Error(`a ${payloadLength}-byte payload exceeds the ${privateValueProfile(shape).name} arena`);
  }
  return cells;
}

/** Record-list bytes a public segment of `cells` cells carries: 65k − 10. */
export function publicCapacity(cells: number): number {
  return ARENA_CELL_BYTES * cells - PUBLIC_HEADER_BYTES;
}

/** Cells of the public segment around a `length`-byte record list; 0 without public records. */
function publicCells(length: number): number {
  return length === 0 ? 0 : Math.ceil((PUBLIC_HEADER_BYTES + length) / ARENA_CELL_BYTES);
}

export interface ArenaPlan {
  /** Cells of each entry of `regions`, in order. */
  cellsPerRegion: number[];
  /** Cells of the sender region, its anchor at C − 1 included; 0 without one. */
  senderCells: number;
  /** Cells 0..publicCells−1 hold the public segment; 0 without public records. */
  publicCells: number;
  /** Planned cells plus cell C − 1, which every build reserves for the sender anchor. */
  usedCells: number;
  totalCells: number;
  fits: boolean;
}

/** Cell usage of a set of region and public record-list lengths. `buildArena` allocates by this plan. */
export function planArena(input: { shape: PrivateValueShape; sender?: number; public?: number; regions: readonly number[] }): ArenaPlan {
  const bitmapBytes = arenaBitmapBytes(input.shape);
  const cellsPerRegion = input.regions.map((length) => minimumCells(length, bitmapBytes));
  const senderCells = input.sender === undefined ? 0 : minimumCells(input.sender, bitmapBytes);
  const segmentCells = publicCells(input.public ?? 0);
  const usedCells = cellsPerRegion.reduce((sum, cells) => sum + cells, Math.max(senderCells, 1) + segmentCells);
  const totalCells = arenaCells(input.shape);
  return { cellsPerRegion, senderCells, publicCells: segmentCells, usedCells, totalCells, fits: usedCells <= totalCells };
}

// ===========================================================================
// Context and keys
// ===========================================================================

/** The section an arena belongs to. Nullifiers are the section's ordered public nullifiers. */
export interface ArenaContext {
  chainId: FieldNumberish;
  transactionType: ArenaTransactionType;
  nullifiers: readonly FieldNumberish[];
}

/** txContext = chainId (4) ‖ transactionType (1) ‖ shapeId (1) ‖ nullifier_0 (32) ‖ ... ‖ nullifier_(I-1) (32). */
export function arenaContextBytes(shape: PrivateValueShape, context: ArenaContext): Uint8Array {
  const { inputs, shapeId } = privateValueProfile(shape);
  if (!ARENA_TRANSACTION_TYPES.has(context.transactionType)) {
    throw new Error(`arena transaction type must be one of ${[...ARENA_TRANSACTION_TYPES].join(", ")}`);
  }
  if (context.nullifiers.length !== inputs) throw new Error(`arena context needs ${inputs} nullifiers`);
  return concatBytes(
    beBytes(context.chainId, 4),
    Uint8Array.of(context.transactionType, shapeId),
    ...context.nullifiers.map((nullifier, index) => field32(toField(nullifier, `nullifiers[${index}]`))),
  );
}

export interface ArenaRegionKeys {
  anchorKey: Uint8Array;
  bodyKey: Uint8Array;
}

/**
 * A region's keys, each HKDF(ikm, salt, "pcash.arena." ‖ role ‖ "." ‖ part ‖ txContext, 32). The
 * ikm is the envelope shared secret (recipient) or the outgoing key (sender); the context binds
 * the keys to their spend, so a repeated salt in another spend still gives other keys.
 */
export function arenaRegionKeys(role: ArenaRole, ikm: Uint8Array, salt: Uint8Array, txContext: Uint8Array): ArenaRegionKeys {
  const derive = (part: string) => hkdf(sha256, ikm, salt, concatBytes(utf8(`pcash.arena.${role}.${part}`), txContext), KEY_BYTES);
  return { anchorKey: derive("anchor"), bodyKey: derive("body") };
}

function assertKey(key: Uint8Array, label: string): void {
  if (key.length !== KEY_BYTES) throw new Error(`${label} must be ${KEY_BYTES} bytes`);
}

// ===========================================================================
// Record lists
// ===========================================================================

/** An output delivered by envelope: its shared secret opens the envelope and the recipient region. */
export interface SentEnvelope {
  slot: number;
  /** Recover records without adding the associated note to paid-output history. */
  recordsOnly?: true;
  sharedSecret: Uint8Array;
  recipientAddress: bigint;
}

/** An output delivered out of band, owned by `recipientAddress`. */
export interface SentOpening {
  slot: number;
  recipientAddress: bigint;
  assetId: bigint;
  amount: bigint;
  noteSecret: bigint;
}

/** Decoded routing records alongside the sender's ordinary data records. */
export interface SenderRecovery {
  records: DataRecord[];
  sentEnvelopes: SentEnvelope[];
  sentOpenings: SentOpening[];
}

function addressBytes(address: FieldNumberish, label: string): Uint8Array {
  return beBytes(toAddressField(address, label), ADDRESS_BYTES);
}

/** Application boundary: recovery records are wallet-managed. */
export function validateDataRecords(records: readonly DataRecord[]): void {
  for (const { schema, data } of records) {
    if (isBuiltinSchema(schema) && !DATA_TYPES.has(schema)) throw new Error(`record ${schema} is managed by the SDK`);
    if (schema === ARENA_RECORD.assetDefinition) decodeAssetDefinition(data);
    if (schema === ARENA_RECORD.sender) claimedSenderSchema.decode(data);
  }
}

/** Public input holds only application records; standard records always have a private audience. */
export function validatePublicRecords(records: readonly DataRecord[]): void {
  for (const { schema } of records) {
    if (isBuiltinSchema(schema)) throw new Error(`public records must be application records, not ${schema}`);
  }
}

function bySlot<T extends { slot: number }>(entries: readonly T[], label: string): T[] {
  const sorted = [...entries].sort((a, b) => a.slot - b.slot);
  sorted.forEach((entry, index) => {
    if (index > 0 && entry.slot === sorted[index - 1]!.slot) throw new Error(`${label} repeat slot ${entry.slot}`);
  });
  return sorted;
}

function encodeSentEnvelopes(entries: readonly SentEnvelope[]): Uint8Array {
  return concatBytes(...bySlot(entries, "sent envelopes").map(({ slot, sharedSecret, recipientAddress, recordsOnly }) => {
    // Codec callers supply slots; leave the high bit exclusively for the recovery flag.
    if (!Number.isInteger(slot) || slot < 0 || slot >= 32) throw new Error("sent envelope slot must be below 32");
    assertKey(sharedSecret, "sent envelope shared secret");
    return concatBytes(beBytes(slot | (recordsOnly ? 0x80 : 0), 1), sharedSecret, addressBytes(recipientAddress, "recipientAddress"));
  }));
}
function encodeSentOpenings(entries: readonly SentOpening[]): Uint8Array {
  return concatBytes(...bySlot(entries, "sent openings").map(opening => concatBytes(
    beBytes(opening.slot, 1), addressBytes(opening.recipientAddress, "recipientAddress"),
    field32(toField(opening.assetId, "assetId")), beBytes(opening.amount, 16), field32(toField(opening.noteSecret, "noteSecret")),
  )));
}

/** Parse a region's zero-padded records from an untrusted writer, enforcing the region's routing rules. */
function decodeRecordList(payload: Uint8Array, allowed: ReadonlySet<string>): DataRecord[] {
  const records = decodeRecords(payload, true);
  for (const { schema } of records) {
    if (isBuiltinSchema(schema) && !allowed.has(schema)) throw new Error(`record ${schema} is not allowed in this region`);
  }
  return records;
}

/** Interpret standard data after the region's routing rules hold. */
function validDataRecords(records: DataRecord[]): DataRecord[] {
  return records.filter(({ schema, data }) => {
    if (schema === ARENA_RECORD.sender) claimedSenderSchema.decode(data);
    // A malformed asset definition is unavailable without invalidating other records.
    if (schema === ARENA_RECORD.assetDefinition) {
      try {
        decodeAssetDefinition(data);
      } catch {
        return false;
      }
    }
    return true;
  });
}

export function decodeRecipientPayload(payload: Uint8Array): DataRecord[] {
  return validDataRecords(decodeRecordList(payload, DATA_TYPES));
}

function slotEntries<T extends { slot: number }>(data: Uint8Array | undefined, entryBytes: number, outputs: number, read: (entry: Uint8Array) => T): T[] {
  if (data === undefined) return [];
  if (data.length % entryBytes !== 0) throw new Error("sender record entries are malformed");
  const entries: T[] = [];
  let previous = -1;
  for (let offset = 0; offset < data.length; offset += entryBytes) {
    const entry = read(data.subarray(offset, offset + entryBytes));
    const { slot } = entry;
    if (slot <= previous) throw new Error("sender record slots must be strictly ascending");
    if (slot >= outputs) throw new Error(`sender record slot must be below ${outputs}`);
    entries.push(entry);
    previous = slot;
  }
  return entries;
}

function decodeSentEnvelopes(data: Uint8Array, outputs = 32): SentEnvelope[] {
  return slotEntries(data, SENT_ENVELOPE_BYTES, outputs, (entry) => ({
    slot: entry[0]! & 0x7f,
    ...(entry[0]! & 0x80 ? { recordsOnly: true as const } : {}),
    sharedSecret: entry.slice(1, 1 + KEY_BYTES),
    recipientAddress: bytesToBigInt(entry.subarray(1 + KEY_BYTES)),
  }));
}
function decodeSentOpenings(data: Uint8Array, outputs = 32): SentOpening[] {
  return slotEntries(data, SENT_OPENING_BYTES, outputs, (entry) => ({
    slot: entry[0]!,
    recipientAddress: bytesToBigInt(entry.subarray(1, 21)),
    assetId: toField(bytesToBigInt(entry.subarray(21, 53)), "sent opening assetId"),
    amount: bytesToBigInt(entry.subarray(53, 69)),
    noteSecret: toField(bytesToBigInt(entry.subarray(69, 101)), "sent opening noteSecret"),
  }));
}

export function decodeSenderPayload(payload: Uint8Array, shape: PrivateValueShape): SenderRecovery {
  const { outputs } = privateValueProfile(shape);
  const records = decodeRecordList(payload, SENDER_TYPES);
  return {
    records: validDataRecords(records.filter(({ schema }) => schema !== ARENA_RECORD.sentEnvelopes && schema !== ARENA_RECORD.sentOpenings)),
    sentEnvelopes: decodeSentEnvelopes(records.find(({ schema }) => schema === ARENA_RECORD.sentEnvelopes)?.data ?? new Uint8Array(0), outputs),
    sentOpenings: decodeSentOpenings(records.find(({ schema }) => schema === ARENA_RECORD.sentOpenings)?.data ?? new Uint8Array(0), outputs),
  };
}

// ===========================================================================
// Regions
// ===========================================================================

interface ArenaFrame {
  shape: PrivateValueShape;
  arenaBytes: number;
  cells: number;
  bitmapBytes: number;
  /** txContext, the spend every region key binds. */
  context: Uint8Array;
}

function arenaFrame(shape: PrivateValueShape, context: ArenaContext): ArenaFrame {
  return {
    shape,
    arenaBytes: privateValueProfile(shape).arenaBytes,
    cells: arenaCells(shape),
    bitmapBytes: arenaBitmapBytes(shape),
    context: arenaContextBytes(shape, context),
  };
}

function cellOffset(index: number): number {
  return ARENA_SALT_BYTES + ARENA_CELL_BYTES * index;
}

function cellAt(arena: Uint8Array, index: number): Uint8Array {
  return arena.subarray(cellOffset(index), cellOffset(index + 1));
}

function isZero(bytes: Uint8Array): boolean {
  return bytes.every((byte) => byte === 0);
}

/** Bit for cell i: byte floor(i / 8), bit 7 − (i mod 8). */
function bitmap(cells: readonly number[], bitmapBytes: number): Uint8Array {
  const bits = new Uint8Array(bitmapBytes);
  for (const cell of cells) bits[cell >> 3]! |= 0x80 >> (cell & 7);
  return bits;
}

/** Write one region. `continuation` is ascending; `payload` fits its cell count. */
function sealRegion(arena: Uint8Array, keys: ArenaRegionKeys, bitmapBytes: number, anchor: number, continuation: readonly number[], payload: Uint8Array): void {
  const listed = continuation.length <= bitmapBytes;
  const directory = listed ? Uint8Array.from(continuation) : bitmap(continuation, bitmapBytes);
  const prefixLength = Math.min(payload.length, ANCHOR_PLAINTEXT_BYTES - COUNT_BYTES - directory.length);
  const plaintext = new Uint8Array(ANCHOR_PLAINTEXT_BYTES);
  plaintext[0] = listed ? continuation.length : BITMAP_COUNT;
  plaintext.set(directory, COUNT_BYTES);
  plaintext.set(payload.subarray(0, prefixLength), COUNT_BYTES + directory.length);
  const anchorCell = gcm(keys.anchorKey, NONCE).encrypt(plaintext);
  arena.set(anchorCell, cellOffset(anchor));
  if (continuation.length === 0) return;
  const body = new Uint8Array(ARENA_CELL_BYTES * continuation.length - TAG_BYTES);
  body.set(payload.subarray(prefixLength));
  const sealed = gcm(keys.bodyKey, NONCE, anchorCell).encrypt(body);
  continuation.forEach((cell, index) => {
    arena.set(sealed.subarray(ARENA_CELL_BYTES * index, ARENA_CELL_BYTES * (index + 1)), cellOffset(cell));
  });
}

/** Continuation cells named by an anchor plaintext's count and directory, and the directory's length. */
function readDirectory(head: Uint8Array, anchor: number, frame: Pick<ArenaFrame, "cells" | "bitmapBytes">): { continuation: number[]; bytes: number } {
  const count = head[0]!;
  if (count === BITMAP_COUNT) {
    const bits = head.subarray(COUNT_BYTES, COUNT_BYTES + frame.bitmapBytes);
    const continuation: number[] = [];
    for (let cell = 0; cell < frame.cells; cell++) {
      if ((bits[cell >> 3]! & (0x80 >> (cell & 7))) !== 0) continuation.push(cell);
    }
    if (continuation.includes(anchor)) throw new Error("bitmap directory marks the anchor");
    if (continuation.length <= frame.bitmapBytes) throw new Error("bitmap directory for a list-sized region");
    return { continuation, bytes: frame.bitmapBytes };
  }
  if (count > frame.bitmapBytes) throw new Error(`invalid directory count ${count}`);
  const continuation = Array.from(head.subarray(COUNT_BYTES, COUNT_BYTES + count));
  continuation.forEach((cell, index) => {
    if (cell >= frame.cells) throw new Error("directory cell is out of range");
    if (cell === anchor) throw new Error("directory names the anchor");
    if (index > 0 && cell <= continuation[index - 1]!) throw new Error("directory cells must be strictly ascending");
  });
  return { continuation, bytes: count };
}

/**
 * Verify a whole region and return its records and zero padding, and its cells. Throws on any
 * failure. The anchor authenticates before its directory is read.
 */
function openRegionCells(arena: Uint8Array, frame: ArenaFrame, role: ArenaRole, ikm: Uint8Array, anchor: number): { payload: Uint8Array; cells: number[] } {
  if (!Number.isInteger(anchor) || anchor < 0 || anchor >= frame.cells) throw new Error("anchor is out of range");
  const keys = arenaRegionKeys(role, ikm, arena.subarray(0, ARENA_SALT_BYTES), frame.context);
  const anchorCell = cellAt(arena, anchor);
  const plaintext = gcm(keys.anchorKey, NONCE).decrypt(anchorCell);
  const { continuation, bytes } = readDirectory(plaintext, anchor, frame);
  const prefix = plaintext.subarray(COUNT_BYTES + bytes);
  if (continuation.length === 0) return { payload: prefix, cells: [anchor] };
  const body = gcm(keys.bodyKey, NONCE, anchorCell).decrypt(concatBytes(...continuation.map((cell) => cellAt(arena, cell))));
  return { payload: concatBytes(prefix, body), cells: [anchor, ...continuation] };
}

// ===========================================================================
// Writer
// ===========================================================================

export interface ArenaRecipient {
  /** Output slot whose envelope carries this region's anchor. */
  slot: number;
  /** The envelope's ML-KEM shared secret. */
  sharedSecret: Uint8Array;
  records: readonly DataRecord[];
}

export interface BuildArenaInput {
  shape: PrivateValueShape;
  context: ArenaContext;
  /** Written whenever present, even with no records, so the outgoing key finds every build. */
  sender?: { outgoingKey: Uint8Array; records: readonly DataRecord[] };
  recipients: readonly ArenaRecipient[];
  /** Application records written in plaintext at the front of the arena for any reader. */
  public?: readonly DataRecord[];
}

export interface BuiltArena {
  arena: Uint8Array;
  salt: Uint8Array;
  /** Anchor of each recipient region by slot: the envelope's `anchor`. A recipient without a region has no entry. */
  recipientAnchors: Map<number, number>;
}

/** Unbiased integer in [0, bound) by rejection sampling 32-bit draws. */
function uniformBelow(bound: number): number {
  const limit = 2 ** 32 - (2 ** 32 % bound);
  for (;;) {
    const draw = arenaRandom(4);
    const value = ((draw[0]! << 24) | (draw[1]! << 16) | (draw[2]! << 8) | draw[3]!) >>> 0;
    if (value < limit) return value % bound;
  }
}

/** The payload bytes selected by planning are the bytes the writer seals. */
export interface ArenaWritePlan {
  input: BuildArenaInput;
  allocation: ArenaPlan;
  senderPayload: Uint8Array | undefined;
  /** The public record list; undefined without public records. */
  publicPayload: Uint8Array | undefined;
  recipients: { recipient: ArenaRecipient; payload: Uint8Array }[];
}

/** Encode once before allocation. */
export function prepareArena(input: BuildArenaInput): ArenaWritePlan {
  const slots = new Set<number>();
  const outputs = privateValueProfile(input.shape).outputs;
  for (const recipient of input.recipients) {
    if (!Number.isInteger(recipient.slot) || recipient.slot < 0 || recipient.slot >= outputs) {
      throw new Error("arena recipient slot is out of range");
    }
    if (slots.has(recipient.slot)) throw new Error("duplicate arena recipient slot");
    slots.add(recipient.slot);
  }
  const publicRecords = input.public ?? [];
  validatePublicRecords(publicRecords);
  const publicPayload = publicRecords.length === 0 ? undefined : encodeRecords(publicRecords);
  const senderPayload = input.sender === undefined ? undefined : encodeRecords(input.sender.records);
  const recipients = input.recipients
    .filter(recipient => recipient.records.length > 0)
    .map(recipient => ({ recipient, payload: encodeRecords(recipient.records) }));
  const allocation = planArena({
    shape: input.shape,
    ...(senderPayload === undefined ? {} : { sender: senderPayload.length }),
    ...(publicPayload === undefined ? {} : { public: publicPayload.length }),
    regions: recipients.map(({ payload }) => payload.length),
  });
  return { input, allocation, senderPayload, publicPayload, recipients };
}

export function buildArena(input: BuildArenaInput): BuiltArena {
  return writeArena(prepareArena(input));
}

/** Allocate random cells and seal the already encoded plan. */
export function writeArena(prepared: ArenaWritePlan): BuiltArena {
  const { input, allocation: plan, senderPayload, publicPayload, recipients } = prepared;
  const { shape, sender } = input;
  const frame = arenaFrame(shape, input.context);
  if (!plan.fits) throw new Error(`arena regions need ${plan.usedCells} cells; the ${privateValueProfile(shape).name} arena has ${plan.totalCells}`);

  const salt = arenaRandom(ARENA_SALT_BYTES);
  const arena = new Uint8Array(frame.arenaBytes);
  arena.set(salt);
  if (publicPayload !== undefined) {
    // The arena starts zeroed, so the segment's padding to the end of its last cell is already zero.
    arena.set(concatBytes(PUBLIC_MARKER, beBytes(publicPayload.length, 2), publicPayload), cellOffset(0));
  }
  const senderAnchor = frame.cells - 1;
  // A partial Fisher–Yates over the cells between the segment and the sender anchor:
  // each deal draws uniformly from the cells not yet dealt.
  const pool = Array.from({ length: senderAnchor - plan.publicCells }, (_, index) => plan.publicCells + index);
  let dealt = 0;
  const deal = (count: number): number[] => {
    for (let index = dealt; index < dealt + count; index++) {
      const swap = index + uniformBelow(pool.length - index);
      [pool[index], pool[swap]] = [pool[swap]!, pool[index]!];
    }
    return pool.slice(dealt, (dealt += count));
  };
  const seal = (role: ArenaRole, ikm: Uint8Array, anchor: number, continuation: number[], payload: Uint8Array) =>
    sealRegion(arena, arenaRegionKeys(role, ikm, salt, frame.context), frame.bitmapBytes, anchor, continuation.sort((a, b) => a - b), payload);

  if (sender !== undefined) seal("sender", sender.outgoingKey, senderAnchor, deal(plan.senderCells - 1), senderPayload!);
  const recipientAnchors = new Map<number, number>();
  recipients.forEach(({ recipient, payload }, index) => {
    const [anchor, ...continuation] = deal(plan.cellsPerRegion[index]!);
    seal("recipient", recipient.sharedSecret, anchor!, continuation, payload);
    recipientAnchors.set(recipient.slot, anchor!);
  });
  // Without a sender region its reserved anchor is filler too.
  const filler = [...pool.slice(dealt), ...(sender === undefined ? [senderAnchor] : [])].sort((a, b) => a - b);
  for (const cell of filler) arena.set(arenaRandom(ARENA_CELL_BYTES), cellOffset(cell));
  return { arena, salt, recipientAnchors };
}

// ===========================================================================
// Readers
// ===========================================================================

/** The context is the caller's and must be well formed; arena bytes and anchors are untrusted. */
export interface ArenaReadInput {
  arena: Uint8Array;
  shape: PrivateValueShape;
  context: ArenaContext;
}

/**
 * One region's records followed by its zero padding, or null when no valid region of this role
 * and key sits at `anchor`.
 */
export function openRegion(input: ArenaReadInput & { role: ArenaRole; ikm: Uint8Array; anchor: number }): Uint8Array | null {
  const frame = arenaFrame(input.shape, input.context);
  try {
    if (input.arena.length !== frame.arenaBytes) return null;
    return openRegionCells(input.arena, frame, input.role, input.ikm, input.anchor).payload;
  } catch {
    return null;
  }
}

/** A recipient region's records, or null when it fails. The note stays valid. */
export function openRecipientRecords(input: ArenaReadInput & { sharedSecret: Uint8Array; anchor: number }): DataRecord[] | null {
  const frame = arenaFrame(input.shape, input.context);
  try {
    if (input.arena.length !== frame.arenaBytes) return null;
    return decodeRecipientPayload(openRegionCells(input.arena, frame, "recipient", input.sharedSecret, input.anchor).payload);
  } catch {
    return null;
  }
}

/** The sender region at cell C − 1, or null when none of this outgoing key verifies there. */
export function openSenderRecords(input: ArenaReadInput & { outgoingKey: Uint8Array }): SenderRecovery | null {
  const frame = arenaFrame(input.shape, input.context);
  try {
    if (input.arena.length !== frame.arenaBytes) return null;
    const region = openRegionCells(input.arena, frame, "sender", input.outgoingKey, frame.cells - 1);
    return decodeSenderPayload(region.payload, input.shape);
  } catch {
    return null;
  }
}

/**
 * The arena's public application records, or null when it has no valid public
 * segment. Needs no key and no transaction context: the profile follows from
 * the arena's length. The records authenticate no author.
 */
export function readPublicRecords(arena: Uint8Array): DataRecord[] | null {
  if (!Object.values(PRIVATE_VALUE_PROFILES).some(profile => profile.arenaBytes === arena.length)) return null;
  const start = cellOffset(0);
  if (!bytesEqual(arena.subarray(start, start + PUBLIC_MARKER.length), PUBLIC_MARKER)) return null;
  const length = (arena[start + PUBLIC_MARKER.length]! << 8) | arena[start + PUBLIC_MARKER.length + 1]!;
  const cells = publicCells(length);
  // The segment stops short of cell C − 1, the sender anchor.
  if (length === 0 || cellOffset(cells + 1) > arena.length) return null;
  const end = start + PUBLIC_HEADER_BYTES + length;
  if (!isZero(arena.subarray(end, cellOffset(cells)))) return null;
  try {
    const records = decodeRecords(arena.subarray(start + PUBLIC_HEADER_BYTES, end));
    return records.some(({ schema }) => isBuiltinSchema(schema)) ? null : records;
  } catch {
    return null;
  }
}

/** Standard record codecs; these definitions are wallet conventions, never consensus interpretation. */
export const claimedSenderSchema: import("./records.ts").RecordSchema<bigint> = {
  id: ARENA_RECORD.sender,
  encode(value) {
    return { schema: ARENA_RECORD.sender, data: addressBytes(value, "claimed sender") };
  },
  decode(data) {
    if (data.length !== ADDRESS_BYTES) throw new Error("claimed sender must be 20 bytes");
    return bytesToBigInt(data);
  },
};
export const assetDefinitionSchema: import("./records.ts").RecordSchema<AssetDefinition> = {
  id: ARENA_RECORD.assetDefinition,
  encode(value) {
    return { schema: ARENA_RECORD.assetDefinition, data: encodeAssetDefinition(value) };
  },
  decode: decodeAssetDefinition,
};
export const sentEnvelopesSchema: import("./records.ts").RecordSchema<readonly SentEnvelope[]> = {
  id: ARENA_RECORD.sentEnvelopes,
  encode(value) {
    return { schema: ARENA_RECORD.sentEnvelopes, data: encodeSentEnvelopes(value) };
  },
  decode: decodeSentEnvelopes,
};
export const sentOpeningsSchema: import("./records.ts").RecordSchema<readonly SentOpening[]> = {
  id: ARENA_RECORD.sentOpenings,
  encode(value) {
    return { schema: ARENA_RECORD.sentOpenings, data: encodeSentOpenings(value) };
  },
  decode: decodeSentOpenings,
};
