import {
  Wallet,
  OPEN_WALLET_INTERNAL,
  type WalletAuthorityOptions,
  type WalletClientOptions,
} from "../actions/walletClient.ts";
import {
  acquireBrowserWalletDatabase,
  type BrowserWalletDatabaseOptions,
} from "./browserDatabase.ts";
import type { StatusResult } from "@pcash/sdk/clients";

export function browserWalletDatabaseName(prefix: string, network: Pick<StatusResult, "pcashChainId" | "l1ChainId" | "genesisHash">): string {
  return `${prefix}-${network.pcashChainId}-${network.l1ChainId}-${network.genesisHash.toLowerCase()}`;
}

export type BrowserWalletOpenOptions<Prepared = unknown, Output = unknown> =
  WalletClientOptions<Prepared, Output>
  & WalletAuthorityOptions
  & BrowserWalletDatabaseOptions;

/** Open a wallet on the shared native IndexedDB database for this origin/name. */
export async function openBrowserWallet<Prepared = unknown, Output = unknown>(
  options: BrowserWalletOpenOptions<Prepared, Output>,
): Promise<Wallet<Prepared, Output>> {
  const { name, ...walletOptions } = options;
  const acquired = await acquireBrowserWalletDatabase({ name });
  return Wallet[OPEN_WALLET_INTERNAL]({
    ...walletOptions,
    database: acquired.database,
    releaseDatabase: acquired.release,
  });
}
