import { recoverLineageOutput, restoreLineageFromNode } from "../src/recovery.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { handoffSchema, verifyHandoff, LineageStore } from "../src/handoff.ts";
import { buildPolicy, claimEvent } from "../src/policy.ts";
import {
  deliveryCommitment,
  randomArena,
  sealSectionDelivery,
  sizeClassFiller,
  TX_KIND_PRIVATE_VALUE,
  decodePayload,
  generateMlKemKeyPair,
  openEnvelope,
  outputRecords,
  trialOpenEnvelope,
  type DataRecord,
  readRecord,
  decodeRecipientPayload,
  openRegion,
  eventsCommitment,
  noteBodyCommitment,
  ownerCommitment,
  outputCommitment,
  blockHash,
  blockHeaderTree,
  stateRoot,
  transactionResultsRoot,
  transactionResultLeaf,
  transactionStatementHash,
} from "@pcash/sdk/protocol";
import { DenseMerkleTree, emptyRoot, fieldToHex } from "@pcash/sdk/crypto";
import { PRIVATE_VALUE_PROFILES } from "@pcash/sdk/constants";
import { type PcashNodeClient, type ResultProofRpc } from "@pcash/sdk/clients";

const NULLIFIERS = Array.from({ length: PRIVATE_VALUE_PROFILES.S.inputs }, (_, index) => BigInt(0x100 + index));
const CONTEXT = { chainId: 1n, transactionType: TX_KIND_PRIVATE_VALUE, nullifiers: NULLIFIERS } as const;

/** An S section delivering the note at slot 0 with `records` in its recipient region. */
function deliver(publicKey: Uint8Array, records: readonly DataRecord[]) {
  const profile = PRIVATE_VALUE_PROFILES.S;
  const delivery = sealSectionDelivery({
    shape: profile.shapeId,
    context: CONTEXT,
    envelopes: [{ slot: 0, receiveKey: publicKey, note: { chainId: 1n, assetId: 0n, amount: 10n, owner: 8n, noteSecret: 9n }, records }],
  });
  const outputData = [delivery.envelopes.get(0)!, ...Array.from({ length: profile.outputs - 1 }, () => sizeClassFiller())];
  return { envelope: outputData[0]!, outputData, arena: delivery.arena };
}

function fixture(deny = false, applicationDataOverride?: Uint8Array) {
  const profile = PRIVATE_VALUE_PROFILES.S;
  const words = Array<bigint>(profile.publicInputs).fill(0n);
  words[0] = 1n;
  NULLIFIERS.forEach((value, index) => { words[profile.offsets.nullifiers + index] = value; });
  for (let slot = 0; slot < profile.outputs; slot++) words[profile.offsets.outputs + slot] = BigInt(11 + slot);
  words[profile.offsets.outputs] = noteBodyCommitment(ownerCommitment(8n, 9n), 0n, 10n);
  const outputTree = new DenseMerkleTree(40, words.slice(profile.offsets.outputs, profile.offsets.outputs + profile.outputs).map((body, index) => outputCommitment(body, BigInt(index))));
  const noteCommitment = outputTree.get(0);
  const policy = buildPolicy(9n, [999n], deny ? [noteCommitment] : []);
  const trustedVk = 321n;
  const handoff = { salt: 77n, qualificationMask: 3, outputSlot: 0 };
  const pair = generateMlKemKeyPair();
  const { envelope, outputData, arena } = deliver(pair.publicKey, [applicationDataOverride === undefined ? handoffSchema.encode(handoff) : { schema: handoffSchema.id, data: applicationDataOverride }]);
  words[profile.offsets.deliveryCommitment] = deliveryCommitment(outputData, arena);
  words[profile.offsets.eventsCommitment] = eventsCommitment(handoff.salt, { applicationVkHash: trustedVk, event: claimEvent({ root: policy.root, applicationVkHash: trustedVk, qualificationMask: handoff.qualificationMask }) });
  const result = { txType: 0, accountCreation: 0, l1TransactionIndex: 1n, batchItemIndex: 0n, outcome: "succeeded" as const, posterOwnerCommitment: 33n, outputStartIndex: 0n, statementHash: transactionStatementHash(words) };
  const results = new DenseMerkleTree(64, [transactionResultLeaf(result)]);
  const state = { outputRoot: outputTree.root(), outputCount: 5n, issuedSoFar: 0n, lagQ: 0n, accountStateRoot: emptyRoot(40), accountCount: 0n, nullifierRoot: emptyRoot(40), nullifierCount: 0n };
  const header = { parentHash: 0n, number: 0n, timestamp: 1n, transactionResultsRoot: transactionResultsRoot([result], []), stateRoot: stateRoot(state), l1OriginRoot: emptyRoot(40), historyRoot: emptyRoot(40) };
  const recentHash = blockHash(header);
  const boundary: ResultProofRpc["recentBoundary"] = {
    state: { outputRoot: fieldToHex(state.outputRoot), outputCount: "0x5", issuedSoFar: "0x0", lagQ: "0", accountStateRoot: fieldToHex(state.accountStateRoot), accountCount: "0x0", nullifierRoot: fieldToHex(state.nullifierRoot), nullifierCount: "0x0" },
    header: { parentHash: fieldToHex(0n), number: "0x0", timestamp: "0x1", transactionResultsRoot: fieldToHex(header.transactionResultsRoot), stateRoot: fieldToHex(header.stateRoot), l1OriginRoot: fieldToHex(header.l1OriginRoot), historyRoot: fieldToHex(header.historyRoot) },
    blockHash: fieldToHex(recentHash),
  };
  const proof: ResultProofRpc = { recentPcashBlockHash: fieldToHex(recentHash), block: { recentPcashBlockHash: fieldToHex(recentHash), boundary }, history: null, resultsRootSiblings: blockHeaderTree(header).proof(3).siblings.map(fieldToHex), transactionCount: "0x1", payoutCount: "0x0", resultsTreeRoot: fieldToHex(results.root()), leafIndex: "0x0", siblings: results.path(0).map(fieldToHex), recentBoundary: boundary, leaf: { kind: "transaction", txType: 0, accountCreation: 0, l1TransactionIndex: "0x1", batchItemIndex: "0x0", outcome: 0, posterOwnerCommitment: fieldToHex(result.posterOwnerCommitment), outputStartIndex: "0x0", statementHash: fieldToHex(result.statementHash), statement: { words: words.map(fieldToHex), accountUpdateOpening: null } } };
  const params = { handoff, outputSlot: handoff.outputSlot, proof, recentHash, blockNumber: 0n, position: { pcashTransactionIndex: 0n }, noteCommitment, policy, trustedVk };
  return { handoff, params, pair, envelope, outputData, arena, words };
}

