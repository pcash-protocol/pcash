import {
  StoredRelayJournal,
  type RelayJournalEntry,
  type RelayJournalRecords,
} from "./journal.ts";
import {
  RelayJournalConflictError,
  RelayValidationError,
} from "./errors.ts";
import { idbRequest, idbTransactionDone } from "../utils/idb.ts";

const DATABASE_VERSION = 1;
const LATCHES = "latches";
const ARCHIVES = "archives";

function completed(transaction: IDBTransaction): Promise<void> {
  return idbTransactionDone(transaction, "relay journal");
}

function openDatabase(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (globalThis.indexedDB === undefined) {
      reject(new RelayJournalConflictError("IndexedDB is unavailable; browser relaying cannot fail closed"));
      return;
    }
    const opening = globalThis.indexedDB.open(name, DATABASE_VERSION);
    opening.onupgradeneeded = () => {
      const database = opening.result;
      if (!database.objectStoreNames.contains(LATCHES)) database.createObjectStore(LATCHES);
      if (!database.objectStoreNames.contains(ARCHIVES)) database.createObjectStore(ARCHIVES);
    };
    opening.onsuccess = () => resolve(opening.result);
    opening.onerror = () => reject(opening.error ?? new Error("relay journal IndexedDB could not be opened"));
    opening.onblocked = () => reject(new Error("relay journal IndexedDB upgrade is blocked by another tab"));
  });
}

class IndexedDbRecords implements RelayJournalRecords {
  readonly #databaseName: string;
  readonly #accountKey: string;
  #opening: Promise<IDBDatabase> | undefined;

  constructor(databaseName: string, accountKey: string) {
    this.#databaseName = databaseName;
    this.#accountKey = accountKey;
  }

  /** Open on first use; a failed open (for example a blocked upgrade) is retried next time. */
  #database(): Promise<IDBDatabase> {
    if (this.#opening === undefined) {
      const opening = openDatabase(this.#databaseName);
      this.#opening = opening;
      opening.catch(() => {
        if (this.#opening === opening) this.#opening = undefined;
      });
    }
    return this.#opening;
  }

  #key(key: string): string {
    return `${this.#accountKey}|${key}`;
  }

  async #write(stores: string[], body: (transaction: IDBTransaction) => Promise<void>): Promise<void> {
    const transaction = (await this.#database()).transaction(stores, "readwrite");
    try {
      await body(transaction);
      await completed(transaction);
    } catch (error) {
      try { transaction.abort(); } catch { /* it may already be aborted */ }
      throw error;
    }
  }

  /** This account's records. Keys and values list in the same key order, so they pair by index. */
  async list(): Promise<unknown[]> {
    const transaction = (await this.#database()).transaction(LATCHES, "readonly");
    const store = transaction.objectStore(LATCHES);
    const [keys, values] = await Promise.all([idbRequest(store.getAllKeys()), idbRequest(store.getAll())]);
    await completed(transaction);
    const prefix = this.#key("");
    return values.filter((_value, index) => String(keys[index]).startsWith(prefix));
  }

  async add(key: string, record: RelayJournalEntry): Promise<void> {
    try {
      await this.#write([LATCHES], async (transaction) => {
        await idbRequest(transaction.objectStore(LATCHES).add(structuredClone(record), this.#key(key)));
      });
    } catch (error) {
      throw new RelayJournalConflictError(`relay journal ${this.#accountKey} already holds ${key} or is unavailable`, error);
    }
  }

  async put(key: string, record: RelayJournalEntry): Promise<void> {
    await this.#write([LATCHES], async (transaction) => {
      await idbRequest(transaction.objectStore(LATCHES).put(structuredClone(record), this.#key(key)));
    });
  }

  async remove(key: string): Promise<void> {
    await this.#write([LATCHES], async (transaction) => {
      await idbRequest(transaction.objectStore(LATCHES).delete(this.#key(key)));
    });
  }

  async archive(key: string, record: RelayJournalEntry): Promise<string> {
    const archiveId = `${this.#key(key)}:${new Date().toISOString()}:${record.resolutionId}`;
    await this.#write([LATCHES, ARCHIVES], async (transaction) => {
      await idbRequest(transaction.objectStore(ARCHIVES).add({
        archivedAt: new Date().toISOString(),
        accountKey: this.#accountKey,
        entry: structuredClone(record),
      }, archiveId));
      await idbRequest(transaction.objectStore(LATCHES).delete(this.#key(key)));
    });
    return `indexeddb://${archiveId}`;
  }

  async close(): Promise<void> {
    if (this.#opening === undefined) return;
    const opening = this.#opening;
    this.#opening = undefined;
    (await opening).close();
  }
}

export interface IndexedDbRelayJournalConfig {
  /** Database shared by this origin's relayer instances. */
  databaseName?: string;
  /** Network-and-account scope of this journal's entries. */
  accountKey: string;
}

/** Browser journal: every tab of the origin shares its entries, and IndexedDB's atomic add holds each nonce. */
export class IndexedDbRelayJournal extends StoredRelayJournal {
  readonly #records: IndexedDbRecords;

  constructor(config: IndexedDbRelayJournalConfig) {
    if (config.accountKey.trim() === "") {
      throw new RelayValidationError("relay journal accountKey must not be empty");
    }
    const records = new IndexedDbRecords(config.databaseName ?? "pcash-relayer", config.accountKey);
    super(`relay journal ${config.accountKey}`, records);
    this.#records = records;
  }

  close(): Promise<void> {
    return this.#records.close();
  }
}

/** Stable journal key for one connected account on one PCASH network. */
export function browserRelayJournalKey(
  network: { pcashChainId: number | bigint; l1ChainId: number | bigint; genesisHash: string },
  address: string,
): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    throw new RelayValidationError("browser relay address must be 20-byte hex");
  }
  return `${network.pcashChainId}:${network.l1ChainId}:${network.genesisHash.toLowerCase()}:${address.toLowerCase()}`;
}
