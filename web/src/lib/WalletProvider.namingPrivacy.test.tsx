// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { mainnet } from "viem/chains";
import { NetworkContext } from "../components/NetworkContext.tsx";
import { NameResolutionContext } from "../names/useEthereumName.ts";
import { NameResolutionSession } from "../names/NameResolutionSession.ts";
import { NAME_CACHE_KEY } from "../names/nameCache.ts";

const state = vi.hoisted(() => ({ connection: { status: "connected", address: `0x${"ab".repeat(20)}`, chainId: 1, connector: {} } }));
vi.mock("wagmi", () => ({ useAccount: () => state.connection, useBalance: () => ({}) }));
vi.mock("wagmi/actions", () => ({ getWalletClient: async () => ({}), disconnect: async () => undefined }));
vi.mock("./EthereumProvider.tsx", () => ({ useEthereumNetwork: () => ({ ethereumConfig: {}, l1Chain: { id: 1 }, l1ChainId: 1 }) }));
vi.mock("./networkWalletClient.ts", () => ({ networkWalletClient: () => ({}) }));
vi.mock("@pcash/sdk/wallet/web", () => ({ viemPcashActionSigner: (_client: unknown, address: string) => ({ address }) }));
vi.mock("./ProfileSessionStore.ts", async (original) => ({ ...await original<typeof import("./ProfileSessionStore.ts")>(), createProfileSessionStore: () => ({
  subscribeToSignOut: () => () => undefined,
  loadProfileSession: async () => ({ state: "absent", revision: 0 }),
  clearProfileSessionIfRevision: async () => true,
}) }));
vi.mock("@pcash/sdk/clients", async (original) => ({ ...await original<typeof import("@pcash/sdk/clients")>(), PcashNodeClient: class {
  async status() { return { pcashChainId: 1n, l1ChainId: 1n, genesisHash: `0x${"00".repeat(32)}`, inboxAddress: `0x${"11".repeat(20)}` }; }
  async getAccountProof(): Promise<never> { throw new Error("connecting must not name the address to the node"); }
} }));
import { WalletProvider, useWallet } from "./WalletProvider.tsx";

let session: NameResolutionSession;
let observed: ReturnType<typeof useWallet>;
let root: Root;
let element: HTMLDivElement;
const recipient = `0x${"12".repeat(20)}` as const;
const network = { name: "mainnet", pcashChainId: 1, pcashRpcUrl: "https://node.example", l1ChainId: mainnet.id, l1RpcUrls: ["https://l1.example"] };
function Probe() { observed = useWallet(); return null; }
function tree() {
  return <NameResolutionContext.Provider value={session}><NetworkContext.Provider value={{ network }}><MemoryRouter><WalletProvider><Probe /></WalletProvider></MemoryRouter></NetworkContext.Provider></NameResolutionContext.Provider>;
}
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  state.connection = { ...state.connection, status: "connected", address: `0x${"ab".repeat(20)}` };
  session = new NameResolutionSession(() => ({ resolveName: vi.fn(), reverseAddress: vi.fn(), getAvatar: vi.fn() }), () => localStorage);
  element = document.createElement("div"); root = createRoot(element);
  await act(async () => root.render(tree()));
  await vi.waitFor(async () => {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    expect(observed.connectedAccount).toBe(state.connection.address);
  });
});
afterEach(async () => { await act(async () => root.unmount()); session.stop(); session.queryClient.clear(); vi.unstubAllGlobals(); });

describe("wallet-independent naming preferences", () => {
  it.each(["disconnect", "account change"])("preserves naming preferences and caches when the wallet performs %s", async (event) => {
    await act(async () => session.setEnabled(true));
    session.cache.write(`1:reverse:${recipient}`, { identity: { address: recipient, name: "alice.wei", system: "wns" }, complete: true });
    session.cache.write("1:reverse:unnamed-recipient", { identity: null, complete: true });
    session.queryClient.setQueryData(["recipient", recipient], "alice.wei");
    if (event === "disconnect") await act(async () => observed.disconnect());
    else {
      state.connection = { ...state.connection, address: `0x${"cd".repeat(20)}` };
      await act(async () => root.render(tree()));
    }
    expect(session.getSnapshot().enabled).toBe(true);
    expect(session.cache.read(`1:reverse:${recipient}`)).toBeDefined();
    expect(session.cache.read("1:reverse:unnamed-recipient")).toBeDefined();
    expect(localStorage.getItem(NAME_CACHE_KEY)).not.toBeNull();
    expect(session.queryClient.getQueryData(["recipient", recipient])).toBe("alice.wei");
  });
});
