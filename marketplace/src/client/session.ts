import { recoverSellerOffers } from "./sellerRecovery.ts";
import { recoverPaymentPublication, savedPaymentIdentity, scanPayerPayments, scannedPaymentIdentity } from "./paymentRecovery.ts";
import { runSponsoredContractCreationFlow } from "./contractCreation.ts";
import { loadSelfReceiveKey, loadSelfReceiveKeyAtSnapshot } from "@pcash/sdk/wallet/actions";
import { createMarketplaceTransactionSubmitter } from "./submitBuiltTransaction.ts";
import {
  getAddress,
  type Address,
  type Hex,
} from "viem";
import type { PcashNodeClient, StatusResult } from "@pcash/sdk/browser";
import type { ProvePhase, ProveStatus } from "@pcash/sdk/browser-prover";
import { networkConfigFromStatus } from "@pcash/sdk/protocol";
import type { SelectedRelayHttpClient } from "@pcash/sdk/relay";
import { randomFieldEntropy } from "@pcash/sdk/utils";
import {
  walletAction,
  type DurableSubmissionAdapter,
  type SpendableWalletExecutionContext,
  type Wallet,
  type WalletExecutionContext,
} from "@pcash/sdk/wallet";
import {
  MIN_CLAIM_WINDOW_SECONDS,
  CLAIM_APPLICATION_VK_HASH,
  RECLAIM_APPLICATION_VK_HASH,
} from "../commitments.mts";
import {
  createOffer,
  type Offer,
} from "../offer.mts";
import {
  awaitPayResult,
  buildBuyCall,
  buildRetryCall,
  buyNotAfter,
  checkPaymentBalance,
  claimBatchStandIn,
  estimateRouterCallsGas,
  isPaymentConfirmationPending,
  MAX_PAYMENT_ANCHOR_AGE_BLOCKS,
  PaymentTransactionCancelledError,
  PaymentTransactionRevertedError,
  paymentL1Timestamp,
  purchaseCommitment,
  recoverPayResult,
  sendRouterCall,
  type BuyCall,
  type PayResult,
  type PaymentBroadcastCallbacks,
  type RecoveredPayResult,
  type RouterCall,
} from "./buy.ts";
import {
  awaitRecordOrAbsence,
  checkCarriedClaim,
  claimBatch,
  ClaimCheckError,
  claimNotAfter,
  proveCarriedClaim,
  readClaimSnapshot,
  readEscrowSpend,
  readPurchaseClaimFinality,
  RecordUnsettledError,
  type ClaimSnapshot,
  type EscrowSpend,
  type MarketplaceProver,
  type ProvedClaim,
} from "./claimFlow.ts";
import { isStaleTransactionAnchorError } from "./mempoolSubmission.ts";
import { fetchCatalogOffers, publishCatalogOffer } from "./catalog.ts";
import type { L1Signer } from "./l1Signer.ts";
import {
  InMemoryMarketplaceOperationLock,
  marketplaceBuyerOperationKey,
  marketplaceSellerPublicationOperationKey,
  marketplaceSellerReclaimOperationKey,
  type MarketplaceOperationLock,
} from "./operationLock.ts";
import {
  checkpointBuyerPublication,
  checkpointCanonicalPayment,
  checkpointClaimFinality,
  checkpointFailedPayment,
  checkpointPaymentBroadcastRequested,
  checkpointPaymentPreBroadcastRejection,
  checkpointPendingPayment,
  checkpointPreparedClaim,
  checkpointPublishFinality,
  checkpointReclaimFinality,
  checkpointStaleReclaim,
  hasCanonicalFunding,
  mergeDiscoveredOffer,
  type BuyRecord,
  type MarketplaceStore,
  type PublishRecord,
  type PublishTxFinality,
  type ReclaimRecord,
  type ReclaimTxFinality,
  type StoredOffer,
} from "./offerPersistence.ts";
import {
  offerKey,
  publicationIdentity,
  publicationFromOffer,
  publicationAssetDefinition,
  publicationContractAddress,
  reconstructOfferFromPublication,
  type OfferPublication,
} from "./publication.ts";
import {
  publishOffer,
  readOfferPublicationFinality,
  type PublishOfferCheckpoint,
  type PublishOfferParams,
  type PublishOfferResume,
} from "./publishOffer.ts";
import {
  readMarketplaceReclaimFinality,
  reclaimMarketplaceOffer,
  resumeMarketplaceReclaim,
} from "./reclaimFlow.ts";
import { defaultMarketplaceProver } from "./prover.ts";
import { verifyOfferForPayment, type OfferVerification, type PaymentAnchor } from "./verification.ts";
import { PURCHASE_MARGIN_SECONDS, openForPurchase, readEscrowReclaim } from "./offerAvailability.ts";
import {
  assertPaymentRouterDeployment,
  selectedL1Client,
  type VerifiedPaymentRouterDeployment,
} from "./paymentRouter.ts";

export interface MarketplaceIdentity {
  wallet: Wallet;
  l1Signer: L1Signer;
}

export interface MarketplaceControllerOptions {
  node: PcashNodeClient;
  store: MarketplaceStore;
  l1RpcUrls: readonly string[];
  configuredRouter?: MarketplaceConfiguredRouter;
  identity?: MarketplaceIdentity;
  prover?: () => Promise<MarketplaceProver>;
  onProgress?: (status: MarketplaceProgress) => void;
  now?: () => number;
  entropy?: () => bigint;
  operationLock?: MarketplaceOperationLock;
}

export interface MarketplaceConfiguredRouter {
  address: Address;
}

export type MarketplaceProgressAction = "refresh" | "verify" | "buy" | "publish" | "reclaim";

export interface MarketplaceProgress extends ProveStatus {
  action: MarketplaceProgressAction;
  publication?: { step: "contract" | "funding" | "catalog"; contentHash?: string; offerAddress?: string };
}

export interface MarketplaceRefreshResult {
  localOffers: StoredOffer[];
  catalogOffers: OfferPublication[];
  catalogError?: string;
  recoveryErrors?: string[];
}

export interface MarketplaceBuyResult {
  paymentHash: Hex;
  claimContentHash: string;
}

export interface MarketplaceBatchPurchase extends MarketplaceBuyResult {
  publication: OfferPublication;
}

/** What paying the selected listings costs once each has been verified safe to pay. */
export interface MarketplacePurchaseCheck {
  paymentWei: bigint;
  websiteFeeWei: bigint;
}

export interface MarketplacePurchaseQuote extends MarketplacePurchaseCheck {
  estimatedGasWei: bigint;
  maximumGasWei: bigint;
}

export interface MarketplaceCreateOfferInput {
  /** 0 lists native PCASH; a token listing carries its asset definition bytes. */
  assetId: bigint;
  assetDefinition?: Uint8Array;
  amount: bigint;
  ethPriceWei: bigint;
  /** How long the listing stays open for new purchases; T follows by the claim window plus the purchase margin. */
  purchaseMinutes: bigint;
  /** Open PCASH fee for the relayer that includes the listing's contract creation. */
  creationOpenFeeAmount: bigint;
  /** Open PCASH fee for the relayer that includes the listing's escrow funding. */
  fundingOpenFeeAmount: bigint;
}

export interface MarketplacePublishResult {
  offer: Offer;
  publication: OfferPublication;
  catalogPublished: boolean;
  catalogError?: string;
}

export interface MarketplaceActionOptions {
  submission?: DurableSubmissionAdapter;
  selectedRelaySession?: SelectedRelayHttpClient;
  privateRelayFeeAmount?: bigint;
  assertActive?: () => void;
}

/** A purchase carries its claim in the buyer's own router call, so it takes no publication options. */
export type MarketplaceBuyOptions = Pick<MarketplaceActionOptions, "assertActive">;

/** Claim bytes, the snapshot anchor a `buy` names for them, and the latest time a call can carry them. */
interface ReadyClaim extends ProvedClaim {
  anchor: PaymentAnchor;
  notAfter: bigint;
}

/** The saved claim bytes, if any. The node's dry run decides whether they can still be carried. */
function savedClaim(buy: BuyRecord | undefined): ReadyClaim | null {
  if (
    buy?.claimContentHash === undefined
    || buy.claimTransactionHex === undefined
    || buy.claimAnchorBlockNumber === undefined
    || buy.claimAnchorBlockHash === undefined
    || buy.claimNotAfter === undefined
  ) return null;
  return {
    contentHash: buy.claimContentHash as Hex,
    transactionHex: buy.claimTransactionHex as Hex,
    anchor: { blockNumber: BigInt(buy.claimAnchorBlockNumber), blockHash: buy.claimAnchorBlockHash as Hex },
    notAfter: BigInt(buy.claimNotAfter),
  };
}

/**
 * Saved claim bytes are reused only with this much room left under their
 * limits: time for the buyer to approve the call, and blocks for a `buy` to land.
 */
const SAVED_CLAIM_MARGIN_SECONDS = 600n;
const SAVED_CLAIM_MARGIN_BLOCKS = 32n;

export interface MarketplacePublicationOptions extends MarketplaceActionOptions {
  relay?: (contentHash: string) => Promise<void>;
}

function requireSpendableWallet(
  context: WalletExecutionContext,
): asserts context is SpendableWalletExecutionContext {
  if (!context.spendable()) {
    throw new Error("Marketplace requires a spendable PCASH wallet");
  }
}

