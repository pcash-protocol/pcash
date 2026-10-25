import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it } from "vitest";
import type { StoredOffer } from "@pcash/marketplace/app";
import offerFixture from "./fixtures/marketplaceStoreOffer.json";
import { openMarketplaceStore } from "./MarketplaceStore.ts";

function offer(): StoredOffer {
  return structuredClone(offerFixture) as StoredOffer;
}

beforeEach(() => {
  Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: new IDBFactory() });
});

describe("IndexedDB Marketplace store", () => {
  it("stores typed offers and updates from the latest durable value", async () => {
    const store = await openMarketplaceStore("marketplace-store-test");
    try {
      const initial = offer();
      await store.put(initial);
      initial.savedAt = 9;
      expect((await store.get(initial.key))?.savedAt).toBe(1);
      const result = await store.update(initial.key, (current) => ({ ...current!, savedAt: 2 }));
      expect(result?.savedAt).toBe(2);
      result!.savedAt = 8;
      expect((await store.list()).map((item) => item.savedAt)).toEqual([2]);
      await store.update(initial.key, () => null);
      expect(await store.get(initial.key)).toBeNull();
    } finally {
      store.close();
    }
  });

  it("aborts a key-changing update without changing the stored offer", async () => {
    const store = await openMarketplaceStore("marketplace-store-test");
    try {
      const initial = offer();
      await store.put(initial);
      await expect(store.update(initial.key, (current) => ({ ...current!, key: "other" })))
        .rejects.toThrow(/cannot change an offer key/);
      expect(await store.get(initial.key)).toEqual(initial);
    } finally {
      store.close();
    }
  });
});
