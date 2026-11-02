import { useRef, useState } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { purchaseBatches } from "@pcash/marketplace/app";
import type { MempoolItemResult, PcashNodeClient } from "@pcash/sdk/clients";
import type { L1SubmissionAdapter } from "@pcash/sdk/wallet";
import { errorMessage, useWallet } from "./WalletProvider.tsx";
import { finalizeMempoolTransaction } from "./finalizeMempoolTransaction.ts";
import { inFlightContentHashes } from "./prepareFastBatch.ts";
import { querySession } from "./querySession.ts";

export interface PostPending {
  /** This wallet's transactions waiting in the PCASH mempool for someone to post them. */
  pendingCount: number;
  /** Ethereum transactions posting all of them takes; each browser batch holds a few. */
  ethereumTransactions: number;
  busy: boolean;
  /** While posting: which Ethereum transaction is being posted, of how many. */
  progress?: { current: number; total: number };
  error?: string;
  post(): Promise<void>;
}

function batchCount(items: readonly MempoolItemResult[]): number {
  return purchaseBatches(items, (item) => Number(item.byteSize)).length;
}

/** This wallet's transactions ready in the mempool and not carried by an unsettled batch, oldest first. */
export async function unpostedTransactions(
  node: Pick<PcashNodeClient, "getMempoolTransaction">,
  submission: Pick<L1SubmissionAdapter, "l1Recovery">,
  ownPendingContentHashes: readonly string[],
): Promise<MempoolItemResult[]> {
  const inFlight = new Set(await inFlightContentHashes(submission));
  const items = await Promise.all(ownPendingContentHashes.filter((id) => !inFlight.has(id.toLowerCase()))
    .map((id) => node.getMempoolTransaction(id)));
  return items.filter((item): item is MempoolItemResult => item?.status === "ready")
    .sort((left, right) => left.receivedAtUnixMs < right.receivedAtUnixMs ? -1 : left.receivedAtUnixMs > right.receivedAtUnixMs ? 1 : 0);
}

/**
 * Posts every pending transaction of this wallet to Ethereum from the
 * connected wallet, oldest first, in as many sequential Ethereum transactions
 * as the browser batch size needs. Each batch goes through the single-transaction
 * posting path, which carries the wallet's other pending transactions after the
 * first and fills the rest with paying mempool transactions.
 */
export function usePostPending(): PostPending {
  const wallet = useWallet();
  const { node, selfPublication, snapshot } = wallet;
  const queryClient = useQueryClient();
  const ownPendingContentHashes = snapshot?.pendingContentHashes ?? [];
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ current: number; total: number }>();
  const [error, setError] = useState<string>();
  const current = useRef(wallet);
  current.current = wallet;
  const query = useQuery({
    queryKey: ["post-pending", querySession(node), querySession(selfPublication), ownPendingContentHashes.join(",")],
    enabled: selfPublication !== undefined && ownPendingContentHashes.length > 0,
    queryFn: async () => {
      const items = await unpostedTransactions(node, selfPublication!, ownPendingContentHashes);
      return { pendingCount: items.length, ethereumTransactions: batchCount(items) };
    },
    // Each snapshot changes the key; the previous counts stay until the new ones arrive.
    placeholderData: keepPreviousData,
    retry: false,
    refetchInterval: 10_000,
  });
  const counts = ownPendingContentHashes.length === 0 ? undefined : query.data;

  const post = async () => {
    const { profile, connectedAccount, readStatus } = wallet;
    if (busy) return;
    if (wallet.phase !== "ready" || profile === undefined) {
      setError("Finish setting up your wallet before posting to Ethereum.");
      return;
    }
    if (selfPublication === undefined || connectedAccount === undefined) {
      setError("Connect your Ethereum wallet to post to Ethereum.");
      return;
    }
    const assertActive = () => {
      const now = current.current;
      if (now.node !== node || now.profile?.address !== profile.address || now.selfPublication !== selfPublication || now.connectedAccount !== connectedAccount) {
        throw new Error("Your wallet changed while posting. Reconnect it and post again.");
      }
    };
    setBusy(true);
    setError(undefined);
    // A transaction posted once is not posted again by this call, even if a batch lands without it.
    const posted = new Set<string>();
    try {
      for (let done = 0; ; done += 1) {
        assertActive();
        const pending = current.current.snapshot?.pendingContentHashes ?? [];
        const unposted = (await unpostedTransactions(node, selfPublication, pending))
          .filter((item) => !posted.has(item.contentHash.toLowerCase()));
        const next = unposted[0];
        if (next === undefined) break;
        // Each Ethereum transaction is its own wallet prompt.
        setProgress({ current: done + 1, total: done + batchCount(unposted) });
        posted.add(next.contentHash.toLowerCase());
        await finalizeMempoolTransaction({ node, readStatus, submission: selfPublication, contentHash: next.contentHash,
          profile, assertActive, onL1Submitted: async () => undefined,
          ownPendingContentHashes: pending.filter((id) => !posted.has(id.toLowerCase())) });
      }
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
      setProgress(undefined);
      void queryClient.invalidateQueries({ queryKey: ["pending-transaction"] });
      void query.refetch();
    }
  };

  return {
    pendingCount: counts?.pendingCount ?? 0,
    ethereumTransactions: counts?.ethereumTransactions ?? 0,
    busy,
    ...(progress === undefined ? {} : { progress }),
    ...(error === undefined ? {} : { error }),
    post,
  };
}
