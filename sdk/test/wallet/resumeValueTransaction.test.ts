import { OPEN_WALLET_INTERNAL, Wallet } from "../../src/wallet/actions/walletClient.ts";
import { WALLET_DATABASE_STATE_STORE, type WalletDatabase } from "../../src/wallet/store.ts";
import { walletAction } from "../../src/wallet/walletAction.ts";
import { describe, expect, it, vi } from "vitest";
import {
  decodeTransaction, deliveryCommitment, encodePrivateValueTransaction, fullOutputCommitment,
  randomArena, sizeClassFiller, transactionIdentity, WIRE_PROOF_BYTES,
} from "@pcash/sdk/protocol";
import { PRIVATE_VALUE_PROFILES } from "@pcash/sdk/constants";
import { bytes32Hex, toHex } from "@pcash/sdk/utils";
import type { PcashNodeClient, ReceiptResult } from "@pcash/sdk/clients";
import type { RelayJournalEntry, RelayJournalRecovery } from "@pcash/sdk/relay";
import { derivePcashProfileFromPrivateKey } from "../../src/wallet/externalIdentity.ts";
import { memoryWalletStateStore } from "../../src/wallet/memoryStoreBackend.ts";
import { emptyWalletState } from "../../src/wallet/store.ts";
import { addPendingAssetAction, reservedNoteCommitments, type PendingAssetAction } from "../../src/wallet/noteStore.ts";
import { resumeValueTransaction } from "../../src/wallet/actions/resumeValueTransaction.ts";
import { noteNullifier } from "../../src/wallet/actions/publication.ts";
import type { DurableSubmissionAdapter } from "../../src/wallet/actions/durableSubmission.ts";
import { anchoredChain, chainRecords, consumedIn, ChainSim } from "./chainFixture.ts";
import { testStatus } from "./statusFixture.ts";

const network = { pcashChainId: 8182n, l1ChainId: 11155111n, inboxAddress: `0x${"66".repeat(20)}` };
const wallet = derivePcashProfileFromPrivateKey(new Uint8Array(32).fill(17), network);
const genesisHash = bytes32Hex(111n);

