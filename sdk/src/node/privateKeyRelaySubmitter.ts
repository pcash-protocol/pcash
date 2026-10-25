// Private-key Ethereum authority for the shared SDK relay submission engine.

import { SigningKey, Transaction } from "ethers";
import { loadKZG } from "kzg-wasm";
import {
  commitmentToVersionedHash,
  numberToHex,
  type Address,
  type Hex,
  type TransactionReceipt,
} from "viem";
import type { StatusResult } from "../clients/index.ts";
import {
  BYTES_PER_PCASH_BLOB,
  encodePcashBlobs,
  relayerAccount,
  requireL1Identity,
} from "../l1/index.ts";
import { toHex } from "../utils/hex.ts";
import {
  RelayL1Submitter,
  type RelayBroadcastContext,
  type RelayBroadcastResult,
  type RelayFeeContext,
  type RelayL1SubmitterConfig,
  type RelayTransactionRequest,
  type ExtendedFeeHistory,
} from "../relay/l1Submitter.ts";
import type { RelayCarrierQuote } from "../relay/relayer.ts";
import {
  RelayUpstreamError,
  RelayValidationError,
  RelayDeadlineError,
  RelayFeeCeilingError,
  relayFailure,
  upstreamQuantity,
  withRelayDeadline,
} from "../relay/errors.ts";
import type { RelayJournalEntry } from "../relay/journal.ts";
import { findJournalReceipt, journalL1Receipt, RECOVERY_RPC_TIMEOUT_MS } from "../relay/recovery.ts";
import { sleep } from "../utils/time.ts";

const BLOB_FEE_CAP_MULTIPLIER = 2n;

type BlobSidecar = { data: string; commitment: string; proof: string };

type Kzg = Awaited<ReturnType<typeof loadKZG>>;

export function retryableInitialization<T>(load: () => Promise<T>): () => Promise<T> {
  let shared: Promise<T> | undefined;
  return () => {
    if (shared !== undefined) return shared;
    const attempt = load();
    shared = attempt;
    void attempt.catch(() => {
      if (shared === attempt) shared = undefined;
    });
    return attempt;
  };
}

const defaultKzg = retryableInitialization(loadKZG);

function concatenateHex(values: readonly string[]): string {
  return `0x${values.map((value) => value.startsWith("0x") ? value.slice(2) : value).join("")}`;
}

interface SignedRelayTransaction {
  hash: string;
  raw: string;
}

export interface PrivateKeyRelaySubmitterConfig extends Omit<RelayL1SubmitterConfig, "address"> {
  privateKey: string;
  loadKzg?: () => Promise<Kzg>;
  /** Replace after this many L1 blocks, or sooner if a base fee exceeds its cap. Default 3. */
  replacementAfterBlocks?: number;
}

/** Durable EIP-1559/EIP-7594 authority used by Node hosts. */
export class PrivateKeyRelaySubmitter extends RelayL1Submitter {
  protected readonly supportsBlobs = true;
  readonly #privateKey: string;
  readonly #loadKzg: () => Promise<Kzg>;
  readonly #replacementAfterBlocks: bigint;

  constructor(config: PrivateKeyRelaySubmitterConfig) {
    const account = relayerAccount(config.privateKey);
    super({ ...config, address: account.address });
    this.#privateKey = config.privateKey;
    this.#loadKzg = config.loadKzg ?? defaultKzg;
    const replacementAfterBlocks = config.replacementAfterBlocks ?? 3;
    if (!Number.isSafeInteger(replacementAfterBlocks) || replacementAfterBlocks < 1) {
      throw new RelayValidationError("replacementAfterBlocks must be a positive safe integer");
    }
    this.#replacementAfterBlocks = BigInt(replacementAfterBlocks);
  }

