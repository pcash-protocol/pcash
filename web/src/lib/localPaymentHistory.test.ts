import { afterEach, describe, expect, it, vi } from "vitest";
import { localPaymentHistoryKey, readLocalPaymentHistory, rememberLocalPayments } from "./localPaymentHistory.ts";
afterEach(() => vi.unstubAllGlobals());
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
describe("locally recognized payments", () => {
  it("keeps known ownership after completion but no longer queues completed IDs", () => {
    const data = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => data.set(key, value) });
    const key = localPaymentHistoryKey({ pcashChainId: 1n, l1ChainId: 2n, genesisHash: hash(1) }, "0xAA");
    rememberLocalPayments(key, [hash(2)], []);
    rememberLocalPayments(key, [], [hash(2)]);
    expect(readLocalPaymentHistory(key)).toEqual({ known: [hash(2)], pending: [] });
    expect(readLocalPaymentHistory(localPaymentHistoryKey({ pcashChainId: 1n, l1ChainId: 2n, genesisHash: hash(1) }, "0xBB")).known).toEqual([]);
    expect(readLocalPaymentHistory(localPaymentHistoryKey({ pcashChainId: 1n, l1ChainId: 2n, genesisHash: hash(3) }, "0xAA")).known).toEqual([]);
    expect(readLocalPaymentHistory(localPaymentHistoryKey({ pcashChainId: 1n, l1ChainId: 3n, genesisHash: hash(1) }, "0xAA")).known).toEqual([]);
  });
  it("recognizes this session's payments even when browser storage is unavailable", () => {
    vi.stubGlobal("localStorage", { getItem() { throw new Error("disabled"); }, setItem() { throw new Error("disabled"); } });
    rememberLocalPayments("local-only-test", [hash(4)], []);
    expect(readLocalPaymentHistory("local-only-test")).toEqual({ known: [hash(4)], pending: [hash(4)] });
  });
});
