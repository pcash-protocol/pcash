// Exact-byte submission transports shared by every wallet host: admission
// through the node mempool, direct L1 self-publication through an SDK relay
// submitter, and the wait-for-acceptance policy of hosts that block on a PCASH
// receipt. A host supplies only the submitter and journal its platform owns.

import {
  admitTransaction,
  assertMempoolAdmissible,
  awaitAcceptedReceipt,
  isAdmissionRefusal,
  samePcashIdentity,
  statusPcashIdentity,
  type PcashNodeClient,
  type StatusResult,
} from "@pcash/sdk/clients";
import {
  encodeBatchForVersion,
  posterPayoutOpening,
  selectBatchVersion,
  transactionIdentity,
} from "@pcash/sdk/protocol";
import {
  MAX_BROWSER_RELAY_BATCH_BYTES,
  MAX_RELAY_CONTENT_HASHES,
  RelayDeadlineError,
  RelayPreBroadcastError,
  RelayUpstreamError,
  prepareTransactionForL1,
  relayFailure,
  submitPreparedTransactionToL1,
  withRelayDeadline,
  type L1BatchCompanions,
  type PreparedL1Transaction,
  type RelayBatchJournalEntry,
  type RelayCarrierQuote,
  type RelayDaMode,
  type RelayJournalRecovery,
  type RelaySubmitter,
} from "@pcash/sdk/relay";
import { fromHex, randomFieldEntropy, toHex } from "@pcash/sdk/utils";
import {
  DurablePreBroadcastError,
  type DurableSubmissionAdapter,
  type DurableSubmissionResult,
} from "./actions/durableSubmission.ts";

export interface MempoolPrepared {
  readonly path: "mempool";
  readonly status: StatusResult;
}

/** Opaque handle to the exact batch and quote retained by the L1 adapter. */
export interface L1Prepared {
  readonly path: "l1";
}

export type SubmissionPrepared = MempoolPrepared | L1Prepared;
export type SubmissionOutput = Record<string, unknown>;

/** Exact-byte admission through the configured node's mempool. */
export function createMempoolSubmissionAdapter(
  node: PcashNodeClient,
): DurableSubmissionAdapter<SubmissionPrepared, SubmissionOutput> {
  return {
    mode: "mempool",
    async preflight({ transactionBytes: entry, status, additionalTransactions = [] }) {
      if (additionalTransactions.length > 0) throw new DurablePreBroadcastError(new Error("dependent transactions require L1 submission"));
      try {
        assertMempoolAdmissible(status, entry);
      } catch (cause) {
        throw new DurablePreBroadcastError(cause);
      }
      return { path: "mempool", status };
    },
    async submit({ transactionBytes: entry, prepared }) {
      let status: StatusResult;
      try {
        status = await node.status();
      } catch (cause) {
        throw new DurablePreBroadcastError(relayFailure("reading node status before admission", cause));
      }
      try {
        if (!samePcashIdentity(statusPcashIdentity((prepared as MempoolPrepared).status), statusPcashIdentity(status))) {
          throw new Error("node PCASH identity changed after transaction preparation");
        }
        assertMempoolAdmissible(status, entry);
      } catch (cause) {
        throw new DurablePreBroadcastError(cause);
      }
      let admission;
      try {
        admission = await admitTransaction(node, entry);
      } catch (cause) {
        // Only the node's own pre-insert refusal proves nothing was admitted.
        // Any other failure leaves the outcome unknown and the journal retained.
        if (isAdmissionRefusal(cause)) throw new DurablePreBroadcastError(cause);
        throw relayFailure(`admitting transaction ${transactionIdentity(entry).contentHash} to the node`, cause);
      }
      return {
        accepted: false,
        queued: true,
        output: { path: "mempool", admission },
      };
    },
  };
}

export interface L1SubmissionHooks {
  /** Called once the batch is durably journaled, before it is broadcast. */
  onJournaled?: (entry: RelayBatchJournalEntry) => Promise<void>;
  /** Called with the Ethereum hash before waiting for receipts. */
  onBroadcast?: (hash: string) => Promise<void>;
}

export interface L1SubmissionOptions {
  node: PcashNodeClient;
  /** The submitter for one publication; `hooks` apply to that publication only. */
  submitterFor(status: StatusResult, hooks?: L1SubmissionHooks): RelaySubmitter;
  /** The profile whose poster commitment the batch names. */
  payoutRecipient(status: StatusResult): { address: bigint; nkRoot: bigint };
  daMode?: RelayDaMode;
  /** Set only when the submitter sends as the wallet's own Ethereum account. */
  l1Sender?: string;
  /** The transport journal that owns whether another Ethereum submission is allowed. */
  recovery?(): Promise<RelayJournalRecovery>;
  /** Fill the batch with ready mempool entries after the required ones. */
  includeMempool?: boolean;
}

