import type { DataRecord } from "../src/protocol/records.ts";
import { orderedRecords, recordValue } from "./recordHelpers.ts";
import { encodeRecords, decodeRecords, claimedSenderSchema, assetDefinitionSchema, RECORD_SCHEMA, sentEnvelopesSchema } from "@pcash/sdk/protocol";
import { memoData } from "./memoData.ts";
// Reference delivery of one private-value section through the builders:
// every recipient region carries its own copy of its records, a bad optional
// record never costs the recipient its note, memo capacity is exact, and every
// build that does not fit its arena fails before proving.

import { describe, expect, it } from "vitest";
import { buildAssetAction } from "../src/builders/assetAction.ts";
import {
  openedAssetActionOutput,
  outOfBandAssetActionOutput,
  type AssetActionInput,
  type AssetActionOutput,
} from "../src/builders/assetOutputs.ts";
import { buildNativeTransfer } from "../src/builders/nativeTransfer.ts";
import { ACCOUNT_KIND_USER, MERKLE_DEPTH } from "../src/constants/params.ts";
import { PCASH_CHAIN_ID } from "../src/constants/networkProfile.ts";
import { PRIVATE_VALUE_PROFILES } from "../src/constants/privateValueProfiles.ts";
import { SparseMerkleTree } from "../src/crypto/tree.ts";
import { accountRuleEntryCommitment, accountStateCommitment, buildAccountRuleSet } from "../src/protocol/account.ts";
import {
  ARENA_CELL_BYTES,
  ARENA_SALT_BYTES,
  arenaCells,
  decodeRecipientPayload,
  openRegion,
  openSenderRecords,
  regionCellsFor,
  type ArenaContext,
} from "../src/protocol/arena.ts";
import { assetDefinitionAssetId, type AssetDefinition } from "../src/protocol/assetDefinition.ts";
import { TX_KIND_PRIVATE_VALUE } from "../src/protocol/codec.ts";
import { decodePayload, encodePayload, generateMlKemKeyPair, sealEnvelope, trialOpenEnvelope } from "../src/protocol/envelope.ts";
import { DEFAULT_NETWORK_CONFIG } from "../src/protocol/network.ts";
import { fullOutputCommitment, noteBodyCommitment, nullifierKeyCommitment, ownerCommitment } from "../src/protocol/notes.ts";
import {
  discloseOutput,
  maxMemoBytes,
  outputRecords,
  paymentMaxMemoBytes,
  sealSectionDelivery,
  type ArenaSender,
} from "../src/protocol/sectionDelivery.ts";
import { ecdsaRuleConfigurationCommitment } from "../src/rules/referenceRules.ts";
import { beBytes } from "../src/utils/bytes.ts";
import { syntheticRecentBlockOpenings } from "@pcash/test-support/protocol-fixtures";
import { privateValueProfileFixture } from "./privateValueProfileFixtures.ts";
import { receiveOutput, sectionArena, type BuiltSection } from "./sectionReading.ts";
import { deriveTestWallet } from "./testWallet.ts";

const S = PRIVATE_VALUE_PROFILES.S.shapeId;
const L = PRIVATE_VALUE_PROFILES.L.shapeId;
const chainId = PCASH_CHAIN_ID;
const outgoingKey = new Uint8Array(32).fill(0x0e);
const sender: ArenaSender = { outgoingKey };

const definition: AssetDefinition = {
  initialSupply: 1_000_000n,
  assetSecretCommitment: 0x52n,
  metadata: { name: "Shared Token", symbol: "SHR", decimals: 6, contentDigest: new Uint8Array(32).fill(3) },
};
const assetId = assetDefinitionAssetId(definition);

/**
 * The plaintext after the directory of each region the section holds, read back with the keys
 * that open them: the record list and zero padding to the end of the region's cells.
 */
function senderPayload(build: BuiltSection): Uint8Array {
  return openRegion({ ...sectionArena(build), role: "sender", ikm: outgoingKey, anchor: arenaCells(build.shape) - 1 })!;
}

function recipientPayload(build: BuiltSection, sharedSecret: Uint8Array, anchor: number): Uint8Array {
  return openRegion({ ...sectionArena(build), role: "recipient", ikm: sharedSecret, anchor })!;
}

