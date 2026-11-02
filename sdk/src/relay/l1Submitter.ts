import {
  createPublicClient,
  http,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type TransactionReceipt,
} from "viem";
import {
  type L1DeliveryBatchResult,
  type PcashNodeClient,
  type StatusResult,
} from "../clients/index.ts";
import { fromHex, toHex } from "../utils/hex.ts";
import { networkConfigFromStatus, transactionId } from "../protocol/index.ts";
import { pcashL1Chain, requireL1Identity } from "../l1/relayer.ts";
import {
  RelayDeadlineError,
  RelayJournalConflictError,
  RelayUpstreamError,
  RelayValidationError,
  RelayPreBroadcastError,
  relayFailure,
  upstreamQuantity,
  withRelayDeadline,
} from "./errors.ts";
import {
  batchEntries,
  batchEntryCarrying,
  type RelayBatchJournalEntry,
  type RelayCallJournalEntry,
  type RelayJournal,
  type RelayJournalEntry,
} from "./journal.ts";
import {
  journalL1Receipt,
  reconcileRelayJournal,
  RECOVERY_RPC_TIMEOUT_MS,
  type RelayJournalReads,
} from "./recovery.ts";
import type {
  RelayBroadcast,
  RelayCarrierQuote,
  RelayTransactionOutcome,
  RelayDaMode,
  RelayQuoteSet,
  RelaySubmissionMetadata,
  RelaySubmissionResult,
  RelaySubmitter,
} from "./relayer.ts";
import { keyedSerialQueue } from "../utils/serial.ts";
import { sleep } from "../utils/time.ts";

const DEFAULT_RECEIPT_TIMEOUT_MS = 300_000;
const DEFAULT_OBSERVATION_TIMEOUT_MS = 120_000;
const DEFAULT_OBSERVATION_POLL_MS = 2_000;
const DEFAULT_MAX_IN_FLIGHT = 1;

export interface RelayFeeContext {
  balance: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  executionGasPrice: bigint;
}

/** The `eth_feeHistory` fields viem's typed result omits; the last entry prices the next block. */
export interface ExtendedFeeHistory {
  baseFeePerGas?: unknown[];
  baseFeePerBlobGas?: unknown[];
}

/** One L1 transaction, at the nonce the journal allocated to it. */
export interface RelayTransactionRequest {
  chainId: bigint;
  nonce: number;
  to: string;
  value: bigint;
  /** Calldata; empty for a blob carrier, whose batch travels in `blobs`. */
  data: string;
  gasLimit: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  blobs: { maxFeePerBlobGas: bigint; quote: Extract<RelayCarrierQuote, { carrier: "blobs" }> } | null;
}

export type RelaySignerValues = Pick<
  RelayJournalEntry,
  "resolutionId" | "phase" | "submissionKind" | "transactionHash" | "signedTransaction"
>;

export interface RelayBroadcastContext {
  status: StatusResult;
  request: RelayTransactionRequest;
  /** This transaction's journal entry, completed with the signer's identifiers. */
  journalEntry(values: RelaySignerValues): RelayJournalEntry;
}

export interface RelayBroadcastResult {
  entry: RelayJournalEntry;
  txHash: string;
  resolutionId: string;
}

/** A plain L1 call from the journal's account, such as an ETH transfer. */
export interface RelayCall {
  to: string;
  value?: bigint;
  data?: string;
  /** Skip estimation with an exact gas limit. */
  gasLimit?: bigint;
}

export interface RelayCallReceipt {
  txHash: string;
  blockNumber: bigint;
  blockHash: string;
  transactionIndex: number;
  gasUsed: bigint;
}

export interface RelayCallBroadcast {
  txHash: string;
  /** Wait for the receipt, then release the journal entry; a revert rejects. */
  settle(): Promise<RelayCallReceipt>;
}

export interface RelayL1SubmitterConfig {
  address: string;
  rpcUrl: string;
  node: Pick<PcashNodeClient, "getReceipt" | "status" | "getInboxDeliveryBatch">;
  journal: RelayJournal;
  transport?: Transport;
  receiptTimeoutMs?: number;
  /** Interval between L1 receipt polls; viem's client default when omitted. */
  receiptPollMs?: number;
  observationTimeoutMs?: number;
  observationPollMs?: number;
  /** Transactions this account may have broadcast and unsettled at once (default 1). */
  maxInFlight?: number;
  maxFeePerGas?: bigint;
  gasLimit?: bigint;
  /**
   * Serializes nonce allocation and broadcast (including replacements) across
   * contexts that share the journal, such as browser tabs. Defaults to a queue
   * per account in this process. Never held while sleeping for settlement.
   */
  runExclusive?: <T>(operation: () => Promise<T>) => Promise<T>;
}

