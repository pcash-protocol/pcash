import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it } from "vitest";
import type { LinkSetRecord } from "@pcash/tokens/app";
import { openTokensStore } from "./TokensStore.ts";

const record: LinkSetRecord = {
  kind: "links", key: "links:1:0xabc:0x01", chainId: "1", creator: "0xabc", assetId: "7", definition: "AQ",
  nonce: "0x01", amounts: ["10", "20"], createdAt: 1, updatedAt: 1,
};

describe("IndexedDB token records", () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: new IDBFactory() });
  });

  it("stores, updates from the latest value, and removes records across openings", async () => {
    const store = await openTokensStore();
    expect(await store.update(record.key, () => record)).toEqual(record);
    expect(await store.update(record.key, (current) => ({ ...current!, fundingJobId: "job" } as LinkSetRecord))).toMatchObject({ fundingJobId: "job" });
    store.close();
    const reopened = await openTokensStore();
    expect(await reopened.get(record.key)).toMatchObject({ fundingJobId: "job", amounts: ["10", "20"] });
    expect(await reopened.list()).toHaveLength(1);
    expect(await reopened.update(record.key, () => null)).toBeNull();
    expect(await reopened.get(record.key)).toBeNull();
  });

  it("refuses an update that changes the key and keeps the stored record", async () => {
    const store = await openTokensStore();
    await store.update(record.key, () => record);
    await expect(store.update(record.key, (current) => ({ ...current!, key: "other" }))).rejects.toThrow(/cannot change its key/);
    expect(await store.get(record.key)).toEqual(record);
  });
});
