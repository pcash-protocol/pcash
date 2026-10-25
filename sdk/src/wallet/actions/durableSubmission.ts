// Internal exact-byte submission state machine shared by wallet action engines.

import { reconcilePendingWalletActions } from "./clientReconciliation.ts";
import { isWalletSyncConflict } from "./syncConflictRetry.ts";
import type { WalletStateStore } from "../store.ts";
import { fromHex, sleep } from "@pcash/sdk/utils";
import type { PcashNodeClient, StatusResult } from "@pcash/sdk/clients";
import type { RelayJournalRecovery } from "@pcash/sdk/relay";
import type { WalletReservation } from "../reservations.ts";
import {
  addMempoolOutboxEntry,
  markMempoolOutboxAdmitted,
  markPendingNoteFundedTransferL1Submitted,
  removeMempoolOutboxEntry,
  type MempoolOutboxEntry,
  type WalletFileData,
} from "../noteStore.ts";

export interface DurableSubmissionResult<Output = unknown> {
  accepted: boolean;
  queued: boolean;
  l1Hash?: string;
  output: Output;
}

export interface DurableSubmissionAdapter<Prepared = unknown, Output = unknown> {
  mode: "mempool" | "l1";
  /** Retain the signed action and input reservations without broadcasting it. */
  prepareOnly?: boolean;
  /** The Ethereum account that sends this adapter's L1 batches, when it is fixed. */
  l1Sender?: string;
  /** The transport journal owns whether another Ethereum submission is allowed. */
  l1Recovery?(): Promise<RelayJournalRecovery>;
  /** Check direct-L1 authority and reserve gas before an action's bytes exist. */
  preflightL1Budget?(context: {
    status: StatusResult;
    maxBatchBytes: number;
    additionalValueWei: bigint;
  }): Promise<{ address: string; maximumCostWei: bigint }>;
  preflight(context: {
    transactionBytes: Uint8Array;
    /** Required transactions carried with the primary action; dependent account setup stays ordered. */
    additionalTransactions?: readonly Uint8Array[];
    status: StatusResult;
    retry: boolean;
  }): Promise<Prepared>;
  submit(context: {
    transactionBytes: Uint8Array;
    status: StatusResult;
    retry: boolean;
    prepared: Prepared;
    /** Persist the Ethereum hash before waiting for receipts or node observation. */
    onL1Submitted?: (hash: string) => Promise<void>;
  }): Promise<DurableSubmissionResult<Output>>;
  isDefinitePreBroadcastError?(error: unknown): boolean;
}

/** Prepare several independent actions before submitting their exact bytes together. */
export function deferSubmission(adapter: DurableSubmissionAdapter): DurableSubmissionAdapter {
  return { ...adapter, prepareOnly: true, preflight: async () => undefined };
}

export class DurablePreBroadcastError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "DurablePreBroadcastError";
  }
}

function isDurablePreBroadcastError(error: unknown): boolean {
  return error instanceof DurablePreBroadcastError;
}

export type DurableSubmissionPhase = "preparing" | "proving" | "submitting" | "confirming";

export interface DurableSubmissionCallbacks {
  beforeJournal?: (contentHash: string, transactionHex: string) => void | Promise<void>;
  onPrepared?: (contentHash: string, transactionHex: string) => void | Promise<void>;
  onProgress?: (phase: DurableSubmissionPhase, message: string) => void;
  nowUnixMilliseconds?: () => number;
}

export function durableSubmissionCallbacks(
  callbacks: DurableSubmissionCallbacks,
): DurableSubmissionCallbacks {
  return {
    ...(callbacks.beforeJournal === undefined ? {} : { beforeJournal: callbacks.beforeJournal }),
    ...(callbacks.onPrepared === undefined ? {} : { onPrepared: callbacks.onPrepared }),
    ...(callbacks.onProgress === undefined ? {} : { onProgress: callbacks.onProgress }),
    ...(callbacks.nowUnixMilliseconds === undefined
      ? {}
      : { nowUnixMilliseconds: callbacks.nowUnixMilliseconds }),
  };
}

interface DurableAction {
  contentHash: string;
  transactionHex: string;
  kind: MempoolOutboxEntry["kind"];
  /** Mempool transaction kind the node reports for these exact bytes. An asset
   *  action is a private-value transaction unless it is a sponsored contract
   *  creation, which spends notes the same way but is retained as its own kind. */
  mempoolKind?: string;
}

