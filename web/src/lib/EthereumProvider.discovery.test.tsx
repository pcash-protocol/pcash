// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ACCOUNT = "0x1111111111111111111111111111111111111111";
const ICON = "data:image/svg+xml;base64,PHN2Zy8+";
let root: Root;
let container: HTMLDivElement;
let config: ReturnType<(typeof import("./EthereumProvider.tsx"))["createEthereumNetwork"]>["ethereumConfig"] | undefined;
let removeAnnouncement: (() => void) | undefined;

function walletProvider(isRabby = false) {
  let connected = false;
  return {
    isRabby,
    request: vi.fn(async ({ method }: { method: string }): Promise<string | string[]> => {
      switch (method) {
        case "eth_chainId": return "0x7a69";
        case "eth_accounts": return connected ? [ACCOUNT] : [];
        case "eth_requestAccounts": connected = true; return [ACCOUNT];
        case "wallet_requestPermissions": throw Object.assign(new Error("unsupported"), { code: -32601 });
        default: throw new Error(`Unexpected wallet request: ${method}`);
      }
    }),
    on: vi.fn(),
    removeListener: vi.fn(),
  };
}

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubEnv("VITE_L1_CHAIN_ID", "31337");
  localStorage.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  config?._internal.mipd?.destroy();
  config = undefined;
  removeAnnouncement?.();
  removeAnnouncement = undefined;
  container.remove();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function openPicker() {
  const { EthereumProvider, useEthereumNetwork } = await import("./EthereumProvider.tsx");
  const { useConnectModal } = await import("@rainbow-me/rainbowkit");
  const { NetworkProvider } = await import("./NetworkProvider.tsx");
  function ConnectButton() {
    config = useEthereumNetwork().ethereumConfig;
    const { openConnectModal } = useConnectModal();
    return <button disabled={!openConnectModal} onClick={openConnectModal}>Connect wallet</button>;
  }
  await act(async () => root.render(<NetworkProvider><EthereumProvider><ConnectButton /></EthereumProvider></NetworkProvider>));
  const button = container.querySelector("button")!;
  expect(button.disabled).toBe(false);
  await act(async () => button.click());
}

function walletOptions() {
  return [...document.querySelectorAll<HTMLButtonElement>('[data-testid^="rk-wallet-option-"]')];
}

