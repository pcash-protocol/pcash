import { useState, type ReactNode } from "react";
import { browserNetwork, parseEndpoint, type NetworkProfile } from "./networks.ts";
import { l1RpcList, savedRpcEndpoints, type RpcEndpoints } from "./WebsiteSettings.tsx";
import { NetworkContext } from "../components/NetworkContext.tsx";

/**
 * The build's network, with any RPC endpoints this browser chose in settings.
 * Ethereum is read from the endpoints that are on in the browser's list, in the
 * order listed; a list with none on reads from the deployment's.
 */
export function withRpcEndpoints(network: NetworkProfile, endpoints: RpcEndpoints): NetworkProfile {
  const valid = (value: string | undefined, label: string) => {
    if (value === undefined) return undefined;
    try { return parseEndpoint(value, label); } catch { return undefined; }
  };
  const l1RpcUrls = l1RpcList(network.l1RpcUrls, endpoints.l1Rpcs).flatMap((rpc) => (rpc.enabled ? valid(rpc.url, "Ethereum RPC URL") : undefined) ?? []);
  return {
    ...network,
    pcashRpcUrl: valid(endpoints.pcashRpcUrl, "PCASH RPC URL") ?? network.pcashRpcUrl,
    l1RpcUrls: l1RpcUrls.length === 0 ? network.l1RpcUrls : l1RpcUrls,
  };
}

export function NetworkProvider({ children, network: supplied }: { children: ReactNode; network?: NetworkProfile }) {
  const [network] = useState(() => supplied ?? withRpcEndpoints(browserNetwork(), savedRpcEndpoints()));
  return <NetworkContext.Provider value={{ network }}>{children}</NetworkContext.Provider>;
}
