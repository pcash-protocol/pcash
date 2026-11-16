// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider, notifyManager } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  receipt: vi.fn(),
  wallet: { node: { getMempoolTransaction: vi.fn() }, selfPublication: undefined },
}));
vi.mock("./WalletProvider.tsx", () => ({ useWallet: () => mocks.wallet }));
vi.mock("@pcash/sdk/clients", () => ({ pollReceipt: mocks.receipt }));
import { usePendingTransactionState } from "./usePendingTransactionState.ts";

// Fake timers would otherwise hold the query's batched updates.
notifyManager.setScheduler((callback) => callback());
let root: Root;
let container: HTMLDivElement;
function State({ contentHash }: { contentHash: string }) {
  return <p>{usePendingTransactionState(contentHash).data?.state ?? "checking"}</p>;
}
beforeEach(() => {
  vi.useFakeTimers();
  mocks.receipt.mockReset().mockResolvedValue(null);
  mocks.wallet.node.getMempoolTransaction.mockReset().mockResolvedValue({ status: "ready" });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); });

it("reads one transaction once per tick for every view of it and stops once it is confirmed", async () => {
  await act(async () => root.render(<QueryClientProvider client={new QueryClient()}>
    <State contentHash="0xpending" /><State contentHash="0xPENDING" />
  </QueryClientProvider>));
  expect(container.textContent).toBe("mempoolmempool");
  expect(mocks.wallet.node.getMempoolTransaction).toHaveBeenCalledOnce();
  await act(async () => vi.advanceTimersByTimeAsync(3_000));
  expect(mocks.wallet.node.getMempoolTransaction).toHaveBeenCalledTimes(2);
  mocks.receipt.mockResolvedValue({ outcome: "succeeded" });
  await act(async () => vi.advanceTimersByTimeAsync(3_000));
  expect(container.textContent).toBe("confirmedconfirmed");
  const reads = mocks.receipt.mock.calls.length;
  await act(async () => vi.advanceTimersByTimeAsync(60_000));
  expect(mocks.receipt).toHaveBeenCalledTimes(reads);
});

it("rechecks a transaction the node no longer offers every 15 seconds", async () => {
  mocks.wallet.node.getMempoolTransaction.mockResolvedValue(null);
  await act(async () => root.render(<QueryClientProvider client={new QueryClient()}><State contentHash="0xgone" /></QueryClientProvider>));
  expect(container.textContent).toBe("absent");
  await act(async () => vi.advanceTimersByTimeAsync(14_000));
  expect(mocks.wallet.node.getMempoolTransaction).toHaveBeenCalledOnce();
  await act(async () => vi.advanceTimersByTimeAsync(1_000));
  expect(mocks.wallet.node.getMempoolTransaction).toHaveBeenCalledTimes(2);
});