// --- a token payment from one asset note to four recipients ---
const tokenOwner = deriveTestWallet({ mlKem: "deterministic" });
const tokenRecipients = Array.from({ length: 4 }, (_, index) =>
  deriveTestWallet({ privKey: beBytes(BigInt(index + 11), 32), nkRoot: BigInt(index + 70), mlKem: "deterministic" }));

const tokenOutput = (slot: number, recipient: typeof tokenOwner, amount: bigint, change?: true) => openedAssetActionOutput({
  kind: "asset",
  pcashChainId: chainId,
  assetId,
  outputIndex: slot,
  amount,
  assetDefinition: definition,
  recipientAddress: recipient.address,
  recipientMlKemPublicKey: recipient.mlKemPublicKey!,
  authenticatedRecipient: true,
  ...(change === undefined ? {} : { change }),
});
const dummyOutput = (dummySecret: bigint): AssetActionOutput => ({ kind: "dummy", dummySecret, amount: 0n });

/** Spends one 100-token note; by default pays 25 to each of four recipients. */
function tokenPayment(options: { sender?: ArenaSender; outputs?: AssetActionOutput[]; assetDefinition?: AssetDefinition } = {}) {
  const configurationCommitment = ecdsaRuleConfigurationCommitment(DEFAULT_NETWORK_CONFIG, nullifierKeyCommitment(tokenOwner.nkRoot));
  const commitmentBlinder = 0x333n;
  const rules = buildAccountRuleSet([{
    entryIndex: 3,
    accountRuleEntryCommitment: accountRuleEntryCommitment(0x1234n, configurationCommitment, commitmentBlinder),
  }]);
  const outputTree = new SparseMerkleTree(MERKLE_DEPTH);
  outputTree.setLeaf(0, fullOutputCommitment({ owner: tokenOwner.address, noteSecret: 0x111n, assetId, amount: 100n }, 0));
  const accountTree = new SparseMerkleTree(MERKLE_DEPTH);
  accountTree.setLeaf(0, accountStateCommitment(
    tokenOwner.address, nullifierKeyCommitment(tokenOwner.nkRoot), rules.accountRuleSetCommitment, ACCOUNT_KIND_USER, 1n, 0n,
  ));
  const recent = syntheticRecentBlockOpenings({
    outputRoot: outputTree.root, outputCount: 1, issuedSoFar: 0n, lagQ: 100n * 10n ** 18n * 2n ** 64n,
    accountStateRoot: accountTree.root, accountCount: 1,
  });
  const inputs: AssetActionInput[] = [
    { kind: "asset", amount: 100n, noteSecret: 0x111n, leafIndex: 0, siblings: outputTree.proof(0).siblings },
    { kind: "dummy" }, { kind: "dummy" }, { kind: "dummy" },
  ];
  return buildAssetAction({
    pcashChainId: chainId,
    snapshot: {
      recentPcashBlockHash: recent.recentPcashBlockHash,
      stateRoot: recent.stateRoot,
      stateRootHeaderSiblings: recent.stateRootHeaderSiblings,
      outputRoot: outputTree.root,
      outputRootStateSiblings: recent.outputRootStateSiblings,
      accountStateRoot: accountTree.root,
      accountStateRootStateSiblings: recent.accountStateRootStateSiblings,
    },
    assetId,
    owner: {
      address: tokenOwner.address,
      nkRoot: tokenOwner.nkRoot,
      accountIndex: 0,
      accountSiblings: accountTree.proof(0).siblings,
      accountRuleSetCommitment: rules.accountRuleSetCommitment,
      accountKind: ACCOUNT_KIND_USER,
      accountRevision: 1n,
      receiveKeyHash: 0n,
      rule: { configurationCommitment, commitmentBlinder, entryIndex: 3, siblings: rules.membership(3).siblings },
    },
    inputs,
    outputs: options.outputs ?? [...tokenRecipients.map((recipient, slot) => tokenOutput(slot, recipient, 25n)), dummyOutput(0x315n)],
    openFeeAmount: 0n,
    issuanceOwnerCommitment: 0n,
    validUntilTimestamp: 999_999n,
    dummyInputSeed: 0x999n,
    ...(options.sender === undefined ? {} : { sender: options.sender }),
    ...(options.assetDefinition === undefined ? {} : { assetDefinition: options.assetDefinition }),
  });
}