function fixture(options: { expired?: boolean; noNotes?: boolean; assetId?: bigint; consumed?: "ours" | "other"; unfinalized?: boolean } = {}) {
  const assetId = options.assetId ?? 0n;
  const noteSecret = 12n;
  const commitment = fullOutputCommitment({ owner: wallet.address, noteSecret, assetId, amount: 100n }, 0);
  const chain = anchoredChain({ outputs: [{ leaf: commitment, mark: true }], blockNumber: 10n, timestamp: 100n });
  const data = emptyWalletState({ address: wallet.address, network: { chainId: network.pcashChainId, genesisHash } });
  const note = { leafIndex: "0", outputIndex: 0, assetId: bytes32Hex(assetId), amount: "100", owner: wallet.address.toString(), noteSecret: bytes32Hex(noteSecret), commitment: bytes32Hex(commitment), spent: options.consumed !== undefined, pending: false };
  if (!options.noNotes) data.notes.push(note);
  data.syncedThrough = { blockNumber: "10", blockHash: bytes32Hex(chain.boundary.blockHash) };
  data.finalizedThrough = { blockNumber: options.unfinalized ? "9" : "10", blockHash: bytes32Hex(chain.boundary.blockHash) };
  const status = testStatus({ pcashChainId: Number(network.pcashChainId), genesisHash,
    latestBlock: 10n, latestBlockHash: bytes32Hex(chain.boundary.blockHash), latestBlockTimestamp: 100n,
    finalizedBlock: options.unfinalized ? 9n : 10n,
    finalizedBlockHash: bytes32Hex(chain.boundary.blockHash), finalizedBlockTimestamp: 100n });
  const { offsets, publicInputs: count } = PRIVATE_VALUE_PROFILES.S;
  const outputData = Array.from({ length: 5 }, sizeClassFiller);
  const arena = randomArena(0);
  const words = Array<bigint>(count).fill(0n);
  words[0] = network.pcashChainId; words[1] = chain.boundary.blockHash;
  const nullifiers = [noteNullifier(wallet.nkRoot, note), 21n, 22n, 23n];
  nullifiers.forEach((value, index) => { words[offsets.nullifiers + index] = value; });
  words[offsets.deliveryCommitment] = deliveryCommitment(outputData, arena);
  words[offsets.validUntil] = options.expired ? 99n : 200n;
  const bytes = encodePrivateValueTransaction({ publicInputs: words, proof: new Uint8Array(WIRE_PROOF_BYTES), outputData, arena });
  const identity = transactionIdentity(bytes);
  const consumed = options.consumed === undefined ? [] : consumedIn(chain.boundary,
    options.consumed === "ours" ? identity.contentHash : bytes32Hex(789n), nullifiers.map(bytes32Hex));
  const store = memoryWalletStateStore(data, chainRecords({ anchor: chain.boundary, outputs: [{ leaf: commitment, mark: true }], consumed }));
  const state = { accepted: false, ready: false, orphaned: false, latched: false, carrying: false, l1Hash: bytes32Hex(700n) as string | null, decline: false,
    submitted: [] as Uint8Array[], beforeAnchor: async () => {} };
  const recovery: RelayJournalRecovery = {
    reconcile: async () => ({ latched: state.latched, entries: [] }),
    show: async () => ({ latched: state.latched, entries: state.carrying ? [{ kind: "batch", selected: [identity.contentHash], transactionHash: state.l1Hash } as RelayJournalEntry] : [] }),
    resolve: async () => { throw new Error("not requested"); },
  };
  const node = {
    status: async () => status,
    getReceipt: async () => state.accepted ? [{ outcome: "succeeded", contentHash: identity.contentHash, kind: "privateValue" } as ReceiptResult] : [],
    getBlockByHash: async () => { await state.beforeAnchor(); return state.orphaned ? null : { timestamp: 100n }; },
    getMempoolTransaction: async () => state.ready ? { contentHash: identity.contentHash, rawTransaction: identity.transactionHex, kind: "privateValue", status: "ready" } : null,
  } as unknown as PcashNodeClient;
  const preflight = vi.fn(async () => null);
  const submission: DurableSubmissionAdapter<null, null> = {
    mode: "mempool", l1Recovery: async () => recovery, preflight,
    submit: async ({ transactionBytes }) => {
      if (state.decline) throw new Error("declined");
      state.submitted.push(transactionBytes); state.ready = true;
      return { accepted: false, queued: true, output: null };
    },
    isDefinitePreBroadcastError: error => error instanceof Error && error.message === "declined",
  };
  const run = (beforeSubmit?: () => void | Promise<void>) => resumeValueTransaction({
    ...identity, node, store, wallet, chainId: network.pcashChainId, submission, synchronize: async () => {},
    ...(beforeSubmit === undefined ? {} : { beforeSubmit }),
  });
  return { state, status, store, node, submission, preflight, run, ...identity, bytes, commitment, nullifiers };
}