const PROCESS_MARKETPLACE_OPERATION_LOCK = new InMemoryMarketplaceOperationLock();

export function assertRecoverablePublicationVerified(verification: OfferVerification): void {
  if (
    verification.l2ContractVerification !== "verified"
    || !verification.functionsBound
    || !verification.chainMatches
    || !verification.routerPinned
    || verification.liveOnNode !== true
    || verification.escrow !== "escrowed"
  ) {
    throw new Error(`The selected publication variant is not a live funded offer: ${verification.checks.join("; ")}`);
  }
}

/** No new payment is sent while an earlier `buy` attempt with no receipt can still land. */
const PENDING_PAYMENT = "Another payment is not sent until this attempt's time limit has passed on Ethereum; Continue after that.";

/**
 * The canonical payment behind a saved `buy` record, or null when it has none
 * and a `buy` may be sent. A `buy` attempt with no receipt, because the signer
 * was asked or its hash has not landed, is pending until the Ethereum head is
 * past its `notAfter`; the router's record at that head then decides. A second
 * `buy` could not pay anyway, since the router records one payment per listing,
 * so this only keeps a reload from prompting a payment that will revert.
 */
export async function resolveCheckpointedPayment(params: {
  buy: BuyRecord | undefined;
  awaitPending: (hash: Hex) => Promise<PayResult>;
  recoverCanonical: (minimumObservedBlock?: bigint, hash?: Hex) => Promise<RecoveredPayResult | null>;
  /** The Ethereum head once it is past the saved attempt's `notAfter`, or undefined before then. */
  headPastAttempt: () => Promise<bigint | undefined>;
}): Promise<{ payment: RecoveredPayResult | null; failedHashes?: Hex[] }> {
  const { buy } = params;
  const txHash = buy?.txHash as Hex | undefined;
  if (buy?.paymentBroadcastRequestedAt === undefined && !isPaymentConfirmationPending(buy)) {
    const payment = await params.recoverCanonical(
      buy?.blockNumber === undefined ? undefined : BigInt(buy.blockNumber),
      txHash,
    );
    if (payment === null && txHash !== undefined && buy?.blockNumber !== undefined) {
      return { payment: null, failedHashes: [txHash] };
    }
    return { payment };
  }
  const head = await params.headPastAttempt();
  if (head !== undefined) {
    const payment = await params.recoverCanonical(head);
    return payment === null ? { payment: null, failedHashes: txHash === undefined ? [] : [txHash] } : { payment };
  }
  if (txHash === undefined) {
    throw new Error(`The wallet was asked to send this payment, and no payment is visible yet. ${PENDING_PAYMENT}`);
  }
  let pending: PayResult;
  try {
    pending = await params.awaitPending(txHash);
  } catch (cause) {
    // A cancelled or reverted `buy` paid nothing, and a revert may be an earlier attempt's payment.
    if (cause instanceof PaymentTransactionCancelledError) {
      return { payment: await params.recoverCanonical(cause.blockNumber), failedHashes: [cause.originalHash, cause.replacementHash] };
    }
    if (cause instanceof PaymentTransactionRevertedError) {
      return { payment: await params.recoverCanonical(cause.blockNumber), failedHashes: [txHash] };
    }
    throw new Error(`Payment ${txHash} has not landed yet. ${PENDING_PAYMENT}`, { cause });
  }
  const canonical = await params.recoverCanonical(pending.blockNumber, pending.hash);
  if (canonical !== null) return { payment: canonical };
  if (pending.replacementReason === "replaced") {
    return {
      payment: null,
      failedHashes: [...new Set([pending.originalHash ?? txHash, pending.hash])],
    };
  }
  throw new Error("The checkpointed payment receipt is not the canonical router payment; retry recovery before paying again");
}

export async function resolveSubmittedPayment(params: {
  submitted: PayResult;
  recoverCanonical: (minimumObservedBlock?: bigint, hash?: Hex) => Promise<RecoveredPayResult | null>;
}): Promise<{ payment: PayResult | RecoveredPayResult | null; failedHashes?: Hex[] }> {
  if (params.submitted.replacementReason !== "replaced") return { payment: params.submitted };
  const canonical = await params.recoverCanonical(params.submitted.blockNumber, params.submitted.hash);
  if (canonical !== null) return { payment: canonical };
  return {
    payment: null,
    failedHashes: [...new Set([
      params.submitted.originalHash ?? params.submitted.hash,
      params.submitted.hash,
    ])],
  };
}

export async function persistFundedPublication(params: {
  store: MarketplaceStore;
  key: string;
  draft: StoredOffer;
  publication: OfferPublication;
  now: () => number;
  publishCatalog: () => Promise<void>;
}): Promise<{ catalogPublished: boolean; catalogError?: string }> {
  const exactPublicationId = publicationIdentity(params.publication);
  const funded = await params.store.update(params.key, (current) => {
    const latest = current ?? params.draft;
    const publish = {
      ...(latest.publish ?? params.draft.publish!),
      phase: latest.publish?.phase === "funded" ? "funded" as const : "finalizing" as const,
      updatedAt: params.now(),
    };
    if (publish.catalogPublicationId !== exactPublicationId) {
      delete publish.catalogPublishedAt;
      delete publish.catalogPublicationId;
    }
    delete publish.catalogError;
    return {
      ...latest,
      pub: params.publication,
      publish,
    };
  });
  if (funded === null) throw new Error("funded Marketplace publication disappeared during checkpointing");
  try {
    await params.publishCatalog();
    await params.store.update(params.key, (current) => {
      const next = current ?? funded;
      if (publicationIdentity(next.pub) !== exactPublicationId) return next;
      const publish = {
        ...next.publish!,
        catalogPublishedAt: params.now(),
        catalogPublicationId: exactPublicationId,
        updatedAt: params.now(),
      };
      delete publish.catalogError;
      return { ...next, pub: params.publication, publish };
    });
    return { catalogPublished: true };
  } catch (cause) {
    const catalogError = cause instanceof Error ? cause.message : String(cause);
    await params.store.update(params.key, (current) => {
      const next = current ?? funded;
      if (publicationIdentity(next.pub) !== exactPublicationId) return next;
      return {
        ...next,
        pub: params.publication,
        publish: { ...next.publish!, catalogError, updatedAt: params.now() },
      };
    });
    return { catalogPublished: false, catalogError };
  }
}

function offerState(publication: OfferPublication, current: StoredOffer | null): StoredOffer {
  return current ?? mergeDiscoveredOffer(offerKey(publication), publication, "catalog");
}

function publishPhase(publish: Pick<
  PublishRecord,
  "l2ContractContentHash" | "fundingContentHash" | "fundingAcceptedBlock" | "l2ContractFinalizedAt" | "fundingFinalizedAt"
>): PublishRecord["phase"] {
  if (publish.l2ContractFinalizedAt !== undefined && publish.fundingFinalizedAt !== undefined) return "funded";
  if (publish.fundingAcceptedBlock !== undefined) return "finalizing";
  if (publish.fundingContentHash !== undefined) return "funding-submitted";
  return "l2-contract-submitted";
}

export function applyPublishCheckpoint(
  current: StoredOffer,
  checkpoint: PublishOfferCheckpoint,
  now: number,
): StoredOffer {
  const prior = current.publish ?? { phase: "draft" as const, updatedAt: now };
  const publish: PublishRecord = {
    ...prior,
    ...checkpoint,
    updatedAt: now,
  };
  if (prior.l2ContractFinalizedAt !== undefined) {
    publish.l2ContractContentHash = prior.l2ContractContentHash;
    publish.l2ContractAcceptedBlock = prior.l2ContractAcceptedBlock;
    publish.l2ContractAcceptedBlockHash = prior.l2ContractAcceptedBlockHash;
    publish.l2ContractFinalizedAt = prior.l2ContractFinalizedAt;
    delete publish.l2ContractTransactionHex;
  }
  if (prior.fundingFinalizedAt !== undefined) {
    publish.fundingContentHash = prior.fundingContentHash;
    publish.fundingAcceptedBlock = prior.fundingAcceptedBlock;
    publish.fundingAcceptedBlockHash = prior.fundingAcceptedBlockHash;
    publish.fundingFinalizedAt = prior.fundingFinalizedAt;
    delete publish.fundingTransactionHex;
  }
  publish.phase = publishPhase(publish);
  return {
    ...current,
    publish,
  };
}

function publicationFinality(
  value: Awaited<ReturnType<typeof readOfferPublicationFinality>> | undefined,
): PublishTxFinality | undefined {
  if (value === undefined) return undefined;
  if (!("receipt" in value)) return { phase: value.phase };
  return {
    phase: value.phase,
    acceptedBlock: value.receipt.inclusion.l1BlockNumber.toString(),
    acceptedBlockHash: value.receipt.inclusion.l1BlockHash,
  };
}

function reclaimFinality(
  value: Awaited<ReturnType<typeof readMarketplaceReclaimFinality>>,
): ReclaimTxFinality {
  if (!("receipt" in value)) return { phase: value.phase };
  return {
    phase: value.phase,
    acceptedBlock: value.receipt.inclusion.l1BlockNumber.toString(),
    acceptedBlockHash: value.receipt.inclusion.l1BlockHash,
  };
}