/**
 * Settlements under way in this process, per L1 account and resolution. A
 * full journal waits for these rather than failing, as a queue would; an entry
 * nobody here is settling, such as one a crashed process left, fails fast.
 */
const settlements = new Map<string, Map<string, Promise<void>>>();

function settlementsOf(address: string): Map<string, Promise<void>> {
  const key = address.toLowerCase();
  let settling = settlements.get(key);
  if (settling === undefined) {
    settling = new Map();
    settlements.set(key, settling);
  }
  return settling;
}

const runForAccount = keyedSerialQueue();

/** Serialize one L1 account's nonce allocation and broadcast within this process. */
function accountQueue(address: string): <T>(operation: () => Promise<T>) => Promise<T> {
  const key = address.toLowerCase();
  return (operation) => runForAccount(key, operation);
}

function beforeDeadline<T>(
  what: string,
  deadline: number,
  operation: () => Promise<T>,
): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Promise.reject(new RelayDeadlineError(`${what} timed out`));
  return withRelayDeadline(what, remaining, operation);
}

/**
 * Shared L1 quote, nonce, receipt, and PCASH-observation engine. Every
 * transaction is journaled before broadcast and released once settled; up to
 * `maxInFlight` may be unsettled at once. Platform subclasses own carrier
 * construction, signing, and optional pending-transaction maintenance.
 */
export abstract class RelayL1Submitter implements RelaySubmitter {
  readonly address: string;
  protected readonly rpcUrl: string;
  protected readonly journal: RelayJournal;
  protected readonly transport: Transport;
  readonly #node: Pick<PcashNodeClient, "getReceipt" | "status" | "getInboxDeliveryBatch">;
  protected readonly receiptTimeoutMs: number;
  protected readonly receiptPollMs: number | undefined;
  readonly #observationTimeoutMs: number;
  readonly #observationPollMs: number;
  readonly #maxInFlight: number;
  protected readonly maxFeePerGas: bigint | undefined;
  readonly #gasLimit: bigint | undefined;
  protected readonly runExclusive: <T>(operation: () => Promise<T>) => Promise<T>;

