// Pure Marketplace seed preparation. No node, wallet store, prover, catalog,
// or L1 call is performed here; execution layers decide when each dependency
// wave is ready to submit.

import {
  toAddressField,
  toField,
  toNonnegativeBigInt,
  type NetworkConfigLike,
} from "@pcash/sdk/browser";
import type { ConfigurationOpening } from "@pcash/sdk/source-verification";
import type { PcashProfile } from "@pcash/sdk/wallet";
import {
  MIN_CLAIM_WINDOW_SECONDS,
  CLAIM_APPLICATION_VK_HASH,
  RECLAIM_APPLICATION_VK_HASH,
} from "../commitments.mts";
import { createOffer, type Offer } from "../offer.mts";
import { publicationFromOffer, type OfferPublication } from "../client/publication.ts";
import { marketplaceSourceConfigurationOpenings } from "../sourceVerification.ts";

// Seeded listings stay open for new purchases for about half an hour.
export const DEFAULT_SEED_PAID_DEADLINE_LEAD_SECONDS = MIN_CLAIM_WINDOW_SECONDS + 3_600n;
export const DEFAULT_SEED_UNPAID_DEADLINE_LEAD_SECONDS = MIN_CLAIM_WINDOW_SECONDS + 3_600n;

export interface MarketplaceSeedOfferEntropy {
  l2ContractNkRoot: bigint;
}

export interface MarketplaceSeedOfferAmounts {
  pcashAmount: bigint;
  ethPriceWei: bigint;
}

export interface MarketplaceSeedOfferInput {
  entropy: MarketplaceSeedOfferEntropy;
  amounts: MarketplaceSeedOfferAmounts;
  deadlineLeadSeconds?: bigint;
}

export interface PrepareMarketplaceSeedOffersParams {
  network: NetworkConfigLike;
  seller: {
    wallet: PcashProfile;
    /** Ethereum address that receives PaymentRouter proceeds. */
    paymentAddress: bigint;
  };
  router: bigint;
  latestL1Timestamp: bigint;
  paid: MarketplaceSeedOfferInput;
  unpaid: MarketplaceSeedOfferInput;
}

export interface PreparedMarketplaceSeedOffer {
  offer: Offer;
  sourceOpenings: ConfigurationOpening[];
  /** Unfunded catalog publication; execution attaches the escrow opening later. */
  publication: OfferPublication;
}

export interface PreparedMarketplaceSeedOffers {
  paid: PreparedMarketplaceSeedOffer;
  unpaid: PreparedMarketplaceSeedOffer;
  sourceOpenings: ConfigurationOpening[];
  publications: readonly [OfferPublication, OfferPublication];
}

function positive(value: bigint, label: string): bigint {
  const result = toNonnegativeBigInt(value, label);
  if (result === 0n) throw new Error(`${label} must be positive`);
  return result;
}

function prepareOffer(params: {
  network: NetworkConfigLike;
  sellerWallet: PcashProfile;
  paymentAddress: bigint;
  router: bigint;
  latestL1Timestamp: bigint;
  input: MarketplaceSeedOfferInput;
  deadlineLeadSeconds: bigint;
  label: "paid" | "unpaid";
}): PreparedMarketplaceSeedOffer {
  const entropy = params.input.entropy;
  const terms = {
    router: params.router,
    seller: params.paymentAddress,
    assetId: 0n,
    amount: positive(params.input.amounts.pcashAmount, `${params.label}.amounts.pcashAmount`),
    ethPriceWei: positive(params.input.amounts.ethPriceWei, `${params.label}.amounts.ethPriceWei`),
    deadlineT: params.latestL1Timestamp + params.deadlineLeadSeconds,
  };
  const offer = createOffer({
    network: params.network,
    terms,
    sellerWallet: params.sellerWallet,
    l2ContractNkRoot: toField(
      entropy.l2ContractNkRoot,
      `${params.label}.entropy.l2ContractNkRoot`,
    ),
    claimApplicationVkHash: CLAIM_APPLICATION_VK_HASH,
    reclaimApplicationVkHash: RECLAIM_APPLICATION_VK_HASH,
  });
  const sourceOpenings = marketplaceSourceConfigurationOpenings({
    address: offer.l2ContractAddress,
    reclaimAuthority: offer.reclaimAuthority,
    claimConfigurationSalt: offer.claimConfigurationSalt,
    reclaimConfigurationSalt: offer.reclaimConfigurationSalt,
    terms: offer.terms,
    network: offer.network,
  });
  return {
    offer,
    sourceOpenings,
    publication: publicationFromOffer(offer),
  };
}

/** Prepare two deterministic offers and every state-free artifact the seed can publish up front. */
export function prepareMarketplaceSeedOffers(
  params: PrepareMarketplaceSeedOffersParams,
): PreparedMarketplaceSeedOffers {
  const router = toAddressField(params.router, "router");
  const paymentAddress = toAddressField(params.seller.paymentAddress, "seller.paymentAddress");
  const latestL1Timestamp = toNonnegativeBigInt(params.latestL1Timestamp, "latestL1Timestamp");
  const paidDeadlineLeadSeconds = positive(
    params.paid.deadlineLeadSeconds ?? DEFAULT_SEED_PAID_DEADLINE_LEAD_SECONDS,
    "paid.deadlineLeadSeconds",
  );
  const unpaidDeadlineLeadSeconds = positive(
    params.unpaid.deadlineLeadSeconds ?? DEFAULT_SEED_UNPAID_DEADLINE_LEAD_SECONDS,
    "unpaid.deadlineLeadSeconds",
  );
  if (paidDeadlineLeadSeconds < MIN_CLAIM_WINDOW_SECONDS + 300n) {
    throw new Error(`paid deadline lead must be at least ${MIN_CLAIM_WINDOW_SECONDS + 300n} seconds`);
  }
  if (unpaidDeadlineLeadSeconds < MIN_CLAIM_WINDOW_SECONDS) {
    throw new Error(`unpaid deadline lead must be at least ${MIN_CLAIM_WINDOW_SECONDS} seconds`);
  }
  if (params.paid.entropy.l2ContractNkRoot === params.unpaid.entropy.l2ContractNkRoot) {
    throw new Error("paid and unpaid offer entropy must use distinct l2ContractNkRoot values");
  }

  const common = {
    network: params.network,
    sellerWallet: params.seller.wallet,
    paymentAddress,
    router,
    latestL1Timestamp,
  };
  const paid = prepareOffer({
    ...common,
    input: params.paid,
    deadlineLeadSeconds: paidDeadlineLeadSeconds,
    label: "paid",
  });
  const unpaid = prepareOffer({
    ...common,
    input: params.unpaid,
    deadlineLeadSeconds: unpaidDeadlineLeadSeconds,
    label: "unpaid",
  });
  if (paid.offer.l2ContractAddress === unpaid.offer.l2ContractAddress) {
    throw new Error("paid and unpaid entropy produced the same L2 contract address");
  }
  return {
    paid,
    unpaid,
    sourceOpenings: [...paid.sourceOpenings, ...unpaid.sourceOpenings],
    publications: [paid.publication, unpaid.publication],
  };
}