describe("recipient records", () => {
  it("gives each of four token recipients its own copy of the asset definition", () => {
    const build = tokenPayment({ sender, assetDefinition: definition });
    const received = tokenRecipients.map((recipient, slot) => receiveOutput(build, recipient.mlKemSecretKey!, slot));
    for (const [slot, output] of received.entries()) {
      expect(output.note).toMatchObject({ assetId, amount: 25n, outputIndex: slot });
      expect(output.records).toEqual(orderedRecords([assetDefinitionSchema.encode(definition)]));
    }

    // Each recipient region, at its own anchor, holds the definition itself.
    const payloads = received.map(({ note, sharedSecret }) => recipientPayload(build, sharedSecret, note.anchor!));
    for (const payload of payloads) expect(decodeRecipientPayload(payload)).toEqual([assetDefinitionSchema.encode(definition)]);
    expect(new Set(received.map(({ note }) => note.anchor)).size).toBe(4);

    // The 100-byte definition record (102 bytes) takes three cells in each of the
    // four recipient regions. The sender region (definition plus four 53-byte
    // sent envelopes, 317 bytes) takes six. An opened region runs to the end of
    // its cells, so its length gives its cell count.
    const sent = senderPayload(build);
    expect([sent, ...payloads].map((payload) => encodeRecords(decodeRecords(payload, true)).length)).toEqual([317, 102, 102, 102, 102]);
    expect([sent, ...payloads].map((payload) => regionCellsFor(payload.length, S))).toEqual([6, 3, 3, 3, 3]);
  });

  it("names every token recipient and the asset in the sender region", () => {
    const build = tokenPayment({ sender, assetDefinition: definition });
    const records = openSenderRecords({ ...sectionArena(build), outgoingKey })!;
    expect(recordValue(records.records, assetDefinitionSchema)).toEqual(definition);
    expect(records.sentOpenings).toEqual([]);
    expect(records.sentEnvelopes.map(({ slot, recipientAddress }) => [slot, recipientAddress]))
      .toEqual(tokenRecipients.map((recipient, slot) => [slot, recipient.address]));
    // The definition the recipients receive is not copied into the sender region unless passed.
    expect(recordValue(openSenderRecords({ ...sectionArena(tokenPayment({ sender })), outgoingKey })!.records, assetDefinitionSchema)).toBeUndefined();
    expect(openSenderRecords({ ...sectionArena(tokenPayment()), outgoingKey })).toBeNull();
  });

  it("records an out-of-band token opening and leaves change out of the sender region", () => {
    const build = tokenPayment({
      sender,
      assetDefinition: definition,
      outputs: [
        tokenOutput(0, tokenRecipients[0]!, 25n),
        tokenOutput(1, tokenOwner, 25n, true),
        outOfBandAssetActionOutput({ kind: "asset", recipientAddress: tokenRecipients[1]!.address, noteSecret: 0x777n, amount: 50n }),
        dummyOutput(0x316n),
        dummyOutput(0x317n),
      ],
    });
    const records = openSenderRecords({ ...sectionArena(build), outgoingKey })!;
    expect(recordValue(records.records, assetDefinitionSchema)).toEqual(definition);
    expect(records.sentEnvelopes.map(({ slot, recipientAddress }) => [slot, recipientAddress])).toEqual([[0, tokenRecipients[0]!.address]]);
    expect(records.sentOpenings).toEqual([{ slot: 2, recipientAddress: tokenRecipients[1]!.address, assetId, amount: 50n, noteSecret: 0x777n }]);
    expect(noteBodyCommitment(ownerCommitment(tokenRecipients[1]!.address, 0x777n), assetId, 50n))
      .toBe(build.transaction.outputs[2]!.outputBodyCommitment);
    expect(receiveOutput(build, tokenOwner.mlKemSecretKey!, 1)).toMatchObject({ note: { amount: 25n }, records: [assetDefinitionSchema.encode(definition)] });
  });

  it("refuses a sender-region definition for another asset", () => {
    expect(() => tokenPayment({ sender, assetDefinition: { ...definition, assetSecretCommitment: 0x53n } }))
      .toThrow("assetDefinition must derive the action's nonzero assetId");
  });

  describe("native batch memos", () => {
    const { params, recipients } = privateValueProfileFixture({ shape: S, scenario: "distribution" });
    const withMemos = (memo: Uint8Array) => buildNativeTransfer({ ...params,
data: { recipients: [
  ...memoData(params, memo).recipients!,
  ...memoData({ ...params, recipientAddress: recipients[1]!.address, recipientReceiveKey: recipients[1]!.mlKemPublicKey! }, memo).recipients!,
] } });

    it.each([
      ["short", new TextEncoder().encode("lunch")],
      ["long", new Uint8Array(300).fill(0x6d)],
    ] as const)("writes a %s identical memo into each recipient's own region", (_label, memo) => {
      const build = withMemos(memo);
      const anchors = [0, 1].map((slot) => {
        const output = receiveOutput(build, recipients[slot]!.mlKemSecretKey!, slot);
        expect(output.records).toEqual(orderedRecords([{ schema: RECORD_SCHEMA.memo, data: memo }]));
        expect(decodeRecipientPayload(recipientPayload(build, output.sharedSecret, output.note.anchor!)))
          .toEqual([{ schema: RECORD_SCHEMA.memo, data: memo }]);
        return output.note.anchor;
      });
      expect(anchors[1]).not.toBe(anchors[0]);
      expect(receiveOutput(build, recipients[2]!.mlKemSecretKey!, 2).records).toBeNull();
    });
  });
});

