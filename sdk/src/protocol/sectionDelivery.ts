import { APPLICATION_ID_BYTES, encodeRecords, MAX_RECORD_BYTES, RECORD_SCHEMA, type DataRecord, type ResolvedTransactionData } from "./records.ts";
// Reference delivery of one private-value section: its envelopes and its arena.
// Non-consensus. A builder encapsulates every envelope-delivered output first,
// because each recipient region is keyed by its envelope's shared secret; then
// it builds the arena, and finally seals each envelope plaintext with the
// anchor of its region.

import { privateValueProfile, type PrivateValueShape } from "../constants/privateValueProfiles.ts";
import { uvarintLength } from "../utils/byteCursor.ts";
import { assetDefinitionAssetId, decodeAssetDefinition, type AssetDefinition } from "./assetDefinition.ts";
import {
  arenaCells,
  prepareArena,
  writeArena,
  validateDataRecords,
  claimedSenderSchema,
  sentEnvelopesSchema,
  sentOpeningsSchema,
  assetDefinitionSchema,
  openRecipientRecords,
  planArena,
  publicCapacity,
  regionCapacity,
  type ArenaContext,
  type SentEnvelope,
  type SentOpening,
} from "./arena.ts";
import {
  decodePayload,
  encodeMessagePayload,
  encapsulateEnvelope,
  encodePayload,
  openEnvelope,
  sealEncapsulatedEnvelope,
  type NotePayload,
  type MessagePayload,
} from "./envelope.ts";

/**
 * The building wallet's sender region. Written whenever present, even with no
 * records, so the wallet's outgoing key recognizes every transaction it built.
 */
export interface ArenaSender {
  /** 32 bytes the wallet derives from its recovery root. */
  outgoingKey: Uint8Array;
  /** Records only the building wallet reads back. */
  records?: readonly DataRecord[];
}

/** One output a builder delivers by envelope, before it is sealed. */
export interface EnvelopeOutput {
  slot: number;
  /** The recipient's ML-KEM-768 public key. */
  receiveKey: Uint8Array;
  /** Address whose note this envelope delivers, including owner change. */
  recipientAddress?: bigint;
  note?: { chainId: bigint; assetId: bigint; amount: bigint; owner: bigint; noteSecret: bigint };
  /** Records the recipient reads from its region. */
  records?: readonly DataRecord[];
  /** The payee's address, recorded as a sent envelope. Omitted for change and relay fees. */
  sentTo?: bigint;
}

export interface SectionDeliveryInput {
  shape: PrivateValueShape;
  context: ArenaContext;
  envelopes: readonly EnvelopeOutput[];
  /** Only dummy slots without explicit output-data overrides may carry message-only delivery. */
  freeSlots?: readonly number[];
  data?: ResolvedTransactionData | undefined;
  sender?: ArenaSender;
  /** Out-of-band outputs whose openings the builder knows. Ignored without a sender. */
  sentOpenings?: readonly SentOpening[];
  /** The asset an action moves, for the sender region. Ignored without a sender. */
  assetDefinition?: AssetDefinition;
}

export interface SectionDelivery {
  arena: Uint8Array;
  /** The sealed envelope of every slot in `envelopes`. */
  envelopes: Map<number, Uint8Array>;
}

/**
 * Encapsulate every envelope, build the arena with each recipient's region
 * and the sender region, then seal every envelope with its region's anchor.
 * Throws before any proof when the regions do not fit the profile's arena.
 */