interface UnjournaledFreshAction<Prepared> {
  retry: false;
  prepared: Prepared;
  preJournaled?: false;
  validateJournal?: () => void | Promise<void>;
  journal: () => void;
  rollback: () => void;
}

interface PreJournaledFreshAction<Prepared> {
  retry: false;
  prepared: Prepared;
  /** The exact action journal and outbox were committed with its resource fence. */
  preJournaled: true;
  rollback: () => void;
}

type FreshAction<Prepared> = UnjournaledFreshAction<Prepared> | PreJournaledFreshAction<Prepared>;

interface RetriedAction {
  retry: true;
  onCanonicalMiss?: () => void;
}

export interface DurableSubmissionOutcome<Output> {
  submission: DurableSubmissionResult<Output> | null;
  accepted: boolean;
  queued: boolean;
  settled: boolean;
  retried: boolean;
  recovered: boolean;
}

/** Poll settings for reconciling a submitted action with the derived chain. */
export interface SettlePollOptions {
  settlePollIntervalMs?: number;
  settlePollMaxAttempts?: number;
  /**
   * Advance the wallet's local chain state before each later settle attempt.
   * Reconciliation reads only that state, so without it waiting cannot
   * observe an inclusion that happened after the action's own synchronization.
   */
  synchronize?: () => Promise<unknown>;
}

/**
 * A single reconcile and no wait: the default for a direct client call, whose
 * caller decides how long to wait. `createWalletRuntime` overrides both, because
 * a long-running wallet service does want to wait for the head to catch up.
 */
const DEFAULT_SETTLE_POLL_MAX_ATTEMPTS = 1;
const DEFAULT_SETTLE_POLL_INTERVAL_MS = 1_500;

export function settlePollOptions(options: SettlePollOptions): SettlePollOptions {
  return {
    ...(options.settlePollIntervalMs === undefined
      ? {}
      : { settlePollIntervalMs: options.settlePollIntervalMs }),
    ...(options.settlePollMaxAttempts === undefined
      ? {}
      : { settlePollMaxAttempts: options.settlePollMaxAttempts }),
    ...(options.synchronize === undefined ? {} : { synchronize: options.synchronize }),
  };
}

interface SubmitDurableActionParams<Prepared, Output> extends SettlePollOptions {
  node: PcashNodeClient;
  store: WalletStateStore;
  data: WalletFileData;
  status: StatusResult;
  action: DurableAction;
  submission: DurableSubmissionAdapter<Prepared, Output>;
  reservation: WalletReservation;
  state: FreshAction<Prepared> | RetriedAction;
  callbacks?: DurableSubmissionCallbacks;

  isAccepted: () => Promise<boolean>;
  isPending: (data: WalletFileData) => boolean;
}

async function save(params: SubmitDurableActionParams<unknown, unknown>): Promise<void> {
  await params.reservation.save(params.data);
}

function hasOutbox(data: WalletFileData, contentHash: string): boolean {
  return data.mempoolOutbox?.some((item) => item.contentHash.toLowerCase() === contentHash.toLowerCase()) ?? false;
}

function addOutbox(params: SubmitDurableActionParams<unknown, unknown>): void {
  addMempoolOutboxEntry(params.data, {
    contentHash: params.action.contentHash,
    transactionHex: params.action.transactionHex,
    kind: params.action.kind,
    state: "prepared",
    createdAtUnixMs: String((params.callbacks?.nowUnixMilliseconds ?? Date.now)()),
  });
}

async function markAdmitted(
  params: SubmitDurableActionParams<unknown, unknown>,
  ensurePresent = false,
): Promise<void> {
  if (params.submission.mode !== "mempool") return;
  await params.reservation.assertActive();
  const retained = await params.store.transaction((current) => {
    if (current === null) throw new Error("wallet state disappeared while marking an admitted transaction");
    if (ensurePresent && !hasOutbox(current, params.action.contentHash)) addOutbox({ ...params, data: current });
    const present = hasOutbox(current, params.action.contentHash);
    if (present) markMempoolOutboxAdmitted(current, params.action.contentHash);
    return { data: current, value: present };
  });
  // Keep the long-running action snapshot aligned with the short transaction.
  // A concurrent scanner may already have removed the outbox after observing a
  // finalized receipt; that is successful reconciliation, not a failed edit.
  if (retained) {
    if (!hasOutbox(params.data, params.action.contentHash)) addOutbox(params);
    markMempoolOutboxAdmitted(params.data, params.action.contentHash);
  }
  else removeMempoolOutboxEntry(params.data, params.action.contentHash);
}

