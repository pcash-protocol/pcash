import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { Hex } from "viem";
import { quotePaymentRouterFee, type OfferPublication } from "@pcash/marketplace/app";
import { EtherAmount } from "../../components/EtherAmount.tsx";
import { CheckIcon, ExternalLinkIcon } from "../../components/icons.tsx";
import { useNetwork } from "../../components/NetworkContext.tsx";
import { TokenAmount } from "../../components/TokenAmount.tsx";
import { etherscanTransactionUrl } from "../explorer/format.ts";
import { transactionPath } from "../explorer/paths.ts";
import { listingUnit } from "./listingAsset.ts";
import { useWalletPanel } from "../wallet/OwnerPanels.tsx";
import type { MarketplaceModel } from "./useMarketplace.ts";
import styles from "./MarketplaceRoute.module.css";

/** One bought listing: its terms, the Ethereum payment, and the PCASH claim it carried. */
export interface PurchaseReceiptItem {
  publication: OfferPublication;
  paymentHash?: string | undefined;
  claimContentHash?: string | undefined;
}

/**
 * The gas the payments spent, from their Ethereum receipts: undefined while
 * reading, null when they cannot be read.
 */
function usePaymentGas(controller: MarketplaceModel["controller"], paymentHashes: readonly (string | undefined)[]): bigint | null | undefined {
  const key = paymentHashes.join(",");
  const [gas, setGas] = useState<{ key: string; wei: bigint | null }>();
  useEffect(() => {
    const hashes = key.split(",");
    if (controller?.paymentGas === undefined || hashes.some((hash) => hash === "")) {
      setGas({ key, wei: null });
      return;
    }
    let current = true;
    controller.paymentGas(hashes as Hex[])
      .then((wei) => { if (current) setGas({ key, wei }); }, () => { if (current) setGas({ key, wei: null }); });
    return () => { current = false; };
  }, [controller, key]);
  return gas?.key === key ? gas.wei : undefined;
}

/** A finished purchase: what was bought, what it cost, and where to see its transactions. */
export function PurchaseReceipt({ market, items, titleId, onDone }: {
  market: MarketplaceModel;
  items: readonly PurchaseReceiptItem[];
  titleId?: string;
  onDone?: () => void;
}) {
  const { network } = useNetwork();
  const walletPanel = useWalletPanel();
  const receipt = useRef<HTMLElement>(null);
  const gas = usePaymentGas(market.controller, items.map((item) => item.paymentHash));
  // A receipt that replaces the purchase panel scrolls into view where the panel sits below the listings.
  useEffect(() => { receipt.current?.scrollIntoView?.({ block: "nearest" }); }, []);
  const unit = listingUnit(items[0]!.publication);
  const amount = items.reduce((sum, item) => sum + BigInt(item.publication.terms.amount), 0n);
  const paid = items.reduce((sum, item) => sum + BigInt(item.publication.terms.ethPriceWei), 0n);
  // Each payment paid the router's fee on its own price, rounded as the contract rounds. A purchase
  // quote prices only what is still unpaid, so it cannot give the fee of a recovered payment.
  const terms = market.routerTerms;
  const websiteFeeWei = terms === undefined ? undefined : items.reduce((sum, item) =>
    sum + quotePaymentRouterFee(BigInt(item.publication.terms.ethPriceWei), terms).websiteFeeWei, 0n);
  const several = items.length > 1;
  return <section ref={receipt} className={styles.receipt} aria-labelledby={titleId} aria-label={titleId === undefined ? "Purchase receipt" : undefined}>
    <span className={styles.receiptMark} aria-hidden="true"><CheckIcon size={22} /></span>
    <p className="eyebrow">Purchase complete</p>
    <h2 id={titleId} className={styles.receiptTitle}>You bought <TokenAmount value={amount} unit={unit} /></h2>
    <p className={styles.muted}>{several ? `${items.length} listings. ` : ""}It's in your wallet.</p>
    <dl className={styles.purchaseTotals} aria-label="Purchase totals">
      <dt>You paid</dt><dd><EtherAmount value={paid} /></dd>
      {websiteFeeWei !== undefined && <><dt>Website fee, included</dt><dd><EtherAmount value={websiteFeeWei} /></dd></>}
      <dt>Gas</dt><dd>{gas === undefined ? "Checking…" : gas === null ? "Unavailable" : <EtherAmount value={gas} />}</dd>
    </dl>
    {items.map((item, index) => {
      const etherscan = item.paymentHash === undefined ? undefined : etherscanTransactionUrl(network.l1ChainId, item.paymentHash);
      return <div key={item.claimContentHash ?? item.paymentHash ?? index} className={styles.receiptItem}>
        {several && <p><TokenAmount value={BigInt(item.publication.terms.amount)} unit={unit} /> for <EtherAmount value={BigInt(item.publication.terms.ethPriceWei)} /></p>}
        <div className={styles.receiptLinks}>
          {item.claimContentHash !== undefined && <Link to={transactionPath(item.claimContentHash)}>PCASH transaction →</Link>}
          {etherscan !== undefined
            ? <a href={etherscan} target="_blank" rel="noreferrer">Ethereum payment<ExternalLinkIcon /></a>
            : item.paymentHash !== undefined && <span>Ethereum payment <code>{item.paymentHash}</code></span>}
        </div>
      </div>;
    })}
    <div className={styles.statusActions}>
      <button type="button" className="button" onClick={walletPanel.openOverview}>Open wallet</button>
      {onDone && <button type="button" className="button primary" onClick={onDone}>Done</button>}
    </div>
  </section>;
}
