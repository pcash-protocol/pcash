import { orderedRecords } from "./recordHelpers.ts";
import { RECORD_SCHEMA } from "@pcash/sdk/protocol";
import { describe, it, expect } from "vitest";
import { generateMlKemKeyPair, trialOpenEnvelope, decodeDeliveryPayload } from "../src/protocol/envelope.ts";
import { sealSectionDelivery, outputRecords } from "../src/protocol/sectionDelivery.ts";
import { openSenderRecords, sentEnvelopesSchema } from "../src/protocol/arena.ts";
import { withArenaRandom } from "../src/protocol/arenaRandom.ts";
import { applicationSchemaId, encodeRecords, decodeRecords, memoSchema, type DataRecord } from "../src/protocol/records.ts";
import { fromHex, toHex } from "../src/utils/hex.ts";

const a = generateMlKemKeyPair(new Uint8Array(64).fill(1));
const b = generateMlKemKeyPair(new Uint8Array(64).fill(2));
const outgoingKey = new Uint8Array(32).fill(3);
const context = { chainId: 1n, transactionType: 0 as const, nullifiers: [1n, 2n, 3n, 4n] };
const record = (schema: string, value: number): DataRecord => ({ schema, data: Uint8Array.of(value) });
function build() {
  return sealSectionDelivery({ shape: 0, context, envelopes: [], freeSlots: [0, 1, 2, 3, 4], sender: { outgoingKey }, data: {
    recipients: [{ recipientAddress: 1n, receiveKey: a.publicKey, records: [memoSchema.encode("for A")] },
      { recipientAddress: 2n, receiveKey: b.publicKey, records: [record(applicationSchemaId("com.example.secret"), 2)] }],
    self: [memoSchema.encode("self")],
  } });
}
describe("transaction data", () => {
  it("uses frozen compact application IDs and length-delimited framing", () => {
    const records = [record(applicationSchemaId("com.b"), 2), record(applicationSchemaId("com.a"), 1)];
    // ID (4, top bit set) ‖ uvarint length ‖ data, in identifier order.
    expect(toHex(encodeRecords(records))).toBe("0x81df150c0102ce2067e00101");
    expect(decodeRecords(encodeRecords(records))).toEqual(orderedRecords([...records].reverse()));
    expect(() => encodeRecords([records[0]!, records[0]!])).toThrow(/duplicate/);
    expect(() => decodeRecords(Uint8Array.from([1, 255]))).toThrow();
  });
  it("separates two recipients and sender data without any note", () => {
    const sealed = build();
    for (const [slot, key, expected] of [[0, a, [memoSchema.encode("for A")]], [1, b, [record(applicationSchemaId("com.example.secret"), 2)]]] as const) {
      const opened = trialOpenEnvelope(key.secretKey, sealed.envelopes.get(slot)!)!;
      const payload = decodeDeliveryPayload(opened.plaintext, { chainId: 1n });
      expect("kind" in payload && payload.kind).toBe("message");
      expect(outputRecords(payload, opened.sharedSecret, { ...sealed, shape: 0, context })!).toEqual(expected);
    }
    expect(trialOpenEnvelope(b.secretKey, sealed.envelopes.get(0)!)).toBeNull();
    const self = openSenderRecords({ arena: sealed.arena, shape: 0, context, outgoingKey })!;
    expect(self.records?.find(record => record.schema === RECORD_SCHEMA.memo)?.data).toEqual(new TextEncoder().encode("self"));
    expect(self.sentEnvelopes).toHaveLength(2);
    expect(openSenderRecords({ arena: sealed.arena, shape: 0, context, outgoingKey: new Uint8Array(32) })).toBeNull();
    expect(openSenderRecords({ arena: sealed.arena, shape: 0, context: { ...context, nullifiers: [5n, 2n, 3n, 4n] }, outgoingKey })).toBeNull();
  });
  it("rejects missing recipient capacity and arena overflow before proving", () => {
    expect(() => sealSectionDelivery({ shape: 0, context, envelopes: [], data: { recipients: [{ recipientAddress: 1n, receiveKey: a.publicKey, records: [memoSchema.encode("hi")] }] } })).toThrow(/slots/);
    expect(() => sealSectionDelivery({ shape: 0, context, envelopes: [], sender: { outgoingKey }, data: { self: [{ schema: applicationSchemaId("com.example.large"), data: new Uint8Array(3000) }] } })).toThrow(/arena/);
  });
});

