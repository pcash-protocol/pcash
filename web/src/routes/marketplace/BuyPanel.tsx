import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { InsufficientPaymentBalanceError, openForPurchase, publicationIdentity, type MarketplaceActivityItem, type MarketplacePurchaseCheck, type MarketplacePurchaseQuote, type OfferPublication } from "@pcash/marketplace/app";
import { EtherAmount } from "../../components/EtherAmount.tsx";
import { friendlyError } from "../../components/friendlyError.ts";
import { UserCheckIcon } from "../../components/icons.tsx";
import { Notice } from "../../components/Notice.tsx";
import { PCASH_UNIT } from "../../components/pcashAmount.ts";
import { TokenAmount } from "../../components/TokenAmount.tsx";
import type { AmountUnit } from "../../components/tokenAmount.ts";
import { ProofProgress } from "../../components/ProofProgress.tsx";
import { TransactionDetails } from "../../components/TransactionDetails.tsx";
import { GasWarning, PaymentShortfallWarning, useGasGuard, type GasShortfall } from "../../lib/gasGuard.tsx";
import { useWallet } from "../../lib/WalletProvider.tsx";
import { listingAsset, listingAssetLabel, listingUnit } from "./listingAsset.ts";
import { offerPath } from "./presentation.ts";
import { compareAsset, ListingTable, type ListingSort } from "./ListingTable.tsx";
import { MarketplaceDialog } from "./MarketplaceDialog.tsx";
import { PendingRow } from "./PendingRow.tsx";
import { PurchaseReceipt } from "./PurchaseReceipt.tsx";
import { SellerListingPanel } from "./SellerListingPanel.tsx";
import { TokenFilter, type TokenOption } from "./TokenFilter.tsx";
import { TradeWalletSetup } from "./TradeWalletSetup.tsx";
import { ConfirmInWallet } from "./ConfirmInWallet.tsx";
import type { MarketplaceModel } from "./useMarketplace.ts";
import { useNowSeconds } from "./useNowSeconds.ts";
import styles from "./MarketplaceRoute.module.css";