export class MarketplaceController {
  private readonly node: PcashNodeClient;
  private readonly store: MarketplaceStore;
  private readonly l1RpcUrls: readonly string[];
  private readonly configuredRouter: MarketplaceConfiguredRouter | undefined;
  private readonly identity: MarketplaceIdentity | undefined;
  private readonly getProver: () => Promise<MarketplaceProver>;
  private readonly onProgress: ((status: MarketplaceProgress) => void) | undefined;
  private readonly now: () => number;
  private readonly entropy: () => bigint;
  private readonly operationLock: MarketplaceOperationLock;
  private refreshing: Promise<MarketplaceRefreshResult> | undefined;
  /** How often a purchase re-reads its escrow spender while the node has not yet settled whether a claim landed. */
  private claimPollIntervalMs = 3_000;

  constructor(options: MarketplaceControllerOptions) {
    this.node = options.node;
    this.store = options.store;
    this.l1RpcUrls = options.l1RpcUrls;
    this.configuredRouter = options.configuredRouter === undefined
      ? undefined
      : { address: getAddress(options.configuredRouter.address) };
    this.identity = options.identity;
    this.getProver = options.prover ?? (() => defaultMarketplaceProver(this.node));
    this.onProgress = options.onProgress;
    this.now = options.now ?? Date.now;
    this.entropy = options.entropy ?? randomFieldEntropy;
    this.operationLock = options.operationLock ?? PROCESS_MARKETPLACE_OPERATION_LOCK;
  }

  private report(action: MarketplaceProgressAction, status: ProveStatus): void {
    this.onProgress?.({ action, ...status });
  }

  private progress(action: MarketplaceProgressAction): (status: ProveStatus) => void {
    return (status) => this.report(action, status);
  }

  private configuredRouterRequired(): MarketplaceConfiguredRouter {
    if (this.configuredRouter === undefined) {
      throw new Error("A Marketplace PaymentRouter address is required");
    }
    return this.configuredRouter;
  }

  private requireIdentity(): MarketplaceIdentity {
    if (this.identity === undefined) throw new Error("Connect the PCASH wallet before changing Marketplace state");
    return this.identity;
  }

  private buyerAddress(): string {
    return this.requireIdentity().wallet.address;
  }

  private buyerAccount(offer: StoredOffer | null): BuyRecord | undefined {
    return offer?.buys?.[this.buyerAddress()];
  }

  private async migrateBuyerPublication(publication: OfferPublication, commitment: Hex): Promise<void> {
    const key = offerKey(publication);
    const buyerAddress = this.buyerAddress();
    await this.store.update(key, (current) => {
      if (current === null) return null;
      const buy = current.buys?.[buyerAddress];
      if (buy === undefined) return current;
      const migrated = checkpointBuyerPublication(buy, publication, commitment);
      if (migrated === buy) return current;
      return { ...current, buys: { ...current.buys, [buyerAddress]: migrated } };
    });
  }

  private async updateBuyer(
    publication: OfferPublication,
    operation: (current: BuyRecord | undefined, buyerAddress: string, selected: OfferPublication) => BuyRecord,
  ): Promise<void> {
    const key = offerKey(publication);
    const buyerAddress = this.buyerAddress();
    const selectedId = publicationIdentity(publication);
    await this.store.update(key, (current) => {
      const value = offerState(publication, current);
      const currentBuy = value.buys?.[buyerAddress];
      if (currentBuy !== undefined && publicationIdentity(currentBuy.publication) !== selectedId) {
        throw new Error("The durable buyer workflow belongs to another publication variant");
      }
      return {
        ...value,
        buys: {
          ...(value.buys ?? {}),
          [buyerAddress]: operation(currentBuy, buyerAddress, publication),
        },
      };
    });
  }

  private async reconcile(node: PcashNodeClient, offer: StoredOffer): Promise<StoredOffer | null> {
    const publish = offer.publish;
    const reclaim = offer.reclaim;
    const buyers = Object.entries(offer.buys ?? {});
    const [contract, funding, reclaimResult, ...claimResults] = await Promise.all([
      publish?.l2ContractContentHash === undefined || publish.l2ContractFinalizedAt !== undefined
        ? Promise.resolve(undefined)
        : readOfferPublicationFinality(node, publish.l2ContractContentHash, "contractAccount"),
      publish?.fundingContentHash === undefined || publish.fundingFinalizedAt !== undefined
        ? Promise.resolve(undefined)
        : readOfferPublicationFinality(node, publish.fundingContentHash, "privateValue"),
      reclaim?.contentHash === undefined || reclaim.finalizedAt !== undefined
        ? Promise.resolve(undefined)
        : readMarketplaceReclaimFinality(node, reclaim.contentHash),
      // Only a paid listing's escrow spender is this buyer's claim.
      ...buyers.map(([, buy]) => buy.claimedAt !== undefined || buy.blockNumber === undefined
        ? Promise.resolve(undefined)
        : readPurchaseClaimFinality(node, buy.publication, buy.commitment as Hex)),
    ]);

    return this.store.update(offer.key, (latest) => {
      if (latest === null) return null;
      const now = this.now();
      let nextPublish = latest.publish;
      if (nextPublish !== undefined) {
        const matchingContract = publish?.l2ContractContentHash !== undefined
          && nextPublish.l2ContractContentHash === publish.l2ContractContentHash;
        const matchingFunding = publish?.fundingContentHash !== undefined
          && nextPublish.fundingContentHash === publish.fundingContentHash;
        if ((matchingContract && contract !== undefined) || (matchingFunding && funding !== undefined)) {
          nextPublish = checkpointPublishFinality(nextPublish, {
            ...(matchingContract && contract !== undefined ? { l2Contract: publicationFinality(contract) } : {}),
            ...(matchingFunding && funding !== undefined ? { funding: publicationFinality(funding) } : {}),
          }, now);
        }
      }

      let nextReclaim = latest.reclaim;
      if (
        nextReclaim !== undefined
        && reclaim?.contentHash !== undefined
        && nextReclaim.contentHash === reclaim.contentHash
        && reclaimResult !== undefined
      ) {
        nextReclaim = checkpointReclaimFinality(nextReclaim, reclaimFinality(reclaimResult), now);
      }

      const nextBuys = { ...(latest.buys ?? {}) };
      buyers.forEach(([buyer], index) => {
        const current = nextBuys[buyer];
        const finality = claimResults[index];
        if (current?.blockNumber === undefined || finality === undefined) return;
        nextBuys[buyer] = checkpointClaimFinality(current, finality, now);
      });

      const changed = nextPublish !== latest.publish
        || nextReclaim !== latest.reclaim
        || Object.entries(nextBuys).some(([buyer, buy]) => buy !== latest.buys?.[buyer]);
      if (!changed) return latest;
      return {
        ...latest,
        ...(nextPublish === undefined ? {} : { publish: nextPublish }),
        ...(nextReclaim === undefined ? {} : { reclaim: nextReclaim }),
        ...(Object.keys(nextBuys).length === 0 ? {} : { buys: nextBuys }),
      };
    });
  }

  private async restore(wallet: WalletExecutionContext): Promise<string[]> {
    if (!wallet.spendable()) return [];
    const recovered = await recoverSellerOffers(wallet, wallet.profile, networkConfigFromStatus(wallet.status));
    const recoveredKeys = new Set(recovered.offers.map(({ publication }) => offerKey(publication)));
    for (const stored of await this.store.list()) {
      if (stored.missingContract !== undefined && !recoveredKeys.has(stored.key)) {
        await this.store.update(stored.key, current => current === null ? null : { ...current, recoveryUnavailable: true });
      }
    }
    for (const { publication, missingContract } of recovered.offers) {
      const key = offerKey(publication);
      // A recovered escrow may already be reclaimed. A reclaim this wallet already made is journaled at its
      // inclusion, and reconciliation finalizes it.
      let reclaimHash: string | null = null;
      if (!missingContract && (await this.store.get(key))?.reclaim === undefined) {
        try { reclaimHash = await readEscrowReclaim(wallet.node, publication); }
        catch (cause) { recovered.errors.push(`Seller recovery ${key}: ${cause instanceof Error ? cause.message : String(cause)}`); }
      }
      const reclaim: ReclaimRecord | undefined = reclaimHash === null
        ? undefined : { phase: "accepted", publication, contentHash: reclaimHash, updatedAt: this.now() };
      await this.store.update(key, current => ({ ...current, key, pub: publication, source: "created",
        savedAt: current?.savedAt ?? this.now(), missingContract, recoveryUnavailable: false,
        ...(reclaim === undefined || current?.reclaim !== undefined ? {} : { reclaim }) }));
    }
    const router = this.configuredRouter;
    if (router === undefined) return recovered.errors;
    try {
      const client = await selectedL1Client(wallet.node, this.l1RpcUrls, wallet.status);
      const deployment = await assertPaymentRouterDeployment(client, router.address);
      const payer = this.requireIdentity().l1Signer.address as Address;
      const head = await client.getBlockNumber();
      const known = new Set((await this.store.list()).flatMap(offer => Object.values(offer.buys ?? {})
        .flatMap(buy => buy.txHash === undefined ? [] : [savedPaymentIdentity(buy.txHash, buy.publication)])));
      for await (const log of scanPayerPayments(client, { router: router.address, payer, deploymentBlock: deployment.deploymentBlock, head })) {
        const paymentId = scannedPaymentIdentity(router.address, log);
        if (known.has(paymentId)) continue;
        try {
          const payment = await recoverPaymentPublication({ node: wallet.node, client, profile: wallet.profile, status: wallet.status,
            router: router.address, log });
          const spend = await readEscrowSpend(wallet.node, payment.publication, log.args.claimKeyCommitment);
          // An escrow another transaction spent is no purchase left to finish. Reconciliation reads this payment's claim.
          if (spend !== null && !spend.ours) continue;
          await this.updateBuyer(payment.publication, (current, buyerAddress) => checkpointCanonicalPayment(
            current ?? { buyerAddress, publication: payment.publication, commitment: log.args.claimKeyCommitment }, payment));
          known.add(paymentId);
        } catch (cause) { recovered.errors.push(`Buyer recovery ${log.transactionHash}: ${cause instanceof Error ? cause.message : String(cause)}`); }
      }
    } catch (cause) { recovered.errors.push(`Payment discovery: ${cause instanceof Error ? cause.message : String(cause)}`); }
    return recovered.errors;
  }

