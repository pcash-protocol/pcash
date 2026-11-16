import { CopyButton } from "../../components/CopyButton.tsx";
import { publicationContractAddress, publicationIdentity } from "@pcash/marketplace/app";
import { Link } from "react-router-dom";
import { Notice } from "../../components/Notice.tsx";
import { PublicationProgress } from "./PublicationProgress.tsx";
import { ListingSummary } from "./ListingDetails.tsx";
import { listingAssetLabel } from "./listingAsset.ts";
import { addressPath } from "../explorer/paths.ts";
import { offerPath, downloadFundedPublication, downloadSourceOpenings } from "./presentation.ts";
import type { MarketplaceModel } from "./useMarketplace.ts";
import styles from "./MarketplaceRoute.module.css";

export function ListingResult({ market, onNewListing, onDone, onView }: {
  market: MarketplaceModel;
  onNewListing: () => void;
  onDone?: () => void;
  /** Opening the listing on this page closes the popup around this result. */
  onView?: () => void;
}) {
  const { created, tradePending } = market;
  if (created) {
    const contractAddress = publicationContractAddress(created.publication);
    return (
      <div className={styles.stack}>
        <p className="eyebrow">Listing live</p>
        <h2 id="trade-title">Your {listingAssetLabel(created.publication)} is listed</h2>
        <ListingSummary publication={created.publication} market={market} contractAddress={contractAddress} includeAmounts />
        <div className={styles.offerActions}>
          <CopyButton className="button" value={market.listingLink(created.publication)} label="Copy link" showLabel />
          <Link
            className="button"
            state={market.location.state}
            to={offerPath(created.publication)}
            onClick={onView}
          >
            View listing
          </Link>
          <Link className="button" to={addressPath(contractAddress)}>View contract</Link>
        </div>
        <details className={styles.advanced}>
          <summary>Export listing data</summary>
          <div className={styles.advancedBody}>
            <label>
              Portable listing link
              <textarea readOnly value={created.shareUrl} />
            </label>
            <div className={styles.offerActions}>
              <button
                onClick={() => downloadFundedPublication(created.publication)}
              >
                Download publication
              </button>
              <button onClick={() => downloadSourceOpenings(created.offer)}>
                Download source openings
              </button>
            </div>
          </div>
        </details>
        <div className={styles.offerActions}>
          <button className="button primary" onClick={onDone ?? onNewListing}>Done</button>
        </div>
      </div>
    );
  }
  // The listing this popup shows: a new one, or a saved one continued here.
  const shown = market.pendingPublication === undefined ? undefined : publicationIdentity(market.pendingPublication);
  const actionError = market.actionErrorFor((trade) => trade.action === "publish" && (trade.identity === undefined || trade.identity === shown));
  const progress = market.progress?.action === "publish" ? market.progress : {
    action: "publish" as const, phase: actionError ? "error" as const : "preparing" as const,
    elapsedMs: 0, message: actionError ?? "Preparing your listing…",
  };
  return <>
    {actionError && <Notice tone="error">{actionError}</Notice>}
    <PublicationProgress progress={progress} busy={tradePending} proof={market.proofProgress}
      awaitingSignature={market.awaitingSignature} confirmInWallet={market.confirmInWallet && market.activeTrade?.action === "publish"}
      pendingPublication={market.pendingPublication}
      onFinalize={market.finalize} inputs={market.listingInputs} />
  </>;
}
