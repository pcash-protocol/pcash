import type { StatusResult, PcashNodeClient } from "../clients/index.ts";
import type { Transport } from "viem";
import { numberToHex } from "viem";
import { sameHex } from "../utils/hex.ts";
import { sleep } from "../utils/time.ts";
import {
  RelayL1Submitter,
  type RelayBroadcastContext,
  type RelayBroadcastResult,
  type RelayFeeContext,
  type RelayL1SubmitterConfig,
  type RelayTransactionRequest,
} from "./l1Submitter.ts";
import {
  Relayer,
  type RelayBroadcast,
  type RelayCarrierQuote,
  type RelayDaMode,
  type RelayQuoteSet,
  type RelaySubmissionMetadata,
  type RelayerConfig,
} from "./relayer.ts";
import type { RelayJournal } from "./journal.ts";
import {
  RelayDeadlineError,
  RelayUpstreamError,
  RelayValidationError,
  RelayPreBroadcastError,
  upstreamQuantity,
  withRelayDeadline,
} from "./errors.ts";

const DEFAULT_TRANSACTION_LOOKUP_TIMEOUT_MS = 30_000;
const TRANSACTION_LOOKUP_POLL_MS = 250;
// Leave 8 KiB for the signed transaction envelope below a 128 KiB pool limit.
export const MAX_BROWSER_RELAY_BATCH_BYTES = 120n * 1024n;

export interface Eip1193Provider {
  request(args: { method: string; params?: readonly unknown[] | object }): Promise<unknown>;
}

export interface Eip1193RelaySubmitterConfig extends Omit<RelayL1SubmitterConfig, "address"> {
  provider: Eip1193Provider;
  address: string;
  createResolutionId?: () => string;
  transactionLookupTimeoutMs?: number;
  /** Called after the wallet's transaction hash is durable, before confirmation. */
  onBroadcast?: (transactionHash: string) => void | Promise<void>;
}

function parsedQuantity(value: unknown, label: string): bigint {
  return upstreamQuantity(value, `injected wallet returned an invalid ${label}`);
}

function parsedHash(value: unknown): string {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new RelayUpstreamError("injected wallet returned an invalid transaction hash");
  }
  return value;
}

