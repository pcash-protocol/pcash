import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { AvailableDrop, DropEligibilityResult, TokenClaimResult } from "@pcash/tokens/app";
import { Notice } from "../../components/Notice.tsx";
import { RouteHeader } from "../../components/RouteHeader.tsx";
import { TokenAmount } from "../../components/TokenAmount.tsx";
import { formatTokenAmount } from "../../components/tokenAmount.ts";
import { errorMessage, useWallet } from "../../lib/WalletProvider.tsx";
import { Metadata } from "../Metadata.tsx";
import paper from "../PaperPage.module.css";
import { tokenPath, tokenUnit, TOKENS_PATH } from "./model.ts";
import { ClaimWalletPrompt, runClaim } from "./ClaimPage.tsx";
import { TokenFailureNotice, type TokenFailure } from "./EthereumSubmission.tsx";
import { VerifiedDefinition } from "./TokenCommon.tsx";
import { formatTimestamp } from "./TokenDrops.tsx";
import { checkedPublication, TokenPublicationFields, usePublicationDraft } from "./TokenPublicationFields.tsx";
import { TokensActionProgress } from "./TokenTransactionStatus.tsx";
import { useTokensApp } from "./useTokensApp.ts";
import { useTokenTransaction } from "./useTokenTransaction.ts";
import styles from "./Tokens.module.css";

const ELIGIBILITY_TONE: Record<DropEligibilityResult["status"], string> = {
  eligible: styles.chipDone!,
  claimed: styles.chipWarn!,
  "not-started": styles.chipWarn!,
  ineligible: styles.chipBad!,
  "no-account": styles.chipBad!,
  ended: styles.chipBad!,
  exhausted: styles.chipBad!,
};

const ELIGIBILITY_LABEL: Record<DropEligibilityResult["status"], string> = {
  eligible: "You can claim",
  claimed: "Already claimed",
  "not-started": "Not open yet",
  ineligible: "Registered after the cutoff",
  "no-account": "No account yet",
  ended: "Drop ended",
  exhausted: "All claimed",
};

