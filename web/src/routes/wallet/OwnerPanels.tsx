import { TransactionDetails } from "../../components/TransactionDetails.tsx";
import { ProofProgress } from "../../components/ProofProgress.tsx";
import { useWebsiteSettings } from "../../lib/WebsiteSettings.tsx";
import { EthereumGasCost } from "../../components/SubmissionChoice.tsx";
import { SubmissionModeControl } from "../../components/SubmissionModeControl.tsx";
import { usePaymentIssuance, type DisplayIssuanceInputs } from "../../lib/usePaymentIssuance.ts";
import { FastPaymentResult, usePaymentConfirmation, type PaymentConfirmation } from "./FastPaymentResult.tsx";
import { NAMES_OFF_MESSAGE } from "../../names/NameResolutionSession.ts";
import { FittedCode } from "../../components/EthereumAddress.tsx";
import { NO_RECEIVE_KEY_MESSAGE, useRecipientInput, useRecipientReceiveKey } from "./useRecipient.ts";
import { etherscanTransactionUrl } from "../explorer/format.ts";
import { transactionPath } from "../explorer/paths.ts";
import { useEthereumNetwork } from "../../lib/EthereumProvider.tsx";
import { NetworkContext } from "../../components/NetworkContext.tsx";
import { useFastSendEstimate } from "../../lib/useFastSendEstimate.ts";
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { Notice } from "../../components/Notice.tsx";
import { CopyButton } from "../../components/CopyButton.tsx";
import { ExternalLinkIcon } from "../../components/icons.tsx";
import { QrCode } from "../../components/QrCode.tsx";
import { QrScanner } from "../../components/QrScanner.tsx";
import { ConfirmInWallet, useConfirmInWallet } from "../../components/WalletSubmissionLock.tsx";
import { PcashAmount } from "../../components/PcashAmount.tsx";
import { formatPcashInput, parsePcashAmount, PCASH_UNIT } from "../../components/pcashAmount.ts";
import { floorToDisplay } from "../../components/tokenAmount.ts";
import { defaultOpenFee } from "@pcash/sdk/wallet/actions";
import { PRIVATE_VALUE_PROFILES } from "@pcash/sdk/constants";
import { paymentMaxMemoBytes } from "@pcash/sdk/protocol";
import { utf8 } from "@pcash/sdk/utils";
import { memoText } from "../../lib/memoText.ts";
import {
  errorMessage,
  useWallet,
  type WalletPaymentActivity,
  type WalletSendOutcome,
  type WalletSendPreflight,
} from "../../lib/WalletProvider.tsx";
import {
  sendIntent,
  shortValue,
  withoutRetrySelection,
  recipientFromScan,
  ZERO_PAYMENT_MESSAGE,
  type ResolvedRecipient,
  type SendIntent,
  type SendSpeed,
} from "./model.ts";
import styles from "./OwnerPanels.module.css";

/** A typed PCASH field: its amount, or why it cannot be sent, shown before the user presses Send. A blank field has neither. */
function pcashInput(value: string, label: string, allowZero: boolean): { amount?: bigint; problem?: string } {
  if (value.trim() === "") return {};
  try { return { amount: parsePcashAmount(value, { label, allowZero }) }; } catch (cause) { return { problem: cause instanceof Error ? cause.message : String(cause) }; }
}

interface ReviewedPayment {
  intent: SendIntent;
  preflight: WalletSendPreflight;
  displayRecipient?: string;
  displayName?: string;
}

/** A submitted payment: where it went and the transaction that identifies it there. */
export interface SentPayment {
  /** Unknown only for a broadcast whose send action failed before reporting it. */
  contentHash: string | undefined;
  publication: WalletSendOutcome["publication"];
  l1Hash?: string;
}

interface SendController {
  panelView: "closed" | "overview" | "send" | "ethereum-submission" | "receive";
  highlightContentHash: string | undefined;
  /** A payment finished while the panel was hidden and has not been looked at yet. */
  unseenOutcome: boolean;
  /** Reopens the view that holds unfinished or unseen work, otherwise the overview. */
  showPanel(): void;
  openOverview(): void;
  openSend(): void;
  /** Opens Send to a recipient, after any connect, sign-in or setup the wallet still needs. */
  openSendTo(recipient: string): void;
  /** The recipient of an openSendTo that waits for the wallet to be ready. */
  pendingRecipient: string | undefined;
  /** Shows the receive link of the given account, by default the connected one. */
  openReceive(address?: string): void;
  receiveAddress: string | undefined;
  closePanel(): void;
  to: string;
  amount: string;
  /** The relayer fee field: the user's entry, otherwise the prefilled default. */
  fee: string;
  /** The spendable balance less the fee, floored to its displayed precision. */
  maxAmount: bigint | undefined;
  memo: string;
  includeSender: boolean;
  estimatedIssuance: bigint | undefined;
  displayIssuanceInputs: DisplayIssuanceInputs | undefined;
  speed: SendSpeed;
  recipient: ResolvedRecipient | undefined;
  /** Whether the typed address has published a receive key; undefined for unresolved input. */
  recipientReceiveKey: "checking" | "present" | "missing" | "unknown" | undefined;
  resolvingRecipient: boolean;
  review: ReviewedPayment | undefined;
  /** When the reviewed payment's proof started, so progress survives hiding the panel. */
  provingStartedAt: number | undefined;
  sent: SentPayment | undefined;
  /** The Ethereum transaction of a payment this wallet posted, until the user leaves its result. */
  resultL1Hash: string | undefined;
  confirmation: PaymentConfirmation;
  message: string | undefined;
  paymentError: string | undefined;
  updateDraft(field: "to" | "amount" | "fee" | "memo", value: string): void;
  fillMax(): void;
  chooseSpeed(speed: SendSpeed): void;
  chooseIncludeSender(include: boolean): void;
  reviewTransfer(event: FormEvent): void;
  confirmTransfer(): void;
  retryPreparation(): void;
  cancelAndEdit(): void;
  checkPaymentStatus(): void;
  editReviewedPayment(): void;
  clearPaymentError(): void;
  sendAnother(): void;
  /** Leaves a payment's result; the payment itself is unaffected. */
  finishPayment(): void;
  /** Leaves a failed payment's result and keeps its values for another try. */
  clearFailedPayment(): void;
  /** Rejects with a mining retry's error, which the activity list that started it shows. */
  reviewPendingPayment(payment: WalletPaymentActivity): Promise<void>;
  /** Sends an expired payment again as a new payment to the same recipient, with the same amount, fee, message and sender choice. */
  resendPayment(payment: WalletPaymentActivity): void;
}

