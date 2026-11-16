import { CopyButton } from "../../components/CopyButton.tsx";
import { EthereumAddress } from "../../components/EthereumAddress.tsx";
import { EtherAmount } from "../../components/EtherAmount.tsx";
import { ListingAmount, ListingAssetIdentity } from "./ListingAsset.tsx";
import { isNativeListing, listingAssetLabel } from "./listingAsset.ts";
import { Link } from "react-router-dom";
import { addressPath } from "../explorer/paths.ts";
import { publicationContractAddress, purchaseCutoff, type OfferPublication } from "@pcash/marketplace/app";
import { Notice } from "../../components/Notice.tsx";
import { addressHex } from "./presentation.ts";
import type { MarketplaceModel } from "./useMarketplace.ts";
import styles from "./MarketplaceRoute.module.css";

export function ListingDetails({
  publication,
  market,
}: {
  publication: OfferPublication;
  market: MarketplaceModel;
}) {
  const contractAddress = publicationContractAddress(publication);
  return (
    <details className={styles.advanced}>
      <summary>Listing details</summary>
      <div className={styles.advancedBody}>
        <ListingSummary publication={publication} market={market} contractAddress={contractAddress} />
        <div className={styles.offerActions}>
          <CopyButton className="button" value={market.listingLink(publication)} label="Copy listing link" showLabel />
          <Link to={addressPath(contractAddress)}>View contract</Link>
        </div>
      </div>
    </details>
  );
}

export function ListingSummary({ publication, market, contractAddress, includeAmounts = false }: {
  publication: OfferPublication;
  market: MarketplaceModel;
  contractAddress: string;
  includeAmounts?: boolean;
}) {
  const notices = market.sourceNotices.filter(notice => notice.address === contractAddress);
  const native = isNativeListing(publication);
  return <>
    <table className={styles.listingSummary} aria-label="Listing details">
      <tbody>
        {!native && <tr><th scope="row">Token</th><td><ListingAssetIdentity publication={publication} /></td></tr>}
        {includeAmounts && <>
          <tr><th scope="row">{listingAssetLabel(publication)} listed</th><td><ListingAmount publication={publication} /></td></tr>
          <tr><th scope="row">Total price</th><td><EtherAmount value={BigInt(publication.terms.ethPriceWei)} /></td></tr>
        </>}
        <tr><th scope="row">Seller</th><td><EthereumAddress address={addressHex(publication.terms.seller)} short /></td></tr>
        <tr><th scope="row">Buying closes</th><td>{new Date(Number(purchaseCutoff(BigInt(publication.terms.deadlineT))) * 1_000).toLocaleString()}</td></tr>
        <tr><th scope="row">Claim deadline</th><td>{new Date(Number(publication.terms.deadlineT) * 1_000).toLocaleString()}</td></tr>
        <tr><th scope="row">Payment router</th><td><EthereumAddress address={addressHex(publication.terms.router)} short /></td></tr>
      </tbody>
    </table>
    {notices.map((notice) => (
      <Notice key={notice.address}>
        <Link to={addressPath(notice.address)}>
          Listing <EthereumAddress address={notice.address} short />
        </Link>
        : {notice.message}
      </Notice>
    ))}
  </>;
}