export function sealSectionDelivery(input: SectionDeliveryInput): SectionDelivery {
  const envelopes: (EnvelopeOutput & { recordsTo?: bigint })[] = input.envelopes.map(output => {
    validateDataRecords(output.records ?? []);
    return { ...output };
  });
  const freeSlots = [...input.freeSlots ?? []];
  // The low-level builder caller supplies these slots; reject overlap before assigning delivery.
  const slots = [...envelopes.map(output => output.slot), ...freeSlots];
  if (new Set(slots).size !== slots.length || slots.some(slot => !Number.isInteger(slot) || slot < 0 || slot >= privateValueProfile(input.shape).outputs)) {
    throw new Error("envelope slots must be distinct and within the selected profile");
  }
  for (const recipient of input.data?.recipients ?? []) {
    validateDataRecords(recipient.records);
    const records = recipient.records;
    const existing = envelopes.find(output => (output.recipientAddress ?? output.sentTo) === recipient.recipientAddress
      && output.receiveKey.length === recipient.receiveKey.length && output.receiveKey.every((byte, index) => byte === recipient.receiveKey[index]));
    if (existing !== undefined) {
      existing.recordsTo = recipient.recipientAddress;
      existing.records = [...existing.records ?? [], ...recipient.records];
    } else {
      const slot = freeSlots.shift();
      if (slot === undefined) throw new Error("transaction data needs more envelope slots than this profile provides");
      envelopes.push({ slot, receiveKey: recipient.receiveKey, records, recordsTo: recipient.recipientAddress });
    }
  }
  if ((input.data?.self?.length ?? 0) > 0 && input.sender === undefined) throw new Error("self records require an outgoing key");
  const selfRecords = [
    ...(input.sender !== undefined && input.assetDefinition !== undefined ? [assetDefinitionSchema.encode(input.assetDefinition)] : []),
    ...(input.sender?.records ?? []), ...(input.data?.self ?? []),
  ];
  validateDataRecords(selfRecords);
  const encapsulations = new Map(envelopes.map((output) => [output.slot, encapsulateEnvelope(output.receiveKey)]));
  const sentEnvelopes: SentEnvelope[] = envelopes
    .filter((output) => output.sentTo !== undefined || output.recordsTo !== undefined)
    .map((output) => ({
      slot: output.slot, sharedSecret: encapsulations.get(output.slot)!.sharedSecret,
      recipientAddress: output.sentTo ?? output.recordsTo!,
      ...(output.sentTo === undefined ? { recordsOnly: true as const } : {}),
    }));
  const sender = input.sender === undefined ? undefined : {
    outgoingKey: input.sender.outgoingKey,
    records: [
      ...selfRecords,
      ...(sentEnvelopes.length === 0 ? [] : [sentEnvelopesSchema.encode(sentEnvelopes)]),
      ...((input.sentOpenings?.length ?? 0) === 0 ? [] : [sentOpeningsSchema.encode(input.sentOpenings!)]),
    ],
  };
  const built = writeArena(prepareArena({
    shape: input.shape,
    context: input.context,
    ...(sender === undefined ? {} : { sender }),
    recipients: envelopes
      .filter(output => (output.records?.length ?? 0) > 0)
      .map(output => ({ slot: output.slot, sharedSecret: encapsulations.get(output.slot)!.sharedSecret, records: output.records! })),
    ...(input.data?.public === undefined ? {} : { public: input.data.public }),
  }));
  const sealed = new Map<number, Uint8Array>();
  for (const output of envelopes) {
    const anchor = built.recipientAnchors.get(output.slot);
    const payload = output.note === undefined
      ? encodeMessagePayload({ chainId: BigInt(input.context.chainId), outputIndex: output.slot, anchor: anchor! })
      : encodePayload({ ...output.note, outputIndex: output.slot, ...(anchor === undefined ? {} : { anchor }) });
    sealed.set(output.slot, sealEncapsulatedEnvelope(encapsulations.get(output.slot)!, payload));
  }
  return { arena: built.arena, envelopes: sealed };
}

// ===========================================================================
// Capacity
// ===========================================================================

/** A standard record's one-byte type. */
const STANDARD_ID_BYTES = 1;

/** The longest record data that fits `available` bytes behind its identifier and uvarint length. */
function recordDataCapacity(available: number, identifierBytes: number): number {
  let data = Math.min(MAX_RECORD_BYTES, available - identifierBytes - 1);
  while (data > 0 && identifierBytes + uvarintLength(data) + data > available) data--;
  return Math.max(0, data);
}

/** Cells left beside the given regions and public records, by the planner the arena allocates by. */
function freeCells(plan: { shape: PrivateValueShape; regions?: readonly number[]; sender?: readonly DataRecord[]; public?: readonly DataRecord[] }): number {
  const used = planArena({
    shape: plan.shape,
    ...(plan.sender === undefined ? {} : { sender: encodeRecords(plan.sender).length }),
    ...(plan.public === undefined ? {} : { public: encodeRecords(plan.public).length }),
    regions: plan.regions ?? [],
  }).usedCells;
  return arenaCells(plan.shape) - used;
}

/**
 * The largest memo one recipient's region can carry beside every other region
 * the section writes: the other recipients' payload lengths, the sender region,
 * and the public segment.
 */