const SendControllerContext = createContext<SendController | null>(null);

export function invalidatePaymentReview(
  reviewRequest: { current: number },
  discardPaymentReview: () => void,
  cancelPrivateSend: () => void,
) {
  reviewRequest.current += 1;
  discardPaymentReview();
  cancelPrivateSend();
}

function panelViewForHash(hash: string, ready: boolean): SendController["panelView"] {
  if (hash === "#ethereum-submission") return "ethereum-submission";
  if (hash === "#send") return ready ? "send" : "overview";
  return hash === "#wallet" ? "overview" : "closed";
}

function useSendControllerState(): SendController {
  const { getDefaultSubmissionMode } = useWebsiteSettings();
  const {
    status,
    connectedAccount,
    phase,
    paymentStage,
    submissionLock,
    synchronize,
    preflightPrivateSend,
    wallet, selfPublication, runAction,
    resolvePendingPaymentFate,
    sendPrivate,
    cancelPrivateSend,
    resetPrivateSend,
    refreshSubmissionLock,
    funds,
  } = useWallet();
  const { pathname, search, hash } = useLocation();
  const navigate = useNavigate();
  const currentLocation = useRef({ pathname, search, hash });
  currentLocation.current = { pathname, search, hash };
  const reviewRequestRef = useRef(0);
  const [panelView, setPanelView] = useState<SendController["panelView"]>("closed");
  const [hiddenView, setHiddenView] = useState<SendController["panelView"]>("overview");
  const [unseenOutcome, setUnseenOutcome] = useState(false);
  const panelViewRef = useRef(panelView);
  panelViewRef.current = panelView;
  const [highlightContentHash, setHighlightContentHash] = useState<string>();
  useEffect(() => {
    if (highlightContentHash === undefined) return;
    const timer = setTimeout(() => setHighlightContentHash(undefined), 12_000);
    return () => clearTimeout(timer);
  }, [highlightContentHash]);
  const internalNavigation = useRef<string | undefined>(undefined);
  const clearPanelHash = () => {
    const current = currentLocation.current;
    if (!["#wallet", "#send", "#ethereum-submission"].includes(current.hash)) return;
    internalNavigation.current = current.pathname + current.search;
    navigate({ pathname: current.pathname, search: current.search, hash: "" }, { replace: true, preventScrollReset: true });
  };
  const dismissPaymentReview = () => invalidatePaymentReview(reviewRequestRef, () => {
    setReviewingName(false);
    setReview(undefined);
    setSent(undefined);
    setMessage(undefined);
    setPaymentError(undefined);
  }, cancelPrivateSend);
  // Hiding the panel or moving between its views never cancels a payment: the
  // proof keeps running and its result waits in this controller.
  const openOverview = () => { clearPanelHash(); setPanelView("overview"); };
  const [receiveAddress, setReceiveAddress] = useState<string>();
  const openReceive = (address?: string) => { clearPanelHash(); setReceiveAddress(address); setPanelView("receive"); };
  /** A profile's Send waiting for connect, sign-in or setup, and the page it was started on. */
  const [pendingSend, setPendingSend] = useState<{ recipient: string; pathname: string }>();
  const pendingRecipient = pendingSend?.recipient;
  // Leaving that page or closing the panel abandons it.
  useEffect(() => { setPendingSend((current) => current?.pathname === pathname ? current : undefined); }, [pathname]);
  const closePanel = () => {
    setPendingSend(undefined);
    clearPanelHash();
    if (panelView !== "closed") setHiddenView(panelView);
    setPanelView("closed");
  };
  const showPanel = () => {
    setUnseenOutcome(false);
    // A payment that failed while the panel was hidden reopens on its error, even when the failure discarded its review.
    setPanelView(hiddenView === "ethereum-submission" && submissionLock !== undefined ? "ethereum-submission"
      : phase === "ready" && (hiddenView === "send" && (review !== undefined || sent !== undefined || paymentStage.state === "l1-submitted")
        || review !== undefined && paymentStage.state === "failed" || paymentError !== undefined) ? "send"
      : "overview");
  };
  const initialRecipient = new URLSearchParams(search).get("to") ?? "";
  const [to, setTo] = useState(initialRecipient);
  const openSendTo = (recipient: string) => {
    if (phase !== "ready") { setPendingSend({ recipient, pathname: currentLocation.current.pathname }); setPanelView("overview"); return; }
    setPendingSend(undefined);
    openSend();
    // A payment already under review keeps its recipient.
    if (review === undefined) setTo(recipient);
  };
  useEffect(() => {
    if (phase === "ready" && pendingRecipient !== undefined) openSendTo(pendingRecipient);
  }, [phase, pendingRecipient]);
  useEffect(() => {
    const destination = pathname + search + hash;
    const internal = internalNavigation.current === destination;
    internalNavigation.current = undefined;
    if (internal) return;
    if (hash === "#send" && initialRecipient !== "") { openSendTo(initialRecipient); return; }
    const destinationView = panelViewForHash(hash, phase === "ready");
    if (destinationView === "send" && review === undefined) setSpeed(getDefaultSubmissionMode());
    setPanelView((view) => destinationView === "closed" ? view : destinationView);
  }, [pathname, search, hash]);
  useEffect(() => {
    if (["#wallet", "#send", "#ethereum-submission"].includes(hash)) setPanelView(panelViewForHash(hash, phase === "ready"));
    else if (phase !== "ready") setPanelView((view) => view === "send" ? "overview" : view);
  }, [phase]);
  const [amountDraft, setAmountDraft] = useState("");
  // Max tracks the balance and fee until the user types an amount.
  const [amountIsMax, setAmountIsMax] = useState(false);
  // Undefined until the user edits the fee: the field then shows the prefilled default.
  const [feeDraft, setFeeDraft] = useState<string>();
  const issuanceQuote = usePaymentIssuance(panelView === "send" && phase === "ready");
  const [speed, setSpeed] = useState<SendSpeed>(getDefaultSubmissionMode);
  const estimatedIssuance = issuanceQuote.issuance;
  // Blank until the first issuance read settles, so the prefilled fee does not change under the user.
  const fee = feeDraft ?? (issuanceQuote.inputs === undefined ? "" : formatPcashInput(defaultOpenFee(estimatedIssuance)));
  const feeAmount = speed === "fast" ? 0n : pcashInput(fee, "Relayer fee", true).amount;
  const maxAmount = funds === undefined || feeAmount === undefined ? undefined
    : funds.spendablePrivate > feeAmount ? floorToDisplay(funds.spendablePrivate - feeAmount, PCASH_UNIT) : 0n;
  const amount = amountIsMax ? maxAmount === undefined ? "" : formatPcashInput(maxAmount) : amountDraft;
  const setAmount = (value: string) => { setAmountIsMax(false); setAmountDraft(value); };
  const [memo, setMemo] = useState("");
  const [includeSender, setIncludeSender] = useState(true);
  /** Clears what the last payment carried; the recipient and fee stay. */
  const clearPaymentDraft = () => { setAmount(""); setMemo(""); setIncludeSender(true); };
  const [review, setReview] = useState<ReviewedPayment>();
  const [provingStartedAt, setProvingStartedAt] = useState<number>();
  const [sent, setSent] = useState<SentPayment>();
  const [message, setMessage] = useState<string>();
  const [paymentError, setPaymentError] = useState<string>();
  const ready = phase === "ready";
  useEffect(() => {
    dismissPaymentReview();
    setTo(initialRecipient); clearPaymentDraft(); setFeeDraft(undefined); setSpeed(getDefaultSubmissionMode()); setHighlightContentHash(undefined);
    const destination = panelViewForHash(hash, phase === "ready");
    setPanelView((view) => destination === "closed" && view !== "closed" ? "overview" : destination);
  }, [connectedAccount, status?.genesisHash]);
  const [reviewingName, setReviewingName] = useState(false);
  const { name, nameResolver, recipient, resolvingName } = useRecipientInput(to);
  const recipientReceiveKey = useRecipientReceiveKey(recipient?.kind === "address" ? recipient.address : undefined);
  const resolvingRecipient = reviewingName || resolvingName;

  useEffect(() => {
    if (ready) return;
    reviewRequestRef.current += 1;
    setReviewingName(false);
    setReview(undefined);
  }, [ready]);

  useEffect(() => () => cancelPrivateSend(), [cancelPrivateSend]);

  const updateDraft = (field: "to" | "amount" | "fee" | "memo", value: string) => {
    if (field === "to") setTo(value);
    else if (field === "amount") setAmount(value);
    else if (field === "memo") setMemo(value);
    else setFeeDraft(value);
    discardDraftReview();
  };
  const fillMax = () => {
    setAmountIsMax(true);
    discardDraftReview();
  };
  const chooseSpeed = (next: SendSpeed) => {
    setSpeed(next);
    discardDraftReview();
  };
  const chooseIncludeSender = (include: boolean) => {
    setIncludeSender(include);
    discardDraftReview();
  };
  const discardDraftReview = () => {
    reviewRequestRef.current += 1;
    setReviewingName(false);
    setReview(undefined);
    setMessage(undefined);
    setPaymentError(undefined);
  };

  const reviewTransfer = (event: FormEvent) => {
    event.preventDefault();
    if (resolvingRecipient) return;
    if (name !== undefined && nameResolver === undefined) { setPaymentError(NAMES_OFF_MESSAGE); return; }
    if (name === undefined && recipient?.kind === "invalid") {
      setPaymentError(recipient.message);
      return;
    }
    if (recipientReceiveKey === "missing") { setPaymentError(NO_RECEIVE_KEY_MESSAGE); return; }
    const request = ++reviewRequestRef.current;
    // The submitted amount stays on screen; Max stops following the balance.
    if (amountIsMax) setAmount(amount);
    setMessage(undefined);
    setPaymentError(undefined);
    setReviewingName(name !== undefined);
    void (async () => {
      // A display-cache entry must never choose the destination of a new payment.
      const fresh = name === undefined ? undefined : (await nameResolver?.resolveName(name) ?? null);
      if (reviewRequestRef.current !== request) return;
      if (fresh === null) throw new Error("This name does not resolve to an Ethereum address. Check the name and retry.");
      if (fresh !== undefined && wallet !== undefined && !await wallet.hasReceiveKey(fresh.address)) throw new Error(NO_RECEIVE_KEY_MESSAGE);
      if (reviewRequestRef.current !== request) return;
      const resolved = fresh === undefined ? recipient : { kind: "address" as const, address: fresh.address };
      // The fee on screen is the fee submitted.
      const intent = sendIntent({ to: fresh?.address ?? to, amount, fee, speed, memo, includeSender });
      const preflight = await preflightPrivateSend(intent);
      if (reviewRequestRef.current !== request) return;
      const prepared = {
        intent, preflight,
        ...(resolved === undefined || resolved.kind === "invalid" ? {} : { displayRecipient: resolved.address }),
        ...(name === undefined ? {} : { displayName: name }),
      };
      resetPrivateSend();
      setReview(prepared);
      if (!preflight.retry) preparePayment(prepared, request);
    })().catch((cause) => {
      if (reviewRequestRef.current === request) setPaymentError(errorMessage(cause));
    }).finally(() => {
      if (reviewRequestRef.current === request) setReviewingName(false);
    });
  };

  const preparePayment = (prepared: ReviewedPayment, request: number) => {
    const reviewed = prepared.intent;
    setProvingStartedAt(Date.now());
    setMessage(undefined);
    setPaymentError(undefined);
    void sendPrivate(reviewed, prepared.preflight).then((outcome) => {
      if (reviewRequestRef.current !== request) return;
      setMessage(undefined);
      setHighlightContentHash(outcome.contentHash);
      clearPanelHash();
      setPaymentError(undefined);
      setReview(undefined);
      setSent({ contentHash: outcome.contentHash, publication: outcome.publication, ...(outcome.l1Hash === undefined ? {} : { l1Hash: outcome.l1Hash }) });
      if (panelViewRef.current === "closed") setUnseenOutcome(true);
    }).catch((cause) => {
      if (reviewRequestRef.current !== request) return;
      if (cause instanceof Error && cause.name === "WalletPaymentCanceledError") {
        setReview(undefined);
        setPaymentError(undefined);
        return;
      }
      if (cause instanceof Error && cause.message.startsWith("Wallet state changed after review")) {
        reviewRequestRef.current += 1;
        setReview(undefined);
      }
      setPaymentError(errorMessage(cause));
      // The Send view shows the error when the hidden panel reopens.
      if (panelViewRef.current === "closed") setUnseenOutcome(true);
    });
  };

  const confirmTransfer = () => {
    if (review !== undefined && review.preflight.retry) preparePayment(review, reviewRequestRef.current);
  };

  const retryPreparation = () => {
    if (review === undefined) return;
    const current = review;
    const request = ++reviewRequestRef.current;
    setPaymentError(undefined);
    setMessage(undefined);
    void preflightPrivateSend({ ...current.intent, openFeeAmount: current.preflight.openFeeAmount }).then((preflight) => {
      if (reviewRequestRef.current !== request) return;
      const prepared = { ...current, preflight };
      resetPrivateSend();
      setReview(prepared);
      if (!preflight.retry) preparePayment(prepared, request);
    }).catch((cause) => {
      if (reviewRequestRef.current === request) setPaymentError(errorMessage(cause));
    });
  };

  const cancelAndEdit = () => {
    dismissPaymentReview();
  };

  const checkPaymentStatus = () => {
    if (review === undefined) return;
    const current = review;
    const request = ++reviewRequestRef.current;
    const exactContentHash = current.intent.retryContentHash ?? ("contentHash" in paymentStage ? paymentStage.contentHash : undefined);
    setPaymentError(undefined);
    void (async () => {
      await synchronize();
      if (reviewRequestRef.current !== request) return;
      let intent = exactContentHash === undefined ? current.intent : { ...current.intent, retryContentHash: exactContentHash };
      if (exactContentHash !== undefined) {
        const fate = await resolvePendingPaymentFate(exactContentHash);
        if (reviewRequestRef.current !== request) return;
        if (fate === "confirmed") {
          resetPrivateSend();
          setReview(undefined);
          clearPaymentDraft();
          setHighlightContentHash(exactContentHash);
          clearPanelHash();
          setPanelView((view) => view === "closed" ? view : "overview");
          return;
        }
        if (fate === "cleared") intent = withoutRetrySelection(current.intent);
      }
      const preflight = await preflightPrivateSend(intent);
      if (reviewRequestRef.current !== request) return;
      setReview(preflight.retry ? { ...current, intent, preflight } : undefined);
      resetPrivateSend();
      setMessage(preflight.retry ? "The payment is still pending." : "Review this payment to try again.");
    })().catch((cause) => {
      if (reviewRequestRef.current === request) setPaymentError(errorMessage(cause));
    });
  };

  const editReviewedPayment = () => {
    reviewRequestRef.current += 1;
    resetPrivateSend();
    setReview(undefined);
    setPaymentError(undefined);
  };

  const reviewPendingPayment = async (payment: WalletPaymentActivity) => {
    if (payment.kind === "mine") {
      if (wallet === undefined || selfPublication === undefined || phase !== "ready") return;
      await runAction(async () => {
        const intent = { retryContentHash: payment.contentHash, submission: selfPublication };
        const reviewed = await wallet.preflightMine(intent);
        await wallet.mine(intent, reviewed);
      });
      return;
    }
    // A retry must carry the saved memo and sender choice, or the wallet refuses it.
    const intent = { ...loadSavedPayment(payment), retryContentHash: payment.contentHash };
    const request = ++reviewRequestRef.current;
    setPaymentError(undefined);
    void preflightPrivateSend(intent).then((preflight) => {
      if (reviewRequestRef.current !== request) return;
      setReview(preflight.retry ? { intent, preflight, displayRecipient: payment.recipientAddress } : undefined);
      resetPrivateSend();
    }).catch((cause) => {
      if (reviewRequestRef.current === request) setPaymentError(errorMessage(cause));
    });
  };

  /** Shows a saved payment in the Send view and returns what it paid, in exact amounts the form's fields may not hold. */
  const loadSavedPayment = (payment: WalletPaymentActivity) => {
    setPanelView("send");
    setTo(payment.deliveryTarget);
    setAmount(formatPcashInput(payment.amount));
    setFeeDraft(formatPcashInput(payment.openFeeAmount));
    setMemo(payment.memo ?? "");
    setIncludeSender(payment.includeSender);
    return {
      to: payment.deliveryTarget,
      amount: payment.amount,
      openFeeAmount: payment.openFeeAmount,
      ...(payment.data === undefined ? {} : { data: payment.data }),
      ...(payment.memo === undefined ? {} : { memo: payment.memo }),
      ...(payment.includeSender ? { includeSender: true } : {}),
    };
  };

  const resendPayment = (payment: WalletPaymentActivity) => {
    // A payment already in the Send view is finished or canceled there first.
    if (review !== undefined || paymentStage.state === "l1-submitted") {
      setPanelView("send");
      setMessage("Finish or cancel this payment before resending another.");
      return;
    }
    // The expired bytes can never be included, so this is a new payment. History
    // does not record how the old one was posted; the default speed posts this one.
    const mode = getDefaultSubmissionMode();
    setSpeed(mode);
    const { openFeeAmount, ...paid } = loadSavedPayment(payment);
    // Self-publication pays Ethereum gas and no relayer fee.
    const intent: SendIntent = mode === "fast" ? { ...paid, publication: "self", newAction: true } : { ...paid, openFeeAmount, newAction: true };
    const request = ++reviewRequestRef.current;
    setReviewingName(false);
    setSent(undefined);
    setMessage(undefined);
    setPaymentError(undefined);
    void preflightPrivateSend(intent).then((preflight) => {
      if (reviewRequestRef.current !== request) return;
      const prepared = { intent, preflight, displayRecipient: payment.recipientAddress };
      resetPrivateSend();
      setReview(prepared);
      if (!preflight.retry) preparePayment(prepared, request);
    }).catch((cause) => {
      if (reviewRequestRef.current === request) setPaymentError(errorMessage(cause));
    });
  };

  const openSend = () => {
    if (phase !== "ready") return;
    if (review !== undefined || paymentError !== undefined) { setPanelView("send"); return; }
    setSpeed(getDefaultSubmissionMode());
    reviewRequestRef.current += 1;
    if (paymentStage.state !== "l1-submitted") resetPrivateSend();
    // The sent payment's amount stays in the form until its result is left.
    if (sent !== undefined) clearPaymentDraft();
    setReview(undefined);
    setSent(undefined);
    setPaymentError(undefined);
    setMessage(undefined);
    setPanelView("send");
  };

  const sendAnother = () => {
    setSpeed(getDefaultSubmissionMode());
    resetPrivateSend();
    setReview(undefined);
    clearPaymentDraft();
    setFeeDraft(undefined);
    setSent(undefined);
    setMessage(undefined);
    setPaymentError(undefined);
  };

  const finishPayment = () => {
    if (review !== undefined) return;
    resetPrivateSend();
    clearPaymentDraft();
    setSent(undefined);
    setMessage(undefined);
    setPaymentError(undefined);
  };

  const clearFailedPayment = () => {
    resetPrivateSend();
    setSent(undefined);
    setMessage(undefined);
    setPaymentError(undefined);
  };

  // A payment this wallet posted to Ethereum is tracked here, not in the Send
  // view, so the overview's progress row clears once it is decided.
  const resultL1Hash = sent !== undefined ? sent.l1Hash
    : paymentStage.state === "l1-submitted" ? paymentStage.l1Hash : undefined;
  const resultContentHash = sent?.contentHash ?? ("contentHash" in paymentStage ? paymentStage.contentHash : undefined);
  const confirmation = usePaymentConfirmation(resultL1Hash, resultContentHash);
  useEffect(() => {
    // The submission lock polls slowly; the receipt releases it now.
    if (resultL1Hash !== undefined && confirmation.l1State !== "pending") void refreshSubmissionLock().catch(() => undefined);
  }, [resultL1Hash, confirmation.l1State]);
  useEffect(() => {
    if (!confirmation.finished || paymentStage.state !== "l1-submitted") return;
    const { l1Hash, contentHash } = paymentStage;
    setSent((current) => current ?? { contentHash, publication: "self", l1Hash });
    resetPrivateSend();
  }, [confirmation.finished, paymentStage]);

  // Send errors and unsubmitted reviews belong to the Send view and end when the
  // user leaves it. A proof in progress and a submission already made keep
  // running; a failure that arrives while the user is elsewhere waits for them.
  const previousPanelView = useRef(panelView);
  useEffect(() => {
    const leftSend = previousPanelView.current === "send";
    previousPanelView.current = panelView;
    if (!leftSend || panelView === "send") return;
    setPaymentError(undefined);
    if (review !== undefined && (paymentStage.state === "failed" || (paymentStage.state === "idle" && review.preflight.retry))) {
      reviewRequestRef.current += 1;
      resetPrivateSend();
      setReview(undefined);
      setMessage(undefined);
    }
  }, [panelView]);

  return {
    panelView, highlightContentHash, unseenOutcome, showPanel, openOverview, openSend, openSendTo, pendingRecipient, openReceive, receiveAddress, closePanel,
    to,
    amount,
    fee,
    maxAmount,
    memo,
    includeSender,
    estimatedIssuance,
    displayIssuanceInputs: issuanceQuote.inputs,
    speed,
    recipient,
    recipientReceiveKey,
    resolvingRecipient,
    review,
    provingStartedAt,
    sent,
    resultL1Hash,
    confirmation,
    message,
    paymentError,
    updateDraft,
    fillMax,
    chooseSpeed,
    chooseIncludeSender,
    reviewTransfer,
    confirmTransfer,
    retryPreparation,
    cancelAndEdit,
    checkPaymentStatus,
    editReviewedPayment,
    clearPaymentError: () => setPaymentError(undefined),
    sendAnother,
    finishPayment,
    clearFailedPayment,
    reviewPendingPayment,
    resendPayment,
  };
}