function providerMessage(message: string): string {
  return message
    .replace(/((?:data|input|rawTransaction|signedTransaction)["']?\s*[:=]\s*["']?)0x[0-9a-f]*/gi, "$1[redacted]")
    .replace(/0x[0-9a-f]{64,}/gi, "[hex data]")
    .split(/\r?\n/, 1)[0]!
    .slice(0, 300);
}

function providerFailure(error: unknown): { detail: string; refused: boolean; rejected: boolean } {
  const seen = new Set<object>();
  const entries: Array<{ code: number | undefined; message: string }> = [];
  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      entries.push({ code: undefined, message: providerMessage(value) });
      return;
    }
    if (value === null || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    const record = value as Record<string, unknown>;
    const code = typeof record.code === "number" ? record.code
      : typeof record.code === "string" && /^-?[0-9]+$/.test(record.code) ? Number(record.code) : undefined;
    const message = typeof record.message === "string" ? providerMessage(record.message) : "";
    if (code !== undefined || message !== "") entries.push({ code, message });
    for (const key of ["cause", "error", "data", "originalError"]) visit(record[key]);
  };
  visit(error);
  const rejected = entries.some(({ code }) => code === 4001);
  const uncertain = entries.some(({ message }) => /nonce|already known|known transaction/i.test(message));
  const refused = rejected || (!uncertain && entries.some(({ code, message }) =>
    [4100, 4200, -32601, -32602].includes(code ?? 0)
    || /^(?:error: )?(?:oversized data\b|transaction size exceeds\b|intrinsic gas too low\b|exceeds block gas limit\b|transaction gas limit exceeds\b|insufficient funds\b)/i.test(message),
  ));
  const detail = entries.map(({ code, message }) =>
    `${code === undefined ? "" : `[${code}] `}${message}`.trim(),
  ).join("; ").slice(0, 1_000) || "No provider error details";
  return { detail, refused, rejected };
}

function assertBrowserBatchSize(batch: string): void {
  const bytes = (batch.length - (batch.startsWith("0x") ? 2 : 0)) / 2;
  if (BigInt(bytes) > MAX_BROWSER_RELAY_BATCH_BYTES) {
    throw new RelayValidationError(`browser relay batch is ${bytes} bytes; maximum is ${MAX_BROWSER_RELAY_BATCH_BYTES} bytes`);
  }
}

function accounts(value: unknown): string[] {
  if (
    !Array.isArray(value)
    || value.some((account) => typeof account !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(account))
  ) {
    throw new RelayUpstreamError("injected wallet returned an invalid account list");
  }
  return value as string[];
}

/** Calldata-only injected-wallet authority for the shared SDK relay engine. */
export class Eip1193RelaySubmitter extends RelayL1Submitter {
  protected readonly supportsBlobs = false;
  readonly maxBatchBytes = MAX_BROWSER_RELAY_BATCH_BYTES;
  readonly #provider: Eip1193Provider;
  readonly #createResolutionId: () => string;
  readonly #transactionLookupTimeoutMs: number;
  readonly #onBroadcast: Eip1193RelaySubmitterConfig["onBroadcast"];

  constructor(config: Eip1193RelaySubmitterConfig) {
    super(config);
    this.#provider = config.provider;
    this.#onBroadcast = config.onBroadcast;
    this.#createResolutionId = config.createResolutionId ?? (() => crypto.randomUUID());
    this.#transactionLookupTimeoutMs = config.transactionLookupTimeoutMs
      ?? DEFAULT_TRANSACTION_LOOKUP_TIMEOUT_MS;
    if (!Number.isInteger(this.#transactionLookupTimeoutMs) || this.#transactionLookupTimeoutMs < 1) {
      throw new RelayValidationError("transactionLookupTimeoutMs must be a positive integer");
    }
  }

  async quote(status: StatusResult, batch: string, mode: RelayDaMode): Promise<RelayQuoteSet> {
    assertBrowserBatchSize(batch);
    return super.quote(status, batch, mode);
  }

  async send(status: StatusResult, batch: string, quote: RelayCarrierQuote, metadata: RelaySubmissionMetadata): Promise<RelayBroadcast> {
    assertBrowserBatchSize(batch);
    return super.send(status, batch, quote, metadata);
  }

  protected quoteBlobCarrier(
    _status: StatusResult,
    _batch: Uint8Array,
    _fees: RelayFeeContext,
  ): Promise<RelayCarrierQuote> {
    return Promise.reject(new RelayValidationError(
      "browser injected-wallet relaying is calldata-only",
    ));
  }

  protected async verifyAuthority(status: StatusResult): Promise<void> {
    let chainId: bigint;
    let connected: string[];
    try {
      chainId = parsedQuantity(
        await this.#provider.request({ method: "eth_chainId" }),
        "chain id",
      );
      connected = accounts(await this.#provider.request({ method: "eth_accounts" }));
    } catch (error) {
      if (error instanceof RelayUpstreamError) throw error;
      throw new RelayUpstreamError("reading injected wallet identity failed", error);
    }
    if (chainId !== status.l1ChainId) {
      throw new RelayValidationError(
        `injected wallet is on chain ${chainId}, expected ${status.l1ChainId}`,
      );
    }
    if (!connected.some((account) => account.toLowerCase() === this.address.toLowerCase())) {
      throw new RelayValidationError(`injected wallet is not connected to relay account ${this.address}`);
    }
  }

  #assertTransaction(
    value: unknown,
    request: RelayTransactionRequest,
    transactionHash: string,
  ): void {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new RelayUpstreamError(`injected wallet cannot read relay transaction ${transactionHash}`);
    }
    const transaction = value as Record<string, unknown>;
    if (transaction.hash !== undefined && !sameHex(transaction.hash, transactionHash)) {
      throw new RelayUpstreamError("injected wallet returned transaction details for another hash");
    }
    if (!sameHex(transaction.from, this.address)
      || !sameHex(transaction.to, request.to)
      || !sameHex(transaction.input, request.data)) {
      throw new RelayUpstreamError("injected wallet changed the relay sender, destination, or calldata");
    }
    // Transaction lookups may omit chainId, such as for legacy transactions or a
    // wallet's own pending copy; the wallet's chain was checked before sending.
    if (transaction.chainId !== undefined && transaction.chainId !== null
      && parsedQuantity(transaction.chainId, "chainId") !== request.chainId) {
      throw new RelayUpstreamError("injected wallet changed relay transaction field chainId");
    }
    // The wallet chooses its transaction envelope and approved gas settings.
    // Delivery depends on the call above and its receipt, not the envelope type.
    for (const [field, expected] of [
      ["nonce", BigInt(request.nonce)],
      ["value", request.value],
    ] as const) {
      if (parsedQuantity(transaction[field], field) !== expected) {
        throw new RelayUpstreamError(`injected wallet changed relay transaction field ${field}`);
      }
    }
  }

  async #readTransaction(transactionHash: string): Promise<unknown> {
    const deadline = Date.now() + this.#transactionLookupTimeoutMs;
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new RelayDeadlineError(
          `reading injected-wallet relay transaction ${transactionHash} timed out`,
        );
      }
      const transaction = await withRelayDeadline(
        `reading injected-wallet relay transaction ${transactionHash}`,
        remaining,
        () => this.#provider.request({
          method: "eth_getTransactionByHash",
          params: [transactionHash],
        }),
      );
      if (transaction !== null) return transaction;
      await sleep(Math.min(TRANSACTION_LOOKUP_POLL_MS, Math.max(0, deadline - Date.now())));
    }
  }

  protected async broadcast(context: RelayBroadcastContext): Promise<RelayBroadcastResult> {
    const { request } = context;
    if (request.blobs !== null) {
      throw new RelayValidationError("browser injected-wallet relaying is calldata-only");
    }
    const resolutionId = this.#createResolutionId();
    if (resolutionId.trim() === "") throw new RelayValidationError("relay resolution id is empty");
    const entry = context.journalEntry({
      resolutionId,
      phase: "broadcast_attempted",
      submissionKind: "eip1193_intent",
      transactionHash: null,
      signedTransaction: null,
    });
    await this.journal.create(entry);

    let transactionHash: string;
    try {
      transactionHash = parsedHash(await this.#provider.request({
        method: "eth_sendTransaction",
        params: [{
          chainId: numberToHex(request.chainId),
          from: this.address,
          to: request.to,
          data: request.data,
          value: numberToHex(request.value),
          type: "0x2",
          nonce: numberToHex(BigInt(request.nonce)),
          gas: numberToHex(request.gasLimit),
          maxFeePerGas: numberToHex(request.maxFeePerGas),
          maxPriorityFeePerGas: numberToHex(request.maxPriorityFeePerGas),
        }],
      }));
    } catch (error) {
      const failure = providerFailure(error);
      if (failure.refused) {
        await this.journal.clear(resolutionId);
        throw new RelayPreBroadcastError(new RelayValidationError(
          `injected wallet ${failure.rejected ? "rejected" : "refused"} relay submission: ${failure.detail}`,
          error,
        ));
      }
      throw new RelayUpstreamError(
        `Wallet did not confirm whether the transaction was sent: ${failure.detail}`,
        error,
      );
    }

    const accepted = { ...entry, phase: "broadcast_accepted" as const, transactionHash };
    await this.journal.replace(accepted);
    await this.#onBroadcast?.(transactionHash);
    let transaction: unknown;
    try {
      transaction = await this.#readTransaction(transactionHash);
    } catch (error) {
      if (error instanceof RelayDeadlineError) throw error;
      throw new RelayUpstreamError(
        `reading injected-wallet relay transaction ${transactionHash} failed`,
        error,
      );
    }
    this.#assertTransaction(transaction, request, transactionHash);
    return { txHash: transactionHash, resolutionId, entry: accepted };
  }
}

