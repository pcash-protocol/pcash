import type { AccountResult } from "@pcash/sdk/clients";
import { addressHex, fromHex } from "@pcash/sdk/utils";
import type { WalletFileData } from "../noteStore.ts";
import { receiveKeyHashHex, receiveKeyPairForHash } from "../receiveKeyring.ts";
import type { WalletStateStore } from "../store.ts";
import { WalletSyncRequiredError } from "../chainState.ts";
import { localAccount } from "./localChain.ts";

/** A caller-supplied self destination must be decryptable by this wallet. */
export function assertReceiveKeyOwned(data: WalletFileData | null, key: Uint8Array): void {
  if (data === null || receiveKeyPairForHash(data, receiveKeyHashHex({ publicKey: key })) === null) {
    throw new Error("wallet does not own the receive key for this output; restore its receive-key keyring before sending");
  }
}

/** Use the registered key from the action's authenticated account snapshot. */
export function registeredSelfReceiveKey(account: AccountResult | null, data: WalletFileData | null): Uint8Array {
  if (account === null || BigInt(account.receiveKeyHash) === 0n) {
    throw new Error("wallet has no registered receive key for encrypted self delivery");
  }
  if (account.material.status !== "available") {
    throw new Error("wallet's registered receive key is unavailable; sync before sending");
  }
  if (data === null || receiveKeyPairForHash(data, account.receiveKeyHash) === null) {
    throw new Error("wallet does not own the registered receive key; restore its receive-key keyring before sending");
  }
  return fromHex(account.material.mlKem768PublicKey);
}

/** Resolve automatic self delivery from the wallet's synced account directory. */
export async function loadSelfReceiveKey(store: WalletStateStore, address: bigint): Promise<Uint8Array> {
  const [account, data] = await Promise.all([localAccount(store, addressHex(address)), store.load()]);
  return registeredSelfReceiveKey(account, data);
}

/**
 * This wallet's account in the local directory at a separately fetched
 * transaction witness's account root; null when it has none there. Reading
 * the local directory keeps the claimant's address out of node queries.
 */
export async function loadSelfAccountAtSnapshot(
  store: WalletStateStore,
  address: bigint,
  accountStateRoot: bigint,
  synchronize: () => Promise<unknown>,
): Promise<AccountResult | null> {
  const readAccount = () => store.readChain(chain => {
    if (chain === null || chain.requireAnchor().state.accountStateRoot !== accountStateRoot) return undefined;
    return chain.accountResult(addressHex(address));
  });
  let account = await readAccount();
  if (account === undefined) {
    await synchronize();
    account = await readAccount();
  }
  if (account === undefined) {
    throw new WalletSyncRequiredError("wallet account state differs from the transaction snapshot; retry this action");
  }
  return account;
}

/** Bind the local key directory to a separately fetched transaction witness. */
export async function loadSelfReceiveKeyAtSnapshot(
  store: WalletStateStore,
  address: bigint,
  accountStateRoot: bigint,
  synchronize: () => Promise<unknown>,
): Promise<Uint8Array> {
  const account = await loadSelfAccountAtSnapshot(store, address, accountStateRoot, synchronize);
  return registeredSelfReceiveKey(account, await store.load());
}
