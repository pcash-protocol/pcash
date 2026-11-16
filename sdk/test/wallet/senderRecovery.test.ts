import { applicationSchemaId } from "../../src/protocol/records.ts";
import { orderedRecords } from "../recordHelpers.ts";
import { memoData } from "../memoData.ts";
// What a wallet sent is recoverable from its recovery root alone: the outgoing
// key opens the sender region of every transaction it built, wherever the
// transaction sits in the output feed, and every reopened output must open the
// streamed commitment.

import { describe, expect, it } from "vitest";
import { buildNativeTransfer } from "@pcash/sdk/builders";
import { PRIVATE_VALUE_PROFILES } from "@pcash/sdk/constants";
import { RECORD_SCHEMA, DEFAULT_NETWORK_CONFIG, generateMlKemKeyPair, WIRE_PROOF_BYTES } from "@pcash/sdk/protocol";
import { fieldToHex } from "@pcash/sdk/crypto";
import { addressHex, toHex, utf8 } from "@pcash/sdk/utils";
import type { OutputResult, PcashNodeClient } from "@pcash/sdk/clients";
import { deriveSeedWalletIdentity, generateWalletMnemonic } from "../../src/wallet/seedIdentity.ts";
import { recoverSentTransaction, synchronizeWalletInventory, type ScanTransaction } from "../../src/wallet/actions/scan.ts";
import { syncWallet } from "../../src/wallet/actions/syncWallet.ts";
import { memoryWalletStateStore } from "../../src/wallet/memoryStoreBackend.ts";
import { emptyWalletState } from "../../src/wallet/store.ts";
import { ChainSim } from "./chainFixture.ts";
import { withSyntheticTransferOpenings } from "./builderTestHelpers.ts";

const network = DEFAULT_NETWORK_CONFIG;
const chainId = BigInt(network.pcashChainId);
const simNetwork = { l1ChainId: BigInt(network.l1ChainId), inboxAddress: addressHex(network.inboxAddress) };

function payee(index: number) {
  const keys = generateMlKemKeyPair();
  const address = BigInt(`0x${(index + 1).toString(16).padStart(4, "0")}${"ab".repeat(18)}`);
  return { address, keys };
}

/**
 * A full payment from a seed wallet: every slot but the last pays a payee with
 * a memo, and change fills the last slot. The change goes to a throwaway key,
 * so nothing the payer can decrypt as a recipient comes from this transaction.
 */
function fullPayment(shape: 0 | 1, mnemonic: string) {
  const { profile } = deriveSeedWalletIdentity(mnemonic, network);
  const profileOutputs = shape === 0 ? PRIVATE_VALUE_PROFILES.S.outputs : PRIVATE_VALUE_PROFILES.L.outputs;
  const payees = Array.from({ length: profileOutputs - 1 }, (_, index) => payee(index));
  const outputs = payees.map((recipient, index) => ({
    address: recipient.address, amount: BigInt(10 + index),
    receiveKey: recipient.keys.publicKey, memo: utf8(`pay ${index}`),
  }));
  const paid = outputs.reduce((sum, output) => sum + output.amount, 0n);
  const [first, ...rest] = outputs;
  const build = buildNativeTransfer(withSyntheticTransferOpenings({
    shape, chainId, network, wallet: profile, defaultRuleSecrets: profile.defaultUserRuleSecrets,
    selfReceiveKey: generateMlKemKeyPair().publicKey,
    sender: { outgoingKey: profile.outgoingKey },
    recipientAddress: first!.address, recipientReceiveKey: first!.receiveKey,
    data: { recipients: outputs.flatMap(output => memoData({ recipientAddress: output.address, recipientReceiveKey: output.receiveKey, wallet: profile }, output.memo).recipients!) },
    paymentAmount: first!.amount,
    additionalOutputs: rest.map(({ memo: _memo, ...output }) => output),
    inputAmount: paid + 1_000n, noteSecret: 0x5eedn, openFeeAmount: 1n, issuanceOwnerCommitment: 0n,
    validUntilTimestamp: 9_999_999_999n,
  }));
  return { profile, payees, outputs, build, entry: build.encodeTransaction(new Uint8Array(WIRE_PROOF_BYTES)) };
}

function restoredInventory(sim: ChainSim, address: bigint) {
  return emptyWalletState({ address, network: { chainId, genesisHash: sim.genesisHash } });
}

const target = (sim: ChainSim) => ({ pcashNumber: sim.head.number, pcashHash: fieldToHex(sim.head.hash).toLowerCase() });

