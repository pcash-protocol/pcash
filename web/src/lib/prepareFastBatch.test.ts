import { beforeEach, expect, it, vi } from "vitest";
import type { L1SubmissionAdapter } from "@pcash/sdk/wallet";
import type { PcashNodeClient, StatusResult } from "@pcash/sdk/clients";
import { transactionIdentity } from "@pcash/sdk/browser";
const mocks = vi.hoisted(() => ({ plan: vi.fn() }));
vi.mock("./fastBatch.ts", () => ({ planFastBatch: mocks.plan }));
import { prepareFastBatch } from "./prepareFastBatch.ts";

const entry = Uint8Array.of(1, 2);
const additionalTransactions = [Uint8Array.of(3, 4), Uint8Array.of(5, 6)];
const context = { transactionBytes: entry, additionalTransactions, contentHash: transactionIdentity(entry).contentHash, status: {} as StatusResult, retry: false };
const options = { node: {} as PcashNodeClient, profile: { address: 1n, nkRoot: 2n }, ownPendingContentHashes: ["0xown"] };
const companions = { transactions: [Uint8Array.of(7, 8)], collectibleOpenFee: 5n, collectibleOpenFees: [5n] };
const own = [Uint8Array.of(9)];
beforeEach(() => mocks.plan.mockReset().mockResolvedValue({ own, companions }));

it("reserves all selected claims, excludes them from the optional mempool selection, and requires own pending entries after them", async () => {
  const preflight = vi.fn().mockResolvedValue("prepared");
  await prepareFastBatch({ preflight } as unknown as L1SubmissionAdapter, context, options);
  expect(mocks.plan).toHaveBeenCalledWith(expect.objectContaining({ requiredTransactionCount: 3, transactionByteSize: 6n,
    excludeContentHashes: [entry, ...additionalTransactions].map(entry => transactionIdentity(entry).contentHash), ownPendingContentHashes: ["0xown"] }));
  expect(preflight).toHaveBeenCalledWith({ ...context, additionalTransactions: [...additionalTransactions, ...own], companions });
});

it("leaves out entries an unsettled batch from this account already carries", async () => {
  const preflight = vi.fn().mockResolvedValue("prepared");
  const l1Recovery = async () => ({ show: async () => ({ latched: true, entries: [
    { kind: "batch", selected: ["0xFLYING"] }, { kind: "call" },
  ] }) });
  await prepareFastBatch({ preflight, l1Recovery } as unknown as L1SubmissionAdapter, context, options);
  expect(mocks.plan).toHaveBeenCalledWith(expect.objectContaining({
    excludeContentHashes: [...[entry, ...additionalTransactions].map(entry => transactionIdentity(entry).contentHash), "0xflying"] }));
});

it.each(["planner", "preflight"])("preserves every required claim when optional %s fails", async stage => {
  const preflight = vi.fn().mockResolvedValue("prepared");
  if (stage === "planner") mocks.plan.mockRejectedValueOnce(new Error("Offline"));
  else preflight.mockRejectedValueOnce(new Error("Conflicting companion"));
  expect(await prepareFastBatch({ preflight } as unknown as L1SubmissionAdapter, context, options)).toBe("prepared");
  expect(preflight).toHaveBeenLastCalledWith({ ...context, companions: { transactions: [], collectibleOpenFee: 0n, collectibleOpenFees: [] } });
});
