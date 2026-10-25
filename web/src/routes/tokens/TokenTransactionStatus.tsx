import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { pollReceipt, type ReceiptResult } from "@pcash/sdk/clients";
import { ExternalLinkIcon } from "../../components/icons.tsx";
import { Notice } from "../../components/Notice.tsx";
import { ProofProgress } from "../../components/ProofProgress.tsx";
import { useEthereumNetwork } from "../../lib/EthereumProvider.tsx";
import { errorMessage, useWallet } from "../../lib/WalletProvider.tsx";
import { describeFailure, etherscanTransactionUrl } from "../explorer/format.ts";
import { transactionPath } from "../explorer/paths.ts";
import { shortValue } from "../wallet/model.ts";
import type { TokensPhase, TokensProgress } from "@pcash/tokens/app";
import { EthereumSubmissionLock } from "./EthereumSubmission.tsx";
import type { TokenTransactionFate, TokenTxStage } from "./useTokenTransaction.ts";
import styles from "./Tokens.module.css";

/** Signing, proving and submitting, with the wallet's live proof progress. */
export function TokenProofProgress({ stage, label }: { stage: TokenTxStage; label: string }) {
  const { progress, actionProgress, awaitingSignature } = useWallet();
  if (stage.state === "submitting") {
    return <div className={styles.status}><p className={styles.statusLine} role="status"><span className="spinner" aria-hidden="true" />Submitting transaction <code>{shortValue(stage.contentHash)}</code>…</p></div>;
  }
  if (stage.state !== "working") return null;
  return <div className={styles.status}>
    <ProofProgress proof={progress} awaitingSignature={awaitingSignature} label={label}
      {...(!progress && actionProgress ? { detail: actionProgress.message } : {})} />
  </div>;
}

const PHASE_LABELS: Record<TokensPhase, string> = {
  preparing: "Preparing",
  "creating-contract": "Creating the contract",
  funding: "Funding",
  publishing: "Publishing",
  signing: "Approve in your wallet",
  proving: "Proving",
  submitting: "Submitting",
  confirming: "Pending",
};

/** A running token contract action: the app's current step, with the proof of whichever prover is at work. */
export function TokensActionProgress({ progress }: { progress: TokensProgress | undefined }) {
  const { progress: proof, awaitingSignature } = useWallet();
  const walletProving = progress?.phase === "creating-contract" || progress?.phase === "funding";
  return <div className={styles.status}>
    <ProofProgress proof={walletProving ? proof : progress?.proof} awaitingSignature={awaitingSignature}
      label={progress === undefined ? "Preparing" : PHASE_LABELS[progress.phase]}
      {...(walletProving && proof !== undefined ? {} : { detail: progress?.message ?? "Starting…" })} />
  </div>;
}

type Observation = { receipt: ReceiptResult | null; journaled: boolean };

/**
 * Follow one submitted transaction until PCASH answers. A transaction the
 * wallet no longer journals and PCASH never accepted expired without effect.
 */
