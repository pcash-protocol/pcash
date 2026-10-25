import { Link } from "react-router-dom";
import type { OfferPublication } from "@pcash/marketplace/app";
import { TokenAmount } from "../../components/TokenAmount.tsx";
import type { FormatAmountOptions } from "../../components/tokenAmount.ts";
import { shortAssetId } from "../tokens/model.ts";
import { listingAsset, listingUnit } from "./listingAsset.ts";
import styles from "./MarketplaceRoute.module.css";

type Listing = Pick<OfferPublication, "terms" | "assetDefinition">;

/** An amount counted in the listing's asset: PCASH, the verified token, or raw units. */
export function ListingAmount({ publication, value, className, ...options }: FormatAmountOptions & {
  publication: Listing;
  value?: bigint;
  className?: string | undefined;
}) {
  return <TokenAmount className={className} value={value ?? BigInt(publication.terms.amount)} unit={listingUnit(publication)} {...options} />;
}

/** The listed token's verified identity with a link to its page; unverifiable definitions say so and nothing more. */
export function ListingAssetIdentity({ publication }: { publication: Listing }) {
  const asset = listingAsset(publication);
  if (asset.kind === "pcash") return <span>PCASH</span>;
  if (asset.kind === "unverified") {
    return <span className={styles.assetIdentity}><span className={`${styles.assetMark} ${styles.assetMarkWarning}`}>Unverified token</span> <code>{shortAssetId(asset.assetId)}</code></span>;
  }
  return <span className={styles.assetIdentity}>
    <Link to={asset.href}><strong>{asset.definition.metadata.symbol}</strong> {asset.definition.metadata.name}</Link>
    <span className={styles.assetMark} title="The listing's token definition derives its token ID.">✓ Verified</span>
  </span>;
}
