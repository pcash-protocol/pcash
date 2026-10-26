import { memoSchema, claimedSenderSchema, type TransactionData } from "@pcash/sdk/delivery";
import { networkWalletClient } from "./networkWalletClient.ts";
import { friendlyError } from "../components/friendlyError.ts";
import { localPaymentHistoryKey, rememberLocalPayments } from "./localPaymentHistory.ts";
import { publishReleasedRelayAttempts, relayDeploymentKey, relayHistoryKey } from "../shared/relayHistory.ts";
import { onboardingDestination, onWalletSurface } from "./walletSurface.ts";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { PcashNodeClient, assertExpectedNetwork, pollReceipt, type StatusResult } from "@pcash/sdk/clients";
import { serializeEcdsaSignature, verifyPcashAuthorization, type PcashActionSigner } from "@pcash/sdk/eip712";
import { networkConfigFromStatus } from "@pcash/sdk/protocol";
import { toHex } from "@pcash/sdk/utils";
import type { ProveStatus } from "@pcash/sdk/browser-prover/requests";
import {
  DurablePreBroadcastError,
  WalletReviewStaleError,
  type L1SubmissionAdapter,
  type PublicationMode,
  type PendingUserAccountCreation,
  type PcashProfile,
  type Wallet,
  type WalletNativeFunds,
  type WalletSnapshot,
  type WalletTransferPreflight,
} from "@pcash/sdk/wallet";
import { useLocation, useNavigate } from "react-router-dom";
import type { Address, WalletClient } from "viem";
import { useAccount, useBalance, type Connector } from "wagmi";
import { connect as connectWagmi, disconnect as disconnectWagmi, getPublicClient, getWalletClient, switchChain } from "wagmi/actions";
import { useEthereumNetwork } from "./EthereumProvider.tsx";
import { useNetwork } from "../components/NetworkContext.tsx";
import { formatPcashAmount } from "../components/pcashAmount.ts";
import { createProfileSessionStore, profileSessionIdentity, profileSessionKey, type ProfileSessionIdentity } from "./ProfileSessionStore.ts";
import { networkInstanceKey } from "./networks.ts";
import { networkChangedMessage } from "../routes/explorer/config.ts";
import type { PaymentActivityStatus } from "../routes/wallet/model.ts";
import { paymentMemo, pendingPaymentActivity, observedPaymentActivity } from "./paymentActivity.ts";
import { withSignatureProgress } from "./signatureProgress.ts";
import { browserPublication } from "./browserPublication.ts";
import { batchEntryCarrying, type RelayCarrierQuote, type RelayJournalEntry, type RelayJournalRecovery } from "@pcash/sdk/relay";
import { reconcileSubmissionLock, refreshSubmissionLock, viemSubmissionLockL1, type SubmissionLockRefresh } from "./submissionLock.ts";
import type { AccountActivationTransaction } from "@pcash/sdk/wallet/web";
import { prepareFastBatch } from "./prepareFastBatch.ts";
import { logProverProgress, traceWalletOperation } from "./proverDiagnostics.ts";
import { recordProofTiming } from "../components/proofStages.ts";

export type WalletPhase =
  /** Nothing is known yet: node status, wallet reconnection, and the saved
   *  sign-in are all still resolving. Rendering any other phase here would be
   *  a confident wrong answer, so the route shows a skeleton instead. */
  | "initializing"
  | "disconnected"
  | "wrong-network"
  | "connecting"
  | "sign-in-required"
  | "signing-in"
  | "opening"
  | "activation-required"
  | "activating"
  | "activation-prepared"
  | "activation-ambiguous"
  | "activation-blocked"
  | "activation-mining"
  | "activation-pending"
  | "syncing"
  | "ready"
  | "error";

/**
 * Whether the connected address already has a PCASH account on this network.
 * The PCASH address is the Ethereum address, so this is answerable from the
 * node before any signature — which is what separates "sign in" from the
 * gas-costing account setup.
 */
export type WalletAccountRecord = "unknown" | "present" | "absent";

export interface WalletSyncState {
  state: "idle" | "syncing" | "error";
  syncedThrough?: { pcashNumber: bigint; pcashHash: string };
  error?: string;
}

export interface WalletActionProgress {
  phase: string;
  message: string;
}

/** The reviewed payment: explicit fee, who it and any issuance pay, and the funding the send must still match. */
export type WalletSendPreflight = WalletTransferPreflight;

export interface WalletSendIntent {
  to: string;
  amount: bigint;
  openFeeAmount?: bigint;
  /** "self" posts from the connected Ethereum wallet; otherwise the node mempool relays it. */
  publication?: PublicationMode;
  /** Text for the recipient, carried in its note. */
  memo?: string;
  data?: TransactionData;
  /** The recipient's note names this wallet as the sender. */
  includeSender?: boolean;
  /** Build a new payment even when a pending one pays the same recipient and amount. */
  newAction?: boolean;
  retryContentHash?: string;
}

export interface WalletSendOutcome {
  contentHash: string;
  /** "self" was posted to Ethereum from the connected wallet; "relay" went to the node mempool. */
  publication: PublicationMode;
  /** The Ethereum transaction that carried a self-published payment. */
  l1Hash?: string;
  accepted: boolean;
  queued: boolean;
  settled: boolean;
  retried: boolean;
  recovered: boolean;
}

export type WalletPaymentActivity = Omit<WalletSnapshot["pendingPayments"][number], "state"> & {
  memo?: string;
  includeSender: boolean;
  status: PaymentActivityStatus | "finalized" | "failed" | "expired" | "conflicted";
  receiptTxId?: string;
  resolvedAtUnixMs?: bigint;
};

/** What became of one exact payment after synchronization retired its journal entry. */
export type WalletPaymentFate = "pending" | "confirmed" | "cleared";

export type WalletPaymentStage =
  | { state: "idle" }
  | { state: "proving"; attemptId: number }
  | { state: "canceling"; attemptId: number }
  | { state: "submitting"; attemptId: number; contentHash?: string }
  | { state: "l1-submitted"; attemptId: number; contentHash?: string; l1Hash: string }
  | { state: "submission-unknown"; attemptId: number; contentHash?: string }
  | { state: "failed"; attemptId: number };

export class FasterGasError extends Error {
  constructor() {
    super("Not enough ETH for gas.");
    this.name = "FasterGasError";
  }
}

/** The batch a Faster action posts: one private-value action, with a signed creation attached for setup. */
export type FasterBatch = "action" | "setup";

/** Full-size stand-ins for a batch's transactions before they exist: all-nonzero bytes bound the calldata cost. */
export async function fasterStandIns(batch: FasterBatch): Promise<Uint8Array[]> {
  const [{ PADDED_PRIVATE_VALUE_BYTE_SIZE }, { USER_ACCOUNT_CREATION_MAX_TX_BYTES }] = await Promise.all([
    import("@pcash/sdk/wallet/actions"), import("@pcash/sdk/protocol"),
  ]);
  const action = new Uint8Array(Number(PADDED_PRIVATE_VALUE_BYTE_SIZE)).fill(255);
  return batch === "setup" ? [new Uint8Array(action.length + USER_ACCOUNT_CREATION_MAX_TX_BYTES - 5).fill(255)] : [action];
}

export class WalletPaymentCanceledError extends Error {
  constructor() {
    super("Payment canceled before submission.");
    this.name = "WalletPaymentCanceledError";
  }
}

interface BrowserProverController {
  cancelCurrent(): void;
  destroy(): void;
}

interface ActiveSendAttempt {
  readonly id: number;
  walletActionId?: string;
  contentHash?: string;
  canceled: boolean;
  /** Set once the proved bytes pass the journal gate; the payment can no longer be canceled. */
  submitting: boolean;
  journaled: boolean;
  readonly lockController: AbortController;
}

interface WalletContextValue {
  node: PcashNodeClient;
  status?: StatusResult;
  /** The status the signed-in wallet's tip follower last read, and when. */
  followedStatus?: { status: StatusResult; observedAt: number };
  /** Fresh, chain-checked status for callers that must not pair against a cached one. */
  readStatus(): Promise<StatusResult>;
  profile?: PcashProfile;
  walletClient?: WalletClient;
  wallet?: Wallet;
  /** Posts an action to Ethereum from the connected wallet. Only an explicit choice passes it. */
  selfPublication?: L1SubmissionAdapter;
  snapshot?: WalletSnapshot;
  paymentActivity: WalletPaymentActivity[];
  /** Fresh actions whose journaled bytes wait on the Ethereum wallet's prompt: contentHash to wallet action id. */
  awaitingConfirmation: ReadonlyMap<string, string>;
  funds?: WalletNativeFunds;
  connectedAccount?: string;
  /** The connected Ethereum wallet's ETH balance on this network's L1, for gas checks. */
  l1Balance?: bigint;
  accountRecord: WalletAccountRecord;
  phase: WalletPhase;
  connectionStep?: string;
  syncState: WalletSyncState;
  activationContentHash?: string;
  activation?: PendingUserAccountCreation;
  activationBlocker?: RelayJournalEntry;
  activationTransaction?: AccountActivationTransaction;
  /**
   * The oldest in-flight Ethereum submission from this address; the next one
   * waits until it settles. It is journaled just before the wallet prompt, so
   * while it has no transaction hash the prompt is open or its outcome unknown.
   */
  submissionLock?: RelayJournalEntry;
  /** Settle the in-flight submissions, releasing those whose transactions can no longer land. */
  refreshSubmissionLock(): Promise<SubmissionLockRefresh>;
  /** An Ethereum wallet prompt for a submission from this site is open. */
  walletPromptOpen: boolean;
  /**
   * Stops a Faster action before any proof when a quote shows the connected
   * wallet cannot pay the gas to post it, or when an earlier submission is
   * still in flight. Without a quote, the submission itself decides.
   */
  assertFasterGas(batch?: FasterBatch): Promise<void>;
  progress?: ProveStatus;
  actionProgress?: WalletActionProgress;
  awaitingSignature: boolean;
  paymentStage: WalletPaymentStage;
  busy: boolean;
  error?: string;
  connect(connector?: Connector, options?: { allowNetworkSwitch?: boolean }): Promise<void>;
  switchNetwork(): Promise<void>;
  signIn(): Promise<"ready" | "activation-required" | undefined>;
  beginOnboarding(): void;
  cancelOnboarding(): void;
  setupAccount(): Promise<void>;
  setupAccountWithoutEth(): Promise<void>;
  retryAccountSetup(contentHash: string, publication?: "self" | "open"): Promise<void>;
  setupStep?: "ethereum" | "waiting";
  disconnect(): Promise<void>;
  checkAccountActivation(): Promise<void>;
  synchronize(): Promise<void>;
  refresh(): Promise<void>;
  preflightPrivateSend(intent: WalletSendIntent): Promise<WalletSendPreflight>;
  resolvePendingPaymentFate(contentHash: string): Promise<WalletPaymentFate>;
  sendPrivate(
    intent: WalletSendIntent,
    reviewed: WalletSendPreflight,
  ): Promise<WalletSendOutcome>;
  cancelPrivateSend(): void;
  resetPrivateSend(): void;
  runAction<T>(action: () => Promise<T>): Promise<T>;
  clearError(): void;
}

