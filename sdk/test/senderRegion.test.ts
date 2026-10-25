import { applicationSchemaId } from "../src/protocol/records.ts";
import { orderedRecords, applicationDataRecords } from "./recordHelpers.ts";
import { RECORD_SCHEMA, claimedSenderSchema } from "@pcash/sdk/protocol";
import { memoData } from "./memoData.ts";
// A native payment carries a memo and the claimed sender in the recipient's
// region, and the building wallet's sender region: one region anchored at the
// arena's last cell under its outgoing key, listing every envelope it paid
// (with that envelope's shared secret) and every output whose opening it
// chose, so the wallet can reopen what it paid from chain data alone.

import { describe, expect, it } from "vitest";
import { buildNativeTransfer, defaultEcdsaRuleSet } from "../src/builders/nativeTransfer.ts";
import { MERKLE_DEPTH } from "../src/constants/params.ts";
import { PCASH_CHAIN_ID } from "../src/constants/networkProfile.ts";
import { SparseMerkleTree } from "../src/crypto/tree.ts";
import { accountStateCommitment } from "../src/protocol/account.ts";
import { openSenderRecords } from "../src/protocol/arena.ts";
import { decodePayload, decryptEnvelope, generateMlKemKeyPair, openEnvelope, sizeClassFiller } from "../src/protocol/envelope.ts";
import { discloseOutput } from "../src/protocol/sectionDelivery.ts";
import {
  fullOutputCommitment,
  noteBodyCommitment,
  nullifierKeyCommitment,
  ownerCommitment,
} from "../src/protocol/notes.ts";
import { bytesEqual } from "../src/utils/bytes.ts";
import { syntheticRecentBlockOpenings, TEST_DEFAULT_RULE_SECRETS } from "@pcash/test-support/protocol-fixtures";
import { receiveOutput, sectionArena } from "./sectionReading.ts";
import { deriveTestWallet } from "./testWallet.ts";

const wallet = deriveTestWallet({ mlKem: "deterministic" });
const recipientKeys = generateMlKemKeyPair();
const chainId = PCASH_CHAIN_ID;
const RECIPIENT = 0x1234567890123456789012345678901234567890n;
const memo = new TextEncoder().encode("Alice — dinner");
const outgoingKey = new Uint8Array(32).fill(0x0e);
const sender = { outgoingKey };

function payment(overrides: Partial<Parameters<typeof buildNativeTransfer>[0]> = {}, selfReceiveKey: Uint8Array | null = wallet.mlKemPublicKey) {
  const outputTree = new SparseMerkleTree(MERKLE_DEPTH);
  outputTree.setLeaf(0, fullOutputCommitment({ owner: wallet.address, noteSecret: 0x11n, assetId: 0n, amount: 1_000n }, 0));
  const rules = defaultEcdsaRuleSet({ wallet, secrets: TEST_DEFAULT_RULE_SECRETS });
  const accountTree = new SparseMerkleTree(MERKLE_DEPTH);
  accountTree.setLeaf(0, accountStateCommitment(
    wallet.address,
    nullifierKeyCommitment(wallet.nkRoot),
    rules.ruleSetCommitment,
    0n,
    1n,
    0n,
  ));
  return buildNativeTransfer({
    chainId,
    wallet,
    ...(selfReceiveKey === null ? {} : { selfReceiveKey }),
    recipientAddress: RECIPIENT,
    recipientReceiveKey: recipientKeys.publicKey,
    paymentAmount: 700n,
    openFeeAmount: 10n,
    issuanceOwnerCommitment: 0n,
    inputs: [{ amount: 1_000n, noteSecret: 0x11n, outputIndex: 0, siblings: outputTree.proof(0).siblings }],
    defaultRuleSecrets: TEST_DEFAULT_RULE_SECRETS,
    outputRoot: outputTree.root,
    accountStateRoot: accountTree.root,
    accountSiblings: accountTree.proof(0).siblings,
    accountRevision: 1n,
    receiveKeyHash: 0n,
    validUntilTimestamp: 9_999_999n,
    ...syntheticRecentBlockOpenings({
      outputRoot: outputTree.root,
      outputCount: 1,
      issuedSoFar: 0n,
      lagQ: 100n * 10n ** 18n * 2n ** 64n,
      accountStateRoot: accountTree.root,
      accountCount: 1,
    }),
    ...overrides,
  });
}