/**
 * One draft payment is shared by sibling panels: a Retry, Check status or
 * Resend control in {@link Activity} loads a payment into the
 * {@link SendCard} review. Every owner panel must be rendered inside this provider.
 */
export function OwnerPanelsProvider({ children }: { children: ReactNode }) {
  const existing = useContext(SendControllerContext);
  return existing === null ? <RootOwnerPanelsProvider>{children}</RootOwnerPanelsProvider> : children;
}

function RootOwnerPanelsProvider({ children }: { children: ReactNode }) {
  const controller = useSendControllerState();
  return <SendControllerContext.Provider value={controller}>{children}</SendControllerContext.Provider>;
}

export function useWalletPanel(): SendController {
  return useContext(SendControllerContext)!;
}

export function AccountStatusNotices() {
  const { error, clearError } = useWallet();
  const { message } = useWalletPanel();
  const { hash } = useLocation();
  return <>
    {error && <div className={styles.noticeRow}><Notice tone="error">{error}</Notice><button type="button" className={styles.dismiss} onClick={clearError}>Dismiss</button></div>}
    {hash !== "#send" && message && <Notice tone="warning">{message}</Notice>}
  </>;
}

/** An account's page on this site, where anyone can pay it. */
export function profileUrl(address: string): string {
  return `${globalThis.location?.origin ?? ""}/${address}`;
}

