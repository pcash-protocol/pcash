import { transactionIdentity as submissionIdentity } from "@pcash/sdk/protocol";
// Synchronization against the public feeds only: the local chain state
// follows the simulated chain through receives, spends, account writes,
// reorganizations, failed commits, and restores, and every witness it serves
// opens against its anchor.

import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { rootFromIndex } from "@pcash/sdk/crypto";
import { privateKeyPcashActionSigner } from "@pcash/sdk/eip712";
import { defaultUserAccountRuleSet } from "@pcash/sdk/rules";
import {
  accountStateCommitment,
  encodePrivateValueTransaction,
  generateMlKemKeyPair,
  noteNk,
  nullifier,
  WIRE_PROOF_BYTES,
  type LocalWalletProfile,
} from "@pcash/sdk/protocol";
import { addressHex, bytes32Hex, randomFieldEntropy, toHex } from "@pcash/sdk/utils";
import { syncWallet } from "../../src/wallet/actions/syncWallet.ts";
import { localReceiveKeyLookup } from "../../src/wallet/actions/localChain.ts";
import { runNoteFundedTransferClient } from "../../src/wallet/actions/noteFundedClient.ts";
import { createWalletRuntime } from "../../src/wallet/actions/walletRuntime.ts";
import type { DurableSubmissionAdapter } from "../../src/wallet/actions/durableSubmission.ts";
import { derivePcashProfileFromPrivateKey } from "../../src/wallet/externalIdentity.ts";
import { memoryWalletStoreBackend } from "../../src/wallet/memoryStoreBackend.ts";
import type { WalletFileData } from "../../src/wallet/noteStore.ts";
import { walletStore, type WalletStateStore, type WalletStoreBackend } from "../../src/wallet/store.ts";
import { requireReceiveKeys } from "../../src/wallet/wallet.ts";
import { ChainSim, type SimCall, type SimNote } from "./chainFixture.ts";
import { deriveTestWallet } from "./testWallet.ts";

const CHAIN_ID = 0x1ff6n;
const randomWord = (): string => toHex(randomBytes(32));

function freshWallet(): LocalWalletProfile & { mlKemPublicKey: Uint8Array; mlKemSecretKey: Uint8Array } {
  return requireReceiveKeys(deriveTestWallet({
    privKey: new Uint8Array(randomBytes(32)),
    nkRoot: randomFieldEntropy(),
    mlKem: generateMlKemKeyPair(),
  }));
}

function noteTo(wallet: { address: bigint; mlKemPublicKey: Uint8Array }, amount: bigint): SimNote {
  return { owner: wallet.address, receiveKey: wallet.mlKemPublicKey, amount };
}

function accountOf(wallet: { address: bigint; nkRoot: bigint; mlKemPublicKey: Uint8Array }, ruleSet = 7n, revision = 1) {
  return {
    address: addressHex(wallet.address),
    nullifierKeyCommitment: BigInt(accountStateCommitmentKey(wallet.nkRoot)),
    accountRuleSetCommitment: ruleSet,
    accountRevision: revision,
    receiveKey: wallet.mlKemPublicKey,
  };
}

function accountStateCommitmentKey(nkRoot: bigint): bigint {
  // Any commitment works for accounts whose profile is not checked.
  return nkRoot + 1n;
}

/** A backend whose next chain-bearing commit can be made to fail. */
function failingBackend(): WalletStoreBackend & { failNextChainCommit: boolean } {
  const inner = memoryWalletStoreBackend();
  const backend = {
    failNextChainCommit: false,
    read: () => inner.read(),
    readChain: (keys?: readonly string[]) => inner.readChain(keys),
    transaction: <T>(operation: Parameters<WalletStoreBackend["transaction"]>[0], chain?: Parameters<WalletStoreBackend["transaction"]>[1]) => {
      if (chain !== undefined && backend.failNextChainCommit) {
        backend.failNextChainCommit = false;
        return Promise.reject(new Error("disk full"));
      }
      return inner.transaction(operation as never, chain) as Promise<T>;
    },
  };
  return backend;
}