  refresh(): Promise<MarketplaceRefreshResult> {
    return this.refreshing ??= this.refreshOnce().finally(() => { this.refreshing = undefined; });
  }

  private async refreshOnce(): Promise<MarketplaceRefreshResult> {
    this.report("refresh", { phase: "preparing", message: "refreshing Marketplace activity…", elapsedMs: 0 });
    const reconcile = async (node: PcashNodeClient) => {
      const offers: StoredOffer[] = [];
      for (const stored of await this.store.list()) {
        const offer = await this.reconcile(node, stored);
        if (offer !== null) offers.push(offer);
      }
      return offers;
    };
    let recoveryErrors: string[] = [];
    const localOffers = this.identity === undefined
      ? await reconcile(this.node)
      : await this.identity.wallet.execute(walletAction("marketplace:reconcile", async wallet => {
        recoveryErrors = await this.restore(wallet);
        return reconcile(wallet.node);
      }));
    try {
      const result = { localOffers, recoveryErrors, catalogOffers: await fetchCatalogOffers(this.node) };
      this.report("refresh", { phase: "done", message: "Marketplace activity is current", elapsedMs: 0 });
      return result;
    } catch (cause) {
      this.report("refresh", {
        phase: "done",
        message: "durable activity is current; catalog is unavailable",
        elapsedMs: 0,
      });
      return {
        localOffers,
        catalogOffers: [],
        recoveryErrors,
        catalogError: `Catalog unavailable; showing durable local offers only. ${cause instanceof Error ? cause.message : String(cause)}`,
      };
    }
  }

  async verify(publication: OfferPublication): Promise<OfferVerification> {
    this.report("verify", { phase: "preparing", message: "verifying the offer and router…", elapsedMs: 0 });
    try {
      const verification = this.identity !== undefined
        ? await this.identity.wallet.execute(walletAction("marketplace:verify", ({ node, status }) =>
            this.verifyWith(node, publication, status)))
        : await this.verifyWith(this.node, publication, await this.node.status());
      this.report("verify", {
        phase: verification.safeToPay ? "done" : "error",
        message: verification.safeToPay ? "offer is safe to pay" : "offer is not safe to pay",
        elapsedMs: 0,
      });
      return verification;
    } catch (cause) {
      this.report("verify", {
        phase: "error",
        message: cause instanceof Error ? cause.message : String(cause),
        elapsedMs: 0,
      });
      throw cause;
    }
  }

  private verifyWith(
    node: PcashNodeClient,
    publication: OfferPublication,
    status: StatusResult,
    routerDeployment?: VerifiedPaymentRouterDeployment,
  ): Promise<OfferVerification> {
    const router = this.configuredRouterRequired();
    return verifyOfferForPayment(node, publication, {
      expectedRouter: router.address,
      expectedNetwork: networkConfigFromStatus(status),
      l1Urls: this.l1RpcUrls,
      ...(routerDeployment === undefined ? {} : { routerDeployment }),
    });
  }

  /** The connected signer, refusing to broadcast once the caller is no longer active. */
  private activeSigner(identity: MarketplaceIdentity, options: MarketplaceBuyOptions): L1Signer {
    return {
      ...identity.l1Signer,
      sendTransaction: (tx) => { options.assertActive?.(); return identity.l1Signer.sendTransaction(tx); },
    };
  }

  /**
   * Buy one offer in one Ethereum transaction: prove the claim, dry-run it, and
   * send `buy`, which pays and carries the claim. If the node that checked the
   * claim was wrong and the carried claim fails, the claim is proved again and
   * carried by `retry`. A saved purchase resumes where
   * it stopped, and a purchase this wallet already paid for, found on L1, is
   * finished the same way.
   */
  async buy(publication: OfferPublication, options: MarketplaceBuyOptions = {}): Promise<MarketplaceBuyResult> {
    const identity = this.requireIdentity();
    const key = marketplaceBuyerOperationKey(
      identity.wallet.network.chainId,
      offerKey(publication),
      this.buyerAddress(),
    );
    return this.operationLock.run(key, () => identity.wallet.execute(walletAction("marketplace:buy", async (wallet) => {
      options.assertActive?.();
      requireSpendableWallet(wallet);
      return this.buyLocked(publication, wallet, this.activeSigner(identity, options), options);
    })));
  }

  /** Check the connected payer's current L1 balance without proving or estimating gas. */
  async checkPaymentBalance(paymentWei: bigint): Promise<void> {
    const identity = this.requireIdentity();
    return identity.wallet.execute(walletAction("marketplace:check-payment-balance", async wallet => {
      requireSpendableWallet(wallet);
      await this.requirePaymentBalance(wallet, identity.l1Signer.address as Address, paymentWei);
    }));
  }

  /** The gas the given Ethereum payments spent, from their receipts. */
  async paymentGas(paymentHashes: readonly Hex[]): Promise<bigint> {
    const identity = this.requireIdentity();
    return identity.wallet.execute(walletAction("marketplace:payment-gas", async wallet => {
      const client = await selectedL1Client(wallet.node, this.l1RpcUrls, wallet.status);
      const receipts = await Promise.all(paymentHashes.map((hash) => client.getTransactionReceipt({ hash })));
      return receipts.reduce((sum, receipt) => sum + receipt.gasUsed * receipt.effectiveGasPrice, 0n);
    }));
  }

  /**
   * Verify the selected listings and quote buying them. `onChecked` receives their
   * payment total as soon as every listing is verified, before gas is estimated.
   */
  async quotePurchases(
    publications: readonly OfferPublication[],
    options: { onChecked?: (check: MarketplacePurchaseCheck) => void } = {},
  ): Promise<MarketplacePurchaseQuote> {
    const identity = this.requireIdentity();
    return identity.wallet.execute(walletAction("marketplace:quote-purchases", async wallet => {
      requireSpendableWallet(wallet);
      return this.quotePurchasesWith(publications, wallet, options.onChecked);
    }));
  }

  private async quotePurchasesWith(
    publications: readonly OfferPublication[],
    wallet: SpendableWalletExecutionContext,
    onChecked?: (check: MarketplacePurchaseCheck) => void,
  ): Promise<MarketplacePurchaseQuote> {
    const client = await selectedL1Client(wallet.node, this.l1RpcUrls, wallet.status);
    // One check of the router's deployment serves every listing.
    const routerDeployment = await assertPaymentRouterDeployment(client, this.configuredRouterRequired().address);
    const calls: BuyCall[] = [];
    const check: MarketplacePurchaseCheck = { paymentWei: 0n, websiteFeeWei: 0n };
    for (const publication of publications) {
      let saved = this.buyerAccount(await this.store.get(offerKey(publication)));
      if (saved?.txHash === undefined && saved?.paymentBroadcastRequestedAt === undefined) {
        const payment = await recoverPayResult(wallet.node, this.l1RpcUrls, wallet.profile, publication, {
          payer: this.requireIdentity().l1Signer.address as Address,
        });
        if (payment !== null) {
          await this.updateBuyer(publication, (current, buyerAddress) => checkpointCanonicalPayment(
            current ?? { buyerAddress, publication, commitment: purchaseCommitment(publication, wallet.profile) }, payment));
          saved = this.buyerAccount(await this.store.get(offerKey(publication)));
        }
      }
      // Payment recovery in buyLocked owns ambiguous broadcasts; never quote a duplicate payment.
      if (saved?.txHash || saved?.paymentBroadcastRequestedAt !== undefined) continue;
      const checked = await this.verifyWith(wallet.node, publication, wallet.status, routerDeployment);
      if (!checked.safeToPay || checked.claimSnapshot === null || checked.feeQuote === null) {
        throw new Error(`Listing is unavailable: ${checked.checks.join("; ")}`);
      }
      // The claim is not proved yet; a stand-in of its size prices the call.
      calls.push(buildBuyCall(publication, wallet.profile, {
        anchor: checked.claimSnapshot.anchor,
        notAfter: claimNotAfter(checked.claimSnapshot.timestamp, BigInt(publication.terms.deadlineT)),
        batch: claimBatchStandIn(),
      }));
      check.paymentWei += BigInt(publication.terms.ethPriceWei);
      check.websiteFeeWei += checked.feeQuote.websiteFeeWei;
    }
    const payer = this.requireIdentity().l1Signer.address as Address;
    if (check.paymentWei > 0n) await checkPaymentBalance(client, payer, check.paymentWei);
    onChecked?.(check);
    const quote = { ...check, estimatedGasWei: 0n, maximumGasWei: 0n };
    // Principal affordability is established before the callback above. Only
    // that checked payment reaches the anchor wait, fee quotes and simulation.
    const gasLimits = await estimateRouterCallsGas(client, payer, calls);
    const [gasPrice, fees] = await Promise.all([client.getGasPrice(), client.estimateFeesPerGas()]);
    for (const gas of gasLimits) {
      quote.estimatedGasWei += gas * gasPrice;
      quote.maximumGasWei += gas * fees.maxFeePerGas;
    }
    return quote;
  }

