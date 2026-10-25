import type { PcashNodeClient } from "@pcash/sdk/clients";
import type { RelayJournalEntry, RelayJournalRecovery } from "@pcash/sdk/relay";
import type { Address, Hash, PublicClient } from "viem";
import type { RelayRecoveredIdentity } from "../shared/relayHistory.ts";

/** The L1 reads that decide whether a locked submission can still land. */
export interface SubmissionLockL1 {
  getBlockNumber(): Promise<bigint>;
  /** Null when the L1 RPC does not know the transaction. */
  getTransaction(hash: string): Promise<unknown>;
  /** Nonce used through `blockNumber`, or including the mempool for "pending". */
  getTransactionCount(address: string, at: bigint | "pending"): Promise<number>;
}

/**
 * `waiting`: in-flight submissions that may still land, or landed and the node
 * has not derived them yet. `released`: submissions that were dropped or replaced; their
 * journal entries were archived. Both empty means nothing is locked.
 */
export interface SubmissionLockRefresh {
  waiting: RelayJournalEntry[];
  /** Resolution IDs confirmed on Ethereum but not yet processed by PCASH. */
  awaitingDerivation: string[];
  released: RelayJournalEntry[];
  recovered?: RelayRecoveredIdentity[];
}

/** Retain batch publication identities before SDK recovery archives their journal entries. */
export async function reconcileSubmissionLock(recovery: RelayJournalRecovery) {
  const before = await recovery.show();
  const reconciliation = await recovery.reconcile();
  const recovered: RelayRecoveredIdentity[] = [];
  for (const outcome of reconciliation.entries) {
    const entry = before.entries.find(entry => entry.resolutionId.toLowerCase() === outcome.resolutionId.toLowerCase());
    if (entry === undefined) continue;
    const transactionHash = outcome.transactionHash ?? entry.transactionHash;
    if (entry.kind === "batch" && transactionHash !== null) recovered.push({ resolutionId: entry.resolutionId, transactionHash, selected: entry.selected });
  }
  return { reconciliation, recovered };
}

/**
 * How long a transaction the site's L1 RPC cannot see keeps its lock. The
 * wallet broadcasts through its own RPC, so a just-sent transaction can be
 * unknown here, with its nonce still free, for a while.
 */
export const SUBMISSION_PROPAGATION_GRACE_MS = 120_000;

/** When this page first saw each journaled transaction hash. */
const hashSeenAt = new Map<string, number>();

/**
 * Settle every in-flight submission, and release one only when its transaction
 * can no longer post its batch. A spent nonce means some transaction mined in
 * its place; once the node has derived through that block, anything our batch
 * delivered has left the mempool, so a new batch cannot post it again. A
 * transaction the L1 does not know whose nonce is still free is lost once it
 * has had time to propagate: the next submission reuses that nonce, so at most
 * one of the two can mine.
 */
export async function refreshSubmissionLock(
  recovery: RelayJournalRecovery,
  l1: SubmissionLockL1,
  node: Pick<PcashNodeClient, "status">,
  now: () => number = Date.now,
): Promise<SubmissionLockRefresh> {
  const { reconciliation, recovered } = await reconcileSubmissionLock(recovery);
  const refresh: SubmissionLockRefresh = { waiting: [], awaitingDerivation: [], released: [], ...(recovered.length === 0 ? {} : { recovered }) };
  if (!reconciliation.latched) return refresh;
  const unobserved = new Set(reconciliation.entries
    .filter((entry) => entry.outcome === "unobserved")
    .map((entry) => entry.resolutionId));
  for (const entry of (await recovery.show()).entries) {
    if (unobserved.has(entry.resolutionId)) refresh.awaitingDerivation.push(entry.resolutionId);
    if (unobserved.has(entry.resolutionId) || !await lost(entry, l1, node, now())) {
      refresh.waiting.push(entry);
      continue;
    }
    await recovery.resolve(entry.resolutionId);
    refresh.released.push(entry);
  }
  return refresh;
}

async function lost(entry: RelayJournalEntry, l1: SubmissionLockL1, node: Pick<PcashNodeClient, "status">, now: number): Promise<boolean> {
  if (entry.transactionHash !== null && await l1.getTransaction(entry.transactionHash) !== null) return false;
  const nonce = BigInt(entry.nonce);
  const head = await l1.getBlockNumber();
  const [mined, pending] = await Promise.all([
    l1.getTransactionCount(entry.relayerAddress, head),
    l1.getTransactionCount(entry.relayerAddress, "pending"),
  ]);
  if (BigInt(mined) > nonce) return (await node.status()).latestL1BlockNumber >= head;
  // Something sits at our nonce in the mempool, possibly our own transaction.
  if (BigInt(pending) > nonce) return false;
  // The entry is created before the wallet prompt and its hash recorded after
  // it, so a hash's grace runs from when this page first saw it.
  let since = Date.parse(entry.createdAt);
  if (entry.transactionHash !== null) {
    const key = `${entry.resolutionId}:${entry.transactionHash}`;
    if (!hashSeenAt.has(key)) hashSeenAt.set(key, now);
    since = Math.max(since, hashSeenAt.get(key)!);
  }
  return now - since >= SUBMISSION_PROPAGATION_GRACE_MS;
}

export function viemSubmissionLockL1(client: PublicClient): SubmissionLockL1 {
  return {
    getBlockNumber: () => client.getBlockNumber(),
    getTransaction: (hash) => client.request({ method: "eth_getTransactionByHash", params: [hash as Hash] }),
    getTransactionCount: (address, at) => client.getTransactionCount({ address: address as Address, ...(at === "pending" ? { blockTag: "pending" } : { blockNumber: at }) }),
  };
}