  protected constructor(config: RelayL1SubmitterConfig) {
    this.address = config.address;
    this.rpcUrl = config.rpcUrl;
    this.#node = config.node;
    this.journal = config.journal;
    this.transport = config.transport ?? http(config.rpcUrl, { timeout: 30_000 });
    this.receiptTimeoutMs = config.receiptTimeoutMs ?? DEFAULT_RECEIPT_TIMEOUT_MS;
    this.receiptPollMs = config.receiptPollMs;
    this.#observationTimeoutMs = config.observationTimeoutMs ?? DEFAULT_OBSERVATION_TIMEOUT_MS;
    this.#observationPollMs = config.observationPollMs ?? DEFAULT_OBSERVATION_POLL_MS;
    this.#maxInFlight = config.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT;
    this.maxFeePerGas = config.maxFeePerGas;
    this.#gasLimit = config.gasLimit;
    if (!/^0x[0-9a-fA-F]{40}$/.test(this.address)) {
      throw new RelayValidationError("relay address must be a 20-byte 0x-prefixed hex string");
    }
    const runExclusive = config.runExclusive ?? accountQueue(this.address);
    this.runExclusive = (operation) => runExclusive(() =>
      this.journal.runExclusive === undefined ? operation() : this.journal.runExclusive(operation));
    for (const [label, value] of [
      ["receiptTimeoutMs", this.receiptTimeoutMs],
      ["receiptPollMs", this.receiptPollMs ?? 1],
      ["observationTimeoutMs", this.#observationTimeoutMs],
      ["observationPollMs", this.#observationPollMs],
      ["maxInFlight", this.#maxInFlight],
    ] as const) {
      if (!Number.isInteger(value) || value < 1) {
        throw new RelayValidationError(`${label} must be a positive integer`);
      }
    }
    if (this.maxFeePerGas !== undefined && this.maxFeePerGas < 0n) {
      throw new RelayValidationError("maxFeePerGas must be nonnegative");
    }
    if (this.#gasLimit !== undefined && this.#gasLimit < 1n) {
      throw new RelayValidationError("gasLimit must be positive");
    }
  }

  protected abstract readonly supportsBlobs: boolean;

  get supportedCarriers(): readonly ("calldata" | "blobs")[] {
    return this.supportsBlobs ? ["calldata", "blobs"] : ["calldata"];
  }

  protected abstract quoteBlobCarrier(
    status: StatusResult,
    batch: Uint8Array,
    fees: RelayFeeContext,
  ): Promise<RelayCarrierQuote>;

  /** Create the journal entry, then sign and broadcast its transaction. */
  protected abstract broadcast(context: RelayBroadcastContext): Promise<RelayBroadcastResult>;

  protected async verifyAuthority(_status: StatusResult): Promise<void> {}

  /**
   * Fail fast when the account cannot take another transaction, first settling
   * entries whose transactions have since been mined and, for batches, recorded
   * by the node. Each read is bounded so a hung RPC keeps its entry but
   * releases the exclusive queue.
   */
  assertAvailable(): Promise<void> {
    return this.#withAdmission([], async () => {});
  }

  async inFlight(): Promise<string[]> {
    return batchEntries(await this.journal.read())
      .flatMap((entry) => entry.selected.map((contentHash) => contentHash.toLowerCase()));
  }

  #reads(): RelayJournalReads {
    return {
      readL1Receipt: (entry, hash) => withRelayDeadline(
        "reading the journal L1 receipt",
        RECOVERY_RPC_TIMEOUT_MS,
        () => journalL1Receipt(entry, this.rpcUrl, this.transport, hash),
      ),
      readDelivery: (hash) => withRelayDeadline(
        "reading PCASH L1 delivery",
        RECOVERY_RPC_TIMEOUT_MS,
        () => this.rpc("reading PCASH L1 delivery", () => this.#node.getInboxDeliveryBatch(hash)),
      ),
    };
  }

  /**
   * The journal's entries, once it can take one more transaction carrying
   * `selected`. Settled entries are reconciled away only when they are in the
   * way, and a journal full of this process's own settling transactions waits
   * for one to finish. An intent without a hash blocks everything: its nonce
   * may or may not be spent, so any later nonce could be stranded behind a gap.
   */
  async #admit(selected: readonly string[]): Promise<{ entries: RelayJournalEntry[] } | { wait: Promise<void> }> {
    let entries = await this.journal.read();
    const blocked = entries.length >= this.#maxInFlight
      || entries.some((entry) => entry.transactionHash === null)
      || selected.some((hash) => batchEntryCarrying(entries, hash) !== undefined);
    if (!blocked) return { entries };
    const reconciliation = await reconcileRelayJournal(this.journal, this.#reads());
    entries = await this.journal.read();
    const state = (entry: RelayJournalEntry) => {
      const outcome = reconciliation.entries.find((candidate) => candidate.resolutionId === entry.resolutionId)?.outcome;
      return `relay journal ${entry.resolutionId} is ${outcome ?? "in flight"}`;
    };
    const ambiguous = entries.find((entry) => entry.transactionHash === null);
    if (ambiguous !== undefined) throw new RelayJournalConflictError(state(ambiguous));
    const settling = settlementsOf(this.address);
    for (const entry of entries) {
      if (!settling.has(entry.resolutionId)
        && reconciliation.entries.some((result) => result.resolutionId === entry.resolutionId && result.outcome === "pending")) {
        await this.maintainPending(entry);
      }
    }
    for (const contentHash of selected) {
      const carrying = batchEntryCarrying(entries, contentHash);
      if (carrying !== undefined) {
        throw new RelayJournalConflictError(`content hash ${contentHash} is already in flight: ${state(carrying)}`);
      }
    }
    if (entries.length < this.#maxInFlight) return { entries };
    const ours = entries.flatMap((entry) => settling.get(entry.resolutionId) ?? []);
    if (ours.length === 0) {
      throw new RelayJournalConflictError(entries.length === 1
        ? state(entries[0]!)
        : `${entries.length} L1 transactions are in flight (${entries.map(state).join("; ")})`);
    }
    return { wait: Promise.race(ours) };
  }

  /** Wait outside the account queue so settlement can acquire it to replace a transaction. */
  async #withAdmission<T>(selected: readonly string[], operation: (entries: RelayJournalEntry[]) => Promise<T>): Promise<T> {
    while (true) {
      const result = await this.runExclusive(async () => {
        const admitted = await this.#admit(selected);
        if ("wait" in admitted) return admitted;
        return { value: await operation(admitted.entries) };
      });
      if ("value" in result) return result.value;
      await result.wait;
    }
  }

  /** Called under the account queue for an unmined entry without an active settlement. */
  protected async maintainPending(entry: RelayJournalEntry): Promise<RelayJournalEntry> { return entry; }

  /**
   * A handle whose first `settle` call runs `settlement`. Until it finishes,
   * a full journal waits for it instead of failing; a handle nobody settles
   * stops holding waiters once its receipt and observation could have timed out.
   */
  #settling<T>(resolutionId: string, settlement: () => Promise<T>): () => Promise<T> {
    const settling = settlementsOf(this.address);
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => { finish = resolve; });
    const expiry = setTimeout(finish, this.receiptTimeoutMs + this.#observationTimeoutMs);
    (expiry as { unref?: () => void }).unref?.();
    const registered: Promise<void> = finished.then(() => {
      clearTimeout(expiry);
      if (settling.get(resolutionId) === registered) settling.delete(resolutionId);
    });
    settling.set(resolutionId, registered);
    let running: Promise<T> | undefined;
    return () => running ??= settlement().finally(finish);
  }

  /** The next nonce no in-flight entry holds, never below the node's pending nonce. */
  async #nextNonce(client: PublicClient<Transport, Chain>, entries: readonly RelayJournalEntry[]): Promise<number> {
    const pending = await this.rpc("reading the pending relay nonce", () => client.getTransactionCount({
      address: this.address as Address,
      blockTag: "pending",
    }));
    return entries.reduce((next, entry) => Math.max(next, Number(entry.nonce) + 1), pending);
  }

  async balance(status: StatusResult): Promise<bigint> {
    await this.verifyIdentity(status);
    return this.rpc("reading the relay balance", () =>
      this.client(status).getBalance({ address: this.address as Address })
    );
  }

  protected client(status: Pick<StatusResult, "l1ChainId">): PublicClient<Transport, Chain> {
    return createPublicClient({
      chain: pcashL1Chain(status.l1ChainId, this.rpcUrl),
      transport: this.transport,
      ...(this.receiptPollMs === undefined ? {} : { pollingInterval: this.receiptPollMs }),
    });
  }

  protected async rpc<T>(what: string, operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      throw relayFailure(what, error);
    }
  }