type Build = ReturnType<typeof payment>;

function senderRecords(build: Build, key: Uint8Array = outgoingKey) {
  return openSenderRecords({ ...sectionArena(build), outgoingKey: key });
}

describe("native payment memo and claimed sender", () => {
  it("delivers the memo and the spender's address in the recipient's region", () => {
    const build = payment({ data: memoData({recipientAddress: RECIPIENT, recipientReceiveKey: recipientKeys.publicKey, wallet}, memo, true) });
    expect(receiveOutput(build, recipientKeys.secretKey, 0).records).toEqual(orderedRecords([{ schema: RECORD_SCHEMA.memo, data: memo }, claimedSenderSchema.encode(wallet.address)]));
  });

  it("leaves the sender out unless asked", () => {
    expect(receiveOutput(payment({ data: memoData({recipientAddress: RECIPIENT, recipientReceiveKey: recipientKeys.publicKey, wallet}, memo, false) }), recipientKeys.secretKey, 0).records).toEqual(orderedRecords([{ schema: RECORD_SCHEMA.memo, data: memo }]));
  });

  it("delivers records without a recipient payment", () => {
    expect(() => payment({ paymentAmount: 0n,
data: memoData({recipientAddress: RECIPIENT, recipientReceiveKey: recipientKeys.publicKey, wallet}, undefined, true) })).not.toThrow();
    expect(() => payment({ paymentAmount: 0n,
data: memoData({recipientAddress: RECIPIENT, recipientReceiveKey: recipientKeys.publicKey, wallet}, memo, false) })).not.toThrow();
  });
});

describe("native payment change delivery", () => {
  it("encrypts change to the resolved key instead of the profile key", () => {
    const rotated = generateMlKemKeyPair();
    const build = payment({ selfReceiveKey: rotated.publicKey });
    expect(decodePayload(decryptEnvelope(rotated.secretKey, build.outputData[1]!)!, { chainId }).amount).toBe(290n);
    expect(decryptEnvelope(wallet.mlKemSecretKey, build.outputData[1]!)).toBeNull();
  });

  it("requires explicit self delivery material for change", () => {
    expect(() => payment({}, null)).toThrow(/no receive key/);
    expect(() => payment({ paymentAmount: 0n, openFeeAmount: 1_000n, sender }, null)).not.toThrow();
  });
});

