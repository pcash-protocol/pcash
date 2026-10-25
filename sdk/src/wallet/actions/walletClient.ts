import { restoreTransactionData, type TransactionData, type DataRecord } from "@pcash/sdk/delivery";
import type { StoredTransactionRecords } from "../noteStore.ts";
import { planNativeConsolidation, ConsolidationRequiredError } from "../consolidation.ts";
import { InsufficientNotesError } from "../noteStore.ts";
import type { PayoutComponent, PayoutSourceKind } from "@pcash/sdk/protocol";
import { planPublication, publicationOf, PADDED_PRIVATE_VALUE_BYTE_SIZE } from "./publication.ts";
import { NativeActivityReader, nativeActivityKey, type WalletNativeActivity } from "./nativeActivity.ts";
import { PcashNodeClient, samePcashIdentity, statusPcashIdentity, type StatusResult } from "@pcash/sdk/clients";
import type { PcashActionSigner } from "@pcash/sdk/eip712";
import type { MlKemKeyPair } from "@pcash/sdk/protocol";
import type { WalletProfile } from "@pcash/sdk/protocol";
import {
  assetDefinitionAssetId,
  networkConfigFromStatus,
  parseAssetDefinition,
  type AssetDefinition,
} from "@pcash/sdk/protocol";
import { PRIVATE_VALUE_PROFILES, type PrivateValueShape } from "@pcash/sdk/constants";
import { addressHex, fromHex, serialQueue, sleep } from "@pcash/sdk/utils";
import { requestPcashProfile, type PcashProfile } from "../externalIdentity.ts";
import { isPcashProfile, isSpendableWallet, missingSpendableCapability } from "../walletCapabilities.ts";
import { emptyWalletState, WALLET_DATABASE_STATE_STORE, type WalletDatabase, type WalletStateStore } from "../store.ts";
import {
  addWalletAsset,
  noteIsSpendable,
  noteStatus,
  reservedNoteCommitments,
  privateBalance,
  spendableBalance,
  storedAssetDefinition,
  walletAssetRecord,
  type WalletFileData,
  type StoredPaymentHistory,
} from "../noteStore.ts";
import { BULK_RECOVERY_OBSERVATION_SECONDS, recoveredBulkGroups, type BulkChunk, type BulkJob } from "../bulkJobs.ts";
import type { AssetTransferIntent } from "./assetTransferClient.ts";
import type { BulkJobStep } from "./bulkJobClient.ts";
import { receiveKeyHashHex, receiveKeyPairs } from "../receiveKeyring.ts";
import type {
  DurableSubmissionAdapter,
} from "./durableSubmission.ts";
import { assertPcashProfileAccount, outputScanBoundary, readyOutputScanBoundary, synchronizedThrough } from "./scan.ts";
import { watchNodeTip } from "./tipFollow.ts";
import { localReceiveKeyLookup } from "./localChain.ts";
import { retryWhileSyncConflict } from "./syncConflictRetry.ts";
import {
  createWalletRuntime,
  WalletCapabilityError,
  type WalletBulkJobStepIntent,
  type WalletTransferPreflight,
  type WalletRuntimeProvers,
} from "./walletRuntime.ts";
import {
  runWalletAction,
  walletActionName,
  type WalletAction,
} from "../walletAction.ts";
import {
  WalletEventRegistry,
  type WalletActionLifecycle,
  type WalletEventContext,
  type WalletEventListener,
  type WalletEventMap,
  type WalletEventName,
  type WalletEventWallet,
  type WalletHookListener,
  type WalletHookName,
} from "../walletEvents.ts";
import {
  NOOP_WALLET_METRICS,
  walletActionMetricType,
  type WalletMetrics,
  type WalletSyncMetricMode,
} from "../metrics.ts";

type WalletRuntimeInstance<Prepared, Output> = ReturnType<
  typeof createWalletRuntime<Prepared, Output>
>;

export interface WalletClientOptions<Prepared = unknown, Output = unknown> {
  /** Node client or RPC URL; URLs use the SDK's standard JSON-RPC client. */
  node: PcashNodeClient | string;
  provers?: Partial<WalletRuntimeProvers>;
  submission?: DurableSubmissionAdapter<Prepared, Output>;
  userAccountCreationSubmission?: DurableSubmissionAdapter<Prepared, Output>;
  settlePollIntervalMs?: number;
  settlePollMaxAttempts?: number;
  /** Local operational metrics; browser wallets default to an in-process no-op. */
  metrics?: WalletMetrics;
}

export type WalletAuthorityOptions =
  | { signer: PcashActionSigner; profile?: PcashProfile | WalletProfile }
  | { profile: PcashProfile | WalletProfile; signer?: PcashActionSigner };

type WalletOpenOptions<Prepared = unknown, Output = unknown> =
  WalletClientOptions<Prepared, Output>
  & WalletAuthorityOptions
  & {
  database: WalletDatabase;
  /** Internal pooled-database release hook installed by platform openers. */
  releaseDatabase?: () => Promise<void>;
};

/** Wallet-bound capabilities for advanced transaction clients. */
export interface WalletExecutionContext<Prepared = unknown, Output = unknown> {
  readonly node: PcashNodeClient;
  readonly store: WalletStateStore;
  readonly profile: PcashProfile | WalletProfile;
  readonly signer?: PcashActionSigner;
  readonly network: { chainId: bigint; genesisHash: string };
  /** Live node status after its chain and genesis were checked against `network`. */
  readonly status: StatusResult;
  readonly submission?: DurableSubmissionAdapter<Prepared, Output>;
  readonly settlePollIntervalMs: number;
  readonly settlePollMaxAttempts: number;
  /** Advance local chain state while waiting for a submitted action to settle. */
  synchronize(): Promise<unknown>;
  readonly lifecycle: WalletActionLifecycle;
  spendable(): this is SpendableWalletExecutionContext<Prepared, Output>;
}

export interface SpendableWalletExecutionContext<Prepared = unknown, Output = unknown>
  extends WalletExecutionContext<Prepared, Output> {
  readonly profile: PcashProfile;
  readonly signer: PcashActionSigner;
}

export interface WalletBalance {
  assetId: bigint;
  private: bigint;
  spendable: bigint;
}

/** A standard asset this wallet holds or can identify. */
export interface WalletAsset {
  assetId: bigint;
  /** Verified against `assetId`; null until a delivered or imported definition is known. */
  definition: AssetDefinition | null;
  private: bigint;
  spendable: bigint;
  /** This wallet created the asset and holds its creation material. */
  created: boolean;
}

export type WalletAssetSendIntent<Prepared = unknown, Output = unknown> = Omit<AssetTransferIntent, "burnAmount"> & {
  submission?: DurableSubmissionAdapter<Prepared, Output>;
};

export type WalletAssetBurnIntent<Prepared = unknown, Output = unknown> = Omit<AssetTransferIntent, "outputs" | "burnAmount"> & {
  amount: bigint;
  submission?: DurableSubmissionAdapter<Prepared, Output>;
};

/** A durable bulk job's progress. Recipient note secrets and chunk openings stay in the wallet. */
export interface WalletBulkJob {
  jobId: string;
  kind: BulkJob["kind"];
  assetId: bigint;
  recipients: { to: string; amount: bigint }[];
  openFeeAmounts: Record<PrivateValueShape, bigint>;
  maxTransactions: number;
  targetNotes: number;
  shape: PrivateValueShape | null;
  recovery: {
    recoveryJobId: string;
    appTag: Uint8Array;
    manifestDigest: string;
    originalRecipientCount: number;
    originalIndexes: number[];
    invalidated: boolean;
    supersededByJobId: string | null;
  } | null;
  chunks: {
    shape: PrivateValueShape;
    firstRecipient: number;
    recipientCount: number;
    contentHash: string;
    outcome: BulkChunk["outcome"];
    inclusion: { blockNumber: bigint; blockHash: string } | null;
  }[];
}

export interface WalletBulkRecoveryRecipient {
  originalIndex: number;
  recipientAddress: string;
  amount: bigint;
  noteSecret: string;
}

export interface WalletBulkRecoveryChunk {
  contentHash: string;
  shape: PrivateValueShape;
  recipients: WalletBulkRecoveryRecipient[];
  inclusion: { blockNumber: bigint; blockHash: string; blockTimestamp: bigint };
}