  /** The latest block's fee history, whose last entries price the next block. */
  protected async feeHistory(status: StatusResult, what: string): Promise<ExtendedFeeHistory> {
    const history = await this.rpc(what, () => this.client(status).request({
      method: "eth_feeHistory",
      params: ["0x1", "latest", []],
    }));
    return history as unknown as ExtendedFeeHistory;
  }

  protected relayGasLimit(estimate: () => Promise<bigint>): Promise<bigint> {
    return this.#gasLimit === undefined
      ? this.rpc("estimating relay gas", estimate)
      : Promise.resolve(this.#gasLimit);
  }

  protected async verifyIdentity(status: StatusResult): Promise<void> {
    // Every batch goes to the status's inbox, which a compiled network fixes.
    networkConfigFromStatus(status);
    await this.rpc("verifying L1 identity", () => requireL1Identity(this.rpcUrl, {
      chainId: status.l1ChainId,
      anchorNumber: status.genesisL1Block,
      anchorHash: status.genesisL1BlockHash,
    }, { transport: this.transport }));
    await this.verifyAuthority(status);
  }

  #commonEntry(status: StatusResult, request: RelayTransactionRequest, values: RelaySignerValues) {
    return {
      createdAt: new Date().toISOString(),
      previousTransactionHashes: [],
      lastBroadcastBlock: null,
      ...values,
      relayerAddress: this.address,
      chainId: status.l1ChainId.toString(),
      nonce: request.nonce.toString(),
      gasLimit: request.gasLimit.toString(),
      maxFeePerGas: request.maxFeePerGas.toString(),
      maxPriorityFeePerGas: request.maxPriorityFeePerGas.toString(),
      genesisL1Block: status.genesisL1Block.toString(),
      genesisL1BlockHash: status.genesisL1BlockHash,
    };
  }