/** PCASH blocks follow Ethereum's 12-second slots; three polls per block find each new tip promptly. */
const TIP_POLL_INTERVAL_MS = 4_000;

const WalletContext = createContext<WalletContextValue | null>(null);

export const errorMessage = friendlyError;

function paymentCanceled(cause: unknown): boolean {
  return cause instanceof WalletPaymentCanceledError
    || (cause instanceof Error && cause.name === "AbortError");
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const { network } = useNetwork();
  const { ethereumConfig, l1Chain, l1ChainId } = useEthereumNetwork();
  const [{ subscribeToSignOut, clearProfileSessionIfRevision, loadProfileSession, profileSessionRevision, saveProfileSession }] = useState(() => createProfileSessionStore(networkInstanceKey(network)));
  const node = useMemo(() => new PcashNodeClient(network.pcashRpcUrl), [network.pcashRpcUrl]);
  const activeProfileIdentityRef = useRef<ProfileSessionIdentity | undefined>(undefined);
  const [status, setStatus] = useState<StatusResult>();
  const [followedStatus, setFollowedStatus] = useState<{ status: StatusResult; observedAt: number }>();
  const [profile, setProfile] = useState<PcashProfile>();
  const [signer, setSigner] = useState<PcashActionSigner>();
  const [walletClient, setWalletClient] = useState<WalletClient>();
  const [wallet, setWallet] = useState<Wallet>();
  const [selfPublication, setSelfPublication] = useState<L1SubmissionAdapter>();
  const [snapshot, setSnapshot] = useState<WalletSnapshot>();
  const [paymentActivity, setPaymentActivity] = useState<WalletPaymentActivity[]>([]);
  const [awaitingConfirmation, setAwaitingConfirmation] = useState<ReadonlyMap<string, string>>(new Map());
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const [funds, setFunds] = useState<WalletNativeFunds>();
  const [connectedAccount, setConnectedAccount] = useState<string>();
  const [accountRecord, setAccountRecord] = useState<WalletAccountRecord>("unknown");
  const [phase, setPhase] = useState<WalletPhase>("initializing");
  const [statusSettled, setStatusSettled] = useState(false);
  const [connectionStep, setConnectionStep] = useState<string>();
  const [syncState, setSyncState] = useState<WalletSyncState>({ state: "idle" });
  const [activationContentHash, setActivationContentHash] = useState<string>();
  const [activation, setActivation] = useState<PendingUserAccountCreation>();
  const [activationBlocker, setActivationBlocker] = useState<RelayJournalEntry>();
  const [activationTransaction, setActivationTransaction] = useState<AccountActivationTransaction>();
  const activationRecoveryRef = useRef<RelayJournalRecovery | undefined>(undefined);
  const [submissionLock, setSubmissionLock] = useState<RelayJournalEntry>();
  const [walletPromptOpen, setWalletPromptOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [progress, setProgress] = useState<ProveStatus>();
  const [actionProgress, setActionProgress] = useState<WalletActionProgress>();
  const [awaitingSignature, setAwaitingSignature] = useState(false);
  const [paymentStage, setPaymentStage] = useState<WalletPaymentStage>({ state: "idle" });
  const walletRef = useRef<Wallet | undefined>(undefined);
  /** The wallet whose tip follower should run while the tab is visible. */
  const followingRef = useRef<Wallet | undefined>(undefined);
  const followStopRef = useRef<Promise<void> | undefined>(undefined);
  const selfPublicationRef = useRef<L1SubmissionAdapter | undefined>(undefined);
  selfPublicationRef.current = selfPublication;
  const fastBatchContextRef = useRef<{ pendingContentHashes: readonly string[] }>({ pendingContentHashes: [] });
  fastBatchContextRef.current = { pendingContentHashes: snapshot?.pendingContentHashes ?? [] };
  // Review and send must name the same transport: the wallet rejects a send whose publication changed.
  const walletSendIntent = useCallback(({ publication, memo, includeSender, data, ...payment }: WalletSendIntent, onL1Hash?: (hash: string) => void) => {
    const records = [...memo === undefined || memo === "" ? [] : [memoSchema.encode(memo)],
      ...includeSender === true ? [claimedSenderSchema.encode(BigInt(walletRef.current!.address))] : []];
    const intent = { ...payment, ...(data !== undefined ? { data } : records.length === 0 ? {} : { data: { recipients: [{ to: payment.to, records }] } }) };
    if (publication !== "self") return intent;
    const adapter = selfPublicationRef.current;
    if (adapter === undefined) throw new Error("Connect an Ethereum wallet to use Faster.");
    if (onL1Hash === undefined) return { ...intent, submission: adapter };
    const submission: L1SubmissionAdapter = {
      ...adapter,
      // Carry this wallet's pending transactions, and whatever else pays best, in the same batch.
      // Planning is an optimization: without it the payment still posts alone.
      preflight: async (context) => {
        const { pendingContentHashes } = fastBatchContextRef.current;
        const profile = profileRef.current;
        if (profile === undefined) {
          return adapter.preflight({ ...context, companions: { transactions: [], collectibleOpenFee: 0n, collectibleOpenFees: [] } });
        }
        return prepareFastBatch(adapter, context, { node, profile, ownPendingContentHashes: pendingContentHashes });
      },
      submit: async (params) => {
        const result = await adapter.submit({
          ...params,
          onL1Submitted: async (hash) => {
            onL1Hash(hash);
            await params.onL1Submitted?.(hash);
          },
        });
        if (result.l1Hash !== undefined) onL1Hash(result.l1Hash);
        return result;
      },
    };
    return { ...intent, submission };
  }, [node]);
  const profileRef = useRef<PcashProfile | undefined>(undefined);
  const onboardingIntentRef = useRef<string | undefined>(undefined);
  const setupRunningRef = useRef<{ session: number } | undefined>(undefined);
  const activationCheckRef = useRef<{ session: number; promise: Promise<void> } | undefined>(undefined);
  const [setupStep, setSetupStep] = useState<"ethereum" | "waiting">();
  const browserProversRef = useRef<BrowserProverController | undefined>(undefined);
  const activeSendRef = useRef<ActiveSendAttempt | undefined>(undefined);
  const sendAttemptSequenceRef = useRef(0);
  const walletStateReadSequenceRef = useRef(0);
  const activeProfileRevisionRef = useRef<number | undefined>(undefined);
  const unsubscribeRef = useRef<Array<() => Promise<void>>>([]);
  const sessionRef = useRef(0);
  const autoConnectKeyRef = useRef<string | undefined>(undefined);
  const wagmiStatusRef = useRef<string | undefined>(undefined);
  const observedChainIdRef = useRef<number | undefined>(undefined);
  const signedOutRef = useRef(false);
  const location = useLocation();
  const { pathname, hash } = location;
  const locationRef = useRef(location);
  locationRef.current = location;
  const navigate = useNavigate();
  const beginOnboarding = useCallback(() => { onboardingIntentRef.current = onboardingDestination(locationRef.current); }, []);
  const cancelOnboarding = useCallback(() => { onboardingIntentRef.current = undefined; }, []);
  const ethereumConnection = useAccount();
  const l1Balance = useBalance({
    ...(connectedAccount === undefined ? {} : { address: connectedAccount as `0x${string}` }),
    chainId: l1ChainId,
    query: { enabled: connectedAccount !== undefined, refetchInterval: 12_000 },
  }).data?.value;

  const clearError = useCallback(() => setError(undefined), []);

  const readWalletState = useCallback(async (
    opened: Wallet,
    session = sessionRef.current,
    knownSnapshot?: WalletSnapshot,
    /** Ask the node about each pending payment; a completed sync has new answers. */
    observePayments = true,
  ) => {
    const readSequence = ++walletStateReadSequenceRef.current;
    const nextSnapshot = knownSnapshot ?? await opened.snapshot();
    if (
      sessionRef.current !== session
      || walletRef.current !== opened
      || walletStateReadSequenceRef.current !== readSequence
    ) return false;
    rememberLocalPayments(localPaymentHistoryKey({ pcashChainId: nextSnapshot.network.chainId, l1ChainId, genesisHash: nextSnapshot.network.genesisHash }, nextSnapshot.address), nextSnapshot.pendingContentHashes, nextSnapshot.paymentHistory.map((payment) => payment.contentHash));
    setSnapshot(nextSnapshot);
    const completed: WalletPaymentActivity[] = [...nextSnapshot.paymentHistory]
      .sort((a, b) => a.resolvedAtUnixMs > b.resolvedAtUnixMs ? -1 : 1)
      .map((payment) => ({
        ...payment,
        ...paymentMemo(payment),
        status: payment.state === "succeeded" ? "finalized" : payment.state,
        ...(payment.receipt === undefined ? {} : { receiptTxId: payment.receipt.transactionId }),
      }));
    setPaymentActivity((previous) => [
      ...pendingPaymentActivity(nextSnapshot.pendingPayments, previous), ...completed,
    ]);
    // One read of this browser's Ethereum submission journal serves every pending payment.
    const journal = observePayments && nextSnapshot.pendingPayments.length > 0
      ? activationRecoveryRef.current?.show() ?? Promise.resolve(undefined) : undefined;
    if (observePayments) void Promise.all(nextSnapshot.pendingPayments.map(async (payment) => {
      const [receiptResult, mempoolResult, journalResult] = await Promise.allSettled([
        node.getReceipt({ contentHash: payment.contentHash }),
        node.getMempoolTransaction(payment.contentHash),
        journal,
      ]);
      const receipts = receiptResult.status === "fulfilled" ? receiptResult.value : [];
      const acceptedReceipt = receipts.find((receipt) => receipt.outcome === "succeeded");
      const rejectedReceipt = receipts.find((receipt) => receipt.outcome !== "succeeded");
      return {
        contentHash: payment.contentHash,
        receipt: receiptResult.status === "fulfilled" ? acceptedReceipt?.transactionId ?? null : undefined,
        ...(rejectedReceipt === undefined ? {} : { rejectedReceipt: rejectedReceipt.transactionId }),
        mempool: mempoolResult.status === "fulfilled" ? mempoolResult.value !== null : undefined,
        journal: journalResult.status === "fulfilled" ? batchEntryCarrying(journalResult.value?.entries ?? [], payment.contentHash) !== undefined : undefined,
      };
    })).then((nextPaymentActivity) => {
      if (
        sessionRef.current === session
        && walletRef.current === opened
        && walletStateReadSequenceRef.current === readSequence
      ) setPaymentActivity((previous) => [
        ...pendingPaymentActivity(nextSnapshot.pendingPayments, previous).map((payment, index) =>
          observedPaymentActivity(payment, nextPaymentActivity[index]!),
        ),
        ...completed,
      ]);
    }).catch(() => undefined);
    const nextFunds = nextSnapshot.syncedThrough === null ? undefined : await opened.nativeFunds();
    if (
      sessionRef.current !== session
      || walletRef.current !== opened
      || walletStateReadSequenceRef.current !== readSequence
    ) return false;
    if (nextFunds?.synchronized) {
      setFunds(nextFunds);
    }
    return true;
  }, [node]);

  const readStatus = useCallback(async (): Promise<StatusResult> => {
    const current = await node.status();
    assertExpectedNetwork(current, String(network.pcashChainId));
    if (current.l1ChainId !== BigInt(network.l1ChainId) || (network.genesisHash !== undefined && current.genesisHash.toLowerCase() !== network.genesisHash.toLowerCase())) {
      throw new Error(networkChangedMessage());
    }
    return current;
  }, [node]);

  // The comparison the Ethereum submission makes after proving, made first for the batch's required transactions.
  const assertFasterGas = useCallback(async (batch: FasterBatch = "action") => {
    const adapter = selfPublicationRef.current;
    if (adapter === undefined) throw new Error("Connect an Ethereum wallet to use Faster.");
    let quote: RelayCarrierQuote;
    try {
      quote = await adapter.quoteBatch({ status: await readStatus(), transactions: await fasterStandIns(batch) });
    } catch (cause) {
      if (cause instanceof Error && cause.name === "RelayJournalConflictError") throw cause;
      return;
    }
    if (quote.balanceWei < quote.maximumCostWei) throw new FasterGasError();
  }, [readStatus]);

  useEffect(() => {
    void readStatus()
      .then(setStatus)
      .catch((cause) => setError(errorMessage(cause)))
      // Settled either way: the initializing phase must not outlive this probe.
      .finally(() => setStatusSettled(true));
  }, [readStatus]);

  const disposeSession = useCallback(async (): Promise<number> => {
    walletStateReadSequenceRef.current += 1;
    const activeSend = activeSendRef.current;
    if (activeSend !== undefined && !activeSend.submitting && !activeSend.journaled) {
      activeSend.canceled = true;
      activeSend.lockController.abort();
    }
    activeSendRef.current = undefined;
    browserProversRef.current?.destroy();
    browserProversRef.current = undefined;
    const session = ++sessionRef.current;
    const unsubscribes = unsubscribeRef.current;
    const opened = walletRef.current;
    unsubscribeRef.current = [];
    walletRef.current = undefined;
    followingRef.current = undefined;
    profileRef.current = undefined;
    activationRecoveryRef.current = undefined;
    setActivationBlocker(undefined);
    setSubmissionLock(undefined);
    setWalletPromptOpen(false);
    setupRunningRef.current = undefined;
    activationCheckRef.current = undefined;
    setSetupStep(undefined);
    activeProfileRevisionRef.current = undefined;
    activeProfileIdentityRef.current = undefined;
    setProfile(undefined);
    setSigner(undefined);
    setWalletClient(undefined);
    setWallet(undefined);
    setSelfPublication(undefined);
    setSnapshot(undefined);
    setPaymentActivity([]);
    setAwaitingConfirmation(new Map());
    setFunds(undefined);
    setConnectedAccount(undefined);
    setAccountRecord("unknown");
    setConnectionStep(undefined);
    setSyncState({ state: "idle" });
    setFollowedStatus(undefined);
    setActivationContentHash(undefined);
    setActivation(undefined);
    setActivationTransaction(undefined);
    setProgress(undefined);
    setActionProgress(undefined);
    setAwaitingSignature(false);
    setPaymentStage({ state: "idle" });
    setBusy(false);
    setPhase("disconnected");
    await Promise.all(unsubscribes.map((unsubscribe) => unsubscribe().catch(() => undefined)));
    if (opened !== undefined) await opened.close().catch(() => undefined);
    return session;
  }, []);

  const resetSession = useCallback(async (reason?: string) => {
    const session = await disposeSession();
    if (reason !== undefined && sessionRef.current === session) setError(reason);
    return session;
  }, [disposeSession]);

  // A sync writes its state several times and each write announces a
  // snapshot, so event-driven reads run one at a time with at most one queued.
  const explicitSyncRef = useRef<{ opened: Wallet; session: number } | undefined>(undefined);
  const syncExplicitly = useCallback(async (opened: Wallet, session: number) => {
    explicitSyncRef.current = { opened, session };
    try { return await opened.sync({ awaitFunds: true }); }
    finally { if (explicitSyncRef.current?.opened === opened && explicitSyncRef.current.session === session) explicitSyncRef.current = undefined; }
  }, []);
  const eventReadRef = useRef<{ opened: Wallet; session: number; queued: { observePayments: boolean; terminal: boolean; waiters: { resolve(): void; reject(cause: unknown): void }[] } | undefined } | undefined>(undefined);
  const readWalletStateSoon = useCallback((opened: Wallet, session: number, observePayments: boolean, terminal = false): Promise<void> => {
    let resolve!: () => void;
    let reject!: (cause: unknown) => void;
    const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
    const completion = { resolve, reject };
    const running = eventReadRef.current;
    if (running?.opened === opened && running.session === session) {
      running.queued ??= { observePayments: false, terminal: false, waiters: [] };
      running.queued.observePayments ||= observePayments;
      running.queued.terminal ||= terminal;
      running.queued.waiters.push(completion);
      return promise;
    }
    const read: NonNullable<typeof eventReadRef.current> = { opened, session, queued: undefined };
    eventReadRef.current = read;
    void (async () => {
      let next: typeof read.queued = { observePayments, terminal, waiters: [completion] };
      while (next !== undefined) {
        read.queued = undefined;
        try {
          let applied = await readWalletState(opened, session, undefined, next.observePayments);
          while (!applied && next.terminal && sessionRef.current === session && walletRef.current === opened) {
            applied = await readWalletState(opened, session, undefined, next.observePayments);
          }
          next.waiters.forEach((waiter) => waiter.resolve());
        } catch (cause) {
          if (sessionRef.current === session && walletRef.current === opened) setError(errorMessage(cause));
          next.waiters.forEach((waiter) => waiter.reject(cause));
        }
        next = read.queued;
      }
      if (eventReadRef.current === read) eventReadRef.current = undefined;
    })();
    return promise;
  }, [readWalletState]);

  const installWalletEvents = useCallback((opened: Wallet, session: number) => {
    const current = () => sessionRef.current === session && walletRef.current === opened;
    const settleAwaiting = (actionId: string) => setAwaitingConfirmation((previous) => [...previous.values()].includes(actionId)
      ? new Map([...previous].filter(([, id]) => id !== actionId)) : previous);
    unsubscribeRef.current = [
      opened.on("snapshot", () => {
        if (current()) void readWalletStateSoon(opened, session, false).catch(() => undefined);
      }),
      opened.on("sync:tip", (event) => {
        if (current()) setFollowedStatus({ status: event.status, observedAt: Date.now() });
      }),
      opened.on("sync:started", () => {
        if (current()) setSyncState({ state: "syncing" });
      }),
      opened.on("sync:progress", (event) => {
        if (!current()) return;
        setSyncState({
          state: "syncing",
          ...(event.syncedThrough === undefined ? {} : { syncedThrough: event.syncedThrough }),
        });
      }),
      opened.on("sync:completed", (event) => {
        if (!current()) return;
        setSyncState({ state: "idle", syncedThrough: event.syncedThrough });
        const explicit = explicitSyncRef.current;
        if (explicit?.opened !== opened || explicit.session !== session) void readWalletStateSoon(opened, session, true).catch(() => undefined);
      }),
      // Sync-lease conflicts are retried inside the engine; what reaches this
      // event is terminal and worth surfacing.
      opened.on("sync:error", (event) => {
        if (current()) setSyncState({ state: "error", error: errorMessage(event.error) });
      }),
      opened.on("action:progress", (event) => {
        if (current()) setActionProgress({ phase: event.phase, message: event.message });
      }),
      // A failed action rejects to the screen that started it, which shows the error.
      opened.on("action:error", (event) => {
        if (current()) settleAwaiting(event.action.id);
      }),
      // Bytes already in a snapshot are a retry; only a fresh action's wait on its prompt is tracked.
      opened.on("action:before-journal", (event) => {
        const contentHash = event.contentHash.toLowerCase();
        if (current() && snapshotRef.current?.pendingContentHashes.includes(contentHash) !== true) {
          setAwaitingConfirmation((previous) => new Map(previous).set(contentHash, event.action.id));
        }
      }),
      opened.on("action:completed", (event) => {
        if (current()) settleAwaiting(event.action.id);
      }),
    ];
  }, [readWalletStateSoon]);

  // Follow the node's tip while the tab is visible. A hidden tab stops, and
  // catches up with one scan when it is shown again.
  const resumeFollowing = useCallback((opened: Wallet) => {
    void (followStopRef.current ?? Promise.resolve()).then(() => {
      if (document.visibilityState === "hidden" || followingRef.current !== opened || walletRef.current !== opened) return;
      try { opened.startSync({ intervalMs: TIP_POLL_INTERVAL_MS }); } catch { /* Closed while the tab was hidden. */ }
    });
  }, []);
  const followTip = useCallback((opened: Wallet) => {
    followingRef.current = opened;
    resumeFollowing(opened);
  }, [resumeFollowing]);
  useEffect(() => {
    const changed = () => {
      const opened = followingRef.current;
      if (opened === undefined || opened !== walletRef.current) return;
      if (document.visibilityState === "hidden") followStopRef.current = opened.stopSync().catch(() => undefined);
      else resumeFollowing(opened);
    };
    document.addEventListener("visibilitychange", changed);
    return () => document.removeEventListener("visibilitychange", changed);
  }, [resumeFollowing]);

  const synchronizeOpened = useCallback(async (opened: Wallet, session = sessionRef.current, preserveReady = false) => {
    if (sessionRef.current !== session || walletRef.current !== opened) return;
    if (!preserveReady) setPhase("syncing");
    setSyncState({ state: "syncing" });
    const result = await syncExplicitly(opened, session);
    if (sessionRef.current !== session || walletRef.current !== opened) return;
    setError(undefined);
    await readWalletStateSoon(opened, session, true, true);
    if (sessionRef.current !== session || walletRef.current !== opened) return;
    followTip(opened);
    setAccountRecord("present");
    setActivationBlocker(undefined);
    setPhase("ready");
    setSyncState({
      state: "idle",
      syncedThrough: result.syncedThrough,
    });
  }, [syncExplicitly, readWalletStateSoon, followTip]);

  const readActivationState = useCallback(async (opened: Wallet, session: number) => {
    const pending = await opened.accountActivation();
    const entries = (await activationRecoveryRef.current?.show())?.entries ?? [];
    if (sessionRef.current !== session || walletRef.current !== opened) return;
    const carriesActivation = (entry: RelayJournalEntry) => entry.kind === "batch" && entry.selected.includes(pending?.contentHash ?? "");
    const own = entries.find(carriesActivation);
    const blocker = entries.find((entry) => !carriesActivation(entry));
    setActivation(pending ?? undefined);
    setActivationContentHash(pending?.contentHash);
    setActivationBlocker(blocker);
    const hash = blocker ? blocker.transactionHash : pending?.l1TxHash;
    setActivationTransaction((previous) => previous?.hash === hash ? previous : undefined);
    setPhase(blocker ? "activation-blocked"
      : pending === null ? "activation-required"
      : pending.state === "prepared" ? "activation-prepared"
      : pending.state === "broadcast-requested" ? "activation-ambiguous" : "activation-mining");
    return { pending, blocker, own };
  }, []);

  const openSignedInProfile = useCallback(async (params: {
    current: StatusResult;
    derived: PcashProfile;
    connectedSigner: PcashActionSigner;
    connectedWalletClient: WalletClient;
    address: Address;
    session: number;
  }) => {
    const { current, derived, connectedSigner, connectedWalletClient, address, session } = params;
    let opened: Wallet | undefined;
    try {
      const walletWeb = await import("@pcash/sdk/wallet/web");
      const { createBrowserWalletProvers, openBrowserWallet } = walletWeb;
      if (sessionRef.current !== session) return;
      setPhase("opening");
      setConnectionStep("Opening wallet state in this browser");
      const publicClient = getPublicClient(ethereumConfig, { chainId: l1ChainId });
      if (publicClient === undefined) {
        throw new Error("Ethereum clients are not ready for account activation.");
      }
      const browserProvers = createBrowserWalletProvers({
        node,
        proverAssets: current.proverAssets,
        onStatus: (next) => {
          if (sessionRef.current === session) {
            logProverProgress(next);
            recordProofTiming(next);
            setProgress(next);
          }
        },
      });
      browserProversRef.current = browserProvers;
      const publication = browserPublication(walletWeb, {
        node,
        publicClient,
        walletClient: connectedWalletClient,
        account: address,
        payoutRecipient: { address: derived.address, nkRoot: derived.nkRoot },
      });
      const recovery = await publication.selfPublication.l1Recovery?.();
      if (sessionRef.current !== session) return;
      // Every Ethereum submission from this wallet is journaled just before its
      // wallet prompt and gets its hash when the prompt is confirmed; the lock
      // and the prompt state follow both points.
      const readLock = () => void recovery?.show()
        .then((view) => { if (sessionRef.current === session) setSubmissionLock(view.entries[0]); })
        .catch(() => undefined);
      const promptOpen = (open: boolean) => { if (sessionRef.current === session) setWalletPromptOpen(open); };
      const l1Adapter = publication.selfPublication;
      const selfPublication: L1SubmissionAdapter = {
        ...l1Adapter,
        submit: async (params) => {
          try {
            return await l1Adapter.submit({
              ...params,
              onL1Journaled: async (entry) => {
                if (sessionRef.current === session) setSubmissionLock((lock) => lock ?? entry);
                promptOpen(true);
                await params.onL1Journaled?.(entry);
              },
              onL1Submitted: async (hash) => {
                promptOpen(false);
                readLock();
                await params.onL1Submitted?.(hash);
              },
            });
          } finally {
            promptOpen(false);
            readLock();
          }
        },
      };
      opened = await openBrowserWallet({
        name: walletWeb.browserWalletDatabaseName("pcash-wallet-state", current),
        node,
        profile: derived,
        signer: withSignatureProgress(connectedSigner, () => {
          if (sessionRef.current === session) {
            setAwaitingSignature(true);
            setProgress(undefined);
          }
          const attempt = activeSendRef.current;
          const current = () => sessionRef.current === session && activeSendRef.current === attempt && attempt !== undefined && !attempt.canceled;
          if (current()) setActionProgress({ phase: "Approve payment", message: "Confirm the signature request in your Ethereum wallet." });
          return () => {
            if (sessionRef.current === session) setAwaitingSignature(false);
            if (current()) setActionProgress({ phase: "Preparing proof", message: "Preparing your private payment proof…" });
          };
        }),
        provers: browserProvers,
        submission: publication.submission,
        userAccountCreationSubmission: selfPublication,
        // Return after latest acceptance. Exact bytes and reservations remain
        // durable until a later sync observes finality or expiry.
        settlePollMaxAttempts: 1,
      });
      if (sessionRef.current !== session) {
        await opened.close();
        return;
      }
      walletRef.current = opened;
      activationRecoveryRef.current = recovery;
      profileRef.current = derived;
      setProfile(derived);
      setWallet(opened);
      setSelfPublication(selfPublication);
      installWalletEvents(opened, session);
      await readWalletState(opened, session);
      if (sessionRef.current !== session || walletRef.current !== opened) return;
      setConnectionStep("Checking your authenticated PCASH account");
      const accountReady = await opened.defaultAccountReady();
      if (sessionRef.current !== session || walletRef.current !== opened) return;
      setAccountRecord(accountReady ? "present" : "absent");
      if (!accountReady) {
        await readActivationState(opened, session);
        if (sessionRef.current !== session || walletRef.current !== opened) return;
        setConnectionStep(undefined);
        // Discovery does not grant spending readiness or block account setup.
        setSyncState({ state: "syncing" });
        const discovering = opened;
        void discovering.sync({ awaitFunds: true }).then(async () => {
          if (sessionRef.current !== session || walletRef.current !== discovering) return;
          await readWalletState(discovering, session);
          if (sessionRef.current !== session || walletRef.current !== discovering) return;
          followTip(discovering);
        }).catch((cause) => {
          if (sessionRef.current === session && walletRef.current === opened) {
            setSyncState({ state: "error", error: errorMessage(cause) });
          }
        });
        return "activation-required" as const;
      }
      await opened.clearAccountActivation();
      if (sessionRef.current !== session || walletRef.current !== opened) return;
      setActivation(undefined);
      setActivationContentHash(undefined);
      // Signed in once the account is known. The tip follower recovers notes
      // and pending actions behind it, and every spend scans before proving.
      setConnectionStep(undefined);
      setPhase("ready");
      followTip(opened);
      return "ready" as const;
    } catch (cause) {
      if (sessionRef.current === session) {
        setError(errorMessage(cause));
        setConnectionStep(undefined);
        setPhase("error");
      }
      if (opened !== undefined && walletRef.current !== opened) await opened.close().catch(() => undefined);
      throw cause;
    }
  }, [installWalletEvents, node, readActivationState, readWalletState, followTip]);

  const signInAs = useCallback(async (connectedSigner: PcashActionSigner, connectedWalletClient: WalletClient, address: string) => {
    const session = sessionRef.current;
    setBusy(true);
    setError(undefined);
    setPhase("signing-in");
    setConnectionStep("Sign in to unlock your private PCASH wallet");
    let saved = false;
    try {
      const current = await readStatus();
      const identity = profileSessionIdentity(current, address);
      const expectedRevision = await profileSessionRevision(identity);
      if (sessionRef.current !== session) return;
      const { derivePcashProfileFromSignature, profileDerivationSigningRequest } = await import("@pcash/sdk/wallet");
      const request = profileDerivationSigningRequest(networkConfigFromStatus(current), connectedSigner.address);
      const signed = verifyPcashAuthorization(request, await connectedSigner.signTypedData(request));
      const signature = toHex(serializeEcdsaSignature(signed));
      const derived = derivePcashProfileFromSignature(signature, networkConfigFromStatus(current), connectedSigner.address);
      if (sessionRef.current !== session) return;
      const committedRevision = await saveProfileSession(identity, signature, expectedRevision);
      if (committedRevision === null) {
        if (sessionRef.current === session) {
          setError("The saved PCASH sign-in changed while this request was open. Sign in again.");
          setConnectionStep(undefined);
          setPhase("sign-in-required");
        }
        return;
      }
      saved = true;
      if (sessionRef.current !== session) {
        await clearProfileSessionIfRevision(identity, committedRevision).catch(() => undefined);
        return;
      }
      activeProfileRevisionRef.current = committedRevision;
      return await openSignedInProfile({
        current,
        derived,
        connectedSigner,
        connectedWalletClient,
        address: address as Address,
        session,
      });
    } catch (cause) {
      if (sessionRef.current === session) {
        setError(errorMessage(cause));
        setConnectionStep(undefined);
        setPhase(saved ? "error" : "sign-in-required");
      }
      throw cause;
    } finally {
      if (sessionRef.current === session) setBusy(false);
    }
  }, [openSignedInProfile, readStatus]);

  const connect = useCallback(async (requested?: Connector, options?: { allowNetworkSwitch?: boolean }) => {
    const allowNetworkSwitch = options?.allowNetworkSwitch ?? true;
    // Any attempt that reuses an existing wagmi connection — the background
    // restore, the popover's retry, connector-driven invalidation — cannot
    // settle in "disconnected": the connect modal is withheld while wagmi is
    // connected, so that phase renders an inert button with no way forward.
    const reusedConnection = ethereumConnection.status === "connected";
    signedOutRef.current = false;
    const disposing = disposeSession();
    let restoring = false;
    setBusy(true);
    setError(undefined);
    setPhase("connecting");
    setConnectionStep("Verifying the configured PCASH network");
    const session = await disposing;
    if (sessionRef.current !== session) return;
    try {
      const current = await readStatus();
      setStatus(current);
      setConnectionStep("Requesting your Ethereum account");
      const connector = ethereumConnection.status === "connected"
        ? ethereumConnection.connector
        : requested;
      if (connector === undefined) throw new Error("Choose a wallet from the account menu to connect.");
      if (current.l1ChainId !== BigInt(l1ChainId)) {
        throw new Error(`This website is configured for ${l1Chain.name} (chain ${l1ChainId}), but the node follows Ethereum chain ${current.l1ChainId}.`);
      }
      let address: Address;
      if (ethereumConnection.status === "connected" && ethereumConnection.address !== undefined) {
        if (ethereumConnection.chainId !== l1ChainId) {
          // A wallet prompt is an interruption when it arrives unbidden on a
          // public page. On a wallet surface the visitor is mid-flow and the
          // switch is what they are there for, so only the former is deferred.
          if (!allowNetworkSwitch) {
            setPhase("wrong-network");
            setConnectionStep(undefined);
            setBusy(false);
            return;
          }
          setConnectionStep(`Switching your Ethereum wallet to ${l1Chain.name}`);
          await switchChain(ethereumConfig, { chainId: l1ChainId });
        }
        address = ethereumConnection.address;
      } else {
        const connected = await connectWagmi(ethereumConfig, { connector, chainId: l1ChainId });
        const selected = connected.accounts[0];
        if (selected === undefined) throw new Error("The wallet returned no usable account.");
        address = selected;
      }
      if (sessionRef.current !== session) return;
      const connected = await getWalletClient(ethereumConfig, { chainId: l1ChainId, connector });
      const connectedWalletClient = networkWalletClient(connected, address, l1Chain);
      const [{ derivePcashProfileFromSignature }, { viemPcashActionSigner }] = await Promise.all([
        import("@pcash/sdk/wallet"),
        import("@pcash/sdk/wallet/web"),
      ]);
      if (sessionRef.current !== session) return;
      const connectedSigner = viemPcashActionSigner(connectedWalletClient, address);
      setSigner(connectedSigner);
      setWalletClient(connectedWalletClient);
      setConnectedAccount(address);
      const signInNow = onboardingIntentRef.current !== undefined;
      if (onboardingIntentRef.current) {
        const destination = onboardingIntentRef.current;
        onboardingIntentRef.current = undefined;
        navigate(destination, { preventScrollReset: true });
      }
      const identity = profileSessionIdentity(current, address);
      activeProfileIdentityRef.current = identity;
      // Account existence is read from the wallet's synced account set after
      // sign-in; asking the node here would name this address to it.
      const loaded = await loadProfileSession(identity);
      if (sessionRef.current !== session) return;
      if (loaded.state === "absent") {
        activeProfileRevisionRef.current = loaded.revision;
        setPhase("sign-in-required");
        setConnectionStep(undefined);
        // A connection the user asked for asks for the key signature at once.
        // Declining leaves the wallet connected and locked, with Sign in offered.
        if (signInNow) await signInAs(connectedSigner, connectedWalletClient, address).catch(() => undefined);
        return;
      }
      restoring = true;
      activeProfileRevisionRef.current = loaded.revision;
      setConnectionStep("Restoring your saved PCASH sign-in");
      let derived: PcashProfile;
      try {
        derived = derivePcashProfileFromSignature(
          loaded.signature,
          networkConfigFromStatus(current),
          connectedSigner.address,
        );
      } catch {
        try {
          const cleared = await clearProfileSessionIfRevision(identity, loaded.revision);
          if (sessionRef.current !== session) return;
          if (cleared) {
            activeProfileRevisionRef.current = undefined;
          } else {
            setError("The saved PCASH sign-in changed while it was being checked. Reconnect or forget it before continuing.");
            setPhase("error");
            setConnectionStep(undefined);
            return;
          }
        } catch (cause) {
          if (sessionRef.current === session) {
            setError(`Your saved PCASH sign-in is invalid and could not be removed: ${errorMessage(cause)}`);
            setPhase("error");
            setConnectionStep(undefined);
          }
          return;
        }
        if (sessionRef.current !== session) return;
        setError("Your saved PCASH sign-in is invalid. Sign in again to replace it.");
        setPhase("sign-in-required");
        setConnectionStep(undefined);
        return;
      }
      await openSignedInProfile({
        current,
        derived,
        connectedSigner,
        connectedWalletClient,
        address,
        session,
      });
    } catch (cause) {
      if (sessionRef.current === session) {
        setError(errorMessage(cause));
        setConnectionStep(undefined);
        setPhase(reusedConnection || restoring || walletRef.current !== undefined ? "error" : "disconnected");
      }
      throw cause;
    } finally {
      if (sessionRef.current === session) setBusy(false);
    }
  }, [disposeSession, ethereumConnection, navigate, node, openSignedInProfile, readStatus, signInAs]);

  const signIn = useCallback(async () => {
    if (signer === undefined || walletClient === undefined || connectedAccount === undefined) {
      throw new Error("Connect an Ethereum wallet before signing in to PCASH.");
    }
    return signInAs(signer, walletClient, connectedAccount);
  }, [connectedAccount, signInAs, signer, walletClient]);

  const switchNetwork = useCallback(async () => {
    setBusy(true);
    setError(undefined);
    try {
      await switchChain(ethereumConfig, { chainId: l1ChainId });
      autoConnectKeyRef.current = undefined;
      setPhase("disconnected");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }, []);

  const disconnect = useCallback(async () => {
    signedOutRef.current = true;
    autoConnectKeyRef.current = undefined;
    const disposing = disposeSession();
    const session = sessionRef.current;
    setBusy(true);
    const [disconnected, disposed] = await Promise.allSettled([disconnectWagmi(ethereumConfig), disposing]);
    if (sessionRef.current !== session) return;
    setBusy(false);
    setError(disconnected.status === "rejected" ? errorMessage(disconnected.reason)
      : disposed.status === "rejected" ? errorMessage(disposed.reason) : undefined);
  }, [disposeSession, ethereumConfig]);

  useEffect(() => subscribeToSignOut((key, revision) => {
    const identity = activeProfileIdentityRef.current;
    if (identity === undefined || profileSessionKey(identity) !== key
      || (activeProfileRevisionRef.current !== undefined && activeProfileRevisionRef.current >= revision)) return;
    void disconnect().catch((cause) => setError(errorMessage(cause)));
  }), [disconnect, subscribeToSignOut]);

  useEffect(() => {
    if (connectedAccount === undefined || status === undefined) return;
    const expectedChainId = Number(status.l1ChainId);
    const changedAccount = ethereumConnection.address?.toLowerCase() !== connectedAccount.toLowerCase();
    const changedChain = ethereumConnection.chainId !== expectedChainId;
    if (ethereumConnection.status !== "connected" || changedAccount || changedChain) {
      signedOutRef.current = true;
      void (async () => {
        const resetting = resetSession();
        setBusy(true);
        const session = await resetting;
        if (sessionRef.current !== session) return;
        signedOutRef.current = false;
        autoConnectKeyRef.current = undefined;
        if (ethereumConnection.status === "connected") await connect(undefined, { allowNetworkSwitch: onWalletSurface(pathname, hash) });
        else setBusy(false);
      })().catch(() => undefined);
    }
  }, [connect, connectedAccount, ethereumConnection, pathname, hash, resetSession, status]);

  // Nothing may render as "disconnected" until node status has settled and the
  // injected wallet has finished its own reconnection. Guessing before then is
  // what made the route paint onboarding and then replace it with the wallet.
  useEffect(() => {
    if (phase !== "initializing") return;
    if (!statusSettled || ethereumConnection.status === "reconnecting") return;
    // Node status settled without a result: the node is unreachable or is a
    // different network. Surface that instead of skeletoning forever.
    if (status === undefined) {
      setPhase("error");
      return;
    }
    if (ethereumConnection.status === "connected") return;
    setPhase("disconnected");
  }, [ethereumConnection.status, phase, status, statusSettled]);

  useEffect(() => {
    const previousChainId = observedChainIdRef.current;
    observedChainIdRef.current = ethereumConnection.chainId;
    if (phase !== "wrong-network" && phase !== "error") return;
    if (ethereumConnection.status !== "connected") {
      if (phase === "wrong-network") setPhase("disconnected");
      return;
    }
    if (ethereumConnection.chainId !== l1ChainId) return;
    // A held wrong-network state resolves as soon as the chain is right. An
    // error state only resolves on an actual transition onto the configured
    // chain, so that unrelated failures are not retried on every render.
    if (phase === "error" && previousChainId === ethereumConnection.chainId) return;
    autoConnectKeyRef.current = undefined;
    setPhase("disconnected");
  }, [ethereumConnection.chainId, ethereumConnection.status, phase]);

  useEffect(() => {
    // Sign-out publishes `disconnected` before wagmi has finished tearing the
    // connector down. Lifting the latch on the mere sight of a connected wallet
    // would restart a session inside that window, so only the transition into
    // connected counts as a new connection.
    const previousWagmiStatus = wagmiStatusRef.current;
    wagmiStatusRef.current = ethereumConnection.status;
    if (previousWagmiStatus !== "connected" && ethereumConnection.status === "connected") {
      signedOutRef.current = false;
    }
    if (
      signedOutRef.current
      || (phase !== "disconnected" && phase !== "initializing")
      || status === undefined
      || ethereumConnection.status !== "connected"
      || ethereumConnection.address === undefined
    ) return;
    const key = `${ethereumConnection.chainId}:${ethereumConnection.address.toLowerCase()}`;
    if (autoConnectKeyRef.current === key) return;
    autoConnectKeyRef.current = key;
    void connect(undefined, { allowNetworkSwitch: onWalletSurface(pathname, hash) }).catch(() => undefined);
  }, [connect, ethereumConnection, pathname, hash, phase, status]);

  const refresh = useCallback(async (session = sessionRef.current) => {
    const opened = walletRef.current;
    if (opened !== undefined) await readWalletState(opened);
    if (sessionRef.current !== session) return;
    const current = await readStatus();
    if (sessionRef.current === session) setStatus(current);
  }, [readStatus, readWalletState]);

  /** Errors go to the caller, which shows them on the screen that started the action. */
  const runAction = useCallback(async <T,>(action: () => Promise<T>, refreshAfter = true): Promise<T> => {
    const session = sessionRef.current;
    setBusy(true);
    setProgress(undefined);
    setActionProgress(undefined);
    try {
      const result = await action();
      if (sessionRef.current !== session) throw new Error("Wallet session changed while the action was running.");
      if (refreshAfter) await refresh(session);
      if (sessionRef.current !== session) throw new Error("Wallet session changed while the action was running.");
      return result;
    } finally {
      if (sessionRef.current === session) setBusy(false);
    }
  }, [refresh]);

  const publishReleased = useCallback((released: SubmissionLockRefresh["released"], recovered: SubmissionLockRefresh["recovered"] = []) => {
    if (status === undefined || connectedAccount === undefined) return;
    publishReleasedRelayAttempts(relayHistoryKey(relayDeploymentKey(status), connectedAccount), released.flatMap(entry => entry.kind === "batch" ? [{
      resolutionId: entry.resolutionId, transactionHash: entry.transactionHash, selected: entry.selected,
    }] : []), recovered);
  }, [connectedAccount, status]);

  const reconcileRecovery = useCallback(async () => {
    const recovery = activationRecoveryRef.current;
    if (recovery === undefined) return undefined;
    const session = sessionRef.current;
    const opened = walletRef.current;
    const { reconciliation, recovered } = await reconcileSubmissionLock(recovery);
    if (sessionRef.current === session && walletRef.current === opened && activationRecoveryRef.current === recovery) publishReleased([], recovered);
    return reconciliation;
  }, [publishReleased]);

  /** Map one headless advance result onto the provider's phases and copy. */
  const applyAdvance = useCallback(async (
    opened: Wallet,
    currentProfile: PcashProfile,
    session: number,
  ) => {
    const [{ advanceAccountActivation }] = await Promise.all([import("@pcash/sdk/wallet/web")]);
    if (sessionRef.current !== session || walletRef.current !== opened) return;
    const publicClient = getPublicClient(ethereumConfig, { chainId: l1ChainId });
    if (publicClient === undefined) throw new Error("Ethereum client is unavailable during activation recovery.");
    const result = await advanceAccountActivation({
      wallet: opened,
      profile: currentProfile,
      node,
      publicClient,
    });
    if (sessionRef.current !== session || walletRef.current !== opened) return;
    if (result.kind === "ready") {
      await opened.clearAccountActivation();
      if (sessionRef.current !== session || walletRef.current !== opened) return;
      setActivation(undefined);
      setActivationContentHash(undefined);
      await synchronizeOpened(opened, session);
      return;
    }
    if (result.kind === "reset-to-prepared") {
      await reconcileRecovery();
      if (sessionRef.current !== session || walletRef.current !== opened) return;
      await readActivationState(opened, session);
      if (sessionRef.current !== session || walletRef.current !== opened) return;
      setError(result.message);
      return;
    }
    if (result.kind === "l1-unconfirmed") {
      setPhase("activation-mining");
      setConnectionStep(result.message);
      return;
    }
    setPhase("activation-pending");
    setConnectionStep("Ethereum mined the activation; waiting for PCASH derivation");
  }, [node, readActivationState, reconcileRecovery, synchronizeOpened]);

  const checkAccountActivation = useCallback(async () => {
    const opened = walletRef.current;
    const currentProfile = profileRef.current;
    if (opened === undefined || currentProfile === undefined) throw new Error("Connect and derive the wallet first.");
    const session = sessionRef.current;
    if (activationCheckRef.current?.session === session) return activationCheckRef.current.promise;
    if (setupRunningRef.current?.session === session) return;
    const attempt = { session, promise: Promise.resolve() };
    attempt.promise = (async () => {
      try {
        const current = await readStatus();
        if (sessionRef.current !== session || walletRef.current !== opened) return;
        setStatus(current);
        if (await opened.defaultAccountReady()) {
          if (sessionRef.current !== session || walletRef.current !== opened) return;
          await opened.clearAccountActivation();
          if (sessionRef.current !== session || walletRef.current !== opened) return;
          setActivation(undefined);
          setActivationContentHash(undefined);
          await synchronizeOpened(opened, session);
          return;
        }
        let state = await readActivationState(opened, session);
        if (state && (state.blocker || state.pending?.state === "l1-submitted" || state.pending?.state === "broadcast-requested")) {
          const watched = state.blocker ?? state.own;
          const reconciliation = await reconcileRecovery();
          if (sessionRef.current !== session || walletRef.current !== opened) return;
          state = await readActivationState(opened, session);
          const outcome = reconciliation?.entries.find((entry) => entry.resolutionId === watched?.resolutionId);
          if (outcome?.outcome === "pending" && outcome.transactionHash) {
            const { inspectAccountActivationTransaction } = await import("@pcash/sdk/wallet/web");
            const publicClient = getPublicClient(ethereumConfig, { chainId: l1ChainId });
            if (publicClient === undefined) throw new Error("Ethereum client is unavailable during activation recovery.");
            const transaction = await inspectAccountActivationTransaction(publicClient, outcome.transactionHash);
            if (sessionRef.current !== session || walletRef.current !== opened) return;
            setActivationTransaction(transaction);
            setError(undefined);
            return;
          }
          if (outcome?.outcome === "ambiguous") return;
          if (outcome?.outcome === "unobserved" && state?.pending?.state === "l1-submitted" && !state.blocker) {
            setPhase("activation-pending");
            setActivationTransaction({ hash: outcome.transactionHash!, state: "included" });
            setError(undefined);
            return;
          }
        }
        if (state?.blocker || state === undefined) return;
        if (state.pending?.state === "l1-submitted") {
          await applyAdvance(opened, currentProfile, session);
        }
      } catch (cause) {
        if (sessionRef.current === session) setError(errorMessage(cause));
        throw cause;
      } finally {
        if (activationCheckRef.current === attempt) activationCheckRef.current = undefined;
      }
    })();
    activationCheckRef.current = attempt;
    return attempt.promise;
  }, [applyAdvance, node, readActivationState, readStatus, reconcileRecovery, synchronizeOpened]);

  const setupAccount = useCallback(async (retryContentHash?: string, publication: "self" | "open" = "self") => {
    const session = sessionRef.current;
    if (setupRunningRef.current?.session === session) return;
    const attempt = { session };
    setupRunningRef.current = attempt;
    let opened: Wallet | undefined;
    let preparingAccount = false;
    try {
      opened = walletRef.current;
      const currentProfile = profileRef.current;
      if (opened === undefined || currentProfile === undefined) return;
      setBusy(true);
      setError(undefined);
      await activationCheckRef.current?.promise;
      if (sessionRef.current !== session || walletRef.current !== opened) return;
      if (await opened.defaultAccountReady()) {
        if (sessionRef.current !== session || walletRef.current !== opened) return;
        await opened.clearAccountActivation();
        if (sessionRef.current !== session || walletRef.current !== opened) return;
        setActivation(undefined);
        setActivationContentHash(undefined);
        await synchronizeOpened(opened, session);
        return;
      }
      if (sessionRef.current !== session || walletRef.current !== opened) return;
      if (retryContentHash !== undefined && publication === "self") {
        const { releaseExpiredAccountActivation } = await import("@pcash/sdk/wallet/web");
        const recovery = activationRecoveryRef.current;
        if (recovery === undefined) throw new Error("Ethereum submission recovery is unavailable.");
        await releaseExpiredAccountActivation({ wallet: opened, node, recovery, contentHash: retryContentHash });
        if (sessionRef.current !== session || walletRef.current !== opened) return;
      }
      let state = await readActivationState(opened, session);
      if (state?.blocker) {
        await reconcileRecovery();
        if (sessionRef.current !== session || walletRef.current !== opened) return;
        state = await readActivationState(opened, session);
      }
      if (state === undefined || state.blocker) return;
      let pending = state.pending;
      publication = pending?.publication ?? publication;
      if (pending?.state === "broadcast-requested" || pending?.state === "l1-submitted") {
        setSetupStep("waiting");
        await checkAccountActivation();
        return;
      }
      preparingAccount = true;
      setPhase("activating");
      setSetupStep(undefined);
      setConnectionStep("Preparing your account creation transaction");
      if (publication === "self") await assertFasterGas("setup");
      if (sessionRef.current !== session || walletRef.current !== opened) return;
      const preparingWallet = opened;
      pending = await traceWalletOperation("setup: prepare account and mining proof", () =>
        preparingWallet.prepareAccountActivation({ authorizationMode: "signed", mine: true, publication }));
      if (sessionRef.current !== session || walletRef.current !== opened) return;
      setActivation(pending);
      setActivationContentHash(pending.contentHash);
      if (pending.state !== "prepared") {
        setPhase(pending.state === "broadcast-requested" ? "activation-ambiguous" : "activation-mining");
        return;
      }
      setSetupStep(publication === "self" ? "ethereum" : "waiting");
      setConnectionStep(publication === "self" ? "Confirm the Ethereum transaction in your wallet" : "Submitting account setup to relayers");
      const submittingWallet = opened;
      await traceWalletOperation("setup: Ethereum approval and submission", () => submittingWallet.submitAccountActivation((submitted) => {
        if (sessionRef.current !== session || walletRef.current !== submittingWallet) return;
        setActivation(submitted);
        setActivationContentHash(submitted.contentHash);
        setPhase("activation-mining");
        setSetupStep("waiting");
      }));
      if (sessionRef.current !== session || walletRef.current !== opened) return;
      pending = await opened.accountActivation();
      if (sessionRef.current !== session || walletRef.current !== opened) return;
      setActivation(pending ?? undefined);
      setActivationContentHash(pending?.contentHash);
      preparingAccount = false;
      setPhase("activation-mining");
      setSetupStep("waiting");
      const submittedWallet = opened;
      await traceWalletOperation("setup: observe activation", () => applyAdvance(submittedWallet, currentProfile, session));
    } catch (cause) {
      if (sessionRef.current === session && opened !== undefined) {
        const state = await readActivationState(opened, session).catch(() => undefined);
        if (sessionRef.current !== session || walletRef.current !== opened) return;
        setError(state?.blocker ? undefined : errorMessage(cause));
        if (state === undefined || (state.pending === null && !preparingAccount && !state.blocker)) setPhase("error");
      }
      throw cause;
    } finally {
      if (setupRunningRef.current === attempt) setupRunningRef.current = undefined;
      if (sessionRef.current === session) {
        setSetupStep(undefined);
        setConnectionStep(undefined);
        setBusy(false);
      }
    }
  }, [applyAdvance, assertFasterGas, checkAccountActivation, node, readActivationState, reconcileRecovery, synchronizeOpened]);

  const activationPending = phase === "activation-mining" || phase === "activation-pending" || phase === "activation-ambiguous" || phase === "activation-blocked";
  useEffect(() => {
    if (busy || !activationPending) return;
    let stopped = false;
    const check = async () => {
      await checkAccountActivation().catch(() => undefined);
      if (!stopped) timer = setTimeout(() => void check(), 3_000);
    };
    let timer = setTimeout(() => void check(), 3_000);
    return () => { stopped = true; clearTimeout(timer); };
  }, [activationPending, busy, checkAccountActivation]);

  const synchronize = useCallback(async () => {
    const opened = walletRef.current;
    if (opened === undefined) throw new Error("Connect a wallet first.");
    const startingPhase = phase;
    const session = sessionRef.current;
    try {
      await runAction(async () => {
        if (startingPhase === "ready") return synchronizeOpened(opened, session, true);
        setSyncState({ state: "syncing" });
        const result = await syncExplicitly(opened, session);
        if (sessionRef.current !== session || walletRef.current !== opened) return;
        await readWalletStateSoon(opened, session, true, true);
        if (sessionRef.current === session && walletRef.current === opened) setSyncState({ state: "idle", syncedThrough: result.syncedThrough });
        if (sessionRef.current === session && walletRef.current === opened) followTip(opened);
      }, false);
    } catch (cause) {
      if (sessionRef.current === session && walletRef.current === opened) {
        setSyncState({ state: "error", error: errorMessage(cause) });
      }
      throw cause;
    }
  }, [phase, runAction, synchronizeOpened, syncExplicitly, readWalletStateSoon, followTip]);

  const preflightPrivateSend = useCallback(async (intent: WalletSendIntent) => {
    const opened = walletRef.current;
    if (opened === undefined || phase !== "ready") throw new Error("Finish wallet setup before sending.");
    return runAction(async () => {
      const review = await opened.preflightSend(walletSendIntent(intent));
      // A saved earning action paying this wallet retains its own L1 publisher.
      // This also makes setup mining retryable after registration completes.
      return review.retry && intent.amount === 0n
        && review.beneficiary.kind === "self" && selfPublication !== undefined
        ? opened.preflightSend(walletSendIntent({ ...intent, publication: "self" })) : review;
    }, false);
  }, [phase, runAction, selfPublication, walletSendIntent]);

  // Synchronization retires a payment's journal entry once it finalizes or
  // expires, so the journal alone cannot say which happened. Ask the chain.
  const resolvePendingPaymentFate = useCallback(async (contentHash: string): Promise<WalletPaymentFate> => {
    const opened = walletRef.current;
    if (opened === undefined || phase !== "ready") throw new Error("Finish wallet setup before sending.");
    return runAction(async () => {
      const current = await opened.snapshot();
      if (current.pendingPayments.some((payment) => payment.contentHash === contentHash)) return "pending";
      const receipt = await pollReceipt(node, contentHash);
      return receipt?.outcome === "succeeded" ? "confirmed" : "cleared";
    });
  }, [node, phase, runAction]);

  const sendPrivate = useCallback(async (
    intent: WalletSendIntent,
    reviewed: WalletSendPreflight,
  ): Promise<WalletSendOutcome> => {
    const opened = walletRef.current;
    const session = sessionRef.current;
    if (opened === undefined || phase !== "ready") throw new Error("Finish wallet setup before sending.");
    if (activeSendRef.current !== undefined) throw new Error("Finish or cancel the current payment first.");
    const attemptId = ++sendAttemptSequenceRef.current;
    const attempt: ActiveSendAttempt = {
      id: attemptId,
      canceled: false,
      submitting: reviewed.retry,
      journaled: reviewed.retry,
      ...(intent.retryContentHash === undefined ? {} : { contentHash: intent.retryContentHash }),
      lockController: new AbortController(),
    };
    let l1Hash: string | undefined;
    activeSendRef.current = attempt;
    setPaymentStage(reviewed.retry
      ? { state: "submitting", attemptId }
      : { state: "proving", attemptId });
    const removeStarted = opened.on("action:started", (event) => {
      if (event.action.name === "send" && attempt.walletActionId === undefined) {
        attempt.walletActionId = event.action.id;
      }
    });
    // The last point a cancel can win: past it the proved bytes journal and submit.
    const removeBeforeJournal = opened.hook("action:before-journal", async (event) => {
      if (event.action.id !== attempt.walletActionId || reviewed.retry) return;
      if (attempt.canceled || activeSendRef.current !== attempt) throw new WalletPaymentCanceledError();
      attempt.contentHash = event.contentHash;
      attempt.submitting = true;
      setPaymentStage({ state: "submitting", attemptId, contentHash: event.contentHash });
    });
    const removePrepared = opened.on("action:prepared", (event) => {
      if (sessionRef.current !== session || walletRef.current !== opened || event.action.id !== attempt.walletActionId) return;
      attempt.journaled = true;
      attempt.contentHash = event.contentHash;
      setPaymentStage({ state: "submitting", attemptId, contentHash: event.contentHash });
    });
    try {
      const execute = () => runAction(async () => {
        setActionProgress({ phase: "Preparing payment", message: "Reading payment inputs and account settings…" });
        if (reviewed.publication === "self" && !reviewed.retry) await assertFasterGas();
        try {
          // The transfer engine re-reads and compares the reviewed funding state.
          // Fresh sends do not acquire durable input ownership until the
          // before-journal hook above lets the exact proved bytes commit.
          return await opened.send({
            ...walletSendIntent({ ...intent, publication: reviewed.publication }, (hash) => {
              l1Hash = hash;
              if (sessionRef.current === session && walletRef.current === opened && activeSendRef.current === attempt) {
                setPaymentStage({ state: "l1-submitted", attemptId, l1Hash: hash,
                  ...(attempt.contentHash === undefined ? {} : { contentHash: attempt.contentHash }) });
              }
            }),
            signal: attempt.lockController.signal,
            onProgress: (nextPhase, message) => {
              if (sessionRef.current === session && walletRef.current === opened) {
                setActionProgress({ phase: nextPhase, message });
              }
            },
          }, reviewed);
        } catch (cause) {
          if (cause instanceof WalletReviewStaleError) {
            throw new Error("Wallet state changed after review. Send the payment again.");
          }
          throw cause;
        }
      });
      const lockName = `pcash-wallet-send:${opened.network.chainId}:${opened.address}`;
      if (navigator.locks !== undefined) {
        setActionProgress({ phase: "Waiting", message: "Waiting for any other wallet tab to finish…" });
      }
      const result = navigator.locks === undefined
        ? await execute()
        : await navigator.locks.request(
            lockName,
            { mode: "exclusive", signal: attempt.lockController.signal },
            execute,
          );
      if (sessionRef.current !== session || walletRef.current !== opened) {
        throw new Error("Wallet session changed while the action was running.");
      }
      // The outcome carries the L1 hash; the send view tracks its confirmation.
      setPaymentStage({ state: "idle" });
      return {
        contentHash: result.contentHash,
        publication: reviewed.publication,
        ...(l1Hash === undefined ? {} : { l1Hash }),
        accepted: result.accepted,
        queued: result.queued,
        settled: result.settled,
        retried: result.retried,
        recovered: result.recovered,
      };
    } catch (cause) {
      if (sessionRef.current !== session || walletRef.current !== opened) throw cause;
      if (attempt.canceled || paymentCanceled(cause)) {
        setPaymentStage({ state: "idle" });
        throw new WalletPaymentCanceledError();
      }
      if (l1Hash !== undefined) {
        // Broadcast succeeded. Receipt polling can fail without making the
        // submission ambiguous; the payment screen tracks this exact L1 hash.
        setPaymentStage({ state: "l1-submitted", attemptId, l1Hash,
          ...(attempt.contentHash === undefined ? {} : { contentHash: attempt.contentHash }) });
      } else setPaymentStage(attempt.journaled && !(cause instanceof DurablePreBroadcastError)
        ? { state: "submission-unknown", attemptId, ...(attempt.contentHash === undefined ? {} : { contentHash: attempt.contentHash }) }
        : { state: "failed", attemptId });
      throw cause;
    } finally {
      void removeStarted();
      removeBeforeJournal();
      void removePrepared();
      if (activeSendRef.current === attempt) activeSendRef.current = undefined;
    }
  }, [assertFasterGas, phase, runAction, walletSendIntent]);

  const cancelPrivateSend = useCallback(() => {
    const attempt = activeSendRef.current;
    if (attempt === undefined || attempt.submitting || attempt.journaled) return;
    attempt.canceled = true;
    attempt.lockController.abort();
    browserProversRef.current?.cancelCurrent();
    setPaymentStage({ state: "canceling", attemptId: attempt.id });
  }, []);

  const resetPrivateSend = useCallback(() => {
    if (activeSendRef.current === undefined) setPaymentStage({ state: "idle" });
  }, []);

  useEffect(() => () => {
    sessionRef.current += 1;
    const activeSend = activeSendRef.current;
    if (activeSend !== undefined && !activeSend.submitting && !activeSend.journaled) {
      activeSend.canceled = true;
      activeSend.lockController.abort();
    }
    activeSendRef.current = undefined;
    browserProversRef.current?.destroy();
    browserProversRef.current = undefined;
    const unsubscribes = unsubscribeRef.current;
    const openedWallet = walletRef.current;
    unsubscribeRef.current = [];
    walletRef.current = undefined;
    void (async () => {
      await Promise.all(unsubscribes.map((unsubscribe) => unsubscribe().catch(() => undefined)));
      if (openedWallet !== undefined) await openedWallet.close();
    })().catch(() => undefined);
  }, []);

  useEffect(() => {
    if (wallet === undefined) return;
    let cancelled = false;
    const read = () => void activationRecoveryRef.current?.show()
      .then((view) => { if (!cancelled) setSubmissionLock(view.entries[0]); })
      .catch(() => undefined);
    read();
    const interval = setInterval(read, 10_000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [wallet]);

  const settleLock = useCallback(async (): Promise<SubmissionLockRefresh> => {
    const session = sessionRef.current;
    const opened = walletRef.current;
    const recovery = activationRecoveryRef.current;
    const publicClient = getPublicClient(ethereumConfig, { chainId: l1ChainId });
    if (recovery === undefined || publicClient === undefined) throw new Error("Sign in to check Ethereum submissions.");
    const result = await refreshSubmissionLock(recovery, viemSubmissionLockL1(publicClient), node);
    if (sessionRef.current !== session || walletRef.current !== opened || activationRecoveryRef.current !== recovery) return result;
    publishReleased(result.released, result.recovered);
    setSubmissionLock(result.waiting[0]);
    if (activationContentHash !== undefined && result.released.some((entry) => entry.kind === "batch" && entry.selected.includes(activationContentHash))) {
      await walletRef.current?.resetAccountActivationSubmission();
      await checkAccountActivation();
    }
    return result;
  }, [activationContentHash, checkAccountActivation, ethereumConfig, l1ChainId, node, publishReleased]);

  const refreshingLockRef = useRef<{ session: number; promise: Promise<SubmissionLockRefresh> } | undefined>(undefined);
  const refreshLock = useCallback((): Promise<SubmissionLockRefresh> => {
    // The poll and a person's Check status share one settlement at a time.
    const session = sessionRef.current;
    if (refreshingLockRef.current?.session === session) return refreshingLockRef.current.promise;
    const refreshing = { session, promise: settleLock() };
    refreshingLockRef.current = refreshing;
    void refreshing.promise.finally(() => { if (refreshingLockRef.current === refreshing) refreshingLockRef.current = undefined; }).catch(() => undefined);
    return refreshing.promise;
  }, [settleLock]);
  const refreshLockRef = useRef(refreshLock);
  refreshLockRef.current = refreshLock;
  // While a submission is in flight, settle it until it lands or can no longer land.
  const locked = submissionLock !== undefined;
  useEffect(() => {
    if (!locked) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      await refreshLockRef.current().catch(() => undefined);
      if (!stopped) timer = setTimeout(() => void poll(), 5_000);
    };
    void poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, [locked]);

  const viewerAccount = ethereumConnection.status === "connected" ? ethereumConnection.address : undefined;
  // Connector changes arrive before the effect disposes the previous session.
  const currentSession = viewerAccount !== undefined
    && viewerAccount.toLowerCase() === connectedAccount?.toLowerCase()
    && ethereumConnection.chainId === l1ChainId;
  const changingSession = connectedAccount !== undefined && !currentSession;
  const visiblePhase = changingSession
    ? viewerAccount === undefined ? "disconnected"
      : ethereumConnection.chainId !== l1ChainId ? "wrong-network" : "connecting"
    : phase;

  return <WalletContext.Provider value={{
    node,
    readStatus,
    ...(status === undefined ? {} : { status }),
    ...(!currentSession || followedStatus === undefined ? {} : { followedStatus }),
    ...(!currentSession || profile === undefined ? {} : { profile }),
    ...(!currentSession || walletClient === undefined ? {} : { walletClient }),
    ...(!currentSession || wallet === undefined ? {} : { wallet }),
    ...(!currentSession || selfPublication === undefined ? {} : { selfPublication }),
    ...(!currentSession || snapshot === undefined ? {} : { snapshot }),
    paymentActivity: currentSession ? paymentActivity : [],
    awaitingConfirmation: currentSession ? awaitingConfirmation : new Map(),
    ...(!currentSession || funds === undefined ? {} : { funds }),
    ...(viewerAccount === undefined ? {} : { connectedAccount: viewerAccount }),
    ...(!currentSession || l1Balance === undefined ? {} : { l1Balance }),
    accountRecord: currentSession ? accountRecord : "unknown",
    switchNetwork,
    phase: visiblePhase,
    ...(changingSession || connectionStep === undefined ? {} : { connectionStep }),
    syncState: currentSession ? syncState : { state: "idle" },
    ...(!currentSession || activationContentHash === undefined ? {} : { activationContentHash }),
    ...(!currentSession || activation === undefined ? {} : { activation }),
    ...(!currentSession || activationBlocker === undefined ? {} : { activationBlocker }),
    ...(!currentSession || activationTransaction === undefined ? {} : { activationTransaction }),
    ...(!currentSession || submissionLock === undefined ? {} : { submissionLock }),
    refreshSubmissionLock: refreshLock,
    walletPromptOpen: currentSession && walletPromptOpen,
    assertFasterGas,
    ...(!currentSession || progress === undefined ? {} : { progress }),
    ...(!currentSession || actionProgress === undefined ? {} : { actionProgress }),
    awaitingSignature: currentSession && awaitingSignature,
    paymentStage: currentSession ? paymentStage : { state: "idle" },
    busy: changingSession ? viewerAccount !== undefined : busy,
    ...(changingSession || error === undefined ? {} : { error }),
    connect,
    signIn,
    beginOnboarding,
    cancelOnboarding,
    setupAccount,
    setupAccountWithoutEth: () => setupAccount(undefined, "open"),
    retryAccountSetup: setupAccount,
    ...(!currentSession || setupStep === undefined ? {} : { setupStep }),
    disconnect,
    checkAccountActivation,
    synchronize,
    refresh,
    preflightPrivateSend,
    resolvePendingPaymentFate,
    sendPrivate,
    cancelPrivateSend,
    resetPrivateSend,
    runAction,
    clearError,
  }}>{children}</WalletContext.Provider>;
}

export function useWallet(): WalletContextValue {
  const value = useContext(WalletContext);
  if (value === null) throw new Error("WalletProvider is missing");
  return value;
}
