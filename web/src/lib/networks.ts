import { PCASH_CHAIN_ID } from "@pcash/sdk/constants";
import { parseL1ChainId } from "./l1Chain.ts";

/** The PCASH deployment this build serves and the Ethereum network that carries it. */
export interface NetworkProfile {
  name: string;
  pcashChainId: number;
  genesisHash?: string;
  pcashRpcUrl: string;
  l1ChainId: number;
  /** In order of preference: a read falls back to the next endpoint. */
  l1RpcUrls: readonly string[];
  pscanUrl?: string;
  paymentRouterAddress?: string;
}

export type NetworkEnvironment = Record<string, string | undefined>;

const knownL1Names: Record<number, string> = {
  1: "Ethereum",
  560048: "Hoodi",
  11155111: "Sepolia",
  31337: "Anvil",
};

/** A public HTTP(S) endpoint; `relative` also admits a same-origin path. */
export function parseEndpoint(value: string, label: string, relative = false): string {
  if (relative && value.startsWith("/") && !value.startsWith("//")) return value;
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`${label} must be an HTTP(S) URL`); }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new Error(`${label} must be a public HTTP(S) endpoint`);
  return value;
}

/** Comma-separated public HTTP(S) endpoints. */
function parseEndpoints(value: string, label: string): string[] {
  const endpoints = value.split(",").map((endpoint) => endpoint.trim()).filter((endpoint) => endpoint !== "");
  if (endpoints.length === 0) throw new Error(`${label} must name at least one endpoint`);
  return endpoints.map((endpoint) => parseEndpoint(endpoint, label));
}

/** Operator configuration becomes public browser configuration. */
export function configuredNetwork(env: NetworkEnvironment): NetworkProfile {
  const l1ChainId = parseL1ChainId(env.VITE_L1_CHAIN_ID);
  const pcashChainId = Number(env.VITE_PCASH_CHAIN_ID || PCASH_CHAIN_ID.toString());
  if (!Number.isInteger(pcashChainId) || pcashChainId < 0 || pcashChainId > 0xffff_ffff) throw new Error("PCASH chain ID must be a uint32");
  const genesisHash = env.VITE_PCASH_GENESIS_HASH?.trim() || undefined;
  if (genesisHash !== undefined && !/^0x[0-9a-f]{64}$/i.test(genesisHash)) throw new Error("PCASH genesis hash is invalid");
  const pscanUrl = env.VITE_PCASH_PSCAN_URL?.trim() || undefined;
  const paymentRouterAddress = env.VITE_PAYMENT_ROUTER_ADDRESS?.trim() || undefined;
  return {
    name: knownL1Names[l1ChainId] ?? `Chain ${l1ChainId}`,
    pcashChainId,
    pcashRpcUrl: parseEndpoint(env.VITE_PCASH_RPC_URL || "http://127.0.0.1:8645", "PCASH RPC URL", true),
    l1ChainId,
    l1RpcUrls: parseEndpoints(env.VITE_L1_RPC_URLS || "http://127.0.0.1:8545", "Ethereum RPC URL"),
    ...(genesisHash === undefined ? {} : { genesisHash }),
    ...(pscanUrl === undefined ? {} : { pscanUrl: parseEndpoint(pscanUrl, "Pscan URL", true) }),
    ...(paymentRouterAddress === undefined ? {} : { paymentRouterAddress }),
  };
}

export function browserNetwork(): NetworkProfile {
  return configuredNetwork({
    VITE_PCASH_CHAIN_ID: import.meta.env.VITE_PCASH_CHAIN_ID,
    VITE_PCASH_GENESIS_HASH: import.meta.env.VITE_PCASH_GENESIS_HASH,
    VITE_PCASH_RPC_URL: import.meta.env.VITE_PCASH_RPC_URL,
    VITE_PCASH_PSCAN_URL: import.meta.env.VITE_PCASH_PSCAN_URL,
    VITE_L1_CHAIN_ID: import.meta.env.VITE_L1_CHAIN_ID,
    VITE_L1_RPC_URLS: import.meta.env.VITE_L1_RPC_URLS,
    VITE_PAYMENT_ROUTER_ADDRESS: import.meta.env.VITE_PAYMENT_ROUTER_ADDRESS,
  });
}

/**
 * Scopes browser caches to one chain instance, so a reset local chain never
 * reads a previous chain's records. RPC endpoints are not part of it: a custom
 * endpoint serves the same chain.
 */
export function networkInstanceKey(network: NetworkProfile): string {
  return `${network.l1ChainId}:${network.pcashChainId}:${network.genesisHash?.toLowerCase() ?? ""}`;
}
