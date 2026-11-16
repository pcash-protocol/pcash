// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  preflight: vi.fn(), submit: vi.fn(), describe: vi.fn(), mineBatch: vi.fn(), plan: vi.fn(), reconcile: vi.fn(), recovery: vi.fn(),
  remember: vi.fn(), read: vi.fn(), refresh: vi.fn(), context: {} as any,
}));
vi.mock("../../lib/WalletProvider.tsx", () => ({ useWallet: () => state.context, errorMessage: (e: unknown) => e instanceof Error ? e.message : String(e) }));
vi.mock("../../components/NetworkContext.tsx", () => ({ useNetwork: () => ({ network: { id: "test", l1ChainId: 1, pcashChainId: 1, genesisHash: "0xgenesis" } }) }));
vi.mock("../../lib/fastBatch.ts", () => ({ planFastBatch: state.plan }));
vi.mock("../../shared/relayHistory.ts", async () => ({
  ...await vi.importActual<typeof import("../../shared/relayHistory.ts")>("../../shared/relayHistory.ts"),
  readRelayHistory: state.read, saveRelayHistory: state.remember,
}));
vi.mock("../wallet/activity.ts", () => ({ useLeaveGuard: () => {} }));
vi.mock("@pcash/sdk/protocol", () => ({ controlledIssuanceOpening: () => null, transactionIdentity: (entry: Uint8Array) => ({ contentHash: `0x${entry[0]}` }) }));
vi.mock("./reconcileGetAttempt.ts", () => ({ reconcileGetAttempt: state.reconcile }));
import { useGetBatch } from "./useGetBatch.ts";
import { GetActivityProvider, useGetActivity } from "../../lib/GetActivity.tsx";
let hook: ReturnType<typeof useGetBatch>;
let activity: ReturnType<typeof useGetActivity>;
let root: Root;
let element: HTMLDivElement;
const FIRST = Uint8Array.of(1), SECOND = Uint8Array.of(2), RELAY = Uint8Array.of(3);
const STATUS = { pcashChainId: 1, l1ChainId: 1n, genesisHash: "0xgenesis", inboxAddress: "0xinbox", latestBlock: 1n, latestBlockHash: "0xhead" };
function Probe() { activity = useGetActivity(); hook = useGetBatch(); return <div>{hook.error}</div>; }