  /** Buy each selected listing with its own `buy`, one after another. */
  async buyMany(publications: readonly OfferPublication[], options: MarketplaceBuyOptions = {}): Promise<MarketplaceBatchPurchase[]> {
    // Selections come from application callers, including catalog data supplied by the node.
    if (publications.length === 0) throw new Error("Select at least one listing");
    const unique = new Set(publications.map(offerKey));
    if (unique.size !== publications.length) throw new Error("Select each listing only once");
    const identity = this.requireIdentity();
    const keys = [...unique].sort().map(key => marketplaceBuyerOperationKey(identity.wallet.network.chainId, key, this.buyerAddress()));
    const execute = () => identity.wallet.execute(walletAction("marketplace:buy", async wallet => {
      options.assertActive?.();
      requireSpendableWallet(wallet);
      await this.assertPurchaseBudget(publications, wallet);
      const results: MarketplaceBatchPurchase[] = [];
      for (const [index, publication] of publications.entries()) {
        options.assertActive?.();
        this.report("buy", { phase: "preparing", message: `Preparing purchase ${index + 1} of ${publications.length}…`, elapsedMs: 0 });
        results.push({ ...await this.buyLocked(publication, wallet, this.activeSigner(identity, options), options), publication });
      }
      return results;
    }));
    const lock = (index: number): Promise<MarketplaceBatchPurchase[]> => index === keys.length ? execute() : this.operationLock.run(keys[index]!, () => lock(index + 1));
    return lock(0);
  }

  /** Refuse to start a multi-listing purchase the buyer's ETH cannot cover in full. */
  private async assertPurchaseBudget(publications: readonly OfferPublication[], wallet: SpendableWalletExecutionContext): Promise<void> {
    const quote = await this.quotePurchasesWith(publications, wallet);
    const client = await selectedL1Client(wallet.node, this.l1RpcUrls, wallet.status);
    if (await client.getBalance({ address: this.requireIdentity().l1Signer.address }) < quote.paymentWei + quote.maximumGasWei) {
      throw new Error("Not enough ETH for the selected listings and transaction fees");
    }
  }

  private async resolvePayment(
    selected: OfferPublication,
    buy: BuyRecord | undefined,
    wallet: SpendableWalletExecutionContext,
  ) {
    const resolution = await resolveCheckpointedPayment({
      buy,
      awaitPending: (hash) => this.awaitRouterCall(hash, wallet),
      recoverCanonical: (minimumObservedBlock, hash) => this.recoverPayment(selected, wallet, minimumObservedBlock, hash),
      headPastAttempt: () => this.headPastBuyAttempt(buy!, wallet),
    });
    if (resolution.failedHashes !== undefined) {
      await this.updateBuyer(
        selected,
        (current) => checkpointFailedPayment(current!, ...resolution.failedHashes!),
      );
    }
    return resolution;
  }

  private recoverPayment(publication: OfferPublication, wallet: SpendableWalletExecutionContext, minimumObservedBlock?: bigint, hash?: Hex) {
    return recoverPayResult(wallet.node, this.l1RpcUrls, wallet.profile, publication, {
      payer: this.requireIdentity().l1Signer.address as Address,
      ...(minimumObservedBlock === undefined ? {} : { minimumObservedBlock }),
      ...(hash === undefined ? {} : { hash }),
    });
  }

  /** The latest block of the selected Ethereum endpoint. */
  private async l1Head(wallet: SpendableWalletExecutionContext): Promise<{ number: bigint; timestamp: bigint }> {
    const client = await selectedL1Client(wallet.node, this.l1RpcUrls, wallet.status);
    return client.getBlock({ blockTag: "latest" });
  }

  /** The Ethereum head once it is past the `notAfter` of the saved `buy` attempt, or undefined before then. */
  private async headPastBuyAttempt(buy: BuyRecord, wallet: SpendableWalletExecutionContext): Promise<bigint | undefined> {
    const head = await this.l1Head(wallet);
    return head.timestamp > buyNotAfter(buy.publication, BigInt(buy.claimNotAfter!)) ? head.number : undefined;
  }

  /** The Ethereum receipt of a `buy` this wallet sent earlier, waiting while it is pending. */
  private awaitRouterCall(hash: Hex, wallet: SpendableWalletExecutionContext): Promise<PayResult> {
    return awaitPayResult(this.l1RpcUrls, hash, wallet.status.l1ChainId, "buy");
  }

  private sendRouterCall(node: PcashNodeClient, signer: L1Signer, call: RouterCall, callbacks: PaymentBroadcastCallbacks = {}): Promise<PayResult> {
    return sendRouterCall(node, this.l1RpcUrls, signer, call, callbacks);
  }

  private async proveClaim(publication: OfferPublication, wallet: SpendableWalletExecutionContext, snapshot: ClaimSnapshot): Promise<ProvedClaim> {
    return proveCarriedClaim({
      node: wallet.node,
      offer: publication,
      buyer: wallet.profile,
      snapshot,
      buyerReceiveKey: (accountStateRoot: bigint) => loadSelfReceiveKeyAtSnapshot(
        wallet.store, wallet.profile.address, accountStateRoot, () => wallet.synchronize(),
      ),
      prover: await this.getProver(),
      onStatus: this.progress("buy"),
    });
  }

  /** Fresh principal-only check shared by the preview and the last check before proving. */
  private async requirePaymentBalance(wallet: SpendableWalletExecutionContext, payer: Address, paymentWei: bigint): Promise<void> {
    const client = await selectedL1Client(wallet.node, this.l1RpcUrls, wallet.status);
    await checkPaymentBalance(client, payer, paymentWei);
  }

  /**
   * Whether a call can still carry this claim, with room to approve and land it:
   * before the claim's time limit, and for `buy` within BLOCKHASH range of its anchor.
   */
  private async withinCallLimits(claim: ReadyClaim, wallet: SpendableWalletExecutionContext, functionName: RouterCall["functionName"]): Promise<boolean> {
    const head = await this.l1Head(wallet);
    return (functionName === "retry" || head.number - claim.anchor.blockNumber < MAX_PAYMENT_ANCHOR_AGE_BLOCKS - SAVED_CLAIM_MARGIN_BLOCKS)
      && claim.notAfter > head.timestamp + SAVED_CLAIM_MARGIN_SECONDS;
  }

  /**
   * Claim bytes for the next router call, checked by the node with the router's
   * carrier context. Saved bytes are reused while they can still execute and the
   * node accepts them; otherwise the claim is proved against `snapshot`, and its
   * exact bytes are saved before any call carries them.
   */
  private async readyClaim(
    publication: OfferPublication,
    wallet: SpendableWalletExecutionContext,
    commitment: Hex,
    snapshot: () => Promise<ClaimSnapshot>,
    functionName: RouterCall["functionName"],
  ): Promise<ReadyClaim> {
    const saved = savedClaim(this.buyerAccount(await this.store.get(offerKey(publication))));
    if (saved !== null && await this.withinCallLimits(saved, wallet, functionName)) {
      try {
        await checkCarriedClaim(wallet.node, saved.transactionHex, publication, commitment);
        return saved;
      } catch (error) {
        if (!(error instanceof ClaimCheckError)) throw error;
      }
    }
    let claimSnapshot = await snapshot();
    let proved: ProvedClaim;
    try {
      proved = await this.proveClaim(publication, wallet, claimSnapshot);
    } catch (error) {
      // The buyer's receive key is read at the snapshot's account root. When the
      // wallet has synced past that root, prove against the current head instead;
      // the key is resolved before any proving starts.
      if (!(error instanceof Error && error.name === "WalletSyncRequiredError")) throw error;
      claimSnapshot = await readClaimSnapshot(wallet.node, publication);
      proved = await this.proveClaim(publication, wallet, claimSnapshot);
    }
    const claim: ReadyClaim = {
      ...proved,
      anchor: claimSnapshot.anchor,
      notAfter: claimNotAfter(claimSnapshot.timestamp, BigInt(publication.terms.deadlineT)),
    };
    await this.updateBuyer(publication, (current) => checkpointPreparedClaim(current!, claim));
    this.report("buy", { phase: "preparing", message: "Checking your claim with the node…", elapsedMs: 0 });
    await checkCarriedClaim(wallet.node, claim.transactionHex, publication, commitment);
    return claim;
  }