/** Persist the Ethereum hash of an L1-published transfer before waiting for its receipt. */
async function markL1Submitted(
  params: SubmitDurableActionParams<unknown, unknown>,
  hash: string,
): Promise<void> {
  if (params.action.kind !== "noteFundedTransfer") return;
  const retained = await params.store.transaction((current) => {
    if (current === null) throw new Error("wallet state disappeared while recording an Ethereum submission");
    return { data: current, value: markPendingNoteFundedTransferL1Submitted(current, params.action.contentHash, hash) };
  });
  // A concurrent scanner may already have retired the settled transfer.
  if (retained) markPendingNoteFundedTransferL1Submitted(params.data, params.action.contentHash, hash);
}

function exactRetained(
  retained: Awaited<ReturnType<PcashNodeClient["getMempoolTransaction"]>>,
  action: DurableAction,
): boolean {
  const expectedKind = action.mempoolKind
    ?? (action.kind === "noteFundedTransfer" || action.kind === "assetAction"
      ? "privateValue"
      : "userAccountUpdate");
  return retained !== null
    && retained.contentHash.toLowerCase() === action.contentHash.toLowerCase()
    && retained.kind === expectedKind
    && retained.rawTransaction !== null
    && retained.rawTransaction.toLowerCase() === action.transactionHex.toLowerCase();
}

type RetainedStatus = "ready" | "included_unfinalized" | "suspended";

async function retainedStatus(
  params: SubmitDurableActionParams<unknown, unknown>,
  rejectMismatch = true,
): Promise<RetainedStatus | null> {
  if (params.submission.mode !== "mempool") return null;
  const retained = await params.node.getMempoolTransaction(params.action.contentHash);
  if (retained === null) return null;
  if (!exactRetained(retained, params.action)) {
    if (!rejectMismatch) return null;
    throw new Error(`node retained different bytes or transaction kind for ${params.action.contentHash}`);
  }
  const status = retained.status.toLowerCase();
  if (status !== "ready" && status !== "included_unfinalized" && status !== "suspended") {
    throw new Error(`pending transaction ${params.action.contentHash} has unknown retained status ${retained.status}`);
  }
  return status;
}

async function reconcile(
  params: SubmitDurableActionParams<unknown, unknown>,
): Promise<WalletFileData> {
  const data = await params.store.load();
  if (data === null) throw new Error("wallet state disappeared while reconciling a submitted transaction");
  const status = await params.node.status();
  if (await params.store.readChain((chain) => reconcilePendingWalletActions(data, chain, status))) {
    await params.reservation.save(data);
  }
  return data;
}

async function recoverAmbiguous(
  params: SubmitDurableActionParams<unknown, unknown>,
): Promise<"accepted" | "queued" | "known" | null> {
  if (await params.isAccepted()) return "accepted";
  const retained = await retainedStatus(params, false);
  if (retained === "ready") return "queued";
  if (retained !== null) return "known";
  await reconcile(params);
  return null;
}

async function settle(params: SubmitDurableActionParams<unknown, unknown>): Promise<boolean> {
  const attempts = params.settlePollMaxAttempts ?? DEFAULT_SETTLE_POLL_MAX_ATTEMPTS;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) {
      await sleep(params.settlePollIntervalMs ?? DEFAULT_SETTLE_POLL_INTERVAL_MS);
      try {
        await params.synchronize?.();
      } catch (error) {
        // Another synchronization holding the wallet's sync lease advances the same state.
        if (!isWalletSyncConflict(error)) throw error;
      }
    }
    const data = await reconcile(params);
    if (!params.isPending(data)) return true;
  }
  const data = await params.store.load();
  return data !== null && !params.isPending(data);
}

function outcome<Output>(
  submission: DurableSubmissionResult<Output> | null,
  values: Omit<DurableSubmissionOutcome<Output>, "submission">,
): DurableSubmissionOutcome<Output> {
  return { submission, ...values };
}

