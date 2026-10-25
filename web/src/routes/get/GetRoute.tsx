import { useState } from "react";
import { issuanceTerms } from "@pcash/sdk/protocol";
import { Link } from "react-router-dom";
import { Metadata } from "../Metadata.tsx";
import { routeById } from "../routeManifest.ts";
import { useWallet } from "../../lib/WalletProvider.tsx";
import { useGetIssuance } from "./useGetIssuance.ts";
import { useGetNavigationGuard } from "./useGetNavigationGuard.ts";
import { useGetActivity } from "../../lib/GetActivity.tsx";
import { useEthereumNetwork } from "../../lib/EthereumProvider.tsx";
import { ExternalLinkIcon } from "../../components/icons.tsx";
import { PcashAmount } from "../../components/PcashAmount.tsx";
import { TokenAmount } from "../../components/TokenAmount.tsx";
import { AccountSetupPanel } from "../wallet/AccountSetupPanel.tsx";
import { ConnectWallet } from "../../components/ConnectWallet.tsx";
import { useStartWalletOnArrival } from "../../lib/useConnectWallet.ts";
import { ProgressIndicator, proofProgressMessage } from "../../components/ProgressIndicator.tsx";
import { TransactionDetails } from "../../components/TransactionDetails.tsx";
import { useProofCompletion } from "../../components/useProofCompletion.ts";
import { IssuanceFormulas } from "./IssuanceFormulas.tsx";
import { IssuanceOverview } from "./IssuanceOverview.tsx";
import { RewardNow } from "./RewardNow.tsx";
import { useBestListing } from "./useBestListing.ts";
import { useGetEstimate } from "./useGetEstimate.ts";
import { useGetBatch } from "./useGetBatch.ts";
import { acquisitionCostPerThousand, batchIssuance, MAX_MINE_ACTIONS } from "./getEstimate.ts";
import { blockSplit, crowdedBlockActions, dayBlockPattern } from "./issuanceOverviewModel.ts";
import styles from "./GetRoute.module.css";

const ETH = { decimals: 18, symbol: "ETH" };
const OWN_PENDING = "Includes your own pending transactions. Their fees stay with you.";

export default function GetRoute() {
  const wallet = useWallet();
  useStartWalletOnArrival();
  return <GetPage key={`${wallet.connectedAccount}:${wallet.status?.genesisHash}:${wallet.profile === undefined ? "locked" : "unlocked"}`} />;
}

/** Without unlocked keys the form is replaced by the wallet's own next step. */
function NextStep() {
  const { phase } = useWallet();
  // Until the saved connection and sign-in resolve, any step shown would be a guess.
  if (phase === "initializing") return null;
  if (phase !== "disconnected") return <AccountSetupPanel />;
  return <>
    <p className={styles.intro}>Connect an Ethereum wallet to mine. No PCASH balance needed; Ethereum gas is paid in ETH.</p>
    <ConnectWallet />
  </>;
}