export interface L1SubmissionAdapter extends DurableSubmissionAdapter<SubmissionPrepared, SubmissionOutput> {
  /** Independent Fast-send companions are shuffled with the payment. */
  preflight(context: Parameters<DurableSubmissionAdapter["preflight"]>[0] & { companions?: L1BatchCompanions; requiredCollectibleOpenFee?: bigint }): Promise<SubmissionPrepared>;
  submit(context: Parameters<DurableSubmissionAdapter<SubmissionPrepared, SubmissionOutput>["submit"]>[0] & { onL1Journaled?: (entry: RelayBatchJournalEntry) => Promise<void> }): Promise<DurableSubmissionResult<SubmissionOutput>>;
  describeBatch(prepared: SubmissionPrepared): { transactions: readonly Uint8Array[]; quote: RelayCarrierQuote; posterOwnerCommitment: bigint; selected: readonly string[] };
  /** What posting these transactions as one batch from this submitter would cost now. */
  quoteBatch(context: { status: StatusResult; transactions: readonly Uint8Array[] }): Promise<RelayCarrierQuote>;
}

/** Direct L1 self-publication with the SDK's durable broadcast journal. */
export function createL1SubmissionAdapter(options: L1SubmissionOptions): L1SubmissionAdapter {
  const daMode = options.daMode ?? "auto";
  const preparations = new WeakMap<L1Prepared, { batch: PreparedL1Transaction; posterOwnerCommitment: bigint }>();
  const posterFor = (status: StatusResult) => {
    const recipient = options.payoutRecipient(status);
    return posterPayoutOpening(recipient.address, recipient.nkRoot, randomFieldEntropy());
  };
  return {
    mode: "l1",
    ...(options.l1Sender === undefined ? {} : { l1Sender: options.l1Sender }),
    ...(options.recovery === undefined ? {} : { l1Recovery: options.recovery }),
    async preflightL1Budget({ status, maxBatchBytes, additionalValueWei }) {
      const submitter = options.submitterFor(status);
      await submitter.assertAvailable();
      // All nonzero calldata bounds both intrinsic gas and the calldata floor.
      const { selected: quote } = await submitter.quote(status, toHex(new Uint8Array(maxBatchBytes).fill(255)), daMode);
      if (quote.balanceWei < additionalValueWei + quote.maximumCostWei) {
        throw new DurablePreBroadcastError(new Error("not enough ETH for payment and direct-L1 claim gas reserve"));
      }
      return { address: submitter.address, maximumCostWei: quote.maximumCostWei };
    },
    describeBatch(handle) {
      const { batch, posterOwnerCommitment } = preparations.get(handle as L1Prepared)!;
      return { transactions: batch.orderedTransactions.map((value) => fromHex(value)), quote: structuredClone(batch.quote), posterOwnerCommitment, selected: [...batch.selected] };
    },
    async quoteBatch({ status, transactions }) {
      const poster = posterFor(status);
      const submitter = options.submitterFor(status);
      await submitter.assertAvailable();
      const batch = toHex(encodeBatchForVersion([...transactions], selectBatchVersion(status), poster.ownerCommitment, poster.context));
      return (await submitter.quote(status, batch, daMode)).selected;
    },
    async preflight({ transactionBytes: entry, status, additionalTransactions = [], companions, requiredCollectibleOpenFee = 0n }) {
      const poster = posterFor(status);
      const submitter = options.submitterFor(status);
      let optional: Uint8Array[] = [];
      if (options.includeMempool && companions === undefined) {
        const prefix = [entry, ...additionalTransactions];
        const prefixBytes = encodeBatchForVersion(prefix, selectBatchVersion(status), poster.ownerCommitment, poster.context).length;
        const headerBytes = encodeBatchForVersion([], selectBatchVersion(status), poster.ownerCommitment, poster.context).length;
        if (prefixBytes < Number(MAX_BROWSER_RELAY_BATCH_BYTES) && prefix.length < MAX_RELAY_CONTENT_HASHES) {
          try {
            const page = await options.node.getMempool({ status: "ready", limit: MAX_RELAY_CONTENT_HASHES - prefix.length });
            const prefixHashes = new Set<string>(prefix.map((item) => transactionIdentity(item).contentHash));
            const candidates = page.items.filter((item) => !prefixHashes.has(item.contentHash.toLowerCase()));
            if (candidates.length > 0) {
              const selected = await options.node.prepareRelay({ contentHashes: candidates.map((item) => item.contentHash),
                controlledIssuanceOwnerCommitments: [],
                maxBatchBytes: MAX_BROWSER_RELAY_BATCH_BYTES - BigInt(prefixBytes - headerBytes) });
              optional = selected.selectedTransactions.map((hex) => fromHex(hex));
            }
          } catch {
            // The node's optional mempool service must not block the required batch.
          }
        }
      }
      const batch = await prepareTransactionForL1(entry, status, submitter, poster.ownerCommitment, poster.context, daMode, { required: additionalTransactions, optional, ...(companions === undefined ? {} : { companions }) });
      batch.collectibleOpenFee += requiredCollectibleOpenFee;
      const handle: L1Prepared = Object.freeze({ path: "l1" });
      preparations.set(handle, { batch: structuredClone(batch), posterOwnerCommitment: poster.ownerCommitment });
      return handle;
    },
    async submit({ prepared, onL1Submitted, onL1Journaled }) {
      const { batch } = preparations.get(prepared as L1Prepared)!;
      const relay = await submitPreparedTransactionToL1(options.node, batch, options.submitterFor(batch.status, {
        ...(onL1Submitted === undefined ? {} : { onBroadcast: onL1Submitted }),
        ...(onL1Journaled === undefined ? {} : { onJournaled: onL1Journaled }),
      }));
      return {
        // The batch may carry other entries; only this action's own outcome counts.
        accepted: relay.outcomes?.some((outcome) => outcome.batchItemIndex === BigInt(batch.actionBatchIndex) && outcome.outcome === "succeeded") ?? false,
        queued: !relay.observed,
        l1Hash: relay.txHash,
        output: { path: "l1", relay },
      };
    },
    isDefinitePreBroadcastError: (error) => error instanceof DurablePreBroadcastError || error instanceof RelayPreBroadcastError,
  };
}

