import { useEffect, useRef, useState } from "react";
import { MIN_CLAIM_WINDOW_SECONDS, PURCHASE_MARGIN_SECONDS } from "@pcash/marketplace/app";
import { EtherAmount } from "../../components/EtherAmount.tsx";
import { PcashAmount } from "../../components/PcashAmount.tsx";
import { TokenAmount } from "../../components/TokenAmount.tsx";
import { withLeadingZero } from "../../components/pcashAmount.ts";
import { Notice } from "../../components/Notice.tsx";
import { Tooltip } from "../../components/Tooltip.tsx";
import { TradeWalletSetup } from "./TradeWalletSetup.tsx";
import { MarketplaceDialog } from "./MarketplaceDialog.tsx";
import { ListingResult } from "./ListingResult.tsx";
import { PURCHASE_WINDOWS } from "./presentation.ts";
import type { MarketplaceModel } from "./useMarketplace.ts";
import styles from "./MarketplaceRoute.module.css";

// Buying closes this long before the listing's claim deadline.
const CLAIM_ONLY_HOURS = Number(MIN_CLAIM_WINDOW_SECONDS + PURCHASE_MARGIN_SECONDS) / 3_600;

/** The Create listing button and the popup that holds the listing form, which its progress replaces once it is published. */
export function CreateListing({ market }: { market: MarketplaceModel }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const { location } = market;
  // Links to /marketplace#list-pcash open the popup.
  useEffect(() => {
    if (location.hash === "#list-pcash") setOpen(true);
  }, [location.key, location.hash]);
  const hasListing = market.listingInputs !== undefined || market.pendingPublication !== undefined || market.created !== undefined;
  // Once published, the listing's progress replaces the form. A listing that failed before any
  // of its transactions was saved leaves its draft editable, with the error under it.
  const publishing = market.tradePending && market.activeTrade?.action === "publish";
  const submitted = publishing || market.pendingPublication !== undefined || market.created !== undefined;
  const done = () => { setOpen(false); market.newListing(); };
  const close = () => {
    setOpen(false);
    if (market.created) market.newListing();
  };
  const result = <ListingResult market={market} onNewListing={market.newListing} onDone={done} onView={() => setOpen(false)} />;
  return <>
    <button type="button" className="button primary" ref={trigger} onClick={() => setOpen(true)}>
      {hasListing ? "View listing progress" : "Create listing"}
    </button>
    {/* Keep the listing mounted so closing the popup does not interrupt an approved submission. */}
    {(open || hasListing) && <MarketplaceDialog open={open} focusKey={hasListing} label="Create marketplace listing" closeLabel="Close listing" returnFocus={trigger} onClose={close}>
      <div id="list-pcash">
        {submitted ? result : <>
          <ListingForm market={market} />
          {hasListing && <div className={styles.listingStatus}>{result}</div>}
        </>}
      </div>
    </MarketplaceDialog>}
  </>;
}