test("receiver verifies an event before retaining provenance", () => {
  const { handoff, params } = fixture();
  const verified = verifyHandoff(params);
  assert.deepEqual(verified, handoff);
  const store = new LineageStore(); store.record(params.noteCommitment, verified);
  assert.deepEqual(LineageStore.restore(store.export()).get(params.noteCommitment), verified);
});

test("receiver rejects forged salt and qualification mask even with authentic result proof", () => {
  const { handoff, params } = fixture();
  for (const forged of [{ ...handoff, salt: 78n }, { ...handoff, qualificationMask: 7 }]) {
    assert.throws(() => verifyHandoff({ ...params, handoff: forged }), /forged event/);
  }
});

test("receiver rejects stale policy and a substituted application identity", () => {
  const { params } = fixture();
  assert.throws(() => verifyHandoff({ ...params, policy: buildPolicy(9n, [998n], []) }), /forged event/);
  assert.throws(() => verifyHandoff({ ...params, trustedVk: 322n }), /forged event/);
});

test("receiver rejects qualified wrong slot, unqualified slot, and wrong note commitment", () => {
  const { params } = fixture();
  assert.throws(() => verifyHandoff({ ...params, outputSlot: 1 }), /another output/);
  assert.throws(() => verifyHandoff({ ...params, outputSlot: 2 }), /unqualified/);
  assert.throws(() => verifyHandoff({ ...params, noteCommitment: params.noteCommitment + 1n }), /another output/);
});

test("receiver rejects an authenticated event whose output is denied by the selected policy", () => {
  const { params } = fixture(true);
  assert.throws(() => verifyHandoff(params), /denied/);
});

test("receiver rejects forged statement words and result proofs anchored to another header", () => {
  const { params } = fixture();
  assert.throws(() => verifyHandoff({ ...params, recentHash: params.recentHash + 1n }), /recent block/);
  const proof = structuredClone(params.proof);
  if (proof.leaf.kind !== "transaction") throw new Error("fixture");
  proof.leaf.statement!.words[PRIVATE_VALUE_PROFILES.S.offsets.outputs] = fieldToHex(101n);
  assert.throws(() => verifyHandoff({ ...params, proof }), /statement hash/);
});

test("encrypted lineage handoff travels in the recipient's arena region and verifies after recipient decryption", () => {
  const { params, handoff } = fixture();
  const pair = generateMlKemKeyPair();
  const { envelope, arena } = deliver(pair.publicKey, [handoffSchema.encode(handoff)]);
  const opened = trialOpenEnvelope(pair.secretKey, envelope)!;
  const note = decodePayload(opened.plaintext, { chainId: 1n });
  const records = outputRecords(note, opened.sharedSecret, { arena, shape: PRIVATE_VALUE_PROFILES.S.shapeId, context: CONTEXT });
  assert.deepEqual(verifyHandoff({ ...params, handoff: readRecord(records, handoffSchema)!, outputSlot: note.outputIndex }), handoff);
});