describe("retained wallet-funded value transactions", () => {
  it.each([0n, 51n])("restores one generic reservation and resubmits exact bytes for asset %s", async assetId => {
    const f = fixture({ assetId });
    expect(await f.run()).toMatchObject({ state: "pending", queued: true, contentHash: f.contentHash });
    const saved = (await f.store.load())!;
    expect(saved.pendingAssetActions).toHaveLength(1);
    expect(saved.pendingAssetActions![0]).toMatchObject({ transactionHex: f.transactionHex, assetId: bytes32Hex(assetId), owner: null,
      ownedOutputs: [], inputs: [{ nullifier: bytes32Hex(f.nullifiers[0]!), spentCommitment: bytes32Hex(f.commitment) }, ...f.nullifiers.slice(1).map(value => ({ nullifier: bytes32Hex(value), spentCommitment: null }))] });
    expect(reservedNoteCommitments(saved).has(f.commitment.toString())).toBe(true);
    expect(f.state.submitted).toEqual([f.bytes]);
    await f.run();
    expect(f.state.submitted).toHaveLength(1);
    expect((await f.store.load())!.pendingAssetActions).toHaveLength(1);
  });

  it("does not describe an L1 submission as ready for mempool relay", async () => {
    const f = fixture(); f.submission.mode = "l1";
    expect(await f.run()).toMatchObject({ state: "pending", queued: false });
    expect(f.state.submitted).toEqual([f.bytes]);
  });

  it("keeps exact retry bytes after a definite declined resubmission", async () => {
    const f = fixture(); f.state.decline = true;
    await expect(f.run()).rejects.toThrow("declined");
    expect((await f.store.load())!.pendingAssetActions?.[0]?.transactionHex).toBe(f.transactionHex);
    f.state.decline = false;
    await f.run();
    expect(toHex(f.state.submitted[0]!)).toBe(f.transactionHex);
  });

  it("runs the application deadline guard only before actual publication", async () => {
    const f = fixture(); const before = vi.fn(() => { throw new Error("offer expired"); });
    await expect(f.run(before)).rejects.toThrow("offer expired");
    expect(f.state.submitted).toHaveLength(0);
    expect(before).toHaveBeenCalledOnce();
    f.state.ready = true;
    expect(await f.run(before)).toMatchObject({ state: "pending", queued: true });
    expect(before).toHaveBeenCalledOnce();
  });

  it("accepts canonical inclusion without requiring a surviving wallet journal", async () => {
    const f = fixture({ noNotes: true }); f.state.accepted = true;
    expect(await f.run()).toMatchObject({ state: "accepted" });
    expect(f.preflight).not.toHaveBeenCalled();
  });

  it("does not rebuild a wallet-observed inclusion while its indexed receipt lags", async () => {
    const f = fixture({ expired: true, consumed: "ours" });
    expect(await f.run()).toMatchObject({ state: "pending", message: expect.stringContaining("observed") });
    expect(f.preflight).not.toHaveBeenCalled();
  });

  it("permits rebuilding only after covered finalized expiry or competing consumption", async () => {
    expect(await fixture({ expired: true }).run()).toMatchObject({ state: "rebuildable" });
    expect(await fixture({ consumed: "other" }).run()).toMatchObject({ state: "rebuildable" });
    expect(await fixture({ consumed: "other", unfinalized: true }).run()).toMatchObject({ state: "blocked", message: expect.stringContaining("not finalized") });
  });

  it("does not interpret absent watched history as an expired unsent transaction", async () => {
    const f = fixture({ expired: true, noNotes: true });
    expect(await f.run()).toMatchObject({ state: "blocked", message: expect.stringContaining("Rescan") });
    expect((await f.store.load())!.pendingAssetActions).toBeUndefined();
  });

  it("requires the wallet's finalized identity to match the node before rebuilding", async () => {
    const f = fixture({ expired: true }); f.status.finalizedBlockHash = bytes32Hex(800n);
    expect(await f.run()).toMatchObject({ state: "blocked", message: expect.stringContaining("finalized chain") });
  });

  it("keeps an orphaned transaction unresolved until finalized time releases it", async () => {
    const f = fixture(); f.state.orphaned = true;
    expect(await f.run()).toMatchObject({ state: "blocked", message: expect.stringContaining("deadline") });
  });

  it("waits for the same known L1 publication and restores its lost value reservation", async () => {
    const f = fixture(); f.state.latched = true; f.state.carrying = true;
    expect(await f.run()).toMatchObject({ state: "pending", queued: false });
    expect((await f.store.load())!.pendingAssetActions).toHaveLength(1);
    expect(f.preflight).not.toHaveBeenCalled();
  });

  it("does not replace unresolved Ethereum publication after PCASH expiry", async () => {
    const f = fixture({ expired: true }); f.state.latched = true; f.state.carrying = true;
    expect(await f.run()).toMatchObject({ state: "blocked", message: expect.stringContaining("Ethereum") });
  });

  it("refreshes transport state after acquiring the input lease", async () => {
    const f = fixture(); let reads = 0;
    f.state.beforeAnchor = async () => { if (++reads === 2) f.state.latched = true; };
    expect(await f.run()).toMatchObject({ state: "blocked", message: expect.stringContaining("Ethereum") });
    expect(f.preflight).not.toHaveBeenCalled();
    expect((await f.store.load())!.pendingAssetActions).toBeUndefined();
  });

  it("refreshes the saved anchor after acquiring the input lease", async () => {
    const f = fixture(); let reads = 0;
    f.state.beforeAnchor = async () => { if (++reads === 2) f.state.orphaned = true; };
    expect(await f.run()).toMatchObject({ state: "blocked", message: expect.stringContaining("stale") });
    expect(f.state.submitted).toHaveLength(0);
  });

  it("checks the configured network before accepting a receipt", async () => {
    const f = fixture(); f.state.accepted = true; f.status.genesisHash = bytes32Hex(999n);
    await expect(f.run()).rejects.toThrow("different network genesis");
  });

  it("does not bypass another action's input reservation", async () => {
    const f = fixture();
    f.state.beforeAnchor = async () => {
      await f.store.transaction(data => {
        addPendingAssetAction(data!, { contentHash: bytes32Hex(999n), transactionHex: "0x", assetId: bytes32Hex(0n), owner: null,
          notBeforeTimestamp: "0", validUntilTimestamp: "200", openFeeAmount: "0", issuanceOwnerCommitment: "0",
          inputs: [{ nullifier: bytes32Hex(f.nullifiers[0]!), spentCommitment: bytes32Hex(f.commitment) }], ownedOutputs: [] } satisfies PendingAssetAction);
        return { data: data!, value: undefined };
      });
    };
    await expect(f.run()).rejects.toThrow("already journaled by another action");
    expect(f.state.submitted).toHaveLength(0);
  });

  it("rejects an unsupported transaction kind before submission", async () => {
    const f = fixture();
    const decoded = decodeTransaction(f.bytes);
    expect(decoded.kind).toBe(0);
    await expect(resumeValueTransaction({ transactionHex: "0x0100001ff601", node: f.node, store: f.store, wallet,
      chainId: network.pcashChainId, submission: f.submission, synchronize: async () => {} })).rejects.toThrow();
  });
});


