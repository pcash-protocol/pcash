// Shared wallet-session validation keeps every action on one state boundary and
// one set of recipient and receipt rules.

import { pollReceipt } from "@pcash/sdk/clients";
import type { PcashNodeClient, StatusResult } from "@pcash/sdk/clients";
import { fixedHex } from "@pcash/sdk/utils";
import type { WalletStateStore } from "../store.ts";

/**
 * Compare two delivery targets. A bare recorded address is case-insensitive
 * hex; an extended receive code is exact base64url, where case is meaningful.
 */
export function sameRecipient(left: string, right: string): boolean {
  if (/^0x[0-9a-fA-F]{40}$/.test(left) && /^0x[0-9a-fA-F]{40}$/.test(right)) {
    return left.toLowerCase() === right.toLowerCase();
  }
  return left === right;
}

/**
 * True when this transaction has a canonical accepted receipt of the expected
 * kind. A receipt of a different kind means the id resolved to something this
 * action never submitted, which is an error rather than a negative answer.
 */
export async function acceptedReceiptOfKind(
  node: PcashNodeClient,
  contentHash: string,
  kind: string,
  label: string,
): Promise<boolean> {
  const receipt = await pollReceipt(node, contentHash);
  if (receipt === null || receipt.outcome !== "succeeded") return false;
  if (receipt.kind !== kind) {
    throw new Error(`${label} ${contentHash} resolved to the wrong receipt kind`);
  }
  return true;
}

/**
 * Prove the store an action was handed is the store that action means to use.
 *
 * `load`/`save` only prove a document matches the identity its store was built
 * with. They cannot catch a store built for the wrong wallet: a populated store
 * for owner A happily returns A's document while the action runs against wallet
 * B, and `save` accepts the result because the owner field is still A. B's
 * recovered notes, receive keys, and pending exact-byte journals would be folded
 * into A's document.
 *
 * Checking the store's declared binding instead of the loaded document also
 * fails an empty store, where there is no document to disagree with, and fails
 * before any reconciliation mutates state.
 */
export function assertWalletStoreMatches(
  store: WalletStateStore,
  /** The wallet this operation runs as. `undefined` only where no wallet drives
   *  it, such as an externally authorized user-account update. */
  wallet: { address: bigint } | undefined,
  chainId: bigint,
  status: StatusResult,
): void {
  const { address, network } = store.identity;
  if (wallet !== undefined && address !== wallet.address) {
    throw new Error("wallet store belongs to a different owner than this operation");
  }
  if (BigInt(network.chainId) !== chainId || BigInt(status.pcashChainId) !== chainId) {
    throw new Error("node, operation, and wallet-store PCASH chain ids must match");
  }
  if (network.genesisHash !== fixedHex(status.genesisHash, 32, "genesisHash")) {
    throw new Error("wallet store belongs to a different network genesis; use a new store and rescan");
  }
}
