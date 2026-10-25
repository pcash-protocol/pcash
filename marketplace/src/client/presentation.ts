import {
  isCataloguedOffer,
  isSellerActivityOffer,
  marketplaceBuyerKey,
  type BuyRecord,
  type StoredOffer,
} from "./offerPersistence.ts";
import type { OfferPublication } from "./publication.ts";

export type MarketplaceActivityStatus = "action-required" | "pending" | "ready" | "complete" | "failed";

export type MarketplaceSellerPhase =
  | "recovery-unavailable"
  | "contract-missing"
  | "draft"
  | "contract-submitted"
  | "funding-submitted"
  | "finalizing"
  | "funded"
  | "publication-failed"
  | "reclaim-prepared"
  | "reclaim-accepted"
  | "reclaimed"
  | "reclaim-failed";

export type MarketplaceBuyerPhase =
  | "selected"
  | "payment-ambiguous"
  | "payment-pending"
  | "paid"
  | "claim-accepted"
  | "claimed";

export interface MarketplaceSellerState {
  role: "seller";
  phase: MarketplaceSellerPhase;
  status: MarketplaceActivityStatus;
  updatedAt: number;
  contentHash?: string;
  openFeeBaseUnits?: string;
  privateRelayFeeBaseUnits?: string;
  error?: string;
}

export interface MarketplaceBuyerState {
  role: "buyer";
  phase: MarketplaceBuyerPhase;
  status: MarketplaceActivityStatus;
  updatedAt: number;
  paymentHash?: string;
  contentHash?: string;
}

export interface MarketplaceActivityItem {
  key: string;
  offerKey: string;
  publication: OfferPublication;
  role: "seller" | "buyer";
  phase: MarketplaceSellerPhase | MarketplaceBuyerPhase;
  status: MarketplaceActivityStatus;
  updatedAt: number;
  paymentHash?: string;
  contentHash?: string;
  openFeeBaseUnits?: string;
  privateRelayFeeBaseUnits?: string;
  error?: string;
}

function buyerState(buy: BuyRecord, savedAt: number): MarketplaceBuyerState {
  const paymentHash = buy.txHash === undefined ? {} : { paymentHash: buy.txHash };
  const contentHash = buy.claimContentHash === undefined ? {} : { contentHash: buy.claimContentHash };
  if (buy.claimedAt !== undefined) {
    return { role: "buyer", phase: "claimed", status: "complete", updatedAt: buy.claimedAt, ...paymentHash, ...contentHash };
  }
  if (buy.claimAcceptedBlock !== undefined) {
    return { role: "buyer", phase: "claim-accepted", status: "pending", updatedAt: buy.paidAt ?? savedAt, ...paymentHash, ...contentHash };
  }
  // Paid with no accepted claim: the carried claim is still being derived, or it failed and needs `retry`.
  if (buy.blockNumber !== undefined) {
    return { role: "buyer", phase: "paid", status: "action-required", updatedAt: buy.paidAt ?? savedAt, ...paymentHash };
  }
  if (buy.txHash !== undefined) {
    return { role: "buyer", phase: "payment-pending", status: "pending", updatedAt: savedAt, ...paymentHash };
  }
  if (buy.paymentBroadcastRequestedAt !== undefined) {
    return { role: "buyer", phase: "payment-ambiguous", status: "action-required", updatedAt: buy.paymentBroadcastRequestedAt };
  }
  return { role: "buyer", phase: "selected", status: "action-required", updatedAt: savedAt };
}

/** Present one connected buyer's resumable state for an offer. */
export function marketplaceBuyerState(
  offer: StoredOffer,
  walletAddress: bigint | undefined,
): MarketplaceBuyerState | null {
  if (walletAddress === undefined) return null;
  const buy = offer.buys?.[marketplaceBuyerKey(walletAddress)];
  return buy === undefined ? null : buyerState(buy, offer.savedAt);
}

