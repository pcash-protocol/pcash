import { describe, expect, it } from "vitest";
import { buildNativeTransfer } from "@pcash/sdk/builders";
import { generateMlKemKeyPair, encodePayload, encryptEnvelope, noteBodyCommitment, outputCommitment, ownerCommitment, noteNk, nullifier, payoutSeed, payoutNoteSecret, payoutRoleForSourceKind, type CurrentBoundaryEnvelope, type PayoutComponent, type PayoutSourceKind } from "@pcash/sdk/protocol";
import { scanFeed, SYSTEM_NOTE_OUTPUT_INDEX, type ScanFeedItem } from "../../src/wallet/actions/scan.ts";
import { withSyntheticTransferOpenings } from "./builderTestHelpers.ts";
import { denseRoot } from "./chainFixture.ts";
import { deriveTestWallet, TEST_PRIV_KEY } from "./testWallet.ts";

const chainId = 8190n;
const nkRoot = 123n;
const address = 1234n;
const keys = generateMlKemKeyPair();
const profile = { address, nkRoot };

function payout(sourceKind: PayoutSourceKind, index: bigint, context: bigint, amount = 77n, recipient = profile, component: PayoutComponent = "issuance"): ScanFeedItem {
  const noteSecret = payoutNoteSecret(payoutSeed(recipient.nkRoot), payoutRoleForSourceKind(sourceKind), context);
  const commitment = ownerCommitment(recipient.address, noteSecret);
  return { kind: "system", outputIndex: SYSTEM_NOTE_OUTPUT_INDEX, leafIndex: index,
    outputCommitment: outputCommitment(noteBodyCommitment(commitment, 0n, amount), index),
    payout: { sourceKind, component, contexts: [context], amount, ownerCommitment: commitment } };
}