function storeFor(sim: ChainSim, wallet: { address: bigint }, backend: WalletStoreBackend = memoryWalletStoreBackend()): WalletStateStore {
  return walletStore(backend, { address: wallet.address, network: { chainId: CHAIN_ID, genesisHash: sim.genesisHash } });
}

async function sync(sim: ChainSim, wallet: LocalWalletProfile & { mlKemPublicKey: Uint8Array; mlKemSecretKey: Uint8Array }, store: WalletStateStore, options: { rescan?: boolean; anchorAtCurrentBoundary?: boolean } = {}) {
  return syncWallet({ node: sim.client(), wallet, chainId: CHAIN_ID, store, ...options });
}

function nullifierOf(wallet: { nkRoot: bigint }, note: WalletFileData["notes"][number]): string {
  return bytes32Hex(nullifier(BigInt(note.commitment!), noteNk(wallet.nkRoot), BigInt(note.noteSecret)));
}

/** Every confirmed unspent note opens against the anchor, and the wallet's account opens against it too. */
async function expectWitnessesOpen(store: WalletStateStore, data: WalletFileData, address?: string): Promise<void> {
  await store.readChain((chain) => {
    const anchor = chain!.requireAnchor();
    const notes = data.notes.filter((note) => !note.pending && !note.spent);
    const paths = chain!.outputPaths(notes.map((note) => ({ outputIndex: BigInt(note.leafIndex!) })));
    notes.forEach((note, index) => {
      const siblings = paths.paths[index]!.siblings.map(BigInt);
      expect(rootFromIndex(BigInt(note.commitment!), BigInt(note.leafIndex!), siblings)).toBe(anchor.state.outputRoot);
    });
    if (address !== undefined) {
      const proof = chain!.accountProof(address);
      if (proof.status !== "present") throw new Error("account missing");
      const leaf = accountStateCommitment(
        BigInt(proof.account.address),
        BigInt(proof.account.nullifierKeyCommitment),
        BigInt(proof.account.accountRuleSetCommitment),
        proof.account.accountKind,
        proof.account.accountRevision,
        BigInt(proof.account.receiveKeyHash),
      );
      expect(rootFromIndex(leaf, proof.account.index, proof.accountSiblings)).toBe(anchor.state.accountStateRoot);
    }
  });
}

