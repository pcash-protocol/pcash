// The local chain-record contract, identical on every wallet store backend:
// records commit and roll back with the document, `replace` clears one slot
// only, and reads return exactly the records a slot holds.

import { PGlite } from "@electric-sql/pglite";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChainCommit } from "@pcash/sdk/wallet/database";
import { WALLET_DATABASE_STATE_STORE, walletDatabaseKey, type WalletDatabase } from "@pcash/sdk/wallet/database";
import { memoryWalletStoreBackend } from "@pcash/sdk/wallet/testing";
import { pgliteWalletStoreBackend } from "../src/pgliteDatabase.ts";
import type { WalletStoreBackend, WalletStoreIdentity } from "@pcash/sdk/wallet/database";
import { openBrowserWalletDatabase } from "@pcash/sdk/wallet/web";

// The IndexedDB backend is private to its database; capture it where the database binds it.
const captured = vi.hoisted(() => ({ backend: null as WalletStoreBackend | null }));
vi.mock("@pcash/sdk/wallet/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@pcash/sdk/wallet/database")>();
  return {
    ...actual,
    walletStore: ((backend, ...rest) => {
      captured.backend = backend;
      return actual.walletStore(backend, ...rest);
    }) satisfies typeof actual.walletStore,
  };
});

const NETWORK = { chainId: 8191n, genesisHash: `0x${"11".repeat(32)}` };
const A: WalletStoreIdentity = { address: 0xabcn, network: NETWORK };
const B: WalletStoreIdentity = { address: 0xbeefn, network: NETWORK };

Object.defineProperty(globalThis, "indexedDB", {
  configurable: true,
  value: new IDBFactory(),
});

const cleanups: Array<() => Promise<void>> = [];
let indexedDbSequence = 0;

afterEach(async () => {
  const pending = cleanups.splice(0);
  await Promise.all(pending.map((cleanup) => cleanup()));
});

type Slots = (identity: WalletStoreIdentity) => WalletStoreBackend;

const BACKENDS: Array<[string, () => Promise<Slots>]> = [
  ["memory", async () => {
    const slots = new Map<string, WalletStoreBackend>();
    return (identity) => {
      const key = walletDatabaseKey(identity);
      if (!slots.has(key)) slots.set(key, memoryWalletStoreBackend());
      return slots.get(key)!;
    };
  }],
  ["PGlite", async () => {
    const client = await PGlite.create("memory://");
    cleanups.push(() => client.close());
    return (identity) => pgliteWalletStoreBackend(client, walletDatabaseKey(identity));
  }],
  ["IndexedDB", async () => {
    const database: WalletDatabase = await openBrowserWalletDatabase({
      name: `pcash-wallet-chain-store-${++indexedDbSequence}`,
    });
    cleanups.push(() => database.close());
    const slots = new Map<string, WalletStoreBackend>();
    return (identity) => {
      const key = walletDatabaseKey(identity);
      if (!slots.has(key)) {
        captured.backend = null;
        database[WALLET_DATABASE_STATE_STORE](identity);
        slots.set(key, captured.backend!);
      }
      return slots.get(key)!;
    };
  }],
];

const commit = (writes: Record<string, unknown>, replace = false): ChainCommit => ({
  replace,
  writes: new Map(Object.entries(writes)),
});

const write = (backend: WalletStoreBackend, step: number, chain?: ChainCommit) =>
  backend.transaction(() => ({ data: { step }, value: undefined }), chain);

const records = async (backend: WalletStoreBackend, keys?: readonly string[]) =>
  Object.fromEntries(await backend.readChain(keys));

const account = (index: number) => ({ index: String(index), address: `0x${String(index).padStart(40, "0")}` });

describe.each(BACKENDS)("chain records on %s", (_name, open) => {
  it("writes and deletes records together with the document", async () => {
    const slot = (await open())(A);
    await write(slot, 1, commit({ meta: { revision: 1 }, "account:01": account(1), "key:0x01": "0xaa" }));
    await write(slot, 2, commit({ meta: { revision: 2 }, "key:0x01": null, "nullifier:0x02": { pcashNumber: "2" } }));
    expect((await slot.read())!.data).toEqual({ step: 2 });
    expect(await records(slot)).toEqual({
      meta: { revision: 2 },
      "account:01": account(1),
      "nullifier:0x02": { pcashNumber: "2" },
    });

    await write(slot, 3);
    expect((await slot.read())!.data).toEqual({ step: 3 });
    expect(Object.keys(await records(slot)).sort()).toEqual(["account:01", "meta", "nullifier:0x02"]);
  });

  it("replaces every record of one slot and none of another's", async () => {
    const slots = await open();
    const a = slots(A);
    const b = slots(B);
    await write(a, 1, commit({ meta: { revision: 1 }, "account:01": account(1), "checkpoint:01": { pcashNumber: "1" } }));
    await write(b, 1, commit({ meta: { revision: 1 }, "account:01": account(7) }));
    await write(a, 2, commit({ meta: { revision: 2 }, "account:02": account(2) }, true));
    expect(await records(a)).toEqual({ meta: { revision: 2 }, "account:02": account(2) });
    expect(await records(b)).toEqual({ meta: { revision: 1 }, "account:01": account(7) });
  });

  it("applies neither the document nor the chain writes when the operation throws", async () => {
    const slot = (await open())(A);
    await write(slot, 1, commit({ meta: { revision: 1 }, "account:01": account(1) }));
    await expect(slot.transaction(() => {
      throw new Error("stop step");
    }, commit({ meta: { revision: 2 }, "account:01": null, "account:02": account(2) }, true))).rejects.toThrow("stop step");
    expect((await slot.read())!.data).toEqual({ step: 1 });
    expect(await records(slot)).toEqual({ meta: { revision: 1 }, "account:01": account(1) });
  });

  it("rolls back chain writes when the document cannot be stored", async () => {
    const slot = (await open())(A);
    await write(slot, 1, commit({ meta: { revision: 1 }, "account:01": account(1) }));
    await expect(slot.transaction(
      () => ({ data: { unstorable: [1n, () => undefined] }, value: undefined }),
      commit({ meta: { revision: 2 }, "account:01": null, "account:02": account(2) }, true),
    )).rejects.toThrow();
    expect((await slot.read())!.data).toEqual({ step: 1 });
    expect(await records(slot)).toEqual({ meta: { revision: 1 }, "account:01": account(1) });
  });

  it("reads every record, or only the requested keys that exist", async () => {
    const slots = await open();
    const a = slots(A);
    await write(a, 1, commit({ meta: { revision: 1 }, "account:01": account(1), "key:0x01": "0xaa" }));
    expect(await records(a)).toEqual({ meta: { revision: 1 }, "account:01": account(1), "key:0x01": "0xaa" });
    expect(await records(a, ["meta", "key:0x01", "checkpoint:ff"])).toEqual({ meta: { revision: 1 }, "key:0x01": "0xaa" });
    expect((await a.readChain(["missing"])).size).toBe(0);
    expect((await slots(B).readChain()).size).toBe(0);
  });
});
