import { orderedRecords, applicationDataRecords } from "./recordHelpers.ts";
import { applicationSchemaId, memoSchema, type DataRecord } from "../src/protocol/records.ts";
import { claimedSenderSchema } from "../src/protocol/arena.ts";
// Opaque application records travel in each output's recipient region of the
// section's arena, beside the memo and claimed sender, and reach only the
// holder of that output's envelope secret.

import { describe, expect, it } from "vitest";
import { buildNativeTransfer } from "../src/builders/nativeTransfer.ts";
import { OUTPUT_DATA_BYTES } from "../src/constants/params.ts";
import { decodePayload, decryptEnvelope, sizeClassFiller } from "../src/protocol/envelope.ts";
import { privateValueProfileFixture } from "./privateValueProfileFixtures.ts";
import { receiveOutput } from "./sectionReading.ts";

const fixture = privateValueProfileFixture({ shape: 0, scenario: "minimal" });
const { params, recipients, wallet } = fixture;
const recipient = recipients[0]!;
const audience = (records: readonly DataRecord[]) => ({ recipientAddress: BigInt(params.recipientAddress!), receiveKey: params.recipientReceiveKey!, records });
const dataFor = (records: readonly DataRecord[]) => ({ recipients: [audience(records)] });

describe("application records in recipient regions", () => {
  it("delivers different records to the recipient and the change owner", () => {
    const recipientRecords = [{ schema: applicationSchemaId("com.example.record007"), data: Uint8Array.from({ length: 98 }, (_, index) => index) }, { schema: applicationSchemaId("com.example.record255"), data: Uint8Array.of(7) }];
    const changeRecords = [{ schema: applicationSchemaId("com.example.record017"), data: new Uint8Array(98).fill(2) }];
    const build = buildNativeTransfer({ ...params,
data: { recipients: [audience([...recipientRecords, memoSchema.encode("payment"), claimedSenderSchema.encode(wallet.address)]),
      { recipientAddress: wallet.address, receiveKey: wallet.mlKemPublicKey!, records: changeRecords }] } });
    expect(build.outputData.every((data) => data.length === OUTPUT_DATA_BYTES)).toBe(true);

    const paid = receiveOutput(build, recipient.mlKemSecretKey!, 0);
    expect(paid.note.amount).toBe(params.paymentAmount);
    expect(paid.records).toEqual(orderedRecords([...recipientRecords, memoSchema.encode("payment"), claimedSenderSchema.encode(wallet.address)]));

    const change = receiveOutput(build, wallet.mlKemSecretKey!, 1);
    expect(change.records).toEqual(changeRecords);
    expect(decryptEnvelope(wallet.mlKemSecretKey!, build.outputData[0]!)).toBeNull();
  });

  it("keeps opaque application content byte for byte", () => {
    const applicationRecords = [
      { schema: applicationSchemaId("com.example.record007"), data: Uint8Array.of(255) },
      { schema: applicationSchemaId("com.example.record017"), data: new Uint8Array(98) },
      { schema: applicationSchemaId("com.example.record200"), data: new TextEncoder().encode("opaque application content") },
    ];
    const build = buildNativeTransfer({ ...params, data: dataFor(applicationRecords) });
    const paid = receiveOutput(build, recipient.mlKemSecretKey!, 0);
    expect(paid.records).toEqual(orderedRecords(applicationRecords));
    expect(paid.note.noteSecret).toBe(build.outputNoteSecrets[0]);
  });

  it("spreads a record larger than one cell over continuation cells", () => {
    const applicationRecords = [{ schema: applicationSchemaId("com.example.record009"), data: Uint8Array.from({ length: 1500 }, (_, index) => (index * 13) & 0xff) }];
    const build = buildNativeTransfer({ ...params, data: dataFor(applicationRecords) });
    expect(receiveOutput(build, recipient.mlKemSecretKey!, 0).records).toEqual(applicationRecords);
  });

  it("names no region for an output without records", () => {
    const build = buildNativeTransfer(params);
    const paid = receiveOutput(build, recipient.mlKemSecretKey!, 0);
    expect(paid.note).not.toHaveProperty("anchor");
    expect(paid.records).toBeNull();
    const plaintext = decryptEnvelope(recipient.mlKemSecretKey!, build.outputData[0]!)!;
    expect(plaintext[1]).toBe(0);
    expect(decodePayload(plaintext, { chainId: params.chainId })).not.toHaveProperty("anchor");
  });

  it.each([["bad"], [applicationSchemaId("com.example.a"), applicationSchemaId("com.example.a")], ["Com.example.a"]])("rejects invalid or duplicate schemas %j", (...schemas) => {
    expect(() => buildNativeTransfer({ ...params, data: dataFor(schemas.map(schema => ({ schema, data: Uint8Array.of(1) }))) })).toThrow(/schema/);
  });
  it("retains an empty application payload", () => {
    const records = [{ schema: applicationSchemaId("com.example.empty"), data: new Uint8Array() }];
    const build = buildNativeTransfer({ ...params, data: dataFor(records) });
    expect(applicationDataRecords(receiveOutput(build, recipient.mlKemSecretKey!, 0).records ?? [])).toEqual(orderedRecords(records));
  });

  it("allocates a message-only envelope when a paid note is delivered out of band", () => {
    const records = [{ schema: applicationSchemaId("com.example.record007"), data: new Uint8Array(98).fill(1) }];
    const build = buildNativeTransfer({ ...params, outputData: [sizeClassFiller()], data: dataFor(records) });
    expect(decryptEnvelope(recipient.mlKemSecretKey!, build.outputData[0]!)).toBeNull();
    expect(decryptEnvelope(recipient.mlKemSecretKey!, build.outputData[2]!)).not.toBeNull();
  });
});
