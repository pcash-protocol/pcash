import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { NativeTransferBuild } from "@pcash/sdk/builders";
import type { ProveStatus, ProofResult } from "@pcash/sdk/browser-prover";
import { createBrowserWalletProvers } from "../../src/wallet/web/provers.ts";

const fake = vi.hoisted(() => ({
  proveTransfer: vi.fn(),
  proveUserAccountUpdate: vi.fn(),
  proveAssetAction: vi.fn(),
  destroy: vi.fn(),
  createSession: vi.fn(),
}));

vi.mock("@pcash/sdk/browser-prover", () => ({
  createBrowserProverSession: fake.createSession,
  normalizeProverThreads: () => 8,
  PROTOCOL_CIRCUIT_PROFILES: {
    "/prover/private_value_transfer_kernel.json": { srsPoints: 2 ** 18 },
    "/prover/account_rule_asset_creation_ecdsa.json": { srsPoints: 2 ** 19 },
  },
  resolveBrowserProverAssetSource: () => ({ assetSetId: "test", baseUrl: "https://assets.invalid/" }),
}));

const build = {
  shape: 0,
  accountRuleWitnessMap: {},
  buildKernelWitnessMap: () => ({}),
  publicInputs: Array.from({ length: 21 }, () => 0n),
  authorizationCircuit: "account_rule_payment_ecdsa",
  outputData: Array.from({ length: 5 }, () => new Uint8Array()),
  encodeTransaction: (proof: Uint8Array) => proof,
} as unknown as NativeTransferBuild;

