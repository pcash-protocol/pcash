import { publicationIdentity, type MarketplaceActivityItem } from "@pcash/marketplace/app";
import { EtherAmount } from "../../components/EtherAmount.tsx";
import { ShoppingCartIcon } from "../../components/icons.tsx";
import { usePendingTransactionState } from "../../lib/usePendingTransactionState.ts";
import { ListingAmount } from "./ListingAsset.tsx";
import { listingUnit } from "./listingAsset.ts";
import { unitPriceWei } from "./listingPrice.ts";
import { OwnMark } from "./ListingTable.tsx";
import { marketplaceActivityStatus } from "./recoveryPresentation.ts";
import type { MarketplaceModel } from "./useMarketplace.ts";
import styles from "./MarketplaceRoute.module.css";

/** Steps whose saved transaction may still be pending; its state shows in place of the next step until it settles. */
const POSTABLE = ["funding-submitted", "publication-failed", "reclaim-prepared", "reclaim-failed"];

/** One of the owner's trades that waits on them, greyed out in the orderbook; opening it continues the trade. */
export function PendingRow({ market, item, onOpen }: { market: MarketplaceModel; item: MarketplaceActivityItem; onOpen: () => void }) {
  const running = market.running(item);
  const contentHash = item.contentHash !== undefined && POSTABLE.includes(item.phase) ? item.contentHash : undefined;
  const observation = usePendingTransactionState(contentHash);
  const transaction = contentHash === undefined ? undefined
    : observation.status === "error" ? "unavailable" : observation.data?.state ?? "checking";
  const phase = running ? market.progress?.phase : undefined;
  const status = running && (market.confirmInWallet || market.awaitingSignature) ? "Needs wallet approval"
    : phase === "proving" ? "Proving" : phase === "preparing" ? "Preparing" : phase === "submitting" ? "Submitting"
    : marketplaceActivityStatus(item, transaction);
  const unit = listingUnit(item.publication);
  const price = unitPriceWei(item.publication, unit.decimals);
  return <label className={`${styles.listingRow} ${styles.pendingRow}`} role="row" data-pending-trade={publicationIdentity(item.publication)}>
    <span role="cell">
      <button type="button" className={styles.pendingState} onClick={onOpen}>{status}</button>
      <ListingAmount publication={item.publication} />
      {item.role === "seller" ? <OwnMark label="Your listing" /> : <OwnMark label="Your purchase"><ShoppingCartIcon size={15} /></OwnMark>}
    </span>
    <span role="cell"><EtherAmount value={price.wei} approximate={price.approximate} /> <span className={styles.muted}>/ {unit.symbol}</span></span>
    <span role="cell"><EtherAmount value={BigInt(item.publication.terms.ethPriceWei)} /></span>
  </label>;
}
