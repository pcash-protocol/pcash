import { memoSchema, claimedSenderSchema, storeTransactionData, restoreTransactionData, transactionDataHash } from "@pcash/sdk/delivery";
import type { NoteFundedProver } from "@pcash/sdk/wallet/actions";
import { applicationSchemaId, encodeUserAccountCreation, transactionIdentity as submissionIdentity } from "@pcash/sdk/protocol";
import { buildDirectReferenceUserAccountCreation } from "@pcash/sdk/builders";
import type { DurableSubmissionAdapter } from "@pcash/sdk/wallet";
import type { RelayJournalEntry } from "@pcash/sdk/relay";
import { assetDefinitionAssetId, encodePrivateValueTransaction, WIRE_PROOF_BYTES, encodePayload, encryptEnvelope, formatAssetDefinition, noteBodyCommitment, outputCommitment, ownerCommitment, type AssetDefinition, type CurrentBoundaryEnvelope } from "@pcash/sdk/protocol";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it, vi } from "vitest";
import { OPEN_WALLET_INTERNAL, Wallet } from "@pcash/sdk/wallet";
import { WalletCapabilityError } from "@pcash/sdk/wallet";
import type { PcashNodeClient, StatusResult } from "@pcash/sdk/clients";
import { privateKeyPcashActionSigner, type PcashActionSigner } from "@pcash/sdk/eip712";
import { defaultUserAccountRuleSet } from "@pcash/sdk/rules";
import { derivePcashProfileFromPrivateKey } from "@pcash/sdk/wallet";
import type { WalletFileData } from "@pcash/sdk/wallet/testing";
import { noteStore } from "@pcash/sdk/wallet/testing";
import { emptyWalletState, type WalletStateCommit } from "@pcash/sdk/wallet/testing";
import { type WalletStateStore } from "@pcash/sdk/wallet/database";
import {
  PGliteWalletDatabase,
} from "../src/pgliteDatabase.ts";
import { WALLET_DATABASE_STATE_STORE, type WalletDatabase } from "@pcash/sdk/wallet/database";
import { keyedResourcePool } from "@pcash/sdk/wallet";
import { TEST_PRIV_KEY } from "./testWallet.ts";
import { ChainSim } from "./chainFixture.ts";
import { walletAction } from "@pcash/sdk/wallet";
import type {
  WalletAccountMetricState,
  WalletActionMetricContext,
  WalletActionMetricResult,
  WalletMetrics,
  WalletSyncMetricContext,
  WalletSyncMetricResult,
} from "@pcash/sdk/wallet";
import {
  acquireWalletReservation,
  WALLET_SYNC_RESOURCE,
} from "@pcash/sdk/wallet/testing";

const CHAIN_ID = 8191;
const INBOX = `0x${"22".repeat(20)}`;

/** A simulated chain at genesis serving the public reads synchronization makes. */
function chain(): ChainSim {
  return new ChainSim(BigInt(CHAIN_ID), { l1ChainId: 11155111n, inboxAddress: INBOX });
}

const GENESIS_HASH = chain().genesisHash;
const status = chain().status();
const hashOf = (block: { hash: bigint }): string => `0x${block.hash.toString(16).padStart(64, "0")}`;

function node(sim: ChainSim = chain()): PcashNodeClient {
  return sim.client();
}

/** A status that reports `sim`'s head while its derived index serves only through `indexed`. */
function statusIndexedThrough(sim: ChainSim, indexed: bigint): StatusResult {
  const current = sim.status();
  return { ...current, index: { status: "ready", cursor: { blockNumber: indexed, blockHash: hashOf(sim.block(indexed)) } } };
}

function profile() {
  return derivePcashProfileFromPrivateKey(TEST_PRIV_KEY, {
    pcashChainId: BigInt(CHAIN_ID),
    l1ChainId: 11155111n,
    inboxAddress: INBOX,
  });
}

function scanningProfile() {
  const { pubX, pubY, address, nkRoot, mlKemPublicKey, mlKemSecretKey } = profile();
  return { pubX, pubY, address, nkRoot, mlKemPublicKey, mlKemSecretKey };
}

function identityFor(account: ReturnType<typeof scanningProfile>) {
  return {
    address: account.address,
    network: { chainId: BigInt(CHAIN_ID), genesisHash: GENESIS_HASH },
  };
}

