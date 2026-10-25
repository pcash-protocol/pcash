import { useId, useState, type Ref } from "react";
import { Link } from "react-router-dom";
import { encodePost, MAX_TEXT_BYTES, type BoardNetwork } from "@pcash/board";
import { defaultOpenFee } from "@pcash/sdk/wallet/actions";
import { ExternalLinkIcon } from "../../components/icons.tsx";
import { Notice } from "../../components/Notice.tsx";
import { PcashAmount } from "../../components/PcashAmount.tsx";
import { ProofProgress } from "../../components/ProofProgress.tsx";
import { SubmissionChoice } from "../../components/SubmissionChoice.tsx";
import { ConfirmInWallet, useConfirmInWallet } from "../../components/WalletSubmissionLock.tsx";
import { useEthereumNetwork } from "../../lib/EthereumProvider.tsx";
import { usePaymentIssuance } from "../../lib/usePaymentIssuance.ts";
import { errorMessage, useWallet, WalletPaymentCanceledError, type WalletSendIntent } from "../../lib/WalletProvider.tsx";
import { useWebsiteSettings, type SubmissionMode } from "../../lib/WebsiteSettings.tsx";
import { etherscanTransactionUrl } from "../explorer/format.ts";
import { transactionPath } from "../explorer/paths.ts";
import { TokenWalletPrompt } from "../tokens/TokenCommon.tsx";
import { shortValue } from "../wallet/model.ts";
import { BOARD } from "./useBoard.ts";
import styles from "./Messages.module.css";

const FAST_EXPLANATION = "Your Ethereum wallet posts it to Ethereum and pays the gas, so anyone can see which Ethereum account published your post.";

/**
 * One post: a zero-value publication from the visitor's own wallet. More
 * private sends it through the public mempool for an open fee; Faster posts it
 * from the connected Ethereum account, which names that account as its sender.
 */
export function Composer({ network, parent, ref, onSent }: {
  network: BoardNetwork;
  /** The post this replies to; a new thread has none. */
  parent?: string;
  ref?: Ref<HTMLTextAreaElement>;
  /** Called once a post is sent, so the page can show it as pending. */
  onSent?: () => void;
}) {
  const wallet = useWallet();
  const ready = wallet.phase === "ready";
  const { getDefaultSubmissionMode } = useWebsiteSettings();
  const [mode, setMode] = useState<SubmissionMode>(getDefaultSubmissionMode);
  const issuance = usePaymentIssuance(ready && mode === "slow");
  const countId = useId();
  const [text, setText] = useState("");
  const [checking, setChecking] = useState(false);
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState<string>();
  const [sent, setSent] = useState<string>();
  const fast = mode === "fast";
  const stage = wallet.paymentStage.state;
  const confirming = useConfirmInWallet(posting && stage === "submitting" && fast);
  const caveat = <p className={styles.hint}>{fast
    ? "Posts are public and permanent. Faster posts from your Ethereum account, so anyone can link that account to your post."
    : "Posts are public and permanent. Your account stays hidden, but the node you post through sees your network address and when you posted."}</p>;
  if (!ready) return <>{caveat}<TokenWalletPrompt purpose={parent === undefined ? "to start a thread" : "to reply"} /></>;

  const bytes = new TextEncoder().encode(text).length;
  const fee = issuance.inputs === undefined ? undefined : defaultOpenFee(issuance.issuance);
  const short = !fast && fee !== undefined && wallet.funds !== undefined && wallet.funds.spendablePrivate < fee;
  const post = async () => {
    setError(undefined);
    setSent(undefined);
    setPosting(true);
    setChecking(true);
    try {
      const { record } = encodePost(network, { board: BOARD, text, parent: parent ?? null });
      const data = { public: [record] };
      // Self-publication pays Ethereum gas and no open fee.
      const intent: WalletSendIntent = fast
        ? { to: wallet.wallet!.address, amount: 0n, publication: "self", data }
        : { to: wallet.wallet!.address, amount: 0n, openFeeAmount: fee!, publication: "open", data };
      const review = await wallet.preflightPrivateSend(intent);
      setChecking(false);
      setSent((await wallet.sendPrivate(intent, review)).contentHash);
      setText("");
      onSent?.();
    } catch (cause) {
      if (!(cause instanceof WalletPaymentCanceledError)) setError(errorMessage(cause));
    } finally {
      setChecking(false);
      setPosting(false);
      wallet.resetPrivateSend();
    }
  };
  return <form className={styles.composer} aria-label={parent === undefined ? "New thread" : "Reply"} onSubmit={(event) => {
    event.preventDefault();
    void post();
  }}>
    {caveat}
    <label className={styles.field}>{parent === undefined ? "Your post" : "Your reply"}
      <textarea ref={ref} value={text} rows={5} dir="auto" readOnly={posting} aria-describedby={countId}
        onChange={(event) => { setText(event.target.value); setSent(undefined); }} />
    </label>
    <p id={countId} className={bytes > MAX_TEXT_BYTES ? styles.fieldError : styles.hint}>{bytes} of {MAX_TEXT_BYTES} bytes</p>
    <SubmissionChoice label="Speed" value={mode} onChange={(next) => { setMode(next); setSent(undefined); setError(undefined); }} openFee={fee} disabled={posting}
      fastDisabled={wallet.selfPublication === undefined} fastExplanation={FAST_EXPLANATION} />
    {short && <Notice>Posting costs a <PcashAmount value={fee!} rounding="up" /> network fee, and your wallet has <PcashAmount value={wallet.funds!.spendablePrivate} rounding="down" />. <Link to="/get">Get PCASH</Link> first, or choose Faster.</Notice>}
    {checking ? <p className={styles.statusLine} role="status"><span className="spinner" aria-hidden="true" />Checking your balance…</p>
      : posting && (stage === "proving" || stage === "canceling"
      ? <ProofProgress proof={wallet.progress} awaitingSignature={wallet.awaitingSignature} label="Proving your post" />
      : confirming ? <ConfirmInWallet />
      : wallet.paymentStage.state === "l1-submitted" ? <PostedToEthereum hash={wallet.paymentStage.l1Hash} />
      : <p className={styles.statusLine} role="status"><span className="spinner" aria-hidden="true" />Sending your post…</p>)}
    {error !== undefined && <Notice tone="error">{error}</Notice>}
    {sent !== undefined && <Notice tone="success">Transaction successful <Link to={transactionPath(sent)}><code>{shortValue(sent)}</code></Link></Notice>}
    <div className={styles.actions}>
      <button className="button primary" type="submit"
        disabled={posting || bytes === 0 || bytes > MAX_TEXT_BYTES || (!fast && (fee === undefined || short)) || wallet.busy}>Post</button>
      {posting && <button className="button" type="button" disabled={stage !== "proving"} onClick={() => wallet.cancelPrivateSend()}>Cancel</button>}
    </div>
  </form>;
}

/** A Faster post the Ethereum wallet has sent: it waits for Ethereum to include it, then for the network to settle it. */
function PostedToEthereum({ hash }: { hash: string }) {
  const href = etherscanTransactionUrl(useEthereumNetwork().l1ChainId, hash);
  return <p className={styles.statusLine} role="status"><span className="spinner" aria-hidden="true" />
    Sent to Ethereum. Waiting for it to be included…{href !== undefined && <> <a href={href} target="_blank" rel="noreferrer">View on Etherscan<ExternalLinkIcon /></a></>}</p>;
}
