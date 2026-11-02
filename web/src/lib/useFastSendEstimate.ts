import { purchaseBatches } from "@pcash/marketplace/app";
import { transactionIdentity } from "@pcash/sdk/browser";
import { useEffect, useRef, useState } from "react";
import { PADDED_PRIVATE_VALUE_BYTE_SIZE } from "@pcash/sdk/wallet/actions";
import { planFastBatch } from "./fastBatch.ts";
import { errorMessage, useWallet } from "./WalletProvider.tsx";
import type { DisplayIssuanceInputs } from "./usePaymentIssuance.ts";

export type FastSendEstimate =
  | { state: "loading" }
  | { state: "error"; message: string }
  | {
    state: "ready";
    /** Expected ETH cost of posting the batch, and the most it can cost at the quoted fee cap. */
    estimatedCostWei: bigint;
    maximumCostWei: bigint;
    /** PCASH the batch is expected to pay this wallet: fees it collects plus expected issuance. */
    collectibleOpenFee: bigint;
    expectedIssuance: bigint;
    /** Mempool transactions carried alongside the new payment, and how many of them are this wallet's own. */
    companions: number;
    ownIncluded: number;
  };

/**
 * A display-only preview of a Fast send, re-planned on every new head: the
 * batch the wallet would post now, with a stand-in of the new payment's size.
 * While a new head re-plans the same batch, the previous estimate stays.
 */
export function useFastSendEstimate(enabled: boolean, requiredCount = 1, displayInputs?: DisplayIssuanceInputs | null): FastSendEstimate | undefined {
  const { node, status, profile, connectedAccount, snapshot, selfPublication } = useWallet();
  const [estimate, setEstimate] = useState<FastSendEstimate>();
  // The batch the shown estimate describes; heads and pending payments only refresh it.
  const planned = useRef<readonly unknown[]>(undefined);
  const pendingKey = (snapshot?.pendingContentHashes ?? []).join(",");
  useEffect(() => {
    if (!enabled || status === undefined || profile === undefined || connectedAccount === undefined || selfPublication === undefined) {
      planned.current = undefined;
      setEstimate(undefined);
      return;
    }
    const batch = [requiredCount, node, profile, connectedAccount, selfPublication, status.pcashChainId, status.genesisHash];
    const changed = planned.current === undefined || batch.some((input, index) => input !== planned.current![index]);
    if (changed) setEstimate({ state: "loading" });
    planned.current = batch;
    if (displayInputs === null) return;
    let current = true;
    void (async () => {
      const total = { state: "ready" as const, estimatedCostWei: 0n, maximumCostWei: 0n,
        collectibleOpenFee: 0n, expectedIssuance: 0n, companions: 0, ownIncluded: 0 };
      const excludeContentHashes: string[] = [];
      const stand = new Uint8Array(Number(PADDED_PRIVATE_VALUE_BYTE_SIZE)).fill(255);
      for (const batch of purchaseBatches(Array.from({ length: requiredCount }, () => stand), entry => entry.length)) {
        const plan = await planFastBatch({
          node, status, profile,
          ownPendingContentHashes: snapshot?.pendingContentHashes ?? [],
          transactionByteSize: PADDED_PRIVATE_VALUE_BYTE_SIZE * BigInt(batch.length),
          requiredTransactionCount: batch.length, excludeContentHashes,
          ...(displayInputs === undefined ? {} : { issuanceInputs: displayInputs }),
        });
        const carried = [...plan.own, ...plan.companions.transactions];
        const quote = await selfPublication.quoteBatch({ status, transactions: [...batch, ...carried] });
        excludeContentHashes.push(...carried.map(entry => transactionIdentity(entry).contentHash));
        total.estimatedCostWei += quote.estimatedCostWei;
        total.maximumCostWei += quote.maximumCostWei;
        total.collectibleOpenFee += plan.companions.collectibleOpenFee;
        total.expectedIssuance += plan.expectedIssuance;
        total.companions += carried.length;
        total.ownIncluded += plan.own.length;
      }
      return total;
    })().then(
      (value) => { if (current) setEstimate(value); },
      (cause) => { if (current) setEstimate({ state: "error", message: errorMessage(cause) }); },
    );
    return () => { current = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, requiredCount, node, status?.pcashChainId, status?.genesisHash, status?.latestBlockHash, profile, connectedAccount, selfPublication, pendingKey, displayInputs]);
  return estimate;
}
