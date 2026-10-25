// Canonical PCASH receipt selection and polling.
//
// This module is browser-safe and is shared by the CLI and web clients. A
// receipt existing is not acceptance: derivation also records skipped
// inclusions, and duplicate inclusion can produce both an accepted receipt and
// a later skipped replay for the same transaction.

import { type PcashNodeClient, type ReceiptResult, type StatusResult } from "./nodeClient.ts";
import { sleep } from "../utils/time.ts";

/**
 * Prefer an accepted inclusion over skipped replays, then the earliest one.
 * Inclusions in the same block tie-break on transaction id, so the choice does
 * not depend on the order the node listed them.
 */
export function selectReceipt(receipts: readonly ReceiptResult[]): ReceiptResult {
  if (receipts.length === 0) throw new Error("cannot select from an empty receipt list");
  const accepted = receipts.filter((receipt) => receipt.outcome === "succeeded");
  const pool = accepted.length > 0 ? accepted : receipts;
  return pool.reduce((left, right) =>
    right.inclusion.l1BlockNumber < left.inclusion.l1BlockNumber
      || (right.inclusion.l1BlockNumber === left.inclusion.l1BlockNumber && right.transactionId < left.transactionId)
      ? right
      : left
  );
}

export interface AwaitReceiptOptions {
  finalized?: boolean;
  pollIntervalMs?: number;
  pollMaxAttempts?: number;
  onWait?: (attempt: number) => void;
}

async function receiptsForContentHash(
  node: PcashNodeClient,
  contentHash: string,
): Promise<ReceiptResult[]> {
  return node.getReceipt({ contentHash });
}

/** Poll reorg-safely until a latest or finalized receipt is observable. */
export async function awaitReceipt(
  node: PcashNodeClient,
  contentHash: string,
  options: AwaitReceiptOptions = {},
): Promise<ReceiptResult | null> {
  const interval = options.pollIntervalMs ?? 1_000;
  const maxAttempts = options.pollMaxAttempts ?? 120;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const receipts = await receiptsForContentHash(node, contentHash);
    if (receipts.length > 0) {
      const receipt = selectReceipt(receipts);
      if (!options.finalized) return receipt;
      if (isFinalized(receipt.inclusion.l1BlockNumber, await node.status())) return receipt;
    }
    options.onWait?.(attempt);
    if (attempt < maxAttempts - 1) await sleep(interval);
  }
  return null;
}

/** Await a receipt and require canonical derivation acceptance. */
export async function awaitAcceptedReceipt(
  node: PcashNodeClient,
  contentHash: string,
  options: AwaitReceiptOptions = {},
): Promise<ReceiptResult> {
  const receipt = await awaitReceipt(node, contentHash, options);
  if (receipt === null) {
    throw new Error(
      `timed out waiting for the pcash receipt of content ${contentHash} at ${options.finalized ? "finalized" : "latest"}. `
        + "This is a client-side wait timeout, not a rejection: the transaction may still be accepted on-chain. "
        + "Run 'pcash scan' or rescan the wallet to reconcile it.",
    );
  }
  if (receipt.outcome !== "succeeded") {
    throw new Error(
      `pcash transaction content ${contentHash} received canonical outcome ${receipt.outcome} (kind=${receipt.kind}). `
        + "This inclusion is nonterminal; pending inputs remain reserved until canonical acceptance "
        + "or finalized expiry.",
    );
  }
  return receipt;
}

/** Read the currently preferred receipt once, or null when none exists. */
export async function pollReceipt(
  node: PcashNodeClient,
  contentHash: string,
): Promise<ReceiptResult | null> {
  const receipts = await receiptsForContentHash(node, contentHash);
  return receipts.length === 0 ? null : selectReceipt(receipts);
}

export function isFinalized(block: bigint, status: StatusResult): boolean {
  return block <= status.finalizedL1BlockNumber;
}
