import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ExternalLinkIcon } from "./icons.tsx";
import { pollReceipt } from "@pcash/sdk/clients";
import { useNetwork } from "./NetworkContext.tsx";
import { useWallet, errorMessage } from "../lib/WalletProvider.tsx";
import { finalizeMempoolTransaction } from "../lib/finalizeMempoolTransaction.ts";
import { usePendingTransactionState } from "../lib/usePendingTransactionState.ts";
import { Notice } from "./Notice.tsx";
import { Tooltip } from "./Tooltip.tsx";
import { etherscanTransactionUrl } from "../routes/explorer/format.ts";
import styles from "./MempoolFinalization.module.css";

const POST_EXPLANATION = "Posts it to Ethereum in a batch with other pending transactions. Your Ethereum wallet pays the gas in ETH and earns the issuance.";

export function MempoolFinalization({ contentHash, onConfirmed, compact = false, fallback }: {
  contentHash: string;
  onConfirmed?: (() => void) | undefined;
  compact?: boolean;
  fallback?: ReactNode;
}) {
  const wallet = useWallet();
  const { network } = useNetwork();
  const query = usePendingTransactionState(contentHash);
  const observed = query.data;
  // What this component's own Post to Ethereum action learned before the shared poll catches up.
  const [sendingState, setSendingState] = useState<"ethereum" | "confirmed">();
  const [hash, setHash] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string>();
  const state = sendingState ?? observed?.state ?? "checking";
  const error = actionError ?? (query.error ? errorMessage(query.error) : observed?.reconcileError);
  const mounted = useRef(false);
  const sending = useRef(false);
  const authorized = useRef(false);
  const current = useRef(wallet);
  current.current = wallet;
  const confirmed = useRef(onConfirmed);
  confirmed.current = onConfirmed;
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; authorized.current = false; };
  }, []);
  useEffect(() => {
    if (observed?.hash !== undefined) setHash(observed.hash);
  }, [observed?.hash]);
  useEffect(() => {
    if (observed?.state === "confirmed" && authorized.current && !sending.current) { authorized.current = false; confirmed.current?.(); }
  }, [observed?.state]);
  const finalize = async () => {
    const { profile, selfPublication, connectedAccount } = wallet;
    if (sending.current || profile === undefined || selfPublication === undefined || connectedAccount === undefined) return;
    sending.current = true;
    authorized.current = true;
    setBusy(true); setActionError(undefined);
    const assertActive = () => {
      if (!mounted.current || current.current.node !== wallet.node || current.current.profile?.address !== profile.address || current.current.selfPublication !== selfPublication || current.current.connectedAccount !== connectedAccount) {
        throw new Error("Your wallet changed. Open this trade with its original wallet to continue.");
      }
    };
    try {
      await finalizeMempoolTransaction({ node: wallet.node, readStatus: wallet.readStatus, submission: selfPublication,
        contentHash, profile, ownPendingContentHashes: wallet.snapshot?.pendingContentHashes ?? [], assertActive,
        onL1Submitted: async (value) => { setHash(value); setSendingState("ethereum"); },
      });
      assertActive();
      const receipt = await pollReceipt(wallet.node, contentHash);
      assertActive();
      if (receipt?.outcome === "succeeded") {
        setSendingState("confirmed"); authorized.current = false; confirmed.current?.();
      }
    } catch (cause) { authorized.current = false; setActionError(errorMessage(cause)); }
    finally {
      sending.current = false; setBusy(false);
      void query.refetch().finally(() => setSendingState(undefined));
    }
  };
  const finalizeButton = <Tooltip placement="top" tip={`${POST_EXPLANATION} Posting right after you submit can make the transaction easier to link to your Ethereum wallet by timing.`}>
    {id => <button aria-describedby={id} className={`button primary ${styles.finalizeButton}`} type="button" disabled={busy || wallet.phase !== "ready" || wallet.selfPublication === undefined || wallet.connectedAccount === undefined}
      onClick={() => void finalize()}>{busy ? "Posting…" : "Post to Ethereum"}</button>}
  </Tooltip>;
  if (compact) {
    const l1Url = hash && etherscanTransactionUrl(network.l1ChainId, hash);
    return <div className={styles.compact}>
      {state === "mempool" ? finalizeButton : <span role="status">{state === "checking" ? "Checking transaction…"
        : state === "confirmed" ? "Included" : state === "absent" ? "Not in mempool"
        : state === "ambiguous" ? (busy ? "Approve in your wallet" : "Check Ethereum submission") : "Posted, waiting for inclusion"}</span>}
      {(state === "absent" || state === "confirmed") && fallback}
      {hash && <Link to={`/batch/${hash}`}>PCASH batch</Link>}
      {l1Url && <a href={l1Url} target="_blank" rel="noreferrer">Ethereum transaction<ExternalLinkIcon /></a>}
      {(state === "ambiguous" || error) && <Link to="#ethereum-submission">Review submission</Link>}
      {error && <span role="alert">{error}</span>}
    </div>;
  }
  if (state === "checking") return <p role="status">{error ?? "Checking transaction status…"}</p>;
  if (state === "absent") return <Notice>This transaction is no longer ready in the mempool. Open your activity and continue the trade to check its progress.{error && <p role="alert">{error}</p>}</Notice>;
  return <Notice tone={state === "confirmed" ? "success" : "warning"}>
    <p role="status">{state === "mempool" ? "Not posted to Ethereum yet."
      : state === "confirmed" ? "Your transaction is included."
      : state === "ambiguous" ? (busy ? "Approve the Ethereum transaction in your wallet." : "Check your Ethereum submission before trying again.")
      : "Posted, waiting for inclusion."}</p>
    {state === "mempool" && <>
      <p>{POST_EXPLANATION}</p>
      {finalizeButton}
    </>}
    {hash && <p><Link to={`/batch/${hash}`}>View PCASH batch</Link></p>}
    {(state === "ambiguous" || error) && <Link to="#ethereum-submission">Review Ethereum submission</Link>}
    {error && <p role="alert">{error}</p>}
  </Notice>;
}
