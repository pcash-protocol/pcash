import { beforeEach, expect, it, vi } from "vitest";
import type { PcashNodeClient, StatusResult } from "@pcash/sdk/clients";
import type { L1SubmissionAdapter } from "@pcash/sdk/wallet";
const mocks = vi.hoisted(() => ({ receipt: vi.fn(), plan: vi.fn() }));
vi.mock("@pcash/sdk/clients", async (original) => ({ ...await original<object>(), pollReceipt: mocks.receipt }));
vi.mock("./fastBatch.ts", () => ({ planFastBatch: mocks.plan }));
import { finalizeMempoolTransaction } from "./finalizeMempoolTransaction.ts";

const companions = { transactions: [Uint8Array.of(2)], collectibleOpenFee: 3n, collectibleOpenFees: [3n] };
const empty = { transactions: [], collectibleOpenFee: 0n, collectibleOpenFees: [] };
// keccak256 of the pending transaction bytes 0x0102.
const pendingContentHash = "0x22ae6da6b482f9b1b19b0b897c3fd43884180a1c5ee361e1107a1bc635649dda";
function setup() {
  const getMempoolTransaction = vi.fn().mockResolvedValue({ status: "ready", kind: "privateValue", rawTransaction: "0x0102" });
  const prepared = {};
  const preflight = vi.fn().mockResolvedValue(prepared);
  const submit = vi.fn().mockResolvedValue({ l1Hash: "0xhash" });
  const args = {
    node: { getMempoolTransaction } as unknown as PcashNodeClient,
    readStatus: vi.fn().mockResolvedValue({ pcashChainId: 1 } as StatusResult),
    submission: { preflight, submit } as unknown as L1SubmissionAdapter,
    contentHash: pendingContentHash, profile: { address: 1n, nkRoot: 3n },
    ownPendingContentHashes: [pendingContentHash], assertActive: vi.fn(), onL1Submitted: vi.fn(),
  };
  return { args, prepared, preflight, submit, getMempoolTransaction };
}
beforeEach(() => {
  mocks.receipt.mockReset().mockResolvedValue(null);
  mocks.plan.mockReset().mockResolvedValue({ own: [], companions });
});

it("finalizes the exact pending bytes with the selected companions", async () => {
  const { args, prepared, preflight, submit } = setup();
  await finalizeMempoolTransaction(args);
  expect(mocks.plan).toHaveBeenCalledWith(expect.objectContaining({ excludeContentHashes: [args.contentHash], transactionByteSize: 2n, actionQualifies: true }));
  expect(preflight).toHaveBeenCalledWith(expect.objectContaining({ transactionBytes: Uint8Array.of(1, 2), contentHash: args.contentHash, retry: true, companions }));
  expect(submit).toHaveBeenCalledWith(expect.objectContaining({ contentHash: args.contentHash, prepared, onL1Submitted: args.onL1Submitted }));
});

it.each(["planner", "quote"])("retains the pending action when the %s fails", async stage => {
  const { args, preflight, submit } = setup();
  if (stage === "planner") mocks.plan.mockRejectedValueOnce(new Error("Unavailable"));
  else preflight.mockRejectedValueOnce(new Error("Companion expired"));
  await finalizeMempoolTransaction(args);
  expect(preflight).toHaveBeenLastCalledWith(expect.objectContaining({ contentHash: args.contentHash, companions: empty }));
  expect(submit).toHaveBeenCalledOnce();
});

it("does not publish an already accepted transaction", async () => {
  const { args, getMempoolTransaction, submit } = setup();
  mocks.receipt.mockResolvedValue({ outcome: "succeeded" });
  await finalizeMempoolTransaction(args);
  expect(getMempoolTransaction).not.toHaveBeenCalled();
  expect(submit).not.toHaveBeenCalled();
});

it("does not publish bytes that do not hash to the pending transaction", async () => {
  const { args, getMempoolTransaction, submit } = setup();
  getMempoolTransaction.mockResolvedValue({ status: "ready", kind: "privateValue", rawTransaction: "0x0103" });
  await expect(finalizeMempoolTransaction(args)).rejects.toThrow("different bytes");
  expect(mocks.plan).not.toHaveBeenCalled();
  expect(submit).not.toHaveBeenCalled();
});

it("does not publish a non-ready transaction reported by the node", async () => {
  const { args, getMempoolTransaction, submit } = setup();
  getMempoolTransaction.mockResolvedValue({ status: "conflicted", rawTransaction: "0x0102" });
  await expect(finalizeMempoolTransaction(args)).rejects.toThrow("no longer ready");
  expect(submit).not.toHaveBeenCalled();
});

it("stops before sending if the wallet changes during preparation", async () => {
  const { args, preflight, submit } = setup();
  preflight.mockImplementation(async () => { args.assertActive.mockImplementation(() => { throw new Error("wallet changed"); }); return {}; });
  await expect(finalizeMempoolTransaction(args)).rejects.toThrow("wallet changed");
  expect(submit).not.toHaveBeenCalled();
});

it("does not count contract creation as an issuance-earning action", async () => {
  const { args, getMempoolTransaction } = setup();
  getMempoolTransaction.mockResolvedValue({ status: "ready", kind: "contractAccount", rawTransaction: "0x0102" });
  await finalizeMempoolTransaction(args);
  expect(mocks.plan).toHaveBeenCalledWith(expect.objectContaining({ actionQualifies: false }));
});