  /** Prove, dry-run, and send `buy`. ETH moves only after the node has accepted the exact claim the call carries. */
  private async pay(
    publication: OfferPublication,
    wallet: SpendableWalletExecutionContext,
    l1Signer: L1Signer,
    commitment: Hex,
    verified: OfferVerification | undefined,
    options: MarketplaceBuyOptions,
  ): Promise<PayResult | RecoveredPayResult> {
    const { node, profile, status } = wallet;
    await loadSelfReceiveKey(wallet.store, profile.address);
    // Recovery above still runs once buying closes, so a restored wallet finds
    // its payment through T; only a fresh payment is refused.
    if (!openForPurchase(publication, BigInt(Math.floor(this.now() / 1_000)))) {
      throw new Error("Buying has closed for this listing, and this wallet has no payment for it");
    }
    const checked = verified ?? await this.verifyWith(node, publication, status);
    if (!checked.safeToPay || checked.claimSnapshot === null) {
      throw new Error(`Offer is not safe to pay: ${checked.checks.join("; ")}`);
    }
    await this.requirePaymentBalance(wallet, l1Signer.address as Address, BigInt(publication.terms.ethPriceWei));
    const verifiedSnapshot = checked.claimSnapshot;
    const claim = await this.readyClaim(publication, wallet, commitment, async () => verifiedSnapshot, "buy");
    options.assertActive?.();
    const call = buildBuyCall(publication, profile, {
      anchor: claim.anchor,
      notAfter: claim.notAfter,
      batch: claimBatch(status, profile, claim.transactionHex),
    });
    this.report("buy", { phase: "submitting", message: "Approve the payment in your wallet…", elapsedMs: 0 });
    let submitted: PayResult;
    try {
      submitted = await this.sendRouterCall(node, l1Signer, call, {
        onBroadcastRequested: () => this.updateBuyer(publication, (current) => checkpointPaymentBroadcastRequested(current!, this.now())),
        onSent: (hash) => this.updateBuyer(publication, (current) => checkpointPendingPayment(current!, hash)),
        onDefinitelyRejected: () => this.updateBuyer(publication, (current) => checkpointPaymentPreBroadcastRejection(current!)),
      });
    } catch (error) {
      // A cancelled or reverted `buy` paid nothing. A revert can be the router
      // refusing a second payment, so its record decides whether an earlier
      // attempt of this purchase paid.
      if (error instanceof PaymentTransactionCancelledError || error instanceof PaymentTransactionRevertedError) {
        const earlier = await this.recoverPayment(publication, wallet, error.blockNumber);
        if (earlier !== null) return earlier;
        const cancelled = error instanceof PaymentTransactionCancelledError;
        const hashes = cancelled ? [error.originalHash, error.replacementHash] : [error.hash];
        await this.updateBuyer(publication, (current) => checkpointFailedPayment(current!, ...hashes));
        throw new Error(`The payment ${cancelled ? "was cancelled in the wallet" : "transaction reverted"}, so nothing was paid. Buy again to send a new payment.`, { cause: error });
      }
      throw error;
    }
    const resolution = await resolveSubmittedPayment({
      submitted,
      recoverCanonical: (minimumObservedBlock, hash) => this.recoverPayment(publication, wallet, minimumObservedBlock, hash),
    });
    if (resolution.payment === null) {
      await this.updateBuyer(publication, (current) => checkpointFailedPayment(current!, ...resolution.failedHashes!));
      throw new Error("The wallet replacement did not pay the Marketplace router; retry to authorize a fresh payment");
    }
    return resolution.payment;
  }

  /**
   * The claim that spent the purchase's escrow, or null when none has by the
   * first canonical block at or after the carrier's Ethereum block.
   */
  private async awaitClaim(publication: OfferPublication, wallet: SpendableWalletExecutionContext, commitment: Hex, carrierL1Block: bigint): Promise<EscrowSpend | null> {
    try {
      return await awaitRecordOrAbsence({
        node: wallet.node,
        l1BlockNumber: carrierL1Block,
        find: async () => {
          const spend = await readEscrowSpend(wallet.node, publication, commitment);
          if (spend !== null && !spend.ours) throw new Error("Another transaction spent this listing's escrow: the seller's reclaim after the claim deadline, or a different payment's claim");
          return spend;
        },
        pollIntervalMs: this.claimPollIntervalMs,
      });
    } catch (error) {
      if (!(error instanceof RecordUnsettledError)) throw error;
      throw new Error("The node has not yet indexed the blocks that show whether your claim landed. Continue to check again.", { cause: error });
    }
  }

  /**
   * Finish a paid purchase. The escrow spender shows whether a claim landed,
   * whichever call carried it. When none has by a canonical block past the
   * last carrier, the claim is proved again against the current head and
   * carried in `retry`, which is not pausable and has no 24-hour limit; after
   * `T` the escrow rejects it. A `retry` sent before a reload is not waited
   * for: a second one costs only gas, since the escrow note's nullifier lets
   * one claim succeed.
   */
  private async finishClaim(
    publication: OfferPublication,
    wallet: SpendableWalletExecutionContext,
    l1Signer: L1Signer,
    commitment: Hex,
    paymentL1Block: bigint,
    options: MarketplaceBuyOptions,
  ): Promise<string> {
    const { node, profile, status } = wallet;
    let carrierL1Block = paymentL1Block;
    for (let retried = false; ; retried = true) {
      this.report("buy", { phase: "confirming", message: "Waiting for the network to process your claim…", elapsedMs: 0 });
      const landed = await this.awaitClaim(publication, wallet, commitment, carrierL1Block);
      if (landed !== null) {
        await this.updateBuyer(publication, (current) => checkpointClaimFinality(current!, {
          phase: "accepted", contentHash: landed.contentHash, acceptedBlock: landed.l1BlockNumber,
        }, this.now()));
        this.report("buy", { phase: "done", message: "Your claim succeeded", elapsedMs: 0 });
        return landed.contentHash;
      }
      if (retried) throw new Error("The retried claim did not succeed. Continue to try again before the deadline.");
      if (BigInt(Math.floor(this.now() / 1_000)) >= BigInt(publication.terms.deadlineT)) {
        throw new Error("The claim did not succeed, and the claim deadline has passed");
      }
      this.report("buy", { phase: "preparing", message: "Your claim did not succeed. Proving it again…", elapsedMs: 0 });
      const claim = await this.readyClaim(publication, wallet, commitment, () => readClaimSnapshot(node, publication), "retry");
      options.assertActive?.();
      this.report("buy", { phase: "submitting", message: "Approve the claim in your wallet…", elapsedMs: 0 });
      const sent = await this.sendRouterCall(node, l1Signer, buildRetryCall(publication, claimBatch(status, profile, claim.transactionHex)));
      carrierL1Block = sent.blockNumber;
    }
  }

  private async buyLocked(
    publication: OfferPublication,
    wallet: SpendableWalletExecutionContext,
    l1Signer: L1Signer,
    options: MarketplaceBuyOptions,
  ): Promise<MarketplaceBuyResult> {
    const { node, profile, status } = wallet;
    const key = offerKey(publication);
    let restoredBuy = this.buyerAccount(await this.store.get(key));
    const variantChanged = restoredBuy !== undefined
      && publicationIdentity(restoredBuy.publication) !== publicationIdentity(publication);

    // An attempt for another variant is settled first, so its payment cannot land after the move.
    if (variantChanged && restoredBuy !== undefined) {
      const priorResolution = await this.resolvePayment(restoredBuy.publication, restoredBuy, wallet);
      restoredBuy = this.buyerAccount(await this.store.get(key));
      if (priorResolution.payment !== null) {
        const canonical = priorResolution.payment;
        await this.updateBuyer(restoredBuy!.publication, (current) => checkpointCanonicalPayment(current!, canonical));
        throw new Error("A canonical payment already authorizes another escrow publication");
      }
    }
    const initialVerification = restoredBuy === undefined || variantChanged
      ? await this.verifyWith(node, publication, status)
      : undefined;
    if (initialVerification !== undefined) assertRecoverablePublicationVerified(initialVerification);
    const commitment = purchaseCommitment(publication, profile);
    if (variantChanged) await this.migrateBuyerPublication(publication, commitment);
    await this.updateBuyer(publication, (current, buyerAddress, selected) => current ?? { buyerAddress, publication: selected, commitment });
    const resolution = await this.resolvePayment(publication, this.buyerAccount(await this.store.get(key)), wallet);
    const payment: PayResult & { paidAt?: number } = resolution.payment
      ?? await this.pay(publication, wallet, l1Signer, commitment, initialVerification, options);
    await this.updateBuyer(publication, (current) => checkpointCanonicalPayment(current!, { ...payment, paidAt: payment.paidAt ?? this.now() }));
    const claimContentHash = await this.finishClaim(publication, wallet, l1Signer, commitment, payment.blockNumber, options);
    return { paymentHash: payment.hash, claimContentHash };
  }