/** Present the connected seller's publication or reclaim state for an offer. */
export function marketplaceSellerState(
  offer: StoredOffer,
  walletAddress: bigint | undefined,
): MarketplaceSellerState | null {
  if (walletAddress === undefined) {
    if (!isSellerActivityOffer(offer, undefined)) return null;
  } else if (BigInt(offer.pub.reclaimAuthority) !== walletAddress) {
    return null;
  }
  if (offer.recoveryUnavailable) return { role: "seller", phase: "recovery-unavailable", status: "pending", updatedAt: offer.savedAt };
  if (offer.missingContract) return { role: "seller", phase: "contract-missing", status: "action-required", updatedAt: offer.savedAt };
  const reclaim = offer.reclaim;
  if (reclaim !== undefined) {
    if (reclaim.phase === "finalized") {
      return {
        role: "seller",
        phase: "reclaimed",
        status: "complete",
        updatedAt: reclaim.finalizedAt ?? reclaim.updatedAt,
        ...(reclaim.contentHash === undefined ? {} : { contentHash: reclaim.contentHash }),
        ...(reclaim.openFeeBaseUnits === undefined ? {} : { openFeeBaseUnits: reclaim.openFeeBaseUnits }),
        ...(reclaim.privateRelayFeeBaseUnits === undefined ? {} : { privateRelayFeeBaseUnits: reclaim.privateRelayFeeBaseUnits }),
      };
    }
    if (reclaim.phase === "accepted") {
      return {
        role: "seller",
        phase: "reclaim-accepted",
        status: "pending",
        updatedAt: reclaim.updatedAt,
        ...(reclaim.contentHash === undefined ? {} : { contentHash: reclaim.contentHash }),
        ...(reclaim.openFeeBaseUnits === undefined ? {} : { openFeeBaseUnits: reclaim.openFeeBaseUnits }),
        ...(reclaim.privateRelayFeeBaseUnits === undefined ? {} : { privateRelayFeeBaseUnits: reclaim.privateRelayFeeBaseUnits }),
      };
    }
    if (reclaim.phase === "prepared") {
      return {
        role: "seller",
        phase: "reclaim-prepared",
        status: "action-required",
        updatedAt: reclaim.updatedAt,
        ...(reclaim.contentHash === undefined ? {} : { contentHash: reclaim.contentHash }),
        ...(reclaim.openFeeBaseUnits === undefined ? {} : { openFeeBaseUnits: reclaim.openFeeBaseUnits }),
        ...(reclaim.privateRelayFeeBaseUnits === undefined ? {} : { privateRelayFeeBaseUnits: reclaim.privateRelayFeeBaseUnits }),
      };
    }
    if (reclaim.phase === "failed") {
      return {
        role: "seller",
        phase: "reclaim-failed",
        status: "failed",
        updatedAt: reclaim.updatedAt,
        ...(reclaim.contentHash === undefined ? {} : { contentHash: reclaim.contentHash }),
        ...(reclaim.openFeeBaseUnits === undefined ? {} : { openFeeBaseUnits: reclaim.openFeeBaseUnits }),
        ...(reclaim.privateRelayFeeBaseUnits === undefined ? {} : { privateRelayFeeBaseUnits: reclaim.privateRelayFeeBaseUnits }),
        ...(reclaim.error === undefined ? {} : { error: reclaim.error }),
      };
    }
  }

  const publish = offer.publish;
  const catalogued = isCataloguedOffer(offer);
  if (publish?.phase === "funded" && !catalogued) {
    return {
      role: "seller",
      phase: "publication-failed",
      status: "action-required",
      updatedAt: publish.updatedAt,
      ...(publish.fundingContentHash ?? publish.l2ContractContentHash
        ? { contentHash: publish.fundingContentHash ?? publish.l2ContractContentHash }
        : {}),
      ...(publish.catalogError === undefined
        ? { error: "Funded offer has not been published to the catalog" }
        : { error: publish.catalogError }),
    };
  }
  if (publish?.phase === "failed") {
    return {
      role: "seller",
      phase: "publication-failed",
      status: "failed",
      updatedAt: publish.updatedAt,
      ...(publish.fundingContentHash ?? publish.l2ContractContentHash
        ? { contentHash: publish.fundingContentHash ?? publish.l2ContractContentHash }
        : {}),
      ...(publish.error === undefined ? {} : { error: publish.error }),
    };
  }
  // A catalogued listing is live while its transactions finalize.
  const phase: MarketplaceSellerPhase = catalogued ? "funded" : publish?.phase === "l2-contract-submitted"
    ? "contract-submitted"
    : publish?.phase === "funding-submitted"
      ? "funding-submitted"
      : publish?.phase === "finalizing"
        ? "finalizing"
        : publish?.phase === "funded" || (publish === undefined && offer.pub.escrow !== undefined)
          ? "funded"
          : "draft";
  const status: MarketplaceActivityStatus = phase === "funded"
    ? "ready"
    : phase === "draft"
      ? "action-required"
      : "pending";
  return {
    role: "seller",
    phase,
    status,
    updatedAt: publish?.updatedAt ?? offer.savedAt,
    ...(publish?.fundingContentHash ?? publish?.l2ContractContentHash
      ? { contentHash: publish?.fundingContentHash ?? publish?.l2ContractContentHash }
      : {}),
    ...(publish?.catalogError === undefined ? {} : { error: publish.catalogError }),
  };
}

/** Flatten durable seller and connected-buyer workflows into stable activity rows. */
export function marketplaceActivity(
  offers: readonly StoredOffer[],
  walletAddress: bigint | undefined,
): MarketplaceActivityItem[] {
  const rows: MarketplaceActivityItem[] = [];
  for (const offer of offers) {
    const seller = marketplaceSellerState(offer, walletAddress);
    if (seller !== null) rows.push({
      key: `${offer.key}:seller`,
      offerKey: offer.key,
      publication: offer.reclaim?.publication ?? offer.pub,
      ...seller,
    });
    const buyer = marketplaceBuyerState(offer, walletAddress);
    if (buyer !== null) rows.push({
      key: `${offer.key}:buyer:${marketplaceBuyerKey(walletAddress!)}`,
      offerKey: offer.key,
      publication: offer.buys![marketplaceBuyerKey(walletAddress!)]!.publication,
      ...buyer,
    });
  }
  return rows.sort((left, right) => right.updatedAt - left.updatedAt || left.key.localeCompare(right.key));
}
