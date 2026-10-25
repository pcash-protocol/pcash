import type { Address } from "viem";

export interface MarketplaceRouterConfiguration {
  address: Address;
}

export interface MarketplaceRouterEnvironment {
  VITE_PAYMENT_ROUTER_ADDRESS?: string | undefined;
}

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

export function resolveMarketplaceRouterConfiguration(
  environment: MarketplaceRouterEnvironment,
): { configuration?: MarketplaceRouterConfiguration; error?: string } {
  const address = environment.VITE_PAYMENT_ROUTER_ADDRESS?.trim();
  if (address === undefined || address === "") {
    return { error: "Marketplace payments are read-only until the router address is configured." };
  }
  if (!ADDRESS_PATTERN.test(address)) {
    return { error: "Marketplace router configuration is invalid, so value-moving actions are disabled." };
  }
  return {
    configuration: {
      address: address.toLowerCase() as Address,
    },
  };
}
