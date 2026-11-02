// Canonical pending-action reconciliation shared by every wallet adapter.
//
// Reconciliation reads only the wallet's local chain state: which watched
// nullifiers the synced chain consumed, in which transaction, and the synced
// account set. It never asks the node about this wallet's nullifiers or
// accounts. Spent flags on notes are owned by synchronization, which derives
// them from the same consumption records.

import type { StatusResult } from "@pcash/sdk/clients";
import { sameHex } from "@pcash/sdk/utils";
import type { NullifierConsumption, WalletChainState } from "../chainState.ts";
import {
  livePendingNoteFundedTransfers,
  paymentAuthorizations,
  paymentOfTransfer,
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
  authorizations: readonly string[],
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
    nativeBurnAmount: transfer.nativeBurnAmount,
    privateRelayFeeAmount: transfer.privateRelayFeeAmount,
    privateRelayRecipient: transfer.privateRelayRecipient,
    validUntilTimestamp: transfer.validUntilTimestamp,
    resolvedAtUnixMs: Date.now().toString(),
    state,
    ...(authorizations.length > 1 ? { authorizations: [...authorizations] } : {}),
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

export type ValueTransactionResolution =
  | { state: "pending"; ours?: NullifierConsumption; first?: NullifierConsumption }
  | { state: "expired" }
  | { state: "settled"; ours: NullifierConsumption | undefined; first: NullifierConsumption };

/**
 * Resolve one watched nullifier tuple against the synced chain. Bookkeeping
 * follows finality: a consuming transaction settles the action once its block
 * is finalized, and a missed deadline releases it once finalized time has
 * passed it. Head is not proof either way, since a reorg can drop an
 * inclusion or restore a fork that included the transaction before its
 * deadline; until finality the inputs stay reserved and the bytes stay
 * retryable.
 */
export function resolveValueTransaction(
  chain: WalletChainState | null,
  status: StatusResult,
  contentHash: string,
  nullifiers: readonly string[],
  validUntilTimestamp: string,
): ValueTransactionResolution {
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
  const ours = consumed.find((consumption) => consumption.contentHash.toLowerCase() === contentHash.toLowerCase());
  if (consumed.some((consumption) => consumption.pcashNumber > status.finalizedBlock)) {
    return { state: "pending", first: consumed[0]!, ...(ours === undefined ? {} : { ours }) };
  }
  return { state: "settled", ours, first: consumed[0]! };
}

/**
 * Reconcile note-funded reservations from their exact nullifier tuple. The
 * rows of one re-authorized payment spend the same notes and settle together;
 * the payment's history records whichever of them landed, once.
 */
export function reconcilePendingNoteFundedTransfers(
  data: WalletFileData,
  chain: WalletChainState | null,
  status: StatusResult,
): boolean {
  let changed = false;
  const rows = [...(data.pendingNoteFundedTransfers ?? [])];
  // Each payment's live row as it stands before reconciliation retires any row.
  const live = new Map(livePendingNoteFundedTransfers(data).map((row) => [paymentOfTransfer(row), row]));
  for (const transfer of rows) {
    const resolution = resolveValueTransaction(
      chain,
      status,
      transfer.contentHash,
      transfer.inputs.map((input) => input.nullifier),
      transfer.validUntilTimestamp,
    );
    if (resolution.state === "pending") continue;
    const latest = live.get(paymentOfTransfer(transfer))!;
    const payment = rows.filter((row) => paymentOfTransfer(row) === paymentOfTransfer(transfer));
    const authorizations = [...new Set(payment.flatMap(paymentAuthorizations).map((hash) => hash.toLowerCase()))];
    removePendingChangeNote(data, transfer);
    if (resolution.state === "expired") {
      // The payment stays pending while another of its rows could still land,
      // and those rows keep answering to this one's hashes.
      const remaining = payment.filter((row) => row !== transfer && (data.pendingNoteFundedTransfers ?? []).includes(row));
      for (const row of remaining) {
        const named = new Set(paymentAuthorizations(row).map((hash) => hash.toLowerCase()));
        const kept = paymentAuthorizations(transfer).filter((hash) => !named.has(hash.toLowerCase()));
        if (kept.length > 0) row.expiredAuthorizations = [...(row.expiredAuthorizations ?? []), ...kept];
      }
      // Setup mining no Ethereum transaction carried leaves no history, like its abandoned setup.
      if (remaining.length === 0 && !unsentSetupMining(data, transfer)) retainPaymentHistory(data, transfer, authorizations, "expired");
    } else if (resolution.ours !== undefined) {
      retainPaymentHistory(data, transfer, authorizations, "succeeded", resolution.ours);
    } else {
      const consumer = resolution.first.contentHash;
      const ownPayment = authorizations.some((hash) => sameHex(hash, consumer));
      // A conflicting spend fails the payment once, on its live row.
      if (!ownPayment && latest === transfer) {
        retainPaymentHistory(data, transfer, authorizations, "conflicted", resolution.first);
      }
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
    const resolution = resolveValueTransaction(
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
