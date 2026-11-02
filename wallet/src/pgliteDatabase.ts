// Node PGlite persistence for wallet state.
//
// One row holds one wallet: the engine reads, edits, and replaces the whole
// typed document in a single short transaction, so the row stores that document
// and nothing else. The wallet's local chain store lives beside it as one row
// per record, written in the same transaction as the document.
// The adapter stores the document `store.ts` hands down and returns it as
// stored; it never parses the schema.

import type { PGliteInterface, Transaction } from "@electric-sql/pglite";
import {
  WALLET_DATABASE_STATE_STORE,
  walletDatabaseKey,
  walletStore,
  type ChainCommit,
  type WalletDatabase,
  type WalletStateStore,
  type WalletStoreBackend,
  type WalletStoreBackendCommit,
  type WalletStoreBackendRecord,
  type WalletStoreIdentity,
  type WalletStorageCipher,
} from "@pcash/sdk/wallet/database";

const CHANGE_CHANNEL = "pcash_wallet_changed";

type SqlExecutor = Pick<PGliteInterface, "query" | "exec"> | Transaction;

const schemaByClient = new WeakMap<object, Promise<void>>();

function schema(client: PGliteInterface): Promise<void> {
  const identity = client as object;
  const existing = schemaByClient.get(identity);
  if (existing !== undefined) return existing;
  // wallet_key already carries (chainId, genesisHash, address), and the stored
  // document carries them too and is identity-checked on every read and write.
  // Mirroring them into columns would be a second source of truth for nothing.
  const initializing = client.exec(`
    CREATE TABLE IF NOT EXISTS pcash_wallet_state (
      wallet_key TEXT PRIMARY KEY,
      revision   BIGINT NOT NULL,
      state      JSONB NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pcash_wallet_chain (
      wallet_key TEXT NOT NULL,
      record_key TEXT NOT NULL,
      value      JSONB NOT NULL,
      PRIMARY KEY (wallet_key, record_key)
    );
    CREATE TABLE IF NOT EXISTS pcash_wallet_storage (
      singleton BOOLEAN PRIMARY KEY CHECK (singleton),
      cipher_id TEXT NOT NULL
    );
  `).then(() => undefined);
  schemaByClient.set(identity, initializing);
  return initializing;
}

const storageByClient = new WeakMap<object, { id: string; ready: Promise<void> }>();

/** Check the configured vault once when opening a database, before any wallet writes. */
function configureStorage(client: PGliteInterface, cipher?: WalletStorageCipher): Promise<void> {
  const id = cipher?.id ?? "plaintext";
  const existing = storageByClient.get(client);
  if (existing !== undefined) {
    if (existing.id !== id) return Promise.reject(new Error("wallet database belongs to a different vault"));
    return existing.ready;
  }
  const ready = schema(client).then(() => client.transaction(async (tx) => {
    const stored = await tx.query<{ cipher_id: string }>("SELECT cipher_id FROM pcash_wallet_storage WHERE singleton");
    const row = stored.rows[0];
    if (row !== undefined) {
      if (row.cipher_id !== id) throw new Error("wallet database belongs to a different vault or storage mode");
      return;
    }
    if (cipher !== undefined) {
      const occupied = await tx.query<{ present: boolean }>(
        "SELECT EXISTS (SELECT 1 FROM pcash_wallet_state) OR EXISTS (SELECT 1 FROM pcash_wallet_chain) AS present",
      );
      if (occupied.rows[0]!.present) throw new Error("encrypted wallets require a new database; plaintext storage cannot be imported");
    }
    await tx.query("INSERT INTO pcash_wallet_storage (singleton, cipher_id) VALUES (true, $1)", [id]);
  }));
  const entry = { id, ready };
  storageByClient.set(client, entry);
  void ready.catch(() => { if (storageByClient.get(client) === entry) storageByClient.delete(client); });
  return ready;
}

function walletKey(key: string, cipher?: WalletStorageCipher): string {
  return cipher?.index(JSON.stringify(["wallet", key])) ?? key;
}

function chainKey(wallet: string, key: string, cipher?: WalletStorageCipher): string {
  return cipher?.index(JSON.stringify(["chain", wallet, key])) ?? key;
}

interface StateRow {
  revision: string | number | bigint;
  state: unknown;
}

