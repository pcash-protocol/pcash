// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { IDBFactory } from "fake-indexeddb";
import { BroadcastChannel } from "node:worker_threads";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { NetworkContext } from "../components/NetworkContext.tsx";
import { createProfileSessionStore, type ProfileSessionIdentity } from "./ProfileSessionStore.ts";
import { networkInstanceKey } from "./networks.ts";
import { readRelayHistory, relayDeploymentKey, relayHistoryKey, saveRelayHistory } from "../shared/relayHistory.ts";
import type { RelayJournalEntry, RelayJournalRecovery } from "@pcash/sdk/relay";

const state = vi.hoisted(() => ({
  connection: { status: "connected", address: `0x${"ab".repeat(20)}`, chainId: 1, connector: {} },
  ethereumConfig: {},
  sign: vi.fn(), close: vi.fn(), send: vi.fn(), submit: vi.fn(), quoteBatch: vi.fn(), prepareActivation: vi.fn(), destroyProver: vi.fn(),
  startSync: vi.fn(), stopSync: vi.fn(), notes: vi.fn(), snapshotReads: 0,
  snapshotPause: undefined as Promise<void> | undefined,
  syncPause: undefined as Promise<void> | undefined,
  recovery: undefined as RelayJournalRecovery | undefined,
  accountReady: true,
  accountProfiles: new Map<string, bigint>(),
  events: new Map<string, Set<(event: unknown) => unknown>>(),
  hooks: new Map<string, (event: unknown) => unknown>(),
}));
vi.mock("wagmi", () => ({ useAccount: () => state.connection, useBalance: () => ({}) }));
vi.mock("wagmi/actions", () => ({
  getWalletClient: async () => ({}), getPublicClient: () => ({}),
  disconnect: async () => { state.connection = { ...state.connection, status: "disconnected" }; },
}));
vi.mock("./EthereumProvider.tsx", () => ({ useEthereumNetwork: () => ({ ethereumConfig: state.ethereumConfig, l1Chain: { id: 1 }, l1ChainId: 1 }) }));
vi.mock("./networkWalletClient.ts", () => ({ networkWalletClient: () => ({}) }));
vi.mock("./browserPublication.ts", () => ({ browserPublication: () => ({ submission: {}, selfPublication: { mode: "l1", submit: state.submit, quoteBatch: state.quoteBatch, l1Recovery: async () => state.recovery } }) }));
vi.mock("@pcash/sdk/wallet/actions", () => ({ PADDED_PRIVATE_VALUE_BYTE_SIZE: 4n }));
vi.mock("@pcash/sdk/eip712", () => ({
  verifyPcashAuthorization: (_request: unknown, signature: string) => ({ signature }),
  serializeEcdsaSignature: ({ signature }: { signature: string }) => Uint8Array.of(signature === "signature-2" ? 2 : 1),
}));
vi.mock("@pcash/sdk/protocol", () => ({ networkConfigFromStatus: () => ({}), USER_ACCOUNT_CREATION_MAX_TX_BYTES: 3 }));
vi.mock("@pcash/sdk/wallet", () => ({
  WalletReviewStaleError: class extends Error {}, DurablePreBroadcastError: class extends Error {},
  derivePcashProfileFromSignature: (signature: string, _network: unknown, address: string) => ({ address: BigInt(address), nkRoot: signature === "0x02" ? 3n : 2n }),
  profileDerivationSigningRequest: () => ({}),
}));
vi.mock("@pcash/sdk/wallet/web", () => ({
  viemPcashActionSigner: (_client: unknown, address: string) => ({ address, signTypedData: state.sign }),
  createBrowserWalletProvers: () => ({ cancelCurrent: () => undefined, destroy: state.destroyProver }), browserWalletDatabaseName: () => "test-wallet",
  openBrowserWallet: async ({ profile }: { profile: { address: bigint; nkRoot: bigint } }) => {
    // The account's key is recorded by the first profile that sees it; a later, different one is refused.
    const matchAccount = () => {
      const address = `0x${profile.address.toString(16).padStart(40, "0")}`;
      const accountProfile = state.accountProfiles.get(address);
      if (accountProfile !== undefined && accountProfile !== profile.nkRoot) {
        throw new Error("derived PCASH profile does not match the account's nullifier-key commitment; the wallet returned a different profile signature or the account uses another profile");
      }
      state.accountProfiles.set(address, profile.nkRoot);
    };
    return {
    close: state.close, send: state.send, network: { chainId: 1n }, address: `0x${profile.address.toString(16).padStart(40, "0")}`,
    on: (name: string, listener: (event: unknown) => unknown) => {
      const listeners = state.events.get(name) ?? new Set();
      listeners.add(listener); state.events.set(name, listeners);
      return async () => { listeners.delete(listener); };
    },
    hook: (name: string, listener: (event: unknown) => unknown) => {
      state.hooks.set(name, listener);
      return () => { state.hooks.delete(name); };
    },
    snapshot: async () => {
      state.snapshotReads += 1;
      await state.snapshotPause;
      return { address: `0x${profile.address.toString(16).padStart(40, "0")}`, network: { chainId: 1n, genesisHash: `0x${"00".repeat(32)}` },
        pendingContentHashes: [], pendingPayments: [], paymentHistory: [], syncedThrough: { pcashNumber: 1n, pcashHash: "head" } };
    },
    notes: state.notes, nativeFunds: async () => ({ total: 10n, synchronized: true }),
    clearAccountActivation: async () => undefined,
    defaultAccountReady: async () => {
      if (state.accountReady) matchAccount();
      return state.accountReady;
    },
    accountActivation: async () => null, prepareAccountActivation: state.prepareActivation,
    sync: async () => {
      await state.syncPause;
      matchAccount();
      const result = { syncedThrough: { pcashNumber: 1n, pcashHash: "head" } };
      for (const listener of state.events.get("sync:completed") ?? []) await listener(result);
      return result;
    },
    startSync: (options: unknown) => state.startSync(options), stopSync: async () => state.stopSync(),
    };
  },
}));
vi.mock("@pcash/sdk/clients", async (original) => ({ ...await original<typeof import("@pcash/sdk/clients")>(), PcashNodeClient: class {
  async status() { return { pcashChainId: 1n, l1ChainId: 1n, genesisHash: `0x${"00".repeat(32)}`, inboxAddress: `0x${"11".repeat(20)}` }; }
} }));
import { FasterGasError, WalletProvider, useWallet } from "./WalletProvider.tsx";