  private async publishPreparedOffer(
    offer: Offer,
    publication: OfferPublication,
    draft: StoredOffer,
    openFees: Pick<PublishOfferParams, "creationOpenFeeAmount" | "fundingOpenFeeAmount">,
    resume?: PublishOfferResume,
    options: MarketplacePublicationOptions = {},
  ): Promise<MarketplacePublishResult> {
    const identity = this.requireIdentity();
    const key = offerKey(publication);
    const checkpoint = await this.store.get(key);
    const fundingCanonical = checkpoint?.missingContract === false || hasCanonicalFunding(checkpoint?.publish);
    const definition = publicationAssetDefinition(publication);
    if (definition !== null) await identity.wallet.importAssetDefinition(definition);
    const startedAt = this.now();
    let publicationProgress: NonNullable<MarketplaceProgress["publication"]> = {
      step: "contract", ...(resume?.l2ContractContentHash === undefined ? {} : { contentHash: resume.l2ContractContentHash }),
    };
    const reportPublication = (phase: ProvePhase, message: string) => this.onProgress?.({
      action: "publish", phase, message, elapsedMs: this.now() - startedAt, publication: { ...publicationProgress, offerAddress: publicationContractAddress(publication) },
    });
    reportPublication("preparing", "Checking the saved offer and preparing registration.");
    const escrow = publication.escrow !== undefined && fundingCanonical ? publication.escrow : await publishOffer({
      wallet: identity.wallet,
      offer,
      ...openFees,
      ...(options.selectedRelaySession === undefined ? {} : { selectedRelayQuote: options.selectedRelaySession }),
      ...(options.privateRelayFeeAmount === undefined ? {} : { privateRelayFeeAmount: options.privateRelayFeeAmount }),
      readL1Timestamp: (node) => paymentL1Timestamp(node, this.l1RpcUrls),
      ...(resume === undefined ? {} : { resume }),
      ...options,
      onProgress: reportPublication,
      onCheckpoint: async (checkpoint) => {
        await this.store.update(key, (current) => applyPublishCheckpoint(current ?? draft, checkpoint, this.now()));
        publicationProgress = checkpoint.l2ContractAcceptedBlock === undefined
          ? { step: "contract", contentHash: checkpoint.l2ContractContentHash }
          : { step: "funding", ...(checkpoint.fundingContentHash === undefined ? {} : { contentHash: checkpoint.fundingContentHash }) };
        reportPublication("preparing", checkpoint.l2ContractAcceptedBlock === undefined
          ? "Your listing creation transaction is ready."
          : checkpoint.fundingContentHash === undefined ? "Listing created. Preparing your escrow funding." : "Your escrow funding transaction is ready.");
      },
    });
    publicationProgress = { step: "catalog" };
    reportPublication("submitting", "Your escrow is funded. Making your listing available to buyers…");
    const fundedPublication: OfferPublication = { ...publication, escrow };
    const catalog = await persistFundedPublication({
      store: this.store,
      key,
      draft,
      publication: fundedPublication,
      now: this.now,
      publishCatalog: () => identity.wallet.execute(walletAction("marketplace:publish-catalog", ({ node }) =>
        publishCatalogOffer(node, fundedPublication).then(() => undefined))),
    });
    reportPublication(catalog.catalogPublished ? "done" : "error", catalog.catalogPublished ? "Your listing is live." : "Your escrow is funded, but publishing the listing failed. Continue from Activity to retry.");
    return { offer, publication: fundedPublication, ...catalog };
  }

  async createAndPublish(input: MarketplaceCreateOfferInput, options: MarketplacePublicationOptions = {}): Promise<MarketplacePublishResult> {
    this.onProgress?.({ action: "publish", phase: "preparing", message: "Checking your wallet and preparing the offer.", elapsedMs: 0, publication: { step: "contract" } });
    if (input.ethPriceWei <= 0n) {
      throw new Error("Marketplace offer ETH price must be greater than zero");
    }
    const identity = this.requireIdentity();
    const router = this.configuredRouterRequired();
    const prepared = await identity.wallet.execute(walletAction("marketplace:create-offer", async (wallet) => {
      requireSpendableWallet(wallet);
      // The offer commits this status's L1 chain and inbox to its reclaim
      // domain, so the configured L1 RPC must confirm this status itself.
      const client = await selectedL1Client(wallet.node, this.l1RpcUrls, wallet.status);
      await assertPaymentRouterDeployment(client, router.address);
      const l1Timestamp = (await client.getBlock({ blockTag: "latest" })).timestamp;
      const terms = {
        router: BigInt(router.address),
        seller: wallet.profile.address,
        assetId: input.assetId,
        amount: input.amount,
        ethPriceWei: input.ethPriceWei,
        deadlineT: l1Timestamp + input.purchaseMinutes * 60n + MIN_CLAIM_WINDOW_SECONDS + PURCHASE_MARGIN_SECONDS,
      };
      const offer = createOffer({
        network: networkConfigFromStatus(wallet.status),
        terms,
        sellerWallet: wallet.profile,
        l2ContractNkRoot: this.entropy(),
        claimApplicationVkHash: CLAIM_APPLICATION_VK_HASH,
        reclaimApplicationVkHash: RECLAIM_APPLICATION_VK_HASH,
      });
      const publication = publicationFromOffer(offer, input.assetDefinition);
      const key = offerKey(publication);
      const submission = options.submission ?? wallet.submission;
      const selected = (options.privateRelayFeeAmount ?? 0n) > 0n;
      if (selected !== (options.selectedRelaySession !== undefined)) {
        throw new Error("selected listing requires a positive private fee and authenticated quote session");
      }
      if (selected && submission?.mode === "l1") {
        throw new Error("selected listing requires public mempool publication");
      }
      const noOpenFees = submission?.mode === "l1" || selected;
      const openFees = {
        creationOpenFeeAmount: noOpenFees ? 0n : input.creationOpenFeeAmount,
        fundingOpenFeeAmount: noOpenFees ? 0n : input.fundingOpenFeeAmount,
      };
      const draft: StoredOffer = {
        key,
        pub: publication,
        source: "created",
        savedAt: this.now(),
        publish: {
          phase: "draft",
          submissionMode: submission?.mode === "l1" ? "fast" : selected ? "selected" : "slow",
          creationOpenFeeBaseUnits: openFees.creationOpenFeeAmount.toString(),
          fundingOpenFeeBaseUnits: openFees.fundingOpenFeeAmount.toString(),
          ...(selected ? { privateRelayFeeBaseUnits: (options.privateRelayFeeAmount ?? 0n).toString() } : {}),
          updatedAt: this.now(),
        },
      };
      return { offer, publication, key, draft, seller: wallet.profile.address, openFees };
    }));
    const operationKey = marketplaceSellerPublicationOperationKey(
      identity.wallet.network.chainId,
      prepared.key,
      prepared.seller,
    );
    return this.operationLock.run(operationKey, async () => {
      await this.store.put(prepared.draft);
      return this.publishPreparedOffer(
        prepared.offer,
        prepared.publication,
        prepared.draft,
        prepared.openFees,
        undefined,
        options,
      );
    });
  }

  async resumePublication(publication: OfferPublication, options: MarketplacePublicationOptions = {}): Promise<MarketplacePublishResult> {
    const identity = this.requireIdentity();
    const operationKey = marketplaceSellerPublicationOperationKey(
      identity.wallet.network.chainId,
      offerKey(publication),
      BigInt(identity.wallet.address),
    );
    return this.operationLock.run(operationKey, () => this.resumePublicationLocked(publication, options));
  }

  /** Forget a listing whose escrow funding never started. A created contract holds nothing. */
  async discardUnfundedPublication(publication: OfferPublication): Promise<void> {
    const identity = this.requireIdentity();
    const key = offerKey(publication);
    const operationKey = marketplaceSellerPublicationOperationKey(
      identity.wallet.network.chainId,
      key,
      BigInt(identity.wallet.address),
    );
    await this.operationLock.run(operationKey, () => this.store.update(key, (current) => {
      // Another tab may have started funding since this one showed the listing.
      if (current !== null && (current.publish?.fundingContentHash !== undefined || current.pub.escrow !== undefined)) {
        throw new Error("This listing's escrow funding has started, so it cannot be discarded.");
      }
      return null;
    }));
  }

  private async resumePublicationLocked(publication: OfferPublication, options: MarketplacePublicationOptions): Promise<MarketplacePublishResult> {
    const identity = this.requireIdentity();
    const saved = await this.store.get(offerKey(publication));
    // Reconcile first, so a transaction that can no longer be accepted is prepared again rather than resubmitted.
    const stored = saved === null ? null
      : await identity.wallet.execute(walletAction("marketplace:reconcile", (wallet) => this.reconcile(wallet.node, saved)));
    if (stored === null || stored.source !== "created") {
      throw new Error("No local seller publication is available to resume");
    }
    if (stored.recoveryUnavailable || stored.missingContract) throw new Error("Recover the funded escrow before resuming publication");
    const publish = stored.publish;
    if (publish === undefined || publish.creationOpenFeeBaseUnits === undefined || publish.fundingOpenFeeBaseUnits === undefined) {
      throw new Error("The durable seller publication has no relayer fees");
    }
    if (publish.submissionMode === "selected" && options.privateRelayFeeAmount !== undefined
      && publish.privateRelayFeeBaseUnits !== options.privateRelayFeeAmount.toString()) {
      throw new Error("resuming a selected listing requires its saved private relay fee");
    }
    const durablePublication = stored.pub;
    const offer = await identity.wallet.execute(walletAction("marketplace:resume-publication", (wallet) => {
      requireSpendableWallet(wallet);
      return reconstructOfferFromPublication(
        durablePublication,
        wallet.profile,
        networkConfigFromStatus(wallet.status),
      );
    }));
    const resume: PublishOfferResume | undefined = publish.l2ContractContentHash === undefined
      ? undefined
      : {
          l2ContractContentHash: publish.l2ContractContentHash,
          ...(publish.l2ContractTransactionHex === undefined ? {} : { l2ContractTransactionHex: publish.l2ContractTransactionHex as Hex }),
          ...(publish.fundingContentHash === undefined ? {} : { fundingContentHash: publish.fundingContentHash }),
          ...(publish.fundingTransactionHex === undefined ? {} : { fundingTransactionHex: publish.fundingTransactionHex as Hex }),
        };
    const openFees = {
      creationOpenFeeAmount: BigInt(publish.creationOpenFeeBaseUnits),
      fundingOpenFeeAmount: BigInt(publish.fundingOpenFeeBaseUnits),
    };
    return this.publishPreparedOffer(offer, durablePublication, stored, openFees, resume, {
      ...options,
      ...(publish.submissionMode === "selected" ? { privateRelayFeeAmount: BigInt(publish.privateRelayFeeBaseUnits ?? "0") } : {}),
    });
  }