  #beforeDeadline<T>(deadline: number, what: string, operation: () => Promise<T>): Promise<T> {
    const remaining = Math.min(RECOVERY_RPC_TIMEOUT_MS, deadline - Date.now());
    if (remaining <= 0) throw new RelayDeadlineError(`${what} timed out`);
    return withRelayDeadline(what, remaining, () => this.rpc(what, operation));
  }

  #receipt(entry: RelayJournalEntry, deadline: number) {
    return findJournalReceipt(entry, (hash) => this.#beforeDeadline(deadline, "reading the journal L1 receipt", () =>
      journalL1Receipt(entry, this.rpcUrl, this.transport, hash)));
  }

  async #verifyJournalIdentity(entry: RelayJournalEntry, deadline: number): Promise<void> {
    // Another process can supply this journal's records; bind a send to its
    // recorded account and L1 network before using the configured signer.
    if (entry.relayerAddress.toLowerCase() !== this.address.toLowerCase()) {
      throw new RelayValidationError("relay journal belongs to another signing account");
    }
    await this.#beforeDeadline(deadline, "verifying replacement L1 identity", () => requireL1Identity(this.rpcUrl, {
      chainId: BigInt(entry.chainId), anchorNumber: BigInt(entry.genesisL1Block), anchorHash: entry.genesisL1BlockHash,
    }, { transport: this.transport }));
  }

  /** Send already-journaled bytes. A retry does not create another signed attempt. */
  async #sendSaved(entry: RelayJournalEntry, deadline: number): Promise<RelayJournalEntry> {
    const client = this.client({ l1ChainId: BigInt(entry.chainId) });
    try {
      const hash = await this.#beforeDeadline(deadline, "broadcasting the saved transaction", () => client.sendRawTransaction({
        serializedTransaction: entry.signedTransaction as Hex,
      }));
      if (hash.toLowerCase() !== entry.transactionHash!.toLowerCase()) {
        throw new RelayUpstreamError(`L1 returned transaction hash ${hash}, expected ${entry.transactionHash}`);
      }
    } catch (error) {
      // An earlier attempt can mine between the receipt read and the send.
      if (await this.#receipt(entry, deadline) !== null) return entry;
      // A lost response can be followed by "already known". Establish receipt
      // by the endpoint rather than leaving that attempt ambiguous forever.
      const known = await this.#beforeDeadline(deadline, "looking up the saved transaction", () =>
        client.getTransaction({ hash: entry.transactionHash as Hex })).catch(() => null);
      if (known === null) throw error;
      if (known.hash.toLowerCase() !== entry.transactionHash!.toLowerCase()) {
        throw new RelayUpstreamError(`L1 returned transaction ${known.hash}, expected ${entry.transactionHash}`);
      }
    }
    const accepted = { ...entry, phase: "broadcast_accepted" as const };
    await this.journal.replace(accepted);
    return accepted;
  }

  protected override async batchReceipt(status: StatusResult, broadcast: RelayBroadcastResult): Promise<TransactionReceipt> {
    const deadline = Date.now() + this.receiptTimeoutMs;
    let entry = broadcast.entry;
    while (Date.now() < deadline) {
      const receipt = await this.runExclusive(async () => {
        const current = (await this.journal.read()).find((candidate) => candidate.resolutionId === entry.resolutionId);
        // Recovery may have cleared a mined entry while this handle was waiting.
        entry = current ?? entry;
        const mined = await this.#receipt(entry, deadline);
        if (mined !== null) return mined.receipt;
        if (current !== undefined) entry = await this.maintainPending(current, deadline);
        return null;
      });
      if (receipt !== null) return receipt;
      await sleep(Math.min(this.receiptPollMs ?? this.client(status).pollingInterval, Math.max(0, deadline - Date.now())));
    }
    throw new RelayDeadlineError("waiting for relay inclusion timed out");
  }

  protected override async maintainPending(
    entry: RelayJournalEntry,
    deadline = Date.now() + RECOVERY_RPC_TIMEOUT_MS,
  ): Promise<RelayJournalEntry> {
    if (entry.kind !== "batch" || entry.submissionKind !== "signed_raw") return entry;
    const client = this.client({ l1ChainId: BigInt(entry.chainId) });
    const read = <T>(what: string, operation: () => Promise<T>) => this.#beforeDeadline(deadline, what, operation);
    const head = await read("reading the replacement L1 head", () => client.getBlock({ blockTag: "latest" }));
    if (head.number <= BigInt(entry.lastBroadcastBlock!)) return entry;
    const history = await read("reading replacement fee history", () => client.request({
      method: "eth_feeHistory", params: ["0x1", numberToHex(head.number), []],
    })) as unknown as ExtendedFeeHistory;
    const baseFee = upstreamQuantity(history.baseFeePerGas?.at(-1), "next execution base fee is missing from L1 fee history");
    const blobBaseFee = entry.carrier === "blobs"
      ? history.baseFeePerBlobGas?.at(-1) === undefined
        ? await read("reading the blob base fee", () => client.getBlobBaseFee())
        : upstreamQuantity(history.baseFeePerBlobGas.at(-1), "next blob base fee is missing from L1 fee history")
      : 0n;
    const canInclude = baseFee <= BigInt(entry.maxFeePerGas)
      && (entry.carrier !== "blobs" || blobBaseFee <= BigInt(entry.maxFeePerBlobGas!));
    if (entry.phase === "broadcast_attempted" && canInclude) {
      if (this.maxFeePerGas !== undefined && BigInt(entry.maxFeePerGas) > this.maxFeePerGas) {
        throw new RelayFeeCeilingError(entry.resolutionId, entry.transactionHash!, this.maxFeePerGas);
      }
      await this.#verifyJournalIdentity(entry, deadline);
      const retry = { ...entry, lastBroadcastBlock: head.number.toString() };
      // Persist the throttle before sending, including sends that fail again.
      await this.journal.replace(retry);
      return this.#sendSaved(retry, deadline);
    }
    if (head.number - BigInt(entry.lastBroadcastBlock!) < this.#replacementAfterBlocks
      && canInclude) return entry;

    const estimate = await read("estimating replacement fees", () => client.estimateFeesPerGas());
    // Default geth/reth pools require 10% for type 2 and 100% for all type-3 fees.
    const bump = (fee: bigint): bigint => {
      const rounded = (fee * (entry.carrier === "blobs" ? 200n : 110n) + 99n) / 100n;
      return rounded > fee ? rounded : fee + 1n;
    };
    const max = (a: bigint, b: bigint) => a > b ? a : b;
    const minimumTip = bump(BigInt(entry.maxPriorityFeePerGas));
    const minimumCap = bump(BigInt(entry.maxFeePerGas));
    let tip = max(minimumTip, estimate.maxPriorityFeePerGas);
    let cap = max(minimumCap, max(estimate.maxFeePerGas, baseFee + tip));
    if (this.maxFeePerGas !== undefined) {
      if (minimumCap > this.maxFeePerGas || baseFee + minimumTip > this.maxFeePerGas) {
        throw new RelayFeeCeilingError(entry.resolutionId, entry.transactionHash!, this.maxFeePerGas);
      }
      cap = cap > this.maxFeePerGas ? this.maxFeePerGas : cap;
      tip = tip > cap - baseFee ? cap - baseFee : tip;
    }
    const blobCap = entry.carrier === "blobs"
      ? max(bump(BigInt(entry.maxFeePerBlobGas!)), blobBaseFee * BLOB_FEE_CAP_MULTIPLIER)
      : null;
    await this.#verifyJournalIdentity(entry, deadline);
    const transaction = Transaction.from(entry.signedTransaction!);
    const balance = await read("checking replacement balance", () => client.getBalance({ address: this.address as Address }));
    const maximumCost = transaction.value + transaction.gasLimit * cap
      + BigInt(transaction.blobVersionedHashes?.length ?? 0) * BigInt(BYTES_PER_PCASH_BLOB) * (blobCap ?? 0n);
    if (balance < maximumCost) throw new RelayUpstreamError(`L1 submitter ${this.address} is underfunded for a replacement`);
    transaction.signature = null;
    transaction.maxPriorityFeePerGas = tip;
    transaction.maxFeePerGas = cap;
    if (blobCap !== null) transaction.maxFeePerBlobGas = blobCap;
    transaction.signature = new SigningKey(this.#privateKey).sign(transaction.unsignedHash);
    const replacement: RelayJournalEntry = {
      ...entry,
      phase: "broadcast_attempted",
      previousTransactionHashes: [...entry.previousTransactionHashes, entry.transactionHash!],
      transactionHash: transaction.hash!,
      signedTransaction: transaction.serialized,
      lastBroadcastBlock: head.number.toString(),
      maxPriorityFeePerGas: tip.toString(),
      maxFeePerGas: cap.toString(),
      maxFeePerBlobGas: blobCap?.toString() ?? null,
    };
    await this.journal.replace(replacement);
    return this.#sendSaved(replacement, deadline);
  }

  async #blobBaseFee(status: StatusResult): Promise<bigint> {
    const history = await this.feeHistory(status, "reading blob fee history");
    const next = history.baseFeePerBlobGas?.at(-1);
    if (next !== undefined) return upstreamQuantity(next, "next blob base fee is missing from L1 fee history");
    return this.rpc("reading the blob base fee", () => this.client(status).getBlobBaseFee());
  }

  protected async quoteBlobCarrier(
    status: StatusResult,
    batch: Uint8Array,
    fees: RelayFeeContext,
  ): Promise<RelayCarrierQuote> {
    const [kzg, blobBaseFee] = await Promise.all([
      this.#loadKzg().catch((error: unknown) => { throw relayFailure("loading KZG", error); }),
      this.#blobBaseFee(status),
    ]);
    const blobs = encodePcashBlobs(batch);
    const commitments = blobs.map((blob) => kzg.blobToKZGCommitment(toHex(blob)) as Hex);
    const sidecars: BlobSidecar[] = blobs.map((blob, index) => {
      const data = toHex(blob);
      const { proofs } = kzg.computeCellsAndKZGProofs(data);
      return { data, commitment: commitments[index]!, proof: concatenateHex(proofs) };
    });
    const versionedHashes = commitments.map((commitment) =>
      commitmentToVersionedHash({ commitment }) as Hex
    );
    const maxFeePerBlobGas = blobBaseFee * BLOB_FEE_CAP_MULTIPLIER;
    const gasLimit = await this.relayGasLimit(() => this.client(status).estimateGas({
      account: this.address as Address,
      to: status.inboxAddress as Address,
      data: "0x",
      value: 0n,
      type: "eip4844",
      blobVersionedHashes: versionedHashes,
      maxFeePerBlobGas,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    }));
    // EIP-4844 charges one unit of blob gas per blob byte.
    const blobGas = BigInt(blobs.length) * BigInt(BYTES_PER_PCASH_BLOB);
    return {
      carrier: "blobs",
      sidecars,
      gasLimit,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      maxFeePerBlobGas,
      blobCount: blobs.length,
      blobVersionedHashes: versionedHashes,
      estimatedCostWei: gasLimit * fees.executionGasPrice + blobGas * blobBaseFee,
      maximumCostWei: gasLimit * fees.maxFeePerGas + blobGas * maxFeePerBlobGas,
      balanceWei: fees.balance,
    };
  }

  async #sign(request: RelayTransactionRequest): Promise<SignedRelayTransaction> {
    const common = {
      chainId: request.chainId,
      nonce: request.nonce,
      maxPriorityFeePerGas: request.maxPriorityFeePerGas,
      maxFeePerGas: request.maxFeePerGas,
      gasLimit: request.gasLimit,
      to: request.to,
      value: request.value,
      accessList: [],
    };
    let transaction: Transaction;
    if (request.blobs === null) {
      transaction = Transaction.from({ ...common, type: 2, data: request.data });
    } else {
      transaction = Transaction.from({
        ...common,
        type: 3,
        data: request.data,
        maxFeePerBlobGas: request.blobs.maxFeePerBlobGas,
        blobWrapperVersion: 1,
        blobs: request.blobs.quote.sidecars,
      });
    }
    transaction.signature = new SigningKey(this.#privateKey).sign(transaction.unsignedHash);
    return { hash: transaction.hash!, raw: transaction.serialized };
  }

  protected async broadcast(context: RelayBroadcastContext): Promise<RelayBroadcastResult> {
    const signed = await this.#sign(context.request);
    const entry = context.journalEntry({
      resolutionId: signed.hash,
      phase: "broadcast_attempted",
      submissionKind: "signed_raw",
      transactionHash: signed.hash,
      signedTransaction: signed.raw,
    });
    if (entry.kind === "batch") {
      const head = await this.rpc("reading the broadcast L1 head", () => this.client(context.status).getBlock({ blockTag: "latest" }));
      entry.lastBroadcastBlock = head.number.toString();
    }
    await this.journal.create(entry);
    const broadcastHash = await this.rpc("broadcasting the signed relay transaction", () =>
      this.client(context.status).sendRawTransaction({ serializedTransaction: signed.raw as Hex })
    );
    if (broadcastHash.toLowerCase() !== signed.hash.toLowerCase()) {
      throw new RelayUpstreamError(
        `L1 returned transaction hash ${broadcastHash}, expected ${signed.hash}`,
      );
    }
    await this.journal.replace({ ...entry, phase: "broadcast_accepted" });
    return { txHash: signed.hash, resolutionId: signed.hash, entry };
  }
}