async function database(): Promise<WalletDatabase> {
  return PGliteWalletDatabase.open(await PGlite.create("memory://"), { ownsClient: true });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

function stateWithOneNote(identity: Parameters<typeof emptyWalletState>[0]): WalletFileData {
  const data = emptyWalletState(identity);
  data.syncedThrough = { blockNumber: "0", blockHash: GENESIS_HASH };
  data.finalizedThrough = data.syncedThrough;
  data.notes = [{
    leafIndex: "0",
    outputIndex: 0,
    assetId: "0x0",
    amount: "1",
    owner: `0x${identity.address.toString(16)}`,
    noteSecret: "0x1",
    commitment: `0x${"08".repeat(32)}`,
    spent: false,
    pending: false,
    cursor: {
      kind: "ordinary",
      payout: null,
      blockNumber: "0",
      blockHash: GENESIS_HASH,
      blockTimestamp: "1800000000",
      transactionId: `0x${"99".repeat(32)}`,
      outputIndex: "0",
    },
  }];
  return data;
}

class RecordingWalletMetrics implements WalletMetrics {
  readonly syncStarted: WalletSyncMetricContext[] = [];
  readonly syncFinished: WalletSyncMetricResult[] = [];
  readonly actionStarted: WalletActionMetricContext[] = [];
  readonly actionFinished: WalletActionMetricResult[] = [];
  readonly accountStates: WalletAccountMetricState[] = [];

  recordSyncStarted(context: WalletSyncMetricContext): void {
    this.syncStarted.push(context);
  }

  recordSyncFinished(result: WalletSyncMetricResult): void {
    this.syncFinished.push(result);
  }

  recordActionStarted(context: WalletActionMetricContext): void {
    this.actionStarted.push(context);
  }

  recordActionFinished(result: WalletActionMetricResult): void {
    this.actionFinished.push(result);
  }

  recordAccountState(state: WalletAccountMetricState): void {
    this.accountStates.push(state);
  }

  removeAccount(_account: string): void {}
}

describe("high-level Wallet", () => {
  it("records successful and failed syncs and actions with bounded labels", async () => {
    const db = await database();
    const metrics = new RecordingWalletMetrics();
    let failStatus = false;
    const controlledNode = {
      ...node(),
      status: async () => {
        if (failStatus) throw new Error("node failure with credentials=secret");
        return status;
      },
    } as unknown as PcashNodeClient;
    const wallet = await Wallet[OPEN_WALLET_INTERNAL]({
      database: db,
      node: controlledNode,
      profile: scanningProfile(),
      metrics,
    });

    const incremental = await wallet.sync();
    await expect(wallet.send({ to: wallet.address, amount: 1n }))
      .rejects.toBeInstanceOf(WalletCapabilityError);
    await wallet.createReceiveKey();
    await wallet.execute(walletAction("recipient:0xdeadbeef", async () => "ok"));
    await expect(wallet.execute(walletAction("transaction:0xsecret", async () => {
      throw new Error("private key leaked");
    }))).rejects.toThrow("private key leaked");
    failStatus = true;
    await expect(wallet.sync()).rejects.toThrow("credentials=secret");
    failStatus = false;

    expect(incremental.scanned).toBe(0);
    // Every action opens with an incremental sync; the receive key adds a full replay.
    expect(metrics.syncStarted.map(({ mode }) => mode)).toEqual([
      "incremental",
      "incremental",
      "incremental",
      "full",
      "incremental",
      "incremental",
      "incremental",
    ]);
    expect(metrics.syncFinished.map(({ mode, outcome }) => ({ mode, outcome }))).toEqual([
      { mode: "incremental", outcome: "success" },
      { mode: "incremental", outcome: "success" },
      { mode: "incremental", outcome: "success" },
      { mode: "full", outcome: "success" },
      { mode: "incremental", outcome: "success" },
      { mode: "incremental", outcome: "success" },
      { mode: "incremental", outcome: "error" },
    ]);
    expect(metrics.syncFinished[0]).toMatchObject({
      outputsScanned: 0,
      trialDecryptAttempts: 0,
      decryptions: 0,
      recoveredNotes: 0,
    });
    expect(metrics.syncFinished.every(({ durationSeconds }) => durationSeconds >= 0)).toBe(true);
    expect(metrics.actionStarted.map(({ action }) => action)).toEqual([
      "send",
      "receive_key",
      "custom",
      "custom",
    ]);
    expect(metrics.actionFinished.map(({ action, outcome }) => ({ action, outcome }))).toEqual([
      { action: "send", outcome: "error" },
      { action: "receive_key", outcome: "success" },
      { action: "custom", outcome: "success" },
      { action: "custom", outcome: "error" },
    ]);
    expect(metrics.actionFinished.every(({ durationSeconds }) => durationSeconds >= 0)).toBe(true);
    expect(metrics.accountStates[0]).toMatchObject({
      scanCursor: null,
      nodeTip: 0n,
      finalizedCursor: null,
      noteCount: 0,
      pendingActionCount: 0,
      receiveKeyCount: 0,
    });
    expect(metrics.accountStates.some(({ receiveKeyCount }) => receiveKeyCount === 2)).toBe(true);
    expect(new Set([
      ...metrics.syncStarted.map(({ account }) => account),
      ...metrics.actionStarted.map(({ account }) => account),
      ...metrics.accountStates.map(({ account }) => account),
    ])).toEqual(new Set([wallet.address]));

    await wallet.close();
    await db.close();
  });

  it("does not make post-action node requests for account metrics", async () => {
    const db = await database();
    const never = deferred<StatusResult>();
    let statusCalls = 0;
    const controlledNode = {
      ...node(),
      status: () => {
        statusCalls += 1;
        return statusCalls <= 4 ? Promise.resolve(status) : never.promise;
      },
    } as unknown as PcashNodeClient;
    const wallet = await Wallet[OPEN_WALLET_INTERNAL]({
      database: db,
      node: controlledNode,
      profile: scanningProfile(),
      metrics: new RecordingWalletMetrics(),
    });

    // Opening reads once; each action's opening sync reads once, and execute once more.
    await expect(Promise.race([
      wallet.execute(walletAction("test:success", async () => "done")),
      new Promise((_, reject) => setTimeout(() => reject(new Error("action timed out")), 100)),
    ])).resolves.toBe("done");
    await expect(wallet.send({ to: wallet.address, amount: 1n }))
      .rejects.toBeInstanceOf(WalletCapabilityError);
    await expect(Promise.race([
      wallet.close(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("close timed out")), 100)),
    ])).resolves.toBeUndefined();
    expect(statusCalls).toBe(4);

    await db.close();
  });

  it("returns a completed sync without an extra status request for metrics", async () => {
    const db = await database();
    const never = deferred<StatusResult>();
    let statusCalls = 0;
    const controlledNode = {
      ...node(),
      status: () => {
        statusCalls += 1;
        return statusCalls <= 2 ? Promise.resolve(status) : never.promise;
      },
    } as unknown as PcashNodeClient;
    const wallet = await Wallet[OPEN_WALLET_INTERNAL]({
      database: db,
      node: controlledNode,
      profile: scanningProfile(),
      metrics: new RecordingWalletMetrics(),
    });

    await expect(Promise.race([
      wallet.sync(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("sync timed out")), 100)),
    ])).resolves.toMatchObject({ scanned: 0, trialDecryptAttempts: 0 });
    expect(statusCalls).toBe(2);

    await wallet.close();
    await db.close();
  });

  it("reruns a coalesced local metrics refresh when a newer action finishes", async () => {
    const db = await database();
    const account = scanningProfile();
    const identity = identityFor(account);
    const backingStore = db[WALLET_DATABASE_STATE_STORE](identity);
    await backingStore.save(emptyWalletState(identity));
    const refreshLoadStarted = deferred<void>();
    const releaseRefreshLoad = deferred<void>();
    let holdNextLoad = false;
    const store: WalletStateStore = {
      ...backingStore,
      async load() {
        const current = await backingStore.load();
        if (holdNextLoad) {
          holdNextLoad = false;
          refreshLoadStarted.resolve();
          await releaseRefreshLoad.promise;
        }
        return current;
      },
    };
    const facade = {
      [WALLET_DATABASE_STATE_STORE]: () => store,
      subscribe: db.subscribe.bind(db),
    } as unknown as WalletDatabase;
    const metrics = new RecordingWalletMetrics();
    const wallet = await Wallet[OPEN_WALLET_INTERNAL]({
      database: facade,
      node: node(),
      profile: account,
      metrics,
    });

    // Hold the refresh that follows the action, not the action's opening sync.
    await wallet.execute(walletAction("first", async () => { holdNextLoad = true; }));
    await refreshLoadStarted.promise;
    await backingStore.save(stateWithOneNote(identity));
    await wallet.execute(walletAction("second", async () => undefined));
    releaseRefreshLoad.resolve();
    await wallet.close();

    expect(metrics.accountStates.at(-1)?.noteCount).toBe(1);
    await db.close();
  });

  it("follows the tip with one scan per new scannable boundary", async () => {
    const db = await database();
    const sim = chain();
    sim.finalityLag = 1n;
    let indexed = 0n;
    let polls = 0;
    const controlledNode = {
      ...node(sim),
      status: async () => { polls += 1; return statusIndexedThrough(sim, indexed); },
    } as unknown as PcashNodeClient;
    const wallet = await Wallet[OPEN_WALLET_INTERNAL]({ database: db, node: controlledNode, profile: scanningProfile() });
    const scans: bigint[] = [];
    const tips: bigint[] = [];
    const unsubscribe = [
      wallet.on("sync:completed", (event) => { scans.push(event.syncedThrough.pcashNumber); }),
      wallet.on("sync:tip", (event) => { tips.push(event.status.latestBlock); }),
    ];

    wallet.startSync({ intervalMs: 1 });
    await vi.waitFor(() => expect(tips).toEqual([0n]));
    // The canonical tip moves before the index that serves its outputs.
    sim.addBlock();
    await vi.waitFor(() => expect(tips).toEqual([0n, 1n]));
    const seen = polls;
    await vi.waitFor(() => expect(polls).toBeGreaterThan(seen + 2));
    expect(scans).toEqual([0n]);
    indexed = 1n;
    await vi.waitFor(() => expect(scans).toEqual([0n, 1n]));

    await Promise.all(unsubscribe.map((remove) => remove()));
    await wallet.stopSync();
    await wallet.close();
    await db.close();
  });

  it("scans a followed boundary with the status it was read from and one account-feed read", async () => {
    const db = await database();
    const sim = chain();
    sim.finalityLag = 1n;
    const genesis = sim.status();
    sim.addBlock();
    const advanced = sim.status();
    const reads = { status: 0, account: 0 };
    const base = node(sim);
    const controlledNode = {
      ...base,
      // Opening and the catch-up scan see block 0; the follower then sees block 1.
      status: async () => (++reads.status <= 2 ? genesis : advanced),
      getAccountChanges: async (query: Parameters<PcashNodeClient["getAccountChanges"]>[0]) => {
        reads.account += 1;
        return base.getAccountChanges(query);
      },
    } as unknown as PcashNodeClient;
    const wallet = await Wallet[OPEN_WALLET_INTERNAL]({ database: db, node: controlledNode, profile: profile() });
    const scans: bigint[] = [];
    const unsubscribe = wallet.on("sync:completed", (event) => { scans.push(event.syncedThrough.pcashNumber); });

    wallet.startSync({ intervalMs: 60_000 });
    await vi.waitFor(() => expect(scans).toEqual([0n, 1n]));
    // Opening the wallet reads once and the catch-up scan once. The follower's
    // poll is reused as its scan's status. Each scan reads the account change
    // feed once.
    expect(reads).toEqual({ status: 3, account: 2 });

    await unsubscribe();
    await wallet.stopSync();
    await wallet.close();
    await db.close();
  });

  it("records an observed node-tip advance while its catch-up scan is still running", async () => {
    const db = await database();
    const metrics = new RecordingWalletMetrics();
    const sim = chain();
    sim.finalityLag = 1n;
    const genesis = sim.status();
    sim.addBlock();
    const delayedScanStarted = deferred<void>();
    const releaseDelayedScan = deferred<void>();
    let statusCalls = 0;
    const base = node(sim);
    const controlledNode = {
      ...base,
      // Opening and the catch-up scan see block 0; the follower's first poll sees block 1.
      status: async () => (++statusCalls >= 3 ? sim.status() : genesis),
      getOutputs: async (request: Parameters<PcashNodeClient["getOutputs"]>[0]) => {
        if (request.target.pcashNumber === 1n) {
          delayedScanStarted.resolve();
          await releaseDelayedScan.promise;
        }
        return base.getOutputs(request);
      },
    } as unknown as PcashNodeClient;
    const wallet = await Wallet[OPEN_WALLET_INTERNAL]({
      database: db,
      node: controlledNode,
      profile: scanningProfile(),
      metrics,
    });

    wallet.startSync({ intervalMs: 1 });
    await delayedScanStarted.promise;
    await vi.waitFor(() => {
      expect(metrics.accountStates.some((state) =>
        state.nodeTip === 1n && state.scanCursor === 0n)).toBe(true);
    });

    releaseDelayedScan.resolve();
    await wallet.stopSync();
    await wallet.close();
    await db.close();
  });

  it("derives the canonical profile when opened with only a signer", async () => {
    const db = await database();
    const wallet = await Wallet[OPEN_WALLET_INTERNAL]({
      database: db,
      node: node(),
      signer: privateKeyPcashActionSigner(TEST_PRIV_KEY),
    });

    expect(wallet.spendable()).toBe(true);
    expect(wallet.address).toBe(`0x${profile().address.toString(16).padStart(40, "0")}`);

    await wallet.close();
    await db.close();
  });

  it("runs generic transaction clients without exposing the database", async () => {
    const db = await database();
    const account = profile();
    const sim = chain();
    const client = node(sim);
    const wallet = await Wallet[OPEN_WALLET_INTERNAL]({ database: db, node: client, profile: account });
    const events: string[] = [];
    const unsubscribeStarted = wallet.on("action:started", ({ action }) => {
      events.push(`${action.name}:started`);
    });
    const unsubscribeCompleted = wallet.on("action:completed", ({ action }) => {
      events.push(`${action.name}:completed`);
    });

    const action = walletAction("test:transaction", async (context) => {
      expect(context.node).toBe(client);
      expect(context.profile).not.toBe(account);
      expect(context.profile).toEqual(account);
      expect(context.network).toEqual({ chainId: BigInt(CHAIN_ID), genesisHash: GENESIS_HASH });
      expect(context.status.genesisHash).toBe(GENESIS_HASH);
      expect(context.store.identity.address).toBe(account.address);
      expect("database" in context).toBe(false);
      sim.addBlock();
      await context.synchronize();
      expect((await context.store.load())?.syncedThrough?.blockNumber).toBe("1");
      return "submitted";
    });
    expect(typeof action).toBe("function");
    expect(action.actionName).toBe("test:transaction");
    expect(Object.isFrozen(action)).toBe(true);
    const result = await wallet.execute(action);

    expect(result).toBe("submitted");
    expect(events).toEqual(["test:transaction:started", "test:transaction:completed"]);
    await Promise.all([unsubscribeStarted(), unsubscribeCompleted()]);
    await wallet.close();
    await db.close();
  });

  it("dispatches action events and awaited durable hooks from one lifecycle", async () => {
    const db = await database();
    const wallet = await Wallet[OPEN_WALLET_INTERNAL]({ database: db, node: node(), profile: profile() });
    const order: string[] = [];
    const actionIds: string[] = [];
    let escapedLifecycle: Parameters<Parameters<typeof walletAction>[1]>[0]["lifecycle"] | undefined;
    const removeStarted = wallet.on("action:started", (event) => {
      order.push("started");
      actionIds.push(event.action.id);
      expect(event.action.name).toBe("test:lifecycle");
      expect(Object.isFrozen(event)).toBe(true);
      expect("store" in event).toBe(false);
      throw new Error("observer failures are isolated");
    });
    const removeProgress = wallet.on("action:progress", (event) => {
      order.push(`${event.phase}:${event.message}`);
      actionIds.push(event.action.id);
    });
    const removeBeforeEvent = wallet.on("action:before-journal", (event) => {
      order.push(`event:before:${event.contentHash}`);
      actionIds.push(event.action.id);
    });
    const removePreparedEvent = wallet.on("action:prepared", async (event) => {
      order.push(`event:${event.contentHash}`);
      actionIds.push(event.action.id);
      throw new Error("async observer failures are isolated");
    });
    const removeCompleted = wallet.on("action:completed", (event) => {
      order.push("completed");
      actionIds.push(event.action.id);
    });
    const removeBeforeHook = wallet.hook("action:before-journal", async ({ contentHash }) => {
      order.push(`hook:before:${contentHash}`);
    });
    const removePreparedHook = wallet.hook("action:prepared", ({ contentHash }) => {
      order.push(`hook:prepared:${contentHash}`);
    });

    const result = await wallet.execute(walletAction("test:lifecycle", async ({ lifecycle }) => {
      escapedLifecycle = lifecycle;
      const callbacks = lifecycle.durableCallbacks({
        beforeJournal: (contentHash) => { order.push(`callback:before:${contentHash}`); },
        onPrepared: (contentHash) => { order.push(`callback:prepared:${contentHash}`); },
      });
      callbacks.onProgress?.("proving", "proof");
      await callbacks.beforeJournal?.("0xtx", "0xentry");
      order.push("journal");
      await callbacks.onPrepared?.("0xtx", "0xentry");
      return "done";
    }));

    expect(result).toBe("done");
    expect(order).toEqual([
      "started",
      "proving:proof",
      "event:before:0xtx",
      "hook:before:0xtx",
      "callback:before:0xtx",
      "journal",
      "event:0xtx",
      "hook:prepared:0xtx",
      "callback:prepared:0xtx",
      "completed",
    ]);
    expect(new Set(actionIds).size).toBe(1);
    expect(() => escapedLifecycle?.progress("late", "late")).toThrow(
      "wallet action lifecycle is no longer active",
    );

    removeBeforeHook();
    removePreparedHook();
    await Promise.all([
      removeStarted(),
      removeProgress(),
      removeBeforeEvent(),
      removePreparedEvent(),
      removeCompleted(),
    ]);
    await wallet.close();
    await db.close();
  });

  it("aborts an action when an awaited lifecycle hook fails", async () => {
    const db = await database();
    const wallet = await Wallet[OPEN_WALLET_INTERNAL]({ database: db, node: node(), profile: profile() });
    let callbackRan = false;
    let actionError: Error | undefined;
    wallet.hook("action:before-journal", () => { throw new Error("checkpoint unavailable"); });
    wallet.on("action:error", ({ error }) => { actionError = error; });

    await expect(wallet.execute(walletAction("test:hook-failure", async ({ lifecycle }) => {
      const callbacks = lifecycle.durableCallbacks({ beforeJournal: () => { callbackRan = true; } });
      await callbacks.beforeJournal?.("0xtx", "0xentry");
    }))).rejects.toThrow("checkpoint unavailable");

    expect(callbackRan).toBe(false);
    expect(actionError?.message).toBe("checkpoint unavailable");
    await wallet.close();
    await db.close();
  });

  it("rejects an unadapted execution callback at runtime", async () => {
    const db = await database();
    const wallet = await Wallet[OPEN_WALLET_INTERNAL]({ database: db, node: node(), profile: profile() });

    await expect(wallet.execute((async () => undefined) as never)).rejects.toThrow(
      "Wallet.execute requires an action created by walletAction()",
    );

    await wallet.close();
    await db.close();
  });

  it("rejects an execution callback after the node switches genesis", async () => {
    const db = await database();
    let genesisHash = GENESIS_HASH;
    const switchedNode = {
      ...node(),
      status: async () => ({ ...status, genesisHash }),
    } as unknown as PcashNodeClient;
    const wallet = await Wallet[OPEN_WALLET_INTERNAL]({ database: db, node: switchedNode, profile: profile() });
    let entered = false;

    genesisHash = `0x${"33".repeat(32)}`;
    // The action's opening synchronization is the first read to see the switch.
    await expect(wallet.execute(walletAction("test:switched-network", () => { entered = true; }))).rejects.toThrow(
      "wallet store belongs to a different network genesis",
    );

    expect(entered).toBe(false);
    await wallet.close();
    await db.close();
  });

  it("revokes escaped execution capabilities and protects the Wallet profile", async () => {
    const db = await database();
    const account = profile();
    const budget = vi.fn(async () => ({ address: INBOX, maximumCostWei: 100n }));
    const wallet = await Wallet[OPEN_WALLET_INTERNAL]({
      database: db,
      node: node(),
      profile: account,
      signer: privateKeyPcashActionSigner(TEST_PRIV_KEY),
      submission: {
        mode: "l1", preflight: async () => undefined,
        submit: async () => { throw new Error("unused"); },
        preflightL1Budget: budget,
      },
    });
    let escapedBudget!: NonNullable<DurableSubmissionAdapter["preflightL1Budget"]>;
    let escapedStore!: WalletStateStore;
    let escapedSigner!: PcashActionSigner;

    await wallet.execute(walletAction("test:escaped-capabilities", async (context) => {
      escapedBudget = context.submission!.preflightL1Budget!;
      expect(await escapedBudget({ status, maxBatchBytes: 30_000, additionalValueWei: 1n })).toEqual({ address: INBOX, maximumCostWei: 100n });
      escapedStore = context.store;
      escapedSigner = context.signer!;
      (context.profile as { address: bigint }).address = 1n;
    }));

    expect(budget).toHaveBeenCalledOnce();
    await expect(escapedBudget({ status, maxBatchBytes: 30_000, additionalValueWei: 1n })).rejects.toThrow("execution context is no longer active");
    expect(account.address).not.toBe(1n);
    await expect(escapedStore.load()).rejects.toThrow("execution context is no longer active");
    await expect(escapedSigner.signTypedData({} as never)).rejects.toThrow("execution context is no longer active");
    await wallet.close();
    await db.close();
  });

  it("waits for a final pooled close before reopening the same key", async () => {
    const finishClose = deferred<void>();
    let opens = 0;
    const acquire = keyedResourcePool<{ id: number }>(async () => finishClose.promise);
    const first = await acquire("wallet", async () => ({ id: ++opens }));
    const closing = first.release();
    const reopening = acquire("wallet", async () => ({ id: ++opens }));
    await Promise.resolve();
    expect(opens).toBe(1);
    finishClose.resolve();
    const second = await reopening;
    expect(second.resource.id).toBe(2);
    await closing;
    await second.release();
  });

  it("discovers ordinary notes before account activation", async () => {
    const db = await database();
    const account = profile();
    const sim = chain();
    sim.addBlock({ transactions: [{ outputs: [{ owner: account.address, receiveKey: account.mlKemPublicKey, amount: 7n }] }] });
    const received = sim.head.outputs[0]!;
    const transactionId = received.kind === "ordinary" ? received.transactionId : "";
    const rpc = { ...node(sim) } as PcashNodeClient;
    const opened = await Wallet[OPEN_WALLET_INTERNAL]({ database: db, node: rpc, profile: account });
    expect((await opened.snapshot()).syncedThrough).toBeNull();
    await opened.sync({ awaitFunds: true });
    expect(await opened.nativeFunds()).toMatchObject({ private: 7n, total: 7n,
      synchronized: true, pcashNumber: 1n, pcashHash: hashOf(sim.head) });
    expect((await opened.snapshot()).ownedNoteCount).toBe(1);
    expect(await opened.nativeActivity()).toMatchObject({ state: "ready",
      entries: [{ direction: "received", amount: 7n, transactionId }] });
    const store = db[WALLET_DATABASE_STATE_STORE](identityFor(account));
    const withoutCoverage = (await store.load())!;
    delete withoutCoverage.historyStartOutputIndex;
    await store.save(withoutCoverage);
    expect(await opened.nativeActivity()).toEqual({ state: "unavailable", reason: "history-not-scanned" });
    const outputs = vi.spyOn(rpc, "getOutputs");
    const recovered = await Promise.all([opened.nativeActivity({ recoverHistory: true }), opened.nativeActivity({ recoverHistory: true })]);
    const recoveredEntry = expect.objectContaining({ state: "ready", entries: [expect.objectContaining({ direction: "received", amount: 7n })] });
    expect(recovered).toEqual([recoveredEntry, recoveredEntry]);
    expect(outputs).toHaveBeenCalledTimes(1);
    await opened.nativeActivity({ recoverHistory: true });
    expect(outputs).toHaveBeenCalledTimes(1);
    expect(await opened.accountActivation()).toBeNull();
    await opened.close();
    const reopened = await Wallet[OPEN_WALLET_INTERNAL]({ database: db, node: rpc, profile: account });
    expect(await reopened.nativeFunds()).toMatchObject({ private: 7n, total: 7n, synchronized: true });
    await reopened.close();
    await db.close();
  });

  it("reports whether a synced account published a receive key", async () => {
    const db = await database();
    const account = profile();
    const sim = chain();
    const registered = `0x${"ab".repeat(20)}`;
    sim.addBlock({ accounts: [{ address: registered, nullifierKeyCommitment: 1n, accountRuleSetCommitment: 7n, accountRevision: 1, receiveKey: account.mlKemPublicKey }] });
    const wallet = await Wallet[OPEN_WALLET_INTERNAL]({ database: db, node: node(sim), profile: account });
    await wallet.sync();
    expect(await wallet.hasReceiveKey(registered.toUpperCase().replace("0X", "0x"))).toBe(true);
    expect(await wallet.hasReceiveKey(`0x${"cd".repeat(20)}`)).toBe(false);
    await wallet.close();
    await db.close();
  });

  it("binds one account and presents an empty typed snapshot", async () => {
    const db = await database();
    const wallet = await Wallet[OPEN_WALLET_INTERNAL]({ database: db, node: node(), profile: profile() });

    expect(await wallet.snapshot()).toMatchObject({
      address: wallet.address,
      network: { chainId: BigInt(CHAIN_ID), genesisHash: GENESIS_HASH },
      syncedThrough: null,
      balances: [{ assetId: 0n, private: 0n, spendable: 0n }],
      ownedNoteCount: 0,
      pendingActionCount: 0,
      pendingPayments: [],
    });

    await wallet.close();
    await db.close();
  });

  it("imports a verified definition and lists assets from definitions and notes", async () => {
    const db = await database();
    const account = profile();
    const definition: AssetDefinition = {
      initialSupply: 700n,
      assetSecretCommitment: 0x92n,
      metadata: { name: "Imported", symbol: "IMP", decimals: 3, contentDigest: new Uint8Array(32).fill(4) },
    };
    const assetId = assetDefinitionAssetId(definition);
    const unknownAssetId = 0x55n;
    const data = emptyWalletState(identityFor(account));
    data.notes = [assetId, unknownAssetId].map((id, index) => ({
      leafIndex: String(index), outputIndex: 0, assetId: `0x${id.toString(16)}`, amount: "25",
      owner: `0x${account.address.toString(16)}`, noteSecret: `0x${(index + 1).toString(16)}`,
      commitment: `0x${(index + 1).toString(16).padStart(64, "0")}`, spent: false, pending: false,
    }));
    await db[WALLET_DATABASE_STATE_STORE](identityFor(account)).save(data);
    const wallet = await Wallet[OPEN_WALLET_INTERNAL]({ database: db, node: node(), profile: account });

    expect(await wallet.importAssetDefinition(`https://pcash.example/token/x#d=${formatAssetDefinition(definition)}`))
      .toEqual({ assetId });
    await expect(wallet.importAssetDefinition({ ...definition, metadata: { ...definition.metadata, decimals: 19 } }))
      .rejects.toThrow(/decimals/);
    const expected = [
      { assetId: unknownAssetId, definition: null, private: 25n, spendable: 25n, created: false },
      { assetId, definition, private: 25n, spendable: 25n, created: false },
    ].sort((a, b) => a.assetId < b.assetId ? -1 : 1);
    expect(await wallet.assets()).toEqual(expected);
    expect((await wallet.snapshot()).assets).toEqual(expected);

    await wallet.close();
    await db.close();
  });

  it("keeps mixed-asset balances and note statuses distinct", async () => {
    const db = await database();
    const account = profile();
    const identity = identityFor(account);
    const data = emptyWalletState(identity);
    const commitment = (index: number) => `0x${index.toString(16).padStart(64, "0")}`;
    const note = (index: number, assetId: bigint, amount: string) => ({
      leafIndex: String(index), outputIndex: index, assetId: `0x${assetId.toString(16)}`, amount,
      owner: `0x${account.address.toString(16)}`, noteSecret: "0x1",
      commitment: commitment(index + 1), spent: false, pending: false,
    });
    data.notes = [
      note(0, 0n, "10"),
      note(1, 0n, "7"),
      note(2, 0n, "5"),
      note(3, 2n, "20"),
      note(4, 2n, "3"),
      { ...note(5, 2n, "4"), leafIndex: null, commitment: null, pending: true,
        pendingContentHash: commitment(9) },
      note(6, 2n, "0"),
      note(7, 3n, "8"),
    ];
    data.notes[2]!.spent = true;
    // A zero note secret is an ordinary spendable note.
    data.notes[4]!.noteSecret = "0x0";
    data.notes[7]!.spent = true;
    data.pendingNoteFundedTransfers = [{
      contentHash: commitment(10), transactionHex: "0x00", notBeforeTimestamp: "0", validUntilTimestamp: "100",
      kind: "payment" as const,
      transferAmount: "1", openFeeAmount: "0", privateRelayFeeAmount: "0", privateRelayRecipient: null,
      issuanceOwnerCommitment: "0", issuanceRecipient: null, recipient: "pcash-extended-receive-code",
      recipientAddress: `0x${"bb".repeat(20)}`,
      inputs: [{ nullifier: commitment(11), spentCommitment: data.notes[1]!.commitment }], change: null,
    }];
    await db[WALLET_DATABASE_STATE_STORE](identity).save(data);
    const wallet = await Wallet[OPEN_WALLET_INTERNAL]({ database: db, node: node(), profile: account });
    const definition: AssetDefinition = {
      initialSupply: 100n, assetSecretCommitment: 0x95n,
      metadata: { name: "Unheld", symbol: "UHD", decimals: 0, contentDigest: new Uint8Array(32).fill(9) },
    };
    const metadataAssetId = (await wallet.importAssetDefinition(definition)).assetId;
    const reservations = vi.spyOn(noteStore, "reservedNoteCommitments");

    expect(await wallet.balances()).toEqual([
      { assetId: 0n, private: 17n, spendable: 10n },
      { assetId: 2n, private: 23n, spendable: 23n },
      { assetId: 3n, private: 0n, spendable: 0n },
    ]);
    expect(reservations).toHaveBeenCalledTimes(1);
    expect(await wallet.balances({ assetId: metadataAssetId })).toEqual([
      { assetId: metadataAssetId, private: 0n, spendable: 0n },
    ]);
    expect(reservations).toHaveBeenCalledTimes(2);
    expect((await wallet.assets()).map(({ assetId, private: balance, spendable }) => ({ assetId, private: balance, spendable })))
      .toEqual([
        { assetId: 2n, private: 23n, spendable: 23n },
        { assetId: 3n, private: 0n, spendable: 0n },
        { assetId: metadataAssetId, private: 0n, spendable: 0n },
      ].sort((a, b) => a.assetId < b.assetId ? -1 : 1));
    expect(reservations).toHaveBeenCalledTimes(3);
    expect((await wallet.notes({ assetId: 2n })).map(({ outputIndex, status }) => ({ outputIndex, status })))
      .toEqual([
        { outputIndex: 3, status: "spendable" },
        { outputIndex: 4, status: "spendable" },
        { outputIndex: 5, status: "pending" },
        { outputIndex: 6, status: "spendable" },
      ]);
    expect(reservations).toHaveBeenCalledTimes(4);
    expect((await wallet.notes({ assetId: 0n })).map(({ outputIndex, status }) => ({ outputIndex, status })))
      .toEqual([
        { outputIndex: 0, status: "spendable" },
        { outputIndex: 1, status: "pending" },
        { outputIndex: 2, status: "spent" },
      ]);
    expect(reservations).toHaveBeenCalledTimes(5);
    reservations.mockRestore();
    await wallet.close();
    await db.close();
  });

  it("summarizes a large mixed-asset inventory with one reservation set per read", async () => {
    const db = await database();
    const account = profile();
    const identity = identityFor(account);
    const data = emptyWalletState(identity);
    data.notes = Array.from({ length: 1_200 }, (_, index) => ({
      leafIndex: String(index), outputIndex: index,
      assetId: `0x${(index % 12 + 1).toString(16)}`, amount: "1",
      owner: `0x${account.address.toString(16)}`, noteSecret: "0x1",
      commitment: `0x${(index + 1).toString(16).padStart(64, "0")}`,
      spent: false, pending: false,
    }));
    await db[WALLET_DATABASE_STATE_STORE](identity).save(data);
    const wallet = await Wallet[OPEN_WALLET_INTERNAL]({ database: db, node: node(), profile: account });
    const reservations = vi.spyOn(noteStore, "reservedNoteCommitments");
    const balances = await wallet.balances();
    expect(balances).toHaveLength(13);
    expect(balances[0]).toEqual({ assetId: 0n, private: 0n, spendable: 0n });
    expect(balances.slice(1)).toEqual(Array.from({ length: 12 }, (_, index) => ({
      assetId: BigInt(index + 1), private: 100n, spendable: 100n,
    })));
    expect(reservations).toHaveBeenCalledTimes(1);
    const selected = await wallet.notes({ assetId: 7n });
    expect(selected).toHaveLength(100);
    expect(selected.map(({ outputIndex }) => outputIndex)).toEqual(
      Array.from({ length: 100 }, (_, index) => 6 + index * 12),
    );
    expect(reservations).toHaveBeenCalledTimes(2);
    reservations.mockRestore();
    await wallet.close();
    await db.close();
  });

  it("presents a pending payment's delivery target separately from its resolved address", async () => {
    const db = await database();
    const account = profile();
    const identity = identityFor(account);
    const data = emptyWalletState(identity);
    data.pendingNoteFundedTransfers = [{
      contentHash: `0x${"aa".repeat(32)}`,
      transactionHex: "0x00",
      notBeforeTimestamp: "0",
      validUntilTimestamp: "100",
      kind: "payment" as const,
      transferAmount: "5",
      openFeeAmount: "1",
      privateRelayFeeAmount: "0",
      privateRelayRecipient: null,
      issuanceOwnerCommitment: "0",
      issuanceRecipient: null,
      recipient: "pcash-extended-receive-code",
      recipientAddress: `0x${"bb".repeat(20)}`,
      data: storeTransactionData({ recipients: [{ to: "pcash-extended-receive-code", records: [memoSchema.encode("rent — March"), claimedSenderSchema.encode(1n)] }] })!,
      inputs: [{
        nullifier: `0x${"cc".repeat(32)}`,
        spentCommitment: `0x${"dd".repeat(32)}`,
      }],
      change: null,
      l1TxHash: `0x${"ee".repeat(32)}`,
    }];
    // Journaled bytes with neither a hash nor mempool admission may still land;
    // "Check status" reads this list to decide whether to prove a new payment.
    data.pendingNoteFundedTransfers.push({ ...data.pendingNoteFundedTransfers[0]!, contentHash: `0x${"ab".repeat(32)}`,
      inputs: [{ nullifier: `0x${"ce".repeat(32)}`, spentCommitment: null }] });
    delete data.pendingNoteFundedTransfers[1]!.l1TxHash;
    delete data.pendingNoteFundedTransfers[1]!.data;
    await db[WALLET_DATABASE_STATE_STORE](identity).save(data);
    const wallet = await Wallet[OPEN_WALLET_INTERNAL]({ database: db, node: node(), profile: account });

    expect((await wallet.snapshot()).pendingPayments).toEqual([expect.objectContaining({
      deliveryTarget: "pcash-extended-receive-code",
      recipientAddress: `0x${"bb".repeat(20)}`,
      data: restoreTransactionData(data.pendingNoteFundedTransfers[0]!.data),
      l1TxHash: `0x${"ee".repeat(32)}`,
    }), expect.objectContaining({ contentHash: `0x${"ab".repeat(32)}`, state: "submission-unknown" })]);
    expect((await wallet.snapshot()).pendingPayments[1]!.l1TxHash).toBeUndefined();
    expect((await wallet.snapshot()).pendingPayments[1]).not.toHaveProperty("data");

    await wallet.close();
    await db.close();
  });

  it("lists setup mining with the hash of the Ethereum transaction that carried it", async () => {
    const db = await database();
    const account = profile();
    const identity = identityFor(account);
    const data = emptyWalletState(identity);
    const miningTransactionHex = "0x0abc";
    const address = `0x${"bb".repeat(20)}`;
    data.pendingNoteFundedTransfers = [{
      contentHash: `0x${"aa".repeat(32)}`, transactionHex: miningTransactionHex, notBeforeTimestamp: "0", validUntilTimestamp: "100",
      kind: "mine" as const, transferAmount: "0", openFeeAmount: "0", privateRelayFeeAmount: "0", privateRelayRecipient: null,
      issuanceOwnerCommitment: "0", issuanceRecipient: null, recipient: address, recipientAddress: address,
      inputs: [{ nullifier: `0x${"cc".repeat(32)}`, spentCommitment: null }], change: null,
    }];
    const creation = {
      contentHash: `0x${"aa".repeat(32)}`, publication: "self" as const, transactionHex: miningTransactionHex, address,
      pcashChainId: "1", pcashGenesisHash: `0x${"01".repeat(32)}`, l1ChainId: "1", inboxAddress: `0x${"02".repeat(20)}`,
      genesisL1Block: "0", genesisL1BlockHash: `0x${"03".repeat(32)}`, ruleSetCommitment: "0", receiveKeyHash: `0x${"04".repeat(32)}`,
      recentPcashBlockNumber: "0", recentPcashBlockHash: `0x${"05".repeat(32)}`, validUntilTimestamp: "100",
      state: "broadcast-requested" as const, l1TxHash: null, preparedAtUnixMs: "0",
    };
    data.pendingUserAccountCreations = [creation];
    const unsent = structuredClone(data);
    const store = db[WALLET_DATABASE_STATE_STORE](identity);
    await store.save(data);
    const wallet = await Wallet[OPEN_WALLET_INTERNAL]({ database: db, node: node(), profile: account });

    // The snapshot is complete; presentation decides what to show before the hash.
    expect((await wallet.snapshot()).pendingPayments).toEqual([expect.objectContaining({ kind: "mine", contentHash: `0x${"aa".repeat(32)}` })]);
    expect((await wallet.snapshot()).pendingPayments[0]!.l1TxHash).toBeUndefined();
    noteStore.markPendingUserAccountCreationSubmitted(data, address, `0x${"06".repeat(32)}`);
    await store.save(data);
    expect((await wallet.snapshot()).pendingPayments).toEqual([expect.objectContaining({
      kind: "mine", contentHash: `0x${"aa".repeat(32)}`, l1TxHash: `0x${"06".repeat(32)}` })]);
    // A broadcast activation leaves its mine to settle on its own nullifiers.
    const completed = structuredClone(data);
    noteStore.removePendingUserAccountCreation(completed, address);
    expect(completed.pendingNoteFundedTransfers).toHaveLength(1);
    // PCASH rejecting the setup returns it to prepared; the transaction still carried the mine.
    noteStore.markPendingUserAccountCreationPrepared(data, address);
    await store.save(data);
    expect((await wallet.snapshot()).pendingPayments).toEqual([expect.objectContaining({ l1TxHash: `0x${"06".repeat(32)}` })]);
    noteStore.removePendingUserAccountCreation(data, address);
    expect(data.pendingNoteFundedTransfers).toHaveLength(1);
    // An activation removed before it reached Ethereum takes its setup mining with it.
    noteStore.removePendingUserAccountCreation(unsent, address);
    expect(unsent.pendingUserAccountCreations).toBeUndefined();
    expect(unsent.pendingNoteFundedTransfers).toBeUndefined();

    await wallet.close();
    await db.close();
  });

  it("recovers a transfer's Ethereum hash from the transport journal when it opens", async () => {
    const db = await database();
    const account = profile();
    const identity = identityFor(account);
    const data = emptyWalletState(identity);
    const transfer = (contentHash: string) => ({
      contentHash, transactionHex: "0x00", notBeforeTimestamp: "0", validUntilTimestamp: "100",
      kind: "payment" as const, transferAmount: "5", openFeeAmount: "1", privateRelayFeeAmount: "0", privateRelayRecipient: null,
      issuanceOwnerCommitment: "0", issuanceRecipient: null, recipient: `0x${"bb".repeat(20)}`, recipientAddress: `0x${"bb".repeat(20)}`,
      inputs: [{ nullifier: contentHash, spentCommitment: null }], change: null,
    });
    const posted = `0x${"a1".repeat(32)}`;
    const ambiguous = `0x${"a2".repeat(32)}`;
    const untouched = `0x${"a3".repeat(32)}`;
    data.pendingNoteFundedTransfers = [transfer(posted), transfer(ambiguous), transfer(untouched)];
    await db[WALLET_DATABASE_STATE_STORE](identity).save(data);
    const hash = `0x${"0f".repeat(32)}`;
    const batch = (selected: string[], transactionHash: string | null) => ({ kind: "batch", selected, transactionHash }) as unknown as RelayJournalEntry;
    const submission: DurableSubmissionAdapter<null, null> = {
      mode: "l1", preflight: async () => null, submit: async () => { throw new Error("not submitted"); },
      l1Recovery: async () => ({
        show: async () => ({ latched: true, entries: [batch([posted], hash), batch([ambiguous], null)] }),
        reconcile: async () => { throw new Error("not reconciled"); },
        resolve: async () => { throw new Error("not resolved"); },
      }),
    };
    const wallet = await Wallet[OPEN_WALLET_INTERNAL]({ database: db, node: node(), profile: account, submission });

    const pending = new Map((await wallet.snapshot()).pendingPayments.map((payment) => [payment.contentHash, payment.l1TxHash]));
    expect(pending).toEqual(new Map([[posted, hash], [ambiguous, undefined], [untouched, undefined]]));

    await wallet.close();
    await db.close();
  });

  it("keeps signing optional and reports the missing capability", async () => {
    const db = await database();
    const wallet = await Wallet[OPEN_WALLET_INTERNAL]({ database: db, node: node(), profile: profile() });
    let contextSpendable = true;

    await wallet.execute(walletAction("test:spendability", (context) => {
      contextSpendable = context.spendable();
    }));

    expect(wallet.spendable()).toBe(false);
    expect(contextSpendable).toBe(false);
    await expect(wallet.send({ to: wallet.address, amount: 1n }))
      .rejects.toMatchObject({ name: "WalletCapabilityError", capability: "signer" });
    await expect(wallet.send({ to: wallet.address, amount: 1n }))
      .rejects.toBeInstanceOf(WalletCapabilityError);

    await wallet.close();
    await db.close();
  });

  it("publishes snapshots and action events without exposing mutable state", async () => {
    const db = await database();
    const wallet = await Wallet[OPEN_WALLET_INTERNAL]({ database: db, node: node(), profile: profile() });
    const events: string[] = [];
    const unsubscribes = [
      wallet.on("snapshot", () => { events.push("snapshot"); }),
      wallet.on("action:started", ({ action }) => { events.push(`action:${action.name}:started`); }),
      wallet.on("action:completed", ({ action }) => { events.push(`action:${action.name}:completed`); }),
    ];

    await wallet.createReceiveKey();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(events).toContain("snapshot");
    expect(events).toContain("action:receive-key:started");
    expect(events).toContain("action:receive-key:completed");
    expect((await wallet.snapshot()).receiveKeys).toHaveLength(2);

    await Promise.all(unsubscribes.map((unsubscribe) => unsubscribe()));
    await wallet.close();
    await db.close();
  });

  it("isolates accounts sharing one PGlite database", async () => {
    const db = await database();
    const firstProfile = profile();
    const secondKey = Uint8Array.from(TEST_PRIV_KEY, (byte, index) => index === 31 ? byte ^ 1 : byte);
    const secondProfile = derivePcashProfileFromPrivateKey(secondKey, {
      pcashChainId: BigInt(CHAIN_ID),
      l1ChainId: 11155111n,
      inboxAddress: INBOX,
    });
    const first = await Wallet[OPEN_WALLET_INTERNAL]({ database: db, node: node(), profile: firstProfile });
    const second = await Wallet[OPEN_WALLET_INTERNAL]({ database: db, node: node(), profile: secondProfile });

    await first.createReceiveKey();

    expect(await first.receiveKeys()).toHaveLength(2);
    expect(await second.receiveKeys()).toHaveLength(0);

    await first.close();
    await second.createReceiveKey();
    expect(await second.receiveKeys()).toHaveLength(2);
    await second.close();
    await db.close();
  });

  it("notifies another Wallet instance after a committed change", async () => {
    const db = await database();
    const writer = await Wallet[OPEN_WALLET_INTERNAL]({ database: db, node: node(), profile: profile() });
    const observer = await Wallet[OPEN_WALLET_INTERNAL]({ database: db, node: node(), profile: profile() });
    let resolveChange!: () => void;
    const changed = new Promise<void>((resolve) => { resolveChange = resolve; });
    const listening = deferred<void>();
    const unsubscribe = observer.on("snapshot", ({ snapshot }) => {
      listening.resolve();
      if (snapshot.receiveKeys.length === 2) resolveChange();
    });

    await listening.promise;
    await writer.createReceiveKey();
    await changed;

    expect(await observer.receiveKeys()).toHaveLength(2);
    await unsubscribe();
    await writer.close();
    await observer.close();
    await db.close();
  });

  it("serializes catch-ups and gives every caller a fresh result", async () => {
    const db = await database();
    const firstStatus = deferred<StatusResult>();
    const statusRequested = deferred<void>();
    let statusCalls = 0;
    const controlledNode = {
      ...node(),
      status: () => {
        if (statusCalls++ === 0) return Promise.resolve(status);
        if (statusCalls === 2) {
          statusRequested.resolve();
          return firstStatus.promise;
        }
        return Promise.resolve(status);
      },
    } as unknown as PcashNodeClient;
    const scanProfile = scanningProfile();
    const wallet = await Wallet[OPEN_WALLET_INTERNAL]({ database: db, node: controlledNode, profile: scanProfile });
    const first = wallet.sync();
    await statusRequested.promise;
    const second = wallet.sync();
    await Promise.resolve();

    expect(statusCalls).toBe(2);
    firstStatus.resolve(status);
    await Promise.all([first, second]);

    expect(statusCalls).toBeGreaterThanOrEqual(3);
    await wallet.close();
    await db.close();
  });

  it("returns a fresh catch-up result after an earlier sync", async () => {
    const db = await database();
    const scanProfile = scanningProfile();
    const sim = chain();
    const identity = identityFor(scanProfile);
    const store = db[WALLET_DATABASE_STATE_STORE](identity);
    const data = emptyWalletState(identity);
    data.syncedThrough = { blockNumber: "0", blockHash: GENESIS_HASH };
    data.finalizedThrough = data.syncedThrough;
    await store.save(data);
    const wallet = await Wallet[OPEN_WALLET_INTERNAL]({ database: db, node: node(sim), profile: scanProfile });

    expect((await wallet.sync()).syncedThrough.pcashNumber).toBe(0n);
    sim.addBlock();

    expect((await wallet.sync()).syncedThrough).toEqual({ pcashNumber: 1n, pcashHash: hashOf(sim.head) });
    await wallet.close();
    await db.close();
  });

  it("retries a required full rescan after an initial failure", async () => {
    const db = await database();
    const scanProfile = scanningProfile();
    let statusCalls = 0;
    const controlledNode = {
      ...node(),
      status: async () => {
        statusCalls += 1;
        if (statusCalls === 2) throw new Error("transient sync failure");
        return status;
      },
    } as unknown as PcashNodeClient;
    const identity = identityFor(scanProfile);
    const store = db[WALLET_DATABASE_STATE_STORE](identity);
    await store.save(stateWithOneNote(identity));
    const wallet = await Wallet[OPEN_WALLET_INTERNAL]({ database: db, node: controlledNode, profile: scanProfile });
    const recovered = deferred<void>();
    const unsubscribeCompleted = wallet.on("sync:completed", () => {
      if (statusCalls > 2) recovered.resolve();
    });
    const unsubscribeError = wallet.on("sync:error", ({ error }) => {
      if (statusCalls > 2) recovered.reject(error);
    });

    wallet.startSync({ intervalMs: 1, rescan: true });
    await recovered.promise;

    expect(statusCalls).toBeGreaterThan(2);
    expect((await store.load())?.notes).toEqual([]);
    await Promise.all([unsubscribeCompleted(), unsubscribeError()]);
    await wallet.close();
    await db.close();
  });

  it("does not emit sync:error for a transient cross-instance sync conflict", async () => {
    const db = await database();
    const scanProfile = scanningProfile();
    const identity = identityFor(scanProfile);
    const store = db[WALLET_DATABASE_STATE_STORE](identity);
    const data = emptyWalletState(identity);
    data.syncedThrough = { blockNumber: "0", blockHash: GENESIS_HASH };
    data.finalizedThrough = data.syncedThrough;
    await store.save(data);
    const active = await acquireWalletReservation(store, [WALLET_SYNC_RESOURCE], { ttlMs: 100 });
    const wallet = await Wallet[OPEN_WALLET_INTERNAL]({ database: db, node: node(), profile: scanProfile });
    const events: string[] = [];
    const unsubscribeStarted = wallet.on("sync:started", () => { events.push("started"); });
    const unsubscribeCompleted = wallet.on("sync:completed", () => { events.push("completed"); });
    const unsubscribeError = wallet.on("sync:error", () => { events.push("error"); });

    await wallet.sync();

    expect(events).toEqual(["started", "completed"]);
    await Promise.all([unsubscribeStarted(), unsubscribeCompleted(), unsubscribeError()]);
    await active.release();
    await wallet.close();
    await db.close();
  });

  it("honors a durable full-replay requirement after reopening", async () => {
    const db = await database();
    const scanProfile = scanningProfile();
    const identity = identityFor(scanProfile);
    const store = db[WALLET_DATABASE_STATE_STORE](identity);
    const data = stateWithOneNote(identity);
    data.fullRescanRequired = true;
    await store.save(data);

    const wallet = await Wallet[OPEN_WALLET_INTERNAL]({ database: db, node: node(), profile: scanProfile });
    await wallet.sync();

    expect((await store.load())?.notes).toEqual([]);
    expect((await store.load())?.fullRescanRequired).toBeUndefined();
    await wallet.close();
    await db.close();
  });

  it("retries a full replay after a receive key persists and its rescan fails", async () => {
    const db = await database();
    const scanProfile = scanningProfile();
    const followerReady = deferred<void>();
    const recovered = deferred<void>();
    let statusCalls = 0;
    let pageCalls = 0;
    let failPage = false;
    const base = node();
    const controlledNode = {
      ...base,
      status: async () => {
        statusCalls += 1;
        if (statusCalls >= 4) followerReady.resolve();
        return status;
      },
      getOutputs: async (request: Parameters<PcashNodeClient["getOutputs"]>[0]) => {
        pageCalls += 1;
        if (failPage) {
          failPage = false;
          throw new Error("transient rescan failure");
        }
        return base.getOutputs(request);
      },
    } as unknown as PcashNodeClient;
    const identity = identityFor(scanProfile);
    const store = db[WALLET_DATABASE_STATE_STORE](identity);
    await store.save(stateWithOneNote(identity));
    const wallet = await Wallet[OPEN_WALLET_INTERNAL]({ database: db, node: controlledNode, profile: scanProfile });
    const unsubscribe = wallet.on("sync:completed", () => {
      if (pageCalls >= 2) recovered.resolve();
    });

    wallet.startSync({ intervalMs: 1 });
    await followerReady.promise;
    await wallet.stopSync();
    failPage = true;
    await expect(wallet.createReceiveKey()).rejects.toThrow("transient rescan failure");
    wallet.startSync({ intervalMs: 1 });
    await recovered.promise;

    expect(pageCalls).toBeGreaterThanOrEqual(2);
    expect((await store.load())?.notes).toEqual([]);
    await unsubscribe();
    await wallet.close();
    await db.close();
  });

  it("drains a public read before releasing the final database lease", async () => {
    const db = await database();
    const identity = {
      address: profile().address,
      network: { chainId: BigInt(CHAIN_ID), genesisHash: GENESIS_HASH },
    };
    const backingStore = db[WALLET_DATABASE_STATE_STORE](identity);
    const loadStarted = deferred<void>();
    const finishLoad = deferred<void>();
    let holdLoads = false;
    const store: WalletStateStore = {
      ...backingStore,
      async load() {
        if (holdLoads) {
          loadStarted.resolve();
          await finishLoad.promise;
        }
        return backingStore.load();
      },
    };
    let releases = 0;
    const facade = {
      [WALLET_DATABASE_STATE_STORE]: () => store,
      subscribe: db.subscribe.bind(db),
    } as unknown as WalletDatabase;
    const wallet = await Wallet[OPEN_WALLET_INTERNAL]({
      database: facade,
      node: node(),
      profile: profile(),
      releaseDatabase: async () => { releases += 1; },
    });

    holdLoads = true;
    const reading = wallet.snapshot();
    await loadStarted.promise;
    const closing = wallet.close();
    await Promise.resolve();
    expect(releases).toBe(0);

    holdLoads = false;
    finishLoad.resolve();
    await reading;
    await closing;
    expect(releases).toBe(1);
    await db.close();
  });

  it("releases the leased database when the wallet fails to open", async () => {
    const db = await database();
    let releases = 0;
    const unreachable = { ...node(), status: async () => { throw new Error("node unreachable"); } } as unknown as PcashNodeClient;

    await expect(Wallet[OPEN_WALLET_INTERNAL]({
      database: db,
      node: unreachable,
      profile: profile(),
      releaseDatabase: async () => { releases += 1; },
    })).rejects.toThrow("node unreachable");

    expect(releases).toBe(1);
    await db.close();
  });

  it("drains a notification snapshot before releasing the final database lease", async () => {
    const db = await database();
    const identity = {
      address: profile().address,
      network: { chainId: BigInt(CHAIN_ID), genesisHash: GENESIS_HASH },
    };
    const backingStore = db[WALLET_DATABASE_STATE_STORE](identity);
    const loadStarted = deferred<void>();
    const finishLoad = deferred<void>();
    let holdLoads = false;
    const store: WalletStateStore = {
      ...backingStore,
      async load() {
        if (holdLoads) {
          loadStarted.resolve();
          await finishLoad.promise;
        }
        return backingStore.load();
      },
    };
    let notify: () => void = () => undefined;
    const subscriptionReady = deferred<void>();
    let releases = 0;
    const facade = {
      [WALLET_DATABASE_STATE_STORE]: () => store,
      subscribe: async (_identity: unknown, listener: () => void) => {
        notify = listener;
        subscriptionReady.resolve();
        return async () => undefined;
      },
    } as unknown as WalletDatabase;
    const wallet = await Wallet[OPEN_WALLET_INTERNAL]({
      database: facade,
      node: node(),
      profile: profile(),
      releaseDatabase: async () => { releases += 1; },
    });
    const unsubscribe = wallet.on("snapshot", () => undefined);
    await subscriptionReady.promise;

    holdLoads = true;
    notify();
    await loadStarted.promise;
    const closing = wallet.close();
    await Promise.resolve();
    expect(releases).toBe(0);

    holdLoads = false;
    finishLoad.resolve();
    await closing;
    expect(releases).toBe(1);
    await unsubscribe();
    await db.close();
  });

  it("drains a child operation started by an admitted action during close", async () => {
    const db = await database();
    const identity = {
      address: profile().address,
      network: { chainId: BigInt(CHAIN_ID), genesisHash: GENESIS_HASH },
    };
    const backingStore = db[WALLET_DATABASE_STATE_STORE](identity);
    const actionStarted = deferred<void>();
    const startChild = deferred<void>();
    const childStarted = deferred<void>();
    const finishChild = deferred<void>();
    let holdLoads = false;
    const store: WalletStateStore = {
      ...backingStore,
      async load() {
        if (holdLoads) {
          childStarted.resolve();
          await finishChild.promise;
        }
        return backingStore.load();
      },
    };
    let releases = 0;
    const facade = {
      [WALLET_DATABASE_STATE_STORE]: () => store,
      subscribe: db.subscribe.bind(db),
    } as unknown as WalletDatabase;
    const wallet = await Wallet[OPEN_WALLET_INTERNAL]({
      database: facade,
      node: node(),
      profile: profile(),
      releaseDatabase: async () => { releases += 1; },
    });

    let child!: Promise<WalletFileData | null>;
    const action = wallet.execute(walletAction("test:late-child", async (context) => {
      actionStarted.resolve();
      await startChild.promise;
      holdLoads = true;
      child = context.store.load();
    }));
    await actionStarted.promise;
    const closing = wallet.close();
    await Promise.resolve();
    startChild.resolve();
    await childStarted.promise;
    await action;
    expect(releases).toBe(0);

    holdLoads = false;
    finishChild.resolve();
    await child;
    await closing;
    expect(releases).toBe(1);
    await db.close();
  });

  it("blocks new work at close start, reuses the close promise, and drains active actions", async () => {
    const db = await database();
    const identity = {
      address: profile().address,
      network: { chainId: BigInt(CHAIN_ID), genesisHash: GENESIS_HASH },
    };
    const backingStore = db[WALLET_DATABASE_STATE_STORE](identity);
    const transactionStarted = deferred<void>();
    const releaseTransaction = deferred<void>();
    let holdTransactions = false;
    const store: WalletStateStore = {
      ...backingStore,
      async transaction<T>(
        operation: (current: WalletFileData | null) => WalletStateCommit<T>,
      ): Promise<T> {
        if (holdTransactions) {
          transactionStarted.resolve();
          await releaseTransaction.promise;
        }
        return backingStore.transaction(operation);
      },
    };
    let databaseCloses = 0;
    const facade = {
      [WALLET_DATABASE_STATE_STORE]: () => store,
      subscribe: db.subscribe.bind(db),
      close: async () => { databaseCloses += 1; },
    } as unknown as WalletDatabase;
    const wallet = await Wallet[OPEN_WALLET_INTERNAL]({
      database: facade,
      node: node(),
      profile: profile(),
      releaseDatabase: async () => { databaseCloses += 1; },
    });

    holdTransactions = true;
    const action = wallet.createReceiveKey();
    await transactionStarted.promise;
    const closing = wallet.close();
    const concurrentClose = wallet.close();

    expect(concurrentClose).toBe(closing);
    expect(databaseCloses).toBe(0);
    expect(() => wallet.on("snapshot", () => undefined)).toThrow("wallet is closed");
    expect(() => wallet.startSync()).toThrow("wallet is closed");

    holdTransactions = false;
    releaseTransaction.resolve();
    await action;
    await closing;
    expect(databaseCloses).toBe(1);
    await db.close();
  });

  it("rescans under sync({ awaitFunds: true }) until funds synchronize, then fails with the catch-up error", async () => {
    const db = await database();
    const scanProfile = scanningProfile();
    const identity = identityFor(scanProfile);
    const store = db[WALLET_DATABASE_STATE_STORE](identity);
    const data = emptyWalletState(identity);
    data.syncedThrough = { blockNumber: "0", blockHash: GENESIS_HASH };
    data.finalizedThrough = data.syncedThrough;
    await store.save(data);
    const wallet = await Wallet[OPEN_WALLET_INTERNAL]({ database: db, node: node(), profile: scanProfile });

    let synchronized = false;
    let nativeFundsCalls = 0;
    let scans = 0;
    (wallet as { nativeFunds(): Promise<unknown> }).nativeFunds = async () => {
      nativeFundsCalls += 1;
      return { synchronized };
    };
    const unsubscribeCompleted = wallet.on("sync:completed", () => { scans += 1; });

    // Funds already synchronized: exactly one scan and one probe.
    synchronized = true;
    await wallet.sync({ awaitFunds: true });
    expect(scans).toBe(1);
    expect(nativeFundsCalls).toBe(1);

    // Two extra scans are attempted before the catch-up is declared failed.
    synchronized = false;
    scans = 0;
    await expect(wallet.sync({ awaitFunds: true })).rejects.toThrow(
      "Wallet balance could not catch up to the current PCASH block.",
    );
    expect(scans).toBe(3);

    // Without awaitFunds a plain sync performs no funds probing at all.
    nativeFundsCalls = 0;
    await wallet.sync();
    expect(nativeFundsCalls).toBe(0);

    await unsubscribeCompleted();
    await wallet.close();
    await db.close();
  });

  it("anchors only the first awaitFunds scan and returns the latest catch-up report", async () => {
    const db = await database();
    const scanProfile = scanningProfile();
    const identity = identityFor(scanProfile);
    await db[WALLET_DATABASE_STATE_STORE](identity).save(emptyWalletState(identity));
    const sim = chain();
    const wallet = await Wallet[OPEN_WALLET_INTERNAL]({ database: db, node: node(sim), profile: scanProfile });
    const reports: bigint[] = [];
    const unsubscribe = wallet.on("sync:completed", ({ syncedThrough }) => {
      reports.push(syncedThrough.pcashNumber);
      if (sim.head.number < 2n) sim.addBlock();
    });
    (wallet as { nativeFunds(): Promise<unknown> }).nativeFunds = async () => ({
      synchronized: reports.length >= 3,
    });

    const result = await wallet.sync({ anchorAtCurrentBoundary: true, awaitFunds: true });

    expect(reports).toEqual([0n, 1n, 2n]);
    expect(result.syncedThrough).toEqual({ pcashNumber: 2n, pcashHash: hashOf(sim.block(2n)) });
    expect(sim.calls.filter((call) => call.method === "getOutputFrontier")).toHaveLength(1);
    await unsubscribe();
    await wallet.close();
    await db.close();
  });

  it("passes the complete reviewed payment state into the reserved send operation", async () => {
    const db = await database();
    const account = profile();
    const wallet = await Wallet[OPEN_WALLET_INTERNAL]({
      database: db,
      node: node(),
      profile: account,
      signer: privateKeyPcashActionSigner(TEST_PRIV_KEY),
    });
    const reviewedPreflight = {
      openFeeAmount: 1n,
      privateRelayFeeAmount: 0n,
      privateRelayRecipient: null,
      beneficiary: { kind: "publisher" as const },
      publication: "open" as const,
      inputCount: 2,
      inputTotal: 12n,
      retry: false,
    };
    const preflight = vi.spyOn(wallet, "preflightSend").mockResolvedValue(reviewedPreflight);
    const intent = { to: wallet.address, amount: 5n };

    await expect(wallet.send(intent, reviewedPreflight)).rejects.toBeInstanceOf(WalletCapabilityError);
    expect(preflight).not.toHaveBeenCalled();

    await expect(wallet.send(intent)).rejects.toBeInstanceOf(WalletCapabilityError);
    expect(preflight).not.toHaveBeenCalled();

    preflight.mockRestore();
    await wallet.close();
    await db.close();
  });
});