function GetPage() {
  const context = useWallet();
  const activity = useGetActivity();
  useGetNavigationGuard(activity.unsafeToLeave);
  const { l1Chain } = useEthereumNetwork();
  const [count, setCount] = useState(1);
  const batch = useGetBatch();
  const working = batch.progress !== undefined;
  const phase = batch.progress?.phase;
  const unlocked = context.wallet !== undefined && context.profile !== undefined && context.selfPublication !== undefined;
  const issuance = useGetIssuance();
  const listing = useBestListing();
  const estimate = useGetEstimate(count, unlocked && !working && context.submissionLock === undefined && issuance.inputs !== undefined, issuance.inputs);
  const ready = estimate.state === "ready" ? estimate : undefined;
  const quote = issuance.inputs?.quote.status === "fulfilled" ? issuance.inputs.quote.value : undefined;
  // A batch's block holds at least as many qualifying actions as recent crowded blocks did, so the estimate never exceeds their split.
  const blockActions = quote == null ? 0n : crowdedBlockActions(blockSplit(quote, issuance.history === undefined ? undefined : dayBlockPattern(issuance.history)));
  const terms = quote == null ? undefined : issuanceTerms(quote);
  const earnings = ready === undefined || terms === undefined ? undefined : batchIssuance(terms, ready.plan.actions, blockActions) + ready.plan.companions.collectibleOpenFee;
  const price = earnings === undefined ? undefined : acquisitionCostPerThousand(ready!.quote.estimatedCostWei, earnings);
  const noIssuance = quote !== undefined && quote !== null && !quote.rewardPossible;
  const insufficientEth = ready !== undefined && ready.quote.balanceWei < ready.quote.maximumCostWei;
  const canStart = unlocked && issuance.inputs !== undefined && ready !== undefined && !working && !context.busy && context.submissionLock === undefined && !insufficientEth && !(count > 0 && noIssuance);
  const own = ready?.plan.own.length ?? 0;
  const relayed = ready?.plan.companions.transactions.length ?? 0;
  // What other people's transactions add over posting the mines and this wallet's own pending transactions alone.
  const relayGain = earnings === undefined ? undefined : earnings - batchIssuance(terms!, ready!.plan.actionsWithoutCompanions, blockActions);
  const betterListing = listing !== undefined && price !== undefined && listing.weiPerThousand < price ? listing : undefined;
  const actionLabel = count === 0 ? "Relay transactions" : relayed > 0 ? "Mine and relay" : "Mine";
  const result = batch.current?.txHash !== undefined || batch.current?.status === "failed" ? batch.current : undefined;
  const settled = result?.collectedFee !== undefined;
  const ownIncluded = result?.ownContentHashes?.some(id => result.contentHashes.some(hash => hash.toLowerCase() === id.toLowerCase())) === true;
  const otherSubmission = context.submissionLock !== undefined && !working && context.submissionLock.resolutionId !== result?.resolutionId;
  const detail = phase === "proving" ? `${batch.progress!.message}. ${proofProgressMessage(context.progress)}` : batch.progress?.message;
  const proofCompletion = useProofCompletion(phase === "proving" ? context.progress : undefined);
  const ethereumLink = (hash: string) => l1Chain.blockExplorers === undefined ? <code>{hash}</code>
    : <a href={`${l1Chain.blockExplorers.default.url}/tx/${hash}`} target="_blank" rel="noreferrer">View Ethereum transaction<ExternalLinkIcon /></a>;
  return <div className={styles.page}>
    <Metadata {...routeById("get").metadata} />
    <header className={styles.heading}><p className="eyebrow">Acquire PCASH</p><h1>Get PCASH</h1><p>Mine new PCASH and earn by posting other people’s pending transactions. Your Ethereum wallet publishes one batch.</p></header>
    <section className={`panel ${styles.acquire}`} aria-labelledby="get-action-title">
      <RewardNow quote={quote} history={issuance.history} error={issuance.error} />
      <div className={styles.action}>
        <h2 id="get-action-title">Mine and relay</h2>
        {!unlocked ? <NextStep /> : <>
          <p className={styles.intro}>Choose how many transactions to mine. Your own pending transactions are posted first, then we fill the remaining space with pending transactions selected by the fees and issuance you can collect. No PCASH balance needed; Ethereum gas is paid in ETH.</p>
          <div className={styles.countRow}><label htmlFor="mine-count">Transactions to mine</label><div className={styles.stepper}>
            <button type="button" aria-label="Mine one fewer transaction" disabled={working || count === 0} onClick={() => setCount(value => value - 1)}>−</button>
            <input id="mine-count" type="number" inputMode="numeric" min={0} max={MAX_MINE_ACTIONS} step={1} value={count} disabled={working}
              onChange={event => setCount(Math.max(0, Math.min(MAX_MINE_ACTIONS, Math.trunc(Number(event.target.value) || 0))))} />
            <button type="button" aria-label="Mine one more transaction" disabled={working || count === MAX_MINE_ACTIONS} onClick={() => setCount(value => value + 1)}>+</button>
          </div></div>
          <p className={styles.hint}>Maximum {MAX_MINE_ACTIONS} mines per batch. Choose 0 to relay only.</p>
          <div className={styles.relay} aria-live="polite">
            {ready === undefined ? estimate.state === "loading" && <p>{count === 0 ? "Looking for transactions to relay…" : "Pending transactions are selected automatically."}</p> : <>
              <p>{ready.plan.pendingCount === undefined ? "Pending transactions are unavailable right now."
                : ready.plan.pendingCount === 0 ? "No pending transactions right now."
                : `${ready.plan.pendingCount.toLocaleString()} pending ${ready.plan.pendingCount === 1 ? "transaction" : "transactions"}. This batch posts ${(own + relayed).toLocaleString()} of ${ready.plan.pendingCount.toLocaleString()}.`}</p>
              {own > 0 && <p>{OWN_PENDING}</p>}
              {relayed > 0 && <p>Fees from other people’s transactions, on top of issuance: <PcashAmount value={ready.plan.companions.collectibleOpenFee} /></p>}
              {count > 0 && relayed > 0 && relayGain !== undefined && relayGain > 0n && <p className={styles.gain}>You get <PcashAmount value={relayGain} /> more than mining alone</p>}
            </>}
            <p className={styles.why}>Why the protocol pays: a More private transaction reaches Ethereum without the sender’s own Ethereum account, so someone else has to post it. Issuance and fees pay whoever does.</p>
          </div>
          <dl className={styles.estimates} aria-live="polite">
            <dt>Estimated Ethereum cost</dt><dd>{ready === undefined ? "—" : <TokenAmount value={ready.quote.estimatedCostWei} unit={ETH} rounding="up" />}</dd>
            <dt>Estimated PCASH received{earnings !== undefined && <small className={styles.qualifier}>{blockActions > 0n ? `at recent crowding, about ${blockActions} per block`
              : count === 1 ? "if your transaction is alone in its block" : "if your batch is alone in its block"}</small>}</dt>
            <dd data-testid="mining-estimate">{earnings === undefined ? "—" : <PcashAmount value={earnings} />}</dd>
            <dt>Mining cost per 1,000 PCASH</dt><dd>{price === undefined ? "—" : <TokenAmount value={price} unit={ETH} />}</dd>
          </dl>
          {betterListing !== undefined && <Link className={styles.better} to={routeById("marketplace").path}>
            <span>Better rate on the marketplace →</span><span><TokenAmount value={betterListing.weiPerThousand} unit={ETH} approximate={betterListing.approximate} /> before gas</span></Link>}
          <p className={styles.hint}>One Ethereum transaction. Confirm it in your wallet.</p>
          <button className={`button primary ${styles.submit}`} data-testid="mining-start" type="button" disabled={!canStart} onClick={() => void batch.start(count)}>
            {phase === "proving" ? "Proving…" : phase === "submitting" ? "Submitting…" : phase === "confirming" ? "Waiting for inclusion…" : working ? "Preparing…" : actionLabel}</button>
          {working && !(phase === "confirming" && result !== undefined) && <div className={styles.status} aria-live="polite">
            {phase === "submitting" ? <p className={styles.statusLine} role="status"><span className="spinner" aria-hidden="true" />Confirm in your wallet</p>
              : <><ProgressIndicator label={batch.progress!.message} detail={detail ?? ""} value={proofCompletion?.fraction} /><p>{detail}</p></>}
            {batch.finalCost !== undefined && <p>Maximum Ethereum cost: <TokenAmount value={batch.finalCost} unit={ETH} rounding="up" /></p>}
            <TransactionDetails proof={context.progress} />
            {phase !== "submitting" && phase !== "confirming" && <button className="button" type="button" onClick={batch.cancel}>Cancel</button>}
          </div>}
          {batch.error !== undefined && <p className="notice error" role="alert">{batch.error}{batch.submissionError && <> <Link to="#ethereum-submission">Review Ethereum submission</Link></>}</p>}
          {result !== undefined && <div className={styles.status} data-testid="mining-result" aria-live="polite">
            {result.status === "failed" ? <><p className={styles.resultTitle}>{result.txHash === undefined ? "Batch was not submitted" : "Batch was not included"}</p><p>{result.error ?? "You can try again."}</p></>
              : settled ? <><p className={styles.resultTitle}>Batch included</p>
                <p className={styles.earned}>Received <PcashAmount value={result.collectedFee! + (result.collectedIssuance ?? 0n)} /></p>
                <p>Issuance <PcashAmount value={result.collectedIssuance ?? 0n} /> · Collected fees <PcashAmount value={result.collectedFee!} /></p>
                <p>{result.acceptedCount} {result.acceptedCount === 1 ? "transaction" : "transactions"} succeeded{result.skippedCount ? `; ${result.skippedCount} ${result.skippedCount === 1 ? "was" : "were"} skipped or failed` : ""}.{result.status === "finalized" ? " Finalized." : ""}</p></>
              : <p className={styles.statusLine} role="status"><span className="spinner" aria-hidden="true" />{result.status === "included" || result.status === "finalized" ? "Waiting for PCASH results" : "Waiting for L1 inclusion"}</p>}
            {ownIncluded && result.status !== "failed" && <p>{OWN_PENDING}</p>}
            {result.minedElsewhereCount !== undefined && result.minedElsewhereCount > 0 && <p>{result.minedElsewhereCount} of your mines {result.minedElsewhereCount === 1 ? "was" : "were"} included by another poster and still paid your wallet.</p>}
            {result.txHash !== undefined && <p>{ethereumLink(result.txHash)} · <Link to={`/batch/${result.txHash}`}>View PCASH batch</Link></p>}
            {batch.trackingError !== undefined && <p role="status">Outcome update delayed: {batch.trackingError}</p>}
          </div>}
          {estimate.state === "empty" && <p role="status">No worthwhile pending transactions right now. Choose a mine transaction or check back later.</p>}
          {ready?.refreshError !== undefined && <p role="status">Estimate update delayed. {ready.refreshError}</p>}
          {estimate.state === "error" && <p role="alert">Could not estimate this batch: {estimate.message}</p>}
          {ready !== undefined && earnings === undefined && <p role="status">Reward information is unavailable. The ETH quote is available, but PCASH earnings cannot currently be estimated.</p>}
          {insufficientEth && <p role="alert">Your Ethereum wallet needs more ETH to cover this batch’s maximum gas cost.</p>}
          {otherSubmission && <p role="status">Resolve your existing Ethereum submission before posting another. <Link to="#ethereum-submission">Review submission</Link></p>}
          {count > 0 && noIssuance && <p role="status">{quote?.exhausted ? "All PCASH has been issued. Choose 0 to earn by relaying fee-paying transactions." : "The current mining reward is zero. You can still relay fee-paying transactions."}</p>}
        </>}
      </div>
      {unlocked && <p className={styles.disclaimer}>Estimates change with activity and Ethereum fees. Another poster may include a relayed transaction first, reducing your earnings.</p>}
    </section>
    <IssuanceOverview quote={quote} history={issuance.history} error={issuance.error} onRetry={issuance.refresh} />
    <IssuanceFormulas />
  </div>;
}
