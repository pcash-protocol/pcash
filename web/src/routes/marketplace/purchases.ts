import { useQuery } from "@tanstack/react-query";
import type { Hex } from "viem";
import { marketplaceBuyerKey, publicationIdentity, readEscrowSpend, type StoredOffer } from "@pcash/marketplace/app";
import { useWallet } from "../../lib/WalletProvider.tsx";
import { querySession } from "../../lib/querySession.ts";

/**
 * This owner's paid purchases whose escrow this buyer's own claim spent, by
 * publication identity, with that claim's content hash. Only purchases no
 * reconciliation has recorded as claimed are read, once per wallet head, so a
 * purchase that any of its claims finished shows as complete without the
 * marketplace running. The spender counts only when it required the router's
 * carrier context for this buyer's payment.
 */
export function usePurchaseClaims(owner: bigint, offers: readonly StoredOffer[]): ReadonlyMap<string, string> {
  const { node, snapshot } = useWallet();
  const session = querySession(node);
  const head = snapshot?.syncedThrough?.pcashHash;
  const buyer = marketplaceBuyerKey(owner);
  const open = offers.flatMap((offer) => {
    const buy = offer.buys?.[buyer];
    return buy?.blockNumber !== undefined && buy.claimedAt === undefined && buy.claimAcceptedBlock === undefined ? [buy] : [];
  });
  const claims = useQuery({
    // The answer depends on whose payment each spender must match, so the buyer and each payment's commitment are part of it.
    queryKey: ["purchase-claims", session, head, buyer, open.map((buy) => `${publicationIdentity(buy.publication)}:${buy.commitment}`).join(",")],
    queryFn: async () => new Map((await Promise.all(open.map(async (buy) => {
      // A failed read leaves the purchase as it is until the next head.
      const spend = await readEscrowSpend(node, buy.publication, buy.commitment as Hex).catch(() => null);
      return spend?.ours ? [[publicationIdentity(buy.publication), spend.contentHash] as const] : [];
    }))).flat()),
    enabled: open.length > 0,
    // The same buyer's answer at the previous head stands until this head's arrives; another buyer's never does.
    placeholderData: (previous, previousQuery) => previousQuery?.queryKey[3] === buyer ? previous : undefined,
    staleTime: Infinity,
    retry: false,
  });
  return claims.data ?? new Map();
}
