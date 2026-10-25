import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PcashNodeClient, type StatusResult } from "@pcash/sdk/clients";
import { Logger } from "@pcash/sdk/blgr";
import { openMemoryNodeWallet, openNodeWallet } from "@pcash/wallet";
import { serveRelayer } from "../src/service.ts";
import { DEV_ANVIL_RELAYER_PRIVATE_KEY, runRelayerCli } from "../src/run.ts";

vi.mock("@pcash/wallet", () => ({
  openNodeWallet: vi.fn(),
  openMemoryNodeWallet: vi.fn(),
}));
vi.mock("../src/service.ts", () => ({ serveRelayer: vi.fn() }));

const owner = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const blockHash = `0x${"ab".repeat(32)}`;
const feeWallet = {
  address: owner,
  sync: vi.fn(async () => undefined),
  nativeFunds: vi.fn(async () => ({
    private: 100n, spendablePrivate: 75n, pcashNumber: 12n, pcashHash: blockHash,
  })),
  notes: vi.fn(async () => [{ amount: 25n }, { amount: 50n }]),
  close: vi.fn(async () => undefined),
};
const expectedFees = {
  owner, balance: "100", spendable: "75", noteCount: 2, blockNumber: "12", blockHash,
};
let directory: string | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(Logger.prototype, "raw").mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, "warning").mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
  vi.spyOn(PcashNodeClient.prototype, "status").mockResolvedValue({
    pcashChainId: 1, l1ChainId: 1n, inboxAddress: `0x${"01".repeat(20)}`,
  } as StatusResult);
  vi.mocked(openMemoryNodeWallet).mockResolvedValue(feeWallet as unknown as Awaited<ReturnType<typeof openMemoryNodeWallet>>);
  vi.mocked(openNodeWallet).mockResolvedValue(feeWallet as unknown as Awaited<ReturnType<typeof openNodeWallet>>);
});

afterEach(() => {
  vi.restoreAllMocks();
  if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

it.each([true, false])("reports fee inventory with a read-only wallet (dev=%s)", async (dev) => {
  directory = mkdtempSync(join(tmpdir(), "pcash-relayer-fees-"));
  const args = dev ? ["--dev"] : ["--journal-path", join(directory, "journal")];
  await expect(runRelayerCli(["wallet-status", ...args], {
    PCASH_RELAYER_L1_KEY: DEV_ANVIL_RELAYER_PRIVATE_KEY,
  })).resolves.toBe(0);

  const opened = dev ? openMemoryNodeWallet : openNodeWallet;
  expect(opened).toHaveBeenCalledOnce();
  const options = vi.mocked(opened).mock.calls[0]![0];
  expect(Object.keys(options).sort()).toEqual(dev ? ["node", "profile"] : ["dataDir", "node", "profile"]);
  expect(options.profile!.address).toBe(BigInt(owner));
  if (!dev) expect(options).toHaveProperty("dataDir", join(directory, "fee-wallet"));
  expect(feeWallet.sync).toHaveBeenCalledOnce();
  expect(feeWallet.notes).toHaveBeenCalledWith({ assetId: 0n, status: "spendable" });
  expect(Logger.prototype.raw).toHaveBeenCalledWith(JSON.stringify(expectedFees, null, 2));
  expect(feeWallet.close).toHaveBeenCalledOnce();
});

it("closes the fee wallet when observation fails", async () => {
  feeWallet.sync.mockRejectedValueOnce(new Error("node unavailable"));
  await expect(runRelayerCli(["wallet-status", "--dev"], {})).resolves.toBe(1);
  expect(feeWallet.nativeFunds).not.toHaveBeenCalled();
  expect(feeWallet.close).toHaveBeenCalledOnce();
});

it("supplies fee observations and a separate selected-relay signer to the service", async () => {
  vi.mocked(serveRelayer).mockImplementationOnce(async (options) => {
    expect(await options.observeFees!()).toEqual(expectedFees);
    expect(options.selected!.profile.address).toBe(BigInt(owner));
    expect(options.selected!.signer.address).toBe(BigInt(owner));
    expect(options.selected!.signer.signTypedData).toBeTypeOf("function");
  });
  await expect(runRelayerCli(["serve", "--dev"], {})).resolves.toBe(0);
  expect(serveRelayer).toHaveBeenCalledOnce();
  expect(Object.keys(vi.mocked(openMemoryNodeWallet).mock.calls[0]![0]).sort()).toEqual(["node", "profile"]);
  expect(feeWallet.close).toHaveBeenCalledOnce();
});
