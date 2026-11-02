import { useState } from "react";
import { BuyPanel } from "./BuyPanel.tsx";
import { CreateListing } from "./CreateListing.tsx";
import type { MarketplaceModel } from "./useMarketplace.ts";
import styles from "./MarketplaceRoute.module.css";

/** Every open listing, with the signed-in owner's trades that wait on them among them. */
export function MarketplaceListings({ market }: { market: MarketplaceModel }) {
  const [refreshes, setRefreshes] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const refresh = () => {
    setRefreshing(true);
    void market.refresh(false, true).finally(() => setRefreshing(false));
    market.retryVerification();
    setRefreshes((count) => count + 1);
  };
  return <>
    {/* Not a .toolbar: the Create listing popup renders inside this header. */}
    <div className={styles.listingsHeader}>
      <h2 className={styles.listingsTitle}>Orderbook</h2>
      <div className={styles.offerActions}>
        {/* Background reads can take a while behind wallet work; only a Refresh the user asked for shows as busy. */}
        <button type="button" className={`button ${styles.refresh}`} aria-busy={refreshing || market.checkingListings} onClick={refresh}>Refresh</button>
        <CreateListing market={market} />
      </div>
    </div>
    <BuyPanel market={market} quoteAttempt={refreshes} />
  </>;
}
