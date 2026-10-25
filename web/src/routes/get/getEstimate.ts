import { rewardEach, type IssuanceTerms } from "@pcash/sdk/protocol";
import type { BatchActions } from "../../lib/fastBatch.ts";

export { MAX_MINE_ACTIONS } from "@pcash/sdk/wallet/actions";

/** Wei spent per 1,000 PCASH received; absent when no earnings are expected. */
export function acquisitionCostPerThousand(costWei: bigint, received: bigint): bigint | undefined {
  return received <= 0n ? undefined : costWei * 1_000n * 10n ** 18n / received;
}

/** Issuance a batch pays this wallet when its block holds at least `blockActions` qualifying actions, its own included. */
export function batchIssuance(terms: IssuanceTerms, actions: BatchActions, blockActions: bigint): bigint {
  return actions.collectible * rewardEach(terms, actions.qualifying > blockActions ? actions.qualifying : blockActions);
}