const A = `0x${"ab".repeat(20)}`;
const B = `0x${"cd".repeat(20)}`;
const network = { name: "mainnet", pcashChainId: 1, pcashRpcUrl: "https://node.example", l1ChainId: 1, l1RpcUrls: ["https://l1.example"] };
const store = createProfileSessionStore(networkInstanceKey(network));
const identity = (account: string): ProfileSessionIdentity => ({ account, pcashChainId: "1", l1ChainId: "1", genesisHash: `0x${"00".repeat(32)}`, inboxAddress: `0x${"11".repeat(20)}` });
async function forget(account: string) {
  await store.clearProfileSessionIfRevision(identity(account), await store.profileSessionRevision(identity(account)));
}
let observed: ReturnType<typeof useWallet>;
let root: Root;
let element: HTMLDivElement;
function Probe() { observed = useWallet(); return null; }
function tree() {
  return <NetworkContext.Provider value={{ network }}><MemoryRouter><WalletProvider><Probe /></WalletProvider></MemoryRouter></NetworkContext.Provider>;
}
async function settle(phase: string) {
  await vi.waitFor(async () => {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    expect(observed.phase).toBe(phase);
  });
}
async function select(account: string, phase: string) {
  state.connection = { ...state.connection, status: "connected", address: account };
  await act(async () => root.render(tree()));
  await settle(phase);
}
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("BroadcastChannel", BroadcastChannel);
  state.events.clear(); state.hooks.clear(); state.recovery = undefined; state.accountReady = true; state.accountProfiles.clear();
  state.send.mockReset(); state.submit.mockReset(); state.prepareActivation.mockReset();
  // Exactly enough ETH for the Faster gas check.
  state.quoteBatch.mockReset().mockResolvedValue({ balanceWei: 1n, maximumCostWei: 1n });
  state.startSync.mockReset(); state.stopSync.mockReset(); state.notes.mockReset().mockResolvedValue([{ amount: 10n }]); state.snapshotReads = 0; state.snapshotPause = undefined; state.syncPause = undefined;
  state.destroyProver.mockReset();
  state.sign.mockReset().mockResolvedValue("signature-1");
  state.close.mockReset().mockResolvedValue(undefined);
  state.connection = { ...state.connection, status: "connected", address: A, chainId: 1 };
  element = document.createElement("div"); root = createRoot(element);
  await act(async () => root.render(tree()));
  await settle("sign-in-required");
});
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });

describe("browser wallet sign-ins", () => {
  it("asks for the key signature right after a connection the user requested, not after a restored one", async () => {
    expect(state.sign).not.toHaveBeenCalled();
    await act(async () => { observed.beginOnboarding(); await observed.connect(); });
    await settle("ready");
    expect(state.sign).toHaveBeenCalledOnce();
  });

  it("stays connected and locked, offering Sign in again, when the signature is declined", async () => {
    state.sign.mockRejectedValueOnce(Object.assign(new Error("User rejected the request."), { code: 4001 }));
    await act(async () => { observed.beginOnboarding(); await observed.connect(); });
    await settle("sign-in-required");
    expect(observed.connectedAccount).toBe(A);
    expect(observed.error).toBe("You rejected the request in your wallet.");
    await act(async () => { await observed.signIn(); });
    await settle("ready");
    expect(state.sign).toHaveBeenCalledTimes(2);
  });

  it("is ready as soon as the account is known, while the wallet catches up behind it", async () => {
    state.syncPause = new Promise(() => undefined);
    await act(async () => { await observed.signIn(); });
    await settle("ready");
    await vi.waitFor(() => expect(state.startSync).toHaveBeenCalledOnce());
    await act(async () => { observed.beginOnboarding(); await observed.connect(); });
    await settle("ready");
    expect(state.sign).toHaveBeenCalledOnce();
  });

  it("uses a saved sign-in on a requested connection instead of asking again", async () => {
    await act(async () => { await observed.signIn(); });
    await settle("ready");
    await act(async () => { observed.beginOnboarding(); await observed.connect(); });
    await settle("ready");
    expect(state.sign).toHaveBeenCalledOnce();
  });

  it("explains when a second valid profile signature derives a different account key", async () => {
    await act(async () => { await observed.signIn(); });
    await settle("ready");
    await act(async () => { await forget(A); });
    await settle("disconnected");
    await select(A, "sign-in-required");
    state.sign.mockResolvedValueOnce("signature-2");
    await act(async () => { await observed.signIn().catch(() => undefined); });
    await settle("error");
    expect(observed.error).toBe("This wallet produced a different key than when the account was created. This can happen with wallets that do not sign the same way twice. Your funds are reachable only from the browser where you first used this account. Do not clear that browser's site data.");
    expect(observed.error).not.toContain("nullifier-key commitment");
  });

  it("uses one terminal read for an awaited sync and keeps background completion refreshes", async () => {
    await act(async () => { await observed.signIn(); });
    await settle("ready");
    state.snapshotReads = 0;
    await act(async () => { await observed.synchronize(); });
    expect(state.snapshotReads).toBe(1);
    expect(state.notes).not.toHaveBeenCalled();
    for (const listener of state.events.get("sync:completed") ?? []) await act(async () => listener({ syncedThrough: { pcashNumber: 2n, pcashHash: "next" } }));
    await vi.waitFor(() => expect(state.snapshotReads).toBe(2));
  });

  it("queues a newer snapshot event while a state read is in flight", async () => {
    await act(async () => { await observed.signIn(); });
    await settle("ready");
    state.snapshotReads = 0;
    let resume!: () => void;
    state.snapshotPause = new Promise<void>((resolve) => { resume = resolve; });
    for (const listener of state.events.get("snapshot") ?? []) listener({});
    await vi.waitFor(() => expect(state.snapshotReads).toBe(1));
    for (const listener of state.events.get("snapshot") ?? []) listener({});
    await act(async () => resume());
    await vi.waitFor(() => expect(state.snapshotReads).toBe(2));
  });

  it("waits for an applied terminal read when a direct refresh starts during it", async () => {
    await act(async () => { await observed.signIn(); });
    await settle("ready");
    state.snapshotReads = 0;
    let resume!: () => void;
    state.snapshotPause = new Promise<void>((resolve) => { resume = resolve; });
    let sync!: Promise<void>;
    await act(async () => { sync = observed.synchronize(); });
    await vi.waitFor(() => expect(state.snapshotReads).toBe(1));
    let refresh!: Promise<void>;
    await act(async () => { refresh = observed.refresh(); });
    await vi.waitFor(() => expect(state.snapshotReads).toBe(2));
    await act(async () => { resume(); await Promise.all([sync, refresh]); });
    expect(state.snapshotReads).toBe(3);
    expect(observed.funds?.total).toBe(10n);
  });

  it("leaves the ready publication UI when the connected Ethereum chain changes", async () => {
    await act(async () => { await observed.signIn(); });
    await settle("ready");
    expect(observed.selfPublication).toBeDefined();

    state.connection = { ...state.connection, chainId: 2 };
    await act(async () => root.render(tree()));
    await settle("wrong-network");
    expect(observed.selfPublication).toBeUndefined();
    expect(observed.profile).toBeUndefined();
  });

  it("restores two wallets across switching, disconnect, and provider remount without signing again", async () => {
    await act(async () => { await observed.signIn(); });
    await settle("ready");
    await select(B, "sign-in-required");
    await act(async () => { await observed.signIn(); });
    await settle("ready");
    await select(A, "ready");
    expect(observed.profile?.address).toBe(BigInt(A));
    expect(observed.funds?.total).toBe(10n);
    expect(state.sign).toHaveBeenCalledTimes(2);
    const destroyedBeforeDisconnect = state.destroyProver.mock.calls.length;
    await act(async () => observed.disconnect());
    expect(state.destroyProver).toHaveBeenCalledTimes(destroyedBeforeDisconnect + 1);
    expect(observed.profile).toBeUndefined();
    await select(B, "ready");
    expect(observed.profile?.address).toBe(BigInt(B));
    const destroyedBeforeUnmount = state.destroyProver.mock.calls.length;
    await act(async () => root.unmount());
    expect(state.destroyProver).toHaveBeenCalledTimes(destroyedBeforeUnmount + 1);
    root = createRoot(element);
    await act(async () => root.render(tree()));
    await settle("ready");
    expect(observed.funds?.total).toBe(10n);
    expect(state.sign).toHaveBeenCalledTimes(2);
  });

  it("ignores another wallet's forgotten sign-in and closes a matching session forgotten in another tab", async () => {
    await act(async () => { await observed.signIn(); });
    await act(async () => forget(B));
    await settle("ready");
    await act(async () => forget(A));
    await settle("disconnected");
    expect(observed.profile).toBeUndefined();
    expect(observed.funds).toBeUndefined();
    await select(A, "sign-in-required");
  });
});


