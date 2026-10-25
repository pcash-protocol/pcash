import {
  WALLET_DATABASE_STATE_STORE,
  walletDatabaseKey,
  type WalletDatabase,
} from "../database.ts";
import type { ChainCommit } from "../chainState.ts";
import { keyedResourcePool } from "../resourcePool.ts";
import {
  walletStore,
  type WalletStateStore,
  type WalletStoreBackend,
  type WalletStoreBackendCommit,
  type WalletStoreBackendRecord,
  type WalletStoreIdentity,
} from "@pcash/sdk/wallet/database";

const DATABASE_VERSION = 1;
const WALLET_STORE = "wallets";
/** One record per key of a wallet's local chain store, keyed `[walletKey, recordKey]`. */
const CHAIN_STORE = "chain";
const CHAIN_BY_WALLET = "walletKey";

interface IndexedDbChainRow {
  walletKey: string;
  recordKey: string;
  value: unknown;
}
const CHANGE_MESSAGE = "wallet-changed";

export interface BrowserWalletDatabaseOptions {
  /** IndexedDB database name. Names are origin-local and may be shared by accounts. */
  name: string;
}

interface IndexedDbWalletRow {
  walletKey: string;
  revision: number;
  data: unknown;
}

interface WalletChangeMessage {
  type: typeof CHANGE_MESSAGE;
  walletKey: string;
  revision: number;
}

function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    value.onsuccess = () => resolve(value.result);
    value.onerror = () => reject(value.error ?? new Error("wallet IndexedDB request failed"));
  });
}

function completed(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("wallet IndexedDB transaction aborted"));
    transaction.onerror = () => reject(transaction.error ?? new Error("wallet IndexedDB transaction failed"));
  });
}

function changeMessage(value: unknown): WalletChangeMessage | null {
  if (
    typeof value !== "object"
    || value === null
    || !("type" in value)
    || value.type !== CHANGE_MESSAGE
    || !("walletKey" in value)
    || typeof value.walletKey !== "string"
    || !("revision" in value)
    || !Number.isSafeInteger(value.revision)
    || (value.revision as number) < 0
  ) return null;
  return value as WalletChangeMessage;
}

function abort(transaction: IDBTransaction): void {
  try {
    transaction.abort();
  } catch {
    // A transaction that already failed or completed needs no second abort.
  }
}

/** Native browser database. Shared wallet semantics remain above this adapter. */
class IndexedDbWalletDatabase implements WalletDatabase {
  readonly #database: IDBDatabase;
  readonly #channel: BroadcastChannel;
  readonly #listeners = new Map<string, Set<() => void>>();
  // One store per wallet slot, so every caller in this tab shares its local chain cache and lock.
  readonly #stores = new Map<string, WalletStateStore>();
  #closed = false;