/** Canonical landed chunks found through sender recovery records. */
export interface WalletBulkRecovery {
  recoveryJobId: string;
  appTag: Uint8Array;
  manifestDigest: string;
  assetId: bigint;
  recipientCount: number;
  paidOriginalIndexes: number[];
  chunks: WalletBulkRecoveryChunk[];
  /** True while a local bulk job already owns this recovery lineage. */
  known: boolean;
  observedAtTimestamp: bigint | null;
  observedThroughTimestamp: bigint | null;
  resumeAfterTimestamp: bigint | null;
}

export interface WalletNativeFunds {
  private: bigint;
  spendablePrivate: bigint;
  total: bigint;
  synchronized: boolean;
  pcashNumber: bigint;
  pcashHash: string;
}

/** Where a system note came from: the payout it settled and the PCASH block that paid it. */
export interface WalletNotePayout {
  sourceKind: PayoutSourceKind;
  component: PayoutComponent;
  blockNumber: bigint;
  blockHash: string;
  /** The transaction the payout was for, or null for a poster group. */
  transactionId: string | null;
}

export interface WalletNoteSummary {
  leafIndex: bigint | null;
  outputIndex: number;
  assetId: bigint;
  amount: bigint;
  commitment: string | null;
  status: ReturnType<typeof noteStatus>;
  /** Set for system payout notes; null for notes delivered in an envelope. */
  payout: WalletNotePayout | null;
}

export interface WalletSnapshot {
  address: string;
  network: { chainId: bigint; genesisHash: string };
  syncedThrough: { pcashNumber: bigint; pcashHash: string } | null;
  finalizedThrough: { pcashNumber: bigint; pcashHash: string } | null;
  balances: WalletBalance[];
  ownedNoteCount: number;
  pendingActionCount: number;
  pendingContentHashes: string[];
  pendingPayments: WalletPendingPayment[];
  paymentHistory: WalletPaymentHistory[];
  receiveKeys: string[];
  assets: WalletAsset[];
}

interface WalletPendingPayment {
  kind: "mine" | "payment";
  contentHash: string;
  /** Original address or receive code used to construct the exact payment. */
  deliveryTarget: string;
  recipientAddress: string;
  data?: TransactionData;
  amount: bigint;
  openFeeAmount: bigint;
  privateRelayFeeAmount: bigint;
  privateRelayRecipient: string | null;
  validUntilTimestamp: bigint;
  state: "submission-unknown" | "admitted";
  /** The Ethereum transaction this wallet posted it in. */
  l1TxHash?: string;
}

export interface WalletPaymentHistory extends Omit<WalletPendingPayment, "state" | "l1TxHash"> {
  state: StoredPaymentHistory["state"];
  resolvedAtUnixMs: bigint;
  receipt?: { transactionId: string; pcashBlockNumber: bigint; pcashBlockHash: string };
}

export interface WalletNoteFilter {
  assetId?: bigint;
  status?: WalletNoteSummary["status"];
}

/** Platform construction seam for the wallet service and the PGlite host; applications use `openBrowserWallet` or `openNodeWallet`. */
export const OPEN_WALLET_INTERNAL: unique symbol = Symbol("pcash.wallet.open");

function boundary(value: WalletFileData["syncedThrough"]): {
  pcashNumber: bigint;
  pcashHash: string;
} | null {
  return value === undefined ? null : {
    pcashNumber: BigInt(value.blockNumber),
    pcashHash: value.blockHash,
  };
}

function balanceTotals(data: WalletFileData | null): Map<bigint, { private: bigint; spendable: bigint }> {
  const totals = new Map<bigint, { private: bigint; spendable: bigint }>();
  if (data === null) return totals;
  const reserved = reservedNoteCommitments(data);
  for (const note of data.notes) {
    const id = BigInt(note.assetId);
    let total = totals.get(id);
    if (total === undefined) {
      total = { private: 0n, spendable: 0n };
      totals.set(id, total);
    }
    if (note.spent || note.pending) continue;
    const amount = BigInt(note.amount);
    total.private += amount;
    if (noteIsSpendable(note, reserved)) total.spendable += amount;
  }
  return totals;
}

function balanceSummaries(data: WalletFileData | null, assetId?: bigint): WalletBalance[] {
  const totals = balanceTotals(data);
  const assets = assetId === undefined
    ? [...new Set([0n, ...totals.keys()])].sort(
        (a, b) => a < b ? -1 : a > b ? 1 : 0,
      )
    : [assetId];
  return assets.map((id) => ({
    assetId: id,
    private: totals.get(id)?.private ?? 0n,
    spendable: totals.get(id)?.spendable ?? 0n,
  }));
}

function assetSummaries(data: WalletFileData | null): WalletAsset[] {
  const totals = balanceTotals(data);
  const ids = [...new Set([
    ...(data?.assets ?? []).map((asset) => BigInt(asset.assetId)),
    ...totals.keys(),
  ])].filter((id) => id !== 0n).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  return ids.map((assetId) => {
    const record = walletAssetRecord(data, assetId);
    return {
      assetId,
      definition: record === undefined ? null : storedAssetDefinition(record),
      private: totals.get(assetId)?.private ?? 0n,
      spendable: totals.get(assetId)?.spendable ?? 0n,
      created: record?.assetSecret !== undefined,
    };
  });
}

function bulkJobSummary(job: BulkJob): WalletBulkJob {
  return {
    jobId: job.jobId,
    kind: job.kind,
    assetId: BigInt(job.assetId),
    recipients: job.recipients.map((recipient) => ({ to: recipient.to, amount: BigInt(recipient.amount) })),
    openFeeAmounts: {
      [PRIVATE_VALUE_PROFILES.S.shapeId]: BigInt(job.openFeeAmounts[PRIVATE_VALUE_PROFILES.S.shapeId]),
      [PRIVATE_VALUE_PROFILES.L.shapeId]: BigInt(job.openFeeAmounts[PRIVATE_VALUE_PROFILES.L.shapeId]),
    },
    maxTransactions: job.maxTransactions,
    targetNotes: job.targetNotes,
    shape: job.shape ?? null,
    recovery: job.recovery === undefined ? null : {
      recoveryJobId: job.recovery.recoveryJobId,
      appTag: fromHex(job.recovery.appTag),
      manifestDigest: job.recovery.manifestDigest,
      originalRecipientCount: job.recovery.originalRecipientCount,
      originalIndexes: [...job.recovery.originalIndexes],
      invalidated: job.recovery.invalidated === true,
      supersededByJobId: job.recovery.supersededByJobId ?? null,
    },
    chunks: job.chunks.map((chunk) => ({
      shape: chunk.shape,
      firstRecipient: chunk.firstRecipient,
      recipientCount: chunk.recipientCount,
      contentHash: chunk.action.contentHash,
      outcome: chunk.outcome,
      inclusion: chunk.inclusion === undefined ? null
        : { blockNumber: BigInt(chunk.inclusion.blockNumber), blockHash: chunk.inclusion.blockHash },
    })),
  };
}

function pendingContentHashes(data: WalletFileData | null): string[] {
  return [...new Set([
    ...(data?.pendingNoteFundedTransfers ?? []).map((item) => item.contentHash.toLowerCase()),
    ...(data?.pendingAssetActions ?? []).map((item) => item.contentHash.toLowerCase()),
    ...(data?.pendingUserAccountCreations ?? []).map((item) => item.contentHash.toLowerCase()),
    ...(data?.pendingUserAccountUpdates ?? []).map((item) => item.contentHash.toLowerCase()),
    ...(data?.mempoolOutbox ?? []).map((item) => item.contentHash.toLowerCase()),
  ])].sort();
}

function pendingActionCount(data: WalletFileData | null): number {
  return pendingContentHashes(data).length;
}

function pendingPayments(data: WalletFileData | null): WalletPendingPayment[] {
  const outbox = new Map((data?.mempoolOutbox ?? []).map((entry) => [entry.contentHash.toLowerCase(), entry.state]));
  return (data?.pendingNoteFundedTransfers ?? []).map((payment) => ({
    kind: payment.kind,
    contentHash: payment.contentHash.toLowerCase(),
    deliveryTarget: payment.recipient,
    recipientAddress: payment.recipientAddress,
    ...(payment.data === undefined ? {} : { data: restoreTransactionData(payment.data)! }),
    amount: BigInt(payment.transferAmount),
    openFeeAmount: BigInt(payment.openFeeAmount),
    privateRelayFeeAmount: BigInt(payment.privateRelayFeeAmount),
    privateRelayRecipient: payment.privateRelayRecipient,
    validUntilTimestamp: BigInt(payment.validUntilTimestamp),
    state: outbox.get(payment.contentHash.toLowerCase()) === "admitted" ? "admitted" : "submission-unknown",
    ...(payment.l1TxHash === undefined ? {} : { l1TxHash: payment.l1TxHash }),
  }));
}