describe("wallet chain synchronization", () => {
  it("syncs from genesis, recovers its notes, and opens them at the anchor", async () => {
    const sim = new ChainSim(CHAIN_ID);
    const alice = freshWallet();
    const bob = freshWallet();
    sim.addBlock({
      accounts: [accountOf(alice), accountOf(bob)],
      transactions: [{ nullifiers: [randomWord()], outputs: [noteTo(alice, 10n), null, noteTo(bob, 3n), null, null] }],
    });
    sim.addBlock({ transactions: [{ nullifiers: [randomWord()], outputs: [null, noteTo(alice, 7n), null, null, null] }] });
    const store = storeFor(sim, alice);
    const { data } = await sync(sim, alice, store);
    expect(data.notes.map((note) => [note.leafIndex, note.amount, note.spent])).toEqual([["0", "10", false], ["6", "7", false]]);
    expect(data.historyStartOutputIndex).toBe("0");
    await expectWitnessesOpen(store, data, addressHex(alice.address));
    expect(await store.readChain((chain) => chain!.receiveKey(addressHex(bob.address)))).toEqual(bob.mlKemPublicKey);
    expect(sim.calls.map((call) => call.method)).toEqual(["status", "getAccountChanges", "getOutputs", "getBlockHeader"]);
  });

  it("rejects an altered receive key in an incremental step and refuses only the key after a fresh replay", async () => {
    const sim = new ChainSim(CHAIN_ID);
    const alice = freshWallet();
    const bob = freshWallet();
    sim.addBlock({ accounts: [accountOf(alice)], transactions: [{ nullifiers: [randomWord()], outputs: [noteTo(alice, 10n), null, null, null, null] }] });
    const store = storeFor(sim, alice);
    await sync(sim, alice, store);
    sim.addBlock({ accounts: [accountOf(bob)] });
    // The node serves bob's genuine row and digest with other key bytes.
    const altered = (): ReturnType<ChainSim["client"]> => {
      const client = sim.client();
      const getAccountChanges = client.getAccountChanges.bind(client);
      return Object.assign(Object.create(client), {
        getAccountChanges: async (query: Parameters<typeof getAccountChanges>[0]) => {
          const page = await getAccountChanges(query);
          return { ...page, changes: page.changes.map((change) => change.receiveKey === null ? change
            : { ...change, receiveKey: Uint8Array.from(change.receiveKey, (byte) => byte ^ 0xff) }) };
        },
      });
    };
    const bobAddress = addressHex(bob.address);
    await expect(syncWallet({ node: altered(), wallet: alice, chainId: CHAIN_ID, store }))
      .rejects.toThrow("does not match its committed digest");
    await sync(sim, alice, store);
    expect(await localReceiveKeyLookup(store)(bobAddress)).toEqual(bob.mlKemPublicKey);

    const replayed = storeFor(sim, alice);
    const { data } = await syncWallet({ node: altered(), wallet: alice, chainId: CHAIN_ID, store: replayed });
    await expectWitnessesOpen(replayed, data, bobAddress);
    await expect(localReceiveKeyLookup(replayed)(bobAddress)).rejects.toThrow("does not match its committed digest");
  });

  it("refuses an incremental step whose feed rows disagree with the anchor block, keeping the previous state", async () => {
    const sim = new ChainSim(CHAIN_ID);
    const alice = freshWallet();
    const bob = freshWallet();
    sim.addBlock({ accounts: [accountOf(alice)], transactions: [{ nullifiers: [randomWord()], outputs: [noteTo(alice, 10n), null, null, null, null] }] });
    const store = storeFor(sim, alice);
    const first = await sync(sim, alice, store);
    sim.addBlock({ accounts: [accountOf(bob)], transactions: [{ nullifiers: [randomWord()], outputs: [null, noteTo(alice, 4n), null, null, null] }] });
    const forged = (rewrite: { outputs?: boolean; accounts?: boolean }): ReturnType<ChainSim["client"]> => {
      const client = sim.client();
      const getOutputs = client.getOutputs.bind(client);
      const getAccountChanges = client.getAccountChanges.bind(client);
      return Object.assign(Object.create(client), {
        getOutputs: async (query: Parameters<typeof getOutputs>[0]) => {
          const page = await getOutputs(query);
          return rewrite.outputs !== true ? page : { ...page, outputs: page.outputs.map((row) =>
            row.outputIndex === 7n ? { ...row, outputCommitment: bytes32Hex(BigInt(row.outputCommitment) ^ 1n) } : row) };
        },
        getAccountChanges: async (query: Parameters<typeof getAccountChanges>[0]) => {
          const page = await getAccountChanges(query);
          return rewrite.accounts !== true ? page : { ...page, changes: page.changes.map((change) =>
            ({ ...change, accountRuleSetCommitment: change.accountRuleSetCommitment + 1n })) };
        },
      });
    };
    await expect(syncWallet({ node: forged({ outputs: true }), wallet: alice, chainId: CHAIN_ID, store }))
      .rejects.toThrow("does not match the anchor block's output root");
    await expect(syncWallet({ node: forged({ accounts: true }), wallet: alice, chainId: CHAIN_ID, store }))
      .rejects.toThrow("does not match the anchor block's account root");
    expect((await store.load())!.syncedThrough).toEqual(first.data.syncedThrough);
    const { data } = await sync(sim, alice, store);
    expect(data.notes.map((note) => [note.leafIndex, note.amount])).toEqual([["0", "10"], ["6", "4"]]);
    await expectWitnessesOpen(store, data, addressHex(alice.address));
  });

  it("marks a note spent when its nullifier appears in the feed and records the consuming transaction", async () => {
    const sim = new ChainSim(CHAIN_ID);
    const alice = freshWallet();
    sim.addBlock({ transactions: [{ outputs: [noteTo(alice, 10n), noteTo(alice, 4n), null, null, null] }] });
    const store = storeFor(sim, alice);
    const first = await sync(sim, alice, store);
    const spentNote = first.data.notes[0]!;
    const contentHash = randomWord();
    sim.addBlock({ transactions: [{ contentHash, nullifiers: [nullifierOf(alice, spentNote), randomWord()], outputs: [null, null, null, null, null] }] });
    const { data } = await sync(sim, alice, store);
    expect(data.notes.map((note) => note.spent)).toEqual([true, false]);
    const consumption = await store.readChain((chain) => chain!.consumption([nullifierOf(alice, spentNote)])[0]);
    expect(consumption).toMatchObject({ contentHash, pcashNumber: 2n });
    await expectWitnessesOpen(store, data);
  });

  it("rewinds a reorganized receive, spend, and account update, then resyncs the replacement", async () => {
    const sim = new ChainSim(CHAIN_ID);
    sim.finalityLag = 100n;
    const alice = freshWallet();
    const address = addressHex(alice.address);
    sim.addBlock({ accounts: [accountOf(alice)], transactions: [{ outputs: [noteTo(alice, 10n), null, null, null, null] }] });
    const store = storeFor(sim, alice);
    const first = await sync(sim, alice, store);
    const kept = first.data.notes[0]!;
    sim.addBlock({ transactions: [{ outputs: [noteTo(alice, 7n), null, null, null, null] }] });
    await sync(sim, alice, store);
    sim.addBlock({
      accounts: [accountOf(alice, 99n, 2)],
      transactions: [{ nullifiers: [nullifierOf(alice, kept)], outputs: [null, null, null, null, null] }],
    });
    const beforeReorg = await sync(sim, alice, store);
    expect(beforeReorg.data.notes.map((note) => [note.amount, note.spent])).toEqual([["10", true], ["7", false]]);
    expect(await store.readChain((chain) => chain!.account(address)!.accountRevision)).toBe(2n);

    sim.reorg(1n, [
      { transactions: [{ outputs: [null, noteTo(alice, 5n), null, null, null] }] },
      {},
      {},
    ]);
    sim.calls.length = 0;
    const { data } = await sync(sim, alice, store);
    expect(data.notes.map((note) => [note.amount, note.spent])).toEqual([["10", false], ["5", false]]);
    expect(await store.readChain((chain) => chain!.account(address)!.accountRevision)).toBe(1n);
    await expectWitnessesOpen(store, data, address);
    expect(sim.calls.map((call) => call.method)).toEqual([
      "status", "getBlockHeader", "getBlockHeader", "getBlockHeader",
      "getAccountChanges", "getOutputs", "getBlockHeader",
    ]);
  });

  it("commits a rewind at its checkpoint while the node's index trails it, then catches up", async () => {
    const sim = new ChainSim(CHAIN_ID);
    sim.finalityLag = 100n;
    const alice = freshWallet();
    const store = storeFor(sim, alice);
    sim.addBlock({ transactions: [{ outputs: [noteTo(alice, 10n), null, null, null, null] }] });
    await sync(sim, alice, store);
    sim.addBlock({ transactions: [{ outputs: [noteTo(alice, 7n), null, null, null, null] }] });
    await sync(sim, alice, store);
    sim.addBlock({ transactions: [{ outputs: [noteTo(alice, 3n), null, null, null, null] }] });
    await sync(sim, alice, store);
    sim.reorg(2n, [{ transactions: [{ outputs: [noteTo(alice, 4n), null, null, null, null] }] }]);
    sim.indexLag = 2n;
    const behind = await sync(sim, alice, store);
    expect(behind.data.notes.map((note) => note.amount)).toEqual(["10", "7"]);
    expect(await store.readChain((chain) => chain!.synced.pcashNumber)).toBe(2n);
    await expectWitnessesOpen(store, behind.data);
    sim.indexLag = 0n;
    const { data } = await sync(sim, alice, store);
    expect(data.notes.map((note) => note.amount)).toEqual(["10", "7", "4"]);
    await expectWitnessesOpen(store, data);
  });

  it("replays from the birthday when a reorganization passes every checkpoint", async () => {
    const sim = new ChainSim(CHAIN_ID);
    const alice = freshWallet();
    sim.addBlock({ transactions: [{ outputs: [noteTo(alice, 10n), null, null, null, null] }] });
    const store = storeFor(sim, alice);
    await sync(sim, alice, store);
    sim.reorg(0n, [{ transactions: [{ outputs: [null, noteTo(alice, 2n), null, null, null] }] }]);
    const { data } = await sync(sim, alice, store);
    expect(data.notes.map((note) => note.amount)).toEqual(["2"]);
    await expectWitnessesOpen(store, data);
  });

  it("replays from genesis when a reorganization replaces an anchored wallet's birthday block", async () => {
    const sim = new ChainSim(CHAIN_ID);
    const alice = freshWallet();
    const bob = freshWallet();
    for (let block = 0; block < 3; block++) {
      sim.addBlock({ transactions: [{ outputs: [noteTo(bob, 1n), null, null, null, null] }] });
    }
    const store = storeFor(sim, alice);
    await sync(sim, alice, store, { anchorAtCurrentBoundary: true });
    expect((await store.load())!.historyStartOutputIndex).toBe("15");
    // The replacement birthday block ends at count 20 and pays Alice at leaf 16, below its end frontier.
    sim.reorg(2n, [{ transactions: [
      { outputs: [null, null, null, null, null] },
      { outputs: [null, noteTo(alice, 9n), null, null, null] },
    ] }]);
    const { data } = await sync(sim, alice, store);
    expect(data.historyStartOutputIndex).toBe("0");
    expect(data.notes.map((note) => [note.leafIndex, note.amount])).toEqual([["16", "9"]]);
    await expectWitnessesOpen(store, data);
  });

  it("restarts an anchored wallet at its birthday when the birthday block survives a reorganization", async () => {
    const sim = new ChainSim(CHAIN_ID);
    const alice = freshWallet();
    const bob = freshWallet();
    for (let block = 0; block < 3; block++) {
      sim.addBlock({ transactions: [{ outputs: [noteTo(bob, 1n), null, null, null, null] }] });
    }
    const store = storeFor(sim, alice);
    await sync(sim, alice, store, { anchorAtCurrentBoundary: true });
    sim.addBlock({ transactions: [{ outputs: [noteTo(bob, 1n), null, null, null, null] }] });
    await sync(sim, alice, store);
    // Finality at the head leaves only the newest checkpoint, so replacing it passes every checkpoint.
    sim.reorg(3n, [{ transactions: [{ outputs: [null, noteTo(alice, 4n), null, null, null] }] }]);
    sim.calls.length = 0;
    const { data } = await sync(sim, alice, store);
    expect(sim.calls.map((call) => call.method)).toContain("getOutputFrontier");
    expect(data.historyStartOutputIndex).toBe("15");
    expect(data.notes.map((note) => [note.leafIndex, note.amount])).toEqual([["16", "4"]]);
    await expectWitnessesOpen(store, data);
  });

  it("keeps the previous complete state when a commit fails, and resumes after restart", async () => {
    const sim = new ChainSim(CHAIN_ID);
    const alice = freshWallet();
    sim.addBlock({ transactions: [{ outputs: [noteTo(alice, 10n), null, null, null, null] }] });
    const backend = failingBackend();
    const store = storeFor(sim, alice, backend);
    await sync(sim, alice, store);
    sim.addBlock({ transactions: [{ outputs: [noteTo(alice, 4n), null, null, null, null] }] });
    backend.failNextChainCommit = true;
    await expect(sync(sim, alice, store)).rejects.toThrow("disk full");

    const restarted = storeFor(sim, alice, backend);
    const loaded = await restarted.load();
    expect(loaded!.notes.map((note) => note.amount)).toEqual(["10"]);
    expect(await restarted.readChain((chain) => chain!.synced.pcashNumber)).toBe(1n);
    expect(await store.readChain((chain) => chain!.outputs.count)).toBe(5n);
    const { data } = await sync(sim, alice, restarted);
    expect(data.notes.map((note) => note.amount)).toEqual(["10", "4"]);
    await expectWitnessesOpen(restarted, data);
  });

  it("anchors a new wallet at the current boundary from the node's frontier", async () => {
    const sim = new ChainSim(CHAIN_ID);
    const alice = freshWallet();
    const bob = freshWallet();
    for (let block = 0; block < 3; block++) {
      sim.addBlock({ transactions: [{ outputs: [noteTo(bob, 1n), null, null, null, null] }] });
    }
    const store = storeFor(sim, alice);
    await sync(sim, alice, store, { anchorAtCurrentBoundary: true });
    expect(sim.calls.map((call) => call.method)).toContain("getOutputFrontier");
    sim.addBlock({ transactions: [{ outputs: [null, noteTo(alice, 6n), null, null, null] }] });
    const { data } = await sync(sim, alice, store);
    expect(data.historyStartOutputIndex).toBe("15");
    expect(data.notes.map((note) => [note.leafIndex, note.amount])).toEqual([["16", "6"]]);
    await expectWitnessesOpen(store, data);
  });

  it("pages outputs and account changes without changing what is synced", async () => {
    const sim = new ChainSim(CHAIN_ID);
    // An output page holds whole transactions: one five-output transaction per page here.
    sim.pageSize = 5;
    const alice = freshWallet();
    const others = Array.from({ length: 7 }, () => freshWallet());
    sim.addBlock({ accounts: others.map((wallet) => accountOf(wallet)), transactions: [{ outputs: [null, null, null, noteTo(alice, 9n), null] }] });
    sim.addBlock({ transactions: [{ outputs: [noteTo(alice, 2n), null, null, null, null] }] });
    const store = storeFor(sim, alice);
    const { data } = await sync(sim, alice, store);
    expect(data.notes.map((note) => note.amount)).toEqual(["9", "2"]);
    await expectWitnessesOpen(store, data, addressHex(others[3]!.address));
  });
});