describe("native consolidation fee", () => {
  const PCASH = 10n ** 18n;
  const STANDARD_FEE = PCASH / 100n;

  function stateWithNotes(identity: Parameters<typeof emptyWalletState>[0], amounts: readonly bigint[]): WalletFileData {
    const data = stateWithOneNote(identity);
    const [template] = data.notes;
    data.notes = amounts.map((amount, index) => ({
      ...template!,
      leafIndex: index.toString(),
      outputIndex: index,
      amount: amount.toString(),
      noteSecret: `0x${(index + 1).toString(16)}`,
      commitment: `0x${(0x80 + index).toString(16).repeat(32)}`,
      cursor: { ...template!.cursor!, outputIndex: index.toString() },
    }));
    return data;
  }

  async function fivePcashWallet() {
    const db = await database();
    const account = profile();
    const estimates: bigint[] = [];
    const feeNode = {
      ...node(),
      estimateFee: async (query: { byteSize: bigint }) => {
        estimates.push(query.byteSize);
        return { tiers: { low: STANDARD_FEE / 2n, standard: STANDARD_FEE, fast: STANDARD_FEE * 2n } };
      },
    } as unknown as PcashNodeClient;
    const identity = identityFor(scanningProfile());
    await db[WALLET_DATABASE_STATE_STORE](identity).save(stateWithNotes(identity, Array(5).fill(PCASH)));
    const wallet = await Wallet[OPEN_WALLET_INTERNAL]({
      database: db, node: feeNode, profile: account, signer: privateKeyPcashActionSigner(TEST_PRIV_KEY),
    });
    const close = async () => { await wallet.close(); await db.close(); };
    return { wallet, estimates, close };
  }
  const adapter = (mode: "mempool" | "l1") => ({
    mode,
    preflight: async () => { throw new Error("no merge is submitted"); },
    submit: async () => { throw new Error("no merge is submitted"); },
  }) as DurableSubmissionAdapter;

  it("plans an omitted relayed fee using the standard estimate", async () => {
    const { wallet, estimates, close } = await fivePcashWallet();
    const options = { amount: 5n * PCASH, submission: adapter("mempool") };
    const preview = await wallet.planConsolidation(options);
    expect(preview).toMatchObject({
      feePerTransaction: STANDARD_FEE, estimatedFees: STANDARD_FEE, maximumSpendableAfter: 5n * PCASH - STANDARD_FEE, canCover: false,
    });
    expect(estimates).toHaveLength(1);
    await close();
  });

  it("keeps explicit zero and charges no PCASH fee for self consolidation", async () => {
    const { wallet, estimates, close } = await fivePcashWallet();
    expect(await wallet.planConsolidation({ amount: 5n * PCASH, openFeeAmount: 0n, submission: adapter("mempool") })).toMatchObject({
      feePerTransaction: 0n, maximumSpendableAfter: 5n * PCASH, canCover: true, issuanceNotePerTransaction: false,
    });
    expect(await wallet.planConsolidation({ amount: 5n * PCASH, submission: adapter("l1") })).toMatchObject({
      feePerTransaction: 0n, maximumSpendableAfter: 5n * PCASH, canCover: true, issuanceNotePerTransaction: true,
    });
    expect(estimates).toHaveLength(0);
    await close();
  });
});