function durationSeconds(startedAtMilliseconds: number): number {
  return Math.max(0, performance.now() - startedAtMilliseconds) / 1000;
}

/**
 * One account on one PCASH network.
 *
 * The class owns orchestration and presentation; injected capabilities retain
 * custody of signing and proving. Persistence stays behind the wallet boundary.
 */
export class Wallet<Prepared = unknown, Output = unknown> {
  readonly address: string;
  readonly network: { chainId: bigint; genesisHash: string };

  readonly #database: WalletDatabase;
  readonly #node: PcashNodeClient;
  readonly #profile: PcashProfile | WalletProfile;
  readonly #signer: PcashActionSigner | undefined;
  readonly #submission: DurableSubmissionAdapter<Prepared, Output> | undefined;
  readonly #settlePollIntervalMs: number;
  readonly #settlePollMaxAttempts: number;
  readonly #store;
  readonly #nativeActivity = new NativeActivityReader();
  #nativeHistoryRecovery: Promise<unknown> | undefined;
  readonly #runtime: WalletRuntimeInstance<Prepared, Output>;
  readonly #releaseDatabase: (() => Promise<void>) | undefined;
  readonly #spendable: boolean;
  readonly #events = new WalletEventRegistry();
  readonly #metrics: WalletMetrics;
  readonly #eventWallet: WalletEventWallet;
  #accountMetricsRefresh: Promise<void> | undefined;
  #accountMetricsDirty = false;
  #latestObservedNodeTip = 0n;
  #databaseUnsubscribe: (() => Promise<void>) | undefined;
  #databaseSubscribePromise: Promise<() => Promise<void>> | undefined;
  readonly #activeOperations = new Set<Promise<unknown>>();
  readonly #withLifecycleLock = serialQueue();
  #syncPromise: ReturnType<WalletRuntimeInstance<Prepared, Output>["scan"]> | undefined;
  #syncRequestKey: string | undefined;
  #rescanRequired = false;
  #followAbort: AbortController | undefined;
  #followPromise: Promise<void> | undefined;
  #followOptions: { intervalMs?: number } | undefined;
  #scannedThrough: { pcashNumber: bigint; pcashHash: string } | undefined;
  #closePromise: Promise<void> | undefined;
  #closed = false;

