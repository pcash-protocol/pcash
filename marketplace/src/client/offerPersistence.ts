// Durable marketplace records. The node catalog supplies the current listing
// set; a host-owned transactional store retains seller publications and
// wallet-side checkpoints for in-flight actions.

import type { Hex } from "viem";
import { addressHex } from "@pcash/sdk/browser";
import { offerKey, publicationIdentity, type OfferPublication } from "./publication.ts";

/** The buyer's local record for an offer they are buying. */
export interface BuyRecord {
  /** Canonical 20-byte address of the profile that owns this workflow. */
  buyerAddress: string;
  /** Exact full publication, including the selected escrow opening. Claim material is re-derived from the profile. */
  publication: OfferPublication;
  /** Claim-key commitment the router records for this buyer's payment; the escrow spender is this purchase's claim only when it names it. */
  commitment: string;
  /** The signer was asked to send `buy`, so the payment may be live although no hash was checkpointed. */
  paymentBroadcastRequestedAt?: number;
  /** The `buy` transaction, which pays and carries the first claim. */
  txHash?: string;
  /** L1 block the payment landed in (decimal string). */
  blockNumber?: string;
  paidAt?: number;
  /**
   * Exact claim bytes, saved before the router call that carries them is signed,
   * with the snapshot anchor and the time limit they were proved for. Once the
   * escrow spender shows a claim, `claimContentHash` names that claim.
   */
  claimContentHash?: string;
  claimTransactionHex?: string;
  claimAnchorBlockNumber?: string;
  claimAnchorBlockHash?: string;
  claimNotAfter?: string;
  /** L1 block of the claim's current accepted, possibly unfinalized, inclusion. */
  claimAcceptedBlock?: string;
  /** Set only after the claim's accepted inclusion is finalized on L1. */
  claimedAt?: number;
}

export type PublishPhase = "draft" | "l2-contract-submitted" | "funding-submitted" | "finalizing" | "funded" | "failed";

export interface PublishRecord {
  submissionMode?: "fast" | "slow" | "selected";
  phase: PublishPhase;
  creationOpenFeeBaseUnits?: string;
  fundingOpenFeeBaseUnits?: string;
  privateRelayFeeBaseUnits?: string;
  l2ContractContentHash?: string;
  l2ContractTransactionHex?: string;
  l2ContractAcceptedBlock?: string;
  l2ContractAcceptedBlockHash?: string;
  l2ContractFinalizedAt?: number;
  fundingContentHash?: string;
  fundingTransactionHex?: string;
  fundingAcceptedBlock?: string;
  fundingAcceptedBlockHash?: string;
  fundingFinalizedAt?: number;
  catalogPublishedAt?: number;
  catalogPublicationId?: string;
  catalogError?: string;
  error?: string;
  updatedAt: number;
}

export type ReclaimPhase = "idle" | "prepared" | "accepted" | "finalized" | "failed";

/** Durable seller reclaim record. Browser reclaim code owns the lifecycle. */
export interface ReclaimRecord {
  submissionMode?: "fast" | "slow" | "selected";
  phase: ReclaimPhase;
  /** Exact funded publication whose escrow opening this reclaim spends. */
  publication: OfferPublication;
  contentHash?: string;
  transactionHex?: Hex;
  /** Open reclaim relayer fee in decimal PCASH base units, retained after finality. */
  openFeeBaseUnits?: string;
  privateRelayFeeBaseUnits?: string;
  acceptedBlock?: string;
  acceptedBlockHash?: string;
  finalizedAt?: number;
  error?: string;
  updatedAt: number;
}

export interface StoredOffer {
  /** A recovered escrow was funded before its contract creation landed. */
  missingContract?: boolean;
  /** The previously recovered funding is absent from the latest completed scan. */
  recoveryUnavailable?: boolean;
  key: string;
  pub: OfferPublication;
  source: "created" | "catalog" | "shared";
  savedAt: number;
  /** Independent durable purchase workflows keyed by canonical buyer address. */
  buys?: Record<string, BuyRecord>;
  publish?: PublishRecord;
  /** One durable seller reclaim journal bound to its exact funded publication. */
  reclaim?: ReclaimRecord;
}

export type PublishTxFinality =
  | { phase: "missing" | "skipped" | "conflicted" }
  | { phase: "accepted" | "finalized"; acceptedBlock: string; acceptedBlockHash: string };