describe("system note restoration", () => {
  it("uses recovered supply-cap-sized and small payouts as ordinary transfer inputs", async () => {
    const wallet = deriveTestWallet({ privKey: TEST_PRIV_KEY, nkRoot, mlKem: keys });
    const amounts = [10n ** 27n, 7n];
    const { recovered } = await scanFeed({
      chainId, owners: [wallet.address], mlKemSecretKeys: [], recoveryWallet: wallet,
      feed: amounts.map((amount, index) => payout("posterPayout", BigInt(index + 22), 999n, amount, wallet)),
    });
    expect(recovered.map((note) => note.amount)).toEqual(amounts);
    const spentNullifiers = recovered.map((note) => {
      const transfer = buildNativeTransfer(withSyntheticTransferOpenings({
        chainId, wallet, selfReceiveKey: keys.publicKey, recipientAddress: wallet.address,
        recipientReceiveKey: keys.publicKey, inputAmount: note.amount,
        paymentAmount: 1n, openFeeAmount: 0n, issuanceOwnerCommitment: 0n,
        noteSecret: note.noteSecret, outputIndex: Number(note.leafIndex),
        dummyInputEntropy: 1n, validUntilTimestamp: 9_999_999n,
      }));
      const expected = nullifier(note.outputCommitment, noteNk(wallet.nkRoot), note.noteSecret);
      expect(transfer.publicInputs[2]).toBe(expected);
      return expected;
    });
    expect(new Set(spentNullifiers).size).toBe(2);
  });

  it("recovers repeated poster payouts despite an earlier copied commitment with a wrong context", async () => {
    const feed = [payout("posterPayout", 22n, 999n), payout("posterPayout", 23n, 999n)];
    for (const item of feed) {
      if (item.kind !== "system") throw new Error("fixture");
      item.payout.contexts = [123n, 999n];
    }
    const result = await scanFeed({ chainId, owners: [address], mlKemSecretKeys: [], recoveryWallet: profile, feed });
    expect(result.recovered.map((note) => note.amount)).toEqual([77n, 77n]);
    expect(result.recovered[0]!.noteSecret).toBe(result.recovered[1]!.noteSecret);
  });
  it("recovers designated issuance and poster payouts using only the profile and canonical contexts", async () => {
    const feed = [payout("designatedIssuance", 13n, 888n), payout("posterPayout", 14n, 888n), payout("posterPayout", 15n, 999n)];
    const result = await scanFeed({ chainId, owners: [address], mlKemSecretKeys: [], recoveryWallet: profile, feed });
    expect(result.recovered.map((note) => note.amount)).toEqual([77n, 77n, 77n]);
    expect(result.recovered.map((note) => note.assetId)).toEqual([0n, 0n, 0n]);
    expect(new Set(result.recovered.map((note) => note.noteSecret)).size).toBe(3);
    expect(result.trialDecryptAttempts).toBe(0);
  });

  it("recovers a zero-fee issuance-only poster payout from any of several batch contexts", async () => {
    const item = payout("posterPayout", 30n, 777n, 50n);
    if (item.kind !== "system") throw new Error("fixture");
    item.payout.contexts = [111n, 222n, 777n];
    const result = await scanFeed({ chainId, owners: [address], mlKemSecretKeys: [], recoveryWallet: profile, feed: [item] });
    expect(result.recovered.map((note) => note.amount)).toEqual([50n]);
  });

  it("does not recover a payout under another role's derivation", async () => {
    const poster = payout("posterPayout", 31n, 777n);
    if (poster.kind !== "system") throw new Error("fixture");
    const relabeled: ScanFeedItem = { ...poster, payout: { ...poster.payout, sourceKind: "designatedIssuance" } };
    const result = await scanFeed({ chainId, owners: [address], mlKemSecretKeys: [], recoveryWallet: profile, feed: [relabeled] });
    expect(result.recovered).toHaveLength(0);
  });

  it("keeps identical owners and amounts distinct by output index", async () => {
    const result = await scanFeed({ chainId, owners: [address], mlKemSecretKeys: [], recoveryWallet: profile,
      feed: [payout("posterPayout", 22n, 999n), payout("posterPayout", 23n, 999n)] });
    expect(result.recovered).toHaveLength(2);
    expect(result.recovered[0]!.noteSecret).toBe(result.recovered[1]!.noteSecret);
    expect(result.recovered[0]!.outputCommitment).not.toBe(result.recovered[1]!.outputCommitment);
  });

  it("recovers a contract-routed payout from an earlier decrypted owner opening", async () => {
    const noteSecret = 456n, commitment = ownerCommitment(address, noteSecret);
    const knownPayoutOpenings = new Map<bigint, { owner: bigint; noteSecret: bigint }>();
    const ordinary: ScanFeedItem = { kind: 0, shape: 0, outputIndex: 0, leafIndex: 40n,
      outputData: encryptEnvelope(keys.publicKey, encodePayload({ chainId, assetId: 9n, amount: 2n, owner: address, noteSecret, outputIndex: 0 })),
      outputCommitment: outputCommitment(noteBodyCommitment(commitment, 9n, 2n), 40n) };
    await scanFeed({ chainId, owners: [address], mlKemSecretKeys: [keys.secretKey], feed: [ordinary], knownPayoutOpenings });
    const system: ScanFeedItem = { kind: "system", outputIndex: SYSTEM_NOTE_OUTPUT_INDEX, leafIndex: 41n,
      payout: { sourceKind: "designatedIssuance", component: "issuance", contexts: [999n], ownerCommitment: commitment, amount: 77n },
      outputCommitment: outputCommitment(noteBodyCommitment(commitment, 0n, 77n), 41n) };
    const result = await scanFeed({ chainId, owners: [address], mlKemSecretKeys: [], recoveryWallet: profile, feed: [system], knownPayoutOpenings });
    expect(result.recovered[0]!.noteSecret).toBe(noteSecret);
    expect(result.recovered[0]!.assetId).toBe(0n);
  });

  it("rejects wrong contexts, amounts and owners", async () => {
    const original = payout("designatedIssuance", 12n, 888n);
    if (original.kind !== "system") throw new Error("fixture");
    const variants = [
      { ...original, payout: { ...original.payout, contexts: [1n] } },
      { ...original, payout: { ...original.payout, amount: 78n } },
      { ...original, payout: { ...original.payout, ownerCommitment: 1n } },
    ];
    for (const item of variants) {
      const result = await scanFeed({ chainId, owners: [address], mlKemSecretKeys: [], recoveryWallet: profile, feed: [item] });
      expect(result.recovered).toHaveLength(0);
    }
  });
});

function systemOutput(item: ScanFeedItem, origin: { pcashNumber: bigint; pcashHash: string }) {
  if (item.kind !== "system") throw new Error("fixture");
  const { sourceKind, ...components } = item.payout;
  return { kind: "system", outputIndex: item.leafIndex, outputCommitment: `0x${item.outputCommitment.toString(16).padStart(64, "0")}`,
    origin: { ...origin, timestamp: 12n }, payout: { ...components, outputIndex: item.leafIndex,
      ...(sourceKind === "posterPayout"
        ? { transactionId: null, source: { kind: sourceKind, l1TransactionIndices: [0n] } }
        : { transactionId: `0x${"33".repeat(32)}`, source: { kind: sourceKind, l1TransactionIndex: 0n, batchItemIndex: item.leafIndex } }) } };
}

