import { publicationContractAddress,
  listingShareUrl,
  marketplaceSourceConfigurationOpenings,
  type MarketplaceActivityItem,
  type Offer,
  type OfferPublication,
} from "@pcash/marketplace/app";
import { stringify } from "viem";
import { parsePcashAmount } from "../../components/pcashAmount.ts";
import { isNativeListing, listingAssetLabel } from "./listingAsset.ts";

/** How long a new listing stays open for purchases, in minutes. */
export const PURCHASE_WINDOWS = {
  "30": "30 minutes",
  "60": "1 hour",
  "1440": "1 day",
  "10080": "1 week",
  "43200": "30 days",
} as const;

/** A listing's page: its checkout, or its seller's view of it. */
export function offerPath(publication: OfferPublication): string {
  return `/marketplace?offer=${publicationContractAddress(publication).toLowerCase()}`;
}

export function offerShareUrl(publication: OfferPublication): string {
  return new URL(offerPath(publication), window.location.origin).href;
}

export function portableOfferUrl(publication: OfferPublication): string {
  const url = new URL(offerShareUrl(publication));
  url.searchParams.set("publication", new URL(listingShareUrl(publication, url.href)).hash.slice(1));
  return url.href;
}

export function asBigint(
  value: string,
  label: string,
  allowZero = false,
): bigint {
  let parsed: bigint;
  try {
    parsed = BigInt(value);
  } catch {
    throw new Error(`${label} must be an integer`);
  }
  if (allowZero ? parsed < 0n : parsed <= 0n) {
    throw new Error(
      `${label} must be ${allowZero ? "nonnegative" : "positive"}`,
    );
  }
  return parsed;
}

export function asPcash(
  value: string,
  label: string,
  allowZero = false,
): bigint {
  return parsePcashAmount(value, { label, allowZero });
}

export function addressHex(value: string): string {
  try {
    return `0x${BigInt(value).toString(16).padStart(40, "0")}`;
  } catch {
    return value;
  }
}

export function saveJson(name: string, value: unknown): void {
  const text = stringify(value, null, 2);
  const url = URL.createObjectURL(
    new Blob([`${text}\n`], { type: "application/json" }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

export function downloadSourceOpenings(offer: Offer): void {
  const openings = marketplaceSourceConfigurationOpenings({
    address: offer.l2ContractAddress,
    reclaimAuthority: offer.reclaimAuthority,
    claimConfigurationSalt: offer.claimConfigurationSalt,
    reclaimConfigurationSalt: offer.reclaimConfigurationSalt,
    terms: offer.terms,
    network: offer.network,
  });
  saveJson(
    `pcash-marketplace-${offer.terms.id}-source-openings.json`,
    openings,
  );
}

export function downloadFundedPublication(publication: OfferPublication): void {
  saveJson(
    `pcash-marketplace-${BigInt(publication.terms.id)}-funded-publication.json`,
    publication,
  );
}

export function activityTitle(item: MarketplaceActivityItem): string {
  if (item.role === "seller" && ["action-required", "failed"].includes(item.status)) return "Listing needs attention";
  const asset = listingAssetLabel(item.publication);
  const labels: Record<MarketplaceActivityItem["phase"], string> = {
    "recovery-unavailable": "Waiting for escrow funding",
    draft: "Creating listing",
    "funding-submitted": "Creating listing",
    finalizing: "Creating listing",
    funded: "Listing live",
    "publication-failed": "Listing needs attention",
    "reclaim-prepared": `Returning ${asset}`,
    "reclaim-accepted": "Return pending",
    reclaimed: `${asset} returned`,
    "reclaim-failed": "Return needs attention",
    selected: "Purchase started",
    "payment-ambiguous": "Payment outcome unknown",
    "payment-pending": "Payment pending",
    paid: `Receiving ${asset}`,
    "claim-accepted": `Receiving ${asset}`,
    claimed: "Purchase complete",
  };
  return labels[item.phase] ?? item.phase;
}