describe("transaction data wire vectors and capacity", () => {
  it("freezes message-only plaintext and rejects malformed fields", async () => {
    const { encodeMessagePayload } = await import("../src/protocol/envelope.ts");
    const bytes = encodeMessagePayload({ chainId: 1n, outputIndex: 0, anchor: 17 });
    expect(toHex(bytes)).toBe("0x010200000001" + "00".repeat(100) + "0011");
    expect(() => decodeDeliveryPayload(bytes, { chainId: 2n })).toThrow();
    bytes[6] = 1;
    expect(() => decodeDeliveryPayload(bytes, { chainId: 1n })).toThrow();
  });



  it("rejects occupied slots and SDK-managed records from application input", async () => {
    const { storeTransactionData } = await import("../src/delivery/transactionData.ts");
    const { RECORD_SCHEMA } = await import("../src/protocol/records.ts");
    expect(() => sealSectionDelivery({ shape: 0, context, envelopes: [{ slot: 0, receiveKey: a.publicKey }], freeSlots: [0] })).toThrow(/slots/);
    for (const schema of [RECORD_SCHEMA.sentEnvelopes, RECORD_SCHEMA.sentOpenings]) {
      expect(() => storeTransactionData({ self: [record(schema, 1)] })).toThrow(/managed/);
    }
  });

  it("freezes typed recovery and claimed-sender codec bodies", async () => {
    const { claimedSenderSchema, sentEnvelopesSchema, sentOpeningsSchema } = await import("../src/protocol/arena.ts");
    expect(toHex(claimedSenderSchema.encode(1n).data)).toBe("0x" + "00".repeat(19) + "01");
    const sent = [{ slot: 2, sharedSecret: new Uint8Array(32).fill(3), recipientAddress: 4n }];
    expect(toHex(sentEnvelopesSchema.encode(sent).data)).toBe("0x02" + "03".repeat(32) + "00".repeat(19) + "04");
    expect(sentEnvelopesSchema.decode(sentEnvelopesSchema.encode(sent).data)).toEqual(sent);
    const opening = [{ slot: 2, recipientAddress: 4n, assetId: 5n, amount: 6n, noteSecret: 7n }];
    expect(toHex(sentOpeningsSchema.encode(opening).data)).toBe("0x02" + "00".repeat(19) + "04" + "00".repeat(31) + "05" + "00".repeat(15) + "06" + "00".repeat(31) + "07");
  });
});


it("matches persisted requests regardless of JSON object-key order", async () => {
  const { storeTransactionData, sameTransactionData } = await import("../src/delivery/transactionData.ts");
  const request = { recipients: [{ to: "0x0000000000000000000000000000000000000001", records: [memoSchema.encode("private")] }], self: [memoSchema.encode("self")] };
  const stored = storeTransactionData(request)!;
  const reordered = { public: stored.public, self: stored.self, recipients: stored.recipients.map(({ to, records }) => ({ records, to })) };
  expect(sameTransactionData(reordered, request)).toBe(true);
  expect(sameTransactionData(reordered, { ...request, public: [record(applicationSchemaId("com.example.post"), 1)] })).toBe(false);
  expect(sameTransactionData(reordered, { ...request, self: [memoSchema.encode("changed")] })).toBe(false);
  expect(sameTransactionData(reordered, { ...request, recipients: [{ ...request.recipients[0]!, to: "0x0000000000000000000000000000000000000002" }] })).toBe(false);
});



it("freezes records-only recovery flags and orders entries by their decoded slot", async () => {
  const { sentEnvelopesSchema } = await import("../src/protocol/arena.ts");
  const entries = [
    { slot: 2, recordsOnly: true as const, sharedSecret: new Uint8Array(32).fill(3), recipientAddress: 4n },
    { slot: 3, sharedSecret: new Uint8Array(32).fill(5), recipientAddress: 6n },
  ];
  const bytes = fromHex("0x82" + "03".repeat(32) + "00".repeat(19) + "04" + "03" + "05".repeat(32) + "00".repeat(19) + "06");
  expect(sentEnvelopesSchema.encode(entries).data).toEqual(bytes);
  expect(sentEnvelopesSchema.decode(bytes)).toEqual(entries);
  const duplicate = bytes.slice(); duplicate[53] = 2;
  expect(() => sentEnvelopesSchema.decode(duplicate)).toThrow(/strictly ascending/);
  const reservedBits = bytes.slice(); reservedBits[0] = 0xa2;
  expect(() => sentEnvelopesSchema.decode(reservedBits)).toThrow(/below 32/);
});

it("freezes application IDs and preserves unknown IDs without a registry", () => {
  // The first four SHA-256 bytes of the name, with the top bit set.
  expect(applicationSchemaId("org.pcash.lineage")).toBe("0xfe3792a6");
  expect(applicationSchemaId("com.a")).toBe("0xce2067e0");
  expect(applicationSchemaId("com.b")).toBe("0x81df150c");
  const wire = fromHex("0x0101618123456702ff00");
  const records = [
    memoSchema.encode("a"),
    { schema: "0x81234567", data: Uint8Array.of(255, 0) },
  ];
  expect(decodeRecords(wire)).toEqual(records);
  expect(encodeRecords(records)).toEqual(wire);
  for (const name of ["", "memo", "Com.example", "com..a", "com.a\u0000", "\ufeffcom.a", "com." + "a".repeat(252)]) {
    expect(() => applicationSchemaId(name)).toThrow(/namespaced ASCII/);
  }
});

