import type { PcashNodeClient } from "@pcash/sdk/clients";
import { reconcileAttempt, type RelayAttempt } from "../../shared/relayHistory.ts";
import { resolveEarnLanding, type EarnOwner, type EarnWatchNode } from "../wallet/earnOutcome.ts";

type GetAttempt = RelayAttempt & { mineContentHashes?: string[] };
type GetWatchNode = EarnWatchNode & Pick<PcashNodeClient, "getInboxDeliveryBatch" | "getBlockByHash" | "status">;

/** Include designated mining payouts even when another poster included the mine first. */
export async function reconcileGetAttempt(
  node: GetWatchNode,
  attempt: GetAttempt,
  address: string,
  owner: EarnOwner,
): Promise<RelayAttempt> {
  if (attempt.mineContentHashes === undefined || attempt.mineContentHashes.length === 0) {
    return reconcileAttempt(node, attempt, address);
  }
  // Recompute from canonical receipts rather than adding to a prior polling result.
  const { collectedFee: _fee, collectedIssuance: _issuance, minedElsewhereCount: _elsewhere, ...fresh } = attempt;
  const batch = await reconcileAttempt(node, fresh, address);
  if (batch.collectedFee === undefined || batch.collectedIssuance === undefined || attempt.txHash === undefined) return batch;
  let minedElsewhere = 0n;
  let minedElsewhereCount = 0;
  for (const contentHash of new Set(attempt.mineContentHashes.map(hash => hash.toLowerCase()))) {
    const reading = await resolveEarnLanding(node, contentHash, owner, { indexAttempts: 1, intervalMs: 0, sleep: async () => undefined });
    if (reading.kind === "absent" && batch.status === "finalized" && reading.indexHead !== undefined && batch.l1BlockNumber !== undefined) {
      // Canonical delivery can precede the submission index. Bind its head to the current branch before concluding absence.
      const indexedBlock = await node.getBlockByHash(reading.indexHead.blockHash);
      if (indexedBlock !== null && indexedBlock.l1Origin.blockNumber >= batch.l1BlockNumber) continue;
    }
    if (reading.kind !== "landed" || (reading.landing.outcome === "succeeded" && reading.landing.payout === null)) {
      const { collectedFee: _pendingFee, collectedIssuance: _pendingIssuance, ...pending } = batch;
      return pending;
    }
    const { landing } = reading;
    if (landing.outcome !== "succeeded" || landing.payout?.issuanceAmount === 0n || landing.l1TransactionHash?.toLowerCase() === attempt.txHash.toLowerCase()) continue;
    if (landing.l1TransactionHash === undefined || landing.payout?.yours === null) {
      const { collectedFee: _pendingFee, collectedIssuance: _pendingIssuance, ...pending } = batch;
      return pending;
    }
    if (landing.payout?.yours === true) {
      minedElsewhere += landing.payout.issuanceAmount;
      minedElsewhereCount += 1;
    }
  }
  return { ...batch, collectedIssuance: batch.collectedIssuance + minedElsewhere, minedElsewhereCount };
}