function scanTransaction(rows: readonly OutputResult[]): ScanTransaction {
  const ordinary = rows.filter((row): row is Extract<OutputResult, { kind: "ordinary" }> => row.kind === "ordinary");
  const first = ordinary[0]!;
  return {
    transactionType: first.transactionType,
    shape: first.privateValueShape,
    arena: { arena: first.arena!, nullifiers: first.nullifiers },
    outputs: ordinary.map((row) => ({ slot: row.outputSlot, leafIndex: row.outputIndex, outputCommitment: BigInt(row.outputCommitment), outputData: row.outputData })),
  };
}

describe("sender recovery from the recovery root alone", () => {
  it.each([
    ["S", 0 as const],
    ["L", 1 as const],
  ])("restores every output of a full %s payment into a fresh wallet with no local state", async (_name, shape) => {
    const mnemonic = generateWalletMnemonic();
    const payment = fullPayment(shape, mnemonic);
    const sim = new ChainSim(chainId, simNetwork);
    sim.addBlock({ transactions: [{ outputs: [null, null, null, null, null] }] });
    sim.include(payment.entry);

    // A new device: the same phrase, an empty vault.
    const { profile } = deriveSeedWalletIdentity(mnemonic, network);
    const data = restoredInventory(sim, profile.address);
    await synchronizeWalletInventory(sim.client(), profile, chainId, data, { store: memoryWalletStateStore(data), target: target(sim) });

    expect(data.notes).toEqual([]);
    expect(data.sentOutputs).toHaveLength(payment.outputs.length);
    expect(data.sentOutputs!.map((output) => ({
      slot: output.slot, recipientAddress: output.recipientAddress, amount: output.amount, memo: output.memo, leafIndex: output.leafIndex,
    }))).toEqual(payment.outputs.map((output, slot) => ({
      slot, recipientAddress: addressHex(output.address), amount: output.amount.toString(), memo: toHex(output.memo), leafIndex: String(5 + slot),
    })));
    expect(new Set(data.sentOutputs!.map((output) => output.contentHash)).size).toBe(1);
  });

  it("reopens a transaction with only the outgoing key and nothing else", () => {
    const mnemonic = generateWalletMnemonic();
    const payment = fullPayment(0, mnemonic);
    const sim = new ChainSim(chainId, simNetwork);
    const block = sim.include(payment.entry);
    const { profile } = deriveSeedWalletIdentity(mnemonic, network);

    const sent = recoverSentTransaction({ chainId, outgoingKey: profile.outgoingKey, transaction: scanTransaction(block.outputs) })!;
    expect(sent.outputs.map(({ slot, recipientAddress, amount, records }) => ({ slot, recipientAddress, amount, memo: records?.find(record => record.schema === RECORD_SCHEMA.memo)?.data })))
      .toEqual(payment.outputs.map((output, slot) => ({ slot, recipientAddress: output.address, amount: output.amount, memo: output.memo })));
    expect(sent.applicationRecords).toEqual(orderedRecords([]));
    // Another wallet's key opens nothing, and neither does a different context.
    const other = deriveSeedWalletIdentity(generateWalletMnemonic(), network).profile;
    expect(recoverSentTransaction({ chainId, outgoingKey: other.outgoingKey, transaction: scanTransaction(block.outputs) })).toBeNull();
    expect(recoverSentTransaction({ chainId: chainId + 1n, outgoingKey: profile.outgoingKey, transaction: scanTransaction(block.outputs) })).toBeNull();
  });

  it("reads each transaction's arena once across pages and a reorganization, with no per-transaction fetch", async () => {
    const mnemonic = generateWalletMnemonic();
    const first = fullPayment(0, mnemonic);
    const second = fullPayment(0, mnemonic);
    const third = fullPayment(0, mnemonic);
    const sim = new ChainSim(chainId, simNetwork);
    sim.addBlock({ transactions: [{ outputs: [null, null, null, null, null] }, { outputs: [null, null, null, null, null] }] });
    const fork = sim.include(first.entry).number;
    // Every page holds exactly one five-output transaction; nothing is final, so checkpoints stay.
    sim.pageSize = 9;
    sim.finalityLag = 10n;
    const { profile } = deriveSeedWalletIdentity(mnemonic, network);
    const store = memoryWalletStateStore(restoredInventory(sim, profile.address));
    const served: bigint[][] = [];
    const client = sim.client();
    const node = {
      ...client,
      getOutputs: async (request: Parameters<PcashNodeClient["getOutputs"]>[0]) => {
        const page = await client.getOutputs(request);
        served.push(page.outputs.map((output) => output.outputIndex));
        return page;
      },
    } as unknown as PcashNodeClient;
    const indexes = (from: number, to: number) => Array.from({ length: to - from }, (_, index) => BigInt(from + index));
    const sync = async () => (await syncWallet({ node, wallet: profile, chainId, store })).data.sentOutputs
      ?.map((output) => [output.leafIndex, output.amount]);
    const rows = (payment: typeof first, firstLeaf: number) =>
      payment.outputs.map((output, slot) => [String(firstLeaf + slot), output.amount.toString()]);

    await sync();
    sim.include(second.entry);
    sim.addBlock({ transactions: [{ outputs: [null, null, null, null, null] }] });
    expect(await sync()).toEqual([...rows(first, 10), ...rows(second, 15)]);
    expect(served.map((page) => page.length)).toEqual([5, 5, 5, 5, 5]);
    expect(served.flat()).toEqual(indexes(0, 25));

    // The second payment is reorganized away; the replacement block carries a third.
    sim.reorg(fork, []);
    sim.include(third.entry);
    served.length = 0;
    expect(await sync()).toEqual([...rows(first, 10), ...rows(third, 15)]);
    expect(served.flat()).toEqual(indexes(15, 20));
    expect(new Set(sim.calls.map((call) => call.method))).toEqual(new Set(["status", "getAccountChanges", "getOutputs", "getBlockHeader"]));
  });
});