it.each(["send", "burn"] as const)("synchronizes a self-published asset %s before reporting settlement", async (action) => {
  const db = await database();
  const sim = chain();
  const account = profile();
  const definition: AssetDefinition = {
    initialSupply: 100n, assetSecretCommitment: 0x72n,
    metadata: { name: "Settlement Token", symbol: "SET", decimals: 0, contentDigest: new Uint8Array(32) },
  };
  const assetId = assetDefinitionAssetId(definition);
  const rules = defaultUserAccountRuleSet({ wallet: account, secrets: account.defaultUserRuleSecrets,
    network: { pcashChainId: BigInt(CHAIN_ID), l1ChainId: sim.l1ChainId, inboxAddress: sim.inboxAddress } });
  sim.addBlock({
    accounts: [{ address: `0x${account.address.toString(16).padStart(40, "0")}`,
      nullifierKeyCommitment: account.nullifierKeyCommitment, accountRuleSetCommitment: rules.accountRuleSetCommitment,
      receiveKey: account.mlKemPublicKey }],
    transactions: [{ outputs: [{ owner: account.address, receiveKey: account.mlKemPublicKey, assetId, amount: 100n }] }],
  });
  const wallet = await Wallet[OPEN_WALLET_INTERNAL]({
    database: db, node: node(sim), profile: account, signer: privateKeyPcashActionSigner(TEST_PRIV_KEY),
    settlePollIntervalMs: 1, settlePollMaxAttempts: 2,
    submission: { mode: "l1", preflight: async () => null, submit: async ({ transactionBytes }) => {
      sim.include(transactionBytes);
      return { accepted: true, queued: false, output: null };
    } },
    provers: { assetAction: { shapes: [0], proveAndEncode: async build => build.encodeTransaction(new Uint8Array(WIRE_PROOF_BYTES)) } },
  });
  try {
    await wallet.importAssetDefinition(definition);
    const result = action === "send"
      ? await wallet.sendAsset({ assetId, outputs: [{ to: wallet.address, amount: 25n }], openFeeAmount: 0n })
      : await wallet.burnAsset({ assetId, amount: 25n, openFeeAmount: 0n });
    expect(result).toMatchObject({ accepted: true, settled: true });
    expect((await wallet.snapshot()).pendingActionCount).toBe(0);
    expect((await wallet.assets()).find(asset => asset.assetId === assetId)?.private).toBe(action === "send" ? 100n : 75n);
  } finally {
    await wallet.close();
    await db.close();
  }
});