  constructor(database: IDBDatabase, name: string) {
    this.#database = database;
    this.#channel = new BroadcastChannel(`pcash-wallet-database:${name}`);
    this.#channel.onmessage = (event) => {
      const message = changeMessage(event.data);
      if (message !== null) this.#notify(message.walletKey);
    };
    this.#database.onversionchange = () => { void this.close(); };
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("wallet database is closed");
  }

  #notify(key: string): void {
    for (const listener of this.#listeners.get(key) ?? []) {
      try {
        listener();
      } catch {
        // Observers cannot roll back or poison a committed wallet transaction.
      }
    }
  }

  #backend(key: string): WalletStoreBackend {
    return {
      read: async (): Promise<WalletStoreBackendRecord | null> => {
        this.#assertOpen();
        const transaction = this.#database.transaction(WALLET_STORE, "readonly");
        const done = completed(transaction);
        try {
          const row = await request(transaction.objectStore(WALLET_STORE).get(key)) as IndexedDbWalletRow | undefined;
          await done;
          return row === undefined ? null : { revision: row.revision, data: structuredClone(row.data) };
        } catch (cause) {
          await done.catch(() => undefined);
          throw cause;
        }
      },
      transaction: async <T>(
        operation: (current: WalletStoreBackendRecord | null) => WalletStoreBackendCommit<T>,
        chain?: ChainCommit,
      ): Promise<T> => {
        this.#assertOpen();
        const transaction = this.#database.transaction(
          [WALLET_STORE, CHAIN_STORE],
          "readwrite",
          { durability: "strict" },
        );
        const done = completed(transaction);
        if (transaction.durability !== "strict") {
          abort(transaction);
          await done.catch(() => undefined);
          throw new Error("browser wallet persistence requires strict IndexedDB durability");
        }
        try {
          const objectStore = transaction.objectStore(WALLET_STORE);
          const row = await request(objectStore.get(key)) as IndexedDbWalletRow | undefined;
          const current = row === undefined
            ? null
            : { revision: row.revision, data: structuredClone(row.data) };
          const committed = operation(current);
          if (chain !== undefined) {
            const records = transaction.objectStore(CHAIN_STORE);
            if (chain.replace) {
              for (const existing of await request(records.index(CHAIN_BY_WALLET).getAllKeys(key))) records.delete(existing);
            }
            for (const [recordKey, value] of chain.writes) {
              if (value === null) records.delete([key, recordKey]);
              else records.put({ walletKey: key, recordKey, value: structuredClone(value) } satisfies IndexedDbChainRow);
            }
          }
          const revision = (row?.revision ?? -1) + 1;
          objectStore.put({
            walletKey: key,
            revision,
            data: structuredClone(committed.data),
          } satisfies IndexedDbWalletRow);
          await done;
          this.#notify(key);
          try {
            this.#channel.postMessage({ type: CHANGE_MESSAGE, walletKey: key, revision } satisfies WalletChangeMessage);
          } catch {
            // The commit is authoritative. A concurrent close may suppress its
            // invalidation hint but cannot turn a durable write into failure.
          }
          return committed.value;
        } catch (cause) {
          abort(transaction);
          await done.catch(() => undefined);
          throw cause;
        }
      },
      readChain: async (recordKeys?: readonly string[]): Promise<Map<string, unknown>> => {
        this.#assertOpen();
        const transaction = this.#database.transaction(CHAIN_STORE, "readonly");
        const done = completed(transaction);
        try {
          const records = transaction.objectStore(CHAIN_STORE);
          const rows = recordKeys === undefined
            ? await request(records.index(CHAIN_BY_WALLET).getAll(key)) as IndexedDbChainRow[]
            : (await Promise.all(recordKeys.map((recordKey) => request(records.get([key, recordKey])))))
              .filter((row): row is IndexedDbChainRow => row !== undefined);
          const result = new Map(rows.map((row) => [row.recordKey, row.value]));
          await done;
          return result;
        } catch (cause) {
          await done.catch(() => undefined);
          throw cause;
        }
      },
    };
  }

  [WALLET_DATABASE_STATE_STORE](identity: WalletStoreIdentity, label = "wallet database"): WalletStateStore {
    this.#assertOpen();
    const key = walletDatabaseKey(identity);
    let store = this.#stores.get(key);
    if (store === undefined) {
      store = walletStore(this.#backend(key), identity, label);
      this.#stores.set(key, store);
    }
    return store;
  }

  async subscribe(identity: WalletStoreIdentity, listener: () => void): Promise<() => Promise<void>> {
    this.#assertOpen();
    const key = walletDatabaseKey(identity);
    const listeners = this.#listeners.get(key) ?? new Set<() => void>();
    listeners.add(listener);
    this.#listeners.set(key, listeners);
    let active = true;
    return async () => {
      if (!active) return;
      active = false;
      const current = this.#listeners.get(key);
      current?.delete(listener);
      if (current?.size === 0) this.#listeners.delete(key);
    };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#listeners.clear();
    this.#channel.close();
    this.#database.close();
  }
}

function openIndexedDb(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const opening = indexedDB.open(name, DATABASE_VERSION);
    let settled = false;
    const fail = (cause: Error) => {
      if (settled) return;
      settled = true;
      reject(cause);
    };
    opening.onupgradeneeded = () => {
      const database = opening.result;
      if (!database.objectStoreNames.contains(WALLET_STORE)) {
        database.createObjectStore(WALLET_STORE, { keyPath: "walletKey" });
      }
      if (!database.objectStoreNames.contains(CHAIN_STORE)) {
        database.createObjectStore(CHAIN_STORE, { keyPath: ["walletKey", "recordKey"] })
          .createIndex(CHAIN_BY_WALLET, CHAIN_BY_WALLET);
      }
    };
    opening.onsuccess = () => {
      const database = opening.result;
      if (settled) {
        database.close();
        return;
      }
      if (!database.objectStoreNames.contains(WALLET_STORE) || !database.objectStoreNames.contains(CHAIN_STORE)) {
        database.close();
        fail(new Error("wallet IndexedDB has an invalid schema"));
        return;
      }
      settled = true;
      resolve(database);
    };
    opening.onerror = () => fail(opening.error ?? new Error("wallet IndexedDB could not be opened"));
    opening.onblocked = () => fail(new Error("wallet IndexedDB open is blocked by another tab"));
  });
}

/** Open the browser's canonical native IndexedDB wallet database. */
export async function openBrowserWalletDatabase(
  options: BrowserWalletDatabaseOptions,
): Promise<WalletDatabase> {
  if (!/^[A-Za-z0-9._-]+$/.test(options.name)) {
    throw new Error("wallet database name may contain only letters, digits, dot, underscore, and hyphen");
  }
  if (globalThis.indexedDB === undefined) throw new Error("browser wallet persistence requires IndexedDB");
  if (globalThis.BroadcastChannel === undefined) {
    throw new Error("browser wallet persistence requires BroadcastChannel");
  }
  const database = await openIndexedDb(options.name);
  try {
    return new IndexedDbWalletDatabase(database, options.name);
  } catch (cause) {
    database.close();
    throw cause;
  }
}

const acquireSharedDatabase = keyedResourcePool<WalletDatabase>((database) => database.close());

/** Acquire the origin-local native IndexedDB connection for a logical wallet database. */
export async function acquireBrowserWalletDatabase(
  options: BrowserWalletDatabaseOptions,
): Promise<{ database: WalletDatabase; release: () => Promise<void> }> {
  const lease = await acquireSharedDatabase(options.name, () => openBrowserWalletDatabase(options));
  return { database: lease.resource, release: lease.release };
}
