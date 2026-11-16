// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider, notifyManager } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  receipt: vi.fn(), finalize: vi.fn(), show: vi.fn(), reconcile: vi.fn(),
  wallet: { node: { getMempoolTransaction: vi.fn() }, phase: "ready", busy: true,
    profile: { address: 1n, nkRoot: 3n }, connectedAccount: "0xethereum",
    readStatus: vi.fn(), snapshot: { pendingContentHashes: ["0xpending"] },
    selfPublication: { l1Recovery: vi.fn() },
  },
}));
vi.mock("../lib/WalletProvider.tsx", () => ({ useWallet: () => mocks.wallet, errorMessage: (cause: Error) => cause.message }));
vi.mock("./NetworkContext.tsx", () => ({ useNetwork: () => ({ signal: new AbortController().signal, network: { l1ChainId: 1 } }) }));
vi.mock("@pcash/sdk/clients", () => ({ pollReceipt: mocks.receipt }));
vi.mock("../lib/finalizeMempoolTransaction.ts", () => ({ finalizeMempoolTransaction: mocks.finalize }));
import { MempoolFinalization } from "./MempoolFinalization.tsx";

let root: Root;
let container: HTMLDivElement;
const onConfirmed = vi.fn();
// Fake timers would otherwise hold the query's batched updates.
notifyManager.setScheduler((callback) => callback());
let queryClient: QueryClient;
async function show(element: ReactNode) { await act(async () => root.render(<QueryClientProvider client={queryClient}><MemoryRouter>{element}</MemoryRouter></QueryClientProvider>)); }
async function render(compact = false) { await show(<MempoolFinalization compact={compact} contentHash="0xpending" onConfirmed={onConfirmed} />); }
const button = () => container.querySelector<HTMLButtonElement>("button")!;
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks();
  queryClient = new QueryClient();
  mocks.receipt.mockReset().mockResolvedValue(null);
  mocks.finalize.mockReset().mockResolvedValue(undefined);
  mocks.show.mockResolvedValue({ latched: false, entries: [] });
  mocks.reconcile.mockResolvedValue(undefined);
  mocks.wallet.selfPublication.l1Recovery.mockResolvedValue({ show: mocks.show, reconcile: mocks.reconcile });
  mocks.wallet.node.getMempoolTransaction.mockResolvedValue({ status: "ready" });
  mocks.wallet.phase = "ready";
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); });

it("shows the mempool notice and allows Post to Ethereum while the original trade waits", async () => {
  await render();
  expect(container.textContent).toContain("Not posted to Ethereum yet.");
  expect(button().textContent).toBe("Post to Ethereum");
  expect(button().disabled).toBe(false);
  expect(mocks.finalize).not.toHaveBeenCalled();
  await act(async () => button().focus());
  const tip = container.querySelector<HTMLElement>('[role="tooltip"]')!;
  expect(button().getAttribute("aria-describedby")).toBe(tip.id);
  expect(tip.hidden).toBe(false);
  expect(tip.textContent).toBe("Posts it to Ethereum in a batch with other pending transactions. Your Ethereum wallet pays the gas in ETH and earns the issuance. Posting right after you submit can make the transaction easier to link to your Ethereum wallet by timing.");
});

it.each([false, true])("serializes Post to Ethereum clicks and continues the trade once confirmation arrives (compact: %s)", async compact => {
  let finish!: () => void;
  mocks.finalize.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
  await render(compact);
  await act(async () => { button().click(); button().click(); });
  expect(mocks.finalize).toHaveBeenCalledOnce();
  expect(mocks.finalize).toHaveBeenCalledWith(expect.objectContaining({ contentHash: "0xpending" }));
  mocks.receipt.mockResolvedValue({ outcome: "succeeded" });
  await act(async () => vi.advanceTimersByTimeAsync(3_000));
  expect(onConfirmed).not.toHaveBeenCalled();
  await act(async () => finish());
  expect(onConfirmed).toHaveBeenCalledOnce();
  await act(async () => vi.advanceTimersByTimeAsync(6_000));
  expect(onConfirmed).toHaveBeenCalledOnce();
});

it("reconciles a saved Ethereum batch without sending another transaction", async () => {
  mocks.show.mockResolvedValue({ latched: true, entries: [{ kind: "batch", selected: ["0xpending"], transactionHash: "0xbatch" }] });
  await render();
  expect(container.textContent).toContain("Posted, waiting for inclusion.");
  expect(container.querySelector('a[href="/batch/0xbatch"]')).not.toBeNull();
  expect(button()).toBeNull();
  expect(mocks.reconcile).toHaveBeenCalledOnce();
  expect(mocks.finalize).not.toHaveBeenCalled();
});

it("shows compact Ethereum and PCASH batch links without offering to submit again", async () => {
  mocks.show.mockResolvedValue({ latched: true, entries: [{ kind: "batch", selected: ["0xpending"], transactionHash: "0xbatch" }] });
  await render(true);
  expect(container.querySelector('a[href="/batch/0xbatch"]')?.textContent).toBe("PCASH batch");
  expect(container.querySelector('a[href="https://etherscan.io/tx/0xbatch"]')).not.toBeNull();
  expect(container.querySelector("button")).toBeNull();
  expect(container.querySelector("p")).toBeNull();
  expect(mocks.finalize).not.toHaveBeenCalled();
});

it("offers the resume action when the transaction is no longer in the mempool", async () => {
  mocks.wallet.node.getMempoolTransaction.mockResolvedValue(null);
  const resume = vi.fn();
  await show(<MempoolFinalization compact contentHash="0xpending" fallback={<button onClick={resume}>Continue</button>} />);
  expect(button().textContent).toBe("Continue");
  await act(async () => button().click());
  expect(resume).toHaveBeenCalledOnce();
  expect(mocks.finalize).not.toHaveBeenCalled();
});

it("routes ambiguous submissions to recovery without offering to send twice", async () => {
  mocks.show.mockResolvedValue({ latched: true, entries: [{ kind: "batch", selected: ["0xpending"], transactionHash: null }] });
  await render();
  expect(container.querySelector('a[href$="#ethereum-submission"]')).not.toBeNull();
  expect(button()).toBeNull();
});

it("allows retry after a rejected approval without advancing the trade", async () => {
  mocks.finalize.mockRejectedValueOnce(new Error("User rejected the request"));
  await render(); await act(async () => button().click());
  expect(container.textContent).toContain("User rejected the request");
  expect(button().disabled).toBe(false);
  expect(onConfirmed).not.toHaveBeenCalled();
});

it("does not start a saved trade just by viewing an accepted transaction", async () => {
  mocks.receipt.mockResolvedValue({ outcome: "succeeded" });
  await render();
  expect(container.textContent).toContain("Your transaction is included.");
  expect(onConfirmed).not.toHaveBeenCalled();
  expect(mocks.finalize).not.toHaveBeenCalled();
});

it("stops a pending preparation when its panel is closed", async () => {
  let finish!: () => void;
  mocks.finalize.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
  await render(); await act(async () => button().click());
  const { assertActive } = mocks.finalize.mock.calls[0]![0];
  await act(async () => root.render(null));
  expect(assertActive).toThrow("wallet changed");
  await act(async () => finish());
  expect(onConfirmed).not.toHaveBeenCalled();
});