/** Block `number` of a chain whose outputs are exactly `feed` and which has no accounts. */
function payoutBoundary(number: bigint, hash: string, feed: readonly ScanFeedItem[]): CurrentBoundaryEnvelope {
  return {
    state: {
      outputRoot: denseRoot(feed.map((item) => item.outputCommitment)), outputCount: BigInt(feed.length),
      issuedSoFar: 0n, lagQ: 0n, accountStateRoot: denseRoot([]), accountCount: 0n, nullifierRoot: 0n,
      nullifierCount: 0n,
    },
    header: {
      parentHash: 0n, number, timestamp: 12n, transactionResultsRoot: 0n, stateRoot: 0n,
      l1OriginRoot: 0n, historyRoot: 0n,
    },
    blockHash: BigInt(hash),
  };
}

/** The account-change and header reads of that chain as it currently stands. */
function payoutChainReads(head: () => { hash: string; feed: readonly ScanFeedItem[] }) {
  return {
    getAccountChanges: async ({ fromBlock, target }: { fromBlock: bigint; target: { pcashNumber: bigint; pcashHash: string } }) => ({
      fromBlock, target: { ...target, accountCount: 0n }, changes: [], continuation: null, complete: true,
    }),
    getBlockHeader: async (number: bigint) => ({ boundary: payoutBoundary(number, head().hash, head().feed) }),
  };
}

it("removes orphaned system payout notes and matches a fresh restore after suffix replacement", async () => {
  const { syncWallet } = await import("../../src/wallet/actions/syncWallet.ts");
  const { memoryWalletStateStore } = await import("../../src/wallet/memoryStoreBackend.ts");
  const { emptyWalletState } = await import("../../src/wallet/store.ts");
  const genesisHash = `0x${"11".repeat(32)}`;
  let blockHash = `0x${"22".repeat(32)}`;
  let feed = [payout("designatedIssuance", 0n, 111n), payout("posterPayout", 1n, 222n)];
  const wallet = { ...profile, pubX: new Uint8Array(32), pubY: new Uint8Array(32), mlKemPublicKey: keys.publicKey, mlKemSecretKey: keys.secretKey };
  const node = {
    status: async () => ({ pcashChainId: Number(chainId), genesisHash, latestBlock: 1n, latestBlockHash: blockHash, latestBlockTimestamp: 12n, outputCount: BigInt(feed.length), finalizedBlock: 0n, finalizedBlockHash: genesisHash, index: { status: "ready", cursor: { blockNumber: 1n, blockHash } } }),
    ...payoutChainReads(() => ({ hash: blockHash, feed })),
    getOutputs: async ({ fromOutputIndex }: { fromOutputIndex: bigint }) => ({
      fromOutputIndex, target: { pcashNumber: 1n, pcashHash: blockHash, outputCount: BigInt(feed.length) },
      outputs: feed.filter((item) => item.leafIndex >= fromOutputIndex).map((item) => systemOutput(item, { pcashNumber: 1n, pcashHash: blockHash })),
      continuation: null, complete: true,
    }),
  } as unknown as import("@pcash/sdk/clients").PcashNodeClient;
  const store = memoryWalletStateStore(emptyWalletState({ address, network: { chainId, genesisHash } }));
  const first = await syncWallet({ node, wallet, chainId, store });
  expect(first.data.notes).toHaveLength(2);
  const orphaned = new Set(first.data.notes.map((note) => note.commitment));
  blockHash = `0x${"24".repeat(32)}`;
  feed = [payout("designatedIssuance", 0n, 333n)];
  const { data } = await syncWallet({ node, wallet, chainId, store });
  expect(data.notes).toHaveLength(1);
  expect(data.notes.every((note) => !orphaned.has(note.commitment))).toBe(true);
  const restored = await syncWallet({
    node, wallet, chainId, store: memoryWalletStateStore(emptyWalletState({ address, network: { chainId, genesisHash } })),
  });
  expect(restored.data.notes).toEqual(data.notes);
  expect(restored.data.syncedThrough).toEqual(data.syncedThrough);
});