export function SentTransaction({ contentHash, mode, l1Hash, noun, onExpired, children }: {
  contentHash: string;
  mode: "fast" | "slow";
  l1Hash?: string | undefined;
  noun: string;
  onExpired?: ReactNode;
  children?: ReactNode;
}) {
  const { node, wallet } = useWallet();
  const { l1ChainId } = useEthereumNetwork();
  const [observation, setObservation] = useState<Observation>();
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const check = async () => {
      try {
        const journaled = wallet === undefined ? true
          : (await wallet.snapshot()).pendingContentHashes.includes(contentHash.toLowerCase());
        const receipt = await pollReceipt(node, contentHash);
        if (stopped) return;
        setObservation({ receipt, journaled });
        if (receipt !== null || !journaled) return;
      } catch {
        // Keep checking; a transient read failure says nothing about the transaction.
      }
      if (!stopped) timer = setTimeout(() => void check(), 3_000);
    };
    void check();
    return () => { stopped = true; clearTimeout(timer); };
  }, [node, contentHash, wallet]);
  const receipt = observation?.receipt ?? null;
  const expired = observation !== undefined && receipt === null && !observation.journaled;
  const href = l1Hash === undefined ? undefined : etherscanTransactionUrl(l1ChainId, l1Hash);
  return <div className={styles.status} data-testid="token-transaction-status">
    {receipt?.outcome === "succeeded" ? <p className={`${styles.statusLine} ${styles.done}`} role="status"><span aria-hidden="true">✓</span> The {noun} is confirmed in PCASH.</p>
      : receipt !== null ? <Notice tone="error">PCASH did not accept this {noun}. {describeFailure(receipt.outcome)}</Notice>
      : expired ? <Notice>This {noun} expired before it was included. Nothing changed.</Notice>
      : <p className={styles.statusLine} role="status"><span className="spinner" aria-hidden="true" />{l1Hash !== undefined ? "Posted to Ethereum. Waiting for PCASH to process it…"
        : mode === "fast" ? "Waiting for your Ethereum wallet to post it…"
          : "In the PCASH mempool, waiting for a relayer to post it to Ethereum…"}</p>}
    <p className={styles.muted}>PCASH transaction <Link to={transactionPath(contentHash)}><code>{shortValue(contentHash)}</code></Link>
      {l1Hash !== undefined && <> · Ethereum transaction {href === undefined ? <code>{shortValue(l1Hash)}</code> : <a href={href} target="_blank" rel="noreferrer"><code>{shortValue(l1Hash)}</code><ExternalLinkIcon /></a>}</>}</p>
    {expired && onExpired}
    {children}
  </div>;
}

/**
 * The exact bytes are journaled but the network's answer never arrived.
 * Checking decides between confirmed, still pending (resubmit the same bytes),
 * and gone without effect.
 */
export function UnknownTransaction({ contentHash, noun, fast = false, fate, onConfirmed, onRetry, onCleared }: {
  contentHash: string;
  noun: string;
  /** Sent from the connected Ethereum wallet, whose unresolved submission must settle before it can be sent again. */
  fast?: boolean;
  fate(contentHash: string): Promise<TokenTransactionFate>;
  onConfirmed(): void;
  onRetry?: (() => void) | undefined;
  onCleared: ReactNode;
}) {
  const { busy } = useWallet();
  const [checked, setChecked] = useState<TokenTransactionFate>();
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string>();
  const check = () => {
    setChecking(true);
    setError(undefined);
    void fate(contentHash).then((result) => {
      setChecked(result);
      if (result === "confirmed") onConfirmed();
    }).catch((cause) => setError(errorMessage(cause))).finally(() => setChecking(false));
  };
  return <div className={styles.status}>
    {checked === undefined && <Notice>We couldn’t confirm whether the network received this {noun}. Check its status before trying again.</Notice>}
    {checked === "pending" && <Notice>The {noun} is still pending. {onRetry === undefined ? "The wallet releases it if it expires." : "You can submit the same transaction again."}</Notice>}
    {checked === "cleared" && <Notice>The {noun} was not included and has expired. Nothing changed.</Notice>}
    {error !== undefined && <Notice tone="error">{error}</Notice>}
    {fast && checked !== "confirmed" && checked !== "cleared" && <EthereumSubmissionLock />}
    <p className={styles.muted}>PCASH transaction <Link to={transactionPath(contentHash)}><code>{shortValue(contentHash)}</code></Link></p>
    <div className={styles.actions}>
      {checked !== "cleared" && <button type="button" className={checked === "pending" && onRetry !== undefined ? "button" : "button primary"} disabled={busy || checking} onClick={check}>{checking ? "Checking…" : "Check status"}</button>}
      {checked === "pending" && onRetry !== undefined && <button type="button" className="button primary" disabled={busy || checking} onClick={onRetry}>Submit again</button>}
      {checked === "cleared" && onCleared}
    </div>
  </div>;
}