it("rejects malformed, duplicate, and noncanonical wire identifiers", () => {
  for (const wire of [
    "0x81234567", // missing length
    "0x8123456702ff", // truncated data
    "0x812345", // truncated application ID
    "0x0600", // unassigned standard IDs
    "0x0700",
    "0x7f00",
    "0x0000", // zero is no identifier
    "0x01000100", // duplicate standard ID
    "0x02000100", // unordered standard IDs
    "0x81234567008123456700", // duplicate application ID
    "0x81234567000100", // standard IDs precede application IDs
    "0x018000", // noncanonical uvarint length
    "0x01808004", // length above 65535
  ]) expect(() => decodeRecords(fromHex(wire))).toThrow();
  for (const schema of ["org.pcash.memo", "0x00", "0x07", "0x000123456789abcdef", "0x01234567", "0x8123456", "0x81234567ab", "0x8123ABCD"]) {
    expect(() => encodeRecords([{ schema, data: new Uint8Array(0) }])).toThrow(/schema/);
  }
});

it("delivers a message through cell zero", () => {
  const records = [memoSchema.encode("at zero")];
  const sealed = withArenaRandom(length => new Uint8Array(length), () => sealSectionDelivery({
    shape: 0,
    context,
    envelopes: [],
    freeSlots: [0],
    data: { recipients: [{ recipientAddress: 1n, receiveKey: a.publicKey, records }] },
  }));
  const opened = trialOpenEnvelope(a.secretKey, sealed.envelopes.get(0)!)!;
  const payload = decodeDeliveryPayload(opened.plaintext, { chainId: 1n });
  expect(payload).toEqual({ kind: "message", chainId: 1n, outputIndex: 0, anchor: 0 });
  expect(outputRecords(payload, opened.sharedSecret, { ...sealed, shape: 0, context })).toEqual(records);
});

describe("public transaction data", () => {
  const post = (value: number) => record(applicationSchemaId("com.example.post"), value);

  it("snapshots public records into the stored request and its hash", async () => {
    const { storeTransactionData, restoreTransactionData, transactionDataHash } = await import("../src/delivery/transactionData.ts");
    const request = { public: [post(1)] };
    const stored = storeTransactionData(request)!;
    expect(stored).toEqual({ recipients: [], self: "0x", public: toHex(encodeRecords([post(1)])) });
    expect(restoreTransactionData(stored)).toEqual({ recipients: [], self: [], public: [post(1)] });
    expect(transactionDataHash(request)).not.toBe(transactionDataHash({ public: [post(2)] }));
    expect(() => storeTransactionData({ public: [memoSchema.encode("not public")] })).toThrow(/application records/);
  });

  it("publishes without recipients or an outgoing key, readable by anyone", async () => {
    const { readPublicRecords } = await import("../src/protocol/arena.ts");
    const sealed = sealSectionDelivery({ shape: 0, context, envelopes: [], data: { public: [post(1)] } });
    expect(sealed.envelopes.size).toBe(0);
    expect(readPublicRecords(sealed.arena)).toEqual([post(1)]);
  });

  it("reports exactly the largest public record that fits", async () => {
    const { maxPublicBytes, maxMemoBytes, paymentMaxMemoBytes } = await import("../src/protocol/sectionDelivery.ts");
    const { readPublicRecords } = await import("../src/protocol/arena.ts");
    // An empty sender region takes one cell; 39 carry 65 · 39 − 10 list bytes, less ID (4) and uvarint length (2).
    const limit = maxPublicBytes({ shape: 0, sender: [] });
    expect(limit).toBe(2519);
    const publish = (bytes: number) => sealSectionDelivery({ shape: 0, context, envelopes: [], sender: { outgoingKey },
      data: { public: [{ schema: applicationSchemaId("com.example.post"), data: new Uint8Array(bytes).fill(7) }] } });
    expect(readPublicRecords(publish(limit).arena)![0]!.data).toHaveLength(limit);
    expect(() => publish(limit + 1)).toThrow("arena regions need 41 cells; the S arena has 40");
    // A 100-byte public record (a 105-byte list) takes two cells from the payment memo's 38.
    const sentEnvelope = [sentEnvelopesSchema.encode([{ slot: 0, sharedSecret: new Uint8Array(32), recipientAddress: 1n }])];
    expect(maxMemoBytes({ shape: 0, sender: sentEnvelope })).toBe(paymentMaxMemoBytes({ shape: 0, includeSender: false }));
    expect(maxMemoBytes({ shape: 0, sender: sentEnvelope, public: [{ schema: applicationSchemaId("com.example.post"), data: new Uint8Array(100) }] })).toBe(65 * 36 - 33 - 5 - 3);
  });
});
