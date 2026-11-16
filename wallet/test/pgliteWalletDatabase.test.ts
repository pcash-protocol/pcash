import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, statSync } from "node:fs";
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

  it("reclaims dead rows and write-ahead log while wallets sharing a client keep committing", { timeout: 60_000 }, async () => {
    const path = join(mkdtempSync(join(tmpdir(), "pcash-pglite-wallet-")), "wallet.pglite");
    const client = await PGlite.create(path);
    await PGliteWalletDatabase.open(client);
    const backends = [1n, 2n, 3n, 4n].map((address) =>
      pgliteWalletStoreBackend(client, walletDatabaseKey({ ...IDENTITY, address })));
    // Random hex, so TOAST compression cannot hide the size of each rewrite.
    const note = () => randomBytes(20).toString("hex");
    const document = { notes: Array.from({ length: 1_000 }, note) };
    const walBytes = () => readdirSync(join(path, "pg_wal"))
      .reduce((total, name) => total + statSync(join(path, "pg_wal", name)).size, 0);
    const commit = async (backend: (typeof backends)[number], block: number) => backend.transaction(() => {
      document.notes[block % document.notes.length] = note();
      return { data: { block, ...document }, value: undefined };
    }, {
      replace: false,
      writes: new Map<string, unknown>([
        [`checkpoint:${block}`, { frontier: randomBytes(1_000).toString("hex") }],
        [`checkpoint:${block - 16}`, null],
        ["meta", { block }],
      ]),
    });

    // Concurrent writers cross the maintenance interval while others are mid-transaction.
    await Promise.all(backends.map(async (backend) => {
      for (let block = 0; block < 500; block += 1) await commit(backend, block);
    }));
    // Without maintenance this leaves about 100 MB of tables and 117 MB of log;
    // with it, about 5 MB and 32 MB.
    const tables = await client.query<{ bytes: number }>(
      "SELECT (pg_total_relation_size('pcash_wallet_state') + pg_total_relation_size('pcash_wallet_chain'))::int AS bytes",
    );
    expect(tables.rows[0]!.bytes).toBeLessThan(16 * 2 ** 20);
    expect(walBytes()).toBeLessThan(64 * 2 ** 20);
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