test("every qualified output carries the same opening in its own region", () => {
  const S = PRIVATE_VALUE_PROFILES.S.shapeId;
  const record = handoffSchema.encode({ salt: 77n, qualificationMask: 3 });
  const pairs = [generateMlKemKeyPair(), generateMlKemKeyPair()];
  const delivery = sealSectionDelivery({
    shape: S, context: CONTEXT,
    envelopes: pairs.map((pair, slot) => ({ slot, receiveKey: pair.publicKey, note: { chainId: 1n, assetId: 0n, amount: 10n, owner: 8n, noteSecret: 9n }, records: [record] })),
  });
  const anchors = pairs.map((pair, slot) => {
    const opened = trialOpenEnvelope(pair.secretKey, delivery.envelopes.get(slot)!)!;
    const note = decodePayload(opened.plaintext, { chainId: 1n });
    const region = openRegion({ arena: delivery.arena, shape: S, context: CONTEXT, role: "recipient", ikm: opened.sharedSecret, anchor: note.anchor! })!;
    assert.deepEqual(decodeRecipientPayload(region), [record]);
    return note.anchor;
  });
  assert.notEqual(anchors[0], anchors[1]);
});

test("wallet adapter restores verified application data and leaves bad data unqualified", async () => {
  const { handoff, params, pair, envelope, outputData, arena } = fixture();
  const store = new LineageStore();
  const candidate = { blockNumber: 0n, position: params.position, outputIndex: 0n, outputSlot: 0, commitment: params.noteCommitment, outputData, arena, nullifiers: NULLIFIERS };
  const args = { node: { getResultProof: async () => params.proof }, chainId: 1n, recentHash: params.recentHash, policy: params.policy, trustedVk: params.trustedVk, store, mlKemSecretKeys: [pair.secretKey], owners: [8n], candidate };
  assert.deepEqual(await recoverLineageOutput(args), handoff);
  assert.deepEqual(store.get(params.noteCommitment), handoff);
  const missingStore = new LineageStore();
  assert.equal(await recoverLineageOutput({ ...args, store: missingStore, node: { getResultProof: async () => null } }), undefined);
  assert.equal(missingStore.get(params.noteCommitment), undefined);
  const bad = fixture(false, Uint8Array.of(255));
  const badStore = new LineageStore();
  assert.equal(await recoverLineageOutput({ ...args, store: badStore, node: { getResultProof: async () => bad.params.proof }, recentHash: bad.params.recentHash, mlKemSecretKeys: [bad.pair.secretKey], candidate: { ...candidate, outputData: bad.outputData, arena: bad.arena } }), undefined);
  assert.equal(badStore.get(params.noteCommitment), undefined);
  // Another delivery of the same note and handoff opens, but the proved statement commits to neither its envelope nor its arena.
  const redelivered = deliver(pair.publicKey, [handoffSchema.encode(handoff)]);
  assert.ok(openEnvelope(trialOpenEnvelope(pair.secretKey, redelivered.envelope)!.sharedSecret, redelivered.envelope));
  assert.equal(await recoverLineageOutput({ ...args, store: new LineageStore(), candidate: { ...candidate, outputData: [redelivered.envelope, ...outputData.slice(1)], arena: redelivered.arena } }), undefined);
  assert.equal(await recoverLineageOutput({ ...args, store: new LineageStore(), candidate: { ...candidate, arena: randomArena(PRIVATE_VALUE_PROFILES.S.shapeId) } }), undefined);
  // The region's keys bind the section's nullifiers: other nullifiers leave the note without its handoff.
  assert.equal(await recoverLineageOutput({ ...args, store: new LineageStore(), candidate: { ...candidate, nullifiers: NULLIFIERS.map((value) => value + 1n) } }), undefined);
});

test("fresh application store reconstructs from receive keys and node output bytes", async () => {
  const { handoff, params, pair, outputData, arena, words } = fixture();
  const profile = PRIVATE_VALUE_PROFILES.S;
  const target = { pcashNumber: 0n, pcashHash: `0x${params.recentHash.toString(16)}` };
  // One whole transaction: its slot-0 row carries the arena and the nullifiers.
  const outputs = outputData.map((item, slot) => ({
    kind: "ordinary", outputIndex: BigInt(slot), outputCommitment: outputCommitment(words[profile.offsets.outputs + slot]!, BigInt(slot)).toString(),
    origin: { ...target, timestamp: 1n }, outputData: item, transactionId: "tx", contentHash: "0x01", transactionType: 0, privateValueShape: 0, outputSlot: slot,
    nullifiers: slot === 0 ? NULLIFIERS.map(fieldToHex) : [], arena: slot === 0 ? arena : null,
  }));
  const node = {
    getResultProof: async () => params.proof,
    getOutputs: async () => ({ fromOutputIndex: 0n, target: { ...target, outputCount: BigInt(profile.outputs) }, outputs, continuation: null, complete: true }),
    getTransaction: async () => ({ summary: { pcashTransactionIndex: 0n } }),
  } as unknown as Pick<PcashNodeClient, "getResultProof" | "getOutputs" | "getTransaction">;
  const restored = await restoreLineageFromNode({ node, target, chainId: 1n, wallet: { address: 8n, nkRoot: 3n, mlKemSecretKey: pair.secretKey }, policy: params.policy, trustedVk: params.trustedVk });
  assert.equal(restored.scanned, profile.outputs);
  assert.equal(restored.qualified, 1);
  assert.deepEqual(restored.store.get(params.noteCommitment), handoff);
});
