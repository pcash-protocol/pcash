import { InsufficientPaymentBalanceError, openForPurchase, publicationIdentity, purchaseCutoff } from "@pcash/marketplace/app";
import { useEffect, useState } from "react";
import { TransactionDetails } from "../../components/TransactionDetails.tsx";
import { ProofProgress } from "../../components/ProofProgress.tsx";
import { PurchaseReceipt } from "./PurchaseReceipt.tsx";
import { SellerListingPanel } from "./SellerListingPanel.tsx";
import { EtherAmount } from "../../components/EtherAmount.tsx";
import { friendlyError } from "../../components/friendlyError.ts";
import { ExternalLinkIcon } from "../../components/icons.tsx";
import { useNetwork } from "../../components/NetworkContext.tsx";
import { etherscanTransactionUrl } from "../explorer/format.ts";
import { Notice } from "../../components/Notice.tsx";
import { ConfirmInWallet } from "./ConfirmInWallet.tsx";
import { TradeWalletSetup } from "./TradeWalletSetup.tsx";
import { ListingDetails } from "./ListingDetails.tsx";
import { ListingAmount } from "./ListingAsset.tsx";
import { listingAssetLabel } from "./listingAsset.ts";
import {
  marketplaceActivityAction,
  marketplaceActionLabel,
} from "./recoveryPresentation.ts";
import type { MarketplaceModel } from "./useMarketplace.ts";
import { useNowSeconds } from "./useNowSeconds.ts";
import { useWallet } from "../../lib/WalletProvider.tsx";
import { PaymentShortfallWarning, type GasShortfall } from "../../lib/gasGuard.tsx";
import styles from "./MarketplaceRoute.module.css";