export interface BrowserLockManager {
  request<T>(
    name: string,
    options: { mode: "exclusive" },
    callback: () => Promise<T>,
  ): Promise<T>;
}

/** Cross-tab serialization for one injected L1 account. */
export function browserRelayOperationQueue(
  address: string,
  locks: BrowserLockManager | undefined = globalThis.navigator?.locks,
): <T>(operation: () => Promise<T>) => Promise<T> {
  const name = `pcash-relayer:${address.toLowerCase()}`;
  return async <T>(operation: () => Promise<T>) => {
    if (locks === undefined) {
      throw new RelayValidationError(
        "this browser cannot serialize L1 relay submissions across tabs",
      );
    }
    return locks.request(name, { mode: "exclusive" }, operation);
  };
}

export interface BrowserRelayerConfig {
  payoutRecipient: RelayerConfig["payoutRecipient"];
  controlledIssuanceOwnerCommitments?: readonly string[];
  node: RelayerConfig["node"] & Pick<PcashNodeClient, "getInboxDeliveryBatch">;
  rpcUrl: string;
  provider: Eip1193Provider;
  address: string;
  journal: RelayJournal;
  minValuePerByte?: bigint;
  maxPages?: number;
  maxFeePerGas?: bigint;
  transportFor?: (rpcUrl: string) => Transport;
  runExclusive?: <T>(operation: () => Promise<T>) => Promise<T>;
  createResolutionId?: () => string;
  receiptTimeoutMs?: number;
  receiptPollMs?: number;
  observationTimeoutMs?: number;
  observationPollMs?: number;
  transactionLookupTimeoutMs?: number;
}