/** The route checks the contract address before this chunk loads. */
export default function DropPage() {
  const { contractAddress = "" } = useParams();
  const wallet = useWallet();
  const tokens = useTokensApp();
  const tx = useTokenTransaction();
  const [readState, setReadState] = useState<{ address: string; drop?: AvailableDrop | null; eligibility?: DropEligibilityResult; error?: string }>();
  const [draft, setDraft] = usePublicationDraft();
  const [claiming, setClaiming] = useState(false);
  const [claimResult, setClaimResult] = useState<{ address: string; claimed: TokenClaimResult }>();
  const [claimError, setClaimError] = useState<{ address: string; failure: TokenFailure }>();
  const [claimUnsettled, setClaimUnsettled] = useState<{ address: string; message: string }>();
  const current = readState?.address === contractAddress ? readState : undefined;
  const drop = current?.drop;
  const eligibility = current?.eligibility;
  const readError = current?.error;
  const claimed = claimResult?.address === contractAddress ? claimResult.claimed : undefined;
  const error = claimError?.address === contractAddress ? claimError.failure : undefined;
  const unsettled = claimUnsettled?.address === contractAddress ? claimUnsettled.message : undefined;

  const read = useCallback(async () => {
    setReadState({ address: contractAddress });
    try {
      const found = (await tokens.availableDrops()).find((candidate) => candidate.id.toLowerCase() === contractAddress.toLowerCase()) ?? null;
      const eligibility = found === null ? undefined : await tokens.dropEligibility(found);
      setReadState((current) => current !== undefined && current.address === contractAddress ? { address: contractAddress, drop: found, ...(eligibility === undefined ? {} : { eligibility }) } : current);
    } catch (cause) {
      setReadState((current) => current !== undefined && current.address === contractAddress ? { address: contractAddress, error: errorMessage(cause) } : current);
    }
  }, [contractAddress, tokens.availableDrops, tokens.dropEligibility]);
  useEffect(() => { void read(); }, [read]);

  const claim = () => {
    if (drop == null) return;
    const publication = checkedPublication(draft, wallet.funds?.spendablePrivate);
    if ("problem" in publication) { setClaimError({ address: contractAddress, failure: { message: publication.problem } }); return; }
    setClaiming(true);
    setClaimError(undefined);
    setClaimUnsettled(undefined);
    tokens.clearProgress();
    void runClaim(tx, tokens, publication.choice, { amount: drop.drop.configuration.claimAmount, unit: tokenUnit(drop.definition) },
      (app, options) => app.claimDrop(drop, options)).then((outcome) => {
      if ("claimed" in outcome) setClaimResult({ address: contractAddress, claimed: outcome.claimed });
      else if ("failure" in outcome) setClaimError({ address: contractAddress, failure: outcome.failure });
      else setClaimUnsettled({ address: contractAddress, message: outcome.unsettled });
    }).finally(() => {
      setClaiming(false);
      void read();
    });
  };

  const unit = drop == null ? undefined : tokenUnit(drop.definition);
  const terms = drop?.drop.configuration;
  return <section className={`${paper.page} ${styles.stack}`}>
    <Metadata title={drop == null ? "Token drop" : `${drop.definition.metadata.name} drop`} description="Claim tokens from a drop for existing PCASH accounts." />
    <RouteHeader eyebrow="Token drop" title={drop == null || unit === undefined || terms === undefined ? "Token drop" : `Claim ${formatTokenAmount(terms.claimAmount, unit)}`}
      description="Accounts that existed before a cutoff can each claim once, until the drop ends." />
    <p><Link to={TOKENS_PATH}>← Tokens</Link></p>
    <div className={styles.columns}>
      <section className="panel" aria-labelledby="drop-token">
        <div className={styles.panelHeading}><h2 id="drop-token">Drop</h2></div>
        {readError !== undefined ? <Notice tone="error">{readError}</Notice>
          : drop === undefined ? <p className={styles.hint} role="status">Looking up the drop…</p>
          : drop === null || unit === undefined || terms === undefined ? <Notice>This node does not list a drop at this address.</Notice>
          : <>
            <p className={styles.claimAmount}><TokenAmount value={terms.claimAmount} unit={unit} /> <span className={styles.muted}>per account</span></p>
            <dl className={styles.facts}>
              <dt>Who can claim</dt><dd>Accounts that existed at block {terms.cutoffBlockNumber.toString()}</dd>
              <dt>Claims end</dt><dd>{formatTimestamp(terms.claimEndTimestamp)}</dd>
              <dt>Claims in the drop</dt><dd>{drop.count}</dd>
            </dl>
            <div className={styles.outside}><VerifiedDefinition definition={drop.definition} assetId={drop.assetId} /></div>
          </>}
      </section>
      <section className="panel" aria-labelledby="drop-claim">
        <div className={styles.panelHeading}><h2 id="drop-claim">Claim</h2>
          {eligibility !== undefined && <span className={`${styles.chip} ${ELIGIBILITY_TONE[eligibility.status]}`} data-eligibility={eligibility.status}>{ELIGIBILITY_LABEL[eligibility.status]}</span>}</div>
        <ClaimWalletPrompt purpose="to claim from this drop" />
        {eligibility !== undefined && <p role="status">{eligibility.message}</p>}
        {claimed !== undefined && unit !== undefined && <Notice tone="success">You claimed <TokenAmount value={claimed.amount} unit={unit} />. It is in your wallet. <Link to={tokenPath(claimed.assetId)}>Open the token →</Link></Notice>}
        {wallet.wallet !== undefined && eligibility?.status === "eligible" && claimed === undefined && <div className={styles.form}>
          <TokenPublicationFields draft={draft} onChange={setDraft} disabled={claiming} contract="claim" />
          <p className={styles.hint}>If someone takes the same note first, the claim tries another automatically.</p>
          {error !== undefined && <TokenFailureNotice failure={error} onCleared={() => setClaimError(undefined)} />}
          {unsettled !== undefined && <Notice tone="warning">{unsettled}</Notice>}
          {claiming ? <TokensActionProgress progress={tokens.progress} />
            : <div className={styles.actions}><button type="button" className="button primary" disabled={wallet.busy} onClick={claim}>Claim</button></div>}
        </div>}
        {error !== undefined && eligibility?.status !== "eligible" && <TokenFailureNotice failure={error} onCleared={() => setClaimError(undefined)} />}
      </section>
    </div>
  </section>;
}