describe("fast payment broadcast state", () => {
  const contentHash = `0x${"12".repeat(32)}`;
  const l1Hash = `0x${"34".repeat(32)}`;
  const reviewed = { openFeeAmount: 0n, privateRelayFeeAmount: 0n, privateRelayRecipient: null, beneficiary: { kind: "self" as const }, publication: "self" as const,
    inputCount: 0, inputTotal: 0n, retry: false };
  const intent = { to: A, amount: 0n, publication: "self" as const };
  async function emit(name: string, event: unknown) {
    for (const listener of state.events.get(name) ?? []) await listener(event);
  }
  beforeEach(async () => {
    await act(async () => { await observed.signIn(); });
    state.send.mockImplementation(async ({ submission }) => {
      const action = { id: "send-1", name: "send" };
      await emit("action:started", { action });
      await state.hooks.get("action:before-journal")?.({ action, contentHash });
      await emit("action:prepared", { action, contentHash });
      return submission.submit({});
    });
  });

  it("publishes the hash before receipt waiting completes and preserves it after a timeout", async () => {
    let rejectReceipt!: (cause: Error) => void;
    state.submit.mockImplementation(async (params) => {
      await params.onL1Submitted(l1Hash);
      return new Promise((_resolve, reject) => { rejectReceipt = reject; });
    });
    let sending!: Promise<unknown>;
    await act(async () => { sending = observed.sendPrivate(intent, reviewed).catch((cause) => cause); });
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(observed.paymentStage).toMatchObject({ state: "l1-submitted", contentHash, l1Hash });
    });
    expect(observed.busy).toBe(true);
    await act(async () => { rejectReceipt(new Error("Receipt wait timed out")); await sending; });
    expect(observed.paymentStage).toMatchObject({ state: "l1-submitted", contentHash, l1Hash });
    expect(observed.busy).toBe(false);
    expect(observed.error).toBeUndefined();
    expect(state.submit).toHaveBeenCalledOnce();
  });

  it("returns the broadcast in the outcome and ends the stage when the send action finishes", async () => {
    state.submit.mockImplementation(async (params) => {
      await params.onL1Submitted(l1Hash);
      return { contentHash, l1Hash, accepted: false, queued: true };
    });
    let outcome: Awaited<ReturnType<typeof observed.sendPrivate>> | undefined;
    await act(async () => { outcome = await observed.sendPrivate(intent, reviewed); });
    expect(outcome).toMatchObject({ contentHash, l1Hash });
    expect(observed.paymentStage).toEqual({ state: "idle" });
  });

  it("keeps unhashed submission failures ambiguous", async () => {
    state.submit.mockRejectedValue(new Error("Wallet did not return a hash"));
    await act(async () => { await observed.sendPrivate(intent, reviewed).catch(() => undefined); });
    expect(observed.paymentStage).toMatchObject({ state: "submission-unknown", contentHash });
  });

  it("cannot restore payment state after disconnecting during submission", async () => {
    let complete!: (value: unknown) => void;
    state.submit.mockImplementation(async (params) => {
      await params.onL1Submitted(l1Hash);
      return new Promise((resolve) => { complete = resolve; });
    });
    let sending!: Promise<unknown>;
    await act(async () => { sending = observed.sendPrivate(intent, reviewed).catch((cause) => cause); });
    await vi.waitFor(() => expect(complete).toBeDefined());
    await act(async () => observed.disconnect());
    await act(async () => emit("action:prepared", { action: { id: "send-1", name: "send" }, contentHash }));
    expect(observed.paymentStage).toEqual({ state: "idle" });
    await act(async () => { complete({ contentHash, l1Hash }); await sending; });
    expect(observed.paymentStage).toEqual({ state: "idle" });
    expect(observed.phase).toBe("disconnected");
  });
});