describe("native payment sender region", () => {
  it("lists the paid envelope with the secret that reopens the note and its region", () => {
    const build = payment({ sender,
data: memoData({recipientAddress: RECIPIENT, recipientReceiveKey: recipientKeys.publicKey, wallet}, memo, true) });
    const records = senderRecords(build)!;
    expect(records.sentOpenings).toEqual([]);
    expect(records.sentEnvelopes.map(({ slot, recipientAddress }) => ({ slot, recipientAddress })))
      .toEqual([{ slot: 0, recipientAddress: RECIPIENT }]);
    const { sharedSecret } = records.sentEnvelopes[0]!;
    // The sender holds the same disclosure key the recipient's receive key recovers.
    expect(bytesEqual(sharedSecret, receiveOutput(build, recipientKeys.secretKey, 0).sharedSecret)).toBe(true);
    const reopened = discloseOutput({ ...sectionArena(build), sharedSecret, slot: 0, outputData: build.outputData })!;
    expect(reopened.note.amount).toBe(700n);
    expect(reopened.note.owner).toBe(RECIPIENT);
    expect(reopened.records).toEqual(orderedRecords([{ schema: RECORD_SCHEMA.memo, data: memo }, claimedSenderSchema.encode(wallet.address)]));
    expect(decodePayload(openEnvelope(sharedSecret, build.outputData[0]!)!, { chainId }).noteSecret).toBe(build.outputNoteSecrets[0]);
  });

  it("leaves change and the private relay fee out", () => {
    const relayer = 0x2222222222222222222222222222222222222222n;
    const build = payment({
      sender,
      privateRelayPayment: { address: relayer, amount: 5n, receiveKey: generateMlKemKeyPair().publicKey },
    });
    expect(senderRecords(build)!.sentEnvelopes.map(({ slot }) => slot)).toEqual([0]);
  });

  it("lists every recipient of a batch payment and not the change", () => {
    const second = 0x3333333333333333333333333333333333333333n;
    const third = 0x4444444444444444444444444444444444444444n;
    const keys = [generateMlKemKeyPair(), generateMlKemKeyPair()];
    const build = payment({
      sender,
      secondOutput: { address: second, amount: 50n, receiveKey: keys[0]!.publicKey },
      additionalOutputs: [{ address: third, amount: 40n, receiveKey: keys[1]!.publicKey }],
    });
    const records = senderRecords(build)!;
    expect(records.sentEnvelopes.map(({ slot, recipientAddress }) => [slot, recipientAddress]))
      .toEqual([[0, RECIPIENT], [1, second], [2, third]]);
    for (const { slot, sharedSecret } of records.sentEnvelopes) {
      expect(discloseOutput({ ...sectionArena(build), sharedSecret, slot, outputData: build.outputData })!.note.outputIndex).toBe(slot);
    }
    // Slot 3 is the owner's change.
    expect(decodePayload(decryptEnvelope(wallet.mlKemSecretKey, build.outputData[3]!)!, { chainId }).amount).toBe(200n);
  });

  it("records an output with explicit output data as a sent opening that matches its body commitment", () => {
    const build = payment({ sender, outputData: [sizeClassFiller()] });
    const records = senderRecords(build)!;
    expect(records.sentEnvelopes).toEqual([]);
    expect(records.sentOpenings).toEqual([{
      slot: 0, recipientAddress: RECIPIENT, assetId: 0n, amount: 700n, noteSecret: build.outputNoteSecrets[0],
    }]);
    const [opening] = records.sentOpenings;
    expect(noteBodyCommitment(
      ownerCommitment(opening!.recipientAddress, opening!.noteSecret),
      opening!.assetId,
      opening!.amount,
    )).toBe(build.transaction.outputs[0]!.outputBodyCommitment);
  });

  it("carries the wallet's own application records", () => {
    const applicationRecords = [{ schema: applicationSchemaId("com.example.record009"), data: new TextEncoder().encode("invoice 42") }];
    const build = payment({ sender: { outgoingKey, records: applicationRecords } });
    expect(applicationDataRecords(senderRecords(build)!.records ?? [])).toEqual(orderedRecords(applicationRecords));
  });

  it("is written even when the build pays no one", () => {
    const build = payment({ paymentAmount: 0n, sender });
    expect(senderRecords(build)).toEqual({ records: [], sentEnvelopes: [], sentOpenings: [] });
  });

  it("exists only with a sender, opens only with its outgoing key, and only in its own section", () => {
    expect(senderRecords(payment({ data: memoData({recipientAddress: RECIPIENT, recipientReceiveKey: recipientKeys.publicKey, wallet}, memo, false) }))).toBeNull();
    const build = payment({ sender });
    expect(senderRecords(build, new Uint8Array(32).fill(0x0f))).toBeNull();
    const nullifiers = sectionArena(build).context.nullifiers;
    const moved = { ...sectionArena(build), context: { ...sectionArena(build).context, nullifiers: [...nullifiers.slice(1), nullifiers[0]!] } };
    expect(openSenderRecords({ ...moved, outgoingKey })).toBeNull();
  });
});

describe("exact rebuilds", () => {
  it("rejects a supplied arena without the prior output data", () => {
    const prior = payment({ sender });
    expect(() => payment({ sender, arena: prior.arena })).toThrow(/a supplied arena requires the prior build's output data/);
  });

  it("rebuilds the same delivery from the prior arena and output data", () => {
    const prior = payment({ sender,
dummyInputEntropy: 42n,
data: memoData({recipientAddress: RECIPIENT, recipientReceiveKey: recipientKeys.publicKey, wallet}, memo, false) });
    const rebuilt = payment({ sender,
dummyInputEntropy: 42n,
arena: prior.arena,
outputData: prior.outputData,
outputNoteSecrets: prior.outputNoteSecrets,
data: undefined });
    expect(rebuilt.transaction.global.deliveryCommitment).toBe(prior.transaction.global.deliveryCommitment);
    expect(rebuilt.transaction.outputs).toEqual(prior.transaction.outputs);
    expect(bytesEqual(rebuilt.arena, prior.arena)).toBe(true);
    expect(senderRecords(rebuilt)!.sentEnvelopes.map(({ slot }) => slot)).toEqual([0]);
    expect(receiveOutput(rebuilt, recipientKeys.secretKey, 0).records).toEqual(orderedRecords([{ schema: RECORD_SCHEMA.memo, data: memo }]));
  });
});