/** A purchase's claim as the escrow spender shows it: absent, or included and possibly final. */
export type ClaimTxFinality =
  | { phase: "missing" }
  | { phase: "accepted" | "finalized"; contentHash: string; acceptedBlock: bigint };

export type ReclaimTxFinality =
  | { phase: "missing" | "skipped" }
  | { phase: "accepted" | "finalized"; acceptedBlock: string; acceptedBlockHash: string };

export function marketplaceBuyerKey(address: bigint): string {
  if (address <= 0n || address >= (1n << 160n)) throw new Error("marketplace buyer address must fit uint160");
  return addressHex(address);
}

function withoutClaimCheckpoint(buy: BuyRecord): BuyRecord {
  const next = { ...buy };
  delete next.claimContentHash;
  delete next.claimTransactionHex;
  delete next.claimAnchorBlockNumber;
  delete next.claimAnchorBlockHash;
  delete next.claimNotAfter;
  delete next.claimAcceptedBlock;
  delete next.claimedAt;
  return next;
}

/** Save exact claim bytes, with the snapshot anchor and time limit they were proved for, before any call carries them. */
export function checkpointPreparedClaim(
  buy: BuyRecord,
  claim: { contentHash: string; transactionHex: string; anchor: { blockNumber: bigint; blockHash: string }; notAfter: bigint },
): BuyRecord {
  return {
    ...withoutClaimCheckpoint(buy),
    claimContentHash: claim.contentHash,
    claimTransactionHex: claim.transactionHex,
    claimAnchorBlockNumber: claim.anchor.blockNumber.toString(),
    claimAnchorBlockHash: claim.anchor.blockHash,
    claimNotAfter: claim.notAfter.toString(),
  };
}

/**
 * Record the purchase's claim as the escrow spender shows it. A claim that spent
 * the escrow replaces any saved bytes; one reorged out leaves no accepted block.
 */
export function checkpointClaimFinality(
  buy: BuyRecord,
  finality: ClaimTxFinality,
  now = Date.now(),
): BuyRecord {
  if (buy.claimedAt !== undefined) return buy;
  if (finality.phase === "missing") {
    if (buy.claimAcceptedBlock === undefined) return buy;
    const next = { ...buy };
    delete next.claimAcceptedBlock;
    return next;
  }
  const acceptedBlock = finality.acceptedBlock.toString();
  if (finality.phase === "accepted" && buy.claimContentHash === finality.contentHash && buy.claimAcceptedBlock === acceptedBlock) return buy;
  return {
    ...withoutClaimCheckpoint(buy),
    claimContentHash: finality.contentHash,
    claimAcceptedBlock: acceptedBlock,
    ...(finality.phase === "finalized" ? { claimedAt: now } : {}),
  };
}

/** Bind the durable buyer journal to one canonical `buy` payment. */
export function checkpointCanonicalPayment(
  buy: BuyRecord,
  payment: { hash: string; blockNumber: bigint; paidAt: number },
): BuyRecord {
  const next = { ...buy };
  delete next.paymentBroadcastRequestedAt;
  next.txHash = payment.hash;
  next.blockNumber = payment.blockNumber.toString();
  next.paidAt = payment.paidAt;
  return next;
}

/** Atomically journal a newly broadcast `buy`, which carries the saved claim bytes, before its receipt is known. */
export function checkpointPendingPayment(buy: BuyRecord, hash: string): BuyRecord {
  const next = { ...buy };
  delete next.paymentBroadcastRequestedAt;
  next.txHash = hash;
  delete next.blockNumber;
  delete next.paidAt;
  return next;
}

/** Persist the ambiguity boundary immediately before invoking the payment signer. */
export function checkpointPaymentBroadcastRequested(buy: BuyRecord, requestedAt = Date.now()): BuyRecord {
  return { ...buy, paymentBroadcastRequestedAt: requestedAt };
}

/** Clear signer ambiguity only after a definite rejection proves no payment was broadcast. */
export function checkpointPaymentPreBroadcastRejection(buy: BuyRecord): BuyRecord {
  if (buy.paymentBroadcastRequestedAt === undefined) return buy;
  const next = { ...buy };
  delete next.paymentBroadcastRequestedAt;
  return next;
}

