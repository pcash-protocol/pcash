import { expect, it, vi } from "vitest";

const walletOpen = vi.hoisted(() => vi.fn(() => { throw new Error("fee wallet opened"); }));
const relay = vi.hoisted(() => vi.fn(async () => ({
  txHash: "0x1234",
  selectedContentHashes: ["0xabcd"],
})));
const submitBatch = vi.hoisted(() => vi.fn(async () => ({ transactionHash: "0x1234", entries: [], receipt: {} })));

vi.mock("@pcash/wallet", () => ({
  openNodeWallet: walletOpen,
  openMemoryNodeWallet: walletOpen,
}));
vi.mock("@pcash/sdk/relay", async (original) => ({
  ...await original<typeof import("@pcash/sdk/relay")>(),
  Relayer: class { relay = relay; },
}));
vi.mock("../src/exactBatch.ts", () => ({
  RawBatchInputError: class extends Error {},
  readRawTransactionBatch: vi.fn(async () => ["0x01"]),
  submitRawTransactionBatch: submitBatch,
  rawBatchExitCode: vi.fn(() => 0),
}));

import { runRelayerCli } from "../src/run.ts";

it("relays without opening a fee wallet", async () => {
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  await expect(runRelayerCli(["relay", "--dev"], {})).resolves.toBe(0);
  expect(relay).toHaveBeenCalledOnce();
  expect(walletOpen).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

it("submits a raw batch without opening a fee wallet", async () => {
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  await expect(runRelayerCli(["submit-batch", "-", "--dev"], {})).resolves.toBe(0);
  expect(submitBatch).toHaveBeenCalledOnce();
  expect(walletOpen).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});
