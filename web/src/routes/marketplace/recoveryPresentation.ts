import {
  openForPurchase,
  publicationIdentity,
  reclaimNotBefore,
  type MarketplaceActivityItem,
  type OfferPublication,
} from "@pcash/marketplace/app";
import type { PendingTransactionState } from "../../lib/pendingTransactionState.ts";
import { listingAssetLabel } from "./listingAsset.ts";

export function marketplaceActivityStatus(item: MarketplaceActivityItem, transaction?: PendingTransactionState | "checking" | "unavailable"): string {
  if (transaction === "mempool") return "Not posted yet";
  if (transaction === "ethereum") return "Posted, waiting for inclusion";
  if (transaction === "ambiguous") return "Check submission";
  // Until the node answers, a submitted transaction is only known to be pending.
  if (transaction === "checking" || transaction === "unavailable") return "Pending";
  if (transaction === "absent") return "Needs submission";
  switch (item.phase) {
    case "recovery-unavailable": return "Waiting for escrow funding to reappear";
    case "contract-missing": return "Escrow needs contract recovery";
    case "draft": return "Needs proving";
    case "contract-submitted": return "Needs submission";
    case "funding-submitted":
    case "finalizing": return "Needs publishing";
    case "publication-failed": return item.publication.escrow ? "Needs publishing" : "Needs retry";
    case "funded": return marketplaceReclaimAvailable(item.publication) ? "Ready to reclaim"
      : openForPurchase(item.publication, BigInt(Math.floor(Date.now() / 1_000))) ? "Live" : "Buying closed";
    case "selected": return openForPurchase(item.publication, BigInt(Math.floor(Date.now() / 1_000))) ? "Needs payment" : "Buying closed";
    case "payment-ambiguous": return "Check payment";
    case "payment-pending": return "Pending";
    // Paid without an accepted claim: the claim it carried failed or is still pending.
    case "paid": return "Needs claim";
    case "claim-accepted": return "Pending";
    case "claimed": return "Complete";
    case "reclaim-prepared": return transaction === "confirmed" ? "Pending" : "Needs submission";
    case "reclaim-accepted": return "Pending";
    case "reclaim-failed": return "Needs retry";
    case "reclaimed": return "Returned";
  }
}

export type MarketplaceUiAction = "restore-contract" | "resume-purchase" | "check-payment" | "resume-publication" | "reclaim" | "refresh";

/**
 * A saved trade that waits on its owner: an unfinished listing or purchase,
 * a reclaim to finish, or a listing past its reclaim time that `sold` does
 * not name as taken by a buyer.
 */
export function marketplaceNeedsYou(
  item: MarketplaceActivityItem,
  sold: ReadonlyMap<string, unknown>,
  nowSeconds = BigInt(Math.floor(Date.now() / 1_000)),
): boolean {
  const action = marketplaceActivityAction(item, nowSeconds);
  if (action === undefined || action === "refresh") return false;
  return action !== "reclaim" || item.phase.startsWith("reclaim") || !sold.has(publicationIdentity(item.publication));
}

export function marketplaceReclaimAvailable(
  publication: OfferPublication,
  nowSeconds = BigInt(Math.floor(Date.now() / 1_000)),
): boolean {
  return nowSeconds >= reclaimNotBefore(BigInt(publication.terms.deadlineT));
}

export function marketplaceActivityAction(
  item: MarketplaceActivityItem,
  nowSeconds = BigInt(Math.floor(Date.now() / 1_000)),
): MarketplaceUiAction | undefined {
  if (item.phase === "recovery-unavailable") return "refresh";
  if (item.phase === "contract-missing") return "restore-contract";
  if (item.role === "buyer") {
    if (item.phase === "payment-ambiguous") return "check-payment";
    // A purchase whose payment was never sent cannot start once buying closes.
    if (item.phase === "selected") return openForPurchase(item.publication, nowSeconds) ? "resume-purchase" : undefined;
    if (["payment-pending", "paid"].includes(item.phase)) return "resume-purchase";
    return item.phase === "claim-accepted" ? "refresh" : undefined;
  }
  if (["reclaim-prepared", "reclaim-failed"].includes(item.phase)) return "reclaim";
  if (
    ["funded", "publication-failed"].includes(item.phase)
    && item.publication.escrow !== undefined
    && marketplaceReclaimAvailable(item.publication, nowSeconds)
  ) return "reclaim";
  if (["draft", "contract-submitted", "funding-submitted", "finalizing", "publication-failed"].includes(item.phase)) return "resume-publication";
  return item.phase === "reclaim-accepted" ? "refresh" : undefined;
}

export function marketplaceActionLabel(
  item: MarketplaceActivityItem,
  action: MarketplaceUiAction,
): string {
  if (action === "restore-contract") return "Recover escrow contract";
  if (action === "resume-purchase") return "Continue";
  if (action === "check-payment") return "Continue";
  if (action === "resume-publication") return "Continue";
  if (action === "reclaim") return `Reclaim ${listingAssetLabel(item.publication)}`;
  return "Check status";
}
