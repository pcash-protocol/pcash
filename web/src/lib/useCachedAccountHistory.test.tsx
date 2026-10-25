// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { IDBFactory } from "fake-indexeddb";
import { BroadcastChannel } from "node:worker_threads";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NetworkContext } from "../components/NetworkContext.tsx";
import { createProfileSessionStore, profileSessionIdentity } from "./ProfileSessionStore.ts";
import { networkInstanceKey } from "./networks.ts";

const state = vi.hoisted(() => ({
  wallet: { node: {}, status: { pcashChainId: 1, l1ChainId: 1n, genesisHash: `0x${"00".repeat(32)}`, inboxAddress: `0x${"11".repeat(20)}` },
    profile: undefined as { address: bigint } | undefined, connectedAccount: undefined as string | undefined,
    wallet: undefined as unknown, snapshot: undefined as unknown, funds: undefined as unknown },
  derive: vi.fn(), open: vi.fn(),
}));
vi.mock("./WalletProvider.tsx", () => ({ useWallet: () => state.wallet, errorMessage: (error: Error) => error.message }));
vi.mock("@pcash/sdk/wallet", () => ({ derivePcashProfileFromSignature: state.derive }));
vi.mock("@pcash/sdk/wallet/web", () => ({ openBrowserWallet: state.open, browserWalletDatabaseName: () => "test-wallet" }));
import { useCachedAccountHistory } from "./useCachedAccountHistory.ts";

const A = `0x${"ab".repeat(20)}`;
const B = `0x${"cd".repeat(20)}`;
const network = { name: "Cached history test", pcashChainId: 1, pcashRpcUrl: "https://node.example", l1ChainId: 1, l1RpcUrls: ["https://l1.example"] };
const store = createProfileSessionStore(networkInstanceKey(network));
const wallets = new Map<string, ReturnType<typeof mockWallet>>();
function mockWallet(address: string) {
  return {
    sync: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined),
    snapshot: vi.fn().mockResolvedValue({ address, pendingPayments: [], paymentHistory: [], syncedThrough: { pcashHash: "head", pcashNumber: 1n } }),
    nativeActivity: vi.fn().mockResolvedValue({ state: "ready", entries: [{ transactionId: address }], pcashHash: "head", pcashNumber: 1n }),
    nativeFunds: vi.fn().mockResolvedValue({ total: 7n, synchronized: true }),
  };
}
let root: Root;
let address: string;
let observed: ReturnType<typeof useCachedAccountHistory>;
function Probe() { observed = useCachedAccountHistory(address); return null; }
let queryClient: QueryClient;
async function render() {
  await act(async () => root.render(<QueryClientProvider client={queryClient}><NetworkContext.Provider value={{ network }}><Probe /></NetworkContext.Provider></QueryClientProvider>));
}
async function settle(phase: string) {
  await vi.waitFor(async () => {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
    expect(observed.phase).toBe(phase);
  });
}
async function save(account = A, signature = account) {
  const identity = profileSessionIdentity(state.wallet.status, account);
  await store.saveProfileSession(identity, signature, await store.profileSessionRevision(identity));
}
async function forget(account: string) {
  const identity = profileSessionIdentity(state.wallet.status, account);
  await store.clearProfileSessionIfRevision(identity, await store.profileSessionRevision(identity));
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("BroadcastChannel", BroadcastChannel);
  address = A;
  queryClient = new QueryClient();
  root = createRoot(document.createElement("div"));
  state.wallet.profile = undefined; state.wallet.connectedAccount = undefined;
  state.wallet.wallet = undefined; state.wallet.snapshot = undefined; state.wallet.funds = undefined;
  state.wallet.status = { pcashChainId: 1, l1ChainId: 1n, genesisHash: `0x${"00".repeat(32)}`, inboxAddress: `0x${"11".repeat(20)}` };
  wallets.clear(); wallets.set(A, mockWallet(A)); wallets.set(B, mockWallet(B));
  state.derive.mockReset().mockImplementation((signature, network, account) => ({ signature, network, address: account.toLowerCase() }));
  state.open.mockReset().mockImplementation(async ({ profile }) => wallets.get(profile.address));
});
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });

it.each([undefined, B])("recovers cached history without signing when connected as %s", async (connected) => {
  state.wallet.connectedAccount = connected;
  await save(); await render(); await settle("ready");
  expect(state.derive).toHaveBeenCalledWith(A, expect.anything(), A);
  expect(state.open.mock.calls[0]![0]).not.toHaveProperty("signer");
  expect(state.open.mock.calls[0]![0]).not.toHaveProperty("submission");
  expect(wallets.get(A)!.nativeActivity).toHaveBeenCalledWith({ recoverHistory: true });
  expect(observed.activity).toMatchObject({ state: "ready", entries: [{ transactionId: A }] });
  expect(observed.funds?.total).toBe(7n);
});

it("reads the signed-in account from its own wallet without opening another", async () => {
  const own = mockWallet(A);
  Object.assign(state.wallet, {
    wallet: own, connectedAccount: A, funds: { total: 9n, synchronized: true },
    snapshot: { address: A, pendingPayments: [], paymentHistory: [], syncedThrough: { pcashHash: "head", pcashNumber: 1n } },
  });
  await save(); await render(); await settle("ready");
  await vi.waitFor(() => expect(observed.activity).toMatchObject({ state: "ready", entries: [{ transactionId: A }] }));
  expect(state.open).not.toHaveBeenCalled();
  expect(own.sync).not.toHaveBeenCalled();
  expect(own.nativeActivity).toHaveBeenCalledWith({ recoverHistory: true });
  expect(observed.funds?.total).toBe(9n);
});

it("keeps an uncached address locked even when another account is cached", async () => {
  await save(B); await render(); await settle("locked");
  expect(state.open).not.toHaveBeenCalled();
  expect(observed.activity).toBeUndefined();
});

it.each(["pcashChainId", "l1ChainId", "genesisHash", "inboxAddress"] as const)("does not reuse a cached key for a different %s", async (field) => {
  await save();
  state.wallet.status = { ...state.wallet.status, [field]: field === "pcashChainId" ? 2 : field === "l1ChainId" ? 2n : `0x${"22".repeat(field === "genesisHash" ? 32 : 20)}` };
  await render(); await settle("locked");
  expect(state.open).not.toHaveBeenCalled();
});

it("switches between cached addresses and clears the previous account immediately", async () => {
  await save(); await save(B); await render(); await settle("ready");
  let resolveSync!: () => void;
  wallets.get(B)!.sync.mockImplementationOnce(() => new Promise<void>((resolve) => { resolveSync = resolve; }));
  address = B.toUpperCase(); await render();
  expect(observed.activity).toBeUndefined();
  await vi.waitFor(async () => {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
    expect(resolveSync).toBeDefined();
  });
  expect(wallets.get(A)!.close).toHaveBeenCalled();
  await act(async () => resolveSync()); await settle("ready");
  expect(observed.activity).toMatchObject({ entries: [{ transactionId: B }] });
});

it("reloads a cache created in another session while the page is open", async () => {
  await render(); await settle("locked");
  await act(async () => {
    await save();
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  await settle("ready");
});

it("clears decrypted history when this cached wallet's sign-in is forgotten, without clearing another wallet", async () => {
  await save(); await save(B); await render(); await settle("ready");
  await act(async () => {
    await forget(B);
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  expect(observed.phase).toBe("ready");
  await act(async () => {
    await forget(A);
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  await settle("locked");
  expect(observed.activity).toBeUndefined(); expect(observed.funds).toBeUndefined();
  expect(wallets.get(A)!.close).toHaveBeenCalled();
});

it("does not restore a late wallet open after its sign-in is forgotten", async () => {
  let resolveOpen!: (wallet: ReturnType<typeof mockWallet>) => void;
  state.open.mockImplementationOnce(() => new Promise((resolve) => { resolveOpen = resolve; }));
  await save(); await render();
  await vi.waitFor(() => expect(resolveOpen).toBeDefined());
  await act(async () => {
    await forget(A);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }); await settle("locked");
  await act(async () => resolveOpen(wallets.get(A)!));
  expect(observed.phase).toBe("locked");
  expect(wallets.get(A)!.close).toHaveBeenCalled();
  expect(wallets.get(A)!.nativeActivity).not.toHaveBeenCalled();
});

it("reports history recovery failure and retries", async () => {
  wallets.get(A)!.nativeActivity.mockRejectedValueOnce(new Error("RPC offline"));
  await save(); await render(); await settle("error");
  expect(observed.failed).toBe(true);
  await act(async () => observed.retry()); await settle("ready");
  expect(observed.failed).toBe(false);
});