it("captures reviewed and published data before wallet synchronization", async () => {
  const db = await database();
  const sim = chain();
  const account = profile();
  const rules = defaultUserAccountRuleSet({ wallet: account, secrets: account.defaultUserRuleSecrets,
    network: { pcashChainId: BigInt(CHAIN_ID), l1ChainId: sim.l1ChainId, inboxAddress: sim.inboxAddress } });
  sim.addBlock({ accounts: [{ address: `0x${account.address.toString(16).padStart(40, "0")}`,
    nullifierKeyCommitment: account.nullifierKeyCommitment, accountRuleSetCommitment: rules.accountRuleSetCommitment,
    receiveKey: account.mlKemPublicKey }] });
  const wallet = await Wallet[OPEN_WALLET_INTERNAL]({
    database: db, node: node(sim), profile: account, signer: privateKeyPcashActionSigner(TEST_PRIV_KEY),
    submission: { mode: "mempool", preflight: async () => null,
      submit: async () => ({ accepted: false, queued: true, output: null }) },
    provers: { privateValue: { proveAndEncode: async build => encodePrivateValueTransaction({
      shape: build.shape, publicInputs: build.publicInputs, proof: new Uint8Array(WIRE_PROOF_BYTES),
      outputData: build.outputData, arena: build.arena,
    }) } },
  });
  try {
    const data = { self: [memoSchema.encode("A")] };
    const reviewPromise = wallet.preflightSend({ to: wallet.address, amount: 0n, openFeeAmount: 0n, data });
    data.self[0]!.data[0] = 0x42;
    const review = await reviewPromise;
    expect(review.dataHash).toBe(transactionDataHash({ self: [memoSchema.encode("A")] }));
    data.self[0]!.data[0] = 0x41;
    const operation = wallet.publishData({ openFeeAmount: 0n, data }, review);
    data.self[0]!.data[0] = 0x43;
    await operation;
    expect((await wallet.snapshot()).pendingPayments[0]?.data?.self).toEqual([memoSchema.encode("A")]);
  } finally {
    await wallet.close();
    await db.close();
  }
});

