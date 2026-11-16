import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { ClaimLinkInspection, TokenClaimResult, TokensActionOptions, TokensApp } from "@pcash/tokens/app";
import { Notice } from "../../components/Notice.tsx";
import { RouteHeader } from "../../components/RouteHeader.tsx";
import { TokenAmount } from "../../components/TokenAmount.tsx";
import { PCASH_UNIT } from "../../components/pcashAmount.ts";
import { formatTokenAmount, type AmountUnit } from "../../components/tokenAmount.ts";
import { errorMessage, useWallet } from "../../lib/WalletProvider.tsx";
import { S_ACTION_UNITS, S_ACTION_WITH_ACCOUNT_UNITS, useNetworkFee } from "../../lib/useNetworkFee.ts";
import { Metadata } from "../Metadata.tsx";
import { routeById } from "../routeManifest.ts";
import paper from "../PaperPage.module.css";
import { tokenPath, tokenUnit } from "./model.ts";
import { TokenFailureNotice, type TokenFailure } from "./EthereumSubmission.tsx";
import { VerifiedDefinition, WalletPromptButton } from "./TokenCommon.tsx";
import { checkedLinkPublication, checkedPublication, publicationChoice, TokenPublicationFields, usePublicationDraft } from "./TokenPublicationFields.tsx";
import { TokensActionProgress } from "./TokenTransactionStatus.tsx";
import { usePageFragment } from "./usePageFragment.ts";
import { useTokensApp } from "./useTokensApp.ts";
import { pcashFeeFor, useTokenTransaction, type TokenPublicationChoice } from "./useTokenTransaction.ts";
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

/** What a native claim pays and leaves for the chosen route: the relayer fee and the network fee come out of the link. */
function NativeClaimSummary({ amount, draft, networkFee }: { amount: bigint; draft: Parameters<typeof publicationChoice>[0]; networkFee: bigint }) {
  let fee: bigint;
  try {
    fee = pcashFeeFor(publicationChoice(draft));
  } catch {
    return null;
  }
  const fees = fee + networkFee;
  return <dl className={styles.facts} aria-label="Claim summary">
    <dt>Link</dt><dd><TokenAmount value={amount} unit={PCASH_UNIT} /></dd>
    <dt>Relayer fee</dt><dd><TokenAmount value={fee} unit={PCASH_UNIT} /></dd>
    {networkFee > 0n && <><dt>Network fee</dt><dd data-testid="claim-network-fee"><TokenAmount value={networkFee} unit={PCASH_UNIT} rounding="up" /></dd></>}
    <dt>You receive</dt><dd data-testid="claim-net">{fees < amount ? <TokenAmount value={amount - fees} unit={PCASH_UNIT} /> : "Nothing"}</dd>
  </dl>;
}