it("keeps transport recovery capabilities scoped to an advanced wallet action", async () => {
  const sim = new ChainSim(network.pcashChainId, { l1ChainId: network.l1ChainId, inboxAddress: network.inboxAddress });
  const node = sim.client();
  const store = memoryWalletStateStore(emptyWalletState({ address: wallet.address, network: { chainId: network.pcashChainId, genesisHash: sim.genesisHash } }));
  const database: WalletDatabase = { [WALLET_DATABASE_STATE_STORE]: () => store,
    subscribe: async () => async () => {}, close: async () => {} };
  const recovery: RelayJournalRecovery = {
    show: async () => ({ latched: false, entries: [] }), reconcile: async () => ({ latched: false, entries: [] }),
    resolve: async id => ({ latched: false, resolutionId: id, archivePath: "resolved" }),
  };
  const submission: DurableSubmissionAdapter<null, null> = { mode: "l1", node, l1Sender: "sender", prepareOnly: true,
    l1Recovery: async () => recovery, preflight: async () => null, submit: async () => ({ accepted: false, queued: false, output: null }) };
  const opened = await Wallet[OPEN_WALLET_INTERNAL]({ database, node, profile: wallet, submission });
  try {
    const retained = await opened.execute(walletAction("transport-capabilities", async context => {
      expect(context.submission).toMatchObject({ mode: "l1", l1Sender: "sender", prepareOnly: true });
      expect(await context.submission!.node!.status()).toEqual(await node.status());
      const view = await context.submission!.l1Recovery!();
      expect(await view.show()).toEqual({ latched: false, entries: [] });
      expect(await view.reconcile()).toEqual({ latched: false, entries: [] });
      expect(await view.resolve("entry")).toMatchObject({ resolutionId: "entry" });
      return view;
    }));
    await expect(retained.show()).rejects.toThrow("execution context is no longer active");
  } finally { await opened.close(); }
});