it("mines without authorization and retries the exact journaled action", async () => {
  const db = await database();
  const account = profile();
  const signer = { address: privateKeyPcashActionSigner(TEST_PRIV_KEY).address,
    signTypedData: vi.fn(async () => { throw new Error("mining must not request a signature"); }) };
  const proveAndEncode = vi.fn<NoteFundedProver["proveAndEncode"]>(async build =>
    encodePrivateValueTransaction({ shape: build.shape, publicInputs: build.publicInputs,
      proof: new Uint8Array(WIRE_PROOF_BYTES), outputData: build.outputData, arena: build.arena }));
  const entries: Uint8Array[] = [];
  const submission: DurableSubmissionAdapter<null, null> = {
    mode: "l1", preflight: async () => null,
    submit: async ({ transactionBytes: entry }) => {
      entries.push(entry);
      return { accepted: false, queued: true, l1Hash: `0x${entries.length.toString(16).padStart(64, "0")}`, output: null };
    },
  };
  const sim = chain();
  const wallet = await Wallet[OPEN_WALLET_INTERNAL]({ database: db, node: node(sim), profile: account,
    signer, submission, provers: { privateValue: { proveAndEncode } } });
  const widerIntent = { newAction: true, noteSelector: "not-a-note", privateRelayFeeAmount: 1n,
    issuanceOwnerCommitment: 123n, amount: 5n, shape: 2 };
  const review = await wallet.preflightMine(widerIntent);
  expect(review).toMatchObject({ inputCount: 0, inputTotal: 0n, openFeeAmount: 0n, privateRelayFeeAmount: 0n,
    publication: "self", beneficiary: { kind: "self" } });
  const first = await wallet.mine(widerIntent, review);
  const second = await wallet.mine({ newAction: true });
  expect(second.contentHash).not.toBe(first.contentHash);
  expect(proveAndEncode).toHaveBeenCalledTimes(2);
  expect(proveAndEncode.mock.calls[0]![0]).toMatchObject({ authorizationCircuit: "account_rule_mine" });
  expect(proveAndEncode.mock.calls[0]![0].authorizationRequest).toBeUndefined();
  expect(signer.signTypedData).not.toHaveBeenCalled();
  const pending = (await wallet.snapshot()).pendingPayments;
  expect(pending).toHaveLength(2);
  expect(pending.every(action => action.kind === "mine" && action.amount === 0n)).toBe(true);
  const retryReview = await wallet.preflightMine({ retryContentHash: first.contentHash });
  expect(retryReview.retry).toBe(true);
  await wallet.mine({ retryContentHash: first.contentHash }, retryReview);
  expect(proveAndEncode).toHaveBeenCalledTimes(2);
  expect(entries[2]).toEqual(entries[0]);
  sim.addBlock({ accounts: [{ address: wallet.address, nullifierKeyCommitment: account.nullifierKeyCommitment,
    accountRuleSetCommitment: 123n, accountRevision: 7, receiveKey: null }] });
  const registeredReview = await wallet.preflightMine({ newAction: true });
  await wallet.mine({ newAction: true }, registeredReview);
  expect(proveAndEncode).toHaveBeenCalledTimes(3);
  expect(signer.signTypedData).not.toHaveBeenCalled();
  await expect(wallet.preflightSend({ to: wallet.address, amount: 0n, retryContentHash: first.contentHash }))
    .rejects.toThrow(/does not match/);
  await expect(wallet.preflightMine({ submission: { mode: "mempool" } }))
    .rejects.toThrow("Mining requires self-publication on L1.");
  await wallet.close();
  await db.close();
});