  private constructor(
    options: WalletOpenOptions<Prepared, Output> & {
      node: PcashNodeClient;
      profile: PcashProfile | WalletProfile;
    },
    network: { chainId: bigint; genesisHash: string },
  ) {
    this.address = addressHex(options.profile.address);
    this.network = Object.freeze(structuredClone(network));
    this.#spendable = isSpendableWallet(options);
    this.#database = options.database;
    this.#node = options.node;
    this.#profile = options.profile;
    this.#signer = options.signer;
    this.#submission = options.submission;
    this.#settlePollIntervalMs = options.settlePollIntervalMs ?? 2000;
    this.#settlePollMaxAttempts = options.settlePollMaxAttempts ?? 150;
    this.#releaseDatabase = options.releaseDatabase;
    this.#metrics = options.metrics ?? NOOP_WALLET_METRICS;
    this.#eventWallet = Object.freeze({
      address: this.address,
      network: Object.freeze(structuredClone(this.network)),
      spendable: this.#spendable,
    });
    this.#store = options.database[WALLET_DATABASE_STATE_STORE]({ address: options.profile.address, network });
    this.#runtime = createWalletRuntime({
      node: options.node,
      chainId: network.chainId,
      wallet: options.profile,
      store: this.#store,
      ...(options.signer === undefined ? {} : { signer: options.signer }),
      ...(options.provers === undefined ? {} : { provers: options.provers }),
      ...(options.submission === undefined ? {} : { submission: options.submission }),
      ...(options.userAccountCreationSubmission === undefined
        ? {}
        : { userAccountCreationSubmission: options.userAccountCreationSubmission }),
      ...(options.settlePollIntervalMs === undefined ? {} : { settlePollIntervalMs: options.settlePollIntervalMs }),
      ...(options.settlePollMaxAttempts === undefined ? {} : { settlePollMaxAttempts: options.settlePollMaxAttempts }),
    });
  }

  static async [OPEN_WALLET_INTERNAL]<Prepared = unknown, Output = unknown>(
    options: WalletOpenOptions<Prepared, Output>,
  ): Promise<Wallet<Prepared, Output>> {
    try {
      const node = typeof options.node === "string" ? new PcashNodeClient(options.node) : options.node;
      const status = await node.status();
      if (options.profile === undefined && options.signer === undefined) {
        throw new Error("wallet open requires a signer or restored profile");
      }
      const profile = options.profile
        ?? await requestPcashProfile(options.signer!, networkConfigFromStatus(status));
      if (options.signer !== undefined && options.signer.address !== profile.address) {
        throw new Error("wallet signer does not match the wallet profile address");
      }
      const wallet = new Wallet({ ...options, node, profile }, {
        chainId: BigInt(status.pcashChainId),
        genesisHash: status.genesisHash.toLowerCase(),
      });
      // A populated store is identity-checked before the instance is exposed.
      // Empty stores are bound by construction and initialized on sync.
      const data = await wallet.#store.load();
      await wallet.#runtime.recordJournaledL1Hashes();
      wallet.#rescanRequired = data?.fullRescanRequired === true;
      wallet.#latestObservedNodeTip = status.latestBlock;
      wallet.#recordAccountMetrics(data);
      return wallet;
    } catch (error) {
      // A wallet that never opened returns the database its opener leased for it.
      await options.releaseDatabase?.();
      throw error;
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("wallet is closed");
  }

  /** Whether this Wallet has both a recoverable profile and its live signer. */
  spendable(): boolean {
    return this.#spendable;
  }

  #requireSpendable(action: string): void {
    if (this.spendable()) return;
    throw new WalletCapabilityError(missingSpendableCapability({
      profile: this.#profile,
      signer: this.#signer,
    })!, action);
  }

  #eventContext(): WalletEventContext {
    return Object.freeze({ wallet: this.#eventWallet });
  }

  #emit<Name extends WalletEventName>(name: Name, event: WalletEventMap[Name]): void {
    this.#events.emit(name, event);
  }

  #recordMetric(record: () => void): void {
    try {
      record();
    } catch {
      // Instrumentation is observational and cannot change wallet outcomes.
    }
  }

  #recordAccountMetrics(data: WalletFileData | null): void {
    this.#recordMetric(() => this.#metrics.recordAccountState({
      account: this.address,
      scanCursor: data?.syncedThrough === undefined ? null : BigInt(data.syncedThrough.blockNumber),
      nodeTip: this.#latestObservedNodeTip,
      finalizedCursor: data?.finalizedThrough === undefined ? null : BigInt(data.finalizedThrough.blockNumber),
      noteCount: data?.notes.length ?? 0,
      pendingActionCount: pendingActionCount(data),
      receiveKeyCount: data === null ? 0 : receiveKeyPairs(data).length,
    }));
  }

  #observeNodeTip(nodeTip: bigint): void {
    this.#latestObservedNodeTip = nodeTip;
    this.#scheduleAccountMetricsRefresh();
  }

  #scheduleAccountMetricsRefresh(): void {
    if (this.#metrics === NOOP_WALLET_METRICS || this.#closed) return;
    this.#accountMetricsDirty = true;
    if (this.#accountMetricsRefresh !== undefined) return;
    const refresh = this.#track((async () => {
      try {
        while (this.#accountMetricsDirty) {
          this.#accountMetricsDirty = false;
          this.#recordAccountMetrics(await this.#store.load());
        }
      } catch {
        // A metrics refresh does not add a new failure mode to wallet work.
      }
    })());
    this.#accountMetricsRefresh = refresh;
    const finished = () => {
      if (this.#accountMetricsRefresh !== refresh) return;
      this.#accountMetricsRefresh = undefined;
      if (this.#accountMetricsDirty) this.#scheduleAccountMetricsRefresh();
    };
    void refresh.then(finished, finished);
  }

  #track<T>(operation: Promise<T>): Promise<T> {
    this.#activeOperations.add(operation);
    void operation.then(
      () => this.#activeOperations.delete(operation),
      () => this.#activeOperations.delete(operation),
    );
    return operation;
  }

  #trackedOperation<T>(operation: () => Promise<T>): Promise<T> {
    this.#assertOpen();
    return this.#track(Promise.resolve().then(operation));
  }

  async #emitSnapshot(): Promise<void> {
    if (this.#closed || this.#events.count("snapshot") === 0) return;
    try {
      this.#emit("snapshot", {
        ...this.#eventContext(),
        snapshot: await this.snapshot(),
      });
    } catch {
      // A concurrent close or transient read cannot poison notifications.
    }
  }

  /** Register a non-blocking observer. Listener failures never affect wallet work. */
  on<Name extends WalletEventName>(
    name: Name,
    listener: WalletEventListener<Name>,
  ): () => Promise<void> {
    this.#assertOpen();
    const remove = this.#events.on(name, listener);
    let active = true;
    if (name === "snapshot") {
      const setup = this.#ensureSnapshotSubscription()
        .then(() => this.#emitSnapshot())
        .catch((cause) => {
          const error = cause instanceof Error ? cause : new Error(String(cause));
          this.#emit("sync:error", { ...this.#eventContext(), error });
        });
      void this.#track(setup);
    }
    return () => {
      if (!active) return Promise.resolve();
      active = false;
      remove();
      return name === "snapshot"
        ? this.#track(this.#stopSnapshotSubscription())
        : Promise.resolve();
    };
  }

  /** Register an awaited lifecycle barrier. Hook failures abort the action. */
  hook<Name extends WalletHookName>(
    name: Name,
    listener: WalletHookListener<Name>,
  ): () => void {
    this.#assertOpen();
    return this.#events.hook(name, listener);
  }

  async #ensureSnapshotSubscription(): Promise<void> {
    if (this.#databaseSubscribePromise === undefined) {
      const subscribing = this.#database.subscribe(
        { address: this.#profile.address, network: this.network },
        () => void this.#emitSnapshot(),
      );
      this.#databaseSubscribePromise = subscribing;
      try {
        this.#databaseUnsubscribe = await subscribing;
      } catch (error) {
        if (this.#databaseSubscribePromise === subscribing) {
          this.#databaseSubscribePromise = undefined;
        }
        throw error;
      }
    } else {
      await this.#databaseSubscribePromise;
    }
  }

  async #stopSnapshotSubscription(): Promise<void> {
    await this.#databaseSubscribePromise?.catch(() => undefined);
    if (this.#events.count("snapshot") !== 0 || this.#databaseUnsubscribe === undefined) return;
    const unsubscribe = this.#databaseUnsubscribe;
    this.#databaseUnsubscribe = undefined;
    this.#databaseSubscribePromise = undefined;
    await unsubscribe();
  }

  balances(options: { assetId?: bigint } = {}): Promise<WalletBalance[]> {
    return this.#trackedOperation(async () => {
      const data = await this.#store.load();
      return balanceSummaries(data, options.assetId);
    });
  }

  /** Native PCASH held in ordinary notes at the synchronized boundary. */
  nativeFunds(): Promise<WalletNativeFunds> {
    return this.#trackedOperation(async () => {
      const [data, status] = await Promise.all([this.#store.load(), this.#node.status()]);
      if (!samePcashIdentity(statusPcashIdentity(status), this.network)) throw new Error("wallet node no longer matches the bound network");
      const privateAmount = privateBalance(data, 0n);
      // With no readable scan boundary, the canonical tip is still the node's head to report.
      const scanBoundary = readyOutputScanBoundary(status);
      return {
        private: privateAmount, spendablePrivate: spendableBalance(data, 0n), total: privateAmount,
        synchronized: synchronizedThrough(status, boundary(data?.syncedThrough)),
        pcashNumber: scanBoundary?.pcashNumber ?? status.latestBlock, pcashHash: scanBoundary?.pcashHash ?? status.latestBlockHash,
      };
    });
  }

  /** Net native inflows/outflows per canonical transaction, excluding self transfers and change. */
  nativeActivity(options: { recoverHistory?: boolean } = {}): Promise<WalletNativeActivity> {
    return this.#trackedOperation(async () => {
      let data = await this.#store.load();
      if (data?.syncedThrough === undefined) return { state: "unavailable", reason: "not-synchronized" };
      if (data.historyStartOutputIndex !== "0" && options.recoverHistory === true) {
        const recovery = this.#nativeHistoryRecovery ??= this.sync({ rescan: true, awaitFunds: true });
        try { await recovery; } finally { if (this.#nativeHistoryRecovery === recovery) this.#nativeHistoryRecovery = undefined; }
        data = await this.#store.load();
      }
      if (data === null) return { state: "unavailable", reason: "not-synchronized" };
      const key = nativeActivityKey(data);
      const result = await this.#nativeActivity.read(data, this.#store, this.#profile);
      const current = await this.#store.load();
      if (current?.syncedThrough === undefined || nativeActivityKey(current) !== key) return { state: "unavailable", reason: "stale" };
      return result.state === "ready"
        ? { ...result, pcashNumber: BigInt(current.syncedThrough.blockNumber), pcashHash: current.syncedThrough.blockHash }
        : result;
    });
  }

  notes(filter: WalletNoteFilter = {}): Promise<WalletNoteSummary[]> {
    return this.#trackedOperation(async () => {
      const data = await this.#store.load();
      if (data === null) return [];
      const reserved = reservedNoteCommitments(data);
      return data.notes
        .filter((note) => filter.assetId === undefined || BigInt(note.assetId) === filter.assetId)
        .map((note): WalletNoteSummary => ({
          leafIndex: note.leafIndex === null ? null : BigInt(note.leafIndex),
          outputIndex: note.outputIndex,
          assetId: BigInt(note.assetId),
          amount: BigInt(note.amount),
          commitment: note.commitment,
          status: noteStatus(data, note, reserved),
          payout: note.cursor?.kind === "system" && note.cursor.payout !== null
            ? {
              sourceKind: note.cursor.payout.sourceKind,
              component: note.cursor.payout.component,
              blockNumber: BigInt(note.cursor.blockNumber),
              blockHash: note.cursor.blockHash,
              transactionId: note.cursor.transactionId,
            }
            : null,
        }))
        .filter((note) => filter.status === undefined || note.status === filter.status);
    });
  }

  /**
   * Whether the synced account directory holds a published receive key for
   * this address, so a payment to the bare address can be delivered.
   */
  hasReceiveKey(address: string): Promise<boolean> {
    return this.#trackedOperation(async () => await localReceiveKeyLookup(this.#store)(address) !== null);
  }

  receiveKeys(): Promise<string[]> {
    return this.#trackedOperation(async () => {
      const data = await this.#store.load();
      return data === null ? [] : receiveKeyPairs(data).map((pair) => receiveKeyHashHex(pair));
    });
  }

  /**
   * Report whether the synced account set holds this profile's account and it
   * matches the profile. The lookup is local. An account is never removed, so
   * only a wallet that has not yet seen it synchronizes first.
   */
  defaultAccountReady(): Promise<boolean> {
    return this.#trackedOperation(async () => {
      if (!isPcashProfile(this.#profile)) throw new Error("account readiness requires a reference PCASH profile");
      const profile = this.#profile;
      if (await this.#store.readChain((chain) => chain?.accountResult(this.address) ?? null) === null) await this.#scan();
      return (await assertPcashProfileAccount(this.#store, profile, await this.#node.status())) !== null;
    });
  }

  receiveCode(): Promise<Awaited<ReturnType<WalletRuntimeInstance<Prepared, Output>["code"]>>> {
    return this.#trackedOperation(() => this.#runtime.code());
  }

  snapshot(): Promise<WalletSnapshot> {
    return this.#trackedOperation(async () => {
      const data = await this.#store.load();
      const balances = balanceSummaries(data);
      return {
        address: this.address,
        network: this.network,
        syncedThrough: boundary(data?.syncedThrough),
        finalizedThrough: boundary(data?.finalizedThrough),
        balances,
      ownedNoteCount: data?.notes.length ?? 0,
      pendingActionCount: pendingActionCount(data),
      pendingContentHashes: pendingContentHashes(data),
      pendingPayments: pendingPayments(data),
      paymentHistory: (data?.paymentHistory ?? []).map((entry) => ({
        kind: entry.kind,
        contentHash: entry.contentHash,
        deliveryTarget: entry.recipient,
        recipientAddress: entry.recipientAddress,
        ...(entry.data === undefined ? {} : { data: restoreTransactionData(entry.data)! }),
        amount: BigInt(entry.transferAmount),
        openFeeAmount: BigInt(entry.openFeeAmount),
        privateRelayFeeAmount: BigInt(entry.privateRelayFeeAmount),
        privateRelayRecipient: entry.privateRelayRecipient,
        validUntilTimestamp: BigInt(entry.validUntilTimestamp),
        resolvedAtUnixMs: BigInt(entry.resolvedAtUnixMs),
        state: entry.state,
        ...(entry.receipt === undefined ? {} : { receipt: {
          ...entry.receipt,
          pcashBlockNumber: BigInt(entry.receipt.pcashBlockNumber),
        } }),
      })),
      receiveKeys: data === null ? [] : receiveKeyPairs(data).map((pair) => receiveKeyHashHex(pair)),
      assets: assetSummaries(data),
      };
    });
  }

  /** Standard assets this wallet holds or has a verified definition for. */
  assets(): Promise<WalletAsset[]> {
    return this.#trackedOperation(async () => assetSummaries(await this.#store.load()));
  }

  /** Verify a shared definition (text, link, or value) against the assetId it derives, and keep it. */
  importAssetDefinition(input: AssetDefinition | string): Promise<{ assetId: bigint }> {
    return this.#trackedOperation(async () => {
      const definition = typeof input === "string" ? parseAssetDefinition(input) : input;
      const assetId = assetDefinitionAssetId(definition);
      await this.#store.transaction((current) => {
        const data = current ?? emptyWalletState({ address: this.#profile.address, network: this.network });
        addWalletAsset(data, { assetId, definition });
        return { data, value: undefined };
      });
      return { assetId };
    });
  }

  bulkJobs(): Promise<WalletBulkJob[]> {
    return this.#trackedOperation(async () => ((await this.#store.load())?.bulkJobs ?? []).map(bulkJobSummary));
  }

  bulkRecoveries(): Promise<WalletBulkRecovery[]> {
    return this.#trackedOperation(async () => {
      const data = await this.#store.load();
      if (data === null) return [];
      const observations = new Map((data.bulkRecoveryObservations ?? []).map(observation => [observation.recoveryJobId, observation]));
      const groups = recoveredBulkGroups(data.sentOutputs ?? []);
      const activeLocal = (recoveryJobId: string, canonical: ReadonlySet<string>) => (data.bulkJobs ?? []).some(job => {
        if (job.recovery?.recoveryJobId !== recoveryJobId || job.recovery.invalidated === true
          || job.recovery.supersededByJobId !== undefined) return false;
        const baseline = job.recovery.baselineContentHashes;
        return baseline === undefined || baseline.every(contentHash => canonical.has(contentHash.toLowerCase()));
      });
      const summaries = groups.map(group => {
        const observation = observations.get(group.recoveryJobId);
        const observedAtTimestamp = observation === undefined ? null : BigInt(observation.observedAtTimestamp);
        const canonical = new Set(group.chunks.map(chunk => chunk.contentHash.toLowerCase()));
        return {
          recoveryJobId: group.recoveryJobId,
          appTag: Uint8Array.from(group.appTag),
          manifestDigest: group.manifestDigest,
          assetId: BigInt(group.assetId),
          recipientCount: group.originalRecipientCount,
          paidOriginalIndexes: [...group.paidOriginalIndexes],
          chunks: group.chunks.map(chunk => ({
            contentHash: chunk.contentHash,
            shape: chunk.shape,
            recipients: chunk.recipients.map(recipient => ({ ...recipient, amount: BigInt(recipient.amount) })),
            inclusion: { blockNumber: BigInt(chunk.inclusion.blockNumber), blockHash: chunk.inclusion.blockHash,
              blockTimestamp: BigInt(chunk.inclusion.blockTimestamp) },
          })),
          known: activeLocal(group.recoveryJobId, canonical),
          observedAtTimestamp,
          observedThroughTimestamp: observation === undefined ? null : BigInt(observation.observedThroughTimestamp),
          resumeAfterTimestamp: observedAtTimestamp === null ? null : observedAtTimestamp + BULK_RECOVERY_OBSERVATION_SECONDS,
        };
      });
      const groupedIds = new Set(groups.map(group => group.recoveryJobId));
      const syntheticIds = new Set<string>();
      for (const job of data.bulkJobs ?? []) {
        const recovery = job.recovery;
        if (recovery?.invalidated !== true || groupedIds.has(recovery.recoveryJobId) || syntheticIds.has(recovery.recoveryJobId)) continue;
        syntheticIds.add(recovery.recoveryJobId);
        const observation = observations.get(recovery.recoveryJobId);
        const observedAtTimestamp = observation === undefined ? null : BigInt(observation.observedAtTimestamp);
        summaries.push({
          recoveryJobId: recovery.recoveryJobId, appTag: Uint8Array.from(fromHex(recovery.appTag)), manifestDigest: recovery.manifestDigest,
          assetId: BigInt(job.assetId), recipientCount: recovery.originalRecipientCount,
          paidOriginalIndexes: [], chunks: [], known: activeLocal(recovery.recoveryJobId, new Set()),
          observedAtTimestamp,
          observedThroughTimestamp: observation === undefined ? null : BigInt(observation.observedThroughTimestamp),
          resumeAfterTimestamp: observedAtTimestamp === null ? null : observedAtTimestamp + BULK_RECOVERY_OBSERVATION_SECONDS,
        });
      }
      return summaries.sort((left, right) => left.recoveryJobId.localeCompare(right.recoveryJobId));
    });
  }

  sync(options: { rescan?: boolean; anchorAtCurrentBoundary?: boolean; awaitFunds?: boolean } = {}): Promise<
    Awaited<ReturnType<WalletRuntimeInstance<Prepared, Output>["scan"]>>
  > {
    return this.#trackedOperation(() => this.#withLifecycleLock(async () => {
      const catchUp = async (initial: { anchorAtCurrentBoundary?: boolean } = {}) => {
        let latest = await this.#scan(initial);
        if (options.awaitFunds !== true) return latest;
        // The head can advance during scanning, so a caller that
        // must observe synchronized funds scans up to twice more. Anchor and
        // full-replay modes apply only to the first scan; catch-up is incremental.
        for (let attempt = 0; attempt < 2; attempt += 1) {
          if ((await this.nativeFunds()).synchronized) return latest;
          latest = await this.#scan();
        }
        if ((await this.nativeFunds()).synchronized) return latest;
        throw new Error("Wallet balance could not catch up to the current PCASH block.");
      };
      if (options.rescan === true || options.anchorAtCurrentBoundary === true) {
        return this.#withFollowingPaused(() => {
          if (options.rescan === true) this.#rescanRequired = true;
          return catchUp(options.anchorAtCurrentBoundary === true
            ? { anchorAtCurrentBoundary: true }
            : {});
        });
      }
      // A caller asking to catch up gets a scan begun after any scan it
      // observed in flight, so the result reflects a fresh node tip.
      await this.#syncPromise?.catch(() => undefined);
      return catchUp();
    }));
  }

  async #scan(options: {
    target?: { pcashNumber: bigint; pcashHash: string };
    /** The status `target` was read from, so the scan need not read it again. */
    status?: StatusResult;
    anchorAtCurrentBoundary?: boolean;
  } = {}): Promise<Awaited<ReturnType<WalletRuntimeInstance<Prepared, Output>["scan"]>>> {
    const rescan = this.#rescanRequired;
    const requestKey = options.anchorAtCurrentBoundary === true
      ? "anchor:tip"
      : rescan
      ? options.target === undefined
        ? "rescan:tip"
        : `rescan:${options.target.pcashNumber}:${options.target.pcashHash.toLowerCase()}`
      : options.target === undefined
        ? "tip"
        : `${options.target.pcashNumber}:${options.target.pcashHash.toLowerCase()}`;
    if (this.#syncPromise !== undefined) {
      if (this.#syncRequestKey === requestKey) return this.#syncPromise;
      await this.#syncPromise.catch(() => undefined);
      return this.#scan(options);
    }
    this.#emit("sync:started", this.#eventContext());
    const metricMode: WalletSyncMetricMode = rescan ? "full" : "incremental";
    const metricContext = { account: this.address, mode: metricMode };
    const startedAtMilliseconds = performance.now();
    this.#recordMetric(() => this.#metrics.recordSyncStarted(metricContext));
    const running = retryWhileSyncConflict(() => this.#runtime.scan({
      ...(rescan ? { rescan: true } : {}),
      ...(options.anchorAtCurrentBoundary === true ? { anchorAtCurrentBoundary: true } : {}),
      ...(options.target === undefined ? {} : { target: options.target }),
      ...(options.status === undefined ? {} : { status: options.status }),
      onProgress: (progress) => this.#emit("sync:progress", {
        ...this.#eventContext(),
        phase: progress.phase,
        ...(progress.syncedThrough === undefined ? {} : {
          syncedThrough: Object.freeze(structuredClone(progress.syncedThrough)),
        }),
      }),
      onNodeTip: (nodeTip) => this.#observeNodeTip(nodeTip),
    }));
    this.#syncPromise = running;
    this.#syncRequestKey = requestKey;
    try {
      const result = await running;
      if (rescan) this.#rescanRequired = false;
      this.#scannedThrough = result.syncedThrough;
      this.#emit("sync:completed", {
        ...this.#eventContext(),
        syncedThrough: Object.freeze(structuredClone(result.syncedThrough)),
      });
      this.#recordMetric(() => this.#metrics.recordSyncFinished({
        ...metricContext,
        outcome: "success",
        durationSeconds: durationSeconds(startedAtMilliseconds),
        outputsScanned: result.scanned,
        trialDecryptAttempts: result.trialDecryptAttempts,
        decryptions: result.decrypted,
        recoveredNotes: result.recovered.length,
      }));
      this.#recordAccountMetrics(result.data);
      return result;
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      this.#emit("sync:error", { ...this.#eventContext(), error });
      this.#recordMetric(() => this.#metrics.recordSyncFinished({
        ...metricContext,
        outcome: "error",
        durationSeconds: durationSeconds(startedAtMilliseconds),
        outputsScanned: 0,
        trialDecryptAttempts: 0,
        decryptions: 0,
        recoveredNotes: 0,
      }));
      this.#scheduleAccountMetricsRefresh();
      throw error;
    } finally {
      if (this.#syncPromise === running) {
        this.#syncPromise = undefined;
        this.#syncRequestKey = undefined;
      }
    }
  }

  async preflightSend(
    intent: Omit<Parameters<WalletRuntimeInstance<Prepared, Output>["preflightTransfer"]>[0], "kind">,
  ): Promise<Awaited<ReturnType<WalletRuntimeInstance<Prepared, Output>["preflightTransfer"]>>> {
    intent = { ...intent, ...(intent.data === undefined ? {} : { data: structuredClone(intent.data) }) };
    return this.#trackedOperation(async () => {
      await this.#scan();
      try { return await this.#runtime.preflightTransfer({ ...intent, kind: "payment" }); }
      catch (error) {
        if (error instanceof InsufficientNotesError && error.totalBalance >= error.need) {
          throw new ConsolidationRequiredError(await this.planConsolidation({
            amount: error.need,
            ...(intent.openFeeAmount === undefined ? {} : { openFeeAmount: intent.openFeeAmount }),
            ...(intent.submission === undefined ? {} : { submission: intent.submission }),
          }));
        }
        throw error;
      }
    });
  }

  startSync(options: { intervalMs?: number; rescan?: boolean } = {}): void {
    this.#assertOpen();
    if (options.rescan === true) this.#rescanRequired = true;
    if (this.#followPromise !== undefined) return;
    const controller = new AbortController();
    this.#followAbort = controller;
    this.#followOptions = options.intervalMs === undefined ? {} : { intervalMs: options.intervalMs };
    const run = async () => {
      while (!controller.signal.aborted) {
        try {
          await this.#scan();
          if (controller.signal.aborted) return;
          await watchNodeTip(this.#node, {
            ...(options.intervalMs === undefined ? {} : { intervalMs: options.intervalMs }),
            signal: controller.signal,
            onTip: async (status) => {
              this.#observeNodeTip(status.latestBlock);
              this.#emit("sync:tip", { ...this.#eventContext(), status });
              const target = outputScanBoundary(status);
              // The tip moves before the index that serves outputs catches up.
              // Until it does, a scan reads nothing new unless pending actions
              // are waiting on receipts at the new tip.
              const scanned = this.#scannedThrough;
              if (!this.#rescanRequired && scanned !== undefined && scanned.pcashNumber === target.pcashNumber
                && scanned.pcashHash.toLowerCase() === target.pcashHash.toLowerCase()
                && pendingActionCount(await this.#store.load()) === 0) return;
              await this.#scan({ target, status });
            },
          });
        } catch (cause) {
          if (controller.signal.aborted) return;
          const error = cause instanceof Error ? cause : new Error(String(cause));
          this.#emit("sync:error", { ...this.#eventContext(), error });
          // sleep rejects only when the follow is stopped; the loop then exits.
          await sleep(options.intervalMs ?? 2000, controller.signal).catch(() => undefined);
        }
      }
    };
    const promise = run().finally(() => {
      if (this.#followPromise === promise) {
        this.#followPromise = undefined;
        this.#followAbort = undefined;
        this.#followOptions = undefined;
      }
    });
    this.#followPromise = promise;
  }

  async stopSync(): Promise<void> {
    const promise = this.#followPromise;
    this.#followAbort?.abort();
    if (promise !== undefined) await promise;
  }

  /** Local canonical records for this wallet. Sync first. */
  async transactionData(options: { limit?: number; offset?: number; schema?: string } = {}): Promise<WalletTransactionRecords[]> {
    const limit = options.limit ?? 100, offset = options.offset ?? 0;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000 || !Number.isSafeInteger(offset) || offset < 0) throw new Error("invalid transaction data pagination");
    const data = await this.#store.load();
    const records = (items: StoredTransactionRecords["self"]): DataRecord[] => items.map(({ schema, data }) => ({ schema, data: fromHex(data) }));
    return (data?.transactionRecords ?? []).filter(row => options.schema === undefined || [
      ...row.self, ...row.public, ...row.received.flatMap(group => group.records), ...row.sent.flatMap(group => group.records),
    ].some(record => record.schema === options.schema)).sort((a, b) => BigInt(a.leafIndex) < BigInt(b.leafIndex) ? -1 : 1).slice(offset, offset + limit).map(row => ({
      ...row, self: records(row.self), public: records(row.public),
      received: row.received.map(group => ({ ...group, records: records(group.records) })),
      sent: row.sent.map(group => ({ ...group, records: records(group.records) })),
    }));
  }

  /** Publish transaction data without creating a recipient payment. */
  publishData(intent: Omit<Parameters<WalletRuntimeInstance<Prepared, Output>["transfer"]>[0], "to" | "amount" | "kind" | "expectedReview">,
    review?: WalletTransferPreflight): Promise<Awaited<ReturnType<WalletRuntimeInstance<Prepared, Output>["transfer"]>>> {
    return this.send({ ...intent, to: this.address, amount: 0n }, review);
  }

  async send(
    intent: Omit<Parameters<WalletRuntimeInstance<Prepared, Output>["transfer"]>[0], "expectedReview" | "kind">,
    review?: WalletTransferPreflight,
  ): Promise<Awaited<ReturnType<WalletRuntimeInstance<Prepared, Output>["transfer"]>>> {
    // Capture caller-owned buffers before synchronization or lifecycle callbacks.
    intent = { ...intent, ...(intent.data === undefined ? {} : { data: structuredClone(intent.data) }) };
    return this.#action("send", (lifecycle) => {
      this.#requireSpendable("send");
      return this.#runtime.transfer({
        ...intent,
        kind: "payment",
        ...(review === undefined ? {} : { expectedReview: review }),
        ...lifecycle.durableCallbacks(intent),
      });
    });
  }

  async preflightMine(
    intent: Pick<Parameters<WalletRuntimeInstance<Prepared, Output>["preflightTransfer"]>[0], "submission" | "retryContentHash" | "newAction"> = {},
  ): Promise<WalletTransferPreflight> {
    return this.#trackedOperation(async () => {
      const submission = intent.submission ?? this.#submission;
      if (submission?.mode !== "l1") throw new Error("Mining requires self-publication on L1.");
      await this.#scan();
      return this.#runtime.preflightTransfer({
        submission, kind: "mine", to: this.address, amount: 0n,
        shape: PRIVATE_VALUE_PROFILES.S.shapeId, openFeeAmount: 0n,
        ...(intent.retryContentHash === undefined ? {} : { retryContentHash: intent.retryContentHash }),
        ...(intent.newAction === undefined ? {} : { newAction: intent.newAction }),
      });
    });
  }

  async mine(
    intent: Pick<Parameters<WalletRuntimeInstance<Prepared, Output>["transfer"]>[0],
      "submission" | "retryContentHash" | "newAction" | "signal" | "onProgress" | "onPrepared" | "beforeJournal" | "nowUnixMilliseconds"> = {},
    review?: WalletTransferPreflight,
  ): Promise<Awaited<ReturnType<WalletRuntimeInstance<Prepared, Output>["transfer"]>>> {
    return this.#action("mine", (lifecycle) => {
      this.#requireSpendable("mine");
      const submission = intent.submission ?? this.#submission;
      if (submission?.mode !== "l1") throw new Error("Mining requires self-publication on L1.");
      return this.#runtime.transfer({
        submission, kind: "mine", to: this.address, amount: 0n,
        shape: PRIVATE_VALUE_PROFILES.S.shapeId, openFeeAmount: 0n,
        ...(intent.retryContentHash === undefined ? {} : { retryContentHash: intent.retryContentHash }),
        ...(intent.newAction === undefined ? {} : { newAction: intent.newAction }),
        ...(intent.signal === undefined ? {} : { signal: intent.signal }),
        ...(review === undefined ? {} : { expectedReview: review }),
        ...lifecycle.durableCallbacks(intent),
      });
    });
  }

  async mineBatch(intent: Parameters<WalletRuntimeInstance<Prepared, Output>["mineBatch"]>[0]) {
    return this.#action("mine", (lifecycle) => this.#runtime.mineBatch({
      ...intent, ...lifecycle.durableCallbacks(intent),
    }));
  }

  /** The fee every merge carries: the caller's, else the default for the publication path. */
  async #consolidationFee(openFeeAmount: bigint | undefined, submission: Pick<DurableSubmissionAdapter, "mode">): Promise<bigint> {
    const plan = await planPublication({
      qualifying: true, byteSize: PADDED_PRIVATE_VALUE_BYTE_SIZE, openFeeAmount, publication: publicationOf(submission), node: this.#node,
    });
    return plan.openFeeAmount;
  }

  /**
   * A self-published merge names this wallet's own commitment, so its fee and
   * any issuance return as one more native note; a relayed merge pays its publisher.
   */
  async planConsolidation(options: {
    amount?: bigint;
    openFeeAmount?: bigint;
    submission?: Pick<DurableSubmissionAdapter, "mode">;
  } = {}) {
    const submission = options.submission ?? this.#submission ?? { mode: "mempool" };
    const notes = await this.notes({ assetId: 0n, status: "spendable" });
    const openFeeAmount = await this.#consolidationFee(options.openFeeAmount, submission);
    return planNativeConsolidation(notes.map((note) => note.amount), openFeeAmount, options.amount, { issuanceNote: publicationOf(submission) === "self" });
  }

  /** Create a fixed-supply asset with registered authorization and no native funding. */
  createAsset(intent: Parameters<WalletRuntimeInstance<Prepared, Output>["assetCreation"]>[0]): Promise<Awaited<ReturnType<WalletRuntimeInstance<Prepared, Output>["assetCreation"]>>> {
    return this.#action("asset-creation", (lifecycle) => {
      this.#requireSpendable("asset-creation");
      return this.#runtime.assetCreation({ ...intent, ...lifecycle.durableCallbacks(intent) });
    });
  }

  /** Pay recipients in one S action: one under the asset-payment rule, several as a batch transfer. Longer lists are bulk jobs. */
  sendAsset(intent: WalletAssetSendIntent<Prepared, Output>): Promise<Awaited<ReturnType<WalletRuntimeInstance<Prepared, Output>["assetTransfer"]>>> {
    intent = { ...intent, outputs: structuredClone(intent.outputs),
      ...(intent.data === undefined ? {} : { data: structuredClone(intent.data) }) };
    return this.#action("asset-send", (lifecycle) => {
      this.#requireSpendable("asset-send");
      return this.#runtime.assetTransfer({ ...intent, ...lifecycle.durableCallbacks(intent) });
    });
  }

  /** Privately burn `amount` of an asset this wallet holds. */
  burnAsset(intent: WalletAssetBurnIntent<Prepared, Output>): Promise<Awaited<ReturnType<WalletRuntimeInstance<Prepared, Output>["assetTransfer"]>>> {
    intent = { ...intent, ...(intent.data === undefined ? {} : { data: structuredClone(intent.data) }) };
    return this.#action("asset-burn", (lifecycle) => {
      this.#requireSpendable("asset-burn");
      const { amount, ...rest } = intent;
      return this.#runtime.assetTransfer({ ...rest, outputs: [], burnAmount: amount, ...lifecycle.durableCallbacks(intent) });
    });
  }

  /** Approve a durable payment or consolidation job; every recipient is resolved before any proof. */
  startBulkJob(intent: Parameters<WalletRuntimeInstance<Prepared, Output>["startBulkJob"]>[0]): Promise<WalletBulkJob> {
    return this.#action("bulk", async () => bulkJobSummary(await this.#runtime.startBulkJob(intent)));
  }

  /** Prove and submit one chunk, or resume the first unresolved one. S chunks prove anywhere; L needs native proving. */
  runBulkJobStep(intent: WalletBulkJobStepIntent<Prepared, Output>): Promise<BulkJobStep> {
    return this.#action("bulk", (lifecycle) => {
      this.#requireSpendable("bulk");
      return this.#runtime.runBulkJobStep({ ...intent, ...lifecycle.durableCallbacks(intent) });
    });
  }

  /** Publish a contract account, paying its creation fee from this wallet's notes. */
  async sponsorContractCreation(
    intent: Parameters<WalletRuntimeInstance<Prepared, Output>["contractCreation"]>[0],
  ): Promise<Awaited<ReturnType<WalletRuntimeInstance<Prepared, Output>["contractCreation"]>>> {
    return this.#action("contract-creation", (lifecycle) => {
      this.#requireSpendable("contract-creation");
      return this.#runtime.contractCreation({
        ...intent,
        ...lifecycle.durableCallbacks(intent),
      });
    });
  }

  /**
   * Pay the open fee or selected relay output of one Contract Account's asset
   * action from this wallet's notes. The caller supplies the contract's side
   * and its application prover; this wallet signs only its fee sponsorship.
   */
  async sponsorContractAction(
    intent: Parameters<WalletRuntimeInstance<Prepared, Output>["contractSponsorship"]>[0],
  ): Promise<Awaited<ReturnType<WalletRuntimeInstance<Prepared, Output>["contractSponsorship"]>>> {
    return this.#action("contract-sponsorship", (lifecycle) => {
      this.#requireSpendable("contract-sponsorship");
      return this.#runtime.contractSponsorship({
        ...intent,
        ...lifecycle.durableCallbacks(intent),
      });
    });
  }

  async updateAccount(
    intent: Parameters<WalletRuntimeInstance<Prepared, Output>["account"]>[0] = {},
  ): Promise<Awaited<ReturnType<WalletRuntimeInstance<Prepared, Output>["account"]>>> {
    return this.#action("account", (lifecycle) => {
      this.#requireSpendable("account");
      const update = () => this.#runtime.account({
        ...intent,
        ...lifecycle.durableCallbacks(intent),
      });
      return intent.receiveKey?.operation === "replace"
        ? this.#mutateAndRescan(update)
        : update();
    });
  }

  /**
   * Run an advanced action against this wallet's identity and durable state.
   * Use `walletAction(name, callback)` to adapt an experimental operation; database
   * construction and lifecycle remain owned by Wallet.
   */
  execute<T>(action: WalletAction<T>): Promise<T> {
    let actionName: string;
    try {
      actionName = walletActionName(action);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.#action(actionName, async (lifecycle) => {
      const status = await this.#node.status();
      if (!samePcashIdentity(statusPcashIdentity(status), this.network)) {
        throw new Error("wallet node no longer matches the bound network");
      }
      this.#observeNodeTip(status.latestBlock);
      let active = true;
      const assertActive = () => {
        if (!active) throw new Error("wallet execution context is no longer active");
      };
      const track = <Value>(run: () => Promise<Value>): Promise<Value> => {
        if (!active) return Promise.reject(new Error("wallet execution context is no longer active"));
        return this.#track(Promise.resolve().then(run));
      };
      const store: WalletStateStore = {
        identity: structuredClone(this.#store.identity),
        load: () => track(() => this.#store.load()),
        save: (data, options) => track(() => this.#store.save(data, options)),
        transaction: (update) => track(() => this.#store.transaction(update)),
        readChain: (read) => track(() => this.#store.readChain(read)),
        chainStep: (step) => track(() => this.#store.chainStep(step)),
      };
      const signer = this.#signer === undefined ? undefined : {
        address: this.#signer.address,
        signTypedData: (request: Parameters<PcashActionSigner["signTypedData"]>[0]) =>
          track(() => this.#signer!.signTypedData(request)),
      };
      const submission = this.#submission === undefined ? undefined : {
        mode: this.#submission.mode,
        ...(this.#submission.preflightL1Budget === undefined ? {} : {
          preflightL1Budget: (context: Parameters<NonNullable<DurableSubmissionAdapter["preflightL1Budget"]>>[0]) =>
            track(() => this.#submission!.preflightL1Budget!(context)),
        }),
        preflight: (context: Parameters<DurableSubmissionAdapter<Prepared, Output>["preflight"]>[0]) =>
          track(() => this.#submission!.preflight(context)),
        submit: (context: Parameters<DurableSubmissionAdapter<Prepared, Output>["submit"]>[0]) =>
          track(() => this.#submission!.submit(context)),
        ...(this.#submission.isDefinitePreBroadcastError === undefined ? {} : {
          isDefinitePreBroadcastError: (error: unknown) => {
            assertActive();
            return this.#submission!.isDefinitePreBroadcastError!(error);
          },
        }),
      } satisfies DurableSubmissionAdapter<Prepared, Output> | undefined;
      const context: WalletExecutionContext<Prepared, Output> = {
        node: this.#node,
        store,
        profile: structuredClone(this.#profile),
        ...(signer === undefined ? {} : { signer }),
        network: structuredClone(this.network),
        status: structuredClone(status),
        ...(submission === undefined ? {} : { submission }),
        settlePollIntervalMs: this.#settlePollIntervalMs,
        settlePollMaxAttempts: this.#settlePollMaxAttempts,
        synchronize: () => track(() => this.#scan()),
        lifecycle,
        spendable(): this is SpendableWalletExecutionContext<Prepared, Output> {
          return isSpendableWallet(this);
        },
      };
      try {
        return await runWalletAction(action, context);
      } finally {
        active = false;
      }
    });
  }

  async accountActivation(): Promise<Awaited<ReturnType<WalletRuntimeInstance<Prepared, Output>["accountActivation"]>>> {
    return this.#trackedOperation(() => this.#runtime.accountActivation());
  }

  async prepareAccountActivation(
    intent: Parameters<WalletRuntimeInstance<Prepared, Output>["prepareAccountActivation"]>[0] = {},
  ): Promise<Awaited<ReturnType<WalletRuntimeInstance<Prepared, Output>["prepareAccountActivation"]>>> {
    const prepare = () => this.#action("account", (lifecycle) => {
      if (intent.authorizationMode !== "direct") this.#requireSpendable("account");
      return this.#runtime.prepareAccountActivation({
        ...intent,
        ...lifecycle.durableCallbacks(intent),
      });
    });
    return intent.receiveKey?.operation === "replace"
      ? this.#mutateAndRescan(prepare)
      : prepare();
  }

  async submitAccountActivation(
    onSubmitted?: Parameters<WalletRuntimeInstance<Prepared, Output>["submitAccountActivation"]>[0],
  ): Promise<Awaited<ReturnType<WalletRuntimeInstance<Prepared, Output>["submitAccountActivation"]>>> {
    return this.#action("account", () => {
      return this.#runtime.submitAccountActivation(onSubmitted);
    });
  }

  clearAccountActivation(): Promise<void> {
    return this.#trackedOperation(() => this.#runtime.clearAccountActivation());
  }

  resetAccountActivationSubmission(): Promise<void> {
    return this.#trackedOperation(() => this.#runtime.resetAccountActivationSubmission());
  }

  async createReceiveKey(): Promise<{ receiveKeyHash: string }> {
    return this.#receiveKeyAction(() => this.#runtime.createReceiveKey({ rescan: false }));
  }

  async importReceiveKey(pair: MlKemKeyPair): Promise<{ receiveKeyHash: string }> {
    return this.#receiveKeyAction(() => this.#runtime.importReceiveKey(pair, { rescan: false }));
  }

  async #receiveKeyAction(operation: () => Promise<{ receiveKeyHash: string }>): Promise<{ receiveKeyHash: string }> {
    return this.#action("receive-key", () => this.#mutateAndRescan(operation));
  }

  #mutateAndRescan<T>(operation: () => Promise<T>): Promise<T> {
    return this.#withLifecycleLock(() => this.#withFollowingPaused(async () => {
      // Set this before mutation because an action can persist a receive key
      // before a later proof or submission step fails. No later incremental
      // sync may run until one full replay succeeds.
      this.#rescanRequired = true;
      const result = await operation();
      await this.#scan();
      return result;
    }));
  }

  async #withFollowingPaused<T>(operation: () => Promise<T>): Promise<T> {
    const followOptions = this.#followPromise === undefined ? undefined : this.#followOptions;
    await this.stopSync();
    await this.#syncPromise?.catch(() => undefined);
    try {
      return await operation();
    } finally {
      if (!this.#closed && followOptions !== undefined) this.startSync(followOptions);
    }
  }

  async #action<T>(
    name: string,
    operation: (lifecycle: WalletActionLifecycle) => Promise<T>,
  ): Promise<T> {
    this.#assertOpen();
    const session = this.#events.startAction(this.#eventWallet, name);
    const metricContext = { account: this.address, action: walletActionMetricType(name) };
    const startedAtMilliseconds = performance.now();
    this.#recordMetric(() => this.#metrics.recordActionStarted(metricContext));
    try {
      // Every action builds its witnesses from the local chain state, so it
      // starts from a fresh synchronization.
      const result = await this.#track(Promise.resolve().then(async () => {
        await this.#scan();
        return operation(session.lifecycle);
      }));
      session.complete();
      this.#recordMetric(() => this.#metrics.recordActionFinished({
        ...metricContext,
        outcome: "success",
        durationSeconds: durationSeconds(startedAtMilliseconds),
      }));
      return result;
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      session.fail(error);
      this.#recordMetric(() => this.#metrics.recordActionFinished({
        ...metricContext,
        outcome: "error",
        durationSeconds: durationSeconds(startedAtMilliseconds),
      }));
      throw error;
    } finally {
      session.close();
      this.#scheduleAccountMetricsRefresh();
    }
  }

  close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    // Closing is observable before any teardown await, so no new operation can
    // enter while an owned database is being drained.
    this.#closed = true;
    this.#closePromise = this.#finishClose();
    return this.#closePromise;
  }

  async #finishClose(): Promise<void> {
    await this.stopSync();
    await this.#syncPromise?.catch(() => undefined);
    while (this.#activeOperations.size > 0) {
      await Promise.allSettled([...this.#activeOperations]);
    }
    const unsubscribe = this.#databaseUnsubscribe;
    this.#databaseUnsubscribe = undefined;
    this.#databaseSubscribePromise = undefined;
    if (unsubscribe !== undefined) await unsubscribe();
    this.#events.clear();
    await this.#releaseDatabase?.();
  }
}

export interface WalletTransactionRecords extends Omit<StoredTransactionRecords, "received" | "sent" | "self" | "public"> {
  received: { slot: number; records: DataRecord[] }[];
  sent: { slot: number; to: string; records: DataRecord[] }[];
  self: DataRecord[];
  public: DataRecord[];
}
