import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { defineChain } from "viem";
import { sepolia } from "viem/chains";
import { createConfig, WagmiContext } from "wagmi";
import { reconnect } from "wagmi/actions";
import { injected, metaMask, walletConnect } from "wagmi/connectors";
import { hydrate } from "@wagmi/core";
import { l1RpcTransport } from "@pcash/sdk/l1";
import { useNetwork } from "../components/NetworkContext.tsx";
import { ConnectWalletProvider } from "../components/ConnectWalletDialog.tsx";
import type { NetworkProfile } from "./networks.ts";

export function createEthereumNetwork(network: NetworkProfile) {
  const l1ChainId = network.l1ChainId;
  const l1Chain = l1ChainId === sepolia.id
    ? { ...sepolia, name: network.name, rpcUrls: { default: { http: network.l1RpcUrls } } }
    : defineChain({
        id: l1ChainId, name: network.name,
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
        rpcUrls: { default: { http: network.l1RpcUrls } },
      });
  const l1Transport = l1RpcTransport(network.l1RpcUrls);
  // Wallets describe the site by its origin only: a claim link's fragment is
  // its bearer secret.
  const browser = typeof window !== "undefined";
  const origin = browser ? window.location.origin : "";
  // Phone browsers have no extension wallets. MetaMask Connect opens the
  // MetaMask app; other wallet apps need WalletConnect and its project ID.
  // WalletConnect's own modal stays off: it is Reown's AppKit, which reports
  // the full page URL. Base Account and Safe are not offered: their accounts
  // are contracts, which cannot produce the ECDSA signature PCASH
  // authorizations require.
  const projectId = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID?.trim() || undefined;
  const ethereumConfig = createConfig({
    chains: [l1Chain],
    connectors: [
      // Rabby can hold window.ethereum, or sit in its providers list, without announcing itself.
      injected({ target: "rabby" }),
      // Headless: the wallet picker shows MetaMask's code itself, since
      // MetaMask's own modal would sit beneath the site's modal dialogs.
      metaMask({ dapp: { name: "PCASH", url: origin }, ui: { headless: true } }),
      // Its setup starts a relay client, which would keep prerendering from exiting.
      ...(projectId === undefined || !browser ? [] : [walletConnect({
        projectId,
        showQrModal: false,
        telemetryEnabled: false,
        metadata: { name: "PCASH", description: "PCASH", url: origin, icons: [] },
      })]),
    ],
    multiInjectedProviderDiscovery: true,
    ssr: true,
    transports: { [l1Chain.id]: l1Transport },
  });
  return { ethereumConfig, l1Chain, l1ChainId, l1Transport };
}

let reconnection = Promise.resolve();

const EthereumContext = createContext<ReturnType<typeof createEthereumNetwork> | null>(null);
export function useEthereumNetwork() { return useContext(EthereumContext)!; }

export function EthereumProvider({ children }: { children: ReactNode }) {
  const { network } = useNetwork();
  const [ethereum] = useState(() => createEthereumNetwork(network));
  const [queryClient] = useState(() => new QueryClient());
  useEffect(() => {
    let active = true;
    const config = ethereum.ethereumConfig;
    // Wagmi skips a reconnect requested while another runs, so StrictMode's
    // effect replay waits for the first attempt instead of racing it.
    reconnection = reconnection.then(async () => {
      if (!active) return;
      // Finish persisted-connection hydration before attaching the extension.
      await hydrate(config, { reconnectOnMount: false }).onMount();
      if (!active) return;
      // Browser wallets answer from the page. MetaMask Connect and
      // WalletConnect are asked only when used last: asking them starts their SDKs.
      const recent = await config.storage?.getItem("recentConnectorId");
      await reconnect(config, { connectors: config.connectors.filter((connector) => connector.type === "injected" || connector.id === recent) });
    }).catch(() => undefined);
    return () => { active = false; };
  }, [ethereum]);
  return <EthereumContext.Provider value={ethereum}><WagmiContext.Provider value={ethereum.ethereumConfig}>
    <QueryClientProvider client={queryClient}>
      <ConnectWalletProvider>{children}</ConnectWalletProvider>
    </QueryClientProvider>
  </WagmiContext.Provider></EthereumContext.Provider>;
}