function canceled(signal: AbortSignal): Promise<ProofResult> {
  return new Promise((_resolve, reject) => {
    const abort = (): void => {
      const error = new Error("proving canceled");
      error.name = "AbortError";
      reject(error);
    };
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

describe("browser wallet provers", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubGlobal("navigator", { hardwareConcurrency: 8 });
    fake.createSession.mockImplementation((profile) => ({ ...fake, profile }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("reuses the worker for consecutive proofs and releases it when the wallet closes", async () => {
    fake.proveTransfer.mockResolvedValue({ proof: Uint8Array.of(2), publicInputs: [] });
    const provers = createBrowserWalletProvers({ node: { rpcUrl: "https://node.invalid/rpc" }, proverAssets: null });
    await provers.privateValue.proveAndEncode(build);
    await provers.privateValue.proveAndEncode(build);
    expect(fake.createSession).toHaveBeenCalledOnce();
    expect(fake.createSession.mock.calls[0]![0].srsPoints).toBe(2 ** 18);
    expect(fake.destroy).not.toHaveBeenCalled();
    provers.destroy();
    expect(fake.destroy).toHaveBeenCalledOnce();
  });

  it("upgrades the worker only when asset creation needs a larger SRS", async () => {
    fake.proveTransfer.mockResolvedValue({ proof: Uint8Array.of(2), publicInputs: [] });
    fake.proveAssetAction.mockResolvedValue({ proof: Uint8Array.of(3), publicInputs: [] });
    const provers = createBrowserWalletProvers({ node: { rpcUrl: "https://node.invalid/rpc" }, proverAssets: null });
    await provers.privateValue.proveAndEncode(build);
    const creation = {
      ...build,
      buildAssetCreationKernelWitnessMap: () => ({}),
    } as unknown as Parameters<typeof provers.assetCreation.proveAndEncode>[0];
    await provers.assetCreation.proveAndEncode(creation, {});
    await provers.privateValue.proveAndEncode(build);
    expect(fake.createSession.mock.calls.map(([profile]) => profile.srsPoints)).toEqual([2 ** 18, 2 ** 19]);
    expect(fake.destroy).toHaveBeenCalledOnce();
    provers.destroy();
  });

  it("proves S asset actions under their authorization rule and leaves L to native proving", async () => {
    fake.proveAssetAction.mockResolvedValue({ proof: Uint8Array.of(4), publicInputs: [] });
    const provers = createBrowserWalletProvers({ node: { rpcUrl: "https://node.invalid/rpc" }, proverAssets: null });
    const asset = build as unknown as Parameters<typeof provers.assetAction.proveAndEncode>[0];
    const witnessMap = { signed: true };
    expect(provers.assetAction.shapes).toEqual([0]);
    expect(await provers.assetAction.proveAndEncode(asset, { packageName: "account_rule_asset_burn_ecdsa", witnessMap }))
      .toEqual(Uint8Array.of(4));
    expect(fake.proveAssetAction.mock.calls[0]![0]).toMatchObject({
      operation: "transfer",
      authorization: { circuitUrl: "/prover/account_rule_asset_burn_ecdsa.json", witnessMap },
      expectedPublicInputs: asset.publicInputs,
    });
    await expect(provers.assetAction.proveAndEncode(asset, { packageName: "account_rule_large_batch_transfer_ecdsa", witnessMap }))
      .rejects.toThrow(/native proving/);
    await expect(provers.assetAction.proveAndEncode({ ...asset, shape: 1 }, { packageName: "account_rule_batch_transfer_ecdsa", witnessMap }))
      .rejects.toThrow(/native proving/);
    expect(fake.proveAssetAction).toHaveBeenCalledOnce();
    provers.destroy();
  });

  it("does not start a worker when the wallet closes during lazy loading", async () => {
    const provers = createBrowserWalletProvers({ node: { rpcUrl: "https://node.invalid/rpc" }, proverAssets: null });
    const pending = provers.privateValue.proveAndEncode(build);
    provers.destroy();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(fake.createSession).not.toHaveBeenCalled();
    expect(fake.proveTransfer).not.toHaveBeenCalled();
  });

  it("cancels the prior proof, ignores its late status, and allows a fresh proof", async () => {
    let firstStatus: ((status: ProveStatus) => void) | undefined;
    fake.proveTransfer
      .mockImplementationOnce((
        _args: unknown,
        onStatus: (status: ProveStatus) => void,
        signal: AbortSignal,
      ) => {
        firstStatus = onStatus;
        return canceled(signal);
      })
      .mockImplementationOnce(async (
        _args: unknown,
        onStatus: (status: ProveStatus) => void,
      ) => {
        onStatus({ phase: "proving", message: "new proof", elapsedMs: 1 });
        return { proof: Uint8Array.of(2), publicInputs: [] };
      });
    const statuses: string[] = [];
    const provers = createBrowserWalletProvers({
      node: { rpcUrl: "https://node.invalid/rpc" },
      proverAssets: { assetSetId: "test", baseUrl: "/proving/test/" },
      onStatus: (status) => statuses.push(status.message),
    });

    const first = provers.privateValue.proveAndEncode(build);
    await vi.waitFor(() => expect(fake.proveTransfer).toHaveBeenCalledTimes(1));
    const second = provers.privateValue.proveAndEncode(build);

    await expect(first).rejects.toMatchObject({
      name: "AbortError",
      message: "proving canceled",
    });
    await expect(second).resolves.toEqual(Uint8Array.of(2));
    firstStatus?.({ phase: "proving", message: "late old proof", elapsedMs: 99 });
    expect(statuses).toEqual(["new proof"]);
  });

  it.each(["cancelCurrent", "destroy"] as const)("%s aborts the active proof without leaking an internal resource name", async (method) => {
    fake.proveTransfer.mockImplementation((
      _args: unknown,
      _onStatus: (status: ProveStatus) => void,
      signal: AbortSignal,
    ) => canceled(signal));
    const provers = createBrowserWalletProvers({
      node: { rpcUrl: "https://node.invalid/rpc" },
      proverAssets: { assetSetId: "test", baseUrl: "/proving/test/" },
    });
    const pending = provers.privateValue.proveAndEncode(build);
    await vi.waitFor(() => expect(fake.proveTransfer).toHaveBeenCalledTimes(1));

    provers[method]();

    await expect(pending).rejects.toMatchObject({
      name: "AbortError",
      message: "proving canceled",
    });
    expect(fake.destroy).toHaveBeenCalledTimes(method === "destroy" ? 1 : 0);
  });

  it("forwards a mining action's cancellation to its worker operation and removes the listener", async () => {
    let workerSignal: AbortSignal | undefined;
    fake.proveTransfer.mockImplementation((_args: unknown, _status: unknown, signal: AbortSignal) => {
      workerSignal = signal;
      return canceled(signal);
    });
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");
    const encodeTransaction = vi.fn(build.encodeTransaction);
    const mine = { ...build, authorizationCircuit: "account_rule_mine", encodeTransaction } as NativeTransferBuild;
    const provers = createBrowserWalletProvers({ node: { rpcUrl: "https://node.invalid/rpc" }, proverAssets: null });
    const pending = provers.privateValue.proveAndEncode(mine, controller.signal);
    await vi.waitFor(() => expect(fake.proveTransfer).toHaveBeenCalledOnce());
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(workerSignal?.aborted).toBe(true);
    expect(encodeTransaction).not.toHaveBeenCalled();
    expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
    fake.proveTransfer.mockResolvedValue({ proof: Uint8Array.of(3), publicInputs: [] });
    await expect(provers.privateValue.proveAndEncode(mine)).resolves.toEqual(Uint8Array.of(3));
    expect(fake.createSession).toHaveBeenCalledOnce();
    provers.destroy();
  });

  it("does not start a worker for an already cancelled mining action", async () => {
    const controller = new AbortController();
    controller.abort();
    const provers = createBrowserWalletProvers({ node: { rpcUrl: "https://node.invalid/rpc" }, proverAssets: null });
    await expect(provers.privateValue.proveAndEncode(build, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(fake.createSession).not.toHaveBeenCalled();
    expect(fake.proveTransfer).not.toHaveBeenCalled();
  });

});