async function readState(executor: SqlExecutor, key: string, cipher?: WalletStorageCipher): Promise<WalletStoreBackendRecord | null> {
  const result = await executor.query<StateRow>(
    "SELECT revision, state FROM pcash_wallet_state WHERE wallet_key = $1",
    [walletKey(key, cipher)],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  const revision = Number(row.revision);
  return { revision, data: cipher === undefined ? row.state : cipher.decode(row.state, JSON.stringify(["state", key, revision])) };
}

async function writeState(tx: Transaction, key: string, revision: number, data: unknown, cipher?: WalletStorageCipher): Promise<void> {
  const storedKey = walletKey(key, cipher);
  const stored = cipher === undefined ? data : cipher.encode(data, JSON.stringify(["state", key, revision]));
  await tx.query(
    `INSERT INTO pcash_wallet_state (wallet_key, revision, state)
     VALUES ($1, $2, $3::jsonb)
     ON CONFLICT (wallet_key) DO UPDATE SET
       revision = EXCLUDED.revision,
       state = EXCLUDED.state`,
    [storedKey, revision, JSON.stringify(stored)],
  );
  await tx.query(`SELECT pg_notify('${CHANGE_CHANNEL}', $1)`, [storedKey]);
}

const CHAIN_WRITE_BATCH = 500;

async function writeChain(tx: Transaction, key: string, commit: ChainCommit, cipher?: WalletStorageCipher): Promise<void> {
  const storedKey = walletKey(key, cipher);
  if (commit.replace) {
    await tx.query("DELETE FROM pcash_wallet_chain WHERE wallet_key = $1", [storedKey]);
  }
  const deleted: string[] = [];
  const upserted: Array<[string, string]> = [];
  for (const [recordKey, value] of commit.writes) {
    const recordIndex = chainKey(key, recordKey, cipher);
    if (value === null) deleted.push(recordIndex);
    else upserted.push([recordIndex, JSON.stringify(cipher === undefined ? value
      : cipher.encode([recordKey, value], JSON.stringify(["chain", key, recordIndex])))]);
  }
  if (deleted.length !== 0) {
    await tx.query(
      "DELETE FROM pcash_wallet_chain WHERE wallet_key = $1 AND record_key = ANY($2::text[])",
      [storedKey, deleted],
    );
  }
  for (let offset = 0; offset < upserted.length; offset += CHAIN_WRITE_BATCH) {
    const batch = upserted.slice(offset, offset + CHAIN_WRITE_BATCH);
    await tx.query(
      `INSERT INTO pcash_wallet_chain (wallet_key, record_key, value)
       SELECT $1, record_key, value::jsonb FROM unnest($2::text[], $3::text[]) AS rows(record_key, value)
       ON CONFLICT (wallet_key, record_key) DO UPDATE SET value = EXCLUDED.value`,
      [storedKey, batch.map(([recordKey]) => recordKey), batch.map(([, value]) => value)],
    );
  }
}

async function readChain(
  executor: SqlExecutor,
  key: string,
  recordKeys?: readonly string[],
  cipher?: WalletStorageCipher,
): Promise<Map<string, unknown>> {
  const result = recordKeys === undefined
    ? await executor.query<{ record_key: string; value: unknown }>(
      "SELECT record_key, value FROM pcash_wallet_chain WHERE wallet_key = $1",
      [walletKey(key, cipher)],
    )
    : await executor.query<{ record_key: string; value: unknown }>(
      "SELECT record_key, value FROM pcash_wallet_chain WHERE wallet_key = $1 AND record_key = ANY($2::text[])",
      [walletKey(key, cipher), recordKeys.map((recordKey) => chainKey(key, recordKey, cipher))],
    );
  return new Map(result.rows.map((row): [string, unknown] => cipher === undefined ? [row.record_key, row.value]
    : cipher.decode(row.value, JSON.stringify(["chain", key, row.record_key])) as [string, unknown]));
}

/** Bind the existing wallet transaction contract to one PGlite row. */
export function pgliteWalletStoreBackend(
  clientValue: PGliteInterface | Promise<PGliteInterface>,
  key: string,
  cipher?: WalletStorageCipher,
): WalletStoreBackend {
  let initialized: Promise<PGliteInterface> | undefined;
  const client = () => initialized ??= Promise.resolve(clientValue).then(async (database) => {
    await configureStorage(database, cipher);
    return database;
  });
  return {
    async read(): Promise<WalletStoreBackendRecord | null> {
      const database = await client();
      // One row, one statement: a reader cannot observe a partial revision, and
      // the returned document is decoded fresh from storage on every read.
      return readState(database, key, cipher);
    },
    async transaction<T>(
      operation: (current: WalletStoreBackendRecord | null) => WalletStoreBackendCommit<T>,
      chain?: ChainCommit,
    ): Promise<T> {
      const database = await client();
      return database.transaction(async (tx) => {
        const current = await readState(tx, key, cipher);
        const committed = operation(current);
        if (chain !== undefined) await writeChain(tx, key, chain, cipher);
        await writeState(tx, key, (current?.revision ?? -1) + 1, committed.data, cipher);
        return committed.value;
      });
    },
    async readChain(recordKeys?: readonly string[]): Promise<Map<string, unknown>> {
      const database = await client();
      return readChain(database, key, recordKeys, cipher);
    },
  };
}

interface PGliteWalletDatabaseOptions {
  /** Close the PGlite connection when this database is closed. */
  ownsClient?: boolean;
  cipher?: WalletStorageCipher;
}

/** Shared database handle. Create one per data directory and bind any number of wallets to it. */
export class PGliteWalletDatabase implements WalletDatabase {
  readonly #client: PGliteInterface;
  readonly #ownsClient: boolean;
  readonly #cipher: WalletStorageCipher | undefined;
  readonly #listeners = new Map<string, Set<() => void>>();
  // One store per wallet slot, so every caller shares its local chain cache and lock.
  readonly #stores = new Map<string, WalletStateStore>();
  #unlistenPromise: Promise<() => Promise<void>> | undefined;
  #closed = false;

  private constructor(client: PGliteInterface, options: PGliteWalletDatabaseOptions) {
    this.#client = client;
    this.#ownsClient = options.ownsClient === true;
    this.#cipher = options.cipher;
  }

  static async open(
    client: PGliteInterface,
    options: PGliteWalletDatabaseOptions = {},
  ): Promise<PGliteWalletDatabase> {
    await client.waitReady;
    await configureStorage(client, options.cipher);
    return new PGliteWalletDatabase(client, options);
  }

  [WALLET_DATABASE_STATE_STORE](identity: WalletStoreIdentity, label = "wallet database"): WalletStateStore {
    if (this.#closed) throw new Error("wallet database is closed");
    const key = walletDatabaseKey(identity);
    let store = this.#stores.get(key);
    if (store === undefined) {
      store = walletStore(pgliteWalletStoreBackend(this.#client, key, this.#cipher), identity, label);
      this.#stores.set(key, store);
    }
    return store;
  }

  async #listen(): Promise<() => Promise<void>> {
    let listening = this.#unlistenPromise;
    if (listening === undefined) {
      listening = this.#client.listen(CHANGE_CHANNEL, (payload) => {
        for (const callback of this.#listeners.get(payload) ?? []) {
          try {
            callback();
          } catch {
            // A subscriber cannot roll back or poison the durable operation.
          }
        }
      });
      this.#unlistenPromise = listening;
    }
    try {
      return await listening;
    } catch (error) {
      if (this.#unlistenPromise === listening) this.#unlistenPromise = undefined;
      throw error;
    }
  }

  async subscribe(identity: WalletStoreIdentity, listener: () => void): Promise<() => Promise<void>> {
    if (this.#closed) throw new Error("wallet database is closed");
    const key = walletKey(walletDatabaseKey(identity), this.#cipher);
    let listeners = this.#listeners.get(key);
    if (listeners === undefined) {
      listeners = new Set();
      this.#listeners.set(key, listeners);
    }
    listeners.add(listener);
    try {
      await this.#listen();
      if (this.#closed) throw new Error("wallet database is closed");
    } catch (error) {
      listeners.delete(listener);
      if (listeners.size === 0) this.#listeners.delete(key);
      throw error;
    }
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
    const listening = this.#unlistenPromise;
    this.#unlistenPromise = undefined;
    const unlisten = await listening?.catch(() => undefined);
    if (unlisten !== undefined) await unlisten();
    if (this.#ownsClient && !this.#client.closed) await this.#client.close();
  }
}