export function BuyPanel({ market, quoteAttempt }: {
  market: MarketplaceModel;
  /** Counts explicit refreshes, so the selection's quote is read again. */
  quoteAttempt: number;
}) {
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
  const [sort, setSort] = useState<ListingSort>("value");
  // Every token by default; the filter narrows the listings to the tokens checked in it.
  const [tokenKeys, setTokenKeys] = useState<ReadonlySet<string>>(new Set());
  const [onlyMine, setOnlyMine] = useState(false);
  // The saved listing whose popup is open, by its activity key.
  const [opened, setOpened] = useState<string>();
  const navigate = useNavigate();
  const owner = market.profile?.address;
  const mine = (offer: OfferPublication) => owner !== undefined && BigInt(offer.reclaimAuthority) === owner;
  const catalogOffers = market.currentCatalog?.offers;
  const pending = market.todos;
  const nowSeconds = useNowSeconds();
  const { open, assets, unverified } = useMemo(() => {
    const assets = new Map<string, TokenOption & { href?: string }>();
    let unverified = 0;
    // A listing with a trade that waits on its owner shows once, as that trade.
    const waiting = new Set(pending.map((item) => publicationIdentity(item.publication)));
    const open = (catalogOffers ?? []).filter((offer) => {
      if (listingAsset(offer).kind === "unverified") { unverified++; return false; }
      return offer.escrow !== undefined && openForPurchase(offer, nowSeconds) && !waiting.has(publicationIdentity(offer));
    }).sort(compareAsset);
    for (const offer of [...pending.map((item) => item.publication), ...open]) {
      const asset = listingAsset(offer);
      if (asset.kind === "unverified") continue;
      const key = assetKeyOf(offer);
      const known = assets.get(key);
      if (known !== undefined) { known.listings++; continue; }
      assets.set(key, asset.kind === "token"
        ? { key, label: asset.label, name: asset.definition.metadata.name, href: asset.href, listings: 1 }
        : { key, label: asset.label, name: "PCASH", listings: 1 });
    }
    return { open, assets: [...assets.values()], unverified };
  }, [catalogOffers, pending, nowSeconds]);
  // A checked token whose listings have all closed no longer narrows anything.
  const chosen = new Set(assets.filter((asset) => tokenKeys.has(asset.key)).map((asset) => asset.key));
  const about = chosen.size === 1 ? assets.find((asset) => chosen.has(asset.key)) : undefined;
  const ofChosenToken = (offer: OfferPublication) => chosen.size === 0 || chosen.has(assetKeyOf(offer));
  const shown = open.filter((offer) => ofChosenToken(offer) && (!onlyMine || mine(offer)));
  const shownPending = pending.filter((item) => ofChosenToken(item.publication));
  // A saved listing continues in a popup; a purchase continues at its listing's checkout.
  const openTrade = (item: MarketplaceActivityItem) => item.role === "seller" ? setOpened(item.key)
    : navigate(offerPath(item.publication), { state: market.location.state });
  const openedItem = opened === undefined ? undefined : market.activity.find((item) => item.key === opened);
  // A seller step's outcome shows in its listing's panel while that is open, and here once it closes.
  const message = openedItem === undefined && market.selectedActivity === undefined
    ? market.messageFor((trade) => trade.identity !== undefined && trade.action !== "buy") : undefined;
  const batch = market.batchPurchase;
  // A submitted purchase keeps its listings and result on screen until Done, even as they leave the catalog.
  const locked = batch !== undefined && batch.error === undefined;
  // Selection survives filtering, so Buy always takes exactly what the bar shows. One purchase buys one asset.
  const selected = open.filter((offer) => selectedIds.has(publicationIdentity(offer)));
  const selectedAsset = selected[0] === undefined ? undefined : assetKeyOf(selected[0]);
  const hint = selected[0] !== undefined && shown.some((offer) => assetKeyOf(offer) !== selectedAsset)
    ? `One asset per purchase: you have ${listingAssetLabel(selected[0])} selected` : undefined;
  const purchased = locked ? batch.publications : selected;
  const unit = purchased[0] === undefined ? PCASH_UNIT : listingUnit(purchased[0]);
  // The listings, and beside them the purchase panel, which is always there and fills as listings are selected.
  return <section className={styles.orderbook} aria-label="Listings">
    <div className={styles.orderbookListings}>
      {(open.length > 0 || pending.length > 0) && <div className={styles.listingFilters}>
        <TokenFilter options={assets} selected={chosen} onChange={setTokenKeys} />
        {owner !== undefined && <label className={styles.mineToggle}>
          <input type="checkbox" checked={onlyMine} onChange={(event) => setOnlyMine(event.target.checked)} />
          <UserCheckIcon size={15} /> Only my listings
        </label>}
      </div>}
      {about?.href !== undefined && <p className={styles.muted}>Token names and decimals are shown only when the listing’s definition matches its token ID. <Link to={about.href}>About {about.label}</Link></p>}
      {unverified > 0 && <p className={styles.muted}>{unverified} {unverified === 1 ? "listing is" : "listings are"} hidden because {unverified === 1 ? "its" : "their"} token definition does not match the token ID.</p>}
      {message && <Notice tone="success">{message}</Notice>}
      {market.currentCatalog?.error && <Notice tone="error">Could not check open listings. {market.currentCatalog.error}</Notice>}
      {market.currentCatalog?.offers === undefined && !market.currentCatalog?.error && <p role="status">{market.loading ? "Loading listings…" : "Checking listings…"}</p>}
      {/* The owner's saved trades come from this browser, so they show before and without the catalog. */}
      {(market.currentCatalog?.offers !== undefined || pending.length > 0) && <ListingTable offers={shown} hint={hint} mine={mine}
          pending={shownPending.map((item) => <PendingRow key={item.key} market={market} item={item} onOpen={() => openTrade(item)} />)}
          selected={selectedIds} onToggle={offer => {
            const id = publicationIdentity(offer);
            setSelectedIds(previous => { const next = new Set(previous); if (!next.delete(id)) next.add(id); return next; });
          }} selectable={(offer) => selectedAsset === undefined || assetKeyOf(offer) === selectedAsset}
          sort={sort} onSort={setSort} busy={market.busy || locked} />}
    </div>
    <aside className={styles.purchasePanel} aria-label="Purchase">
      {batch?.results === undefined && <h3 className={styles.purchaseTitle}>Your purchase</h3>}
      {selected.length > 0 || batch !== undefined ? <PurchaseBar market={market} selected={purchased} locked={locked}
        unit={unit} quoteAttempt={quoteAttempt} onDone={() => { market.closeBatchPurchase(); setSelectedIds(new Set()); }} />
        : <p className={styles.muted}>Select listings to see their total with gas, then buy them together. One asset per purchase.</p>}
    </aside>
    {/* A discarded listing leaves the owner's trades, and its popup closes with it. */}
    {openedItem?.role === "seller" && <MarketplaceDialog label="Your listing" closeLabel="Close listing" onClose={() => setOpened(undefined)}>
      <SellerListingPanel market={market} item={openedItem} />
    </MarketplaceDialog>}
  </section>;
}

