import type { TokensRecord, TokensStore } from "@pcash/tokens/app";

const DATABASE_VERSION = 1;
const RECORDS_STORE = "records";
const STRICT_DURABILITY = { durability: "strict" } as const;

function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    value.onsuccess = () => resolve(value.result);
    value.onerror = () => reject(value.error ?? new Error("IndexedDB request failed"));
  });
}

function completed(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("Token record transaction aborted"));
    transaction.onerror = () => reject(transaction.error ?? new Error("Token record transaction failed"));
  });
}

/** Link sets and drops this browser's wallets created, including their creator recovery material. */
export class IndexedDbTokensStore implements TokensStore {
  constructor(private readonly database: IDBDatabase) {}

  async list(): Promise<TokensRecord[]> {
    const transaction = this.database.transaction(RECORDS_STORE, "readonly");
    const values = await request(transaction.objectStore(RECORDS_STORE).getAll()) as TokensRecord[];
    await completed(transaction);
    return values;
  }

  async get(key: string): Promise<TokensRecord | null> {
    const transaction = this.database.transaction(RECORDS_STORE, "readonly");
    const value = await request(transaction.objectStore(RECORDS_STORE).get(key)) as TokensRecord | undefined;
    await completed(transaction);
    return value ?? null;
  }

  async update(key: string, operation: (current: TokensRecord | null) => TokensRecord | null): Promise<TokensRecord | null> {
    // A record journals a step before it is broadcast, so it must reach disk before the step runs.
    const transaction = this.database.transaction(RECORDS_STORE, "readwrite", STRICT_DURABILITY);
    const objectStore = transaction.objectStore(RECORDS_STORE);
    try {
      const value = await request(objectStore.get(key)) as TokensRecord | undefined;
      const next = operation(value ?? null);
      if (next === null) objectStore.delete(key);
      else {
        if (next.key !== key) throw new Error("A token record update cannot change its key");
        objectStore.put(next);
      }
      await completed(transaction);
      return next === null ? null : structuredClone(next);
    } catch (cause) {
      transaction.abort();
      throw cause;
    }
  }

  close(): void {
    this.database.close();
  }
}

export function openTokensStore(name = "pcash-web-tokens"): Promise<IndexedDbTokensStore> {
  return new Promise((resolve, reject) => {
    const opening = indexedDB.open(name, DATABASE_VERSION);
    opening.onupgradeneeded = () => {
      const database = opening.result;
      if (!database.objectStoreNames.contains(RECORDS_STORE)) database.createObjectStore(RECORDS_STORE, { keyPath: "key" });
    };
    opening.onsuccess = () => resolve(new IndexedDbTokensStore(opening.result));
    opening.onerror = () => reject(opening.error ?? new Error("Token records could not be opened"));
    opening.onblocked = () => reject(new Error("Token records are blocked by another tab"));
  });
}