/** Move an unpaid buyer to a newly verified escrow variant, dropping claim bytes proved for the old one. */
export function checkpointBuyerPublication(
  buy: BuyRecord,
  publication: OfferPublication,
  commitment: string,
): BuyRecord {
  if (offerKey(buy.publication) !== offerKey(publication)) {
    throw new Error("replacement publication does not belong to the durable offer");
  }
  if (publicationIdentity(buy.publication) === publicationIdentity(publication)) return buy;
  if (
    buy.paymentBroadcastRequestedAt !== undefined
    || buy.txHash !== undefined
    || buy.blockNumber !== undefined
    || buy.paidAt !== undefined
  ) {
    throw new Error("A payment already authorizes a different escrow publication");
  }
  return { buyerAddress: buy.buyerAddress, publication, commitment };
}

/**
 * Invalidate a `buy` attempt that cannot pay, given the hashes it was sent
 * under, and make the buyer journal eligible for a deliberate new payment.
 */
export function checkpointFailedPayment(buy: BuyRecord, ...hashes: string[]): BuyRecord {
  const next = { ...buy };
  delete next.paymentBroadcastRequestedAt;
  if (next.txHash !== undefined && hashes.includes(next.txHash)) {
    delete next.txHash;
    delete next.blockNumber;
    delete next.paidAt;
  }
  return next;
}

function reconcilePublishTx(
  publish: PublishRecord,
  prefix: "l2Contract" | "funding",
  finality: PublishTxFinality | undefined,
  now: number,
): void {
  if (finality === undefined) return;
  const contentHash = `${prefix}ContentHash` as "l2ContractContentHash" | "fundingContentHash";
  const acceptedBlock = `${prefix}AcceptedBlock` as "l2ContractAcceptedBlock" | "fundingAcceptedBlock";
  const acceptedBlockHash = `${prefix}AcceptedBlockHash` as "l2ContractAcceptedBlockHash" | "fundingAcceptedBlockHash";
  const transactionHex = `${prefix}TransactionHex` as "l2ContractTransactionHex" | "fundingTransactionHex";
  const finalizedAt = `${prefix}FinalizedAt` as "l2ContractFinalizedAt" | "fundingFinalizedAt";

  if (publish[finalizedAt] !== undefined) return;
  if (!("acceptedBlock" in finality)) {
    delete publish[acceptedBlock];
    delete publish[acceptedBlockHash];
    // These bytes can never be accepted, so resuming prepares the transaction again.
    if (finality.phase === "conflicted") {
      delete publish[contentHash];
      delete publish[transactionHex];
    }
    return;
  }

  publish[acceptedBlock] = finality.acceptedBlock;
  publish[acceptedBlockHash] = finality.acceptedBlockHash;
  if (finality.phase === "finalized") {
    publish[finalizedAt] = now;
    delete publish[transactionHex];
  }
}

/**
 * Reconcile accepted publication receipts while retaining exact bytes until
 * finality, and forget a transaction whose input another transaction spent at finality.
 */
export function checkpointPublishFinality(
  publish: PublishRecord,
  finality: { l2Contract?: PublishTxFinality; funding?: PublishTxFinality },
  now = Date.now(),
): PublishRecord {
  const next = { ...publish };
  reconcilePublishTx(next, "l2Contract", finality.l2Contract, now);
  reconcilePublishTx(next, "funding", finality.funding, now);
  next.phase = next.l2ContractFinalizedAt !== undefined && next.fundingFinalizedAt !== undefined
    ? "funded"
    : next.fundingAcceptedBlock !== undefined
      ? "finalizing"
      : next.fundingContentHash !== undefined
        ? "funding-submitted"
        : next.l2ContractContentHash !== undefined
          ? "l2-contract-submitted"
          : "draft";
  if (JSON.stringify(next) === JSON.stringify(publish)) return publish;
  next.updatedAt = now;
  return next;
}

export function hasCanonicalFunding(publish: PublishRecord | undefined): boolean {
  return publish?.fundingFinalizedAt !== undefined || publish?.fundingAcceptedBlock !== undefined;
}

/**
 * The listing's exact publication is in the catalog and its funding is still
 * known, so buyers see it whether or not its transactions are final yet. A
 * funding forgotten because another transaction spent its input leaves the
 * listing to fund again.
 */
export function isCataloguedOffer(offer: StoredOffer): boolean {
  return offer.publish !== undefined && offer.publish.catalogError === undefined
    && offer.publish.fundingContentHash !== undefined
    && offer.publish.catalogPublicationId === publicationIdentity(offer.pub);
}