/** What the selected listings cost, the button that buys them, and the purchase's progress and result under it, in the purchase panel. */
function PurchaseBar({ market, selected, locked, unit, quoteAttempt, onDone }: {
  market: MarketplaceModel; selected: OfferPublication[]; locked: boolean; unit: AmountUnit; quoteAttempt: number; onDone: () => void;
}) {
  const paymentBalance = useWallet().l1Balance;
  const batch = market.batchPurchase;
  const running = locked && batch?.results === undefined;
  const quoting = !market.busy && !locked;
  // The quote follows what is selected, not the clock or a background recheck.
  const selectedKey = selected.map(publicationIdentity).join(":");
  // Verified listings enable Buy while their gas figures fill in, unless the
  // exact payment alone already exceeds the wallet's ETH balance. The purchase
  // itself verifies, quotes and checks the ETH it needs again.
  const [quoted, setQuoted] = useState<{ key: string; check?: MarketplacePurchaseCheck; quote?: MarketplacePurchaseQuote; paymentShortfall?: GasShortfall; error?: string }>();
  useEffect(() => {
    if (!market.ready || !market.controller || !quoting) return;
    let current = true;
    // Keep showing the previous quote for this selection until the new one arrives.
    void market.controller.quotePurchases(selected, {
      onChecked: check => {
        if (current) setQuoted(previous => ({ key: selectedKey, check, ...(previous?.key === selectedKey && previous.quote ? { quote: previous.quote } : {}) }));
      },
    }).then(quote => { if (current) setQuoted({ key: selectedKey, check: quote, quote }); }, cause => {
      if (!current) return;
      setQuoted(previous => cause instanceof InsufficientPaymentBalanceError
        ? {
            key: selectedKey,
            ...(previous?.key === selectedKey && previous.check !== undefined ? { check: previous.check } : {}),
            paymentShortfall: { balanceWei: cause.balanceWei, requiredWei: cause.paymentWei },
          }
        : {
            key: selectedKey,
            ...(previous?.key === selectedKey && previous.check !== undefined ? { check: previous.check } : {}),
            error: friendlyError(cause),
          });
    });
    return () => { current = false; };
  }, [market.controller, market.ready, quoting, selectedKey, quoteAttempt, paymentBalance]);
  const shown = market.ready && quoted?.key === selectedKey ? quoted : undefined;
  const { check, quote, error } = shown ?? {};
  // The controller's fresh L1 read is authoritative. The polled balance above
  // only retriggers the quote after funding arrives.
  const paymentShortfall = shown?.paymentShortfall;
  const amount = selected.reduce((sum, offer) => sum + BigInt(offer.terms.amount), 0n);
  const listedPrice = selected.reduce((sum, offer) => sum + BigInt(offer.terms.ethPriceWei), 0n);
  // Each buy() carries its own claim, so the router calls' gas is the whole cost.
  const estimatedGas = quote?.estimatedGasWei;
  const maximumGas = quote?.maximumGasWei;
  const gas = useGasGuard(market.ready && quoting, check !== undefined && maximumGas !== undefined ? check.paymentWei + maximumGas : undefined);
  const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;
  const asset = batch?.publications[0] === undefined ? unit.symbol : listingAssetLabel(batch.publications[0]);
  // A finished purchase replaces the panel: the quote, Buy and progress are history.
  if (batch?.results !== undefined) return <PurchaseReceipt market={market} items={batch.results} onDone={onDone} />;
  return <>
    {error && <div className={styles.purchaseError}><Notice tone="error">{error}</Notice></div>}
    {paymentShortfall && <div className={styles.purchaseError}><PaymentShortfallWarning shortfall={paymentShortfall} /></div>}
    {!paymentShortfall && gas.shortfall && <div className={styles.purchaseError}><GasWarning shortfall={gas.shortfall} action="Buy" /></div>}
    {selected.length > 0 && <><div className={styles.purchaseSummary}>
      <strong>{plural(selected.length, "listing")} · <TokenAmount value={amount} unit={unit} /></strong>
      <span>{quote !== undefined && estimatedGas !== undefined ? <>≈ <EtherAmount value={quote.paymentWei + estimatedGas} /> incl. gas</>
        : !market.ready || locked ? <>Price <EtherAmount value={listedPrice} /> plus gas</>
        : paymentShortfall ? <><EtherAmount value={check?.paymentWei ?? listedPrice} /> plus gas</>
        : error ? "—"
        : check ? <><EtherAmount value={check.paymentWei} /> plus gas (estimating…)</>
        : "Checking listings…"}</span>
      {check && <small className={styles.muted}>Includes website fee <EtherAmount value={check.websiteFeeWei} /> · No relayer fee</small>}
      <small className={styles.muted}>Your Ethereum address, the price and the amount are public.</small>
      <details className={styles.advanced}><summary>Fee breakdown</summary>
        <dl className={styles.purchaseTotals} aria-label="Purchase totals">
          <dt>ETH payment (includes website fee)</dt><dd><EtherAmount value={check?.paymentWei ?? listedPrice} /></dd>
          {check && <><dt>Website fee</dt><dd><EtherAmount value={check.websiteFeeWei} /></dd></>}
          <dt>Estimated gas</dt><dd>{estimatedGas !== undefined ? <EtherAmount value={estimatedGas} /> : paymentShortfall ? "Not estimated: payment exceeds balance" : error ? "Unavailable" : "Estimating…"}</dd>
          {maximumGas !== undefined && <><dt>Maximum gas at current fee caps</dt><dd><EtherAmount value={maximumGas} /></dd></>}
        </dl>
        <p className={styles.muted}>{plural(selected.length, "Ethereum transaction")}, each paying for one listing and carrying its claim. Estimates may change.</p>
      </details>
    </div>
    {!market.ready ? <TradeWalletSetup /> : <button type="button" className={`button primary ${styles.purchaseAction}`}
      disabled={locked || market.busy || check === undefined || paymentShortfall !== undefined || error !== undefined || !!market.currentCatalog?.error}
      onClick={() => { if (gas.proceed()) market.buySelected(selected); }}>{running ? "Buying…" : "Buy"}</button>}</>}
    {running && market.confirmInWallet && <ConfirmInWallet />}
    {batch && <section className={styles.purchaseStatus} aria-label="Purchase status">
      {batch.error !== undefined ? <>
        <Notice tone="error">{batch.error} Your progress is saved. Continue any interrupted purchase from its row in the orderbook.</Notice>
        <div className={styles.statusActions}><button type="button" className="button" onClick={market.closeBatchPurchase}>Dismiss</button></div>
      </> : <>
        <ProofProgress proof={market.proofProgress} awaitingSignature={market.awaitingSignature} label={`Buying ${asset}`} detail={market.progress?.message} />
        <TransactionDetails proof={market.proofProgress} message={market.progress?.message} />
      </>}
    </section>}
  </>;
}

function assetKeyOf(offer: OfferPublication): string {
  return BigInt(offer.terms.assetId).toString();
}
