import { transactionIdentity } from "@pcash/sdk/browser";
import { pollReceipt, type PcashNodeClient, type StatusResult } from "@pcash/sdk/clients";
import type { L1SubmissionAdapter } from "@pcash/sdk/wallet";
import { fromHex } from "@pcash/sdk/utils";
import { prepareFastBatch } from "./prepareFastBatch.ts";

/** Publish the exact pending transaction using the same planner, randomization, and journal as Fast private send. */
export async function finalizeMempoolTransaction({ node, readStatus, submission, contentHash, profile, ownPendingContentHashes, assertActive, onL1Submitted }: {
  node: PcashNodeClient;
  readStatus(): Promise<StatusResult>;
  submission: L1SubmissionAdapter;
  contentHash: string;
  profile: { address: bigint; nkRoot: bigint };
  ownPendingContentHashes: readonly string[];
  assertActive(): void;
  onL1Submitted(hash: string): Promise<void>;
}) {
  assertActive();
  if ((await pollReceipt(node, contentHash))?.outcome === "succeeded") return;
  const pending = await node.getMempoolTransaction(contentHash);
  if (pending?.status !== "ready" || pending.rawTransaction === null) {
    throw new Error("This transaction is no longer ready in the mempool. Refresh its status before continuing.");
  }
  const entry = fromHex(pending.rawTransaction);
  if (transactionIdentity(entry).contentHash.toLowerCase() !== contentHash.toLowerCase()) {
    throw new Error("The node returned different bytes for this transaction.");
  }
  const status = await readStatus();
  const context = { transactionBytes: entry, contentHash, status, retry: true };
  const prepared = await prepareFastBatch(submission, context, { node, profile,
    ownPendingContentHashes, actionQualifies: pending.kind === "privateValue" });
  assertActive();
  return submission.submit({ ...context, prepared, onL1Submitted });
}