describe("Faster gas check", () => {
  const reviewed = { openFeeAmount: 0n, privateRelayFeeAmount: 0n, privateRelayRecipient: null, beneficiary: { kind: "self" as const },
    publication: "self" as const, inputCount: 0, inputTotal: 0n, retry: false };
  beforeEach(async () => {
    await act(async () => { await observed.signIn(); });
    await settle("ready");
    state.quoteBatch.mockResolvedValue({ balanceWei: 1n, maximumCostWei: 2n });
    state.send.mockResolvedValue({ contentHash: `0x${"12".repeat(32)}`, accepted: true, queued: false });
  });

  it("stops a Faster send the Ethereum wallet cannot pay gas for before it is proved", async () => {
    let caught: unknown;
    await act(async () => { caught = await observed.sendPrivate({ to: A, amount: 1n, publication: "self" }, reviewed).catch((cause) => cause); });
    expect(caught).toBeInstanceOf(FasterGasError);
    expect(state.send).not.toHaveBeenCalled();
    expect(observed.paymentStage).toMatchObject({ state: "failed" });
  });

  it.each([
    { name: "a More private send", publication: "open" as const, retry: false },
    { name: "a retry", publication: "self" as const, retry: true },
  ])("does not check gas for $name", async ({ publication, retry }) => {
    await act(async () => { await observed.sendPrivate({ to: A, amount: 1n, publication }, { ...reviewed, publication, retry }); });
    expect(state.quoteBatch).not.toHaveBeenCalled();
    expect(state.send).toHaveBeenCalledOnce();
  });

  it.each([
    { name: "quote", quotes: 1, fail: () => { state.quoteBatch.mockRejectedValue(new Error("L1 RPC unavailable")); } },
    { name: "status read", quotes: 0, fail: () => { vi.spyOn(observed.node, "status").mockRejectedValueOnce(new Error("node unavailable")); } },
  ])("lets a Faster send continue when the gas $name fails", async ({ quotes, fail }) => {
    fail();
    await act(async () => { await observed.sendPrivate({ to: A, amount: 1n, publication: "self" }, reviewed); });
    expect(state.quoteBatch).toHaveBeenCalledTimes(quotes);
    expect(state.send).toHaveBeenCalledOnce();
  });

  it("stops a Faster send when the quote finds the submission journal blocked", async () => {
    const conflict = Object.assign(new Error("An earlier submission is in flight"), { name: "RelayJournalConflictError" });
    state.quoteBatch.mockRejectedValue(conflict);
    let caught: unknown;
    await act(async () => { caught = await observed.sendPrivate({ to: A, amount: 1n, publication: "self" }, reviewed).catch((cause) => cause); });
    expect(caught).toBe(conflict);
    expect(state.send).not.toHaveBeenCalled();
  });

  it("quotes account setup as its creation entry and one action, before preparing it", async () => {
    state.accountReady = false;
    let caught: unknown;
    await act(async () => { caught = await observed.setupAccount().catch((cause) => cause); });
    expect(caught).toBeInstanceOf(FasterGasError);
    const { transactions: entries } = state.quoteBatch.mock.calls[0]![0] as { transactions: Uint8Array[] };
    expect(entries.map((entry) => entry.length)).toEqual([3, 4]);
    expect(state.prepareActivation).not.toHaveBeenCalled();
    expect(observed.error).toBe("Not enough ETH for gas. Add ETH to your Ethereum wallet and try again.");
  });
});