describe("request transcripts", () => {
  const SUBMISSION = new Set(["submitRawTransaction", "getReceipt", "getMempoolTransaction"]);
  const transcript = (calls: readonly SimCall[]) => calls.filter((call) => !SUBMISSION.has(call.method));

  it("is identical for two wallets with different notes over the same chain range", async () => {
    const sim = new ChainSim(CHAIN_ID);
    const alice = freshWallet();
    const bob = freshWallet();
    sim.addBlock({
      accounts: [accountOf(alice), accountOf(bob)],
      transactions: [{ outputs: [noteTo(alice, 10n), noteTo(alice, 3n), null, null, null] }],
    });
    const aliceStore = storeFor(sim, alice);
    const bobStore = storeFor(sim, bob);
    const record = async (steps: () => Promise<void>) => {
      sim.calls.length = 0;
      await steps();
      return transcript([...sim.calls]);
    };
    const first = [
      await record(async () => { await sync(sim, alice, aliceStore); }),
      await record(async () => { await sync(sim, bob, bobStore); }),
    ];
    const aliceNote = (await aliceStore.load())!.notes[0]!;
    sim.addBlock({ transactions: [{ nullifiers: [nullifierOf(alice, aliceNote)], outputs: [noteTo(bob, 4n), null, null, null, null] }] });
    const second = [
      await record(async () => { await sync(sim, alice, aliceStore); }),
      await record(async () => { await sync(sim, bob, bobStore); }),
    ];
    expect(first[0]).toEqual(first[1]);
    expect(second[0]).toEqual(second[1]);
    expect((await aliceStore.load())!.notes.map((note) => note.spent)).toEqual([true, false]);
    expect((await bobStore.load())!.notes.map((note) => note.amount)).toEqual(["4"]);
  });
});

