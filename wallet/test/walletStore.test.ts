// One wallet, multiple storage backends, identical behavior.
//
// The platform-neutral store contract is real only if its implementations are
// indistinguishable through this seam. The native IndexedDB adapter has focused
// browser-semantics coverage in indexedDbWalletDatabase.test.ts.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, describe, expect, it } from "vitest";
import { WalletConflictError } from "@pcash/sdk/wallet";
import { loadWalletStateOrEmpty } from "@pcash/sdk/wallet/testing";
import { walletStore, type WalletStateStore, type WalletStoreBackend } from "@pcash/sdk/wallet/database";
import { memoryWalletStateStore, memoryWalletStoreBackend } from "@pcash/sdk/wallet/testing";
import type { PendingAssetAction, WalletFileData } from "@pcash/sdk/wallet/testing";
import { pgliteWalletStoreBackend } from "../src/pgliteDatabase.ts";
import { walletDatabaseKey } from "@pcash/sdk/wallet/database";
import { acquireWalletReservation } from "@pcash/sdk/wallet/testing";
import { emptyWalletState } from "@pcash/sdk/wallet/testing";
import { type WalletStoreIdentity } from "@pcash/sdk/wallet/database";
import { WALLET_DATABASE_STATE_STORE, type WalletDatabase } from "@pcash/sdk/wallet/database";
import { openBrowserWalletDatabase } from "@pcash/sdk/wallet/web";
import { WalletChainState } from "@pcash/sdk/wallet/testing";
import { ChainSim, chainRecords } from "./chainFixture.ts";
import { generateMlKemKeyPair } from "@pcash/sdk/protocol";
import { retainReceiveKeyPair, retainReceiveKeyPairForRescan } from "@pcash/sdk/wallet/testing";

const OWNER_ADDRESS = 0xabcn;
const NETWORK = { chainId: 8191n, genesisHash: `0x${"11".repeat(32)}` };
const IDENTITY: WalletStoreIdentity = { address: OWNER_ADDRESS, network: NETWORK };

const seeded = (): WalletFileData => emptyWalletState(IDENTITY);

const pgliteClients = new Set<Promise<PGlite>>();
const browserDatabases = new Set<WalletDatabase>();
let indexedDbSequence = 0;

Object.defineProperty(globalThis, "indexedDB", {
  configurable: true,
  value: new IDBFactory(),
});

function trackedPGlite(dataDir: string | Promise<string>): Promise<PGlite> {
  const client = Promise.resolve(dataDir).then((directory) => PGlite.create(directory));
  pgliteClients.add(client);
  return client;
}

afterEach(async () => {
  const clients = [...pgliteClients];
  pgliteClients.clear();
  const browser = [...browserDatabases];
  browserDatabases.clear();
  await Promise.all([
    ...clients.map(async (client) => (await client).close()),
    ...browser.map((database) => database.close()),
  ]);
});

function scratch(): string {
  return join(mkdtempSync(join(tmpdir(), "pcash-wallet-store-")), "wallet");
}

function pgliteStore(
  identity: WalletStoreIdentity,
  dataDir: string | Promise<string> = "memory://",
): WalletStateStore {
  const client = trackedPGlite(dataDir);
  return walletStore(pgliteWalletStoreBackend(client, walletDatabaseKey(identity)), identity);
}

async function indexedDbStore(identity: WalletStoreIdentity): Promise<WalletStateStore> {
  const database = await openBrowserWalletDatabase({
    name: `pcash-wallet-store-conformance-${++indexedDbSequence}`,
  });
  browserDatabases.add(database);
  return database[WALLET_DATABASE_STATE_STORE](identity);
}

/**
 * Every backend implements the same short transaction boundary. Reads never
 * acquire that boundary, and a transaction callback cannot be asynchronous.
 */
const BACKENDS: Array<[
  string,
  (identity: WalletStoreIdentity) => WalletStateStore | Promise<WalletStateStore>,
  boolean,
]> = [
  ["PGlite filesystem", (identity) => pgliteStore(identity, scratch()), true],
  ["PGlite memory", (identity) => pgliteStore(identity), true],
  ["IndexedDB", indexedDbStore, true],
  ["memory", () => memoryWalletStateStore(seeded()), false],
];

