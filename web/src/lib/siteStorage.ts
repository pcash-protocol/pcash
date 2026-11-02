const LOCK_NAME = "pcash-site-storage";
const FRESH_START_KEY = "pcash-dev-fresh-start";
const CLEAR_REQUEST_KEY = "pcash-clear-site-data";

/** Delete every IndexedDB database, Cache Storage entry, and localStorage value for this origin. */
async function deleteSharedStorage(): Promise<void> {
  const databases = await indexedDB.databases();
  await Promise.all(databases.map(({ name }) => new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name!);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error(
      "Close other PCASH tabs, then reload to finish clearing site data.",
    ));
  })));
  if (globalThis.caches) {
    await Promise.all((await caches.keys()).map((name) => caches.delete(name)));
  }
  localStorage.clear();
}

/** Reset this development origin once per server start, before opening any stores. */
export async function resetDevelopmentStorage(start: string): Promise<void> {
  // Tabs share IndexedDB and localStorage; serialize their startup resets.
  await navigator.locks.request(LOCK_NAME, async () => {
    if (localStorage.getItem(FRESH_START_KEY) !== start) {
      await deleteSharedStorage();
      localStorage.setItem(FRESH_START_KEY, start);
    }
    // Session storage belongs to each tab and needs its own startup marker.
    if (sessionStorage.getItem(FRESH_START_KEY) !== start) {
      sessionStorage.clear();
      sessionStorage.setItem(FRESH_START_KEY, start);
    }
  });
}

/**
 * Reload and delete everything this website stores in the browser. Open pages
 * hold IndexedDB connections that block deletion, so the next page load clears
 * storage before any provider opens it.
 */
export function requestSiteDataClear(): void {
  localStorage.setItem(CLEAR_REQUEST_KEY, "requested");
  location.reload();
}

function clearRequested(): boolean {
  try {
    return localStorage.getItem(CLEAR_REQUEST_KEY) !== null;
  } catch {
    return false; // Unavailable storage holds nothing to clear.
  }
}

/** Finish a requested clear before any provider opens browser storage. */
export async function clearRequestedSiteData(): Promise<void> {
  if (!clearRequested()) return;
  await navigator.locks.request(LOCK_NAME, async () => {
    // Another tab may have finished the clear while this one waited.
    if (!clearRequested()) return;
    // The request survives a blocked deletion, so the next reload retries it.
    await deleteSharedStorage();
    sessionStorage.clear();
  });
}
