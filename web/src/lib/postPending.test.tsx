// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider, notifyManager } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PADDED_PRIVATE_VALUE_BYTE_SIZE } from "@pcash/sdk/wallet/actions";
const mocks = vi.hoisted(() => ({
  finalize: vi.fn(),
  items: new Map<string, { contentHash: string; status: string; byteSize: bigint; receivedAtUnixMs: bigint }>(),
  inFlight: [] as string[],
  wallet: {} as Record<string, unknown>,
}));
vi.mock("./WalletProvider.tsx", () => ({ useWallet: () => mocks.wallet, errorMessage: (cause: unknown) => cause instanceof Error ? cause.message : String(cause) }));
vi.mock("./finalizeMempoolTransaction.ts", () => ({ finalizeMempoolTransaction: mocks.finalize }));
import { usePostPending } from "./postPending.ts";

notifyManager.setScheduler((callback) => callback());
const id = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
let root: Root;
let container: HTMLDivElement;
let hook: ReturnType<typeof usePostPending>;
function Probe() { hook = usePostPending(); return null; }
function pending(...ids: number[]) {
  mocks.items.clear();
  for (const n of ids) mocks.items.set(id(n), { contentHash: id(n), status: "ready", byteSize: PADDED_PRIVATE_VALUE_BYTE_SIZE, receivedAtUnixMs: BigInt(10 - n) });
  mocks.wallet.snapshot = { pendingContentHashes: ids.map(id) };
}
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  mocks.inFlight = [];
  mocks.finalize.mockReset();
  const node = { getMempoolTransaction: vi.fn(async (contentHash: string) => mocks.items.get(contentHash) ?? null) };
  const selfPublication = { l1Recovery: async () => ({ show: async () => ({ latched: mocks.inFlight.length > 0, entries: [{ kind: "batch", selected: mocks.inFlight }] }) }) };
  mocks.wallet = { node, selfPublication, phase: "ready", profile: { address: 1n, nkRoot: 3n }, connectedAccount: "0xposter",
    readStatus: vi.fn(), snapshot: { pendingContentHashes: [] } };
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
const render = () => act(async () => root.render(<QueryClientProvider client={new QueryClient()}><Probe /></QueryClientProvider>));

it("counts this wallet's unposted transactions and the Ethereum transactions they need", async () => {
  pending(1, 2, 3, 4, 5, 6);
  mocks.items.set(id(6), { ...mocks.items.get(id(6))!, status: "included_unfinalized" });
  mocks.inFlight = [id(5)];
  await render();
  expect(hook.pendingCount).toBe(4);
  expect(hook.ethereumTransactions).toBe(2);
});

it("fits three full-size transactions in one Ethereum transaction", async () => {
  pending(1, 2, 3);
  await render();
  expect(hook.pendingCount).toBe(3);
  expect(hook.ethereumTransactions).toBe(1);
});

it("posts oldest first, one batch at a time, until nothing of this wallet's is left unposted", async () => {
  pending(1, 2, 3, 4);
  await render();
  // Each batch carries the first entry and the wallet's next ones that fit.
  mocks.finalize.mockImplementation(async ({ contentHash }: { contentHash: string }) => {
    const batch = [...mocks.items.values()].sort((a, b) => Number(a.receivedAtUnixMs - b.receivedAtUnixMs)).slice(0, 3);
    expect(batch[0]!.contentHash).toBe(contentHash);
    mocks.inFlight.push(...batch.map((item) => item.contentHash));
    for (const item of batch) mocks.items.delete(item.contentHash);
  });
  await act(async () => hook.post());
  expect(mocks.finalize.mock.calls.map(([args]) => args.contentHash)).toEqual([id(4), id(1)]);
  expect(mocks.finalize.mock.calls[0]![0]).toMatchObject({ ownPendingContentHashes: [id(1), id(2), id(3)] });
  expect(hook.busy).toBe(false);
  expect(hook.error).toBeUndefined();
});

it("stops at the first failure and reports it", async () => {
  pending(1, 2);
  await render();
  mocks.finalize.mockRejectedValue(new Error("User rejected the request."));
  await act(async () => hook.post());
  expect(mocks.finalize).toHaveBeenCalledOnce();
  expect(hook.error).toBe("User rejected the request.");
});

it("never posts the same entry twice in one call", async () => {
  pending(1);
  await render();
  mocks.finalize.mockResolvedValue(undefined);
  await act(async () => hook.post());
  expect(mocks.finalize).toHaveBeenCalledOnce();
});

it("says which Ethereum transaction it is posting, of how many", async () => {
  pending(1, 2, 3, 4);
  await render();
  const releases: (() => void)[] = [];
  mocks.finalize.mockImplementation(async () => {
    const batch = [...mocks.items.values()].sort((a, b) => Number(a.receivedAtUnixMs - b.receivedAtUnixMs)).slice(0, 3);
    mocks.inFlight.push(...batch.map((item) => item.contentHash));
    for (const item of batch) mocks.items.delete(item.contentHash);
    await new Promise<void>((resolve) => releases.push(resolve));
  });
  let posting!: Promise<void>;
  await act(async () => {
    posting = hook.post();
    await vi.waitFor(() => expect(mocks.finalize).toHaveBeenCalledTimes(1));
  });
  expect(hook.progress).toEqual({ current: 1, total: 2 });
  await act(async () => {
    releases.shift()!();
    await vi.waitFor(() => expect(mocks.finalize).toHaveBeenCalledTimes(2));
  });
  expect(hook.progress).toEqual({ current: 2, total: 2 });
  await act(async () => { releases.shift()!(); await posting; });
  expect(hook.progress).toBeUndefined();
  expect(hook.busy).toBe(false);
});

it("says why it cannot post instead of doing nothing", async () => {
  pending(1);
  mocks.wallet.phase = "activation-prepared";
  await render();
  await act(async () => hook.post());
  expect(hook.error).toBe("Finish setting up your wallet before posting to Ethereum.");
  mocks.wallet.phase = "ready";
  mocks.wallet.connectedAccount = undefined;
  await render();
  await act(async () => hook.post());
  expect(hook.error).toBe("Connect your Ethereum wallet to post to Ethereum.");
  expect(mocks.finalize).not.toHaveBeenCalled();
});

it("keeps the last counts while a new snapshot's are read, so the button does not flicker", async () => {
  const client = new QueryClient();
  const show = () => act(async () => root.render(<QueryClientProvider client={client}><Probe /></QueryClientProvider>));
  pending(1, 2);
  await show();
  expect(hook.pendingCount).toBe(2);
  (mocks.wallet.node as { getMempoolTransaction: ReturnType<typeof vi.fn> }).getMempoolTransaction.mockReturnValue(new Promise(() => undefined));
  mocks.wallet.snapshot = { pendingContentHashes: [id(1), id(2), id(3)] };
  await show();
  expect(hook.pendingCount).toBe(2);
});