describe.each(BACKENDS)("wallet store backend: %s", (_name, open, persistent) => {
  it("round-trips a document unchanged", async () => {
    const store = await open(IDENTITY);
    const data = seeded();
    data.notes = [];
    await store.save(data);
    expect(await store.load()).toEqual(data);
  });

  it("merges disjoint edits and rejects conflicting edits", async () => {
    const store = await open(IDENTITY);
    await store.save(seeded());
    const first = (await store.load())!;
    const second = (await store.load())!;
    first.nextOutputIndex = "1";
    second.historyRevision = "2";
    await store.save(first);
    await store.save(second);
    expect(await store.load()).toMatchObject({ nextOutputIndex: "1", historyRevision: "2" });

    const stale = (await store.load())!;
    const fresh = (await store.load())!;
    stale.nextOutputIndex = "3";
    fresh.nextOutputIndex = "4";
    await store.save(fresh);
    await expect(store.save(stale)).rejects.toBeInstanceOf(WalletConflictError);
    expect((await store.load())!.nextOutputIndex).toBe("4");
  });

  it("edits and deletes a saved pending action after a durable reread", async () => {
    for (const change of ["edit", "delete"] as const) {
      const store = await open(IDENTITY);
      const data = seeded();
      // A backend may return a stored object's keys in another order than they
      // were written, so merging must not depend on key order.
      const pending: PendingAssetAction = {
        contentHash: `0x${"a1".repeat(32)}`,
        transactionHex: "0x00",
        claimLinkRecipient: `0x${"b2".repeat(20)}`,
        assetId: `0x${"00".repeat(32)}`,
        owner: data.address,
        notBeforeTimestamp: "0",
        validUntilTimestamp: "100",
        openFeeAmount: "0",
        issuanceOwnerCommitment: "0",
        inputs: [{ nullifier: `0x${"c3".repeat(32)}`, spentCommitment: null }],
        ownedOutputs: [],
      };
      data.pendingAssetActions = [pending];
      await store.save(data);
      const [reread] = (await store.load())!.pendingAssetActions!;
      expect(reread).toEqual(pending);

      if (change === "edit") data.pendingAssetActions![0]!.validUntilTimestamp = "200";
      else data.pendingAssetActions = [];
      await store.save(data);
      expect((await store.load())!.pendingAssetActions ?? [])
        .toEqual(change === "edit" ? [{ ...pending, validUntilTimestamp: "200" }] : []);
    }
  });

  it("validates imported receive-key material at insertion and stores it", async () => {
    const store = await open(IDENTITY);
    const data = seeded();
    const first = generateMlKemKeyPair(new Uint8Array(64).fill(0x31));
    const second = generateMlKemKeyPair(new Uint8Array(64).fill(0x32));
    expect(retainReceiveKeyPair(data, first)).toBe(true);
    expect(retainReceiveKeyPairForRescan(data, second)).toBe(true);
    await store.save(data);
    expect((await store.load())!.receiveKeys).toHaveLength(2);
    expect((await store.load())!.fullRescanRequired).toBe(true);
    const mismatched = { ...first, secretKey: second.secretKey };
    expect(() => retainReceiveKeyPair(seeded(), mismatched)).toThrow(/mlKemSecretKey does not match mlKemPublicKey/);
  });

  it("rolls back a throwing transaction", async () => {
    const store = await open(IDENTITY);
    await store.save(seeded());
    await expect(store.transaction((current) => {
      current!.nextOutputIndex = "7";
      throw new Error("stop mutation");
    })).rejects.toThrow("stop mutation");
    expect((await store.load())!.nextOutputIndex).toBeUndefined();
  });

  it("refuses a document bound to a different owner", async () => {
    const store = await open(IDENTITY);
    const foreign = emptyWalletState({ address: 0xdeadn, network: NETWORK });
    await expect(store.save(foreign)).rejects.toThrow(/different owner/);
  });

  it("refuses a document bound to a different chain", async () => {
    const store = await open(IDENTITY);
    const foreign = emptyWalletState({
      address: OWNER_ADDRESS,
      network: { ...NETWORK, chainId: 4242n },
    });
    await expect(store.save(foreign)).rejects.toThrow(/chainId/);
  });

  it("refuses a document bound to a different genesis", async () => {
    const store = await open(IDENTITY);
    const foreign = emptyWalletState({
      address: OWNER_ADDRESS,
      network: { ...NETWORK, genesisHash: `0x${"22".repeat(32)}` },
    });
    await expect(store.save(foreign)).rejects.toThrow(/genesisHash/);
  });

  it("atomically composes concurrent short transactions", async () => {
    const store = await open(IDENTITY);
    await store.save(seeded());
    const reserve = (tag: string) => store.transaction((current) => {
      const data = current!;
      (data.resourceReservations ??= []).push({
        reservationId: tag,
        resources: [`note:${tag}`],
        createdAtUnixMs: "1",
        heartbeatAtUnixMs: "1",
        expiresAtUnixMs: "2",
      });
      return { data, value: tag };
    });
    await expect(Promise.all([reserve("a"), reserve("b")])).resolves.toEqual(["a", "b"]);
    expect((await store.load())!.resourceReservations?.map((item) => item.reservationId).sort())
      .toEqual(["a", "b"]);
  });

  it("permits parallel reads without acquiring a writer lease", async () => {
    const store = await open(IDENTITY);
    await store.save(seeded());
    const [left, right, third] = await Promise.all([
      store.load(),
      store.load(),
      store.load(),
    ]);
    expect(left).toEqual(right);
    expect(right).toEqual(third);
  });

  it("rejects a conditioned save after its reservation expires", async () => {
    const store = await open(IDENTITY);
    let now = 100;
    const reservation = await acquireWalletReservation(store, ["note:conditioned"], {
      ttlMs: 10,
      nowUnixMilliseconds: () => now,
    });
    const data = await store.load();
    data!.syncedThrough = { blockNumber: "1", blockHash: `0x${"22".repeat(32)}` };
    now = 111;

    await expect(reservation.save(data!)).rejects.toBeInstanceOf(WalletConflictError);
    expect((await store.load())!.syncedThrough).toBeUndefined();
    await reservation.release();
  });

  it("rejects a conditioned save after its reservation is lost", async () => {
    const store = await open(IDENTITY);
    const reservation = await acquireWalletReservation(store, ["note:conditioned"], {
      ttlMs: 100,
      nowUnixMilliseconds: () => 100,
    });
    const data = (await store.load())!;
    data.nextOutputIndex = "1";
    await store.transaction((current) => {
      const fresh = current!;
      delete fresh.resourceReservations;
      return { data: fresh, value: undefined };
    });
    await expect(reservation.save(data)).rejects.toBeInstanceOf(WalletConflictError);
    expect((await store.load())!.nextOutputIndex).toBeUndefined();
    await reservation.release();
  });

  it("reads null before anything has been written", async () => {
    if (!persistent) return;
    expect(await (await open(IDENTITY)).load()).toBeNull();
  });
});