describe("Ethereum submission lock", () => {
  const entry = { kind: "batch", resolutionId: "lock", transactionHash: null, selected: ["content"] } as unknown as RelayJournalEntry;
  afterEach(() => { vi.useRealTimers(); });

  it("locks and opens the wallet prompt at journaling, and closes the prompt on the hash or a failure", async () => {
    await act(async () => { await observed.signIn(); });
    await settle("ready");
    let confirm: (() => void) | undefined;
    let reject: ((cause: Error) => void) | undefined;
    state.submit
      .mockImplementationOnce(async (params) => {
        await params.onL1Journaled(entry);
        await new Promise<void>((resolve) => { confirm = resolve; });
        await params.onL1Submitted(`0x${"34".repeat(32)}`);
        return new Promise(() => undefined); // waiting for the receipt
      })
      .mockImplementationOnce(async (params) => {
        await params.onL1Journaled(entry);
        return new Promise((_resolve, fail) => { reject = fail; });
      });
    const callerJournaled = vi.fn();
    await act(async () => { void observed.selfPublication!.submit({ onL1Journaled: callerJournaled } as never); });
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(confirm).toBeDefined();
      expect(observed.submissionLock).toEqual(entry);
      expect(observed.walletPromptOpen).toBe(true);
    });
    expect(callerJournaled).toHaveBeenCalledWith(entry);
    await act(async () => { confirm!(); });
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(observed.walletPromptOpen).toBe(false);
    });

    let failing!: Promise<unknown>;
    await act(async () => { failing = observed.selfPublication!.submit({} as never).catch(() => undefined); });
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(reject).toBeDefined();
      expect(observed.walletPromptOpen).toBe(true);
    });
    await act(async () => { reject!(new Error("User rejected the request.")); await failing; });
    expect(observed.walletPromptOpen).toBe(false);
  });

  it("settles a lock at once and every 5 seconds, one settlement at a time, until it clears", async () => {
    let journaled = false;
    const settlements: ((reconciliation: unknown) => void)[] = [];
    state.recovery = {
      show: async () => ({ latched: journaled, entries: journaled ? [entry] : [] }),
      reconcile: () => new Promise((resolve) => { settlements.push(resolve); }),
      resolve: vi.fn(),
    } as unknown as RelayJournalRecovery;
    await act(async () => { await observed.signIn(); });
    await settle("ready");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    state.submit.mockImplementation(async (params) => { journaled = true; await params.onL1Journaled(entry); return {}; });
    await act(async () => { await observed.selfPublication!.submit({} as never); });
    await vi.waitFor(() => expect(settlements).toHaveLength(1));

    // An unresolved settlement holds the next one, and Check status shares it.
    let manual!: Promise<unknown>;
    await act(async () => { manual = observed.refreshSubmissionLock(); await vi.advanceTimersByTimeAsync(15_000); });
    expect(settlements).toHaveLength(1);

    const stillPending = { latched: true, entries: [{ outcome: "unobserved", resolutionId: "lock", transactionHash: null }] };
    await act(async () => { settlements[0]!(stillPending); await manual; });
    expect(observed.submissionLock).toEqual(entry);
    await act(async () => { await vi.advanceTimersByTimeAsync(4_999); });
    expect(settlements).toHaveLength(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(settlements).toHaveLength(2);

    journaled = false;
    await act(async () => { settlements[1]!({ latched: false, entries: [] }); await vi.advanceTimersByTimeAsync(0); });
    expect(observed.submissionLock).toBeUndefined();
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(settlements).toHaveLength(2);
  });
});