  #batchEntry(
    status: StatusResult,
    batch: string,
    quote: RelayCarrierQuote,
    metadata: RelaySubmissionMetadata,
    request: RelayTransactionRequest,
    values: RelaySignerValues,
  ): RelayBatchJournalEntry {
    return {
      kind: "batch",
      ...this.#commonEntry(status, request, values),
      carrier: quote.carrier,
      batch,
      selected: [...metadata.selected],
      batchItemIndexes: relayBatchItemIndexes(metadata).map(String),
      observationMode: metadata.observationMode ?? "selected",
      collectibleOpenFee: metadata.collectibleOpenFee.toString(),
      inboxAddress: status.inboxAddress,
      maxFeePerBlobGas: quote.maxFeePerBlobGas?.toString() ?? null,
      headCheckedBlock: metadata.headCheckedBlock.toString(),
      headCheckedBlockHash: metadata.headCheckedBlockHash,
    };
  }

  #callEntry(status: StatusResult, request: RelayTransactionRequest, values: RelaySignerValues): RelayCallJournalEntry {
    return {
      kind: "call",
      ...this.#commonEntry(status, request, values),
      to: request.to,
      value: request.value.toString(),
      data: request.data,
    };
  }

  async #fees(status: StatusResult): Promise<RelayFeeContext> {
    const client = this.client(status);
    const [fees, balance, history] = await Promise.all([
      this.rpc("estimating EIP-1559 fees", () => client.estimateFeesPerGas()),
      this.rpc("reading the relay balance", () => client.getBalance({ address: this.address as Address })),
      this.feeHistory(status, "reading L1 fee history"),
    ]);
    if (!("maxFeePerGas" in fees) || !("maxPriorityFeePerGas" in fees)) {
      throw new RelayUpstreamError("L1 does not expose EIP-1559 fee estimates");
    }
    const nextBaseFee = upstreamQuantity(history.baseFeePerGas?.at(-1), "next execution base fee is missing from L1 fee history");
    const maxFeePerGas = fees.maxFeePerGas;
    const maxPriorityFeePerGas = fees.maxPriorityFeePerGas;
    if (this.maxFeePerGas !== undefined && maxFeePerGas > this.maxFeePerGas) {
      throw new RelayValidationError(
        `estimated L1 max fee per gas ${maxFeePerGas} wei exceeds configured maximum ${this.maxFeePerGas} wei`,
      );
    }
    const executionGasPrice = maxFeePerGas < nextBaseFee + maxPriorityFeePerGas
      ? maxFeePerGas
      : nextBaseFee + maxPriorityFeePerGas;
    return { balance, maxFeePerGas, maxPriorityFeePerGas, executionGasPrice };
  }

  async #calldataQuote(
    status: StatusResult,
    batch: Hex,
    fees: RelayFeeContext,
  ): Promise<RelayCarrierQuote> {
    const gasLimit = await this.relayGasLimit(
      () => this.client(status).estimateGas({
        account: this.address as Address,
        to: status.inboxAddress as Address,
        data: batch,
        value: 0n,
      }),
    );
    return {
      carrier: "calldata",
      gasLimit,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      maxFeePerBlobGas: null,
      blobCount: 0,
      blobVersionedHashes: [],
      estimatedCostWei: gasLimit * fees.executionGasPrice,
      maximumCostWei: gasLimit * fees.maxFeePerGas,
      balanceWei: fees.balance,
    };
  }

  async quote(status: StatusResult, batchHex: string, mode: RelayDaMode): Promise<RelayQuoteSet> {
    const batch = fromHex(batchHex, "relay batch");
    if (batch.length === 0) throw new RelayValidationError("cannot quote an empty relay batch");
    await this.verifyIdentity(status);
    const fees = await this.#fees(status);
    const calldataPromise = () => this.#calldataQuote(status, batchHex as Hex, fees);
    if (mode === "calldata") {
      const calldata = await calldataPromise();
      return { selected: calldata, calldata };
    }
    if (mode === "blobs") {
      if (!this.supportsBlobs) {
        throw new RelayValidationError("this relay submitter does not support blob transactions");
      }
      const blobs = await this.quoteBlobCarrier(status, batch, fees);
      return { selected: blobs, blobs };
    }
    if (!this.supportsBlobs) {
      const calldata = await calldataPromise();
      return { selected: calldata, calldata };
    }
    const [calldataResult, blobResult] = await Promise.allSettled([
      calldataPromise(),
      this.quoteBlobCarrier(status, batch, fees),
    ]);
    if (calldataResult.status === "rejected" && blobResult.status === "rejected") {
      const calldataFailure = relayFailure("quoting calldata", calldataResult.reason);
      const blobFailure = relayFailure("quoting blobs", blobResult.reason);
      throw new RelayUpstreamError(
        `neither relay carrier could be quoted (calldata: ${calldataFailure.message}; blobs: ${blobFailure.message})`,
        new AggregateError([calldataResult.reason, blobResult.reason]),
      );
    }
    const calldata = calldataResult.status === "fulfilled" ? calldataResult.value : undefined;
    const blobs = blobResult.status === "fulfilled" ? blobResult.value : undefined;
    const selected = calldata === undefined
      ? blobs!
      : blobs === undefined || calldata.estimatedCostWei <= blobs.estimatedCostWei
        ? calldata
        : blobs;
    return {
      selected,
      ...(calldata === undefined ? {} : { calldata }),
      ...(blobs === undefined ? {} : { blobs }),
    };
  }

  async #batchExclusions(
    selected: readonly string[],
    batchItemIndexes: readonly number[],
    inclusion: { txHash: string; blockHash: string; transactionIndex: number },
    deadline: number,
  ): Promise<{ excluded: Set<number>; delivery: L1DeliveryBatchResult }> {
    while (true) {
      if (Date.now() >= deadline) throw new RelayDeadlineError("node L1 delivery observation timed out");
      const delivery = await beforeDeadline(
        "node L1 delivery observation",
        deadline,
        () => this.rpc("reading PCASH L1 delivery", () => this.#node.getInboxDeliveryBatch(inclusion.txHash)),
      );
      if (delivery !== null) {
        if (
          delivery.l1TransactionHash.toLowerCase() !== inclusion.txHash.toLowerCase()
          || delivery.l1BlockHash.toLowerCase() !== inclusion.blockHash.toLowerCase()
          || delivery.l1TransactionIndex !== BigInt(inclusion.transactionIndex)
        ) {
          throw new RelayUpstreamError("L1 delivery diagnostics belong to another inclusion");
        }
        if (delivery.exclusionReason !== null) {
          throw new RelayUpstreamError(`relay batch was excluded: ${delivery.exclusionReason}`);
        }
        const itemsByIndex = new Map(delivery.items.map((item) => [Number(item.batchItemIndex), item]));
        const excluded = new Set<number>();
        for (let selectedIndex = 0; selectedIndex < selected.length; selectedIndex += 1) {
          const batchItemIndex = batchItemIndexes[selectedIndex]!;
          const item = itemsByIndex.get(batchItemIndex);
          if (item === undefined || item.contentHash.toLowerCase() !== selected[selectedIndex]!.toLowerCase()) {
            throw new RelayUpstreamError(`L1 delivery diagnostics do not match batch item ${batchItemIndex}`);
          }
          if (item.exclusionReason !== null) excluded.add(selectedIndex);
        }
        return { excluded, delivery };
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new RelayDeadlineError("node L1 delivery observation timed out");
      await sleep(Math.min(this.#observationPollMs, remaining));
    }
  }

  async #observe(
    selected: readonly string[],
    batchItemIndexes: readonly number[],
    observationMode: "selected" | "batch",
    inclusion: { txHash: string; blockHash: string; transactionIndex: number },
  ): Promise<{ outcomes: RelayTransactionOutcome[]; delivery?: L1DeliveryBatchResult }> {
    const deadline = Date.now() + this.#observationTimeoutMs;
    const batchObservation = observationMode === "batch"
      ? await this.#batchExclusions(selected, batchItemIndexes, inclusion, deadline)
      : undefined;
    const excluded = batchObservation?.excluded ?? new Set<number>();
    const outcomes: Array<RelayTransactionOutcome | undefined> = Array.from({ length: selected.length });
    while (true) {
      const pending: string[] = [];
      for (let selectedIndex = 0; selectedIndex < selected.length; selectedIndex += 1) {
        if (excluded.has(selectedIndex)) continue;
        if (outcomes[selectedIndex] !== undefined) continue;
        const contentHash = selected[selectedIndex]!;
        const batchItemIndex = batchItemIndexes[selectedIndex]!;
        if (Date.now() >= deadline) throw new RelayDeadlineError("node inclusion observation timed out");
        const receipts = await beforeDeadline(
          "node inclusion observation",
          deadline,
          () => this.rpc(
            `reading PCASH batch item ${batchItemIndex}`,
            async () => await this.#node.getReceipt({ inclusionId: {
              l1BlockHash: inclusion.blockHash,
              l1TransactionIndex: inclusion.transactionIndex,
              batchItemIndex,
            } }),
          ),
        );
        if (receipts.length > 1) {
          throw new RelayUpstreamError(`Node returned multiple receipts for batch item ${batchItemIndex}`);
        }
        const observed = receipts[0];
        if (observed === undefined) {
          pending.push(`${batchItemIndex}:${contentHash}`);
          continue;
        }
        const coordinates = observed.inclusion;
        if (
          coordinates.l1BlockHash.toLowerCase() !== inclusion.blockHash.toLowerCase()
          || coordinates.l1TransactionIndex !== BigInt(inclusion.transactionIndex)
          || coordinates.batchItemIndex !== BigInt(batchItemIndex)
        ) {
          throw new RelayUpstreamError(`Receipt ${batchItemIndex} belongs to another L1 inclusion`);
        }
        if (observed.contentHash.toLowerCase() !== contentHash.toLowerCase()) {
          throw new RelayUpstreamError(`Receipt ${batchItemIndex} is for another transaction`);
        }
        outcomes[selectedIndex] = {
          transactionId: toHex(transactionId({
            l1BlockHash: fromHex(inclusion.blockHash, "L1 inclusion block hash"),
            l1TransactionIndex: BigInt(inclusion.transactionIndex),
            batchItemIndex: BigInt(batchItemIndex),
          })),
          outcome: observed.outcome,
          accepted: observed.outcome === "succeeded",
          kind: observed.kind,
          l1BlockHash: coordinates.l1BlockHash,
          l1TransactionIndex: coordinates.l1TransactionIndex,
          batchItemIndex: coordinates.batchItemIndex,
        };
      }
      if (outcomes.every((outcome, index) => outcome !== undefined || excluded.has(index))) {
        return {
          outcomes: outcomes.filter((outcome): outcome is RelayTransactionOutcome => outcome !== undefined),
          ...(batchObservation === undefined ? {} : { delivery: batchObservation.delivery }),
        };
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new RelayDeadlineError(
          `node has classified ${selected.length - pending.length} of ${selected.length} selected transactions; `
            + `pending batch items: ${pending.join(", ")}`,
        );
      }
      await sleep(Math.min(this.#observationPollMs, remaining));
    }
  }

  #receipt(client: PublicClient<Transport, Chain>, txHash: string) {
    return beforeDeadline(
      "waiting for relay inclusion",
      Date.now() + this.receiptTimeoutMs,
      () => this.rpc("waiting for relay inclusion", () => client.waitForTransactionReceipt({
        hash: txHash as Hex,
        timeout: this.receiptTimeoutMs,
      })),
    );
  }

  /**
   * Journal and broadcast one batch under the account queue. The returned
   * handle waits for inclusion and the node's observation, then releases the
   * journal entry; it does not hold the queue while waiting between polls.
   */
  async send(
    status: StatusResult,
    batch: string,
    quote: RelayCarrierQuote,
    metadata: RelaySubmissionMetadata,
  ): Promise<RelayBroadcast> {
    const preBroadcast = async <T>(operation: () => Promise<T>): Promise<T> => {
      try {
        return await operation();
      } catch (cause) {
        if (metadata.source !== "direct" || cause instanceof RelayJournalConflictError) throw cause;
        throw new RelayPreBroadcastError(cause);
      }
    };
    const client = this.client(status);
    const batchItemIndexes = await preBroadcast(async () => {
      if (fromHex(batch, "relay batch").length === 0) {
        throw new RelayValidationError("cannot submit an empty relay batch");
      }
      return relayBatchItemIndexes(metadata);
    });
    const broadcast = await this.#withAdmission(metadata.selected, async (entries) => {
      const request = await preBroadcast(async () => {
        await this.verifyIdentity(status);
        const [nonce, balance] = await Promise.all([
          this.#nextNonce(client, entries),
          this.rpc("rechecking the relay balance", () => client.getBalance({ address: this.address as Address })),
        ]);
        if (balance < quote.maximumCostWei) {
          throw new RelayUpstreamError(
            `L1 submitter ${this.address} is underfunded: balance ${balance} wei < maximum relay cost ${quote.maximumCostWei} wei`,
          );
        }
        return batchRequest(status, batch, quote, nonce);
      });
      return this.broadcast({
        status,
        request,
        journalEntry: (values) => this.#batchEntry(status, batch, quote, metadata, request, values),
      });
    });
    return {
      txHash: broadcast.txHash,
      settle: this.#settling(broadcast.resolutionId, () => this.#settleBatch(status, broadcast, metadata, batchItemIndexes)),
    };
  }

  protected batchReceipt(status: StatusResult, broadcast: RelayBroadcastResult): Promise<TransactionReceipt> {
    return this.#receipt(this.client(status), broadcast.txHash);
  }

  async #settleBatch(
    status: StatusResult,
    broadcast: RelayBroadcastResult,
    metadata: RelaySubmissionMetadata,
    batchItemIndexes: readonly number[],
  ): Promise<RelaySubmissionResult> {
    const receipt = await this.batchReceipt(status, broadcast);
    const observation = await this.#observe(
      metadata.selected,
      batchItemIndexes,
      metadata.observationMode ?? "selected",
      {
        txHash: receipt.transactionHash,
        blockHash: receipt.blockHash,
        transactionIndex: receipt.transactionIndex,
      },
    );
    // The node has derived the inclusion block, so these transactions no longer
    // read as ready and the journal entry has nothing left to protect.
    await this.journal.clear(broadcast.resolutionId);
    return {
      txHash: receipt.transactionHash,
      receipt: {
        status: receipt.status === "success" ? 1 : 0,
        blockNumber: receipt.blockNumber,
        blockHash: receipt.blockHash,
        transactionIndex: receipt.transactionIndex,
        gasUsed: receipt.gasUsed,
      },
      observed: true,
      outcomes: observation.outcomes,
      ...(observation.delivery === undefined ? {} : { delivery: observation.delivery }),
    };
  }

  /** Journal and broadcast one plain call, such as an ETH transfer, at this account's next nonce. */
  async sendCall(call: RelayCall): Promise<RelayCallBroadcast> {
    if (!/^0x[0-9a-fA-F]{40}$/.test(call.to)) throw new RelayValidationError("call recipient must be a 20-byte address");
    const value = call.value ?? 0n;
    const data = call.data ?? "0x";
    fromHex(data, "call data");
    if (value < 0n) throw new RelayValidationError("call value must be nonnegative");
    const status = await this.rpc("reading PCASH node status", () => this.#node.status());
    const client = this.client(status);
    const broadcast = await this.#withAdmission([], async (entries) => {
      await this.verifyIdentity(status);
      const [fees, nonce, gasLimit] = await Promise.all([
        this.#fees(status),
        this.#nextNonce(client, entries),
        call.gasLimit ?? this.rpc("estimating call gas", () => client.estimateGas({
          account: this.address as Address,
          to: call.to as Address,
          value,
          data: data as Hex,
        })),
      ]);
      const maximumCost = value + gasLimit * fees.maxFeePerGas;
      if (fees.balance < maximumCost) {
        throw new RelayUpstreamError(
          `L1 submitter ${this.address} is underfunded: balance ${fees.balance} wei < maximum call cost ${maximumCost} wei`,
        );
      }
      const request: RelayTransactionRequest = {
        chainId: status.l1ChainId,
        nonce,
        to: call.to,
        value,
        data,
        gasLimit,
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
        blobs: null,
      };
      return this.broadcast({ status, request, journalEntry: (values) => this.#callEntry(status, request, values) });
    });
    return {
      txHash: broadcast.txHash,
      settle: this.#settling(broadcast.resolutionId, async () => {
        const receipt = await this.#receipt(client, broadcast.txHash);
        await this.journal.clear(broadcast.resolutionId);
        if (receipt.status !== "success") throw new RelayUpstreamError(`L1 call ${broadcast.txHash} reverted`);
        return {
          txHash: broadcast.txHash,
          blockNumber: receipt.blockNumber,
          blockHash: receipt.blockHash,
          transactionIndex: receipt.transactionIndex,
          gasUsed: receipt.gasUsed,
        };
      }),
    };
  }
}