export function ProfileLink({ address }: { address: string }) {
  const url = profileUrl(address);
  return <div className={styles.profileLink}><FittedCode text={url} /><CopyButton value={url} label="Copy profile link" /></div>;
}

/** Payers need only the address: the wallet looks up its published receive key. */
export function ReceiveCard({ address }: { address: string }) {
  return <article id="receive" className="panel">
    <p className="eyebrow">Receive</p>
    <h2>Receive PCASH</h2>
    <p>Share your profile link. Anyone can pay you from it.</p>
    <QrCode value={profileUrl(address)} label="QR code of your profile link" />
    <ProfileLink address={address} />
  </article>;
}

export function SendCard({ onClose }: { onClose?: () => void } = {}) {
  const { busy, progress, actionProgress, paymentStage, selfPublication, awaitingSignature, funds } = useWallet();
  // Display only: the payment never waits on this read.
  const { displayIssuanceInputs } = useWalletPanel();
  const {
    to,
    amount,
    fee,
    maxAmount,
    memo,
    includeSender,
    estimatedIssuance,
    speed,
    recipient,
    recipientReceiveKey,
    resolvingRecipient,
    review,
    provingStartedAt,
    sent,
    resultL1Hash: l1Hash,
    confirmation,
    paymentError,
    message,
    updateDraft,
    fillMax,
    chooseSpeed,
    chooseIncludeSender,
    reviewTransfer,
    confirmTransfer,
    retryPreparation,
    cancelAndEdit,
    checkPaymentStatus,
    editReviewedPayment,
    clearPaymentError,
    sendAnother,
    finishPayment,
    clearFailedPayment,
  } = useWalletPanel();
  // Under review, the reviewed transport: a payment loaded by Check status keeps its own.
  const fast = review === undefined ? speed === "fast" : review.preflight.publication === "self";
  const contentHash = sent?.contentHash ?? ("contentHash" in paymentStage ? paymentStage.contentHash : undefined);
  const amountInput = pcashInput(amount, "Amount", true);
  const feeInput: ReturnType<typeof pcashInput> = fast ? { amount: 0n } : pcashInput(fee, "Relayer fee", true);
  const feeAmount = feeInput.amount;
  const missingReceiveKey = recipient?.kind === "address" && recipientReceiveKey === "missing";
  // Counted as sent: the intent carries the trimmed memo.
  const memoBytes = utf8(memo.trim()).length;
  // The S arena bounds both profiles: an L payment's records fit it too.
  const memoLimit = paymentMaxMemoBytes({ shape: PRIVATE_VALUE_PROFILES.S.shapeId, includeSender });
  const memoTooLong = memoBytes > memoLimit;
  const sendBlocked = resolvingRecipient ? "Resolving the recipient…"
    : to.trim() === "" ? "Enter a recipient to continue."
    : missingReceiveKey ? NO_RECEIVE_KEY_MESSAGE
    : recipient?.kind === "address" && recipientReceiveKey === "checking" ? "Checking the recipient…"
    : amount.trim() === "" ? "Enter an amount to continue."
    : amountInput.problem !== undefined ? amountInput.problem
    : feeInput.problem !== undefined ? feeInput.problem
    : feeAmount === undefined ? "Enter a relayer fee to continue."
    : memoTooLong ? "Shorten the message to continue."
    : amountInput.amount === 0n && memoBytes > 0 ? ZERO_PAYMENT_MESSAGE
    : busy ? `Your wallet is busy${actionProgress === undefined ? "" : `: ${actionProgress.message}`}`
    : undefined;
  const reviewing = review !== undefined;
  const drafting = !reviewing && sent === undefined && l1Hash === undefined;
  // A broadcast payment's result replaces its review.
  const preparing = reviewing && l1Hash === undefined;
  // A failed payment unlocks its fields with their values intact.
  const failedProof = reviewing && paymentStage.state === "failed";
  const rejected = l1Hash !== undefined && confirmation.receipt !== null && confirmation.receipt.outcome !== "succeeded";
  const editable = drafting || failedProof || rejected;
  const fastEstimate = useFastSendEstimate(fast && (drafting || rejected), 1, displayIssuanceInputs ?? null);
  const confirming = useConfirmInWallet(paymentStage.state === "submitting" && review?.preflight.publication === "self");
  // Under review, the reviewed values: the fee on screen is the fee submitted.
  const recipientGets = review?.intent.amount ?? amountInput.amount;
  const relayerGets = review === undefined ? feeAmount : review.preflight.openFeeAmount + review.preflight.privateRelayFeeAmount;
  const [scanning, setScanning] = useState(false);
  const submitTransfer = (event: FormEvent) => {
    if (rejected) clearFailedPayment();
    reviewTransfer(event);
  };
  const done = onClose === undefined ? undefined : () => { finishPayment(); onClose(); };
  // A name resolves to an address the field does not show; under review, the freshly resolved one is paid.
  const payee = review?.displayName !== undefined ? review.displayRecipient : recipient?.kind === "address" ? recipient.address : undefined;
  const namedAddress = payee !== undefined && payee.toLowerCase() !== to.trim().toLowerCase() ? payee : undefined;
  return <article id="send" className={`panel ${styles.sendCard}`}>
    <h2 id="send-title">{l1Hash !== undefined ? "Payment submitted" : sent === undefined ? "Send PCASH" : "Payment sent"}</h2>
        <form onSubmit={submitTransfer} className={styles.sendForm}>
          {/* The form stays on screen with its values while the payment is prepared and after it is sent; its fields lock until a failure. */}
          <fieldset className={styles.sendFields} disabled={!editable}>
            <div className={styles.recipientField}>
              <label>Recipient<input className={recipient?.kind === "invalid" || missingReceiveKey ? `${styles.recipientInput} ${styles.fieldInvalid}` : styles.recipientInput} value={to} onChange={(event) => updateDraft("to", event.target.value)} placeholder="Address or ENS, .gwei or .wei name" autoComplete="off" required /></label>
              <button type="button" className={styles.scanButton} aria-label="Scan a QR code" aria-pressed={scanning} title="Scan a QR code" onClick={() => setScanning((value) => !value)}>
                <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M3 3h7v7H3zm2 2v3h3V5zm9-2h7v7h-7zm2 2v3h3V5zM3 14h7v7H3zm2 2v3h3v-3zm8-2h2v2h-2zm2 2h2v2h-2zm2-2h2v2h-2zm2 2h2v2h-2zm-6 2h2v2h-2zm4 0h2v2h-2zm2 2h2v2h-2zm-4 0h2v2h-2z" /></svg>
              </button>
            </div>
            {scanning && editable && <QrScanner onClose={() => setScanning(false)} onScan={(text) => { setScanning(false); updateDraft("to", recipientFromScan(text)); }} />}
            {resolvingRecipient && <p className={styles.fieldResolved} role="status">Resolving recipient…</p>}
            {recipient?.kind === "invalid" && <p className={styles.fieldError}>{recipient.message}</p>}
            {missingReceiveKey && <p className={styles.fieldError}>{NO_RECEIVE_KEY_MESSAGE}</p>}
            {namedAddress !== undefined && !resolvingRecipient && <p className={styles.fieldResolved}>Pays <FittedCode text={namedAddress} /></p>}
            <div className={styles.amountField}>
              <div className={styles.amountBox}>
                <label>Amount<input className={styles.amountInput} value={amount} onChange={(event) => updateDraft("amount", event.target.value)} inputMode="numeric" placeholder="0" required /></label>
                <span className={styles.unit} aria-hidden="true">PCASH</span>
              </div>
              {funds !== undefined && <p className={styles.available}><span>Available <PcashAmount value={funds.spendablePrivate} rounding="down" /></span>
                <button type="button" disabled={maxAmount === undefined || maxAmount === 0n} title={maxAmount === undefined ? "Enter a valid fee first" : maxAmount === 0n ? "Less than 1 PCASH is available to send" : "Send everything after the fee"} onClick={fillMax}>Max</button></p>}
            </div>
            <div className={styles.memoField}>
              <label>Message (optional)<textarea className={memoTooLong ? `${styles.memoInput} ${styles.fieldInvalid}` : styles.memoInput} value={memo} onChange={(event) => updateDraft("memo", event.target.value)} rows={2} aria-describedby="send-memo-hint" /></label>
              <p id="send-memo-hint" className={`${styles.formHint} ${styles.memoHint}`}><span>Encrypted: only you and the recipient can read it.</span><span>{memoBytes} / {memoLimit} bytes</span></p>
              {memoTooLong && <p className={styles.fieldError}>Shorten the message to {memoLimit} bytes or fewer.</p>}
              <label className={styles.senderChoice}><input type="checkbox" checked={includeSender} onChange={(event) => chooseIncludeSender(event.target.checked)} aria-describedby="send-sender-hint" />Include my address</label>
              <p id="send-sender-hint" className={styles.formHint}>Shows the recipient who paid. It is not proof of identity: any payer can name any address.</p>
            </div>
            <SubmissionModeControl label="Speed" value={fast ? "fast" : "slow"} onChange={chooseSpeed} fastDisabled={selfPublication === undefined} />
            {!fast && <div className={styles.feeField}>
              <label>Relayer fee (PCASH)<input className={styles.feeInput} value={fee} onChange={(event) => updateDraft("fee", event.target.value)} inputMode="numeric" placeholder="0" /></label>
              {estimatedIssuance !== undefined && <p>{estimatedIssuance > 0n ? <>Relayers already earn about <PcashAmount value={estimatedIssuance} /> per transaction</> : "Relayers earn no issuance right now, so this fee is all they get"}</p>}
            </div>}
          </fieldset>
          {recipientGets !== undefined && (fast || relayerGets !== undefined) && <p className={styles.summary} data-testid="payment-split">
            Recipient gets <span data-split="recipient"><PcashAmount value={recipientGets} /></span>{" · "}
            {fast ? <EthereumGasCost estimate={drafting || rejected ? fastEstimate : undefined} />
              : <>relayer gets <span data-split="relayer-fee"><PcashAmount value={relayerGets!} rounding="up" /></span> extra</>}
          </p>}
          {/* A zero payment has no recipient note to carry either. */}
          {review !== undefined && review.intent.amount > 0n && <dl className={styles.reviewLine} aria-label="For the recipient">
            {review.intent.memo !== undefined && <><dt>Message</dt><dd>{memoText(review.intent.memo)}</dd></>}
            <dt>Your address</dt><dd>{review.intent.includeSender === true ? "Included" : "Not included"}</dd>
          </dl>}
          {fast && (drafting || rejected) && fastEstimate?.state === "ready" && fastEstimate.collectibleOpenFee + fastEstimate.expectedIssuance > 0n
            && <p className={styles.formHint}>Posting it earns you about <PcashAmount value={fastEstimate.collectibleOpenFee + fastEstimate.expectedIssuance} />.</p>}
          {(drafting || rejected) && <>
            <div className={styles.sendActions}>{onClose !== undefined && <button className="button" type="button" onClick={onClose}>Cancel</button>}<button className="button primary" disabled={sendBlocked !== undefined} aria-describedby={sendBlocked === undefined ? undefined : "send-blocked"} type="submit">{busy ? "Checking balance…" : rejected ? "Try again" : "Send"}</button></div>
            {sendBlocked !== undefined && !resolvingRecipient && !missingReceiveKey && !memoTooLong && <p id="send-blocked" className={styles.formHint}>{sendBlocked}</p>}
          </>}
          {preparing && <>
            <div className={styles.sendActions}>
              {failedProof && <button className="button primary" type="button" disabled={busy} onClick={retryPreparation}>Try again</button>}
              {(paymentStage.state === "proving" || (paymentStage.state === "idle" && !review.preflight.retry)) && <>
                <button className="button" type="button" onClick={cancelAndEdit}>Cancel</button>
                <button className="button primary" type="button" disabled><span className="spinner" aria-hidden="true" />Proving…</button>
              </>}
              {paymentStage.state === "canceling" && <button className="button" type="button" disabled><span className="spinner" aria-hidden="true" />Canceling…</button>}
              {review.preflight.retry && paymentStage.state === "idle" && <>
                <button className="button" type="button" onClick={editReviewedPayment}>Edit payment</button>
                <button className="button primary" type="button" disabled={busy} onClick={confirmTransfer}>Send payment</button>
              </>}
              {paymentStage.state === "submitting" && <button className="button primary" type="button" disabled><span className="spinner" aria-hidden="true" />Sending…</button>}
              {paymentStage.state === "submission-unknown" && <button className="button primary" type="button" onClick={checkPaymentStatus}>Check status</button>}
            </div>
            {confirming && <ConfirmInWallet />}
            {review.preflight.retry && paymentStage.state === "idle" && <p role="status" className={styles.formHint}>Payment prepared. Ready to send.</p>}
            {paymentStage.state === "submission-unknown" && <Notice tone="warning">We couldn't confirm whether the network received this payment. Check its status before trying again.</Notice>}
            {paymentStage.state !== "submitting" && (busy || paymentStage.state === "proving") && <ProofProgress
              proof={progress} awaitingSignature={awaitingSignature} startedAt={provingStartedAt}
              {...(!progress && actionProgress ? { label: actionProgress.phase, detail: actionProgress.message } : {})} />}
            <TransactionDetails proof={progress} message={actionProgress?.message} contentHash={contentHash} />
          </>}
          {message && <Notice tone="warning">{message}</Notice>}
          {paymentError && l1Hash === undefined && <div className={styles.noticeRow}><Notice tone="error">{paymentError}</Notice><button type="button" className={styles.dismiss} onClick={clearPaymentError}>Dismiss</button></div>}
        </form>
    {l1Hash !== undefined ? <FastPaymentResult key={l1Hash} hash={l1Hash} confirmation={confirmation} onDone={done} onSendAnother={sendAnother} />
      : sent !== undefined && <SentPaymentResult sent={sent} onDone={done} onSendAnother={sendAnother} />}
  </article>;
}

/** Where a submitted payment went, linked to the explorer that shows it. */
function SentPaymentResult({ sent, onDone, onSendAnother }: { sent: SentPayment; onDone: (() => void) | undefined; onSendAnother: () => void }) {
  const { l1ChainId } = useEthereumNetwork();
  const l1 = sent.publication === "self";
  const hash = l1 ? sent.l1Hash : sent.contentHash;
  const href = hash === undefined ? undefined : l1 ? etherscanTransactionUrl(l1ChainId, hash) : transactionPath(hash);
  return <div className={styles.review}>
    <p role="status">{l1 ? "Your Ethereum wallet posted the payment to Ethereum." : "The payment is in the PCASH mempool, waiting for a relayer to post it to Ethereum."}</p>
    <dl>
      <dt>Sent to</dt><dd>{l1 ? "Ethereum (L1)" : "PCASH mempool (L2)"}</dd>
      <dt>{l1 ? "Ethereum transaction" : "PCASH transaction"}</dt>
      <dd>{hash === undefined ? "—"
        : href === undefined ? <code>{shortValue(hash, 10, 8)}</code>
          : l1 ? <a href={href} target="_blank" rel="noreferrer"><code>{shortValue(hash, 10, 8)}</code><ExternalLinkIcon /></a>
            : <Link to={href}><code>{shortValue(hash, 10, 8)}</code></Link>}
        {hash !== undefined && <> <CopyButton value={hash} label={l1 ? "Copy Ethereum transaction hash" : "Copy PCASH content hash"} className={styles.copyHash} /></>}</dd>
    </dl>
    <div className="actions">
      <button className="button" onClick={onSendAnother}>Send another</button>
      {onDone !== undefined && <button className="button primary" onClick={onDone}>Done</button>}
    </div>
  </div>;
}
