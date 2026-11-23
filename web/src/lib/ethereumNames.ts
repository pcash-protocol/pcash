import { createEthereumNameResolver } from "@pcash/sdk/names";
import { createPublicClient, http } from "viem";
import { mainnet } from "viem/chains";
import type { MainnetNames } from "../names/NameResolutionSession.ts";

// Naming is always mainnet, independently of the selected PCASH deployment, and so is a recipient's history while names are on.
export const createEthereumNames = (signal: AbortSignal): MainnetNames => {
  const client = createPublicClient({
    chain: mainnet,
    transport: http(import.meta.env.VITE_ENS_RPC_URL?.trim() || "https://ethereum-rpc.publicnode.com", { timeout: 5_000, retryCount: 0, fetchOptions: { signal } }),
    batch: { multicall: true },
  });
  return {
    ...createEthereumNameResolver({ client }),
    readAddress: async (address) => {
      const [code, nonce] = await Promise.all([client.getCode({ address }), client.getTransactionCount({ address })]);
      return { code, nonce };
    },
  };
};
