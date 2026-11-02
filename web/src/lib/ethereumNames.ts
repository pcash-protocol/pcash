import { createEthereumNameResolver } from "@pcash/sdk/names";
import { createPublicClient, http } from "viem";
import { mainnet } from "viem/chains";

// Naming is always mainnet, independently of the selected PCASH deployment.
export const createEthereumNames = (signal: AbortSignal) => createEthereumNameResolver({ client: createPublicClient({
  chain: mainnet,
  transport: http(import.meta.env.VITE_ENS_RPC_URL?.trim() || "https://ethereum-rpc.publicnode.com", { timeout: 5_000, retryCount: 0, fetchOptions: { signal } }),
  batch: { multicall: true },
}) });
