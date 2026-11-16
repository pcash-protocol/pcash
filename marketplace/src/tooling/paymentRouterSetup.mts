import { join, resolve } from "node:path";
import { createPublicClient, http, type Hex, type TransactionSerialized } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { pcashL1Chain } from "@pcash/sdk/l1";
import { normalizePaymentRouterConfig, PAYMENT_ROUTER_DEFAULT_FEE_BPS, type PaymentRouterConfigInput } from "../client/paymentRouter.ts";
import { deployPaymentRouter, resolvePaymentRouter, type PaymentRouterReady } from "./paymentRouterDeployment.mts";

export const LOCAL_PAYMENT_ROUTER_CONFIG = {
  feeRecipient: "0x0000000000000000000000000000000000000fee",
  feeBps: PAYMENT_ROUTER_DEFAULT_FEE_BPS,
} as const;

// Public, funded account 0 from Anvil's default mnemonic. Only local dev callers use it.
export const LOCAL_PAYMENT_ROUTER_KEY: Hex = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

export function localPaymentRouterCacheRoot(repoRoot: string, devRoot?: string): string {
  return join(resolve(repoRoot, devRoot?.trim() || ".cache/pcash/dev/anvil"), "marketplace");
}

type DeploymentFees = { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };

export interface SetupPaymentRouterOptions {
  rpcUrl: string;
  l1ChainId: bigint;
  cacheRoot: string;
  routerConfig?: PaymentRouterConfigInput;
  explicitAddress?: string | undefined;
  /** Omit to require an existing deployment. */
  privateKey?: Hex | undefined;
  fees?: DeploymentFees | (() => Promise<DeploymentFees>);
}

/** Shared deployment adapter for development commands and isolated scenarios. */
export async function setupPaymentRouter(options: SetupPaymentRouterOptions): Promise<PaymentRouterReady> {
  const chain = pcashL1Chain(options.l1ChainId, options.rpcUrl);
  const client = createPublicClient({ chain, transport: http(options.rpcUrl) });
  const genesis = await client.getBlock({ blockNumber: 0n });
  const routerConfig = options.routerConfig === undefined ? undefined : normalizePaymentRouterConfig(options.routerConfig);
  const resolutionOptions = {
    client,
    cachePath: join(options.cacheRoot, genesis.hash, "payment-router.json"),
    expectedL1ChainId: chain.id,
    routerConfig,
    explicitAddress: options.explicitAddress,
  };
  const resolution = await resolvePaymentRouter(resolutionOptions);
  if (resolution.kind === "ready") return resolution;
  if (options.privateKey === undefined) {
    throw new Error(`PaymentRouter deployment required: ${resolution.reason}; configure PCASH_PAYMENT_ROUTER_ADDRESS`);
  }
  if (routerConfig === undefined) throw new Error("PaymentRouter fee configuration is required for automatic deployment");
  const account = privateKeyToAccount(options.privateKey);
  const fees = typeof options.fees === "function"
    ? await options.fees()
    : options.fees ?? await client.estimateFeesPerGas({ type: "eip1559" });
  return deployPaymentRouter({
    ...resolutionOptions,
    routerConfig,
    deployer: account.address,
    ...fees,
    sign: ({ bytecode, gas, maxFeePerGas, maxPriorityFeePerGas, nonce }) => account.signTransaction({
      type: "eip1559",
      chainId: chain.id,
      data: bytecode,
      gas,
      maxFeePerGas,
      maxPriorityFeePerGas,
      nonce,
    }) as Promise<TransactionSerialized>,
    broadcast: (serializedTransaction) => client.sendRawTransaction({ serializedTransaction }),
  });
}