export function isSellerActivityOffer(offer: StoredOffer, walletAddress: bigint | undefined): boolean {
  return offer.source === "created"
    || (walletAddress !== undefined && BigInt(offer.pub.reclaimAuthority) === walletAddress);
}

/**
 * Only records the node cannot restore are persisted: the seller's own
 * listings, and any offer with wallet-side transaction state. Everything else
 * is re-fetched from the catalog on demand.
 */
export function isDurableOffer(offer: StoredOffer): boolean {
  return offer.source === "created"
    || (offer.buys !== undefined && Object.keys(offer.buys).length !== 0)
    || offer.publish !== undefined
    || offer.reclaim !== undefined;
}

/** Every exact publication needed to resume the durable seller and buyer workflows. */
export function durableOfferPublications(offer: StoredOffer): OfferPublication[] {
  const publications = [
    offer.pub,
    ...Object.values(offer.buys ?? {}).map((buy) => buy.publication),
    ...(offer.reclaim === undefined ? [] : [offer.reclaim.publication]),
  ];
  return [...new Map(publications.map((publication) => [publicationIdentity(publication), publication])).values()];
}

/** Discovery may refresh an untouched listing, but never changes the artifact behind durable local transaction state. */
export function mergeDiscoveredOffer(
  key: string,
  pub: OfferPublication,
  source: StoredOffer["source"],
  existing?: StoredOffer,
  savedAt = Date.now(),
): StoredOffer {
  const frozen = existing !== undefined && isDurableOffer(existing);
  return {
    key,
    pub: frozen ? existing.pub : pub,
    source: frozen ? existing.source : source,
    savedAt: frozen ? existing.savedAt : savedAt,
    ...(existing?.buys ? { buys: existing.buys } : {}),
    ...(existing?.publish ? { publish: existing.publish } : {}),
    ...(existing?.reclaim ? { reclaim: existing.reclaim } : {}),
  };
}

export interface MarketplaceStore {
  list(): Promise<StoredOffer[]>;
  get(key: string): Promise<StoredOffer | null>;
  put(offer: StoredOffer): Promise<void>;
  remove(key: string): Promise<void>;
  clear(): Promise<void>;
  /** Atomically replace or remove one offer from its latest durable value. */
  update(
    key: string,
    operation: (current: StoredOffer | null) => StoredOffer | null,
  ): Promise<StoredOffer | null>;
}

/** Return a prepared reclaim whose proof can no longer execute to idle so the same reclaim can be proved again. */
export function checkpointStaleReclaim(reclaim: ReclaimRecord, contentHash: string, now = Date.now()): ReclaimRecord {
  if (reclaim.contentHash !== contentHash || reclaim.finalizedAt !== undefined) return reclaim;
  return {
    phase: "idle",
    publication: reclaim.publication,
    ...(reclaim.submissionMode === undefined ? {} : { submissionMode: reclaim.submissionMode }),
    ...(reclaim.openFeeBaseUnits === undefined ? {} : { openFeeBaseUnits: reclaim.openFeeBaseUnits }),
    ...(reclaim.privateRelayFeeBaseUnits === undefined ? {} : { privateRelayFeeBaseUnits: reclaim.privateRelayFeeBaseUnits }),
    updatedAt: now,
  };
}

/** Reconcile a seller reclaim while retaining exact bytes through accepted, unfinalized inclusions. */
export function checkpointReclaimFinality(
  reclaim: ReclaimRecord,
  finality: ReclaimTxFinality,
  now = Date.now(),
): ReclaimRecord {
  if (reclaim.finalizedAt !== undefined) return reclaim;
  const next = { ...reclaim };
  if (!("acceptedBlock" in finality)) {
    delete next.acceptedBlock;
    delete next.acceptedBlockHash;
    next.phase = next.contentHash !== undefined && next.transactionHex !== undefined ? "prepared" : "idle";
  } else {
    next.acceptedBlock = finality.acceptedBlock;
    next.acceptedBlockHash = finality.acceptedBlockHash;
    next.phase = finality.phase;
    if (finality.phase === "finalized") {
      next.finalizedAt = now;
      delete next.transactionHex;
    }
  }
  if (JSON.stringify(next) === JSON.stringify(reclaim)) return reclaim;
  next.updatedAt = now;
  return next;
}