function batchRequest(
  status: StatusResult,
  batch: string,
  quote: RelayCarrierQuote,
  nonce: number,
): RelayTransactionRequest {
  const common = {
    chainId: status.l1ChainId,
    nonce,
    to: status.inboxAddress,
    value: 0n,
    gasLimit: quote.gasLimit,
    maxFeePerGas: quote.maxFeePerGas,
    maxPriorityFeePerGas: quote.maxPriorityFeePerGas,
  };
  if (quote.carrier === "calldata") return { ...common, data: batch, blobs: null };
  if (quote.maxFeePerBlobGas === null) throw new RelayValidationError("blob quote has no blob fee cap");
  return {
    ...common,
    data: "0x",
    blobs: { maxFeePerBlobGas: quote.maxFeePerBlobGas, quote },
  };
}

function relayBatchItemIndexes(metadata: RelaySubmissionMetadata): number[] {
  const indexes = metadata.batchItemIndexes === undefined
    ? metadata.selected.map((_contentHash, index) => index)
    : [...metadata.batchItemIndexes];
  if (
    indexes.length !== metadata.selected.length
    || indexes.some((index) => !Number.isSafeInteger(index) || index < 0)
    || new Set(indexes).size !== indexes.length
  ) {
    throw new RelayValidationError("relay batch item indexes must be unique nonnegative safe integers");
  }
  return indexes;
}
