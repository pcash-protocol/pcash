import { transactionIdentity } from "@pcash/sdk/browser";
import type { PcashNodeClient } from "@pcash/sdk/clients";
import type { L1SubmissionAdapter } from "@pcash/sdk/wallet";
import { planFastBatch } from "./fastBatch.ts";

/** Content hashes carried by this Ethereum account's batches that have not settled yet. */
export async function inFlightContentHashes(submission: Pick<L1SubmissionAdapter, "l1Recovery">): Promise<string[]> {
  const view = await (await submission.l1Recovery?.())?.show();
  return (view?.entries ?? []).flatMap((entry) => entry.kind === "batch" ? entry.selected.map((id) => id.toLowerCase()) : []);
}

/**
 * Prepare the required transactions for Ethereum with this wallet's other pending
 * transactions after them and paying mempool transactions beside them. Optional mempool
 * work must never displace any of the user's required transactions.
 */
export async function prepareFastBatch(submission: L1SubmissionAdapter,
  context: Parameters<L1SubmissionAdapter["preflight"]>[0],
  options: {
    node: PcashNodeClient;
    profile: { address: bigint; nkRoot: bigint };
    ownPendingContentHashes: readonly string[];
    actionQualifies?: boolean;
  }) {
  const required = [context.transactionBytes, ...context.additionalTransactions ?? []];
  const plan = await (async () => planFastBatch({ ...options, status: context.status,
    transactionByteSize: required.reduce((sum, entry) => sum + BigInt(entry.length), 0n),
    requiredTransactionCount: required.length, companionsOptional: true,
    // A batch still in flight blocks any other batch that carries its transactions.
    excludeContentHashes: [transactionIdentity(context.transactionBytes).contentHash, ...(context.additionalTransactions ?? []).map(entry => transactionIdentity(entry).contentHash), ...await inFlightContentHashes(submission)],
  }))().catch(() => undefined);
  const standalone = () => submission.preflight({ ...context, companions: { transactions: [], collectibleOpenFee: 0n, collectibleOpenFees: [] } });
  return plan === undefined ? standalone()
    : submission.preflight({ ...context, additionalTransactions: [...context.additionalTransactions ?? [], ...plan.own], companions: plan.companions }).catch(standalone);
}