describe("restore and spend", () => {
  const PRIVATE_KEY = new Uint8Array(randomBytes(32));
  const NETWORK = { pcashChainId: CHAIN_ID, l1ChainId: 11_155_111n, inboxAddress: `0x${"66".repeat(20)}` };
  const profile = derivePcashProfileFromPrivateKey(PRIVATE_KEY, NETWORK);
  const signer = privateKeyPcashActionSigner(PRIVATE_KEY);
  const rules = defaultUserAccountRuleSet({ wallet: profile, network: NETWORK, secrets: profile.defaultUserRuleSecrets });
  const prover = {
    proveAndEncode: async (build: { publicInputs: bigint[]; outputData: readonly Uint8Array[]; arena: Uint8Array }) => encodePrivateValueTransaction({
      publicInputs: build.publicInputs, proof: new Uint8Array(WIRE_PROOF_BYTES), outputData: build.outputData, arena: build.arena,
    } as never),
  };

  it("finds old notes from genesis with an empty store and spends one with no note, account, or nullifier request", async () => {
    const sim = new ChainSim(CHAIN_ID);
    const recipient = freshWallet();
    sim.addBlock({
      accounts: [
        {
          address: addressHex(profile.address),
          nullifierKeyCommitment: profile.nullifierKeyCommitment,
          accountRuleSetCommitment: rules.accountRuleSetCommitment,
          receiveKey: profile.mlKemPublicKey,
        },
        accountOf(recipient),
      ],
      transactions: [{ outputs: [noteTo(profile, 10n), null, null, null, null] }],
    });
    sim.addBlock({ transactions: [{ outputs: [null, null, noteTo(profile, 5n), null, null] }] });

    // A device restored from the seed starts with nothing but the profile.
    const store = storeFor(sim, profile);
    const restored = await syncWallet({ node: sim.client(), wallet: profile, chainId: CHAIN_ID, store });
    expect(restored.data.notes.map((note) => note.amount)).toEqual(["10", "5"]);

    const included: string[] = [];
    const submission: DurableSubmissionAdapter<string, string> = {
      mode: "mempool",
      preflight: async () => "prepared",
      submit: async ({ transactionBytes: entry }) => {
        const { contentHash } = submissionIdentity(entry);

        sim.include(entry);
        included.push(contentHash);
        return { accepted: false, queued: true, output: "queued" };
      },
    };
    sim.calls.length = 0;
    const result = await runNoteFundedTransferClient({
      node: sim.client(),
      store,
      wallet: profile,
      signer,
      chainId: CHAIN_ID,
      to: addressHex(recipient.address),
      amount: 8n,
      openFeeAmount: 0n,
      issuanceOwnerCommitment: 0n,
      prover: prover as never,
      submission,
      settlePollIntervalMs: 0,
      settlePollMaxAttempts: 1,
    });
    expect(included).toEqual([result.contentHash]);
    // Building, proving, and journaling read only the node's status.
    expect(sim.calls.filter((call) => !SUBMISSION_METHODS.has(call.method)).map((call) => call.method)
      .every((method) => method === "status")).toBe(true);

    const received = await sync(sim, recipient, storeFor(sim, recipient));
    expect(received.data.notes.map((note) => note.amount)).toEqual(["8"]);
    const after = await syncWallet({ node: sim.client(), wallet: profile, chainId: CHAIN_ID, store });
    expect(after.data.notes.filter((note) => !note.pending).map((note) => [note.amount, note.spent]))
      .toEqual([["10", true], ["5", false], ["2", false]]);
  });

  it("refuses a recipient key from an account set the payment's witnesses do not open against", async () => {
    const sim = new ChainSim(CHAIN_ID);
    const recipient = freshWallet();
    sim.addBlock({
      accounts: [
        {
          address: addressHex(profile.address),
          nullifierKeyCommitment: profile.nullifierKeyCommitment,
          accountRuleSetCommitment: rules.accountRuleSetCommitment,
          receiveKey: profile.mlKemPublicKey,
        },
        accountOf(recipient),
      ],
      transactions: [{ outputs: [noteTo(profile, 10n), null, null, null, null] }],
    });
    const store = storeFor(sim, profile);
    await syncWallet({ node: sim.client(), wallet: profile, chainId: CHAIN_ID, store });
    // A synchronization step commits another key for the recipient right
    // after the witnesses are read.
    sim.addBlock({ accounts: [{ ...accountOf(recipient, 7n, 2), receiveKey: generateMlKemKeyPair().publicKey }] });
    let raced = false;
    const racing: WalletStateStore = Object.assign(Object.create(store) as WalletStateStore, {
      readChain: async <T>(read: Parameters<WalletStateStore["readChain"]>[0]) => {
        const value = await store.readChain(read);
        if (!raced && typeof value === "object" && value !== null && "blockHeader" in value) {
          raced = true;
          await syncWallet({ node: sim.client(), wallet: profile, chainId: CHAIN_ID, store });
        }
        return value as T;
      },
    });
    const submission: DurableSubmissionAdapter<string, string> = {
      mode: "mempool",
      preflight: async () => "prepared",
      submit: async () => { throw new Error("nothing may be submitted"); },
    };
    await expect(runNoteFundedTransferClient({
      node: sim.client(), store: racing, wallet: profile, signer, chainId: CHAIN_ID,
      to: addressHex(recipient.address), amount: 8n, openFeeAmount: 0n, issuanceOwnerCommitment: 0n,
      prover: prover as never, submission, settlePollIntervalMs: 0, settlePollMaxAttempts: 1,
    })).rejects.toThrow("differs from the transaction snapshot");
    expect(raced).toBe(true);
    expect((await store.load())!.pendingNoteFundedTransfers ?? []).toEqual([]);
  });

  it("settles a payment whose inclusion lands after submission by synchronizing between attempts", async () => {
    const sim = new ChainSim(CHAIN_ID);
    const recipient = freshWallet();
    sim.addBlock({
      accounts: [
        {
          address: addressHex(profile.address),
          nullifierKeyCommitment: profile.nullifierKeyCommitment,
          accountRuleSetCommitment: rules.accountRuleSetCommitment,
          receiveKey: profile.mlKemPublicKey,
        },
        accountOf(recipient),
      ],
      transactions: [{ outputs: [noteTo(profile, 10n), null, null, null, null] }],
    });
    const store = storeFor(sim, profile);
    await syncWallet({ node: sim.client(), wallet: profile, chainId: CHAIN_ID, store });
    const submission: DurableSubmissionAdapter<string, string> = {
      mode: "l1",
      preflight: async () => "prepared",
      submit: async ({ transactionBytes: entry }) => {
        sim.include(entry);
        return { accepted: true, queued: false, output: "accepted" };
      },
    };
    const runtime = createWalletRuntime({
      node: sim.client(), chainId: CHAIN_ID, wallet: profile, signer, store,
      provers: { privateValue: prover as never }, submission,
      settlePollIntervalMs: 0, settlePollMaxAttempts: 3,
    });
    const result = await runtime.transfer({ to: addressHex(recipient.address), amount: 8n, openFeeAmount: 0n });
    expect(result.settled).toBe(true);
    expect((await store.load())!.pendingNoteFundedTransfers ?? []).toEqual([]);
  });
});

const SUBMISSION_METHODS = new Set(["submitRawTransaction", "getReceipt", "getMempoolTransaction"]);