export default function ClaimPage() {
  const fragment = usePageFragment();
  const wallet = useWallet();
  const tokens = useTokensApp();
  const tx = useTokenTransaction();
  const [read, setRead] = useState<{ link: string; inspection?: ClaimLinkInspection; error?: string }>();
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
  // A native PCASH link pays its relayer fee out of its own value.
  const native = inspection !== undefined && inspection.definition === null;
  const linkValue = native ? inspection.amount : undefined;
  // With no account yet the claim also creates it; a relayer then posts it, so it needs no ETH.
  const createsAccount = wallet.accountRecord === "absent";
  const [draft, setDraft] = usePublicationDraft(true, 1, linkValue, createsAccount ? "slow" : undefined);
  // A native link burns it from its own value; a token claim burns it from this wallet's PCASH.
  const networkFee = useNetworkFee(createsAccount ? S_ACTION_WITH_ACCOUNT_UNITS : S_ACTION_UNITS, inspection !== undefined) ?? 0n;

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
    const publication = linkValue !== undefined ? checkedLinkPublication(draft, linkValue) : checkedPublication(draft, wallet.funds?.spendablePrivate);
    if ("problem" in publication) { setClaimError({ link, failure: { message: publication.problem } }); return; }
    setClaiming(true);
    setClaimError(undefined);
    setClaimUnsettled(undefined);
    tokens.clearProgress();
    // Activity records what arrives: a native claim's fee comes out of the link.
    const received = inspection.amount - (native ? pcashFeeFor(publication.choice) + networkFee : 0n);
    const claimUnit = inspection.definition === null ? PCASH_UNIT : tokenUnit(inspection.definition);
    void runClaim(tx, tokens, { ...publication.choice, createsAccount }, { amount: received, unit: claimUnit },
      (app, options) => app.claimLink(link, options)).then((outcome) => {
      if ("claimed" in outcome) {
        setClaimResult({ link, claimed: outcome.claimed });
        if (createsAccount) void wallet.checkAccountActivation().catch(() => undefined);
      }
      else if ("failure" in outcome) setClaimError({ link, failure: outcome.failure });
      else setClaimUnsettled({ link, message: outcome.unsettled });
    }).finally(() => {
      setClaiming(false);
      void inspect();
    });
  };

  const unit = inspection === undefined ? undefined : inspection.definition === null ? PCASH_UNIT : tokenUnit(inspection.definition);
  const what = native ? "PCASH" : "tokens";
  return <section className={`${paper.page} ${styles.stack}`}>
    <Metadata {...route.metadata} />
    <RouteHeader eyebrow="Claim link" title={inspection === undefined || unit === undefined ? "Claim a link" : `Claim ${formatTokenAmount(inspection.amount, unit)}`}
      description={`Claim the ${inspection === undefined ? "money" : what} from this link into your own wallet${native || networkFee === 0n ? "; it works even if you hold no PCASH" : ""}.`} />
    {link === undefined ? <Notice>Open the full claim link you were sent. The part after “#” holds the claim.</Notice> : <>
      <Notice>Keep this link to yourself until you claim: anyone with it can claim its {what}, including the person who made it. Once you claim, the {native ? "PCASH is" : "tokens are"} yours.</Notice>
      <div className={styles.columns}>
        <section className="panel" aria-labelledby="claim-token">
          <div className={styles.panelHeading}><h2 id="claim-token">{native ? "PCASH" : "Token"}</h2>
            {inspection !== undefined && <span className={`${styles.chip} ${inspection.status === "claimable" ? styles.chipDone : inspection.status === "claimed" ? styles.chipWarn : styles.chipBad}`} data-claim-status={inspection.status}>{STATUS_TEXT[inspection.status]}</span>}</div>
          {inspection === undefined || unit === undefined
            ? readError !== undefined ? <Notice tone="error">{readError}</Notice>
              : <p className={styles.hint} role="status">Reading the link…</p>
            : <>
              <p className={styles.claimAmount} data-testid="claim-amount"><TokenAmount value={inspection.amount} unit={unit} /></p>
              {inspection.definition !== null && <VerifiedDefinition definition={inspection.definition} assetId={inspection.assetId} />}
              {inspection.status === "unfunded" && <p className={styles.hint}>The creator’s funding for this link is not confirmed yet. Try again in a few minutes.</p>}
              {inspection.status === "invalid" && <p className={styles.hint}>This link does not open anything on this network. Check that you are on the network it was made for.</p>}
            </>}
        </section>
        <section className="panel" aria-labelledby="claim-action">
          <div className={styles.panelHeading}><h2 id="claim-action">Claim</h2></div>
          <ClaimWalletPrompt purpose={native ? "to claim this PCASH" : "to claim these tokens"} />
          {claimed !== undefined && unit !== undefined && <Notice tone="success">
            You claimed <TokenAmount value={claimed.definition === null ? claimed.amount - claimed.openFeeAmount - claimed.nativeBurnAmount : claimed.amount} unit={unit} />. It is in your wallet.
            {claimed.definition !== null && <> <Link to={tokenPath(claimed.assetId)}>Open the token →</Link></>}
          </Notice>}
          {wallet.wallet !== undefined && inspection?.status === "claimable" && claimed === undefined && <div className={styles.form}>
            <p className={styles.hint}>The {what} go to this wallet, {wallet.connectedAccount}.</p>
            {createsAccount && <p className={styles.hint} data-testid="claim-creates-account">This wallet has no PCASH account yet. The claim creates it in the same transaction, after you approve one signature.{draft.mode === "slow" ? " No ETH required." : ""}</p>}
            <TokenPublicationFields draft={draft} onChange={setDraft} disabled={claiming} contract="claim" {...(linkValue === undefined ? {} : { linkValue })} />
            {linkValue !== undefined && <NativeClaimSummary amount={linkValue} draft={draft} networkFee={networkFee} />}
            {error !== undefined && <TokenFailureNotice failure={error} onCleared={() => setClaimError(undefined)} />}
            {unsettled !== undefined && <Notice tone="warning">{unsettled}</Notice>}
            {claiming ? <TokensActionProgress progress={tokens.progress} />
              : <div className={styles.actions}><button type="button" className="button primary" disabled={wallet.busy} onClick={claim}>{createsAccount ? "Create account & claim" : "Claim"}</button></div>}
          </div>}
          {inspection?.status === "claimed" && claimed === undefined && <p className={styles.hint}>This link has already been claimed. A link can be claimed once.{createsAccount && " Your PCASH account was not created; you can still set it up from your wallet."}</p>}
        </section>
      </div>
    </>}
  </section>;
}