/** Construct one browser Relayer whose requests share one journal and lock. */
export function createBrowserRelayer(config: BrowserRelayerConfig): Relayer {
  const runExclusive = config.runExclusive ?? browserRelayOperationQueue(config.address);
  return new Relayer({
    node: config.node,
    payoutRecipient: config.payoutRecipient,
    ...(config.controlledIssuanceOwnerCommitments === undefined
      ? {}
      : { controlledIssuanceOwnerCommitments: config.controlledIssuanceOwnerCommitments }),
    ...(config.minValuePerByte === undefined ? {} : { minValuePerByte: config.minValuePerByte }),
    ...(config.maxPages === undefined ? {} : { maxPages: config.maxPages }),
    submitterFor(l1RpcOverride) {
      const rpcUrl = l1RpcOverride ?? config.rpcUrl;
      return new Eip1193RelaySubmitter({
        rpcUrl,
        provider: config.provider,
        address: config.address,
        node: config.node,
        journal: config.journal,
        runExclusive,
        ...(config.transportFor === undefined ? {} : { transport: config.transportFor(rpcUrl) }),
        ...(config.maxFeePerGas === undefined ? {} : { maxFeePerGas: config.maxFeePerGas }),
        ...(config.createResolutionId === undefined ? {} : { createResolutionId: config.createResolutionId }),
        ...(config.receiptTimeoutMs === undefined ? {} : { receiptTimeoutMs: config.receiptTimeoutMs }),
        ...(config.receiptPollMs === undefined ? {} : { receiptPollMs: config.receiptPollMs }),
        ...(config.observationTimeoutMs === undefined ? {} : { observationTimeoutMs: config.observationTimeoutMs }),
        ...(config.observationPollMs === undefined ? {} : { observationPollMs: config.observationPollMs }),
        ...(config.transactionLookupTimeoutMs === undefined
          ? {}
          : { transactionLookupTimeoutMs: config.transactionLookupTimeoutMs }),
      });
    },
  });
}
