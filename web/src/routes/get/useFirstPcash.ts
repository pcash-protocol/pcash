import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useWallet } from "../../lib/WalletProvider.tsx";
import { resolveEarnLanding } from "../wallet/earnOutcome.ts";

export interface FirstPcash {
  /** What the setup's mine paid this wallet; undefined until its receipt is indexed. */
  amount?: bigint;
  l1TransactionHash?: string;
}

const ONE_READ = { indexAttempts: 1, intervalMs: 0, sleep: async () => undefined };
const READ_INTERVAL_MS = 6_000;
/** Reads before the page stops waiting for the receipt: about two minutes. */
const MAX_READS = 20;

/**
 * The account setup this page saw in progress and, once the account is ready,
 * what its mine paid. Undefined when this page saw no setup, when the setup
 * paid this wallet nothing, or when its receipt did not arrive.
 */
export function useFirstPcash(enabled: boolean): FirstPcash | undefined {
  const { activationContentHash, node, profile } = useWallet();
  // The wallet forgets the setup's hash when the account is ready, so the page keeps it.
  const [watched, setWatched] = useState<string>();
  useEffect(() => { if (activationContentHash !== undefined) setWatched(activationContentHash); }, [activationContentHash]);
  const reads = useRef(0);
  const receipt = useQuery({
    queryKey: ["first-pcash", watched],
    enabled: enabled && watched !== undefined && profile !== undefined,
    retry: false,
    queryFn: async (): Promise<FirstPcash | "pending" | "none"> => {
      const pending = () => (reads.current += 1) < MAX_READS ? "pending" as const : "none" as const;
      const reading = await resolveEarnLanding(node, watched!, profile!, ONE_READ);
      if (reading.kind !== "landed") return pending();
      const { payout, outcome, l1TransactionHash } = reading.landing;
      if (outcome !== "succeeded") return "none";
      if (payout === null) return pending();
      // A payout of nothing has no record to say whose it is.
      if (payout.issuanceAmount + payout.openFeeAmount === 0n || payout.yours === false) return "none";
      if (payout.yours === null) return pending();
      return { amount: payout.issuanceAmount + payout.openFeeAmount, ...(l1TransactionHash === undefined ? {} : { l1TransactionHash }) };
    },
    // The receipt can trail the account by an index update.
    refetchInterval: (query) => query.state.data === "pending" ? READ_INTERVAL_MS : false,
  });
  const data = receipt.data;
  if (!enabled || watched === undefined || receipt.isError || data === "none") return undefined;
  return data === undefined || data === "pending" ? {} : data;
}