export async function submitDurableAction<Prepared, Output>(
  params: SubmitDurableActionParams<Prepared, Output>,
): Promise<DurableSubmissionOutcome<Output>> {
  const entry = fromHex(params.action.transactionHex);
  let prepared: Prepared;
  let hadOutbox = false;

  if (params.state.retry) {
    await params.callbacks?.onPrepared?.(params.action.contentHash, params.action.transactionHex);
    if (await params.isAccepted()) {
      return outcome(null, { accepted: true, queued: false, settled: await settle(params), retried: true, recovered: true });
    }
    const retained = await retainedStatus(params);
    if (retained === "ready") {
      if (!hasOutbox(params.data, params.action.contentHash)) addOutbox(params);
      await markAdmitted(params, true);
      return outcome(null, { accepted: false, queued: true, settled: false, retried: true, recovered: true });
    }
    if (retained !== null) {
      await markAdmitted(params, true);
      return outcome(null, {
        accepted: false,
        queued: false,
        settled: await settle(params),
        retried: true,
        recovered: true,
      });
    }
    params.state.onCanonicalMiss?.();
    prepared = await params.submission.preflight({
      transactionBytes: entry,
      status: params.status,
      retry: true,
    });
    await params.callbacks?.beforeJournal?.(params.action.contentHash, params.action.transactionHex);
    if (params.submission.mode === "mempool" && !params.submission.prepareOnly) {
      hadOutbox = hasOutbox(params.data, params.action.contentHash);
      addOutbox(params);
      await save(params);
    }
  } else {
    prepared = params.state.prepared;
    if (!params.state.preJournaled) {
      await params.callbacks?.beforeJournal?.(params.action.contentHash, params.action.transactionHex);
      await params.state.validateJournal?.();
      params.state.journal();
      if (params.submission.mode === "mempool" && !params.submission.prepareOnly) addOutbox(params);
      await save(params);
    }
    await params.callbacks?.onPrepared?.(params.action.contentHash, params.action.transactionHex);
  }

  if (params.submission.prepareOnly) {
    return outcome(null, { accepted: false, queued: false, settled: false, retried: params.state.retry, recovered: false });
  }

  let submission: DurableSubmissionResult<Output>;
  try {
    // The journal save above checked this lease in the same transaction as the
    // durable mutation. Re-check immediately before the irreversible adapter.
    await params.reservation.assertActive();
    params.callbacks?.onProgress?.("submitting", "submitting the transaction to PCASH…");
    submission = await params.submission.submit({
      transactionBytes: entry,
      status: params.status,
      retry: params.state.retry,
      prepared,
      ...(params.submission.mode === "l1" ? { onL1Submitted: (hash: string) => markL1Submitted(params, hash) } : {}),
    });
  } catch (error) {
    const definite = isDurablePreBroadcastError(error)
      || params.submission.isDefinitePreBroadcastError?.(error) === true;
    if (definite) {
      let changed = false;
      if (!params.state.retry) {
        params.state.rollback();
        changed = true;
      }
      if (params.submission.mode === "mempool" && (!params.state.retry || !hadOutbox)) {
        removeMempoolOutboxEntry(params.data, params.action.contentHash);
        changed = true;
      }
      if (changed) await save(params);
      throw isDurablePreBroadcastError(error) ? error : new DurablePreBroadcastError(error);
    }
    let recovered: "accepted" | "queued" | "known" | null = null;
    try { recovered = await recoverAmbiguous(params); } catch { /* preserve the original ambiguous result */ }
    if (recovered === null) throw error;
    if (recovered === "queued") {
      await markAdmitted(params);
      return outcome(null, { accepted: false, queued: true, settled: false, retried: params.state.retry, recovered: true });
    }
    if (recovered === "known") {
      await markAdmitted(params);
      return outcome(null, {
        accepted: false,
        queued: false,
        settled: await settle(params),
        retried: params.state.retry,
        recovered: true,
      });
    }
    await markAdmitted(params);
    return outcome(null, {
      accepted: true,
      queued: false,
      settled: await settle(params),
      retried: params.state.retry,
      recovered: true,
    });
  }

  if (params.submission.mode === "l1" && submission.l1Hash !== undefined) await markL1Submitted(params, submission.l1Hash);
  if (submission.queued || submission.accepted) await markAdmitted(params);
  if (submission.accepted && !submission.queued) {
    params.callbacks?.onProgress?.("confirming", "waiting for the PCASH transaction to settle…");
  }
  return outcome(submission, {
    accepted: submission.accepted,
    queued: submission.queued,
    settled: submission.queued ? false : await settle(params),
    retried: params.state.retry,
    recovered: false,
  });
}
