import { publicationContractAddress, publicationIdentity, type MarketplaceActivityItem } from "@pcash/marketplace/app";
import { MempoolFinalization } from "../../components/MempoolFinalization.tsx";
import { TransactionDetails } from "../../components/TransactionDetails.tsx";
import { ProofProgress } from "../../components/ProofProgress.tsx";
import { ProgressIndicator } from "../../components/ProgressIndicator.tsx";
import { EtherAmount } from "../../components/EtherAmount.tsx";
import { friendlyError } from "../../components/friendlyError.ts";
import { Notice } from "../../components/Notice.tsx";
import { ListingAmount } from "./ListingAsset.tsx";
import { listingAssetLabel } from "./listingAsset.ts";
import { ConfirmInWallet } from "./ConfirmInWallet.tsx";
import { PublicationProgress } from "./PublicationProgress.tsx";
import { ListingDetails } from "./ListingDetails.tsx";
import { TradeWalletSetup } from "./TradeWalletSetup.tsx";
import { marketplaceActivityAction, marketplaceActionLabel } from "./recoveryPresentation.ts";
import { activityTitle } from "./presentation.ts";
import { useListingSales } from "./sales.ts";
import type { MarketplaceModel } from "./useMarketplace.ts";
import styles from "./MarketplaceRoute.module.css";

/** One of the owner's saved listings, with its next step. */
export function SellerListingPanel({ market, item }: { market: MarketplaceModel; item: MarketplaceActivityItem }) {
  // A funded listing whose escrow is spent with no reclaim recorded sold: a buyer's claim took it, and nothing is left to reclaim.
  const sold = useListingSales(["funded", "publication-failed"].includes(item.phase) && item.publication.escrow !== undefined
    ? [item.publication] : []).size > 0;
  const action = sold ? undefined : marketplaceActivityAction(item);
  const identity = publicationIdentity(item.publication);
  const itemAddress = publicationContractAddress(item.publication);
  const publishing = market.tradePending && market.activeTrade?.action === "publish" &&
    (market.progress?.publication?.offerAddress === itemAddress ||
      market.activeTrade.identity === identity);
  const waiting = (market.pendingPublication && publicationContractAddress(market.pendingPublication)) === itemAddress;
  if (market.progress?.action === "publish" && market.progress.phase !== "error" && (publishing || waiting)) {
    return <PublicationProgress progress={market.progress} busy={market.tradePending}
      proof={market.proofProgress} awaitingSignature={market.awaitingSignature} confirmInWallet={market.confirmInWallet}
      pendingPublication={item.publication} />;
  }
  const reclaiming = market.tradePending && market.activeTrade?.action === "reclaim" && market.activeTrade.identity === identity;
  const asset = listingAssetLabel(item.publication);
  const error = market.actionErrorFor((trade) => trade.identity === identity)
    ?? (item.error === undefined ? undefined : friendlyError(item.error));
  const message = market.messageFor((trade) => trade.identity === identity && trade.action !== "buy");
  // A listing whose escrow funding never started holds nothing and can be dropped.
  const discardable = item.phase === "draft" || item.phase === "contract-submitted";
  const discard = () => {
    if (window.confirm("Discard this listing? Its escrow was never funded, so nothing is locked in it.")) market.discardListing(item);
  };
  return <div className={styles.stack}>
    <p className="eyebrow">Your listing</p>
    <h2 id="trade-title">{sold ? "Listing sold" : activityTitle(item)}</h2>
    <dl className={styles.totals}>
      <dt>{asset} listed</dt><dd><ListingAmount publication={item.publication} /></dd>
      <dt>Total price</dt><dd><EtherAmount value={BigInt(item.publication.terms.ethPriceWei)} /></dd>
    </dl>
    {item.contentHash && ["funding-submitted", "publication-failed", "reclaim-prepared", "reclaim-failed"].includes(item.phase) && <MempoolFinalization key={item.contentHash} contentHash={item.contentHash} onConfirmed={() => market.runActivityAction(item)} />}
    {action && <>
      <p>{action === "reclaim" ? `Return unsold ${asset} to your wallet.` : action === "restore-contract" ? "Create the missing escrow contract, then reclaim after the deadline." : "Your progress is saved. Continue and we’ll take care of the remaining work."}</p>
      <TradeWalletSetup />
      {market.ready && <div className={styles.offerActions}>
        <button className="button primary" disabled={market.busy} onClick={() => market.runActivityAction(item)}>
          {market.busy ? "Working…" : marketplaceActionLabel(item, action)}
        </button>
        {discardable && <button className="button" disabled={market.busy} onClick={discard}>Discard</button>}
      </div>}
    </>}
    {reclaiming && !(market.progress?.phase === "confirming" && item.contentHash) && (market.confirmInWallet ? <ConfirmInWallet />
      : market.progress?.phase === "proving" || market.awaitingSignature ? <ProofProgress proof={market.proofProgress} awaitingSignature={market.awaitingSignature} />
      : <div role="status"><p>Preparing and confirming the return to your wallet…</p><ProgressIndicator label={`Returning ${asset}`} detail="Preparing and confirming the return to your wallet…" /></div>)}
    {error && <Notice tone="error">{error}</Notice>}
    {message && <Notice tone="success">{message}</Notice>}
    <ListingDetails publication={item.publication} market={market} />
    <TransactionDetails proof={reclaiming ? market.proofProgress : undefined}
      message={reclaiming ? market.progress?.message : undefined} contentHash={item.contentHash} />
  </div>;
}