export function maxMemoBytes(plan: {
  shape: PrivateValueShape;
  /** The memo recipient's other records. */
  records?: readonly DataRecord[];
  /** Payload lengths of every other recipient region. */
  regions?: readonly number[];
  sender?: readonly DataRecord[];
  public?: readonly DataRecord[];
}): number {
  const free = freeCells(plan);
  if (free < 1) return 0;
  return recordDataCapacity(regionCapacity(free, plan.shape) - encodeRecords(plan.records ?? []).length, STANDARD_ID_BYTES);
}

/**
 * The largest application record the public segment can carry beside the
 * segment's other records and every private region the section writes. A
 * wallet's publish-only transaction has an empty sender region: `sender: []`.
 */
export function maxPublicBytes(plan: {
  shape: PrivateValueShape;
  /** The segment's other public records. */
  records?: readonly DataRecord[];
  /** Payload lengths of every recipient region. */
  regions?: readonly number[];
  sender?: readonly DataRecord[];
}): number {
  const { records, ...others } = plan;
  const free = freeCells(others);
  if (free < 1) return 0;
  return recordDataCapacity(publicCapacity(free) - encodeRecords(records ?? []).length, APPLICATION_ID_BYTES);
}

/**
 * The largest memo a wallet's native payment carries: one recipient, owner
 * change and a relay fee without records, and a sender region naming the
 * payment. `includeSender` adds the claimed-sender record beside the memo.
 */
export function paymentMaxMemoBytes(params: { shape: PrivateValueShape; includeSender: boolean }): number {
  return maxMemoBytes({
    shape: params.shape,
    records: params.includeSender ? [claimedSenderSchema.encode(1n)] : [],
    sender: [sentEnvelopesSchema.encode([{ slot: 0, sharedSecret: new Uint8Array(32), recipientAddress: 1n }])],
  });
}

// ===========================================================================
// Reading one output
// ===========================================================================

/** Arena bytes and context of the section an output belongs to. */
export interface OutputArena {
  arena: Uint8Array;
  shape: PrivateValueShape;
  context: ArenaContext;
}

/**
 * The records of a decrypted envelope's output, or null when it names no
 * region or its region is unavailable. These records are independent of notes.
 */
export function deliveryRecords(
  payload: NotePayload | MessagePayload,
  sharedSecret: Uint8Array,
  source: OutputArena,
): DataRecord[] | null {
  if (payload.anchor === undefined) return null;
  return openRecipientRecords({
    arena: source.arena,
    shape: source.shape,
    context: source.context,
    sharedSecret,
    anchor: payload.anchor,
  });
}

/** Associate an asset definition with a note only when it derives that note's asset. */
export function noteAssetRecords(records: DataRecord[] | null, assetId: bigint): DataRecord[] | null {
  if (records === null) return null;
  return records.filter(record => {
    if (record.schema !== RECORD_SCHEMA.assetDefinition) return true;
    try {
      return assetId !== 0n && assetDefinitionAssetId(decodeAssetDefinition(record.data)) === assetId;
    } catch { return false; }
  });
}

export function outputRecords(payload: NotePayload | MessagePayload, sharedSecret: Uint8Array, source: OutputArena): DataRecord[] | null {
  const records = deliveryRecords(payload, sharedSecret, source);
  return "kind" in payload ? records : noteAssetRecords(records, payload.assetId);
}

export interface DisclosedOutput {
  note: NotePayload;
  /** Null when the output has no region or its region is unavailable. */
  records: DataRecord[] | null;
}

/**
 * Open one output with its envelope's shared secret, the per-output disclosure
 * key: the note opening and every record its region carries. Null when the
 * secret does not open that slot's envelope.
 */
export function discloseOutput(params: OutputArena & {
  sharedSecret: Uint8Array;
  slot: number;
  outputData: readonly Uint8Array[];
}): DisclosedOutput | null {
  const { outputs } = privateValueProfile(params.shape);
  if (!Number.isInteger(params.slot) || params.slot < 0 || params.slot >= outputs || params.outputData.length !== outputs) return null;
  const plaintext = openEnvelope(params.sharedSecret, params.outputData[params.slot]!);
  if (plaintext === null) return null;
  let note: NotePayload;
  try {
    note = decodePayload(plaintext, { chainId: params.context.chainId });
  } catch {
    return null;
  }
  if (note.outputIndex !== params.slot) return null;
  return { note, records: outputRecords(note, params.sharedSecret, params) };
}
