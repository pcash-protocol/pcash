// Narrow browser-application surface. Product hosts render and persist around
// the headless controller; low-level proving and checkpoint primitives stay on
// the package root for tooling and integration tests.

export {
  MarketplaceController,
  type MarketplaceBatchPurchase,
  type MarketplacePurchaseCheck,
  type MarketplacePurchaseQuote,
  type MarketplaceConfiguredRouter,
  type MarketplaceControllerOptions,
  type MarketplaceProgress,
  type MarketplaceProgressAction,
  type MarketplacePublicationOptions,
  type MarketplacePublishResult,
} from "./client/session.ts";
export {
  durableOfferPublications,
  hasCanonicalFunding,
  isCataloguedOffer,
  marketplaceBuyerKey,
  type MarketplaceStore,
  type StoredOffer,
} from "./client/offerPersistence.ts";
export {
  marketplaceActivity,
  marketplaceBuyerState,
  marketplaceSellerState,
  type MarketplaceActivityItem,
  type MarketplaceActivityStatus,
  type MarketplaceBuyerPhase,
  type MarketplaceBuyerState,
  type MarketplaceSellerPhase,
  type MarketplaceSellerState,
} from "./client/presentation.ts";
export { type MarketplaceOperationLock } from "./client/operationLock.ts";
export { fetchCatalogOffers, listingShareUrl, sharedOfferFromUrl } from "./client/catalog.ts";
export {
  offerKey,
  publicationAssetDefinition,
  publicationContractAddress,
  publicationIdentity,
  type OfferPublication,
} from "./client/publication.ts";
export { viemL1Signer } from "./client/l1Signer.ts";
export { InsufficientPaymentBalanceError } from "./client/buy.ts";
export { readEscrowSpend, type EscrowSpend } from "./client/claimFlow.ts";
export {
  normalizePaymentRouterConfig,
  PAYMENT_ROUTER_DEFAULT_FEE_BPS,
  PAYMENT_ROUTER_FEE_BPS_DENOMINATOR,
  quotePaymentRouterFee,
  verifyPaymentRouterDeployment,
  type PaymentRouterConfig,
  type PaymentRouterConfigInput,
  type PaymentRouterFeeQuote,
} from "./client/paymentRouter.ts";
export {
  marketplacePublicationSourceConfigurationOpenings,
  marketplaceSourceConfigurationOpenings,
} from "./sourceVerification.ts";
export { type Offer } from "./offer.mts";
export { type OfferVerification } from "./client/verification.ts";

export {
  PURCHASE_MARGIN_SECONDS,
  escrowCommitments,
  fetchOpenOffers,
  openForPurchase,
  purchaseCutoff,
} from "./client/offerAvailability.ts";
export { MIN_CLAIM_WINDOW_SECONDS, reclaimNotBefore } from "./commitments.mts";

export { purchaseBatches } from "./client/purchaseBatches.ts";