  /** Repair a funding-only inclusion; funding is never submitted by this action. */
  async restoreContract(publication: OfferPublication, creationOpenFee: bigint, options: MarketplaceActionOptions = {}): Promise<Hex> {
    const identity = this.requireIdentity();
    return this.operationLock.run(marketplaceSellerPublicationOperationKey(identity.wallet.network.chainId, offerKey(publication), BigInt(identity.wallet.address)), async () => {
      const prepared = await identity.wallet.execute(walletAction("marketplace:restore-contract", async wallet => {
        requireSpendableWallet(wallet);
        const offer = reconstructOfferFromPublication(publication, wallet.profile, networkConfigFromStatus(wallet.status));
        const contract = await wallet.node.getContract(publicationContractAddress(publication));
        if (contract.status !== "notFound") throw new Error("Refresh the listing's contract status before recovery");
        return { offer, node: wallet.node, selfPublished: (options.submission ?? wallet.submission)?.mode === "l1" };
      }));
      options.assertActive?.();
      const result = await runSponsoredContractCreationFlow({ wallet: identity.wallet, node: prepared.node,
        contract: { body: prepared.offer.l2ContractBody, address: prepared.offer.l2ContractAddress },
        openFeeAmount: prepared.selfPublished || options.selectedRelaySession !== undefined ? 0n : creationOpenFee,
        ...(options.submission === undefined ? {} : { submission: options.submission }),
        ...(options.selectedRelaySession === undefined ? {} : { selectedRelayQuote: options.selectedRelaySession, privateRelayFeeAmount: options.privateRelayFeeAmount ?? 0n }),
      });
      return result.contentHash as Hex;
    });
  }

  async reclaim(publication: OfferPublication, requestedOpenFee: bigint, options: MarketplaceActionOptions = {}): Promise<Hex> {
    const identity = this.requireIdentity();
    const operationKey = marketplaceSellerReclaimOperationKey(
      identity.wallet.network.chainId,
      offerKey(publication),
      BigInt(identity.wallet.address),
    );
    return this.operationLock.run(
      operationKey,
      () => this.reclaimLocked(publication, requestedOpenFee, options),
    );
  }

  private async reclaimLocked(publication: OfferPublication, requestedOpenFee: bigint, options: MarketplaceActionOptions): Promise<Hex> {
    const identity = this.requireIdentity();
    const key = offerKey(publication);
    const publicationId = publicationIdentity(publication);
    const stored = await this.store.get(key);
    const existingReclaim = stored?.reclaim;
    const samePublication = existingReclaim !== undefined
      && publicationIdentity(existingReclaim.publication) === publicationId;
    if (existingReclaim?.contentHash !== undefined && !samePublication) {
      throw new Error("An active reclaim already belongs to another escrow publication");
    }
    const storedReclaim = samePublication ? existingReclaim : undefined;
    if (storedReclaim?.finalizedAt !== undefined) {
      if (storedReclaim.contentHash === undefined) throw new Error("Finalized reclaim journal has no content hash");
      return storedReclaim.contentHash as Hex;
    }
    const openFeeAmount = storedReclaim?.openFeeBaseUnits === undefined
      ? requestedOpenFee
      : BigInt(storedReclaim.openFeeBaseUnits);
    const prepared = storedReclaim?.contentHash !== undefined && storedReclaim.transactionHex !== undefined
      ? { contentHash: storedReclaim.contentHash, transactionHex: storedReclaim.transactionHex }
      : undefined;
    const result = await identity.wallet.execute(walletAction("marketplace:reclaim", async (wallet) => {
      options.assertActive?.();
      if (options.submission) wallet = { ...wallet, submission: options.submission };
      const { node } = wallet;
      const quoteProvider = options.selectedRelaySession;
      const selectedRelay = quoteProvider === undefined ? undefined : {
        provider: quoteProvider,
        privateFeeAmount: options.privateRelayFeeAmount ?? BigInt(storedReclaim?.privateRelayFeeBaseUnits ?? "0"),
      };
      if (prepared === undefined && wallet.submission?.mode === "l1" && selectedRelay !== undefined) {
        throw new Error("selected reclaim requires public mempool publication");
      }
      if (prepared === undefined && options.privateRelayFeeAmount !== undefined && selectedRelay === undefined) {
        throw new Error("selected reclaim requires an authenticated quote session");
      }
      if (selectedRelay !== undefined && selectedRelay.privateFeeAmount <= 0n) {
        throw new Error("selected reclaim requires a positive private relay fee");
      }
      const effectiveOpenFee = (wallet.submission?.mode === "l1" || selectedRelay !== undefined) && prepared === undefined ? 0n : openFeeAmount;
      const prove = async () => {
        if (storedReclaim?.submissionMode === "selected" && selectedRelay === undefined) {
          throw new Error("reproving a selected reclaim requires a new private relayer quote");
        }
        if (!wallet.spendable()) {
          throw new Error("Marketplace reclaim requires a spendable wallet");
        }
        options.assertActive?.();
        return reclaimMarketplaceOffer({
          node,
          submitTransaction: createMarketplaceTransactionSubmitter(wallet),
          offer: publication,
          sellerProfile: wallet.profile,
          sellerReceiveKey: (accountStateRoot: bigint) => loadSelfReceiveKeyAtSnapshot(
            wallet.store, wallet.profile.address, accountStateRoot, () => wallet.synchronize(),
          ),
          sellerSigner: wallet.signer,
          readL1Timestamp: () => paymentL1Timestamp(node, this.l1RpcUrls),
          openFeeAmount: effectiveOpenFee,
          publicationMode: wallet.submission?.mode === "l1" ? "self" : "open",
          ...(selectedRelay === undefined ? {} : { selectedRelay }),
          sponsor: identity.wallet,
          prover: await this.getProver(),
          onStatus: this.progress("reclaim"),
          onPrepared: async (contentHash, transactionHex) => {
            await this.store.update(key, (current) => {
              const value = offerState(publication, current);
              if (
                value.reclaim?.contentHash !== undefined
                && (
                  publicationIdentity(value.reclaim.publication) !== publicationId
                  || value.reclaim.contentHash !== contentHash
                )
              ) {
                throw new Error("Another reclaim was prepared while this proof was being built");
              }
              return {
                ...value,
                reclaim: {
                  phase: "prepared",
                  submissionMode: wallet.submission?.mode === "l1" ? "fast" : selectedRelay !== undefined ? "selected" : "slow",
                  publication,
                  contentHash,
                  transactionHex,
                  openFeeBaseUnits: effectiveOpenFee.toString(),
                  ...(selectedRelay === undefined ? {} : { privateRelayFeeBaseUnits: selectedRelay.privateFeeAmount.toString() }),
                  updatedAt: this.now(),
                },
              };
            });
          },
        });
      };
      if (prepared === undefined) return prove();
      try {
        if (selectedRelay !== undefined) {
          if (storedReclaim?.privateRelayFeeBaseUnits !== selectedRelay.privateFeeAmount.toString()) {
            throw new Error("prepared selected reclaim has a different private relay fee");
          }
        }
        return await resumeMarketplaceReclaim({
          node,
          submitTransaction: createMarketplaceTransactionSubmitter(wallet),
          contentHash: prepared.contentHash,
          transactionHex: prepared.transactionHex,
          onStatus: this.progress("reclaim"),
        });
      } catch (error) {
        if (!isStaleTransactionAnchorError(error)) throw error;
        this.report("reclaim", { phase: "preparing", message: `${error.message}; proving the reclaim again…`, elapsedMs: 0 });
        await this.store.update(key, (current) => {
          const value = offerState(publication, current);
          return value.reclaim === undefined
            ? value
            : { ...value, reclaim: checkpointStaleReclaim(value.reclaim, prepared.contentHash, this.now()) };
        });
        return prove();
      }
    }));
    await this.store.update(key, (current) => {
      const value = offerState(publication, current);
      const reclaim = value.reclaim;
      if (
        reclaim?.contentHash !== result.contentHash
        || reclaim === undefined
        || publicationIdentity(reclaim.publication) !== publicationId
      ) {
        throw new Error("The accepted reclaim does not match its durable prepared journal");
      }
      return {
        ...value,
        reclaim: checkpointReclaimFinality(reclaim, {
          phase: "accepted",
          acceptedBlock: result.receipt.inclusion.l1BlockNumber.toString(),
          acceptedBlockHash: result.receipt.inclusion.l1BlockHash,
        }, this.now()),
      };
    });
    return result.contentHash;
  }
}
