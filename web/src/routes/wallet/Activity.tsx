import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { keepPreviousData, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import type { StoredOffer } from "@pcash/marketplace/app";
import { transactionIdentity } from "@pcash/sdk/browser";
import { pollReceipt, type ReceiptResult } from "@pcash/sdk/clients";
import { addressHex, fromHex } from "@pcash/sdk/utils";
import {
  ArrowDownLeftIcon,
  ArrowUpRightIcon,
  CirclePlusIcon,
  ExternalLinkIcon,
  FlameIcon,
  GiftIcon,
  HandCoinsIcon,
  LockIcon,
  PickaxeIcon,
  ShoppingCartIcon,
  TagIcon,
  Undo2Icon,
  UserCheckIcon,
} from "../../components/icons.tsx";
import { NativeActivityNotice } from "../../components/NativeActivityNotice.tsx";
import { useNetwork } from "../../components/NetworkContext.tsx";
import { RelativeTime } from "../../components/RelativeTime.tsx";
import { Tooltip } from "../../components/Tooltip.tsx";
import { ConfirmInWallet, useConfirmInWallet } from "../../components/WalletSubmissionLock.tsx";
import { useEthereumNetwork } from "../../lib/EthereumProvider.tsx";
import { marketplaceStoreName, openMarketplaceStore } from "../../lib/MarketplaceStore.ts";
import { networkInstanceKey } from "../../lib/networks.ts";
import { usePostPending } from "../../lib/postPending.ts";
import { querySession } from "../../lib/querySession.ts";
import { useTokenActivity, walletTokenActivityKey } from "../../lib/tokenActivity.ts";
import { useNativeActivity } from "../../lib/useNativeActivity.ts";
import { usePendingTransactionState } from "../../lib/usePendingTransactionState.ts";
import { errorMessage, useWallet, type WalletPaymentActivity } from "../../lib/WalletProvider.tsx";
import { activityReceiptHashes, activityRows, shownState, type ActivityKind, type ActivityRow } from "./activityRows.tsx";
import { saleCandidates, useListingSales } from "../marketplace/sales.ts";
import { usePurchaseClaims } from "../marketplace/purchases.ts";
import { useWalletPanel } from "./OwnerPanels.tsx";
import styles from "./Activity.module.css";

const ICONS: Record<ActivityKind, ReactNode> = {
  sent: <ArrowUpRightIcon />,
  received: <ArrowDownLeftIcon />,
  mined: <PickaxeIcon />,
  setup: <UserCheckIcon />,
  listed: <TagIcon />,
  escrow: <LockIcon />,
  bought: <ShoppingCartIcon />,
  sold: <HandCoinsIcon />,
  reclaimed: <Undo2Icon />,
  "token-created": <CirclePlusIcon />,
  "token-sent": <ArrowUpRightIcon />,
  "token-burned": <FlameIcon />,
  "token-claimed": <GiftIcon />,
};

/** A receipt read, and whether it can no longer change: accepted in a block finalized when it was read. */
interface ActivityReceipt {
  receipt: ReceiptResult | null;
  final: boolean;
}

export function postPendingLabel({ pendingCount, ethereumTransactions }: { pendingCount: number; ethereumTransactions: number }): string {
  return `Post ${pendingCount} pending${ethereumTransactions > 1 ? ` (${ethereumTransactions} Ethereum transactions)` : ""}`;
}

/** Each Ethereum transaction is its own wallet prompt, so the count shows how far posting has come. */
export function postingLabel(progress: { current: number; total: number } | undefined): string {
  return progress === undefined || progress.total < 2 ? "Posting…" : `Posting ${progress.current} of ${progress.total}…`;
}

/** Marketplace records this browser keeps, read again whenever the wallet moves to a new state. */
function useLocalOffers(trigger: unknown): StoredOffer[] {
  const { network } = useNetwork();
  const scope = networkInstanceKey(network);
  const [offers, setOffers] = useState<StoredOffer[]>([]);
  useEffect(() => {
    let cancelled = false;
    void openMarketplaceStore(marketplaceStoreName(scope)).then(async (store) => {
      try {
        const listed = await store.list();
        if (!cancelled) setOffers(listed);
      } finally { store.close(); }
    })
      // The marketplace pages report an unavailable store; the feed shows the rest.
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [scope, trigger]);
  return offers;
}

function ActivityRowView({ row, postable, awaitingPrompt, highlighted, onNavigate, children }: {
  row: ActivityRow;
  /** "Post all pending" can post this row's transaction. */
  postable: boolean;
  /** This session's Ethereum wallet prompt for the row's transaction is still open. */
  awaitingPrompt: boolean;
  highlighted: boolean;
  onNavigate: (() => void) | undefined;
  children?: ReactNode;
}) {
  const observed = usePendingTransactionState(row.state.state === "pending" ? row.state.contentHash : undefined).data?.state;
  // A marketplace step saved before its submission is known waits until the
  // mempool or Ethereum holds it; a journaled one without a hash waits while its prompt is open.
  if (row.state.state === "pending" && row.state.submissionUnknown
    && (observed === undefined || observed === "absent" || (observed === "ambiguous" && awaitingPrompt))) return null;
  const state = shownState(row.state, observed);
  const detail = state.state === "pending"
    ? state.posted === true ? "Posted, waiting for inclusion" : state.posted === false && postable ? "Not posted yet" : state.detail
    : state.state === "failed" ? state.reason : undefined;
  const time = row.at === undefined ? undefined : <RelativeTime seconds={BigInt(Math.floor(row.at / 1_000))} suffix />;
  return <div className={styles.row} data-activity-kind={row.kind} data-activity-state={state.state}
    {...row.payment === undefined ? {} : { "data-payment-id": row.payment.contentHash, "data-payment-status": row.payment.status }}
    data-payment-highlighted={highlighted ? "true" : undefined}>
    <span className={styles.icon} aria-hidden="true">{ICONS[row.kind]}</span>
    <Link className={styles.text} onClick={onNavigate} to={row.href}>
      <span>{row.title}</span>
      {row.note !== undefined && <small className={styles.note}>{row.note}</small>}
      {(time !== undefined || detail !== undefined) && <small>{time}{time !== undefined && detail !== undefined && " · "}{detail}</small>}
    </Link>
    {state.state === "expired"
      ? <Tooltip tip="Transaction never confirmed" align="end" className={styles.chipTip}>{(tipId) =>
        <span className={`${styles.chip} ${styles.chipBad}`} tabIndex={0} aria-describedby={tipId}>Expired</span>}</Tooltip>
      : state.state !== "complete" && <span className={`${styles.chip} ${state.state === "pending" ? "" : styles.chipBad}`}>{state.state === "pending" ? "Pending" : "Failed"}</span>}
    {children !== undefined && children !== null && children !== false && <div className={styles.rowActions}>{children}</div>}
  </div>;
}

/**
 * Everything the signed-in wallet did or received, newest first: payments,
 * mining, account setup, marketplace trades, and token actions.
 */
export function Activity({ compact = false, onNavigate }: { compact?: boolean; onNavigate?: (() => void) | undefined }) {
  const { profile } = useWallet();
  if (profile === undefined) return <section id={compact ? "wallet-activity" : "activity"} className={styles.activity}><p>Sign in to see your activity.</p></section>;
  return <OwnerActivity owner={profile.address} compact={compact} onNavigate={onNavigate} />;
}

function OwnerActivity({ owner, compact, onNavigate }: { owner: bigint; compact: boolean; onNavigate: (() => void) | undefined }) {
  const wallet = useWallet();
  const { node, snapshot, busy, phase, awaitingConfirmation, activation, submissionLock, refreshSubmissionLock, walletPromptOpen } = wallet;
  const { l1Chain } = useEthereumNetwork();
  const native = useNativeActivity();
  const { reviewPendingPayment, resendPayment, highlightContentHash } = useWalletPanel();
  const post = usePostPending();
  const queryClient = useQueryClient();
  const offers = useLocalOffers(snapshot);
  const setupMiningContentHash = useMemo(() => activation?.miningTransactionHex === undefined ? undefined
    : transactionIdentity(fromHex(activation.miningTransactionHex)).contentHash.toLowerCase(), [activation?.miningTransactionHex]);
  // An action shows once it is committed: confirmed in the Ethereum wallet
  // (Faster) or submitted to the PCASH mempool (More private). A fresh action
  // still waiting on either stays out, and so does setup mining until its setup
  // transaction goes out. A declined prompt removes the record; any other
  // outcome shows it, with its recovery when the outcome is unclear.
  const awaitingPrompt = (contentHash: string) => awaitingConfirmation.has(contentHash.toLowerCase());
  const paymentActivity = wallet.paymentActivity.filter((payment) => payment.l1TxHash !== undefined
    || !(awaitingPrompt(payment.contentHash) || payment.contentHash === setupMiningContentHash));
  const tokens = useTokenActivity(walletTokenActivityKey(wallet))
    .filter((activity) => activity.awaitingSubmission !== true || !awaitingPrompt(activity.contentHash));
  const head = snapshot?.syncedThrough?.pcashHash;
  const session = querySession(node);
  const pendingContentHashes = useMemo(() => new Set(snapshot?.pendingContentHashes ?? []), [snapshot]);

  const accountEvents = useQuery({
    queryKey: ["activity-account-events", session, owner.toString(), head],
    queryFn: async () => (await node.getAccountHistory({ address: addressHex(owner), limit: 25 })).items,
    placeholderData: keepPreviousData,
    staleTime: Infinity,
    retry: false,
  });
  const hashes = activityReceiptHashes({ owner, payments: paymentActivity, offers, tokens });
  // Read before the receipt, so a receipt at or below it was in a finalized block when read.
  const finalizedL1 = wallet.followedStatus?.status.finalizedL1BlockNumber;
  const receiptQueries = useQueries({ queries: hashes.map((hash) => ({
    queryKey: ["activity-receipt", session, hash],
    queryFn: async (): Promise<ActivityReceipt> => {
      const receipt = await pollReceipt(node, hash);
      // A rejection is not final: a later inclusion of the same transaction can still be accepted.
      return { receipt, final: receipt?.outcome === "succeeded" && finalizedL1 !== undefined && receipt.inclusion.l1BlockNumber <= finalizedL1 };
    },
    staleTime: Infinity,
    retry: false,
  })) });
  // Each new wallet head reads again every receipt that can still change: none yet, a failed read,
  // a rejection, or an inclusion a reorg can remove. Final receipts stay cached.
  useEffect(() => {
    void queryClient.invalidateQueries({ queryKey: ["activity-receipt", session], predicate: (query) => (query.state.data as ActivityReceipt | undefined)?.final !== true },
      { cancelRefetch: false });
  }, [queryClient, session, head]);
  const receipts = new Map(hashes.flatMap((hash, index) => {
    const data = receiptQueries[index]!.data;
    return data === undefined ? [] : [[hash, data.receipt] as const];
  }));
  // Canonical rows wait for the receipts that tell which of them a local row already shows.
  const receiptsSettled = receiptQueries.every((query) => query.status !== "pending");
  const sold = useListingSales(saleCandidates(owner, offers));
  const purchased = usePurchaseClaims(owner, offers);

  const history = native.activity?.state === "ready" ? native.activity : undefined;
  const historyReady = history !== undefined && !native.failed;
  const historyCurrent = historyReady && history.pcashHash === head;
  const rows = activityRows({
    owner,
    payments: paymentActivity,
    canonical: receiptsSettled ? history?.entries : undefined,
    historyCurrent: historyCurrent && receiptsSettled,
    accountEvents: accountEvents.data ?? [],
    offers,
    sold,
    purchased,
    tokens,
    receipts,
    pendingContentHashes,
  });
  if (compact && highlightContentHash !== undefined) {
    const highlighted = rows.findIndex((row) => row.id === highlightContentHash);
    if (highlighted > 0) rows.unshift(...rows.splice(highlighted, 1));
  }
  const canReview = phase === "ready";
  // A retried mining action runs and fails here, in the list it was started from.
  const [retryError, setRetryError] = useState<string>();
  const [retrying, setRetrying] = useState<string>();
  const retryConfirming = useConfirmInWallet(retrying !== undefined);
  const postConfirming = useConfirmInWallet(post.busy);
  const review = (payment: WalletPaymentActivity) => {
    setRetryError(undefined);
    if (payment.kind === "mine") setRetrying(payment.contentHash);
    reviewPendingPayment(payment).catch((cause) => setRetryError(errorMessage(cause)))
      .finally(() => setRetrying((current) => current === payment.contentHash ? undefined : current));
  };
  const recovery = (payment: WalletPaymentActivity) => payment.status === "unknown"
    ? <>
      <button className="button" disabled={busy || !canReview} onClick={() => review(payment)}>{payment.kind === "mine" ? "Retry mining" : "Check status"}</button>
      {retryConfirming && retrying === payment.contentHash && <ConfirmInWallet />}
    </>
    : payment.status === "failed" ? <button className="button" disabled={busy || !canReview} onClick={() => review(payment)}>Retry</button>
      // Mining is only ever retried from its saved bytes, and those have expired.
      : payment.status === "expired" && payment.kind === "payment" ? <button className="button" disabled={busy || !canReview} onClick={() => resendPayment(payment)}>Resend</button>
        : null;
  // The oldest in-flight Ethereum submission holds every later one; its rows reach it directly.
  const [lockMessage, setLockMessage] = useState<string>();
  const [checkingLock, setCheckingLock] = useState(false);
  const lockHash = submissionLock?.transactionHash ?? undefined;
  const carriedByLock = (contentHash: string | undefined) => contentHash !== undefined && submissionLock?.kind === "batch"
    && submissionLock.selected.some((selected) => selected.toLowerCase() === contentHash.toLowerCase());
  const checkLock = () => {
    setCheckingLock(true);
    setLockMessage(undefined);
    refreshSubmissionLock()
      .then((result) => setLockMessage(result.waiting.length > 0 ? "Still pending on Ethereum." : "Cleared. You can submit again."))
      .catch((cause) => setLockMessage(errorMessage(cause)))
      .finally(() => setCheckingLock(false));
  };
  // A submission no row carries, such as a relay-only batch, gets a row of its own once its prompt has closed.
  const unshownLock = submissionLock !== undefined && !walletPromptOpen
    && !rows.some((row) => row.state.state === "pending" && carriedByLock(row.state.contentHash)) ? submissionLock : undefined;
  const lockControls = <>
    {lockHash !== undefined && l1Chain.blockExplorers !== undefined && <a href={`${l1Chain.blockExplorers.default.url}/tx/${lockHash}`} target="_blank" rel="noreferrer">View on Ethereum<ExternalLinkIcon /></a>}
    <button className="button" disabled={checkingLock} onClick={checkLock}>{checkingLock ? "Checking…" : "Check status"}</button>
  </>;

  return <section id={compact ? "wallet-activity" : "activity"} className={`${styles.activity} ${compact ? styles.compact : ""}`}
    data-history-current={historyCurrent ? "true" : "false"} data-history-head={history?.pcashHash} data-wallet-head={head}
    data-history-checking={native.checking ? "true" : "false"} data-history-state={native.failed ? history !== undefined ? "stale" : "unavailable" : historyReady ? "ready" : "checking"}>
    <NativeActivityNotice history={native} />
    {/* Posting takes its transactions out of the count; the block stays while it posts and shows its error. */}
    {(post.pendingCount > 0 || post.busy || post.error !== undefined) && <div className={styles.post}>
      {(post.pendingCount > 0 || post.busy) && <>
        <button type="button" className="button primary" disabled={post.busy} onClick={() => void post.post()}>{post.busy ? postingLabel(post.progress) : postPendingLabel(post)}</button>
        {postConfirming ? <ConfirmInWallet /> : <p>Posts them to Ethereum in a batch. Your Ethereum wallet pays the gas in ETH and earns the issuance.</p>}
      </>}
      {post.error !== undefined && <p role="alert">{post.error}</p>}
    </div>}
    {retryError !== undefined && <p role="alert">{retryError}</p>}
    {lockMessage !== undefined && <p role="status">{lockMessage}</p>}
    {!canReview && paymentActivity.some((payment) => payment.status === "unknown" || payment.status === "failed" || (payment.status === "expired" && payment.kind === "payment"))
      && <p className={styles.hint}>Resume wallet setup to retry, resend or check these transactions.</p>}
    {history === undefined && !native.failed && <p role="status">Loading activity…</p>}
    {rows.length === 0 && historyReady && unshownLock === undefined
      ? <div className={styles.empty}><strong>No activity yet</strong><span>Payments, mining, trades, and token actions will appear here.</span></div>
      : <div className={styles.rows}>{unshownLock !== undefined && <div className={styles.row} data-activity-kind="submission" data-activity-state="pending">
        <span className={styles.icon} aria-hidden="true"><ArrowUpRightIcon /></span>
        <Link className={styles.text} onClick={onNavigate} to="#ethereum-submission">
          <span>Ethereum submission</span>
          <small>{unshownLock.transactionHash === null ? "Your wallet did not return a transaction" : "Posted, waiting for inclusion"}</small>
        </Link>
        <span className={styles.chip}>Pending</span>
        <div className={styles.rowActions}>{lockControls}</div>
      </div>}{rows.map((row) => {
        const contentHash = row.state.state === "pending" ? row.state.contentHash : undefined;
        return <ActivityRowView key={row.id} row={row} highlighted={row.payment !== undefined && row.id === highlightContentHash} onNavigate={onNavigate}
          postable={contentHash !== undefined && pendingContentHashes.has(contentHash.toLowerCase())} awaitingPrompt={contentHash !== undefined && awaitingPrompt(contentHash)}>
          {carriedByLock(contentHash) ? lockControls : row.payment !== undefined && recovery(row.payment)}
        </ActivityRowView>;
      })}</div>}
  </section>;
}
