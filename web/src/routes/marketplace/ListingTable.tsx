import type { ReactNode } from "react";
import { publicationIdentity, type OfferPublication } from "@pcash/marketplace/app";
import { EtherAmount } from "../../components/EtherAmount.tsx";
import { UserCheckIcon } from "../../components/icons.tsx";
import { formatTokenExact } from "../../components/tokenAmount.ts";
import { ListingAmount } from "./ListingAsset.tsx";
import { listingAsset, listingUnit } from "./listingAsset.ts";
import { compareTotal, compareValue, unitPriceWei } from "./listingPrice.ts";
import styles from "./MarketplaceRoute.module.css";

export type ListingSort = "value" | "total";

/**
 * Open listings of every asset, each in its own unit. Totals compare across
 * assets; value compares only within one, so it groups by asset first.
 */
export function ListingTable({
  offers,
  pending = [],
  mine,
  hint,
  sort,
  onSort,
  selected,
  onToggle,
  selectable,
  busy = false,
}: {
  offers: OfferPublication[];
  /** The owner's unfinished trades, greyed out ahead of the open listings. */
  pending?: readonly ReactNode[];
  /** Listings the signed-in owner created. */
  mine: (offer: OfferPublication) => boolean;
  /** Why some rows cannot join the selection. */
  hint?: string | undefined;
  selected: ReadonlySet<string>;
  onToggle: (offer: OfferPublication) => void;
  /** Listings that can join the current selection. */
  selectable: (offer: OfferPublication) => boolean;
  sort: ListingSort;
  onSort: (sort: ListingSort) => void;
  busy?: boolean;
}) {
  const listings = [...offers].sort(sort === "total" ? compareTotal : (a, b) => compareAsset(a, b) || compareValue(a, b));
  const count = pending.length + listings.length;
  return (
    <>
      <div className={styles.toolbar}>
        <p className={styles.muted}>
          {count} {count === 1 ? "listing" : "listings"} ·
          {hint ?? "Select whole listings"}
        </p>
        <label className={styles.sort}>
          Sort by{" "}
          <select
            value={sort}
            onChange={(event) => onSort(event.target.value as ListingSort)}
          >
            <option value="value">Best value</option>
            <option value="total">Lowest total price</option>
          </select>
        </label>
      </div>
      {count === 0 ? (
        <div className={styles.empty}>
          <h2>No open listings</h2>
          <p>Be the first to list.</p>
        </div>
      ) : (
        <div className={styles.listingTable} role="table" aria-label="Available listings">
          <div className={styles.listingTableHeader} role="row"><span role="columnheader">Select / Amount</span><span role="columnheader">Price each</span><span role="columnheader">Total price</span></div>
          {pending}
          {listings.map(offer => {
            const id = publicationIdentity(offer);
            const unit = listingUnit(offer);
            const price = unitPriceWei(offer, unit.decimals);
            const disabled = busy || !(selected.has(id) || selectable(offer));
            return <label className={`${styles.listingRow} ${selected.has(id) ? styles.selectedRow : ""} ${disabled && !busy ? styles.unavailableRow : ""}`} key={id} role="row">
              <span role="cell"><input type="checkbox" checked={selected.has(id)} disabled={disabled} onChange={() => onToggle(offer)}
                data-listing-select={id} aria-label={`Select ${formatTokenExact(BigInt(offer.terms.amount), unit)}`} />
                <ListingAmount publication={offer} />{mine(offer) && <OwnMark label="Your listing" />}</span>
              <span role="cell"><EtherAmount value={price.wei} approximate={price.approximate} /> <span className={styles.muted}>/ {unit.symbol}</span></span>
              <span role="cell"><EtherAmount value={BigInt(offer.terms.ethPriceWei)} /></span>
            </label>;
          })}
        </div>
      )}
    </>
  );
}

/** Marks a row as the signed-in owner's own trade. */
export function OwnMark({ label, children = <UserCheckIcon size={15} /> }: { label: string; children?: ReactNode }) {
  return <span className={styles.ownMark} title={label}>{children}<span className="sr-only">{label}</span></span>;
}

/** PCASH first, then tokens by symbol. */
export function compareAsset(a: OfferPublication, b: OfferPublication): number {
  const left = listingAsset(a);
  const right = listingAsset(b);
  if (left.assetId === right.assetId) return 0;
  if (left.kind !== "token") return -1;
  if (right.kind !== "token") return 1;
  return left.label.localeCompare(right.label) || (left.assetId < right.assetId ? -1 : 1);
}