export interface AcceptanceWait {
  node: PcashNodeClient;
  /** Wait for finality instead of the latest accepted receipt. */
  finalized?: boolean;
  pollIntervalMs?: number;
  pollMaxAttempts?: number;
  /** Wall-clock deadline for the whole wait. */
  timeoutMs?: number;
}

/**
 * Wait for the PCASH receipt after `adapter` submits. Hosts that answer a
 * caller only once the outcome is canonical wrap their transport in this; a
 * host that reports "submitted" and reconciles later uses the transport bare.
 */
export function awaitingAcceptance<Prepared>(
  adapter: DurableSubmissionAdapter<Prepared, SubmissionOutput>,
  wait: AcceptanceWait,
): DurableSubmissionAdapter<Prepared, SubmissionOutput> {
  const finalized = wait.finalized === true;
  const pollIntervalMs = wait.pollIntervalMs ?? (finalized ? 5_000 : 2_000);
  const pollMaxAttempts = wait.pollMaxAttempts ?? (finalized ? 300 : 150);
  const timeoutMs = wait.timeoutMs ?? 30_000 + pollIntervalMs * pollMaxAttempts;
  return {
    ...adapter,
    async submit(context) {
      const submitted = await adapter.submit(context);
      const { contentHash } = transactionIdentity(context.transactionBytes);
      // The bytes are out: a failure from here on must never read as a definite
      // pre-broadcast rejection, so it is always a relay deadline or upstream error.
      let pcashReceipt;
      try {
        pcashReceipt = await withRelayDeadline(
          `PCASH acceptance observation for ${contentHash}`,
          timeoutMs,
          () => awaitAcceptedReceipt(wait.node, contentHash, { finalized, pollIntervalMs, pollMaxAttempts }),
        );
      } catch (error) {
        if (error instanceof RelayDeadlineError) throw error;
        if (error instanceof Error && /timed out waiting for the pcash receipt/i.test(error.message)) {
          throw new RelayDeadlineError(error.message, error);
        }
        throw new RelayUpstreamError(`PCASH acceptance observation for ${contentHash} failed`, error);
      }
      return {
        ...submitted,
        accepted: true,
        queued: false,
        output: {
          ...submitted.output,
          contentHash,
          pcashReceipt,
          accepted: true,
          ...(finalized ? { finalized: true } : {}),
        },
      };
    },
  };
}
