import { keepPreviousData, skipToken, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { escrowCommitments, isCataloguedOffer, publicationIdentity, type OfferPublication, type StoredOffer } from "@pcash/marketplace/app";
import { useWallet } from "../../lib/WalletProvider.tsx";
import { querySession } from "../../lib/querySession.ts";

/** The transaction that took a sold listing and when it was included; empty until the node names it. */
export interface ListingSale {
  transactionId?: string;
  /** Milliseconds. */
  at?: number;
}

/** The node checks at most this many nullifiers per request. */
const NULLIFIER_BATCH = 256;

/** Each listing's escrow nullifier by publication identity. Deriving one verifies the listing's contract, and it never changes. */
const escrowNullifiers = new Map<string, string>();

function escrowNullifier(publication: OfferPublication): string {
  const identity = publicationIdentity(publication);
  let nullifier = escrowNullifiers.get(identity);
  if (nullifier === undefined) {
    nullifier = escrowCommitments(publication, publication.escrow!).nullifier;
    escrowNullifiers.set(identity, nullifier);
  }
  return nullifier;
}

/** Funded listings of this owner that have not been reclaimed: a spent escrow means a buyer took it. */
export function saleCandidates(owner: bigint, offers: readonly StoredOffer[]): OfferPublication[] {
  return offers.flatMap((offer) => BigInt(offer.pub.reclaimAuthority) === owner && offer.reclaim?.contentHash === undefined
    && (offer.publish === undefined || offer.publish.phase === "funded" || isCataloguedOffer(offer)) && offer.pub.escrow !== undefined ? [offer.pub] : []);
}

/**
 * The listings among these that a buyer took, by publication identity; a
 * listing not known to be sold is absent. A sale is final once its claim is
 * in a finalized Ethereum block. Until then each wallet head checks the
 * escrows in one read and looks up the claims of the spent ones, so a claim
 * a reorg removes stops counting as a sale.
 */
export function useListingSales(listings: readonly OfferPublication[]): ReadonlyMap<string, ListingSale> {
  const { node, snapshot, followedStatus } = useWallet();
  const session = querySession(node);
  const head = snapshot?.syncedThrough?.pcashHash;
  const queryClient = useQueryClient();
  const finalKey = (publication: OfferPublication) => ["listing-sale-final", session, publicationIdentity(publication)];
  // Written by the check below once a claim is finalized; nothing fetches them.
  const finals = useQueries({ queries: listings.map((publication) => ({ queryKey: finalKey(publication), queryFn: skipToken })) });
  const finalSale = (index: number) => finals[index]?.data as ListingSale | undefined;
  const open = listings.filter((_, index) => finalSale(index) === undefined);
  // Read before the claims, so a claim at or below it was in a finalized block when read.
  const finalizedL1 = followedStatus?.status.finalizedL1BlockNumber;
  const current = useQuery({
    queryKey: ["listing-sales", session, head, open.map(publicationIdentity).join(",")],
    queryFn: async () => {
      const sold = new Map<string, ListingSale>();
      for (let offset = 0; offset < open.length; offset += NULLIFIER_BATCH) {
        const batch = open.slice(offset, offset + NULLIFIER_BATCH);
        const flags = await node.areNullifiersSpent(batch.map(escrowNullifier));
        await Promise.all(batch.filter((_, index) => flags[index]).map(async (publication) => {
          // The spent flag decides the sale; a failed claim lookup only leaves its details for a later head.
          const claim = await node.getTransactionByNullifier(escrowNullifier(publication)).catch(() => null);
          const sale: ListingSale = claim === null ? {} : { transactionId: claim.summary.transactionId, at: Number(claim.summary.timestamp) * 1_000 };
          if (claim !== null && finalizedL1 !== undefined && claim.summary.inclusion.l1BlockNumber <= finalizedL1) queryClient.setQueryData(finalKey(publication), sale);
          sold.set(publicationIdentity(publication), sale);
        }));
      }
      return sold;
    },
    enabled: open.length > 0,
    // The previous head's answer stands until this head's arrives.
    placeholderData: keepPreviousData,
    staleTime: Infinity,
    retry: false,
  });
  return new Map(listings.flatMap((publication, index) => {
    const identity = publicationIdentity(publication);
    const sale = finalSale(index) ?? current.data?.get(identity);
    return sale === undefined ? [] : [[identity, sale] as const];
  }));
}
