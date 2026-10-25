import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearRequestedSiteData, requestSiteDataClear, resetDevelopmentStorage } from "./siteStorage.ts";

async function openStore(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name);
    request.onupgradeneeded = () => request.result.createObjectStore("state");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

beforeEach(() => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  let pending = Promise.resolve();
  vi.stubGlobal("navigator", { locks: {
    request: (_name: string, callback: () => Promise<void>) => {
      const result = pending.then(callback);
      pending = result.catch(() => {});
      return result;
    },
  } });
  for (const name of ["localStorage", "sessionStorage"]) {
    const values = new Map<string, string>();
    vi.stubGlobal(name, {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      clear: () => values.clear(),
    });
  }
});

afterEach(() => vi.unstubAllGlobals());

it("clears previous network stores and browser state, then preserves state until the next startup", async () => {
  for (const name of ["pcash-web-marketplace", "pcash-wallet-state", "pcash-profile-session", "pcash-prover-crs"]) {
    (await openStore(name)).close();
  }
  localStorage.setItem("sign-in", "old");
  sessionStorage.setItem("relay-history", "old");
  const cacheDelete = vi.fn(async () => true);
  vi.stubGlobal("caches", { keys: async () => ["prover"], delete: cacheDelete });

  await resetDevelopmentStorage("first-start");
  expect(await indexedDB.databases()).toEqual([]);
  expect(localStorage.getItem("sign-in")).toBeNull();
  expect(sessionStorage.getItem("relay-history")).toBeNull();
  expect(cacheDelete).toHaveBeenCalledWith("prover");

  (await openStore("pcash-web-marketplace")).close();
  localStorage.setItem("sign-in", "new");
  sessionStorage.setItem("relay-history", "new");
  await Promise.all([resetDevelopmentStorage("first-start"), resetDevelopmentStorage("first-start")]);
  expect(await indexedDB.databases()).toHaveLength(1);
  expect(localStorage.getItem("sign-in")).toBe("new");
  expect(sessionStorage.getItem("relay-history")).toBe("new");
  expect(cacheDelete).toHaveBeenCalledTimes(1);

  await resetDevelopmentStorage("second-start");
  expect(await indexedDB.databases()).toEqual([]);
  expect(localStorage.getItem("sign-in")).toBeNull();
  expect(sessionStorage.getItem("relay-history")).toBeNull();
});

it("clears a second tab's old session without deleting shared state again", async () => {
  await resetDevelopmentStorage("start");
  (await openStore("pcash-wallet-state")).close();
  sessionStorage.clear();
  sessionStorage.setItem("relay-history", "old-tab");
  await resetDevelopmentStorage("start");
  expect(sessionStorage.getItem("relay-history")).toBeNull();
  expect(await indexedDB.databases()).toHaveLength(1);
});

it("stops startup when another tab blocks deletion and allows retry after it closes", async () => {
  const connection = await openStore("pcash-web-marketplace");
  await expect(resetDevelopmentStorage("start")).rejects.toThrow("Close other PCASH tabs");
  connection.close();
  await resetDevelopmentStorage("start");
  expect(await indexedDB.databases()).toEqual([]);
});

it("does nothing at startup unless a clear was requested", async () => {
  (await openStore("pcash-wallet-state")).close();
  localStorage.setItem("sign-in", "kept");
  sessionStorage.setItem("relay-history", "kept");
  vi.stubGlobal("navigator", {});
  await clearRequestedSiteData();
  expect(await indexedDB.databases()).toHaveLength(1);
  expect(localStorage.getItem("sign-in")).toBe("kept");
  expect(sessionStorage.getItem("relay-history")).toBe("kept");
});

it("starts normally when browser storage is unavailable", async () => {
  vi.stubGlobal("localStorage", { getItem: () => { throw new DOMException("blocked", "SecurityError"); } });
  await expect(clearRequestedSiteData()).resolves.toBeUndefined();
});

it("reloads to clear, then deletes every store before the app opens", async () => {
  const reload = vi.fn();
  vi.stubGlobal("location", { reload });
  for (const name of ["pcash-wallet-state", "pcash-profile-session", "pcash-prover-crs"]) {
    (await openStore(name)).close();
  }
  localStorage.setItem("sign-in", "old");
  sessionStorage.setItem("relay-history", "old");
  const cacheDelete = vi.fn(async () => true);
  vi.stubGlobal("caches", { keys: async () => ["prover"], delete: cacheDelete });

  requestSiteDataClear();
  expect(reload).toHaveBeenCalledOnce();
  expect(await indexedDB.databases()).toHaveLength(3);

  await clearRequestedSiteData();
  expect(await indexedDB.databases()).toEqual([]);
  expect(cacheDelete).toHaveBeenCalledWith("prover");
  expect(localStorage.getItem("sign-in")).toBeNull();
  expect(sessionStorage.getItem("relay-history")).toBeNull();

  (await openStore("pcash-wallet-state")).close();
  await clearRequestedSiteData();
  expect(await indexedDB.databases()).toHaveLength(1);
});

it("keeps a blocked clear requested until another tab closes", async () => {
  vi.stubGlobal("location", { reload: vi.fn() });
  const connection = await openStore("pcash-wallet-state");
  localStorage.setItem("sign-in", "old");
  requestSiteDataClear();
  await expect(clearRequestedSiteData()).rejects.toThrow("Close other PCASH tabs");
  expect(localStorage.getItem("sign-in")).toBe("old");
  connection.close();
  await clearRequestedSiteData();
  expect(await indexedDB.databases()).toEqual([]);
  expect(localStorage.getItem("sign-in")).toBeNull();
});
