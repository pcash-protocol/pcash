import type { PcashNodeClient, StatusResult } from "@pcash/sdk/clients";
import { stringify } from "viem";

export interface RelayAttempt {
  id: string;
  at: number;
  contentHashes: string[];
  /** Newly proved mine actions whose designated issuance remains ours if copied. */
  mineContentHashes?: string[];
  /** Fees on our own pending payments are returned funds, not relay earnings. */
  ownContentHashes?: string[];
  minedElsewhereCount?: number;
  /** Issuance commitments this relayer controls: the batch poster and known designated ones. */
  controlledCommitments?: string[];
  txHash?: string;
  resolutionId?: string;
  status: "wallet" | "pending" | "included" | "finalized" | "failed";
  l1BlockHash?: string;
  l1BlockNumber?: bigint;
  /** Settled explicit fees paid to a controlled destination. */
  collectedFee?: bigint;
  /** Settled issuance paid to a controlled destination. */
  collectedIssuance?: bigint;
  error?: string;
  acceptedCount?: number;
  skippedCount?: number;
}

/** Canonical deployment identity shared by wallet history and public batch details. */
export function relayDeploymentKey(status: Pick<StatusResult, "pcashChainId" | "genesisHash" | "l1ChainId" | "inboxAddress">): string {
  return `${status.pcashChainId}:${status.genesisHash.toLowerCase()}:${status.l1ChainId}:${status.inboxAddress.toLowerCase()}`;
}

export function relayHistoryKey(network: string, address: string): string {
  return `pcash:relay-history:${network}:${address.toLowerCase()}`;
}

export interface RelayReleaseIdentity {
  resolutionId: string;
  transactionHash: string | null;
  selected: readonly string[];
}

export interface RelayRecoveredIdentity extends Omit<RelayReleaseIdentity, "transactionHash"> {
  transactionHash: string;
}

export const RELAY_ATTEMPTS_RELEASED_EVENT = "pcash:relay-attempts-released";
export interface RelayAttemptsReleasedDetail {
  historyKey: string;
  released: readonly RelayReleaseIdentity[];
  recovered?: readonly RelayRecoveredIdentity[];
}

function matchesRelayAttempt(row: RelayAttempt, entry: RelayReleaseIdentity): boolean {
  if (row.resolutionId !== undefined) return row.resolutionId.toLowerCase() === entry.resolutionId.toLowerCase();
  if (row.txHash !== undefined && entry.transactionHash !== null) return row.txHash.toLowerCase() === entry.transactionHash.toLowerCase();
  return row.contentHashes.length > 0 && row.contentHashes.length === entry.selected.length
    && row.contentHashes.every(hash => entry.selected.some(selected => hash.toLowerCase() === selected.toLowerCase()));
}

/** Recover publication identity before a successful SDK reconciliation archives it. */
export function applyRecoveredRelayAttempts(rows: RelayAttempt[], recovered: readonly RelayRecoveredIdentity[]): RelayAttempt[] {
  let changed = false;
  const next = rows.map(row => {
    if (row.status !== "wallet" && row.status !== "pending") return row;
    const match = recovered.find(entry => matchesRelayAttempt(row, entry));
    if (match === undefined || (row.status === "pending" && row.txHash === match.transactionHash && row.resolutionId === match.resolutionId && row.error === undefined)) return row;
    changed = true;
    const { error: _error, ...pending } = row;
    return { ...pending, status: "pending" as const, txHash: match.transactionHash, resolutionId: match.resolutionId };
  });
  return changed ? next : rows;
}