function batchNode(sim: ChainSim): PcashNodeClient {
  const client = node(sim);
  client.getBlockByHash = async hash => hash.toLowerCase() === sim.status().latestBlockHash.toLowerCase()
    ? { number: sim.status().latestBlock, hash, parentHash: hash,
      timestamp: sim.status().latestBlockTimestamp, transactionResultsRoot: hash, stateRoot: hash,
      l1OriginRoot: hash, historyRoot: hash, transactionResultCount: 0n,
      transactionResults: [], transactionBytes: null,
      l1Origin: { blockNumber: 0n, blockHash: hash, blockTimestamp: sim.status().latestBlockTimestamp,
        l1LogsRoot: hash, l1LogCount: 0n } } : null;
  return client;
}

it("prepares three distinct mines before journaling and submits them once", async () => {
  const db = await database();
  const sim = chain();
  const account = profile();
  const proveAndEncode = vi.fn<NoteFundedProver["proveAndEncode"]>(async build => {
    expect((await db[WALLET_DATABASE_STATE_STORE](identityFor(account)).load())?.pendingNoteFundedTransfers ?? []).toHaveLength(0);
    return encodePrivateValueTransaction({ shape: build.shape, publicInputs: build.publicInputs,
      proof: new Uint8Array(WIRE_PROOF_BYTES), outputData: build.outputData, arena: build.arena });
  });
  const preflight = vi.fn(async ({ additionalTransactions }: Parameters<DurableSubmissionAdapter["preflight"]>[0]) => {
    expect(additionalTransactions).toHaveLength(2);
    expect((await db[WALLET_DATABASE_STATE_STORE](identityFor(account)).load())?.pendingNoteFundedTransfers ?? []).toHaveLength(0);
    return null;
  });
  const submit = vi.fn(async ({ onL1Submitted }: Parameters<DurableSubmissionAdapter<null, null>["submit"]>[0]) => {
    // Journaled before the wallet prompt, and in the snapshot without a hash until it returns one.
    const journaled = (await wallet.snapshot()).pendingPayments;
    expect(journaled).toHaveLength(3);
    expect(journaled.every((item) => item.l1TxHash === undefined)).toBe(true);
    await onL1Submitted?.(`0x${"ab".repeat(32)}`);
    return { accepted: false, queued: true, output: null };
  });
  const wallet = await Wallet[OPEN_WALLET_INTERNAL]({ database: db, node: batchNode(sim), profile: account,
    signer: privateKeyPcashActionSigner(TEST_PRIV_KEY), submission: { mode: "l1", preflight, submit },
    provers: { privateValue: { proveAndEncode } } });
  const result = await wallet.mineBatch({ count: 3, nowUnixMilliseconds: () => Number(sim.status().latestBlockTimestamp * 1000n) });
  expect(new Set(result.ownedContentHashes).size).toBe(3);
  expect(submit).toHaveBeenCalledTimes(1);
  expect(preflight).toHaveBeenCalledTimes(1);
  expect(proveAndEncode).toHaveBeenCalledTimes(3);
  const pending = (await wallet.snapshot()).pendingPayments;
  expect(pending).toHaveLength(3);
  expect(pending.every(item => item.kind === "mine" && item.l1TxHash === `0x${"ab".repeat(32)}`)).toBe(true);
  await wallet.close();
  await db.close();
});