describe("errors of actions started on other screens", () => {
  async function emit(name: string, event: unknown) {
    for (const listener of state.events.get(name) ?? []) await listener(event);
  }
  beforeEach(async () => {
    await act(async () => { await observed.signIn(); });
    await settle("ready");
  });

  it("rejects to the screen that ran the action without recording a wallet error", async () => {
    const failure = new Error("insufficient funds for gas * price + value");
    let caught: unknown;
    await act(async () => { await observed.runAction(async () => { throw failure; }).catch((cause) => { caught = cause; }); });
    expect(caught).toBe(failure);
    expect(observed.busy).toBe(false);
    expect(observed.error).toBeUndefined();
    await act(async () => emit("action:error", { action: { id: "buy-1", name: "send" }, error: failure }));
    expect(observed.error).toBeUndefined();
  });

  it("shows a failed background sync once, in plain words, as the sync state", async () => {
    await act(async () => emit("sync:error", { error: Object.assign(new Error("HTTP request failed.\n\nURL: https://node.example"), { name: "HttpRequestError", shortMessage: "HTTP request failed." }) }));
    expect(observed.syncState).toEqual({ state: "error", error: "The network did not respond. Try again in a moment." });
    expect(observed.error).toBeUndefined();
  });
});

describe("following the node tip", () => {
  async function emit(name: string, event: unknown) {
    for (const listener of state.events.get(name) ?? []) await listener(event);
  }
  afterEach(() => { vi.restoreAllMocks(); });

  it("follows every 4 seconds only while the tab is visible and shares what it read", async () => {
    let hidden = false;
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => hidden ? "hidden" : "visible");
    await act(async () => { await observed.signIn(); });
    await settle("ready");
    await vi.waitFor(() => expect(state.startSync).toHaveBeenLastCalledWith({ intervalMs: 4_000 }));
    const starts = state.startSync.mock.calls.length;
    hidden = true;
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(state.stopSync).toHaveBeenCalledOnce();
    hidden = false;
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    await vi.waitFor(() => expect(state.startSync).toHaveBeenCalledTimes(starts + 1));
    const status = { latestBlock: 5n };
    await act(async () => emit("sync:tip", { status }));
    expect(observed.followedStatus?.status).toBe(status);
  });

  it("reads wallet state once for a burst of snapshot writes", async () => {
    await act(async () => { await observed.signIn(); });
    await settle("ready");
    const reads = state.snapshotReads;
    await act(async () => { for (let write = 0; write < 5; write += 1) void emit("snapshot", {}); });
    await vi.waitFor(async () => {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
      expect(state.snapshotReads).toBeGreaterThan(reads);
    });
    // One read, and at most one more for the writes that arrived during it.
    expect(state.snapshotReads - reads).toBeLessThanOrEqual(2);
  });
});