describe("two wallets sharing one PGlite database", () => {
  // The stable identity key and schema allow many accounts per data directory.
  // Short transactions retain isolation through the shared PGlite connection.

  it("updates separate wallets independently", async () => {
    const path = scratch();
    const client = trackedPGlite(path);
    const a = walletStore(pgliteWalletStoreBackend(client, walletDatabaseKey(IDENTITY)), IDENTITY);
    const otherIdentity = { address: 0xbeefn, network: NETWORK };
    const b = walletStore(pgliteWalletStoreBackend(client, walletDatabaseKey(otherIdentity)), otherIdentity);
    await Promise.all([
      a.save(emptyWalletState(IDENTITY)),
      b.save(emptyWalletState({ address: 0xbeefn, network: NETWORK })),
    ]);
    expect(BigInt((await a.load())!.address)).toBe(OWNER_ADDRESS);
    expect(BigInt((await b.load())!.address)).toBe(0xbeefn);
  });

  it("keeps the two wallets' documents separate", async () => {
    const path = scratch();
    const client = trackedPGlite(path);
    const a = walletStore(pgliteWalletStoreBackend(client, walletDatabaseKey(IDENTITY)), IDENTITY);
    const otherIdentity = { address: 0xbeefn, network: NETWORK };
    const b = walletStore(pgliteWalletStoreBackend(client, walletDatabaseKey(otherIdentity)), otherIdentity);
    await a.save(emptyWalletState(IDENTITY));
    expect(await b.load()).toBeNull();
    await b.save(emptyWalletState({ address: 0xbeefn, network: NETWORK }));
    expect(BigInt((await a.load())!.address)).toBe(OWNER_ADDRESS);
    expect(BigInt((await b.load())!.address)).toBe(0xbeefn);
  });

  it("serializes two stores updating the same wallet", async () => {
    const path = scratch();
    const client = trackedPGlite(path);
    const first = walletStore(pgliteWalletStoreBackend(client, walletDatabaseKey(IDENTITY)), IDENTITY);
    const second = walletStore(pgliteWalletStoreBackend(client, walletDatabaseKey(IDENTITY)), IDENTITY);
    await first.save(seeded());
    const add = (store: WalletStateStore, id: string) => store.transaction((current) => {
      const data = current!;
      (data.resourceReservations ??= []).push({
        reservationId: id,
        resources: [`note:${id}`],
        createdAtUnixMs: "1",
        heartbeatAtUnixMs: "1",
        expiresAtUnixMs: "2",
      });
      return { data, value: undefined };
    });
    await Promise.all([add(first, "first"), add(second, "second")]);
    expect((await first.load())!.resourceReservations).toHaveLength(2);
  });

  it("reloads chain state another store over the same wallet committed", async () => {
    const client = trackedPGlite(scratch());
    const first = walletStore(pgliteWalletStoreBackend(client, walletDatabaseKey(IDENTITY)), IDENTITY);
    const second = walletStore(pgliteWalletStoreBackend(client, walletDatabaseKey(IDENTITY)), IDENTITY);
    expect(await second.readChain((chain) => chain)).toBeNull();
    const sim = new ChainSim(NETWORK.chainId);
    const records = chainRecords({ outputs: [], anchor: sim.head.envelope });
    const state = WalletChainState.fromRecords(records)!;
    await first.save(seeded(), { chain: { state, commit: { replace: true, writes: records } } });
    expect(await second.readChain((chain) => [chain!.synced.pcashNumber, chain!.accountCount])).toEqual([0n, 0n]);

    const block = sim.addBlock({ accounts: [{ address: `0x${"ab".repeat(20)}`, nullifierKeyCommitment: 1n, accountRuleSetCommitment: 2n }] });
    for (const change of block.changes) state.applyAccountChange(change);
    const commit = state.finishStep({ anchor: block.envelope, finalizedBlock: 0n, watched: new Set() });
    await first.save((await first.load())!, { chain: { state, commit } });
    expect(await second.readChain((chain) => [chain!.synced.pcashNumber, chain!.accountCount])).toEqual([1n, 1n]);
  });
});

