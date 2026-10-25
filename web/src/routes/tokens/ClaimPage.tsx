import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { ClaimLinkInspection, TokenClaimResult, TokensActionOptions, TokensApp } from "@pcash/tokens/app";
import { Notice } from "../../components/Notice.tsx";
import { RouteHeader } from "../../components/RouteHeader.tsx";
import { TokenAmount } from "../../components/TokenAmount.tsx";
import { formatTokenAmount, type AmountUnit } from "../../components/tokenAmount.ts";
import { errorMessage, useWallet } from "../../lib/WalletProvider.tsx";
import { Metadata } from "../Metadata.tsx";
import { routeById } from "../routeManifest.ts";
import paper from "../PaperPage.module.css";
import { tokenPath, tokenUnit } from "./model.ts";
import { TokenFailureNotice, type TokenFailure } from "./EthereumSubmission.tsx";
import { VerifiedDefinition, WalletPromptButton } from "./TokenCommon.tsx";
import { checkedPublication, TokenPublicationFields, usePublicationDraft } from "./TokenPublicationFields.tsx";
import { TokensActionProgress } from "./TokenTransactionStatus.tsx";
import { usePageFragment } from "./usePageFragment.ts";
import { useTokensApp } from "./useTokensApp.ts";
import { useTokenTransaction, type TokenPublicationChoice } from "./useTokenTransaction.ts";
import styles from "./Tokens.module.css";

const route = routeById("claim");

const STATUS_TEXT: Record<ClaimLinkInspection["status"], string> = {
  claimable: "Ready to claim",
  claimed: "Already claimed",
  unfunded: "Not funded yet",
  invalid: "Not valid on this network",
};

/** A claim's end: claimed, failed, or submitted without a known result, which Activity keeps as Pending. */
export type ClaimOutcome = { claimed: TokenClaimResult } | { failure: TokenFailure } | { unsettled: string };

/**
 * Run one claim. Like every token action, it is recorded for the Activity feed
 * once its exact bytes are journaled, so an unclear submission still shows.
 */
export async function runClaim(
  tx: ReturnType<typeof useTokenTransaction>,
  tokens: ReturnType<typeof useTokensApp>,
  choice: TokenPublicationChoice,
  claiming: { amount: bigint; unit: AmountUnit },
  claim: (app: TokensApp, options: TokensActionOptions) => Promise<TokenClaimResult>,
): Promise<ClaimOutcome> {
  const outcome = await tx.run(choice, async ({ submission, openFeeAmount, onPrepared }) => claim(await tokens.app(choice.mode, submission), {
    onProgress: tokens.onProgress,
    ...(openFeeAmount === undefined ? {} : { openFeeAmount }),
    ...(onPrepared === undefined ? {} : { onPrepared }),
  }), { kind: "token-claimed", ...claiming });
  if (outcome.state === "sent") return { claimed: outcome.result };
  if (outcome.state === "failed") return { failure: outcome };
  return { unsettled: outcome.state === "broadcast"
    ? "Your claim is posted to Ethereum and waiting for inclusion. It shows as Pending in your activity."
    : "We couldn’t confirm whether your claim reached the network. It shows as Pending in your activity; claiming again submits the same claim." };
}

/** Claims need the wallet's keys, not an activated account: an unsponsored claim is authorized by the link's contract. */
export function ClaimWalletPrompt({ purpose }: { purpose: string }) {
  const { wallet, phase, connectionStep } = useWallet();
  if (wallet !== undefined) return null;
  const working = phase === "initializing" || phase === "connecting" || phase === "signing-in" || phase === "opening";
  return <div className={styles.status} aria-label="Wallet setup">
    <p role="status">{working ? connectionStep ?? "Opening your wallet…" : phase === "disconnected" ? `Connect a wallet ${purpose}.` : `Sign in to your wallet ${purpose}.`}</p>
    {!working && <WalletPromptButton />}
  </div>;
}