it("recovers mixed-audience messages without notes, survives restart, and follows reorgs", async () => {
  const sender = deriveSeedWalletIdentity(generateWalletMnemonic(), network).profile;
  const alice = deriveSeedWalletIdentity(generateWalletMnemonic(), network).profile;
  const bob = deriveSeedWalletIdentity(generateWalletMnemonic(), network).profile;
  const { memoSchema } = await import("../../src/protocol/records.ts");
  const message = (text: string) => [memoSchema.encode(text)];
  const build = buildNativeTransfer(withSyntheticTransferOpenings({
    chainId, network, wallet: sender, defaultRuleSecrets: sender.defaultUserRuleSecrets,
    selfReceiveKey: sender.mlKemPublicKey, sender: { outgoingKey: sender.outgoingKey },
    recipientAddress: sender.address, paymentAmount: 0n, inputAmount: 0n, noteSecret: 0x123n,
    openFeeAmount: 0n, issuanceOwnerCommitment: 0n, validUntilTimestamp: 9_999_999_999n,
    data: { recipients: [
      { recipientAddress: alice.address, receiveKey: alice.mlKemPublicKey, records: message("alice") },
      { recipientAddress: bob.address, receiveKey: bob.mlKemPublicKey, records: message("bob") },
    ], self: message("sender") },
  }));
  const entry = build.encodeTransaction(new Uint8Array(WIRE_PROOF_BYTES));
  const sim = new ChainSim(chainId, simNetwork);
  sim.finalityLag = 10n;
  sim.addBlock({ transactions: [{ outputs: [null, null, null, null, null] }] });
  const fork = sim.head.number;
  sim.include(entry);
  const stores = [sender, alice, bob].map(profile => memoryWalletStateStore(restoredInventory(sim, profile.address)));
  const sync = (index: number) => syncWallet({ node: sim.client(), wallet: [sender, alice, bob][index]!, chainId, store: stores[index]! });
  for (let index = 0; index < 3; index++) {
    const { data } = await sync(index);
    expect(data.notes).toEqual([]);
    expect(data.sentOutputs ?? []).toEqual([]);
    expect(data.transactionRecords).toHaveLength(1);
    const row = data.transactionRecords![0]!;
    if (index === 0) {
      expect(row.self).toEqual([{ schema: memoSchema.id, data: toHex(utf8("sender")) }]);
      expect(row.sent.map(group => group.records)).toEqual(["alice", "bob"].map(text => [{ schema: memoSchema.id, data: toHex(utf8(text)) }]));
      expect(row.received).toEqual([]);
    } else {
      expect(row.received.map(group => group.records)).toEqual([[{ schema: memoSchema.id, data: toHex(utf8(index === 1 ? "alice" : "bob")) }]]);
      expect(row.self).toEqual([]);
      expect(row.sent).toEqual([]);
    }
    // A new state-store instance uses only persisted state; no transient recipient keys are needed.
    stores[index] = memoryWalletStateStore((await stores[index]!.load())!, stores[index]!.chainSnapshot());
    expect((await sync(index)).data.transactionRecords).toEqual(data.transactionRecords);
  }
  sim.reorg(fork, []);
  for (let index = 0; index < 3; index++) expect((await sync(index)).data.transactionRecords ?? []).toEqual([]);
  sim.include(entry);
  for (let index = 0; index < 3; index++) expect((await sync(index)).data.transactionRecords).toHaveLength(1);
});