describe("loadWalletStateOrEmpty identity binding", () => {
  // An EMPTY store has no document to disagree with, so the binding is the only
  // thing standing between a runtime wallet and another owner's slot. Reading
  // the fallback identity off the store instead of the caller would make this
  // silently succeed and write the wrong wallet's key.
  const OTHER_OWNER = 0xdeadn;
  const emptyStore = (identity = IDENTITY): WalletStateStore =>
    walletStore(memoryWalletStoreBackend(), identity);

  it("refuses an empty store bound to a different owner", async () => {
    await expect(
      loadWalletStateOrEmpty(emptyStore(), { address: OTHER_OWNER, network: NETWORK }),
    ).rejects.toThrow(/different owner or network/);
  });

  it("refuses an empty store bound to a different genesis", async () => {
    await expect(
      loadWalletStateOrEmpty(emptyStore(), {
        address: OWNER_ADDRESS,
        network: { chainId: NETWORK.chainId, genesisHash: `0x${"22".repeat(32)}` },
      }),
    ).rejects.toThrow(/different owner or network/);
  });

  it("refuses a populated store bound to a different owner", async () => {
    const store = memoryWalletStateStore(seeded());
    await expect(
      loadWalletStateOrEmpty(store, { address: OTHER_OWNER, network: NETWORK }),
    ).rejects.toThrow(/different owner or network/);
  });

  it("returns an empty document carrying the caller's identity", async () => {
    const store = emptyStore();
    const data = await loadWalletStateOrEmpty(store, IDENTITY);
    expect(BigInt(data.address)).toBe(OWNER_ADDRESS);
    expect(data.network.genesisHash).toBe(NETWORK.genesisHash);
    // and the store accepts what it just handed back
    await expect(store.save(data)).resolves.toBeUndefined();
  });
});

describe("wallet store durable boundary", () => {
  it("snapshots the caller before waiting for the backend transaction", async () => {
    const held = memoryWalletStoreBackend(seeded());
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const backend: WalletStoreBackend = {
      ...held,
      async transaction(operation, chain) {
        await gate;
        return held.transaction(operation, chain);
      },
    };
    const store = walletStore(backend, IDENTITY);
    const data = (await store.load())!;
    data.nextOutputIndex = "1";
    const saving = store.save(data);
    data.nextOutputIndex = "9";
    release();
    await saving;
    expect((held.snapshot() as WalletFileData).nextOutputIndex).toBe("1");
  });

  it("does not expose a backend-held object through load", async () => {
    const held = memoryWalletStoreBackend(seeded());
    const store = walletStore(held, IDENTITY);
    const loaded = (await store.load())!;
    loaded.nextOutputIndex = "7";
    expect((held.snapshot() as WalletFileData).nextOutputIndex).toBeUndefined();
  });
});