export default function ClaimPage() {
  const fragment = usePageFragment();
  const wallet = useWallet();
  const tokens = useTokensApp();
  const tx = useTokenTransaction();
  const [read, setRead] = useState<{ link: string; inspection?: ClaimLinkInspection; error?: string }>();
  const [draft, setDraft] = usePublicationDraft();
  const [claiming, setClaiming] = useState(false);
  const [claimResult, setClaimResult] = useState<{ link: string; claimed: TokenClaimResult }>();
  const [claimError, setClaimError] = useState<{ link: string; failure: TokenFailure }>();
  const [claimUnsettled, setClaimUnsettled] = useState<{ link: string; message: string }>();
  const link = fragment;
  const inspection = read !== undefined && read.link === link ? read.inspection : undefined;
  const readError = read !== undefined && read.link === link ? read.error : undefined;
  const claimed = claimResult !== undefined && claimResult.link === link ? claimResult.claimed : undefined;
  const error = claimError !== undefined && claimError.link === link ? claimError.failure : undefined;
  const unsettled = claimUnsettled !== undefined && claimUnsettled.link === link ? claimUnsettled.message : undefined;

  const inspect = useCallback(async () => {
    if (link === undefined) return;
    setRead({ link });
    try {
      const inspection = await tokens.inspectLink(link);
      setRead((current) => current !== undefined && current.link === link ? { link, inspection } : current);
    } catch (cause) {
      setRead((current) => current !== undefined && current.link === link ? { link, error: errorMessage(cause) } : current);
    }
  }, [link, tokens.inspectLink]);
  useEffect(() => { void inspect(); }, [inspect]);

  const claim = () => {
    if (link === undefined || inspection === undefined) return;
    const publication = checkedPublication(draft, wallet.funds?.spendablePrivate);
    if ("problem" in publication) { setClaimError({ link, failure: { message: publication.problem } }); return; }
    setClaiming(true);
    setClaimError(undefined);
    setClaimUnsettled(undefined);
    tokens.clearProgress();
    void runClaim(tx, tokens, publication.choice, { amount: inspection.amount, unit: tokenUnit(inspection.definition) },
      (app, options) => app.claimLink(link, options)).then((outcome) => {
      if ("claimed" in outcome) setClaimResult({ link, claimed: outcome.claimed });
      else if ("failure" in outcome) setClaimError({ link, failure: outcome.failure });
      else setClaimUnsettled({ link, message: outcome.unsettled });
    }).finally(() => {
      setClaiming(false);
      void inspect();
    });
  };

  const unit = inspection === undefined ? undefined : tokenUnit(inspection.definition);
  return <section className={`${paper.page} ${styles.stack}`}>
    <Metadata {...route.metadata} />
    <RouteHeader eyebrow="Claim link" title={inspection === undefined || unit === undefined ? "Claim tokens" : `Claim ${formatTokenAmount(inspection.amount, unit)}`}
      description="Claim the tokens from this link into your own wallet; it works even if you hold no PCASH." />
    {link === undefined ? <Notice>Open the full claim link you were sent. The part after “#” holds the claim.</Notice> : <>
      <Notice>Keep this link to yourself until you claim: anyone with it can claim its tokens, including the person who made it. Once you claim, the tokens are yours.</Notice>
      <div className={styles.columns}>
        <section className="panel" aria-labelledby="claim-token">
          <div className={styles.panelHeading}><h2 id="claim-token">Token</h2>
            {inspection !== undefined && <span className={`${styles.chip} ${inspection.status === "claimable" ? styles.chipDone : inspection.status === "claimed" ? styles.chipWarn : styles.chipBad}`} data-claim-status={inspection.status}>{STATUS_TEXT[inspection.status]}</span>}</div>
          {inspection === undefined || unit === undefined
            ? readError !== undefined ? <Notice tone="error">{readError}</Notice>
              : <p className={styles.hint} role="status">Reading the link…</p>
            : <>
              <p className={styles.claimAmount} data-testid="claim-amount"><TokenAmount value={inspection.amount} unit={unit} /></p>
              <VerifiedDefinition definition={inspection.definition} assetId={inspection.assetId} />
              {inspection.status === "unfunded" && <p className={styles.hint}>The creator’s funding for this link is not confirmed yet. Try again in a few minutes.</p>}
              {inspection.status === "invalid" && <p className={styles.hint}>This link does not open any tokens on this network. Check that you are on the network it was made for.</p>}
            </>}
        </section>
        <section className="panel" aria-labelledby="claim-action">
          <div className={styles.panelHeading}><h2 id="claim-action">Claim</h2></div>
          <ClaimWalletPrompt purpose="to claim these tokens" />
          {claimed !== undefined && unit !== undefined && <Notice tone="success">You claimed <TokenAmount value={claimed.amount} unit={unit} />. It is in your wallet. <Link to={tokenPath(claimed.assetId)}>Open the token →</Link></Notice>}
          {wallet.wallet !== undefined && inspection?.status === "claimable" && claimed === undefined && <div className={styles.form}>
            <p className={styles.hint}>The tokens go to this wallet, {wallet.connectedAccount}.</p>
            <TokenPublicationFields draft={draft} onChange={setDraft} disabled={claiming} contract="claim" />
            {error !== undefined && <TokenFailureNotice failure={error} onCleared={() => setClaimError(undefined)} />}
            {unsettled !== undefined && <Notice tone="warning">{unsettled}</Notice>}
            {claiming ? <TokensActionProgress progress={tokens.progress} />
              : <div className={styles.actions}><button type="button" className="button primary" disabled={wallet.busy} onClick={claim}>Claim</button></div>}
          </div>}
          {inspection?.status === "claimed" && claimed === undefined && <p className={styles.hint}>These tokens have already been claimed. A link can be claimed once.</p>}
        </section>
      </div>
    </>}
  </section>;
}
