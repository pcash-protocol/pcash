import { keyedSerialQueue } from "@pcash/sdk/utils";

export interface MarketplaceOperationLock {
  run<T>(key: string, operation: () => Promise<T>): Promise<T>;
}

/** Serializes headless callers in one process; browser hosts inject a cross-context lock. */
export class InMemoryMarketplaceOperationLock implements MarketplaceOperationLock {
  private readonly queue = keyedSerialQueue();

  run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    return this.queue(key, operation);
  }
}

export function marketplaceBuyerOperationKey(
  chainId: bigint | number,
  offer: string,
  buyerAddress: string,
): string {
  return `buy:${chainId}:${offer}:${buyerAddress.toLowerCase()}`;
}

export function marketplaceSellerPublicationOperationKey(
  chainId: bigint | number,
  offer: string,
  sellerAddress: bigint,
): string {
  return `publish:${chainId}:${offer}:${sellerAddress.toString(16)}`;
}

export function marketplaceSellerReclaimOperationKey(
  chainId: bigint | number,
  offer: string,
  sellerAddress: bigint,
): string {
  return `reclaim:${chainId}:${offer}:${sellerAddress.toString(16)}`;
}
