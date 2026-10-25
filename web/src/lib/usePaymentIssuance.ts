import { useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { BlockEconomicsPageResult, IssuanceQuoteResult } from "@pcash/sdk/clients";
import { nextBlockIssuanceQuote, recentBlockEconomics } from "@pcash/sdk/relay";
import { paymentIssuanceFromInputs } from "@pcash/sdk/wallet/actions";
import { useWallet } from "./WalletProvider.tsx";
import { querySession } from "./querySession.ts";

export interface DisplayIssuanceInputs {
  quote: PromiseSettledResult<IssuanceQuoteResult | null>;
  economics: PromiseSettledResult<BlockEconomicsPageResult>;
}

/** Displayed issuance refreshes on this cadence, not every block, so fee fields do not blank and redraw. */
export const ISSUANCE_DISPLAY_REFRESH_MS = 36_000;

/**
 * The expected per-action issuance and the quote/history pair behind it, shared
 * by every view on the network. A failed read keeps that input's last value.
 */
export function usePaymentIssuance(enabled: boolean) {
  const { node, status } = useWallet();
  const latest = useRef(status);
  latest.current = status;
  const queryClient = useQueryClient();
  const queryKey = ["payment-issuance", querySession(node), status === undefined ? undefined : `${status.pcashChainId}:${status.genesisHash}`];
  const query = useQuery({
    queryKey,
    queryFn: async (): Promise<DisplayIssuanceInputs> => {
      const head = latest.current!;
      const [quote, economics] = await Promise.allSettled([nextBlockIssuanceQuote(node, head), recentBlockEconomics(node, head.latestBlock)]);
      const prior = queryClient.getQueryData<DisplayIssuanceInputs>(queryKey);
      return {
        quote: quote.status === "fulfilled" ? quote : prior?.quote ?? quote,
        economics: economics.status === "fulfilled" ? economics : prior?.economics ?? economics,
      };
    },
    enabled: enabled && status !== undefined,
    retry: false,
    staleTime: ISSUANCE_DISPLAY_REFRESH_MS,
    refetchInterval: ISSUANCE_DISPLAY_REFRESH_MS,
  });
  const inputs = enabled ? query.data : undefined;
  const issuance = inputs?.quote.status === "fulfilled" && inputs.economics.status === "fulfilled"
    ? paymentIssuanceFromInputs(inputs.quote.value, inputs.economics.value) : undefined;
  return { issuance, inputs };
}
