import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  WALLET_DATABASE_STATE_STORE,
  type WalletDatabase,
} from "../../src/wallet/database.ts";
import { emptyWalletState, type WalletStateStore, type WalletStoreIdentity } from "../../src/wallet/store.ts";
import { browserWalletDatabaseName } from "../../src/wallet/web/walletClient.ts";
import { openBrowserWalletDatabase } from "../../src/wallet/web/browserDatabase.ts";

const IDENTITY: WalletStoreIdentity = {
  address: 0xabcn,
  network: { chainId: 8191n, genesisHash: `0x${"11".repeat(32)}` },
};

let sequence = 0;
let databases: WalletDatabase[] = [];

function databaseName(): string {
  return `pcash-wallet-indexeddb-test-${++sequence}`;
}

async function open(name: string): Promise<WalletDatabase> {
  const database = await openBrowserWalletDatabase({ name });
  databases.push(database);
  return database;
}

beforeEach(() => {
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: new IDBFactory(),
  });
});

afterEach(async () => {
  const opened = databases;
  databases = [];
  await Promise.all(opened.map((database) => database.close()));
});

describe("native IndexedDB wallet database", () => {
  it("keeps wallet documents separate across L1 IDs and genesis resets", async () => {
    const network = { pcashChainId: 8191, l1ChainId: 12345678n, genesisHash: IDENTITY.network.genesisHash };
    const prefix = databaseName();
    const first = await open(browserWalletDatabaseName(prefix, network));
    const data = emptyWalletState(IDENTITY);
    data.syncedThrough = { blockNumber: "7", blockHash: `0x${"22".repeat(32)}` };
    await first[WALLET_DATABASE_STATE_STORE](IDENTITY).save(data);
    for (const reset of [{ ...network, l1ChainId: 12345679n }, { ...network, genesisHash: `0x${"33".repeat(32)}` }]) {
      const fresh = await open(browserWalletDatabaseName(prefix, reset));
      expect(await fresh[WALLET_DATABASE_STATE_STORE](IDENTITY).load()).toBeNull();
    }
    const restored = await open(browserWalletDatabaseName(prefix, network));
    expect(await restored[WALLET_DATABASE_STATE_STORE](IDENTITY).load()).toEqual(data);
  });

  it("round-trips one whole wallet document across reopen", async () => {
    const name = databaseName();
    const first = await open(name);
    const data = emptyWalletState(IDENTITY);
    data.syncedThrough = { blockNumber: "7", blockHash: `0x${"22".repeat(32)}` };
    await first[WALLET_DATABASE_STATE_STORE](IDENTITY).save(data);
    await first.close();

    const reopened = await open(name);
    expect(await reopened[WALLET_DATABASE_STATE_STORE](IDENTITY).load()).toEqual(data);
  });

  it("serializes concurrent updates from separate database handles", async () => {
    const name = databaseName();
    const first = await open(name);
    const second = await open(name);
    const firstStore = first[WALLET_DATABASE_STATE_STORE](IDENTITY);
    const secondStore = second[WALLET_DATABASE_STATE_STORE](IDENTITY);
    await firstStore.save(emptyWalletState(IDENTITY));

    const reserve = (store: WalletStateStore, id: string) =>
      store.transaction((current) => {
        const data = current!;
        (data.resourceReservations ??= []).push({
          reservationId: id,
          resources: [`note:${id}`],
          createdAtUnixMs: "1",
          heartbeatAtUnixMs: "1",
          expiresAtUnixMs: "9",
        });
        return { data, value: id };
      });

    await expect(Promise.all([
      reserve(firstStore, "first"),
      reserve(secondStore, "second"),
    ])).resolves.toEqual(["first", "second"]);
    expect((await firstStore.load())?.resourceReservations?.map((item) => item.reservationId).sort())
      .toEqual(["first", "second"]);
  });

  it("notifies another handle only after the committed state is readable", async () => {
    const name = databaseName();
    const writer = await open(name);
    const observer = await open(name);
    const writerStore = writer[WALLET_DATABASE_STATE_STORE](IDENTITY);
    const observerStore = observer[WALLET_DATABASE_STATE_STORE](IDENTITY);
    const observed = new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("cross-handle notification timed out")), 2_000);
      void observer.subscribe(IDENTITY, () => {
        void observerStore.load().then((data) => {
          const block = data?.syncedThrough?.blockNumber;
          if (block !== undefined) {
            clearTimeout(timeout);
            resolve(block);
          }
        }).catch(reject);
      });
    });
    const data = emptyWalletState(IDENTITY);
    data.syncedThrough = { blockNumber: "9", blockHash: `0x${"33".repeat(32)}` };
    await writerStore.save(data);
    await expect(observed).resolves.toBe("9");
  });

  it("notifies and unsubscribes listeners on the writing handle", async () => {
    const database = await open(databaseName());
    const store = database[WALLET_DATABASE_STATE_STORE](IDENTITY);
    let notifications = 0;
    const unsubscribe = await database.subscribe(IDENTITY, () => { notifications += 1; });
    await store.save(emptyWalletState(IDENTITY));
    expect(notifications).toBe(1);
    await unsubscribe();
    await store.save(emptyWalletState(IDENTITY));
    expect(notifications).toBe(1);
  });

  it("aborts a failed mutation without changing the prior revision", async () => {
    const database = await open(databaseName());
    const store = database[WALLET_DATABASE_STATE_STORE](IDENTITY);
    const initial = emptyWalletState(IDENTITY);
    initial.syncedThrough = { blockNumber: "1", blockHash: `0x${"44".repeat(32)}` };
    await store.save(initial);

    await expect(store.transaction(() => {
      throw new Error("stop mutation");
    })).rejects.toThrow("stop mutation");
    expect((await store.load())?.syncedThrough?.blockNumber).toBe("1");
  });

  it("reports a committed write as success when close races post-commit notification", async () => {
    const name = databaseName();
    const database = await open(name);
    const store = database[WALLET_DATABASE_STATE_STORE](IDENTITY);
    const data = emptyWalletState(IDENTITY);
    data.syncedThrough = { blockNumber: "3", blockHash: `0x${"55".repeat(32)}` };
    const writing = store.save(data);
    const closing = database.close();
    await expect(writing).resolves.toBeUndefined();
    await closing;

    const reopened = await open(name);
    expect((await reopened[WALLET_DATABASE_STATE_STORE](IDENTITY).load())?.syncedThrough?.blockNumber)
      .toBe("3");
  });

  it("refuses work after close", async () => {
    const database = await open(databaseName());
    const store = database[WALLET_DATABASE_STATE_STORE](IDENTITY);
    await database.close();
    await expect(store.load()).rejects.toThrow("wallet database is closed");
    await expect(database.subscribe(IDENTITY, () => undefined)).rejects.toThrow("wallet database is closed");
  });

  it("closes an old handle when the IndexedDB schema version changes", async () => {
    const name = databaseName();
    const database = await open(name);
    const store = database[WALLET_DATABASE_STATE_STORE](IDENTITY);
    const upgraded = await new Promise<IDBDatabase>((resolve, reject) => {
      const opening = indexedDB.open(name, 2);
      opening.onsuccess = () => resolve(opening.result);
      opening.onerror = () => reject(opening.error);
    });
    await expect(store.load()).rejects.toThrow("wallet database is closed");
    upgraded.close();
  });
});