describe("optional records never cost the note", () => {
  const { params, recipients } = privateValueProfileFixture({ shape: S, scenario: "minimal" });
  const recipient = recipients[0]!;
  const memo = new TextEncoder().encode("rent");

  function withArena(build: BuiltSection, arena: Uint8Array): BuiltSection {
    return { ...build, arena };
  }

  it("recovers the note when its anchor cell is corrupted", () => {
    const build = buildNativeTransfer({ ...params,
data: memoData(params, memo, false) });
    const { note, sharedSecret } = receiveOutput(build, recipient.mlKemSecretKey!, 0);
    const arena = Uint8Array.from(build.arena);
    arena[ARENA_SALT_BYTES + ARENA_CELL_BYTES * note.anchor! + 5]! ^= 1;
    const disclosed = discloseOutput({ ...sectionArena(withArena(build, arena)), sharedSecret, slot: 0, outputData: build.outputData })!;
    expect(disclosed.note).toEqual(note);
    expect(disclosed.records).toBeNull();
  });

  it("recovers the note when a continuation cell is corrupted", () => {
    const build = buildNativeTransfer({ ...params,
data: memoData(params, new Uint8Array(400).fill(0x72), false) });
    const { note, sharedSecret } = receiveOutput(build, recipient.mlKemSecretKey!, 0);
    const arena = Uint8Array.from(build.arena);
    for (let cell = 0; cell < 40; cell++) if (cell !== note.anchor) arena[ARENA_SALT_BYTES + ARENA_CELL_BYTES * cell]! ^= 1;
    const disclosed = discloseOutput({ ...sectionArena(withArena(build, arena)), sharedSecret, slot: 0, outputData: build.outputData })!;
    expect(disclosed.note).toEqual(note);
    expect(disclosed.records).toBeNull();
  });

  it.each([
    ["outside the arena", () => 200],
    ["at a cell of no region of this recipient", (anchor: number) => (anchor + 1) % 40],
  ] as [string, (anchor: number) => number][])("recovers the note when the envelope names an anchor %s", (_label, moveAnchor) => {
    const build = buildNativeTransfer({ ...params,
data: memoData(params, memo, false) });
    const { note } = receiveOutput(build, recipient.mlKemSecretKey!, 0);
    const sealed = sealEnvelope(recipient.mlKemPublicKey!, encodePayload({ ...note, anchor: moveAnchor(note.anchor!) }));
    const outputData = [sealed.envelope, ...build.outputData.slice(1)];
    const disclosed = discloseOutput({ ...sectionArena(build), sharedSecret: sealed.sharedSecret, slot: 0, outputData })!;
    expect(disclosed.note).toEqual({ ...note, anchor: moveAnchor(note.anchor!) });
    expect(disclosed.records).toBeNull();
  });

  describe("asset definitions", () => {
    const otherDefinition: AssetDefinition = { ...definition, assetSecretCommitment: 0x53n };
    const receiver = generateMlKemKeyPair();
    const context: ArenaContext = { chainId, transactionType: TX_KIND_PRIVATE_VALUE, nullifiers: [1n, 2n, 3n, 4n] };

    function delivered(noteAssetId: bigint, records: readonly DataRecord[]) {
      const delivery = sealSectionDelivery({
        shape: S,
        context,
        envelopes: [{
          slot: 0,
          receiveKey: receiver.publicKey,
          note: { chainId, assetId: noteAssetId, amount: 5n, owner: 9n, noteSecret: 10n },
          records,
        }],
      });
      const opened = trialOpenEnvelope(receiver.secretKey, delivery.envelopes.get(0)!)!;
      const note = decodePayload(opened.plaintext, { chainId });
      return { note, records: outputRecords(note, opened.sharedSecret, { arena: delivery.arena, shape: S, context }) };
    }

    it("keeps a definition that derives the note's asset", () => {
      expect(delivered(assetId, [assetDefinitionSchema.encode(definition), { schema: RECORD_SCHEMA.memo, data: memo }]).records).toEqual(orderedRecords([assetDefinitionSchema.encode(definition), { schema: RECORD_SCHEMA.memo, data: memo }]));
    });

    it.each([
      ["another asset's definition on an asset note", assetId, otherDefinition],
      ["a definition on a native note", 0n, definition],
    ] as [string, bigint, AssetDefinition][])("drops %s and keeps the note and its other records", (_label, noteAssetId, assetDefinition) => {
      const { note, records } = delivered(noteAssetId, [assetDefinitionSchema.encode(assetDefinition), { schema: RECORD_SCHEMA.memo, data: memo }]);
      expect(note).toMatchObject({ assetId: noteAssetId, amount: 5n });
      expect(records).toEqual(orderedRecords([{ schema: RECORD_SCHEMA.memo, data: memo }]));
    });
  });

  it("returns null for a secret, slot, or output list that is not this output's", () => {
    const build = buildNativeTransfer({ ...params,
data: memoData(params, memo, false) });
    const { sharedSecret } = receiveOutput(build, recipient.mlKemSecretKey!, 0);
    const source = { ...sectionArena(build), outputData: build.outputData };
    expect(discloseOutput({ ...source, sharedSecret, slot: 0 })).not.toBeNull();
    expect(discloseOutput({ ...source, sharedSecret: new Uint8Array(32), slot: 0 })).toBeNull();
    expect(discloseOutput({ ...source, sharedSecret, slot: 1 })).toBeNull();
    expect(discloseOutput({ ...source, sharedSecret, slot: 5 })).toBeNull();
    expect(discloseOutput({ ...source, sharedSecret, slot: 0, outputData: build.outputData.slice(0, 4) })).toBeNull();
  });
});

