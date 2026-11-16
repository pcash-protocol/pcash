// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ACCOUNT = "0x1111111111111111111111111111111111111111";
const ICON = "data:image/svg+xml;base64,PHN2Zy8+";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1";
let root: Root;
let container: HTMLDivElement;
let config: ReturnType<(typeof import("./EthereumProvider.tsx"))["createEthereumNetwork"]>["ethereumConfig"] | undefined;
let removeAnnouncement: (() => void) | undefined;
const reconnected = vi.hoisted(() => [] as string[][]);
vi.mock("wagmi/actions", async (original) => {
  const actual = await original<typeof import("wagmi/actions")>();
  return {
    ...actual,
    reconnect: (...args: Parameters<typeof actual.reconnect>) => {
      reconnected.push((args[1]?.connectors ?? []).map((connector) => (connector as { id: string }).id));
      return actual.reconnect(...args);
    },
  };
});

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
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
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
  vi.restoreAllMocks();
});

async function openPicker() {
  const { EthereumProvider, useEthereumNetwork } = await import("./EthereumProvider.tsx");
  const { useConnectWalletDialog } = await import("../components/ConnectWalletDialog.tsx");
  const { NetworkProvider } = await import("./NetworkProvider.tsx");
  function ConnectButton() {
    config = useEthereumNetwork().ethereumConfig;
    const picker = useConnectWalletDialog();
    return <button onClick={picker.open}>Connect wallet</button>;
  }
  await act(async () => root.render(<MemoryRouter><NetworkProvider><EthereumProvider><ConnectButton /></EthereumProvider></NetworkProvider></MemoryRouter>));
  await act(async () => container.querySelector("button")!.click());
  // The Rabby option appears once its provider lookup settles.
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

function walletOptions() {
  return [...document.querySelectorAll<HTMLButtonElement>('[data-testid^="wallet-option-"]')];
}
const optionIds = () => walletOptions().map((button) => button.dataset.testid?.replace("wallet-option-", ""));

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

  it.each([[null, false], ["metaMaskSDK", true]])("asks MetaMask Connect to reconnect only when it was used last (last used: %s)", async (recent, asked) => {
    vi.stubEnv("VITE_WALLETCONNECT_PROJECT_ID", "test-project");
    if (recent !== null) localStorage.setItem("wagmi.recentConnectorId", JSON.stringify(recent));
    reconnected.length = 0;
    const { EthereumProvider, useEthereumNetwork } = await import("./EthereumProvider.tsx");
    const { NetworkProvider } = await import("./NetworkProvider.tsx");
    function Probe() { config = useEthereumNetwork().ethereumConfig; return null; }
    await act(async () => root.render(<NetworkProvider><EthereumProvider><Probe /></EthereumProvider></NetworkProvider>));
    await act(async () => { await vi.waitFor(() => expect(reconnected).toHaveLength(1)); });
    expect(reconnected[0]!.includes("metaMaskSDK")).toBe(asked);
    expect(reconnected[0]).not.toContain("walletConnect");
    expect(reconnected[0]).toContain("rabby");
  });

  it("offers wallet apps on an iPhone, where no extension is injected", async () => {
    vi.stubEnv("VITE_WALLETCONNECT_PROJECT_ID", "test-project");
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(IPHONE);
    await openPicker();
    expect(optionIds()).toEqual(["metaMask", "trust", "rainbow", "uniswap", "okx", "ledger", "zerion"]);
    expect(walletOptions().map((button) => button.querySelector("img")?.getAttribute("src"))).not.toContain(undefined);
  });

  it.each([
    ["a marketplace listing", "/marketplace?offer=0x2222222222222222222222222222222222222222", undefined],
    ["a private payment's recipient", "/alice.eth?to=0x1234567890123456789012345678901234567890#send", undefined],
    ["a claim link", "/claim#FAKE-CLAIM-BEARER-SECRET", undefined],
    ["a claim link the page holds while the wallet panel has the address bar", "/claim#wallet", "/claim#FAKE-CLAIM-BEARER-SECRET"],
  ])("sends MetaMask's link service only the host and copies %s for MetaMask's own browser", async (_, address, held) => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(IPHONE);
    window.history.replaceState(null, "", address);
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const pageRoot = createRoot(document.body.appendChild(document.createElement("div")));
    try {
      if (held !== undefined) {
        const { usePageFragment } = await import("../routes/tokens/usePageFragment.ts");
        const Page = () => { usePageFragment(); return null; };
        await act(async () => pageRoot.render(<MemoryRouter initialEntries={[held]}><Page /></MemoryRouter>));
      }
      await openPicker();
      const connect = vi.spyOn(config!.connectors.find((connector) => connector.id === "metaMaskSDK")!, "connect");
      await act(async () => walletOptions().find((button) => button.dataset.testid === "wallet-option-metaMask")!.click());
      expect(connect).not.toHaveBeenCalled();
      expect([...document.querySelectorAll<HTMLAnchorElement>('a[href*="metamask.app.link"]')].map((link) => link.href))
        .toEqual([`https://metamask.app.link/dapp/${window.location.host}`]);
      await act(async () => [...document.querySelectorAll("button")].find((button) => button.textContent === "Copy link")!.click());
      expect(writeText).toHaveBeenCalledWith(`${window.location.origin}${held ?? address}`);
    } finally {
      await act(async () => pageRoot.unmount());
      Reflect.deleteProperty(navigator, "clipboard");
      window.history.replaceState(null, "", "/");
    }
  });

  it("connects MetaMask inside MetaMask's own browser", async () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(`${IPHONE} MetaMaskMobile`);
    vi.stubGlobal("ReactNativeWebView", { postMessage() {} });
    await openPicker();
    const connect = vi.spyOn(config!.connectors.find((connector) => connector.id === "metaMaskSDK")!, "connect")
      .mockImplementation(async () => await new Promise<never>(() => undefined));
    await act(async () => walletOptions().find((button) => button.dataset.testid === "wallet-option-metaMask")!.click());
    expect(connect).toHaveBeenCalled();
  });

  it("focuses the title rather than the close button when the picker opens", async () => {
    await openPicker();
    expect(document.activeElement?.id).toBe("connect-wallet-title");
  });

  it("offers MetaMask and a WalletConnect code on a computer without extensions", async () => {
    vi.stubEnv("VITE_WALLETCONNECT_PROJECT_ID", "test-project");
    await openPicker();
    expect(optionIds()).toEqual(["metaMask", "walletConnect"]);
    expect(walletOptions().map((button) => button.querySelector("img")?.getAttribute("src"))).not.toContain(undefined);
    expect(document.body.textContent).toContain("Terms of Service");
  });

  it("offers MetaMask alone without a WalletConnect project", async () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(IPHONE);
    await openPicker();
    expect(optionIds()).toEqual(["metaMask"]);
  });

  it("shows the WalletConnect pairing link as a QR code on a computer", async () => {
    vi.stubEnv("VITE_WALLETCONNECT_PROJECT_ID", "test-project");
    await openPicker();
    const walletConnect = config!.connectors.find((connector) => connector.id === "walletConnect")!;
    vi.spyOn(walletConnect, "connect").mockImplementation(async () => {
      walletConnect.emitter.emit("message", { type: "display_uri", data: "wc:pairing@2?relay-protocol=irn&symKey=00" });
      return await new Promise<never>(() => undefined);
    });
    await act(async () => walletOptions().find((button) => button.dataset.testid === "wallet-option-walletConnect")!.click());
    expect(document.querySelector('[role="img"][aria-label="WalletConnect code"]')).not.toBeNull();
    expect(document.body.textContent).toContain("Scan with your phone wallet");
  });

  it("shows MetaMask's pairing link as a QR code on a computer without the extension", async () => {
    await openPicker();
    const metaMask = config!.connectors.find((connector) => connector.id === "metaMaskSDK")!;
    vi.spyOn(metaMask, "connect").mockImplementation(async () => {
      metaMask.emitter.emit("message", { type: "display_uri", data: "https://metamask.app.link/connect?p=00" });
      return await new Promise<never>(() => undefined);
    });
    await act(async () => walletOptions().find((button) => button.dataset.testid === "wallet-option-metaMask")!.click());
    expect(document.querySelector('[role="img"][aria-label="MetaMask code"]')).not.toBeNull();
  });

  it("connects to Rabby inside the Rabby app's browser", async () => {
    vi.stubEnv("VITE_WALLETCONNECT_PROJECT_ID", "test-project");
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(IPHONE);
    const rabby = walletProvider(true);
    vi.stubGlobal("ethereum", rabby);
    await openPicker();
    await act(async () => walletOptions().find((button) => button.dataset.testid === "wallet-option-rabby")!.click());
    expect(rabby.request).toHaveBeenCalledWith({ method: "eth_requestAccounts" });
    expect(config!.state.status).toBe("connected");
  });

  it.each([["desktop", undefined], ["iPhone", IPHONE]])("sends no part of a claim link while wallets set up (%s)", async (_, userAgent) => {
    const secret = "FAKE-CLAIM-BEARER-SECRET";
    vi.stubEnv("VITE_WALLETCONNECT_PROJECT_ID", "test-project");
    if (userAgent) vi.spyOn(navigator, "userAgent", "get").mockReturnValue(userAgent);
    window.history.replaceState(null, "", `/claim#${secret}`);
    const sent: Array<string | Promise<string>> = [];
    const record = (target: unknown, body?: unknown) => {
      sent.push(target instanceof Request ? target.url : String(target));
      if (body instanceof Blob) sent.push(body.text());
      else if (body !== undefined && body !== null) sent.push(typeof body === "string" ? body : JSON.stringify(body));
    };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      record(input, init?.body);
      return new Response("{}", { status: 503 });
    }));
    vi.stubGlobal("WebSocket", class { constructor(url: string) { record(url); } addEventListener() {} removeEventListener() {} close() {} send(data: unknown) { record("socket", data); } });
    Object.defineProperty(navigator, "sendBeacon", { configurable: true, value: (url: string, body?: unknown) => { record(url, body); return true; } });
    try {
      const { EthereumProvider, useEthereumNetwork } = await import("./EthereumProvider.tsx");
      const { NetworkProvider } = await import("./NetworkProvider.tsx");
      function Probe() { config = useEthereumNetwork().ethereumConfig; return null; }
      await act(async () => root.render(<NetworkProvider><EthereumProvider><Probe /></EthereumProvider></NetworkProvider>));
      await act(async () => { await Promise.all(config!.connectors.map((connector) => connector.getProvider().catch(() => undefined))); });
      await act(async () => {
        window.dispatchEvent(new Event("pagehide"));
        document.dispatchEvent(new Event("visibilitychange"));
        await new Promise((resolve) => setTimeout(resolve, 100));
      });
      expect((await Promise.all(sent)).filter((payload) => payload.includes(secret))).toEqual([]);
    } finally {
      Reflect.deleteProperty(navigator, "sendBeacon");
      window.history.replaceState(null, "", "/");
    }
  });

  it("saves the wallet app so WalletConnect reopens it for later requests", async () => {
    vi.stubEnv("VITE_WALLETCONNECT_PROJECT_ID", "test-project");
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(IPHONE);
    await openPicker();
    const walletConnect = config!.connectors.find((connector) => connector.id === "walletConnect")!;
    vi.spyOn(walletConnect, "connect").mockImplementation(async () => {
      walletConnect.emitter.emit("message", { type: "display_uri", data: "wc:pairing@2?relay-protocol=irn&symKey=00" });
      return await new Promise<never>(() => undefined);
    });
    await act(async () => walletOptions().find((button) => button.dataset.testid === "wallet-option-trust")!.click());
    expect(JSON.parse(localStorage.getItem("WALLETCONNECT_DEEPLINK_CHOICE")!)).toEqual({ href: "trust://wc", name: "Trust Wallet" });
  });

  function announcedWallet(rdns: string, account: string, onRevoke?: () => Promise<void>) {
    let approve!: () => void;
    const approved = new Promise<void>((resolve) => { approve = resolve; });
    let connected = false;
    const provider = {
      request: vi.fn(async ({ method }: { method: string }) => {
        switch (method) {
          case "eth_chainId": return "0x7a69";
          case "eth_accounts": return connected ? [account] : [];
          case "eth_requestAccounts": await approved; connected = true; return [account];
          case "wallet_requestPermissions": throw Object.assign(new Error("unsupported"), { code: -32601 });
          case "wallet_revokePermissions": await onRevoke?.(); return null;
          default: throw new Error(`Unexpected wallet request: ${method}`);
        }
      }),
      on: vi.fn(),
      removeListener: vi.fn(),
    };
    const announce = () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", {
      detail: { info: { uuid: crypto.randomUUID(), rdns, name: rdns, icon: ICON }, provider },
    }));
    window.addEventListener("eip6963:requestProvider", announce);
    return { approve, stop: () => window.removeEventListener("eip6963:requestProvider", announce) };
  }
  const click = (id: string) => act(async () => walletOptions().find((button) => button.dataset.testid === `wallet-option-${id}`)!.click());
  const clickButton = (label: string) => act(async () => [...document.querySelectorAll("button")].find((button) => button.textContent === label)!.click());
  const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  const currentId = () => config!.state.connections.get(config!.state.current!)?.connector.id;
  const connectedIds = () => [...config!.state.connections.values()].map((connection) => connection.connector.id);

  it("disconnects a wallet approved after the user went back and chose another", async () => {
    const first = announcedWallet("dev.pcash.first", "0x2222222222222222222222222222222222222222");
    const second = announcedWallet("dev.pcash.second", ACCOUNT);
    removeAnnouncement = () => { first.stop(); second.stop(); };
    second.approve();
    await openPicker();
    await click("dev.pcash.first");
    await clickButton("Back");
    await click("dev.pcash.second");
    await settle();
    first.approve();
    await settle();
    await settle();
    expect(currentId()).toBe("dev.pcash.second");
    expect(connectedIds()).toEqual(["dev.pcash.second"]);
    expect(await config!.storage?.getItem("recentConnectorId")).toBe("dev.pcash.second");
  });

  it("keeps the chosen wallet when it is approved while an abandoned wallet is being disconnected", async () => {
    const second = announcedWallet("dev.pcash.second", ACCOUNT);
    const first = announcedWallet("dev.pcash.first", "0x2222222222222222222222222222222222222222", async () => {
      second.approve();
      await vi.waitFor(() => expect(currentId()).toBe("dev.pcash.second"), { interval: 1 });
    });
    removeAnnouncement = () => { first.stop(); second.stop(); };
    await openPicker();
    await click("dev.pcash.first");
    await clickButton("Back");
    await click("dev.pcash.second");
    first.approve();
    await settle();
    await settle();
    expect(currentId()).toBe("dev.pcash.second");
    expect(connectedIds()).toEqual(["dev.pcash.second"]);
  });

  it("leaves a reopened picker open when the closed picker's wallet is approved", async () => {
    const wallet = announcedWallet("dev.pcash.first", ACCOUNT);
    removeAnnouncement = wallet.stop;
    await openPicker();
    await click("dev.pcash.first");
    await clickButton("×");
    await act(async () => container.querySelector("button")!.click());
    wallet.approve();
    await settle();
    expect(document.querySelector('dialog[aria-labelledby="connect-wallet-title"]')).not.toBeNull();
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