it.each(["submission refresh", "account check"].flatMap(path => ([0, 1] as const).map(receiptStatus => ({ path, receiptStatus }))))("preserves cleared receipt $receiptStatus through $path outside the Get page", async ({ path, receiptStatus }) => {
  const hash = `0x${"ef".repeat(32)}`;
  const entry = { kind: "batch", resolutionId: "recovered-get", transactionHash: null, selected: ["content"] } as RelayJournalEntry;
  // Journaled after the attempt is recorded; a lock at sign-in would be settled by the provider's poll first.
  let journaled = false;
  let reconciled = false;
  state.recovery = {
    show: async () => ({ latched: journaled && !reconciled, entries: journaled && !reconciled ? [entry] : [] }),
    reconcile: async () => {
      reconciled = true;
      return { latched: false, entries: [{ outcome: "cleared", resolutionId: entry.resolutionId, transactionHash: hash,
        l1Receipt: { status: receiptStatus, blockNumber: 2n, blockHash: hash, transactionIndex: 0, gasUsed: 21_000n } }] };
    },
    resolve: vi.fn(),
  };
  await act(async () => { await observed.signIn(); });
  await settle("ready");
  const key = relayHistoryKey(relayDeploymentKey(observed.status!), A);
  saveRelayHistory(key, [{ id: "get", at: 0, status: "wallet", resolutionId: entry.resolutionId, contentHashes: ["content"] }]);
  journaled = true;
  try {
    if (path === "account check") state.accountReady = false;
    await act(async () => { if (path === "account check") await observed.checkAccountActivation(); else await observed.refreshSubmissionLock(); });
    const saved = readRelayHistory(key)[0]!;
    expect(saved).toMatchObject({ status: "pending", txHash: hash, resolutionId: entry.resolutionId });
    expect(saved.error).toBeUndefined();
    if (path === "submission refresh") expect(observed.submissionLock).toBeUndefined();
  } finally { sessionStorage.removeItem(key); }
});
