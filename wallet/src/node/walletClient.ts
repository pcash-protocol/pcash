import {
  Wallet,
  OPEN_WALLET_INTERNAL,
  type WalletAuthorityOptions,
  type WalletClientOptions,
} from "@pcash/sdk/wallet";
import {
  acquireNodeWalletDatabase,
  openMemoryWalletDatabase,
} from "./walletDatabase.ts";
import type { WalletStorageCipher } from "@pcash/sdk/wallet/database";

export type NodeWalletOpenOptions<Prepared = unknown, Output = unknown> =
  WalletClientOptions<Prepared, Output>
  & WalletAuthorityOptions
  & { dataDir: string; storageCipher?: WalletStorageCipher };

export type MemoryNodeWalletOpenOptions<Prepared = unknown, Output = unknown> =
  WalletClientOptions<Prepared, Output>
  & WalletAuthorityOptions;

/** Open a wallet on the shared portable PGlite index for this directory. */
export async function openNodeWallet<Prepared = unknown, Output = unknown>(
  options: NodeWalletOpenOptions<Prepared, Output>,
): Promise<Wallet<Prepared, Output>> {
  const { dataDir, storageCipher, ...walletOptions } = options;
  const acquired = await acquireNodeWalletDatabase(dataDir, storageCipher === undefined ? {} : { cipher: storageCipher });
  return Wallet[OPEN_WALLET_INTERNAL]({
    ...walletOptions,
    database: acquired.database,
    releaseDatabase: acquired.release,
  });
}

/** Open one wallet over an owned process-local PGlite database. */
export async function openMemoryNodeWallet<Prepared = unknown, Output = unknown>(
  options: MemoryNodeWalletOpenOptions<Prepared, Output>,
): Promise<Wallet<Prepared, Output>> {
  const database = await openMemoryWalletDatabase();
  return Wallet[OPEN_WALLET_INTERNAL]({
    ...options,
    database,
    releaseDatabase: () => database.close(),
  });
}
