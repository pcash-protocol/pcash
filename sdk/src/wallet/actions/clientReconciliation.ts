// Canonical pending-action reconciliation shared by every wallet adapter.
//
// Reconciliation reads only the wallet's local chain state: which watched
// nullifiers the synced chain consumed, in which transaction, and the synced
// account set. It never asks the node about this wallet's nullifiers or
// accounts. Spent flags on notes are owned by synchronization, which derives
// them from the same consumption records.

import type { StatusResult } from "@pcash/sdk/clients";
import type { NullifierConsumption, WalletChainState } from "../chainState.ts";
import {
  removeMempoolOutboxEntry,
  removePendingAssetAction,
  removePendingNoteFundedTransfer,
  removePendingUserAccountUpdate,
  removePendingNotesForTransaction,
  unsentSetupMining,
  type StoredPaymentHistory,
  type PendingAssetAction,
  type PendingNoteFundedTransfer,
  type WalletFileData,
} from "../noteStore.ts";

function retainPaymentHistory(
  data: WalletFileData,
  transfer: PendingNoteFundedTransfer,
  state: StoredPaymentHistory["state"],
  consumption?: NullifierConsumption,
): void {
  const history = data.paymentHistory ?? (data.paymentHistory = []);
  history.push({
    kind: transfer.kind,
    contentHash: transfer.contentHash.toLowerCase(),
    recipient: transfer.recipient,
    recipientAddress: transfer.recipientAddress,
    ...(transfer.data === undefined ? {} : { data: transfer.data }),
    transferAmount: transfer.transferAmount,
    openFeeAmount: transfer.openFeeAmount,
    privateRelayFeeAmount: transfer.privateRelayFeeAmount,
    privateRelayRecipient: transfer.privateRelayRecipient,
    validUntilTimestamp: transfer.validUntilTimestamp,
    resolvedAtUnixMs: Date.now().toString(),
    state,
    ...(consumption === undefined ? {} : { receipt: {
      transactionId: consumption.transactionId.toLowerCase(),
      pcashBlockNumber: consumption.pcashNumber.toString(),
      pcashBlockHash: consumption.pcashHash.toLowerCase(),
    } }),
  });
}

/** Remove the expected change note when a prepared transfer can no longer land. */
export function removePendingChangeNote(
  data: WalletFileData,
  transfer: PendingNoteFundedTransfer,
): void {
  if (transfer.change === null) return;
  removePendingNotesForTransaction(data, transfer.contentHash);
}

/** Remove locally opened outputs when a pending asset action can no longer land. */
function removePendingAssetOutputs(data: WalletFileData, action: PendingAssetAction): void {
  removePendingNotesForTransaction(data, action.contentHash);
}

type Resolution =
  | { state: "pending" }
  | { state: "expired" }
  | { state: "settled"; ours: NullifierConsumption | undefined; first: NullifierConsumption };

/**
 * Resolve one journaled nullifier tuple against the synced chain. Bookkeeping
 * follows finality: a consuming transaction settles the action once its block
 * is finalized, and a missed deadline releases it once finalized time has
 * passed it. Head is not proof either way, since a reorg can drop an
 * inclusion or restore a fork that included the transaction before its
 * deadline; until finality the inputs stay reserved and the bytes stay
 * retryable.
 */
function resolveTuple(
  chain: WalletChainState | null,
  status: StatusResult,
  contentHash: string,
  nullifiers: readonly string[],
  validUntilTimestamp: string,
): Resolution {
  const consumed = (chain?.consumption(nullifiers) ?? []).filter(
    (consumption): consumption is NullifierConsumption => consumption !== null,
  );
  if (consumed.length === 0) {
    // Expiry needs every finalized block synced, or an unseen inclusion could still be there.
    const expired = chain !== null
      && chain.synced.pcashNumber >= status.finalizedBlock
      && status.finalizedBlockTimestamp > BigInt(validUntilTimestamp);
    return expired ? { state: "expired" } : { state: "pending" };
  }
  if (consumed.some((consumption) => consumption.pcashNumber > status.finalizedBlock)) return { state: "pending" };
  const ours = consumed.find((consumption) => consumption.contentHash.toLowerCase() === contentHash.toLowerCase());
  return { state: "settled", ours, first: consumed[0]! };
}