describe("wallet picker discovery", () => {
  it.each([false, true])("connects to injected Rabby without an announcement (multiple wallets: %s)", async (multiple) => {
    const rabby = walletProvider(true);
    const otherWallet = walletProvider();
    vi.stubGlobal("ethereum", multiple ? { ...otherWallet, providers: [otherWallet, rabby] } : rabby);
    await openPicker();
    const option = walletOptions().find((button) => button.textContent?.includes("Rabby"));
    expect(option).toBeDefined();
    await act(async () => option!.click());
    expect(rabby.request).toHaveBeenCalledWith({ method: "eth_requestAccounts" });
    expect(otherWallet.request).not.toHaveBeenCalledWith({ method: "eth_requestAccounts" });
    expect(config!.state.status).toBe("connected");
  });

  it("adds and switches Rabby to a discovered Anvil chain", async () => {
    const chainId = 1_900_000_001;
    const chainHex = `0x${chainId.toString(16)}`;
    const rpcUrl = "http://127.0.0.1:9545";
    vi.stubEnv("VITE_L1_CHAIN_ID", String(chainId));
    vi.stubEnv("VITE_L1_RPC_URLS", rpcUrl);
    let current = "0x7a69";
    let added = false;
    let connected = false;
    const listeners = new Map<string, Set<(value: string) => void>>();
    const rabby = {
      isRabby: true,
      request: vi.fn(async ({ method, params }: { method: string; params?: Array<{ chainId: string }> }) => {
        if (method === "eth_chainId") return current;
        if (method === "eth_accounts") return connected ? [ACCOUNT] : [];
        if (method === "eth_requestAccounts") { connected = true; return [ACCOUNT]; }
        if (method === "wallet_addEthereumChain") {
          added = true; current = params![0]!.chainId;
          listeners.get("chainChanged")?.forEach((listener) => listener(current));
          return null;
        }
        if (method === "wallet_switchEthereumChain") {
          if (!added) throw Object.assign(new Error("Unknown chain"), { code: 4902 });
          current = params![0]!.chainId;
          listeners.get("chainChanged")?.forEach((listener) => listener(current));
          return null;
        }
        throw Object.assign(new Error("Unsupported method"), { code: -32601 });
      }),
      on(event: string, listener: (value: string) => void) {
        const callbacks = listeners.get(event) ?? new Set();
        callbacks.add(listener); listeners.set(event, callbacks);
      },
      removeListener(event: string, listener: (value: string) => void) { listeners.get(event)?.delete(listener); },
    };
    vi.stubGlobal("ethereum", rabby);
    await openPicker();
    await act(async () => walletOptions().find((button) => button.textContent?.includes("Rabby"))!.click());
    expect(rabby.request).toHaveBeenCalledWith({ method: "wallet_addEthereumChain", params: [expect.objectContaining({
      chainId: chainHex, chainName: `Chain ${chainId}`, rpcUrls: [rpcUrl], nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    })] });
    expect(current).toBe(chainHex);
    expect(config!.state.status).toBe("connected");
    expect(config!.state.chainId).toBe(chainId);
  });

  it("reconnects the saved connection when extension discovery resolves asynchronously", async () => {
    const { EthereumProvider, useEthereumNetwork } = await import("./EthereumProvider.tsx");
    const { NetworkProvider } = await import("./NetworkProvider.tsx");
    const rabby = walletProvider(true);
    rabby.request.mockImplementation(async ({ method }) => {
      if (method === "eth_accounts") {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return [ACCOUNT];
      }
      if (method === "eth_chainId") return "0x713fb301";
      throw new Error(`Unexpected wallet request: ${method}`);
    });
    vi.stubGlobal("ethereum", rabby);
    function Probe() { config = useEthereumNetwork().ethereumConfig; return null; }
    const base = { pcashChainId: 7, pcashRpcUrl: "http://localhost:8645", l1RpcUrls: ["http://localhost:8545"] };
    await act(async () => root.render(<NetworkProvider network={{ ...base, name: "Anvil", l1ChainId: 1900000001 }}><EthereumProvider><Probe /></EthereumProvider></NetworkProvider>));
    await act(async () => {
      await vi.waitFor(() => expect(config!.state.status).toBe("connected"));
    });
    expect(config!.chains[0].id).toBe(1900000001);
    expect(config!.state.chainId).toBe(1900000001);
    expect(rabby.request).not.toHaveBeenCalledWith(expect.objectContaining({ method: "eth_requestAccounts" }));
  });

  it("keeps announced wallets selectable and lists Rabby once", async () => {
    const rabby = walletProvider(true);
    vi.stubGlobal("ethereum", rabby);
    const announce = () => {
      for (const [rdns, name, provider] of [
        ["io.rabby", "Rabby Wallet", rabby],
        ["dev.pcash.other", "Other Wallet", walletProvider()],
      ] as const) {
        window.dispatchEvent(new CustomEvent("eip6963:announceProvider", {
          detail: { info: { uuid: crypto.randomUUID(), rdns, name, icon: ICON }, provider },
        }));
      }
    };
    window.addEventListener("eip6963:requestProvider", announce);
    removeAnnouncement = () => window.removeEventListener("eip6963:requestProvider", announce);
    await openPicker();
    expect(walletOptions().filter((button) => button.textContent?.includes("Rabby"))).toHaveLength(1);
    expect(walletOptions().some((button) => button.textContent?.includes("Other Wallet"))).toBe(true);
  });
});