export function CheckoutPanel({ market }: { market: MarketplaceModel }) {
  const {
    selectedOffer,
    controller,
    currentReview,
    reviewedQuote,
    ready,
    busy,
    buyingSelected,
    purchaseAccepted,
    purchase,
    progress,
    loading,
    reviewError,
    configurationError,
  } = market;
  const selectedIdentity = selectedOffer === undefined ? undefined : publicationIdentity(selectedOffer);
  const { network } = useNetwork();
  const cachedPaymentBalance = useWallet().l1Balance;
  const nowSeconds = useNowSeconds();
  const asset = selectedOffer === undefined ? "PCASH" : listingAssetLabel(selectedOffer);
  // Without a known payment, buying closes at the cutoff. This browser may
  // lack the purchase record, so a restored wallet can still look for its
  // payment until T; the controller refuses a fresh one.
  const purchaseClosed = selectedOffer !== undefined
    && (purchase === undefined || purchase.phase === "selected")
    && !openForPurchase(selectedOffer, nowSeconds);
  const paymentSearchOpen = purchaseClosed && nowSeconds < BigInt(selectedOffer!.terms.deadlineT);
  const continuing = !purchaseClosed && (purchase !== undefined || buyingSelected || purchaseAccepted);
  const action = purchase && marketplaceActivityAction(purchase);
  const complete = purchase?.phase === "claimed";
  const paymentConfirmed =
    purchaseAccepted ||
    (purchase &&
      ["paid", "claim-accepted", "claimed"].includes(
        purchase.phase,
      ));
  // Paid with no claim accepted and nothing running: the carried claim failed
  // or was never checked, and only Continue can finish it.
  const claimNeeded = !buyingSelected && !purchaseAccepted && purchase?.phase === "paid";
  const actionError = market.actionErrorFor((trade) => trade.action === "buy" && trade.identity !== undefined && trade.identity === selectedIdentity);
  const error = actionError ?? (purchase?.error === undefined ? undefined : friendlyError(purchase.error));
  const paymentUrl = purchase?.paymentHash && etherscanTransactionUrl(network.l1ChainId, purchase.paymentHash);
  const paymentWei = reviewedQuote?.buyerGrossWei;
  const checkPayment = market.selectedActivity === undefined && ready && !purchaseClosed && !continuing && currentReview?.verification.safeToPay === true
    && controller !== undefined && paymentWei !== undefined;
  const paymentCheckKey = checkPayment ? `${market.profile?.address}:${selectedIdentity}:${paymentWei}` : undefined;
  const [paymentCheck, setPaymentCheck] = useState<{ key: string; controller: NonNullable<MarketplaceModel["controller"]>; ready?: true; shortfall?: GasShortfall; error?: string }>();
  const [paymentCheckAttempt, setPaymentCheckAttempt] = useState(0);
  useEffect(() => {
    if (paymentCheckKey === undefined || controller === undefined || paymentWei === undefined) {
      setPaymentCheck(undefined);
      return;
    }
    let current = true;
    setPaymentCheck({ key: paymentCheckKey, controller });
    void controller.checkPaymentBalance(paymentWei).then(
      () => { if (current) setPaymentCheck({ key: paymentCheckKey, controller, ready: true }); },
      (cause) => {
        if (!current) return;
        setPaymentCheck(cause instanceof InsufficientPaymentBalanceError
          ? { key: paymentCheckKey, controller, shortfall: { balanceWei: cause.balanceWei, requiredWei: cause.paymentWei } }
          : { key: paymentCheckKey, controller, error: friendlyError(cause) });
      },
    );
    return () => { current = false; };
  }, [controller, paymentCheckKey, paymentWei, cachedPaymentBalance, paymentCheckAttempt]);
  const currentPaymentCheck = paymentCheck !== undefined && paymentCheck.key === paymentCheckKey && paymentCheck.controller === controller ? paymentCheck : undefined;
  const paymentShortfall = currentPaymentCheck?.shortfall;
  const checkingPaymentBalance = paymentCheckKey !== undefined && currentPaymentCheck?.ready !== true
    && currentPaymentCheck?.shortfall === undefined && currentPaymentCheck?.error === undefined;
  if (market.selectedActivity) return <SellerListingPanel market={market} item={market.selectedActivity} />;
  if (complete && selectedOffer !== undefined) {
    return <div className={styles.stack}>
      <PurchaseReceipt market={market} titleId="trade-title"
        items={[{ publication: selectedOffer, paymentHash: purchase.paymentHash, claimContentHash: purchase.contentHash }]} />
      <ListingDetails publication={selectedOffer} market={market} />
    </div>;
  }
  return (
    <div className={styles.stack}>
      <p className="eyebrow">Buy {asset}</p>
      <h2 id="trade-title">{complete ? "Purchase complete" : "Review purchase"}</h2>
      <p className={styles.muted}>One Ethereum transaction pays in ETH and claims your {asset}. It always requires gas.</p>
      <p className={styles.muted}>The payment is public on Ethereum: your address, the price and the amount. What you do with the {asset} afterwards is private.</p>
      {selectedOffer === undefined ? (
        <p role="status">
          {loading
            ? "Loading listing…"
            : "Listing unavailable. Open the seller’s shared link or choose another listing."}
        </p>
      ) : (
        <>
          <dl className={styles.totals}>
            <dt>You receive</dt>
            <dd>
              <ListingAmount publication={selectedOffer} value={BigInt(selectedOffer.terms.amount)} />
            </dd>
            <dt>You pay</dt>
            <dd>
              <EtherAmount
                value={
                  reviewedQuote?.buyerGrossWei ??
                  BigInt(selectedOffer.terms.ethPriceWei)
                }
              />
            </dd>
          </dl>
          <dl className={styles.economics} aria-label="Fees">
            <dt>Website fee included</dt>
            <dd>{reviewedQuote ? <EtherAmount value={reviewedQuote.websiteFeeWei} /> : "—"}</dd>
          </dl>
          <p className={styles.muted}>
            No relayer fee. Ethereum gas is additional.
          </p>
          {!purchaseClosed && <p className={styles.muted}>
            {purchaseAccepted || (purchase !== undefined && purchase.phase !== "selected")
              ? <>Your claim must finish by {new Date(Number(selectedOffer.terms.deadlineT) * 1_000).toLocaleString()}.</>
              : <>Buy before {new Date(Number(purchaseCutoff(BigInt(selectedOffer.terms.deadlineT))) * 1_000).toLocaleString()}.</>}
          </p>}
          <p className={styles.muted}>
            Keep this tab open while we complete your purchase. You can browse the website while you wait.
          </p>
          {purchaseClosed ? (
            <>
              <Notice>Buying closed at {new Date(Number(purchaseCutoff(BigInt(selectedOffer.terms.deadlineT))) * 1_000).toLocaleString()}. The time left before the deadline is kept for buyers who already paid to claim.</Notice>
              {paymentSearchOpen && <p className={styles.muted}>Paid from this wallet before buying closed? Check for your payment to finish the claim.</p>}
            </>
          ) : currentReview ? (
            <>
              {!continuing && !currentReview.verification.safeToPay && (
                <Notice tone="error">
                  {currentReview.verification.error !== undefined ? friendlyError(currentReview.verification.error) :
                    (currentReview.verification.escrow === "spent" || currentReview.verification.routerPaid === true
                      ? "This listing has already been bought or reclaimed."
                      : "This listing is unavailable or could not be verified.")}
                </Notice>
              )}
              <details className={styles.advanced}>
                <summary>Fees and verification</summary>
                <div className={styles.advancedBody}>
                  <dl className={styles.economics}>
                    <dt>Listed {asset}</dt>
                    <dd>
                      <ListingAmount publication={selectedOffer} />
                    </dd>
                    <dt>Seller receives</dt>
                    <dd>
                      {reviewedQuote ? (
                        <EtherAmount value={reviewedQuote.sellerNetWei} />
                      ) : (
                        "Not verified"
                      )}
                    </dd>
                  </dl>
                  <ul className={styles.verificationChecks}>
                    {currentReview.verification.checks.map(
                      (item, index) => (
                        <li key={index}>{friendlyError(item)}</li>
                      ),
                    )}
                  </ul>
                </div>
              </details>
            </>
          ) : !continuing && (reviewError ? (
            <Notice tone="error">
              {reviewError}{" "}
              <button onClick={market.retryVerification}>Retry verification</button>
            </Notice>
          ) : (
            <p role="status">
              {configurationError
                ? "Purchasing is unavailable until marketplace payments are configured."
                : "Checking listing availability…"}
            </p>
          ))}
          {paymentShortfall && <PaymentShortfallWarning shortfall={paymentShortfall} />}
          {checkingPaymentBalance && <p role="status">Checking your Ethereum balance…</p>}
          {currentPaymentCheck?.error && <Notice tone="error">
            {currentPaymentCheck.error}{" "}<button type="button" onClick={() => setPaymentCheckAttempt((attempt) => attempt + 1)}>Retry balance check</button>
          </Notice>}
          {!complete && <TradeWalletSetup />}
          {ready && !purchaseClosed && (currentReview !== undefined || continuing) && (
            <button
              className={`button primary ${styles.primaryAction}`}
              disabled={
                busy ||
                continuing ||
                currentPaymentCheck?.ready !== true ||
                !currentReview?.verification.safeToPay ||
                reviewedQuote === undefined
              }
              onClick={market.buyReviewed}
            >
              {buyingSelected ? "Buying…" : <>Buy for{" "}
                <EtherAmount
                  value={
                    reviewedQuote?.buyerGrossWei ??
                    BigInt(selectedOffer.terms.ethPriceWei)
                  }
                /></>}
            </button>
          )}
          {ready && paymentSearchOpen && (
            <button
              className={`button ${styles.primaryAction}`}
              disabled={busy || buyingSelected || currentReview === undefined}
              onClick={market.buyReviewed}
            >
              {buyingSelected ? "Checking…" : "Check for my payment"}
            </button>
          )}
          {buyingSelected && market.confirmInWallet && <ConfirmInWallet />}
          {error && <Notice tone="error">{error}</Notice>}
          {continuing && (
            <>
              {buyingSelected && (progress?.phase === "proving" || market.awaitingSignature) && <ProofProgress proof={market.proofProgress} awaitingSignature={market.awaitingSignature} />}
              <div
                className={styles.purchaseProgress}
                role="status"
                aria-live="polite"
              >
                <strong>
                  {complete
                    ? `Your ${asset} has arrived`
                    : claimNeeded
                      ? "Payment confirmed · Finish your claim"
                    : paymentConfirmed
                      ? `Payment confirmed · Receiving ${asset}`
                      : purchase?.phase === "payment-ambiguous"
                        ? "Check your payment"
                        : purchase?.phase === "payment-pending"
                          ? "Waiting for ETH payment"
                          : buyingSelected
                            ? progress?.phase === "submitting" ? "Approve payment in your wallet"
                              : progress?.phase === "proving" ? "Proving your claim" : "Preparing your purchase"
                            : "Continue your purchase"}
                </strong>
                <p>
                  {complete
                    ? `Your ${asset} is ready in your wallet.`
                      : buyingSelected && progress?.phase === "submitting"
                        ? paymentConfirmed
                          ? `Approve the Ethereum transaction that carries your ${asset} claim again. It costs only gas.`
                          : `Approve the Ethereum transaction: it pays for the listing and carries your ${asset} claim. Gas is paid in ETH.`
                    : claimNeeded
                      ? `Your ${asset} claim has not landed yet. Continue checks it and sends it again if it failed. Finish before ${new Date(Number(selectedOffer.terms.deadlineT) * 1_000).toLocaleString()}.`
                    : paymentConfirmed
                      ? `Waiting for the network to confirm your ${asset}. Keep this tab open to finish.`
                      : purchase ? "Your purchase is saved. Closing this view does not cancel a submitted payment." : `Your claim is proved first, then you approve one Ethereum transaction that pays in ETH and claims your ${asset}.`}
                </p>
              </div>
              {purchase?.phase === "payment-ambiguous" && (
                <Notice>
                  The wallet was asked to send your payment, but its outcome is
                  unknown. Continue finds the payment if it was sent. If it was
                  not, Continue buys again once this attempt’s time limit, at
                  most an hour after its claim was proved, has passed on
                  Ethereum.
                </Notice>
              )}
              <TransactionDetails proof={buyingSelected ? market.proofProgress : undefined}
                message={(buyingSelected || purchaseAccepted) && progress?.action === "buy" ? progress.message : undefined}
                contentHash={purchase?.contentHash} />
              <div className={styles.offerActions}>
                {paymentUrl && <a href={paymentUrl} target="_blank" rel="noreferrer">ETH payment<ExternalLinkIcon /></a>}
                {action && ready && !buyingSelected ? (
                  <button
                    className="button primary"
                    disabled={busy}
                    onClick={() => market.runActivityAction(purchase!)}
                  >
                    {marketplaceActionLabel(purchase!, action)}
                  </button>
                ) : !complete && !action && !buyingSelected && (
                  <button
                    disabled={busy || loading}
                    onClick={() => void market.refresh(true)}
                  >
                    Check status
                  </button>
                )}
              </div>
            </>
          )}
          <ListingDetails publication={selectedOffer} market={market} />
        </>
      )}
    </div>
  );
}
