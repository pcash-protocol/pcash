import { Link } from "react-router-dom";
import { purchaseCutoff, type MarketplaceProgress, type OfferPublication } from "@pcash/marketplace/app";
import type { ProveStatus } from "@pcash/sdk/browser-prover/requests";
import { EtherAmount } from "../../components/EtherAmount.tsx";
import { TokenAmount } from "../../components/TokenAmount.tsx";
import { listingUnit } from "./listingAsset.ts";
import type { ListingInputs } from "./useMarketplace.ts";
import { ProgressIndicator, proofProgressMessage } from "../../components/ProgressIndicator.tsx";
import { TransactionDetails } from "../../components/TransactionDetails.tsx";
import { ProofProgress } from "../../components/ProofProgress.tsx";
import { ConfirmInWallet } from "./ConfirmInWallet.tsx";
import styles from "./MarketplaceRoute.module.css";

export function PublicationProgress({
  progress, busy, proof, awaitingSignature = false, confirmInWallet = false, pendingPublication, onFinalize, inputs,
}: {
  progress: MarketplaceProgress;
  busy: boolean;
  proof?: ProveStatus | undefined;
  awaitingSignature?: boolean;
  /** This listing's Ethereum transaction waits for approval in the wallet. */
  confirmInWallet?: boolean;
  pendingPublication?: OfferPublication | undefined;
  onFinalize?: () => void;
  /** Set for a listing published from the form, whose progress replaces the form without repeating its terms. */
  inputs?: ListingInputs | undefined;
}) {
  const listed = inputs === undefined ? pendingPublication : undefined;
  const unit = listed && listingUnit(listed);
  const done = progress.phase === "done";
  const paused = progress.phase === "error";
  // Once one of its transactions exists, a listing continues from what was saved.
  const saved = pendingPublication !== undefined || progress.publication?.contentHash !== undefined;
  const waiting = !done && !paused;
  // A listing signs once to create its contract and once to fund its escrow; neither signature costs gas.
  const signing = progress.publication?.step === "funding" ? "Sign in your wallet to fund the listing. Signing is free."
    : "Sign in your wallet to create the listing. Signing is free.";
  const detail = done ? "Your listing is available for buyers."
    : paused ? saved ? "Your progress is saved. Continue when you’re ready." : "Nothing was submitted. You can change the listing and publish it again."
    : awaitingSignature ? signing
    : progress.phase === "proving" ? proofProgressMessage(proof)
    : progress.publication?.step === "catalog" ? "Making your listing available to buyers…"
    : progress.phase === "submitting" ? "Posting your listing to Ethereum. Gas is paid in ETH."
    : progress.phase === "confirming" ? "Waiting for Ethereum to confirm your listing…"
    : "Preparing your listing securely. Your wallet will ask for approval when it’s ready.";
  return <section className={styles.publicationProgress} aria-label="Listing creation progress">
    <p className="eyebrow">Your listing</p>
    <h2 id="trade-title">{done ? "Your listing is live" : paused ? saved ? "Your listing needs attention" : "Your listing was not created" : "Creating your listing"}</h2>
    {listed && unit && <dl className={styles.totals} aria-label="Listing inputs">
      <dt>{unit.symbol} listed</dt><dd><TokenAmount value={BigInt(listed.terms.amount)} unit={unit} /></dd>
      <dt>Total price</dt><dd><EtherAmount value={BigInt(listed.terms.ethPriceWei)} /></dd>
      <dt>Recipient</dt><dd>Your listing’s escrow</dd>
      <dt>Published by</dt><dd>Your Ethereum wallet</dd>
      <dt>Buying closes</dt><dd>{new Date(Number(purchaseCutoff(BigInt(listed.terms.deadlineT))) * 1_000).toLocaleString()}</dd>
    </dl>}
    {waiting && confirmInWallet ? <ConfirmInWallet />
      : waiting && awaitingSignature ? <ConfirmInWallet>{signing}</ConfirmInWallet>
      : waiting && progress.phase === "proving" ? <ProofProgress proof={proof} /> : <>
      <p role="status" aria-live="polite">{detail}</p>
      {waiting && <ProgressIndicator label="Creating your listing" detail={detail} />}
    </>}
    {waiting && <p className={styles.muted}>You can keep browsing this website. Keep this tab open so your listing can finish.</p>}
    <TransactionDetails proof={proof} message={progress.message}>
      {progress.publication?.contentHash && <p>
        <Link to={`/tx/${progress.publication.contentHash}`}>
          {progress.publication.step === "funding" ? "View escrow funding submission" : "View listing creation submission"}
        </Link>
        {" — track its confirmation on PCASH."}
      </p>}
      {paused && saved && <Link to="#ethereum-submission">Review Ethereum submission</Link>}
    </TransactionDetails>
    {paused && pendingPublication && onFinalize && <div className={styles.offerActions}>
      <button className="button primary" disabled={busy} onClick={() => onFinalize()}>Continue</button>
    </div>}
  </section>;
}