it("rejects a suffix replaced between discovery and the anchor header before persistence", async () => {
  const { synchronizeWalletInventory } = await import("../../src/wallet/actions/scan.ts");
  const { memoryWalletStateStore } = await import("../../src/wallet/memoryStoreBackend.ts");
  const { emptyWalletState } = await import("../../src/wallet/store.ts");
  const genesisHash = `0x${"11".repeat(32)}`, orphanHash = `0x${"22".repeat(32)}`, replacementHash = `0x${"24".repeat(32)}`;
  const discovered = payout("designatedIssuance", 0n, 111n);
  let headHash = orphanHash, persisted = false;
  const wallet = { ...profile, pubX: new Uint8Array(32), pubY: new Uint8Array(32), mlKemPublicKey: keys.publicKey, mlKemSecretKey: keys.secretKey };
  const node = {
    status: async () => ({ pcashChainId: Number(chainId), genesisHash, latestBlock: 1n, latestBlockHash: headHash, outputCount: 1n, finalizedBlock: 0n, finalizedBlockHash: genesisHash, index: { status: "ready", cursor: { blockNumber: 1n, blockHash: headHash } } }),
    ...payoutChainReads(() => ({ hash: headHash, feed: [discovered] })),
    getOutputs: async ({ fromOutputIndex, target }: { fromOutputIndex: bigint; target: { pcashNumber: bigint; pcashHash: string } }) => {
      const result = { fromOutputIndex, target: { ...target, outputCount: 1n }, outputs: [systemOutput(discovered, target)], continuation: null, complete: true };
      headHash = replacementHash;
      return result;
    },
  } as unknown as import("@pcash/sdk/clients").PcashNodeClient;
  const data = emptyWalletState({ address, network: { chainId, genesisHash } });
  await expect(synchronizeWalletInventory(node, wallet, chainId, data, { store: memoryWalletStateStore(data), persist: () => { persisted = true; } })).rejects.toThrow("PCASH head changed during wallet synchronization");
  expect(persisted).toBe(false);
  expect(data.notes).toEqual([]); expect(data.nextOutputIndex).toBeUndefined();
});

it("persists each payout note's source, component, and amount", async () => {
  const { synchronizeWalletInventory } = await import("../../src/wallet/actions/scan.ts");
  const { memoryWalletStateStore } = await import("../../src/wallet/memoryStoreBackend.ts");
  const { emptyWalletState } = await import("../../src/wallet/store.ts");
  const genesisHash = `0x${"11".repeat(32)}`;
  const blockHash = `0x${"22".repeat(32)}`;
  const feed = [
    payout("designatedIssuance", 0n, 111n, 10n, profile, "issuance"),
    payout("posterPayout", 1n, 222n, 3n, profile, "openFee"),
    payout("posterPayout", 2n, 222n, 6n, profile, "issuance"),
    payout("posterPayout", 3n, 333n, 4n, profile, "openFee"),
  ];
  const wallet = { ...profile, pubX: new Uint8Array(32), pubY: new Uint8Array(32), mlKemPublicKey: keys.publicKey, mlKemSecretKey: keys.secretKey };
  const origin = { pcashNumber: 1n, pcashHash: blockHash };
  const node = {
    status: async () => ({ pcashChainId: Number(chainId), genesisHash, latestBlock: 1n, latestBlockHash: blockHash, latestBlockTimestamp: 12n, outputCount: 4n, finalizedBlock: 0n, finalizedBlockHash: genesisHash, index: { status: "ready", cursor: { blockNumber: 1n, blockHash } } }),
    ...payoutChainReads(() => ({ hash: blockHash, feed })),
    getOutputs: async ({ fromOutputIndex }: { fromOutputIndex: bigint }) => ({
      fromOutputIndex, target: { ...origin, outputCount: 4n },
      outputs: feed.map((item) => systemOutput(item, origin)), continuation: null, complete: true,
    }),
  } as unknown as import("@pcash/sdk/clients").PcashNodeClient;
  const data = emptyWalletState({ address, network: { chainId, genesisHash } });
  await synchronizeWalletInventory(node, wallet, chainId, data, { store: memoryWalletStateStore(data) });
  expect(data.notes.map((note) => [note.amount, note.cursor?.payout])).toEqual([
    ["10", { sourceKind: "designatedIssuance", component: "issuance" }],
    ["3", { sourceKind: "posterPayout", component: "openFee" }],
    ["6", { sourceKind: "posterPayout", component: "issuance" }],
    ["4", { sourceKind: "posterPayout", component: "openFee" }],
  ]);
  expect(data.notes.every((note) => note.outputIndex === SYSTEM_NOTE_OUTPUT_INDEX)).toBe(true);
});
