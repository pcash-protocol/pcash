import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite, type PGliteInterface } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { openNodeWalletDatabase } from "../src/node/walletDatabase.ts";
import { emptyWalletState } from "@pcash/sdk/wallet/testing";
import { walletStore, type WalletStoreIdentity } from "@pcash/sdk/wallet/database";
import {
  PGliteWalletDatabase,
  pgliteWalletStoreBackend,
} from "../src/pgliteDatabase.ts";
import { WALLET_DATABASE_STATE_STORE, walletDatabaseKey } from "@pcash/sdk/wallet/database";

const IDENTITY: WalletStoreIdentity = {
  address: 0xabcn,
  network: { chainId: 8191n, genesisHash: `0x${"11".repeat(32)}` },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

describe("PGlite wallet database", () => {
  it("stores one row per wallet and round-trips the whole document", async () => {
    const client = await PGlite.create("memory://");
    const database = await PGliteWalletDatabase.open(client);
    const data = emptyWalletState(IDENTITY);
    data.syncedThrough = { blockNumber: "7", blockHash: `0x${"22".repeat(32)}` };
    data.resourceReservations = Array.from({ length: 251 }, (_, index) => ({
      reservationId: `reservation-${index}`,
      resources: [`note:${index}`],
      createdAtUnixMs: "1",
      heartbeatAtUnixMs: "2",
      expiresAtUnixMs: "3",
    }));

    const store = database[WALLET_DATABASE_STATE_STORE](IDENTITY);
    await store.transaction(() => ({ data, value: undefined }));

    const rows = await client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM pcash_wallet_state",
    );
    const columns = await client.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns "
        + "WHERE table_name = 'pcash_wallet_state' ORDER BY ordinal_position",
    );
    expect(rows.rows[0]?.count).toBe("1");
    expect(columns.rows.map((row) => row.column_name)).toEqual(["wallet_key", "revision", "state"]);
    expect(await store.load()).toEqual(data);

    await database.close();
    await client.close();
  });

  it("reopens the same filesystem database without a format adapter", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "pcash-pglite-wallet-")), "wallet.pglite");
    const first = await openNodeWalletDatabase(path);
    const data = emptyWalletState(IDENTITY);
    data.syncedThrough = { blockNumber: "4", blockHash: `0x${"33".repeat(32)}` };
    await first[WALLET_DATABASE_STATE_STORE](IDENTITY).save(data);
    await first.close();

    const reopened = await openNodeWalletDatabase(path);
    expect(await reopened[WALLET_DATABASE_STATE_STORE](IDENTITY).load()).toEqual(data);
    await reopened.close();
  });

  it("serializes concurrent read-modify-write transactions without losing an update", async () => {
    const client = await PGlite.create("memory://");
    const key = walletDatabaseKey(IDENTITY);
    const store = walletStore(pgliteWalletStoreBackend(client, key), IDENTITY);
    const initial = emptyWalletState(IDENTITY);
    initial.syncedThrough = { blockNumber: "1", blockHash: `0x${"21".repeat(32)}` };
    await store.transaction(() => ({ data: initial, value: undefined }));

    const append = (id: string) =>
      store.transaction((current) => {
        const data = current!;
        data.resourceReservations = [...(data.resourceReservations ?? []), {
          reservationId: id,
          resources: [`note:${id}`],
          createdAtUnixMs: "1",
          heartbeatAtUnixMs: "1",
          expiresAtUnixMs: "9",
        }];
        return { data, value: undefined };
      });

    await Promise.all([append("first"), append("second")]);

    const final = await store.load();
    expect(final?.resourceReservations?.map((reservation) => reservation.reservationId).sort())
      .toEqual(["first", "second"]);
    await client.close();
  });

  it("shares concurrent LISTEN initialization and retries after a failure", async () => {
    const client = await PGlite.create("memory://");
    const firstListen = deferred<() => Promise<void>>();
    let attempts = 0;
    let unlistens = 0;
    const controlled = new Proxy(client, {
      get(target, property) {
        if (property === "listen") {
          return () => {
            attempts += 1;
            if (attempts === 1) return firstListen.promise;
            return Promise.resolve(async () => { unlistens += 1; });
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as PGliteInterface;
    const database = await PGliteWalletDatabase.open(controlled);
    const first = database.subscribe(IDENTITY, () => undefined);
    const second = database.subscribe(IDENTITY, () => undefined);

    expect(attempts).toBe(1);
    firstListen.reject(new Error("listen failed"));
    await expect(first).rejects.toThrow("listen failed");
    await expect(second).rejects.toThrow("listen failed");

    const unsubscribe = await database.subscribe(IDENTITY, () => undefined);
    expect(attempts).toBe(2);
    await unsubscribe();
    await database.close();
    expect(unlistens).toBe(1);
    await client.close();
  });
});