function ListingForm({ market }: { market: MarketplaceModel }) {
  const {
    listingAmount,
    setListingAmount,
    listingAssetId,
    setListingAssetId,
    listableTokens,
    listingUnit,
    ethPrice,
    setEthPrice,
    purchaseMinutes,
    setPurchaseMinutes,
    sellerAmounts,
    sellerQuote,
    busy,
    ready,
    controller,
    configuration,
    create,
  } = market;
  const native = listingAssetId === 0n;
  const asset = listingUnit.symbol;
  const { amount } = sellerAmounts;
  const submit = (tipId: string) => (
    <button
      className={`button primary ${styles.primaryAction}`}
      disabled={
        busy ||
        controller === undefined ||
        configuration === undefined ||
        sellerQuote.quote === undefined ||
        amount === undefined ||
        sellerAmounts.shortfall === true ||
        sellerAmounts.error !== undefined
      }
      aria-describedby={tipId}
      type="submit"
    >
      Publish listing
    </button>
  );
  return (
    <>
      <p className="eyebrow">Sell {native ? "PCASH" : "a token"}</p>
      <h2 className={styles.listingTitle}>List your {asset}</h2>
      <p className={`${styles.muted} ${styles.listingIntro}`}>
        One amount. One price. A buyer takes the whole listing.
      </p>
      <form className={`${styles.form} ${styles.listingForm}`} onSubmit={create}>
        <div className={styles.fieldRow}>
          {listableTokens.length > 0 && <label className={styles.assetPicker}>
            What to sell
            <select value={listingAssetId.toString()}
              onChange={(event) => setListingAssetId(BigInt(event.target.value))}>
              <option value="0">PCASH</option>
              {listableTokens.map((token) => <option key={token.assetId.toString()} value={token.assetId.toString()}>
                {token.definition.metadata.symbol} · {token.definition.metadata.name}</option>)}
            </select>
          </label>}
          <label>
            {asset} amount
            <input
              required
              inputMode={native ? "numeric" : "decimal"}
              placeholder="0"
              value={listingAmount}
              onChange={(event) => setListingAmount(withLeadingZero(event.target.value))}
            />
          </label>
          <label>
            Total price in ETH
            <input
              required
              inputMode="decimal"
              placeholder="0.0"
              value={ethPrice}
              onChange={(event) => setEthPrice(withLeadingZero(event.target.value))}
            />
          </label>
          <label>
            Open for purchases for
            <select
              value={purchaseMinutes}
              onChange={(event) => setPurchaseMinutes(event.target.value)}
            >
              {Object.entries(PURCHASE_WINDOWS).map(([minutes, label]) => (
                <option key={minutes} value={minutes}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        </div>
        {sellerAmounts.shortfall && <p className={styles.fieldError}>Not enough PCASH</p>}
        {!native && <p className={styles.muted}>
          Listed with its verified definition, so buyers see its name, symbol and decimals. You have{" "}
          <TokenAmount value={listableTokens.find((token) => token.assetId === listingAssetId)?.spendable ?? 0n} unit={listingUnit} rounding="down" /> to list.
        </p>}
        {sellerAmounts.error && (
          <Notice tone="error">{sellerAmounts.error}</Notice>
        )}
        {sellerQuote.error && <Notice tone="error">{sellerQuote.error}</Notice>}
        {sellerQuote.loading && <p className={styles.muted}>Reading the router fee from Ethereum…</p>}
        <dl className={styles.listingQuote}>
          <dt>You receive</dt>
          <dd>
            {sellerQuote.quote ? (
              <EtherAmount value={sellerQuote.quote.sellerNetWei} />
            ) : (
              "—"
            )}
          </dd>
          {native ? <>
            <dt>Total PCASH committed</dt>
            <dd>{amount !== undefined ? <PcashAmount value={amount} /> : "—"}</dd>
          </> : <>
            <dt>{asset} committed</dt>
            <dd>{amount !== undefined ? <TokenAmount value={amount} unit={listingUnit} /> : "—"}</dd>
          </>}
          <dt>Website fee included in price</dt>
          <dd>
            {sellerQuote.quote ? (
              <EtherAmount value={sellerQuote.quote.websiteFeeWei} />
            ) : (
              "—"
            )}
          </dd>
        </dl>
        <p className={styles.listingNote}>
          {asset}{" "}
          stays locked until bought or reclaimed. When buying closes, the next{" "}
          {CLAIM_ONLY_HOURS} hours are kept for buyers to claim. Unsold {asset} can be
          reclaimed after that.
        </p>
        <p className={styles.listingNote}>
          When someone buys, the ETH goes straight to your Ethereum wallet. The listing shows your Ethereum address, the amount and the price.
        </p>
        <TradeWalletSetup />
        {ready && (
          <Tooltip block placement="top" tip="Approve two free signatures: one to create the listing’s escrow contract and one to fund it. Then approve one Ethereum transaction to publish both. Gas is paid in ETH.">
            {submit}
          </Tooltip>
        )}
      </form>
    </>
  );
}
