import { RainbowKitProvider, connectorsForWallets, type DisclaimerComponent } from "@rainbow-me/rainbowkit";
import { rabbyWallet } from "@rainbow-me/rainbowkit/wallets";
import "@rainbow-me/rainbowkit/styles.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { defineChain } from "viem";
import { sepolia } from "viem/chains";
import { createConfig, WagmiContext } from "wagmi";
import { reconnect } from "wagmi/actions";
import { hydrate } from "@wagmi/core";
import { l1RpcTransport } from "@pcash/sdk/l1";
import { useNetwork } from "../components/NetworkContext.tsx";
import { connectTheme } from "./connectTheme.ts";
import type { NetworkProfile } from "./networks.ts";
import { routeById } from "../routes/routeManifest.ts";

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
  const ethereumConfig = createConfig({
    chains: [l1Chain],
    connectors: connectorsForWallets(
      [{ groupName: "Wallets", wallets: [rabbyWallet] }],
      { appName: "PCASH", projectId: "" },
    ),
    multiInjectedProviderDiscovery: true,
    ssr: true,
    transports: { [l1Chain.id]: l1Transport },
  });
  return { ethereumConfig, l1Chain, l1ChainId, l1Transport };
}

let reconnection = Promise.resolve();

const EthereumContext = createContext<ReturnType<typeof createEthereumNetwork> | null>(null);
export function useEthereumNetwork() { return useContext(EthereumContext)!; }

/** Shown under the wallet list in the connect modal, which every connect button opens. */
const TermsNotice: DisclaimerComponent = ({ Text, Link }) =>
  <Text>By connecting a wallet, you agree to the <Link href={routeById("terms").path}>Terms of Service</Link>.</Text>;

// RainbowKit supplies the connect modal, wallet discovery, and chain switching.
// Announced wallets remain discoverable alongside the explicit Rabby connector.
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
      if (active) await reconnect(config);
    }).catch(() => undefined);
    return () => { active = false; };
  }, [ethereum]);
  return <EthereumContext.Provider value={ethereum}><WagmiContext.Provider value={ethereum.ethereumConfig}>
    <QueryClientProvider client={queryClient}>
      <RainbowKitProvider theme={connectTheme} modalSize="compact" appInfo={{ appName: "PCASH", disclaimer: TermsNotice }} initialChain={ethereum.l1Chain}>
        {children}
      </RainbowKitProvider>
    </QueryClientProvider>
  </WagmiContext.Provider></EthereumContext.Provider>;
}