it("keeps the records a wallet published, survives restart, and follows reorgs", async () => {
  const sender = deriveSeedWalletIdentity(generateWalletMnemonic(), network).profile;
  const reader = deriveSeedWalletIdentity(generateWalletMnemonic(), network).profile;
  const post = { schema: applicationSchemaId("com.example.post"), data: utf8("hello, board") };
  const build = buildNativeTransfer(withSyntheticTransferOpenings({
    chainId, network, wallet: sender, defaultRuleSecrets: sender.defaultUserRuleSecrets,
    selfReceiveKey: sender.mlKemPublicKey, sender: { outgoingKey: sender.outgoingKey },
    recipientAddress: sender.address, paymentAmount: 0n, inputAmount: 0n, noteSecret: 0x123n,
    openFeeAmount: 0n, issuanceOwnerCommitment: 0n, validUntilTimestamp: 9_999_999_999n,
    data: { public: [post] },
  }));
  const entry = build.encodeTransaction(new Uint8Array(WIRE_PROOF_BYTES));
  const sim = new ChainSim(chainId, simNetwork);
  sim.finalityLag = 10n;
  sim.addBlock({ transactions: [{ outputs: [null, null, null, null, null] }] });
  const fork = sim.head.number;
  const block = sim.include(entry);
  expect(recoverSentTransaction({ chainId, outgoingKey: sender.outgoingKey, transaction: scanTransaction(block.outputs) })!.public).toEqual([post]);
  const stores = [sender, reader].map(profile => memoryWalletStateStore(restoredInventory(sim, profile.address)));
  const sync = (index: number) => syncWallet({ node: sim.client(), wallet: [sender, reader][index]!, chainId, store: stores[index]! });
  const { data } = await sync(0);
  expect(data.transactionRecords).toHaveLength(1);
  expect(data.transactionRecords![0]!).toMatchObject({ public: [{ schema: post.schema, data: toHex(post.data) }], self: [], sent: [], received: [] });
  // Public records are anyone's to read; a wallet keeps only those it published.
  expect((await sync(1)).data.transactionRecords ?? []).toEqual([]);
  stores[0] = memoryWalletStateStore((await stores[0]!.load())!, stores[0]!.chainSnapshot());
  expect((await sync(0)).data.transactionRecords).toEqual(data.transactionRecords);
  sim.reorg(fork, []);
  expect((await sync(0)).data.transactionRecords ?? []).toEqual([]);
});

it("recovers explicit relay and change records from the outgoing key without treating them as payments", async () => {
  const profile = deriveSeedWalletIdentity(generateWalletMnemonic(), network).profile;
  const paid = payee(1), relay = payee(2), changeKey = generateMlKemKeyPair();
  const records = [{ schema: applicationSchemaId("com.example.private"), data: Uint8Array.of(7) }];
  const build = buildNativeTransfer(withSyntheticTransferOpenings({
    chainId, network, wallet: profile, defaultRuleSecrets: profile.defaultUserRuleSecrets,
    selfReceiveKey: changeKey.publicKey, sender: { outgoingKey: profile.outgoingKey },
    recipientAddress: paid.address,
    recipientReceiveKey: paid.keys.publicKey, paymentAmount: 10n,
    privateRelayPayment: { address: relay.address, amount: 5n, receiveKey: relay.keys.publicKey },
    inputAmount: 100n, noteSecret: 0x123n, openFeeAmount: 1n,
    issuanceOwnerCommitment: 0n, validUntilTimestamp: 9_999_999_999n,
    data: { recipients: [
      { recipientAddress: relay.address, receiveKey: relay.keys.publicKey, records },
      { recipientAddress: profile.address, receiveKey: changeKey.publicKey, records },
    ] },
  }));
  const sim = new ChainSim(chainId, simNetwork);
  const block = sim.include(build.encodeTransaction(new Uint8Array(WIRE_PROOF_BYTES)));
  const sent = recoverSentTransaction({ chainId, outgoingKey: profile.outgoingKey, transaction: scanTransaction(block.outputs) })!;
  expect(sent.messages).toEqual([
    { slot: 1, to: addressHex(profile.address), records },
    { slot: 4, to: addressHex(relay.address), records },
  ]);
  expect(sent.outputs.map(output => [output.slot, output.amount])).toEqual([[0, 10n]]);
  // No recipient key on this device can open any output, including the rotated change.
  const data = restoredInventory(sim, profile.address);
  await synchronizeWalletInventory(sim.client(), profile, chainId, data, { store: memoryWalletStateStore(data), target: target(sim) });
  expect(data.notes).toEqual([]);
  expect(data.sentOutputs?.map(output => [output.slot, output.amount])).toEqual([[0, "10"]]);
  expect(data.transactionRecords?.[0]?.sent).toEqual(sent.messages.map(group => ({
    ...group, records: group.records.map(record => ({ ...record, data: toHex(record.data) })),
  })));
});
