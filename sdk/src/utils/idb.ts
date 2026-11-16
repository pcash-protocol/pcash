// Promise adapters for IndexedDB requests and transactions.

export function idbRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

/** Settle once the transaction commits; reject when it fails or aborts. */
export function idbTransactionDone(transaction: IDBTransaction, label = "IndexedDB"): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error(`${label} transaction aborted`));
    transaction.onerror = () => reject(transaction.error ?? new Error(`${label} transaction failed`));
  });
}