/** Reconcile note-funded reservations from their exact nullifier tuple. */
export function reconcilePendingNoteFundedTransfers(
  data: WalletFileData,
  chain: WalletChainState | null,
  status: StatusResult,
): boolean {
  let changed = false;
  for (const transfer of [...(data.pendingNoteFundedTransfers ?? [])]) {
    const resolution = resolveTuple(
      chain,
      status,
      transfer.contentHash,
      transfer.inputs.map((input) => input.nullifier),
      transfer.validUntilTimestamp,
    );
    if (resolution.state === "pending") continue;
    removePendingChangeNote(data, transfer);
    if (resolution.state === "expired") {
      // Setup mining no Ethereum transaction carried leaves no history, like its abandoned setup.
      if (!unsentSetupMining(data, transfer)) retainPaymentHistory(data, transfer, "expired");
    } else {
      retainPaymentHistory(
        data,
        transfer,
        resolution.ours === undefined ? "conflicted" : "succeeded",
        resolution.ours ?? resolution.first,
      );
    }
    removePendingNoteFundedTransfer(data, transfer.contentHash);
    removeMempoolOutboxEntry(data, transfer.contentHash);
    changed = true;
  }
  return changed;
}

/** Reconcile generic asset-action reservations from their exact nullifier tuple. */
function reconcilePendingAssetActions(
  data: WalletFileData,
  chain: WalletChainState | null,
  status: StatusResult,
): boolean {
  let changed = false;
  for (const action of [...(data.pendingAssetActions ?? [])]) {
    const resolution = resolveTuple(
      chain,
      status,
      action.contentHash,
      action.inputs.map((input) => input.nullifier),
      action.validUntilTimestamp,
    );
    if (resolution.state === "pending") continue;
    removePendingAssetOutputs(data, action);
    removePendingAssetAction(data, action.contentHash);
    removeMempoolOutboxEntry(data, action.contentHash);
    changed = true;
  }
  return changed;
}

/**
 * Account updates follow finality like nullifier tuples. The revision is the
 * conflict key: an advance past the journaled revision, by these bytes or a
 * competing update for the same revision, retires the update once the
 * account's latest write is finalized, and a missed deadline releases it once
 * finalized time has passed it. Until then a reorg can drop the inclusion, and
 * a self-published update's journal is the only copy of its bytes.
 */
export function reconcilePendingUserAccountUpdates(
  data: WalletFileData,
  chain: WalletChainState | null,
  status: StatusResult,
): boolean {
  let changed = false;
  // Expiry needs every finalized block synced, or an unseen inclusion could still be there.
  const finalizedSynced = chain !== null && chain.synced.pcashNumber >= status.finalizedBlock;
  for (const pending of [...(data.pendingUserAccountUpdates ?? [])]) {
    const account = chain?.account(pending.address) ?? null;
    const advanced = account !== null
      && account.accountRevision > BigInt(pending.currentAccountRevision)
      && account.pcashNumber <= status.finalizedBlock;
    const expired = finalizedSynced && status.finalizedBlockTimestamp > BigInt(pending.validUntilTimestamp);
    if (!advanced && !expired) continue;
    // Fee inputs a landed update spent are marked by synchronization from
    // their consumed nullifiers.
    removePendingNotesForTransaction(data, pending.contentHash);
    removePendingUserAccountUpdate(data, pending.address);
    removeMempoolOutboxEntry(data, pending.contentHash);
    changed = true;
  }
  return changed;
}

export function reconcilePendingWalletActions(
  data: WalletFileData,
  chain: WalletChainState | null,
  status: StatusResult,
): boolean {
  const notesChanged = reconcilePendingNoteFundedTransfers(data, chain, status);
  const assetsChanged = reconcilePendingAssetActions(data, chain, status);
  const accountChanged = reconcilePendingUserAccountUpdates(data, chain, status);
  return notesChanged || assetsChanged || accountChanged;
}
