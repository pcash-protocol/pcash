// Host contract for a wallet database. The engine binds a store through
// WALLET_DATABASE_STATE_STORE; applications and database hosts import this
// subpath rather than the high-level wallet entry.
import { numberToHex } from "viem";
import { walletNetworkIdentity, type WalletStoreIdentity } from "./store.ts";

export {
  WALLET_DATABASE_STATE_STORE,
  type WalletDatabase,
  walletStore,
  type WalletStateStore,
  type WalletStoreBackend,
  type WalletStoreBackendCommit,
  type WalletStoreBackendRecord,
  type WalletStoreIdentity,
} from "./store.ts";
export type { ChainCommit } from "./chainState.ts";
export type { WalletStorageCipher } from "./storageCipher.ts";

/** Stable database key for one account on one exact network genesis. */
export function walletDatabaseKey(identity: WalletStoreIdentity): string {
  const network = walletNetworkIdentity(identity.network);
  return `${network.chainId}.${network.genesisHash}.${numberToHex(identity.address)}`;
}
