import type { MarketplaceOperationLock, MarketplaceStore, StoredOffer } from "@pcash/marketplace/app";

const DATABASE_VERSION = 1;
const OFFERS_STORE = "offers";
const STRICT_DURABILITY = { durability: "strict" } as const;

export const BROWSER_MARKETPLACE_OPERATION_LOCK: MarketplaceOperationLock = {
  run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    if (navigator.locks === undefined) {
      throw new Error("This browser cannot serialize Marketplace value-moving actions across tabs");
    }
    return navigator.locks.request(
      `pcash-marketplace:${key}`,
      { mode: "exclusive" },
      operation,
    ).then((result) => result);
  },
};

function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    value.onsuccess = () => resolve(value.result);
    value.onerror = () => reject(value.error ?? new Error("IndexedDB request failed"));
  });
}

function completed(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("Marketplace transaction aborted"));
    transaction.onerror = () => reject(transaction.error ?? new Error("Marketplace transaction failed"));
  });
}

function strictWriteTransaction(database: IDBDatabase, store: string): IDBTransaction {
  const transaction = database.transaction(store, "readwrite", STRICT_DURABILITY);
  if (transaction.durability !== "strict") {
    transaction.abort();
    throw new Error("browser Marketplace persistence requires strict IndexedDB durability");
  }
  return transaction;
}

export class IndexedDbMarketplaceStore implements MarketplaceStore {
  constructor(private readonly database: IDBDatabase) {}

  async list(): Promise<StoredOffer[]> {
    const transaction = this.database.transaction(OFFERS_STORE, "readonly");
    const values = await request<StoredOffer[]>(transaction.objectStore(OFFERS_STORE).getAll());
    await completed(transaction);
    return values.sort((left, right) => right.savedAt - left.savedAt || left.key.localeCompare(right.key));
  }

  async get(key: string): Promise<StoredOffer | null> {
    const transaction = this.database.transaction(OFFERS_STORE, "readonly");
    const value = await request<StoredOffer | undefined>(transaction.objectStore(OFFERS_STORE).get(key));
    await completed(transaction);
    return value ?? null;
  }

  async put(offer: StoredOffer): Promise<void> {
    const transaction = strictWriteTransaction(this.database, OFFERS_STORE);
    transaction.objectStore(OFFERS_STORE).put(offer);
    await completed(transaction);
  }

  async remove(key: string): Promise<void> {
    const transaction = strictWriteTransaction(this.database, OFFERS_STORE);
    transaction.objectStore(OFFERS_STORE).delete(key);
    await completed(transaction);
  }

  async clear(): Promise<void> {
    const transaction = strictWriteTransaction(this.database, OFFERS_STORE);
    transaction.objectStore(OFFERS_STORE).clear();
    await completed(transaction);
  }

  async update(
    key: string,
    operation: (current: StoredOffer | null) => StoredOffer | null,
  ): Promise<StoredOffer | null> {
    const transaction = strictWriteTransaction(this.database, OFFERS_STORE);
    const objectStore = transaction.objectStore(OFFERS_STORE);
    try {
      const current = await request<StoredOffer | undefined>(objectStore.get(key)) ?? null;
      const next = operation(current);
      if (next === null) objectStore.delete(key);
      else {
        if (next.key !== key) throw new Error("Marketplace update cannot change an offer key");
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

/** One marketplace database per network instance. */
export function marketplaceStoreName(networkInstance: string): string {
  return `pcash-web-marketplace:${networkInstance}`;
}

export function openMarketplaceStore(name = "pcash-web-marketplace"): Promise<IndexedDbMarketplaceStore> {
  return new Promise((resolve, reject) => {
    const opening = indexedDB.open(name, DATABASE_VERSION);
    opening.onupgradeneeded = () => {
      const database = opening.result;
      if (!database.objectStoreNames.contains(OFFERS_STORE)) database.createObjectStore(OFFERS_STORE, { keyPath: "key" });
    };
    opening.onsuccess = () => resolve(new IndexedDbMarketplaceStore(opening.result));
    opening.onerror = () => reject(opening.error ?? new Error("Marketplace IndexedDB could not be opened"));
    opening.onblocked = () => reject(new Error("Marketplace IndexedDB opening is blocked by another tab"));
  });
}
