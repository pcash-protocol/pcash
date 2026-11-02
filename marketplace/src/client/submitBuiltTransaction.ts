import { createMempoolSubmissionAdapter, type DurableSubmissionAdapter, type WalletExecutionContext } from "@pcash/sdk/wallet";
// Marketplace transactions follow the wallet's configured publication: the
// configured node's mempool by default, or Ethereum through an explicit L1
// wallet adapter. Proof-free USER creation requires owner publication.

import {
  transactionIdentity,
  transactionPublication,
  type PcashNodeClient,
  type StatusResult,
  type SubmitRawTransactionResult,
} from "@pcash/sdk/browser";
import type { ReceiptResult } from "@pcash/sdk/browser";
import { pollReceipt } from "@pcash/sdk/browser";
import type { ProvePhase } from "@pcash/sdk/browser-prover";

export interface BuiltTransactionSubmissionParams {
  node: PcashNodeClient;
  /** The node status the bytes were prepared against; read now when absent. */
  status?: StatusResult;
  onProgress?: (phase: ProvePhase, message: string) => void;
}

export interface BuiltTransactionSubmissionResult {
  contentHash: string;
  receipt: ReceiptResult | null;
  queued: boolean;
}

/** A marketplace transaction submitter; only direct L1 publication bypasses public mempool admission. */
export type MarketplaceTransactionSubmitter = ((
  entry: Uint8Array,
  params: BuiltTransactionSubmissionParams,
) => Promise<BuiltTransactionSubmissionResult>) & { readonly publication?: "l1" };

/** Proof-free USER creation has no note-funded publication incentive. */
export class MarketplaceUnpaidTransactionError extends Error {
  constructor() {
    super("proof-free USER creation must use owner-authorized Ethereum publication");
    this.name = "MarketplaceUnpaidTransactionError";
  }
}

function nonRelayableMempoolStatus(contentHash: string, status: string): Error {
  return new Error(
    `transaction ${contentHash} has non-relayable mempool status ${status}; wait for node lifecycle reconciliation before retrying`,
  );
}

/** Admit exact bytes through the wallet's mempool adapter, which rechecks the node's status first. */
export async function submitBuiltTransaction(
  entry: Uint8Array,
  params: BuiltTransactionSubmissionParams,
): Promise<BuiltTransactionSubmissionResult> {
  if (transactionPublication(entry) === null) throw new MarketplaceUnpaidTransactionError();
  const mempool = createMempoolSubmissionAdapter(params.node);
  const { contentHash } = transactionIdentity(entry);
  const status = params.status ?? await params.node.status();
  const prepared = await mempool.preflight({ transactionBytes: entry, status, retry: false });
  params.onProgress?.("submitting", "verifying and submitting to the configured node…");
  const { output } = await mempool.submit({ transactionBytes: entry, status, retry: false, prepared });
  const admitted = output.admission as SubmitRawTransactionResult;
  if (admitted.status.toLowerCase() !== "ready") {
    const receipt = await pollReceipt(params.node, contentHash);
    if (receipt?.outcome === "succeeded") {
      params.onProgress?.("confirming", "accepted on the canonical chain");
      return { contentHash: admitted.contentHash, receipt, queued: false };
    }
    const retained = await params.node.getMempoolTransaction(contentHash);
    if (retained?.status.toLowerCase() !== "ready") {
      throw nonRelayableMempoolStatus(contentHash, retained?.status ?? admitted.status);
    }
  }
  params.onProgress?.("confirming", "accepted by the configured node; awaiting relay");
  return { contentHash: admitted.contentHash, receipt: null, queued: true };
}

/** Submit a wallet-built action's exact bytes to the configured node's mempool through `submit`. */
export function marketplaceMempoolSubmission(
  node: PcashNodeClient,
  submit: typeof submitBuiltTransaction,
  onProgress?: (phase: ProvePhase, message: string) => void,
): DurableSubmissionAdapter {
  return {
    mode: "mempool",
    preflight: async () => undefined,
    submit: async ({ transactionBytes: entry, status }) => {
      const output = await submit(entry, { node, status, ...(onProgress !== undefined ? { onProgress } : {}) });
      return {
        accepted: output.receipt?.outcome === "succeeded",
        queued: output.queued,
        output,
      };
    },
  };
}

/**
 * Publish through the configured public mempool unless the wallet itself posts
 * to Ethereum. A selected quote changes the proved fee output, not transport.
 */
export function createMarketplaceTransactionSubmitter(
  wallet: WalletExecutionContext,
  mempoolSubmit: typeof submitBuiltTransaction = submitBuiltTransaction,
): MarketplaceTransactionSubmitter {
  const adapter = wallet.submission;
  if (adapter?.mode !== "l1") return mempoolSubmit;
  const publish = async (entry: Uint8Array, params: BuiltTransactionSubmissionParams): Promise<BuiltTransactionSubmissionResult> => {
    const { contentHash } = transactionIdentity(entry);
    const status = await params.node.status();
    params.onProgress?.("submitting", "Approve Ethereum gas to publish this PCASH transaction yourself.");
    const prepared = await adapter.preflight({ transactionBytes: entry, status, retry: false });
    const result = await adapter.submit({ transactionBytes: entry, status, retry: false, prepared });
    return { contentHash, receipt: await pollReceipt(params.node, contentHash), queued: result.queued };
  };
  return Object.assign(publish, { publication: adapter.mode });
}
