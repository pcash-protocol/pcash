import { useEffect, useState } from "react";
import { marketplaceActivity, purchaseCutoff, reclaimNotBefore, type MarketplaceActivityItem, type StoredOffer } from "@pcash/marketplace/app";
import { marketplaceNeedsYou, marketplaceReclaimAvailable } from "./recoveryPresentation.ts";
import { saleCandidates, useListingSales } from "./sales.ts";

/**
 * The owner's saved trades that wait on them. Only listings past their
 * reclaim time are checked for a sale, and the list is read again when the
 * next one's reclaim opens or an unpaid purchase's buying closes.
 */
export function useMarketplaceTodos(owner: bigint | undefined, offers: readonly StoredOffer[]): MarketplaceActivityItem[] {
  const [now, setNow] = useState(Date.now);
  const nowSeconds = BigInt(Math.floor(now / 1_000));
  const listings = owner === undefined ? [] : saleCandidates(owner, offers);
  const sold = useListingSales(listings.filter((publication) => marketplaceReclaimAvailable(publication, nowSeconds)));
  const activity = owner === undefined ? [] : marketplaceActivity(offers, owner);
  const changes = [
    ...listings.map((publication) => reclaimNotBefore(BigInt(publication.terms.deadlineT))),
    ...activity.flatMap((item) => item.role === "buyer" && item.phase === "selected" ? [purchaseCutoff(BigInt(item.publication.terms.deadlineT))] : []),
  ].map((at) => at * 1_000n).filter((at) => at > BigInt(now));
  const next = changes.length === 0 ? undefined : Number(changes.reduce((first, at) => at < first ? at : first));
  useEffect(() => {
    if (next === undefined) return;
    // setTimeout holds at most about 24.8 days.
    const timer = window.setTimeout(() => setNow(Date.now()), Math.min(next - Date.now(), 2 ** 31 - 1));
    return () => window.clearTimeout(timer);
  }, [next]);
  return activity.filter((item) => marketplaceNeedsYou(item, sold, nowSeconds));
}
