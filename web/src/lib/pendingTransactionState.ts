import { pollReceipt, type PcashNodeClient } from "@pcash/sdk/clients";
import { batchEntryCarrying } from "@pcash/sdk/relay";
import type { L1SubmissionAdapter } from "@pcash/sdk/wallet";

/** Read the node and the shared Ethereum journal without starting a submission. */
export async function pendingTransactionState(node: PcashNodeClient, submission: L1SubmissionAdapter | undefined, contentHash: string) {
  if ((await pollReceipt(node, contentHash))?.outcome === "succeeded") return { state: "confirmed" as const };
  const recovery = await submission?.l1Recovery?.();
  const entry = batchEntryCarrying((await recovery?.show())?.entries ?? [], contentHash);
  if (entry !== undefined) {
    return { state: entry.transactionHash ? "ethereum" as const : "ambiguous" as const, hash: entry.transactionHash ?? undefined, recovery };
  }
  const item = await node.getMempoolTransaction(contentHash);
  return { state: item?.status === "ready" ? "mempool" as const : "absent" as const };
}

export type PendingTransactionState = Awaited<ReturnType<typeof pendingTransactionState>>["state"];
