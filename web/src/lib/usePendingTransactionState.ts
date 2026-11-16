import { useQuery } from "@tanstack/react-query";
import { useWallet } from "./WalletProvider.tsx";
import { friendlyError } from "../components/friendlyError.ts";
import { pendingTransactionState, type PendingTransactionState } from "./pendingTransactionState.ts";
import { querySession } from "./querySession.ts";

export interface PendingTransactionObservation {
  state: PendingTransactionState;
  hash?: string | undefined;
  /** Reconciling an Ethereum submission failed; the state itself was read. */
  reconcileError?: string | undefined;
}

/**
 * One shared poll per pending transaction: every view of the same contentHash reads
 * this query, so a row, its details and its Post to Ethereum control cost one request
 * set per tick. It stops once the transaction is confirmed, slows while the
 * node no longer offers it, and pauses while the tab is hidden.
 */
export function usePendingTransactionState(contentHash: string | undefined) {
  const { node, selfPublication } = useWallet();
  return useQuery<PendingTransactionObservation>({
    queryKey: ["pending-transaction", querySession(node), querySession(selfPublication), contentHash?.toLowerCase()],
    enabled: contentHash !== undefined,
    queryFn: async () => {
      const observation = await pendingTransactionState(node, selfPublication, contentHash!);
      let reconcileError: string | undefined;
      try { await observation.recovery?.reconcile(); } catch (cause) { reconcileError = friendlyError(cause); }
      return { state: observation.state, hash: observation.hash, reconcileError };
    },
    retry: false,
    refetchInterval: (query) => {
      if (query.state.status === "error") return 10_000;
      const state = query.state.data?.state;
      return state === "confirmed" ? false : state === "absent" ? 15_000 : 3_000;
    },
  });
}