/** Only positive recovery results can end a pending attempt without a canonical batch. */
export function applyReleasedRelayAttempts(rows: RelayAttempt[], released: readonly RelayReleaseIdentity[]): RelayAttempt[] {
  let changed = false;
  const next = rows.map(row => {
    if (row.status !== "wallet" && row.status !== "pending") return row;
    const match = released.find(entry => matchesRelayAttempt(row, entry));
    if (match === undefined) return row;
    changed = true;
    const { collectedFee: _fee, collectedIssuance: _issuance, acceptedCount: _accepted, skippedCount: _skipped,
      l1BlockHash: _blockHash, l1BlockNumber: _blockNumber, minedElsewhereCount: _elsewhere, ...pending } = row;
    return { ...pending, status: "failed" as const, error: "The Ethereum submission was dropped or replaced. This batch was not posted." };
  });
  return changed ? next : rows;
}

/** Storage events do not fire in their writing tab; update mounted consumers explicitly. */
export function publishReleasedRelayAttempts(historyKey: string, released: readonly RelayReleaseIdentity[], recovered: readonly RelayRecoveredIdentity[] = []): void {
  if (released.length === 0 && recovered.length === 0) return;
  saveRelayHistory(historyKey, applyReleasedRelayAttempts(applyRecoveredRelayAttempts(readRelayHistory(historyKey), recovered), released));
  window.dispatchEvent(new CustomEvent<RelayAttemptsReleasedDetail>(RELAY_ATTEMPTS_RELEASED_EVENT, { detail: { historyKey, released, ...(recovered.length === 0 ? {} : { recovered }) } }));
}

export function readRelayHistory(key: string): RelayAttempt[] {
  try {
    const rows: unknown = JSON.parse(sessionStorage.getItem(key) ?? "[]", (name, value) =>
      name === "collectedFee" || name === "collectedIssuance" || name === "l1BlockNumber" ? BigInt(value) : value,
    );
    if (!Array.isArray(rows)) return [];
    return rows.filter((row): row is RelayAttempt => row !== null && typeof row === "object"
      && typeof row.id === "string" && typeof row.at === "number"
      && Array.isArray(row.contentHashes) && row.contentHashes.every((hash: unknown) => typeof hash === "string")
      && (row.minedElsewhereCount === undefined || (Number.isSafeInteger(row.minedElsewhereCount) && row.minedElsewhereCount >= 0))
      && [row.mineContentHashes, row.ownContentHashes].every(hashes => hashes === undefined || (Array.isArray(hashes) && hashes.every((hash: unknown) => typeof hash === "string")))
      && (row.controlledCommitments === undefined || (Array.isArray(row.controlledCommitments) && row.controlledCommitments.every((commitment: unknown) => typeof commitment === "string")))
      && ["wallet", "pending", "included", "finalized", "failed"].includes(row.status)
      && (row.txHash === undefined || typeof row.txHash === "string")
      && (row.resolutionId === undefined || typeof row.resolutionId === "string")
      && (row.error === undefined || typeof row.error === "string")
      && (row.l1BlockNumber === undefined || typeof row.l1BlockNumber === "bigint")
      && (row.collectedFee === undefined || typeof row.collectedFee === "bigint")
      && (row.collectedIssuance === undefined || typeof row.collectedIssuance === "bigint"));
  } catch {
    return [];
  }
}

export function saveRelayHistory(key: string, attempts: readonly RelayAttempt[]): void {
  try {
    sessionStorage.setItem(key, stringify(attempts.slice(0, 100)));
  } catch {
    // Browser storage is optional; the current session keeps its history.
  }
}

export function findRelayAttempt(network: string, txHash: string): RelayAttempt | undefined {
  try {
    const prefix = `pcash:relay-history:${network}:`;
    for (let index = 0; index < sessionStorage.length; index += 1) {
      const key = sessionStorage.key(index);
      if (!key?.startsWith(prefix)) continue;
      const attempt = readRelayHistory(key).find((row) => row.txHash?.toLowerCase() === txHash.toLowerCase());
      if (attempt !== undefined) return attempt;
    }
  } catch { /* Local history is optional. */ }
  return undefined;
}

export function isRelayAttemptTracking(attempt: RelayAttempt): boolean {
  return attempt.status === "pending" || attempt.status === "included"
    || (attempt.status === "finalized" && attempt.collectedFee === undefined);
}

