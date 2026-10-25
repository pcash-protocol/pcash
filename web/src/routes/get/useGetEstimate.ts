import { useEffect, useState } from "react";
import type { RelayCarrierQuote } from "@pcash/sdk/relay";
import { PADDED_PRIVATE_VALUE_BYTE_SIZE } from "@pcash/sdk/wallet/actions";
import { planFastBatch, type FastBatchPlan } from "../../lib/fastBatch.ts";
import { useWallet, errorMessage } from "../../lib/WalletProvider.tsx";
import type { DisplayIssuanceInputs } from "../../lib/usePaymentIssuance.ts";

export type GetEstimate =
  | { state: "loading" }
  | { state: "empty" }
  | { state: "error"; message: string }
  | { state: "ready"; plan: FastBatchPlan; quote: RelayCarrierQuote; refreshError?: string };

/** One calldata batch, quoted with full-size placeholders before any proofs are built. */
export function useGetEstimate(count: number, enabled: boolean, inputs?: DisplayIssuanceInputs): GetEstimate {
  const { node, status, profile, selfPublication, connectedAccount, snapshot } = useWallet();
  const identity = `${status?.pcashChainId}:${status?.genesisHash}`;
  const [display, setDisplay] = useState<{ count: number; node: typeof node; identity: string; estimate: GetEstimate }>({ count, node, identity, estimate: { state: "loading" } });
  const pendingIds = snapshot?.pendingContentHashes ?? [];
  const pendingKey = pendingIds.join(",");
  useEffect(() => {
    if (!enabled || status === undefined || profile === undefined || selfPublication === undefined || connectedAccount === undefined) {
      return;
    }
    let current = true;
    setDisplay(previous => previous.count === count && previous.node === node && previous.identity === identity && previous.estimate.state === "ready" ? previous : { count, node, identity, estimate: { state: "loading" } });
    void (async (): Promise<GetEstimate> => {
      const plan = await planFastBatch({ node, status, profile,
        ownPendingContentHashes: pendingIds, transactionByteSize: PADDED_PRIVATE_VALUE_BYTE_SIZE * BigInt(count),
        requiredTransactionCount: count, companionsOptional: count > 0,
        ...(inputs === undefined ? {} : { issuanceInputs: inputs }),
      });
      const entries = [...Array.from({ length: count }, () => new Uint8Array(Number(PADDED_PRIVATE_VALUE_BYTE_SIZE)).fill(255)), ...plan.own, ...plan.companions.transactions];
      if (entries.length === 0) return { state: "empty" };
      return { state: "ready", plan, quote: await selfPublication.quoteBatch({ status, transactions: entries }) };
    })().then(value => { if (current) setDisplay({ count, node, identity, estimate: value }); }, cause => { if (current) setDisplay(previous => previous.count === count && previous.node === node && previous.identity === identity && previous.estimate.state === "ready" ? { ...previous, estimate: { ...previous.estimate, refreshError: errorMessage(cause) } } : { count, node, identity, estimate: { state: "error", message: errorMessage(cause) } }); });
    return () => { current = false; };
  }, [count, enabled, node, status?.pcashChainId, status?.genesisHash, profile, connectedAccount, selfPublication, pendingKey, inputs]);
  return display.count === count && display.node === node && display.identity === identity ? display.estimate : { state: "loading" };
}