describe("memo capacity", () => {
  // Free cells after a two-cell sender region (one 53-byte sent envelope):
  // S 38, L 254. A k-cell region (k ≥ 2) carries 65k − 33 − min(k − 1, B) bytes, less
  // the memo header (type and a uvarint length: 3 bytes below 16384, 4 from
  // there) and, with the claimed sender, its 22-byte record.
  it.each([
    [S, false, 2429], [S, true, 2407],
    [L, false, 16441], [L, true, 16419],
  ] as const)("shape %s with sender %s carries exactly %s memo bytes", (shape, includeSender, limit) => {
    expect(paymentMaxMemoBytes({ shape, includeSender })).toBe(limit);
    const { params, recipients } = privateValueProfileFixture({ shape, scenario: "minimal" });
    const payment = (bytes: number) => buildNativeTransfer({ ...params,
sender,
data: memoData(params, new Uint8Array(bytes).fill(0x61), includeSender) });
    const build = payment(limit);
    expect(receiveOutput(build, recipients[0]!.mlKemSecretKey!, 0).records!?.find(record => record.schema === RECORD_SCHEMA.memo)?.data).toHaveLength(limit);
    const cells = shape === S ? 40 : 256;
    expect(() => payment(limit + 1)).toThrow(`arena regions need ${cells + 1} cells; the ${shape === S ? "S" : "L"} arena has ${cells}`);
  });

  it("accounts for the section's other regions", () => {
    const { params, recipients, wallet } = privateValueProfileFixture({ shape: S, scenario: "distribution" });
    const otherMemo = new Uint8Array(200).fill(0x62);
    // Four sent envelopes (215 bytes) and a 203-byte memo region take four
    // cells each, leaving 32: 65·32 − 33 − 5 − 22 − 3 = 2017.
    const limit = maxMemoBytes({
      shape: S,
      records: [claimedSenderSchema.encode(wallet.address)],
      regions: [(encodeRecords([{ schema: RECORD_SCHEMA.memo, data: otherMemo }]).length)],
      sender: [sentEnvelopesSchema.encode([0, 1, 2, 3].map((slot) => ({ slot, sharedSecret: new Uint8Array(32), recipientAddress: 1n })))],
    });
    expect(limit).toBe(2017);
    const payment = (bytes: number) => buildNativeTransfer({ ...params,
sender,
data: { recipients: [
  ...memoData(params, new Uint8Array(bytes).fill(0x61), true).recipients!,
  ...memoData({ ...params, recipientAddress: recipients[1]!.address, recipientReceiveKey: recipients[1]!.mlKemPublicKey! }, otherMemo).recipients!,
] } });
    const build = payment(limit);
    expect(receiveOutput(build, recipients[0]!.mlKemSecretKey!, 0).records!?.find(record => record.schema === RECORD_SCHEMA.memo)?.data).toHaveLength(limit);
    expect(receiveOutput(build, recipients[1]!.mlKemSecretKey!, 1).records).toEqual(orderedRecords([{ schema: RECORD_SCHEMA.memo, data: otherMemo }]));
    expect(() => payment(limit + 1)).toThrow("arena regions need 41 cells; the S arena has 40");
  });

  it("refuses an L batch whose distinct memos overflow the arena, before proving", () => {
    const { params, recipients } = privateValueProfileFixture({ shape: L, scenario: "distribution" });
    // Each 603-byte memo region needs ten cells: 31 regions exceed 256 cells.
    const memo = (index: number) => new Uint8Array(600).fill(index + 1);
    expect(() => buildNativeTransfer({ ...params,
data: { recipients: recipients.flatMap((recipient, index) => memoData({ ...params, recipientAddress: recipient.address, recipientReceiveKey: recipient.mlKemPublicKey! }, memo(index)).recipients!) } })).toThrow(/arena regions need \d+ cells; the L arena has 256/);
  });
});

