import type { NetworkProfile } from "../../lib/networks.ts";
import type { StatusResult } from "@pcash/sdk/clients";
import { FIXTURE_CHAIN_ID } from "./fixtures/constants.ts";

/**
 * Shown when the node serves another network than this build expects. A
 * visitor can only wait for the site to be redeployed; a local build restarts.
 */
export function networkChangedMessage(development = import.meta.env.DEV): string {
  return development
    ? "This network has changed. Restart just web and reload the page to use its new state."
    : "The PCASH node is running a different network than this site expects. Try again later.";
}

export const DEVELOPMENT_EXPLORER_RPC_URL = "http://127.0.0.1:8645";
export const DEVELOPMENT_PSCAN_URL = "http://127.0.0.1:8648";

export interface ExplorerEnvironment {
  /** "fixtures" renders the explorer from generated data with no node. */
  VITE_PCASH_MODE?: string | undefined;
  VITE_PCASH_RPC_URL?: string | undefined;
  VITE_PCASH_PSCAN_URL?: string | undefined;
  VITE_PCASH_CHAIN_ID?: string | undefined;
}

export interface ExplorerConfig {
  rpcUrl: string;
  rpcDisplayUrl: string;
  /** Dedicated `pscan_*` listener; absent means the source service is off. */
  pscanUrl?: string | undefined;
  pscanDisplayUrl?: string | undefined;
  pcashChainId: number;
  genesisHash?: string;
  l1ChainId?: number;
}

export type ExplorerConfigResult =
  | { status: "valid"; config: ExplorerConfig }
  | { status: "fixtures"; config: ExplorerConfig }
  | { status: "invalid"; message: string };

export const FIXTURE_EXPLORER_CONFIG: ExplorerConfig = {
  rpcUrl: "fixtures:",
  rpcDisplayUrl: "Fixture data",
  pscanUrl: "fixtures:",
  pscanDisplayUrl: "Fixture data",
  pcashChainId: FIXTURE_CHAIN_ID,
};

function parseChainId(value: string): number {
  let parsed: bigint;
  try {
    parsed = BigInt(value);
  } catch {
    throw new Error("PCASH_CHAIN_ID must be a decimal or 0x-prefixed integer");
  }
  if (parsed < 0n || parsed > 0xffff_ffffn) throw new Error("PCASH_CHAIN_ID must fit uint32");
  return Number(parsed);
}

/** The source-service endpoint shares URL validation but carries its own config keys. */
function parsePscanUrl(value: string): Pick<ExplorerConfig, "pscanUrl" | "pscanDisplayUrl"> {
  const parsed = parseRpcUrl(value, "PCASH_PSCAN_URL");
  return { pscanUrl: parsed.rpcUrl, pscanDisplayUrl: parsed.rpcDisplayUrl };
}

function parseRpcUrl(value: string, envName = "PCASH_RPC_URL"): Pick<ExplorerConfig, "rpcUrl" | "rpcDisplayUrl"> {
  if (value.startsWith("/") && !value.startsWith("//")) return { rpcUrl: value, rpcDisplayUrl: "Same-origin RPC" };
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${envName} must be an absolute HTTP(S) URL or a same-origin path`);
  }
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error(`${envName} must use HTTP or HTTPS`);
  if (parsed.username !== "" || parsed.password !== "") throw new Error(`${envName} must not contain user information`);
  return { rpcUrl: value, rpcDisplayUrl: `${parsed.protocol}//${parsed.host}` };
}

export function resolveExplorerConfig(env: ExplorerEnvironment, production: boolean): ExplorerConfigResult {
  if (env.VITE_PCASH_MODE?.trim() === "fixtures") return { status: "fixtures", config: FIXTURE_EXPLORER_CONFIG };
  const configuredRpc = env.VITE_PCASH_RPC_URL?.trim();
  const chainId = env.VITE_PCASH_CHAIN_ID?.trim();
  if (production && configuredRpc === undefined) {
    return { status: "invalid", message: "Explorer production builds require PCASH_RPC_URL." };
  }
  // Every selected deployment pins its PCASH chain, including in development.
  if (chainId === undefined || chainId === "") {
    return { status: "invalid", message: "Explorer requires PCASH_CHAIN_ID." };
  }
  try {
    const rpc = parseRpcUrl(configuredRpc ?? DEVELOPMENT_EXPLORER_RPC_URL);
    // The source service is optional everywhere: in production its absence
    // simply renders source routes as unavailable, never an error.
    const configuredPscan = env.VITE_PCASH_PSCAN_URL?.trim() ?? (production ? undefined : DEVELOPMENT_PSCAN_URL);
    const pscanFields = configuredPscan === undefined ? {} : parsePscanUrl(configuredPscan);
    return {
      status: "valid",
      config: { ...rpc, ...pscanFields, pcashChainId: parseChainId(chainId) },
    };
  } catch (cause) {
    return { status: "invalid", message: cause instanceof Error ? cause.message : String(cause) };
  }
}

export function resolveNetworkExplorerConfig(network: NetworkProfile): ExplorerConfigResult {
  const result = resolveExplorerConfig({
    VITE_PCASH_MODE: import.meta.env.VITE_PCASH_MODE,
    VITE_PCASH_RPC_URL: network.pcashRpcUrl,
    VITE_PCASH_PSCAN_URL: network.pscanUrl,
    VITE_PCASH_CHAIN_ID: String(network.pcashChainId),
  }, true);
  if (result.status === "valid") {
    result.config.l1ChainId = network.l1ChainId;
    if (network.genesisHash !== undefined) result.config.genesisHash = network.genesisHash;
  }
  return result;
}

export function explorerIdentityMismatch(config: ExplorerConfig, status: StatusResult): string | undefined {
  if ((config.genesisHash !== undefined && status.genesisHash.toLowerCase() !== config.genesisHash.toLowerCase())
    || (config.l1ChainId !== undefined && status.l1ChainId !== BigInt(config.l1ChainId))) return networkChangedMessage();
  if (status.pcashChainId !== config.pcashChainId) {
    return `Expected PCASH chain ${config.pcashChainId}, but the configured node reported ${status.pcashChainId}.`;
  }
  return undefined;
}