beforeEach(async () => {
  vi.clearAllMocks();
  state.read.mockReturnValue([]);
  state.reconcile.mockImplementation(async (_node, row) => row);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.refresh.mockResolvedValue({ waiting: [], released: [] });
  state.plan.mockResolvedValue({ own: [], companions: { transactions: [RELAY], collectibleOpenFee: 5n, collectibleOpenFees: [5n] } });
  state.describe.mockReturnValue({ transactions: [FIRST, SECOND, RELAY], selected: ["0x1", "0x2", "0x3"], posterOwnerCommitment: 4n, quote: { maximumCostWei: 10n } });
  state.preflight.mockResolvedValue({ path: "l1" });
  state.submit.mockImplementation(async args => { await args.onL1Journaled?.({ kind: "batch", resolutionId: "durable-one", selected: ["0x1", "0x2", "0x3"] }); await args.onL1Submitted?.("0xl1"); return { l1Hash: "0xl1" }; });
  state.recovery.mockResolvedValue({ show: async () => ({ entries: [] }) });
  state.context = { status: STATUS, node: {}, profile: { address: 1n, nkRoot: 2n }, connectedAccount: "0xowner", snapshot: { pendingContentHashes: [] },
    selfPublication: { preflight: state.preflight, submit: state.submit, describeBatch: state.describe, l1Recovery: state.recovery, isDefinitePreBroadcastError: (error: Error) => error.message === "Rejected in wallet" },
    readStatus: async () => STATUS, runAction: async (fn: () => Promise<unknown>) => fn(), refreshSubmissionLock: state.refresh, assertFasterGas: async () => undefined,
    wallet: { mineBatch: state.mineBatch } };
  element = document.createElement("div"); document.body.append(element); root = createRoot(element);
  await act(async () => root.render(<GetActivityProvider><Probe /></GetActivityProvider>));
});
afterEach(async () => { await act(async () => root.unmount()); element.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("Get PCASH batch orchestration", () => {
  it("attaches fresh companions to all required mines and remembers the exact broadcast", async () => {
    state.mineBatch.mockImplementation(async intent => {
      const prepared = await intent.submission.preflight({ transactionBytes: FIRST, additionalTransactions: [SECOND], status: STATUS, retry: false });
      return { submission: await intent.submission.submit({ transactionBytes: FIRST,  prepared, status: STATUS }) };
    });
    await act(async () => hook.start(2));
    expect(state.mineBatch).toHaveBeenCalledWith(expect.objectContaining({ count: 2 }));
    expect(state.preflight).toHaveBeenCalledWith(expect.objectContaining({ transactionBytes: FIRST, additionalTransactions: [SECOND], companions: expect.objectContaining({ transactions: [RELAY] }) }));
    expect(hook.attempts[0]).toMatchObject({ resolutionId: "durable-one", txHash: "0xl1", status: "pending", contentHashes: ["0x1", "0x2", "0x3"] });
    expect(hook.attempts[0]?.collectedIssuance).toBeUndefined();
  });
  it("passes zero mines and only selected relay entries without proving", async () => {
    state.mineBatch.mockImplementation(async intent => ({ submission: { l1Hash: undefined } }));
    await act(async () => hook.start(0));
    expect(state.mineBatch).toHaveBeenCalledWith(expect.objectContaining({ count: 0, relayEntries: [RELAY] }));
    expect(state.plan).toHaveBeenCalledWith(expect.objectContaining({ requiredTransactionCount: 0, transactionByteSize: 0n }));
  });
  it("relays a batch the wallet can pay for although a full-size stand-in would cost more", async () => {
    // The stand-in precheck would refuse; the preflight quote of the selected entry fits the balance.
    state.context.assertFasterGas = vi.fn(async () => { throw new Error("Not enough ETH for gas."); });
    state.mineBatch.mockImplementation(async intent => {
      const prepared = await intent.submission.preflight({ transactionBytes: RELAY, status: STATUS, retry: false });
      return { submission: await intent.submission.submit({ transactionBytes: RELAY,  prepared, status: STATUS }) };
    });
    await act(async () => hook.start(0));
    expect(state.context.assertFasterGas).not.toHaveBeenCalled();
    expect(hook.error).toBeUndefined();
    expect(state.submit).toHaveBeenCalled();
    expect(hook.attempts[0]).toMatchObject({ txHash: "0xl1", status: "pending" });
  });
  it("stops mining before proving when ETH is short", async () => {
    state.context.assertFasterGas = vi.fn(async () => { throw new Error("Not enough ETH for gas."); });
    await act(async () => hook.start(1));
    expect(state.mineBatch).not.toHaveBeenCalled();
    expect(hook.error).toBe("Not enough ETH for gas.");
  });
  it("does not open Ethereum confirmation when relay-only has no profitable entries", async () => {
    state.plan.mockResolvedValue({ own: [], companions: { transactions: [] } });
    await act(async () => hook.start(0));
    expect(state.mineBatch).not.toHaveBeenCalled();
    expect(hook.error).toContain("No worthwhile pending");
    expect(hook.submissionError).toBe(false);
  });
  it("marks a definitely rejected wallet confirmation failed without reporting earnings", async () => {
    state.mineBatch.mockImplementation(async intent => {
      const prepared = await intent.submission.preflight({ transactionBytes: FIRST, status: STATUS });
      await intent.submission.submit({ transactionBytes: FIRST,  prepared, status: STATUS });
    });
    state.submit.mockRejectedValue(new Error("Rejected in wallet"));
    await act(async () => hook.start(1));
    expect(hook.attempts[0]).toMatchObject({ status: "failed" });
    expect(hook.attempts[0]?.collectedFee).toBeUndefined();
    expect(hook.error).toBe("Rejected in wallet");
    expect(hook.submissionError).toBe(true);
  });
});

it("keeps a known broadcast pending when a later wallet refresh fails after the journal clears", async () => {
  state.mineBatch.mockImplementation(async intent => {
    const prepared = await intent.submission.preflight({ transactionBytes: FIRST, status: STATUS });
    return { submission: await intent.submission.submit({ transactionBytes: FIRST,  prepared, status: STATUS }) };
  });
  state.refresh.mockRejectedValueOnce(new Error("Node refresh unavailable"));
  await act(async () => hook.start(1));
  expect(hook.attempts[0]).toMatchObject({ txHash: "0xl1", status: "pending" });
  expect(hook.attempts[0]?.collectedFee).toBeUndefined();
});

it.each([0, 1])("tracks canonical earnings after the submission journal clears with %i mines", async count => {
  vi.useFakeTimers();
  try {
    await act(async () => root.unmount());
    root = createRoot(element);
    await act(async () => root.render(<GetActivityProvider><Probe /></GetActivityProvider>));
    state.mineBatch.mockImplementation(async intent => {
      const entry = intent.count === 0 ? RELAY : FIRST;
      const prepared = await intent.submission.preflight({ transactionBytes: entry, status: STATUS });
      return { submission: await intent.submission.submit({ transactionBytes: entry,  prepared, status: STATUS }) };
    });
    await act(async () => hook.start(count));
    expect(hook.attempts[0]).toMatchObject({ txHash: "0xl1", status: "pending" });
    state.reconcile.mockImplementation(async (_node, row) => ({ ...row, status: "finalized", collectedFee: 5n, collectedIssuance: 12n }));
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(hook.attempts[0]).toMatchObject({ txHash: "0xl1", status: "finalized", collectedFee: 5n, collectedIssuance: 12n });
    const reads = state.reconcile.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(state.reconcile).toHaveBeenCalledTimes(reads);
  } finally {
    vi.useRealTimers();
  }
});

it("retains an uncertain broadcast when recovery reads are unavailable", async () => {
  state.mineBatch.mockImplementation(async intent => {
    const prepared = await intent.submission.preflight({ transactionBytes: FIRST, status: STATUS });
    await intent.submission.submit({ transactionBytes: FIRST,  prepared, status: STATUS });
  });
  state.submit.mockRejectedValue(new Error("Wallet response lost"));
  state.recovery.mockRejectedValue(new Error("Journal read unavailable"));
  await act(async () => hook.start(1));
  expect(hook.attempts[0]).toMatchObject({ status: "pending" });
  expect(hook.attempts[0]?.txHash).toBeUndefined();
});


it("asks before canceling expensive preparation and keeps working when declined", async () => {
  let signal: AbortSignal | undefined;
  state.mineBatch.mockImplementation(intent => {
    signal = intent.signal;
    return new Promise((_resolve, reject) => intent.signal.addEventListener("abort", () => reject(Object.assign(new Error("canceled"), { name: "AbortError" }))));
  });
  let attempt: Promise<void>;
  await act(async () => { attempt = hook.start(1); });
  expect(activity).toMatchObject({ working: true, unsafeToLeave: true });
  vi.spyOn(window, "confirm").mockReturnValue(false);
  await act(async () => hook.cancel());
  expect(signal?.aborted).toBe(false);
  vi.mocked(window.confirm).mockReturnValue(true);
  await act(async () => { hook.cancel(); await attempt!; });
  expect(signal?.aborted).toBe(true);
  expect(activity).toMatchObject({ working: false, unsafeToLeave: false });
});

it("keeps the operation active but permits leaving after a durable broadcast hash", async () => {
  let finish: (value: unknown) => void;
  state.submit.mockImplementation(async args => {
    await args.onL1Submitted("0xl1");
    return new Promise(resolve => { finish = resolve; });
  });
  state.mineBatch.mockImplementation(async intent => {
    const prepared = await intent.submission.preflight({ transactionBytes: FIRST, status: STATUS });
    return { submission: await intent.submission.submit({ transactionBytes: FIRST,  prepared, status: STATUS }) };
  });
  let attempt: Promise<void>;
  await act(async () => { attempt = hook.start(1); });
  expect(activity).toMatchObject({ working: true, unsafeToLeave: false });
  await act(async () => { finish!({ l1Hash: "0xl1" }); await attempt!; });
  expect(activity).toMatchObject({ working: false, unsafeToLeave: false });
});

it("restores a saved wallet-confirmation row from the hashed durable journal", async () => {
  await act(async () => root.unmount());
  state.read.mockReturnValue([{ id: "saved", at: 1, contentHashes: ["0x1"], status: "wallet", resolutionId: "journal-saved" }]);
  state.recovery.mockResolvedValue({ show: async () => ({ entries: [{ kind: "batch", resolutionId: "journal-saved", selected: ["0x1"], transactionHash: "0xposted" }] }) });
  root = createRoot(element);
  await act(async () => root.render(<GetActivityProvider><Probe /></GetActivityProvider>));
  expect(state.recovery).toHaveBeenCalledOnce();
  expect(hook.attempts[0]).toMatchObject({ status: "pending", txHash: "0xposted", resolutionId: "journal-saved" });
  expect(state.reconcile).toHaveBeenCalledOnce();
});

it("applies panel recovery and prevents an older outcome poll from resurrecting a released attempt", async () => {
  await act(async () => root.unmount());
  state.read.mockReturnValue([{ id: "saved", at: 1, contentHashes: ["0x1"], status: "pending", resolutionId: "journal-saved", txHash: "0xposted" }]);
  let finish: (value: unknown) => void;
  state.reconcile.mockImplementationOnce((_node, row) => new Promise(resolve => { finish = () => resolve(row); }));
  root = createRoot(element);
  await act(async () => root.render(<GetActivityProvider><Probe /></GetActivityProvider>));
  const { relayDeploymentKey, relayHistoryKey, RELAY_ATTEMPTS_RELEASED_EVENT } = await import("../../shared/relayHistory.ts");
  await act(async () => {
    window.dispatchEvent(new CustomEvent(RELAY_ATTEMPTS_RELEASED_EVENT, { detail: {
      historyKey: relayHistoryKey(relayDeploymentKey(STATUS), "0xowner"),
      released: [{ resolutionId: "journal-saved", selected: ["0x1"], transactionHash: "0xposted" }],
    } }));
  });
  expect(hook.attempts[0]?.status).toBe("failed");
  await act(async () => finish!(undefined));
  expect(hook.attempts[0]?.status).toBe("failed");
});

it("allows prepared mines to submit a mine-only fallback plan", async () => {
  state.plan.mockResolvedValue({ own: [], companions: { transactions: [], collectibleOpenFee: 0n, collectibleOpenFees: [] } });
  state.mineBatch.mockImplementation(async intent => {
    const prepared = await intent.submission.preflight({ transactionBytes: FIRST, status: STATUS });
    return { submission: await intent.submission.submit({ transactionBytes: FIRST,  prepared, status: STATUS }) };
  });
  await act(async () => hook.start(1));
  expect(state.plan).toHaveBeenCalledWith(expect.objectContaining({ companionsOptional: true, requiredTransactionCount: 1 }));
  expect(state.preflight).toHaveBeenCalledWith(expect.objectContaining({ companions: { transactions: [], collectibleOpenFee: 0n, collectibleOpenFees: [] } }));
  expect(state.submit).toHaveBeenCalledOnce();
});

it("shows a batch an earlier visit left in flight but not one that finished", async () => {
  await act(async () => root.unmount());
  state.read.mockReturnValue([
    { id: "done", at: 2, contentHashes: ["0x2"], status: "included", txHash: "0xdone", collectedFee: 0n, collectedIssuance: 1n, acceptedCount: 1, skippedCount: 0 },
    { id: "posted", at: 1, contentHashes: ["0x1"], status: "pending", txHash: "0xposted" },
  ]);
  root = createRoot(element);
  await act(async () => root.render(<GetActivityProvider><Probe /></GetActivityProvider>));
  expect(hook.current?.id).toBe("posted");
  await act(async () => root.unmount());
  state.read.mockReturnValue([{ id: "done", at: 2, contentHashes: ["0x2"], status: "finalized", txHash: "0xdone", collectedFee: 0n, collectedIssuance: 1n, acceptedCount: 1, skippedCount: 0 }]);
  root = createRoot(element);
  await act(async () => root.render(<GetActivityProvider><Probe /></GetActivityProvider>));
  expect(hook.current).toBeUndefined();
  expect(hook.attempts).toHaveLength(1);
});

it("dismisses the previous result when a new batch starts", async () => {
  state.mineBatch.mockImplementation(async intent => {
    const prepared = await intent.submission.preflight({ transactionBytes: FIRST, status: STATUS });
    return { submission: await intent.submission.submit({ transactionBytes: FIRST,  prepared, status: STATUS }) };
  });
  await act(async () => hook.start(1));
  const first = hook.current!;
  expect(first).toMatchObject({ txHash: "0xl1", status: "pending" });
  let release: () => void;
  state.mineBatch.mockImplementation(() => new Promise<never>((_resolve, reject) => { release = () => reject(new Error("stopped")); }));
  let second: Promise<void>;
  await act(async () => { second = hook.start(1); });
  expect(hook.current).toBeUndefined();
  expect(hook.attempts[0]?.id).toBe(first.id);
  await act(async () => { release!(); await second!; });
});