describe("full payments with a sender region", () => {
  it.each([
    ["S", S, 4],
    ["L", L, 31],
  ] as const)("%s lists every recipient slot and leaves out the change", (_name, shape, paid) => {
    const { params, recipients, wallet } = privateValueProfileFixture({ shape, scenario: "distribution" });
    expect(recipients).toHaveLength(paid);
    const build = buildNativeTransfer({ ...params, sender });
    const records = openSenderRecords({ ...sectionArena(build), outgoingKey })!;
    expect(records.sentOpenings).toEqual([]);
    expect(records.sentEnvelopes.map(({ slot, recipientAddress }) => [slot, recipientAddress]))
      .toEqual(recipients.map((recipient, slot) => [slot, recipient.address]));
    for (const { slot, sharedSecret } of records.sentEnvelopes) {
      const disclosed = discloseOutput({ ...sectionArena(build), sharedSecret, slot, outputData: build.outputData })!;
      expect(disclosed.note).toMatchObject({ amount: 100n, owner: recipients[slot]!.address, outputIndex: slot });
    }
    // The change in the last slot returns to the wallet and is not recorded as paid.
    const change = receiveOutput(build, wallet.mlKemSecretKey!, paid);
    expect(change.note.amount).toBe(100_000n - 100n * BigInt(paid) - 1n);
    expect(paid).toBe(PRIVATE_VALUE_PROFILES[shape === S ? "S" : "L"].outputs - 1);
  });
});