export async function reconcileAttempt(
  node: Pick<PcashNodeClient, "getReceipt" | "getInboxDeliveryBatch" | "status">,
  attempt: RelayAttempt,
  address: string,
): Promise<RelayAttempt> {
  if (!isRelayAttemptTracking(attempt) || !attempt.txHash) return attempt;
  const batch = await node.getInboxDeliveryBatch(attempt.txHash);
  const { collectedFee: _fee, collectedIssuance: _issuance, acceptedCount: _accepted, skippedCount: _skipped, l1BlockHash: _block, l1BlockNumber: _blockNumber, error: _error, ...base } = attempt;
  if (batch === null) return attempt.status === "pending" ? attempt : { ...base, status: "pending" };
  if (batch.l1Sender.toLowerCase() !== address.toLowerCase()
    || batch.l1TransactionHash.toLowerCase() !== attempt.txHash.toLowerCase()) return attempt;
  const status = await node.status();
  const included: RelayAttempt = {
    ...base,
    status: "included",
    l1BlockHash: batch.l1BlockHash,
    l1BlockNumber: batch.l1BlockNumber,
    ...(attempt.l1BlockHash === batch.l1BlockHash && attempt.collectedFee !== undefined
      ? { collectedFee: attempt.collectedFee, collectedIssuance: attempt.collectedIssuance ?? 0n, acceptedCount: attempt.acceptedCount!, skippedCount: attempt.skippedCount! } : {}),
  };
  const selectedItems = batch.exclusionReason === null ? attempt.contentHashes.map((contentHash) =>
    batch.items.find((item) => item.contentHash.toLowerCase() === contentHash.toLowerCase()),
  ) : [];
  if (selectedItems.some((item) => item === undefined)) return included;
  const includedItems = selectedItems.filter((item) => item !== undefined).filter((item) => item.exclusionReason === null);
  const observed = await Promise.allSettled(includedItems.map(async (item) =>
    (await node.getReceipt({ inclusionId: {
      l1BlockHash: batch.l1BlockHash,
      l1TransactionIndex: batch.l1TransactionIndex,
      batchItemIndex: item.batchItemIndex,
    } })).find((receipt) =>
      receipt.contentHash.toLowerCase() === item.contentHash.toLowerCase()
      && receipt.l1Sender.toLowerCase() === address.toLowerCase()
      && receipt.inclusion.l1TransactionHash.toLowerCase() === attempt.txHash!.toLowerCase(),
    ),
  ));
  if (observed.some((result) => result.status === "rejected" || result.value === undefined)) return included;
  const receipts = observed.flatMap((result) => result.status === "fulfilled" && result.value !== undefined ? [result.value] : []);
  const acceptedCount = receipts.filter((receipt) => receipt.outcome === "succeeded").length;
  const finalized = batch.l1BlockNumber <= status.finalizedL1BlockNumber;
  if (finalized && includedItems.length === 0) {
    const confirmedBatch = await node.getInboxDeliveryBatch(attempt.txHash);
    if (confirmedBatch === null
      || confirmedBatch.l1BlockHash !== batch.l1BlockHash
      || confirmedBatch.l1TransactionIndex !== batch.l1TransactionIndex) return included;
  }
  const collected = receipts.filter((receipt) => receipt.issuanceOwnerCommitment !== null
    && attempt.controlledCommitments?.some((commitment) => commitment.toLowerCase() === receipt.issuanceOwnerCommitment!.toLowerCase()) === true);
  return {
    ...included,
    status: finalized ? "finalized" : "included",
    acceptedCount,
    skippedCount: attempt.contentHashes.length - acceptedCount,
    collectedFee: collected.reduce((total, receipt) => total + (attempt.ownContentHashes?.some(id => id.toLowerCase() === receipt.contentHash.toLowerCase()) ? 0n : receipt.settledOpenFeeAmount), 0n),
    collectedIssuance: collected.reduce((total, receipt) => total + receipt.settledIssuanceAmount, 0n),
  };
}