it("relay-only batches do not prove or journal wallet mines", async () => {
  const db = await database();
  const submit = vi.fn(async ({  }: Parameters<DurableSubmissionAdapter<null, null>["submit"]>[0]) =>
    ({ accepted: false, queued: true, output: null }));
  const wallet = await Wallet[OPEN_WALLET_INTERNAL]({ database: db, node: node(), profile: profile(),
    signer: privateKeyPcashActionSigner(TEST_PRIV_KEY), submission: { mode: "l1", preflight: async () => null, submit } });
  const entries = [Uint8Array.of(0, 2, 3)];
  const result = await wallet.mineBatch({ count: 0, relayEntries: entries });
  expect(result.ownedContentHashes).toEqual([]);
  expect(submit).toHaveBeenCalledTimes(1);
  expect((await wallet.snapshot()).pendingPayments).toHaveLength(0);
  await expect(wallet.mineBatch({ count: 0 })).rejects.toThrow("No transactions available");
  await wallet.close();
  await db.close();
});


it("relay-only batches refuse a direct account creation from the node's mempool", async () => {
  const db = await database();
  const preflight = vi.fn(async () => null);
  const submit = vi.fn(async ({  }: Parameters<DurableSubmissionAdapter<null, null>["submit"]>[0]) =>
    ({ accepted: false, queued: true, output: null }));
  const wallet = await Wallet[OPEN_WALLET_INTERNAL]({ database: db, node: node(), profile: profile(),
    signer: privateKeyPcashActionSigner(TEST_PRIV_KEY), submission: { mode: "l1", preflight, submit } });
  // The node's own account, which would register at this wallet's L1 sender.
  const nodeAccount = derivePcashProfileFromPrivateKey(new Uint8Array(32).fill(0x42), {
    pcashChainId: BigInt(CHAIN_ID), l1ChainId: 11155111n, inboxAddress: INBOX,
  });
  const directCreation = encodeUserAccountCreation(BigInt(CHAIN_ID), buildDirectReferenceUserAccountCreation({
    chainId: BigInt(CHAIN_ID), wallet: nodeAccount, defaultRuleSecrets: nodeAccount.defaultUserRuleSecrets,
    recentPcashBlockHash: BigInt(GENESIS_HASH), validUntilTimestamp: status.latestBlockTimestamp + 1_800n,
  }).body);
  await expect(wallet.mineBatch({ count: 0, relayEntries: [Uint8Array.of(0, 2, 3), directCreation] }))
    .rejects.toThrow(/dedicated owner L1 submission/);
  expect(preflight).not.toHaveBeenCalled();
  expect(submit).not.toHaveBeenCalled();
  await wallet.close();
  await db.close();
});

it.each([false, true])("rolls back only definite failed mine batches (ambiguous=%s)", async ambiguous => {
  const db = await database();
  const sim = chain();
  const failure = new Error("submission failed");
  const submission: DurableSubmissionAdapter<null, null> = {
    mode: "l1", preflight: async () => null,
    submit: async () => { throw failure; },
    isDefinitePreBroadcastError: () => !ambiguous,
  };
  const wallet = await Wallet[OPEN_WALLET_INTERNAL]({ database: db, node: batchNode(sim), profile: profile(),
    signer: privateKeyPcashActionSigner(TEST_PRIV_KEY), submission,
    provers: { privateValue: { proveAndEncode: async build =>
      encodePrivateValueTransaction({ shape: build.shape, publicInputs: build.publicInputs,
        proof: new Uint8Array(WIRE_PROOF_BYTES), outputData: build.outputData, arena: build.arena }) } } });
  await expect(wallet.mineBatch({ count: 2, nowUnixMilliseconds: () => Number(sim.status().latestBlockTimestamp * 1000n) })).rejects.toThrow("submission failed");
  expect((await wallet.snapshot()).pendingPayments).toHaveLength(ambiguous ? 2 : 0);
  await wallet.close();
  await db.close();
});

it("refuses stale mining proofs before asking for Ethereum publication", async () => {
  const db = await database();
  const sim = chain();
  const submit = vi.fn(async ({  }: Parameters<DurableSubmissionAdapter<null, null>["submit"]>[0]) =>
    ({ accepted: false, queued: true, output: null }));
  const wallet = await Wallet[OPEN_WALLET_INTERNAL]({ database: db, node: batchNode(sim), profile: profile(),
    signer: privateKeyPcashActionSigner(TEST_PRIV_KEY), submission: { mode: "l1", preflight: async () => null, submit },
    provers: { privateValue: { proveAndEncode: async build =>
      encodePrivateValueTransaction({ shape: build.shape, publicInputs: build.publicInputs,
        proof: new Uint8Array(WIRE_PROOF_BYTES), outputData: build.outputData, arena: build.arena }) } } });
  await expect(wallet.mineBatch({ count: 1, nowUnixMilliseconds: () => Number((sim.status().latestBlockTimestamp + 4000n) * 1000n) })).rejects.toThrow("Mining proofs expired");
  expect(submit).not.toHaveBeenCalled();
  expect((await wallet.snapshot()).pendingPayments).toHaveLength(0);
  await wallet.close();
  await db.close();
});


it("cancels a mine batch while checking freshness without broadcasting or retaining mines", async () => {
  const db = await database();
  const sim = chain();
  const controller = new AbortController();
  const client = batchNode(sim);
  const getBlockByHash = client.getBlockByHash;
  client.getBlockByHash = async hash => {
    const result = await getBlockByHash(hash);
    controller.abort();
    return result;
  };
  const submit = vi.fn(async ({  }: Parameters<DurableSubmissionAdapter<null, null>["submit"]>[0]) =>
    ({ accepted: false, queued: true, output: null }));
  const wallet = await Wallet[OPEN_WALLET_INTERNAL]({ database: db, node: client, profile: profile(),
    signer: privateKeyPcashActionSigner(TEST_PRIV_KEY), submission: { mode: "l1", preflight: async () => null, submit },
    provers: { privateValue: { proveAndEncode: async build =>
      encodePrivateValueTransaction({ shape: build.shape, publicInputs: build.publicInputs,
        proof: new Uint8Array(WIRE_PROOF_BYTES), outputData: build.outputData, arena: build.arena }) } } });
  await expect(wallet.mineBatch({ count: 1, signal: controller.signal,
    nowUnixMilliseconds: () => Number(sim.status().latestBlockTimestamp * 1000n) })).rejects.toThrow();
  expect(submit).not.toHaveBeenCalled();
  expect((await wallet.snapshot()).pendingPayments).toHaveLength(0);
  await wallet.close();
  await db.close();
});


it("returns a published mine batch when another tab holds the synchronization lease", async () => {
  const db = await database();
  const sim = chain();
  const account = profile();
  const store = db[WALLET_DATABASE_STATE_STORE](identityFor(account));
  let lease: Awaited<ReturnType<typeof acquireWalletReservation>> | undefined;
  const submit = vi.fn(async ({  }: Parameters<DurableSubmissionAdapter<null, null>["submit"]>[0]) => {
    lease = await acquireWalletReservation(store, [WALLET_SYNC_RESOURCE]);
    return { accepted: true, queued: false, l1Hash: hashOf(sim.block(0n)), output: null };
  });
  const wallet = await Wallet[OPEN_WALLET_INTERNAL]({ database: db, node: batchNode(sim), profile: account,
    signer: privateKeyPcashActionSigner(TEST_PRIV_KEY), submission: { mode: "l1", preflight: async () => null, submit },
    provers: { privateValue: { proveAndEncode: async build =>
      encodePrivateValueTransaction({ shape: build.shape, publicInputs: build.publicInputs,
        proof: new Uint8Array(WIRE_PROOF_BYTES), outputData: build.outputData, arena: build.arena }) } } });
  try {
    const result = await wallet.mineBatch({ count: 1, nowUnixMilliseconds: () => Number(sim.status().latestBlockTimestamp * 1000n) });
    expect(result.submission).toMatchObject({ accepted: true, queued: false, l1Hash: hashOf(sim.block(0n)) });
    expect(submit).toHaveBeenCalledTimes(1);
    expect((await wallet.snapshot()).pendingPayments).toHaveLength(1);
  } finally {
    await lease?.release();
    await wallet.close();
    await db.close();
  }
});


it("paginates transaction records independently of note inventory after reopening", async () => {
  const db = await database();
  const account = profile(), identity = identityFor(account);
  const data = emptyWalletState(identity);
  data.transactionRecords = [1, 2, 3].map(index => ({
    transactionId: `0x${index.toString(16).padStart(64, "0")}`, contentHash: `0x${"aa".repeat(32)}`,
    leafIndex: String(index * 5), blockNumber: "1", blockHash: `0x${"bb".repeat(32)}`, timestamp: "1",
    received: [], sent: [], self: [{ schema: index === 2 ? applicationSchemaId("com.example.other") : applicationSchemaId("com.example.post"), data: "0x01" }], public: [],
  }));
  await db[WALLET_DATABASE_STATE_STORE](identity).save(data);
  const wallet = await Wallet[OPEN_WALLET_INTERNAL]({ database: db, node: node(), profile: account });
  expect((await wallet.transactionData({ limit: 1, offset: 1 }))[0]?.leafIndex).toBe("10");
  expect((await wallet.transactionData({ schema: applicationSchemaId("com.example.post") })).map(row => row.leafIndex)).toEqual(["5", "15"]);
  expect((await wallet.transactionData())[0]?.self[0]?.data).toEqual(Uint8Array.of(1));
  await expect(wallet.transactionData({ limit: 0 })).rejects.toThrow(/pagination/);
  await expect(wallet.transactionData({ offset: -1 })).rejects.toThrow(/pagination/);
  await wallet.close();
  const reopened = await Wallet[OPEN_WALLET_INTERNAL]({ database: db, node: node(), profile: account });
  expect(await reopened.transactionData()).toHaveLength(3);
  expect((await reopened.snapshot()).ownedNoteCount).toBe(0);
  await reopened.close(); await db.close();
});
