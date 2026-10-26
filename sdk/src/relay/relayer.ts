// High-level mempool inspection and one-shot relay orchestration.
//
// Relaying owns secret payout material, but no transaction proving authority. Like Wallet,
// the high-level type owns policy and concurrency while node access and the
// side-effecting L1 submitter are injected capabilities.

import { PRIVATE_VALUE_PROFILES } from "../constants/privateValueProfiles.ts";
import { BN254_SCALAR_MODULUS } from "../crypto/field.ts";
import { assertMempoolAdmissible } from "../clients/admission.ts";
import type {
  L1DeliveryBatchResult,
  MempoolItemResult,
  MempoolPageResult,
  MempoolQuery,
  PcashNodeClient,
  PrepareRelayRejection,
  PrepareRelayResult,
  StatusResult,
} from "../clients/index.ts";
import { encodeBatchForVersion, issuanceTerms, posterPayoutOpening, selectBatchVersion, type TransactionOutcome } from "../protocol/index.ts";
import { keccak256, randomFieldEntropy, toHex } from "../utils/index.ts";
import { fromHex } from "../utils/hex.ts";
import { serialQueue } from "../utils/serial.ts";
import { MAX_PCASH_BATCH_BLOBS, pcashBlobPayloadCapacity } from "../l1/blob.ts";
import {
  RelayDeadlineError,
  RelayUpstreamError,
  RelayValidationError,
  relayFailure,
  withRelayDeadline,
} from "./errors.ts";
import {
  batchExpectedIssuance,
  DEFAULT_ISSUANCE_WINDOW_BLOCKS,
  discountIssuance,
  estimateOtherQualifyingActions,
  nextBlockIssuanceQuote,
  recentBlockEconomics,
  selectRelayCandidates,
  type RelayValuation,
} from "./valuation.ts";
import { inspectPrivateRelayValue } from "./selected.ts";

const CONTENT_HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;

export const MAX_RELAY_CONTENT_HASHES = 64;
const DEFAULT_MAX_PAGES = 41;
const DEFAULT_PAGE_ITEMS = 100;
const DEFAULT_NODE_RPC_TIMEOUT_MS = 30_000;
const DEFAULT_ISSUANCE_HAIRCUT_BPS = 5_000;
/** pcash_getBlockEconomics returns at most this many records per page. */
const MAX_ISSUANCE_WINDOW_BLOCKS = 1_024;
/** Fresh valuations an automatic cycle may take when the head moves under it. */
const MAX_AUTOMATIC_REVALUATIONS = 2;


export type RelayDaMode = "auto" | "calldata" | "blobs";
export type RelayCarrier = Exclude<RelayDaMode, "auto">;

/** Blob-first bulk publishing is policy; explicit calldata and calldata-only hosts remain valid. */
export function preferredRelayDaMode(entries: readonly Uint8Array[], mode: RelayDaMode, carriers: readonly RelayCarrier[]): RelayDaMode {
  return mode === "auto" && carriers.includes("blobs")
    && entries.some(entry => entry[0] === 0 && entry[5] === PRIVATE_VALUE_PROFILES.L.shapeId)
    ? "blobs" : mode;
}

export type RelayCarrierQuote = {
  gasLimit: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  maxFeePerBlobGas: bigint | null;
  blobCount: number;
  blobVersionedHashes: string[];
  estimatedCostWei: bigint;
  maximumCostWei: bigint;
  balanceWei: bigint;
} & ({ carrier: "calldata" } | {
  carrier: "blobs";
  sidecars: { data: string; commitment: string; proof: string }[];
});

export interface RelayQuoteSet {
  selected: RelayCarrierQuote;
  calldata?: RelayCarrierQuote;
  blobs?: RelayCarrierQuote;
}

/** Canonical per-transaction classification captured while observing L1 inclusion. */
export interface RelayTransactionOutcome {
  transactionId: string;
  outcome: TransactionOutcome;
  accepted: boolean;
  kind: string;
  l1BlockHash: string;
  l1TransactionIndex: bigint;
  batchItemIndex: bigint;
}

export interface RelaySubmissionResult {
  txHash: string;
  receipt: {
    status: number;
    blockNumber: bigint;
    blockHash: string;
    transactionIndex: number;
    gasUsed: bigint;
  };
  observed: boolean;
  /** Present when the node observation completed; absent on deadline aborts. */
  outcomes?: RelayTransactionOutcome[];
  /** Present when batch delivery diagnostics drove observation. */
  delivery?: L1DeliveryBatchResult;
}

export interface RelaySubmissionMetadata {
  /** Direct callers own their bytes; mempool batches are independently reconstructed. */
  source?: "direct" | "mempool";
  selected: string[];
  /** Actual batch positions for selected transactions; defaults to their array indexes. */
  batchItemIndexes?: readonly number[];
  /** Discover parser-level item exclusions from the canonical L1 delivery before reading receipts. */
  observationMode?: "selected" | "batch";
  collectibleOpenFee: bigint;
  headCheckedBlock: bigint;
  headCheckedBlockHash: string;
}

/**
 * A broadcast batch whose settlement the caller awaits separately. The caller
 * must settle it: until then, a full journal in this process waits on it.
 */
export interface RelayBroadcast {
  txHash: string;
  /** Wait for inclusion and the node's observation, then release the journal entry. */
  settle(): Promise<RelaySubmissionResult>;
}

/** L1 capability injected into Relayer by a platform host. */
export interface RelaySubmitter {
  readonly address: string;
  readonly supportedCarriers: readonly RelayCarrier[];
  /** Platform payload capacity, applied before selecting transactions. */
  readonly maxBatchBytes?: bigint;
  /** Fail fast when the account's journal cannot take another transaction. */
  assertAvailable(): Promise<void>;
  /** Lowercase content hashes carried by the account's in-flight batches. */
  inFlight(): Promise<string[]>;
  quote(status: StatusResult, batch: string, mode: RelayDaMode): Promise<RelayQuoteSet>;
  /** Journal and broadcast one batch, returning once it is broadcast. */
  send(
    status: StatusResult,
    batch: string,
    quote: RelayCarrierQuote,
    metadata: RelaySubmissionMetadata,
  ): Promise<RelayBroadcast>;
}

export interface RelayerOptions {
  /** Explicit ordered content hashes. Empty/omitted selects automatically. */
  contentHashes?: readonly string[];
  /** L1 carrier policy. Auto prefers blobs for L, otherwise quotes both carriers. */
  daMode?: RelayDaMode;
  /** Maximum canonical batch capacity, expressed as 1 through 6 blobs. */
  maxBlobs?: number;
  /** Exact batch-byte cap for operator hosts. Mutually exclusive with maxBlobs. */
  maxBatchBytes?: bigint;
  /** Prepare and quote, but do not sign or broadcast. */
  noSubmit?: boolean;
  /** Optional per-request endpoint understood by the host's submitter factory. */
  l1Rpc?: string;
}

/** What a prepared automatic batch is expected to add to this relayer's block issuance. */
export interface RelayBatchValuation {
  /** Other posters' qualifying actions assumed in the block. */
  otherQualifyingActions: bigint;
  /** Per-action issuance assumed for the block. */
  rewardEach: bigint;
  /** Issuance the batch adds for this relayer, before the haircut. */
  expectedIssuance: bigint;
  /** expectedIssuance after the issuance haircut. */
  discountedExpectedIssuance: bigint;
}

export interface RelayerResult extends PrepareRelayResult {
  /** Final exact bytes, framed locally after node selection. */
  batch: string;
  status: StatusResult;
  automatic: boolean;
  requested: string[];
  maxBlobs: number;
  maxBatchBytes: bigint;
  /** Mempool transactions examined by automatic policy; zero for explicit IDs. */
  considered: number;
  /** Ordinary encrypted native notes opened by this relayer in the selected batch. */
  collectiblePrivateFee: bigint;
  /** Automatic selection only; explicit content hashes are relayed as given. */
  valuation: RelayBatchValuation | null;
  submitted: boolean;
  carrier: RelayCarrier | null;
  quotes: RelayQuoteSet | null;
  txHash?: string;
  receipt?: RelaySubmissionResult["receipt"];
  observed?: boolean;
  outcomes?: RelayTransactionOutcome[];
}

type RelayNode = Pick<
  PcashNodeClient,
  "status" | "getMempool" | "getMempoolTransaction" | "getReceipt" | "prepareRelay" | "getIssuanceQuote" | "getBlockEconomics"
>;

export interface RelayerConfig {
  payoutRecipient: RelayPayoutRecipient | ((status: StatusResult) => Promise<RelayPayoutRecipient>);
  /** Operator-configured commitments; discovered quote control is scoped to exact transaction hashes. */
  controlledIssuanceOwnerCommitments?: readonly string[];
  node: RelayNode;
  submitterFor?: (l1Rpc?: string) => RelaySubmitter;
  maxPages?: number;
  /** Wall-clock deadline for each PCASH node operation. */
  nodeRpcTimeoutMs?: number;
  /** PCASH publication cost per encoded transaction byte; fee plus discounted expected issuance must cover it. */
  minValuePerByte?: bigint;
  /** Minimum native note value counted as a private relay payment. */
  minPrivateFee?: bigint;
  /** Discount on positive expected issuance in basis points (default 5000); fees are never discounted. */
  issuanceHaircutBps?: number;
  /** Recent blocks averaged to estimate other posters' qualifying actions (default 64). */
  issuanceWindowBlocks?: number;
  /** This relayer's own qualifying actions expected in the same block outside the mempool candidates. */
  selfMinedActions?: bigint;
  /**
   * After paying transactions, also relay every remaining fitting transaction,
   * including ones that pay this relayer nothing or fall below the byte floor.
   */
  sponsorUnpaid?: boolean;
  /** Take ready transactions this old first, ignoring the byte floor; unpaid ones still need sponsorUnpaid. */
  maxWaitMs?: bigint;
  /** Maximum transactions handed to one prepareRelay request. */
  maxTransactions?: number;
  /** Deterministic wall clock for policy tests and simulations. */
  nowUnixMs?: () => bigint;
}

export interface RelayPayoutRecipient {
  address: bigint;
  nkRoot: bigint;
  /** Present for relayers that inspect ordinary encrypted native fee notes. */
  mlKemSecretKey?: Uint8Array;
}

interface PrivateTransactionInspection {
  privateFeeByContentHash: Map<string, bigint>;
  collectibleByContentHash: Map<string, bigint>;
  controlledByContentHash: Map<string, bigint>;
}

interface RelayerPreflight {
  submitter: RelaySubmitter;
  daMode: RelayDaMode;
  maxBlobs: number;
  maxBatchBytes: bigint;
  requested: string[] | null;
}

/** Exact candidate-batch payload capacity of `blobCount` canonical blobs. */
export function relayBatchCapacity(blobCount: number): bigint {
  if (!Number.isInteger(blobCount) || blobCount < 1 || blobCount > MAX_PCASH_BATCH_BLOBS) {
    throw new RelayValidationError(`maxBlobs must be an integer from 1 through ${MAX_PCASH_BATCH_BLOBS}`);
  }
  return BigInt(pcashBlobPayloadCapacity(blobCount));
}

function assertContentHash(contentHash: string): void {
  if (!CONTENT_HASH_PATTERN.test(contentHash)) {
    throw new RelayValidationError(`content hash must be a 32-byte 0x-prefixed hex string: ${contentHash}`);
  }
}

function uniqueContentHashes(contentHashes: readonly string[]): string[] {
  if (contentHashes.length > MAX_RELAY_CONTENT_HASHES) {
    throw new RelayValidationError(`relay accepts at most ${MAX_RELAY_CONTENT_HASHES} content hashes`);
  }
  const seen = new Set<string>();
  return contentHashes.map((contentHash) => {
    assertContentHash(contentHash);
    const normalized = contentHash.toLowerCase();
    if (seen.has(normalized)) throw new RelayValidationError(`duplicate relay content hash ${contentHash}`);
    seen.add(normalized);
    return contentHash;
  });
}

/**
 * A configured designated commitment: a nonzero canonical field element as a
 * 32-byte 0x-hex word. The node refuses any prepareRelay request listing
 * another value, so one bad entry would stop every relay.
 */
function controlledCommitment(commitment: string): bigint {
  const value = /^0x[0-9a-fA-F]{64}$/.test(commitment) ? BigInt(commitment) : 0n;
  if (value === 0n || value >= BN254_SCALAR_MODULUS) {
    throw new RelayValidationError(`controlledIssuanceOwnerCommitments must be nonzero 32-byte 0x-hex field elements: ${commitment}`);
  }
  return value;
}

function batchValuation(valuation: RelayValuation, prepared: PrepareRelayResult): RelayBatchValuation {
  const { rewardEach, expectedIssuance } = batchExpectedIssuance(
    valuation,
    prepared.collectibleQualifyingActions,
    prepared.selectedQualifyingActions,
  );
  return {
    otherQualifyingActions: valuation.otherQualifyingActions,
    rewardEach,
    expectedIssuance,
    discountedExpectedIssuance: discountIssuance(expectedIssuance, valuation.issuanceHaircutBps),
  };
}

function sameContentHashes(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && left.every((entry, index) => entry.toLowerCase() === right[index]?.toLowerCase());
}

function preparedAtStatusHead(prepared: PrepareRelayResult, status: StatusResult): boolean {
  return preparedAt(prepared, { blockNumber: status.latestBlock, blockHash: status.latestBlockHash });
}

function preparedAt(prepared: PrepareRelayResult, block: ValuationParent): boolean {
  return prepared.headCheckedBlock === block.blockNumber
    && prepared.headCheckedBlockHash.toLowerCase() === block.blockHash.toLowerCase();
}

/** The canonical block whose successor a valuation's issuance terms describe. */
interface ValuationParent {
  blockNumber: bigint;
  blockHash: string;
}

/**
 * A profile-free relay capability. Mempool reads can be used without an L1
 * submitter; preparation and relay require the host to configure one.
 */
export class Relayer {
  readonly #node: RelayNode;
  readonly #payoutRecipient: RelayerConfig["payoutRecipient"];
  readonly #controlledIssuanceOwnerCommitments: readonly string[];
  readonly #controlled: ReadonlySet<bigint>;
  readonly #submitterFor: ((l1Rpc?: string) => RelaySubmitter) | undefined;
  readonly #maxPages: number;
  readonly #nodeRpcTimeoutMs: number;
  readonly #minValuePerByte: bigint;
  readonly #minPrivateFee: bigint;
  readonly #issuanceHaircutBps: number;
  readonly #issuanceWindowBlocks: number;
  readonly #selfMinedActions: bigint;
  readonly #sponsorUnpaid: boolean;
  readonly #maxWaitMs: bigint | undefined;
  readonly #maxTransactions: number;
  readonly #nowUnixMs: () => bigint;
  readonly #runSerialized = serialQueue();

  constructor(config: RelayerConfig) {
    this.#node = config.node;
    this.#payoutRecipient = config.payoutRecipient;
    this.#controlledIssuanceOwnerCommitments = config.controlledIssuanceOwnerCommitments ?? [];
    this.#controlled = new Set(this.#controlledIssuanceOwnerCommitments.map(controlledCommitment));
    this.#submitterFor = config.submitterFor;
    this.#maxPages = config.maxPages ?? DEFAULT_MAX_PAGES;
    this.#nodeRpcTimeoutMs = config.nodeRpcTimeoutMs ?? DEFAULT_NODE_RPC_TIMEOUT_MS;
    this.#minValuePerByte = config.minValuePerByte ?? 0n;
    this.#minPrivateFee = config.minPrivateFee ?? 0n;
    this.#issuanceHaircutBps = config.issuanceHaircutBps ?? DEFAULT_ISSUANCE_HAIRCUT_BPS;
    this.#issuanceWindowBlocks = config.issuanceWindowBlocks ?? DEFAULT_ISSUANCE_WINDOW_BLOCKS;
    this.#selfMinedActions = config.selfMinedActions ?? 0n;
    this.#sponsorUnpaid = config.sponsorUnpaid ?? false;
    this.#maxWaitMs = config.maxWaitMs;
    this.#maxTransactions = config.maxTransactions ?? MAX_RELAY_CONTENT_HASHES;
    this.#nowUnixMs = config.nowUnixMs ?? (() => BigInt(Date.now()));
    if (!Number.isInteger(this.#maxPages) || this.#maxPages < 1) {
      throw new RelayValidationError("maxPages must be a positive integer");
    }
    if (!Number.isSafeInteger(this.#nodeRpcTimeoutMs) || this.#nodeRpcTimeoutMs < 1) {
      throw new RelayValidationError("nodeRpcTimeoutMs must be a positive integer");
    }
    if (this.#minValuePerByte < 0n) {
      throw new RelayValidationError("minValuePerByte must be nonnegative");
    }
    if (this.#minPrivateFee < 0n) {
      throw new RelayValidationError("minPrivateFee must be nonnegative");
    }
    if (!Number.isInteger(this.#issuanceHaircutBps) || this.#issuanceHaircutBps < 0 || this.#issuanceHaircutBps > 10_000) {
      throw new RelayValidationError("issuanceHaircutBps must be an integer from 0 through 10000");
    }
    if (
      !Number.isInteger(this.#issuanceWindowBlocks)
      || this.#issuanceWindowBlocks < 1
      || this.#issuanceWindowBlocks > MAX_ISSUANCE_WINDOW_BLOCKS
    ) {
      throw new RelayValidationError(`issuanceWindowBlocks must be an integer from 1 through ${MAX_ISSUANCE_WINDOW_BLOCKS}`);
    }
    if (this.#selfMinedActions < 0n) {
      throw new RelayValidationError("selfMinedActions must be nonnegative");
    }
    if (this.#maxWaitMs !== undefined && this.#maxWaitMs < 0n) {
      throw new RelayValidationError("maxWaitMs must be nonnegative");
    }
    if (!Number.isInteger(this.#maxTransactions) || this.#maxTransactions < 1 || this.#maxTransactions > MAX_RELAY_CONTENT_HASHES) {
      throw new RelayValidationError(`maxTransactions must be an integer from 1 through ${MAX_RELAY_CONTENT_HASHES}`);
    }
  }

  async getMempool(query: MempoolQuery = {}): Promise<MempoolPageResult> {
    return this.#nodeRpc("reading the mempool", () => this.#node.getMempool(query));
  }

  async getMempoolTransaction(contentHash: string): Promise<MempoolItemResult | null> {
    assertContentHash(contentHash);
    return this.#nodeRpc(
      `reading mempool content ${contentHash}`,
      () => this.#node.getMempoolTransaction(contentHash),
    );
  }

  async relay(options: RelayerOptions = {}): Promise<RelayerResult> {
    // Concurrent relays for one L1 account serialize selection through
    // broadcast, so each sees the batches journaled before it and selects
    // around them. Settlement runs outside, so batches overlap on L1.
    const settle = await this.#runSerialized(() => this.#relay(options));
    return settle();
  }

  #configuredSubmitter(l1Rpc?: string): RelaySubmitter {
    const submitter = this.#submitterFor?.(l1Rpc);
    if (submitter === undefined) {
      throw new RelayValidationError("relay is not configured: the wallet service needs --l1-rpc and an L1 key");
    }
    return submitter;
  }

  async #preflight(options: RelayerOptions): Promise<RelayerPreflight> {
    const daMode = options.daMode ?? "auto";
    if (daMode !== "auto" && daMode !== "calldata" && daMode !== "blobs") {
      throw new RelayValidationError("daMode expects auto, calldata, or blobs");
    }
    if (options.maxBlobs !== undefined && options.maxBatchBytes !== undefined) {
      throw new RelayValidationError("maxBlobs and maxBatchBytes are mutually exclusive");
    }
    let maxBlobs: number;
    let maxBatchBytes: bigint;
    if (options.maxBatchBytes !== undefined) {
      maxBatchBytes = options.maxBatchBytes;
      if (maxBatchBytes < 1n || maxBatchBytes > relayBatchCapacity(MAX_PCASH_BATCH_BLOBS)) {
        throw new RelayValidationError(`maxBatchBytes must be between 1 and ${relayBatchCapacity(MAX_PCASH_BATCH_BLOBS)}`);
      }
      maxBlobs = Array.from({ length: MAX_PCASH_BATCH_BLOBS }, (_, index) => index + 1)
        .find((count) => relayBatchCapacity(count) >= maxBatchBytes)!;
    } else {
      maxBlobs = options.maxBlobs ?? 3;
      maxBatchBytes = relayBatchCapacity(maxBlobs);
    }
    const requested = options.contentHashes === undefined || options.contentHashes.length === 0
      ? null
      : uniqueContentHashes(options.contentHashes);
    const submitter = this.#configuredSubmitter(options.l1Rpc);
    if (submitter.maxBatchBytes !== undefined && maxBatchBytes > submitter.maxBatchBytes) {
      maxBatchBytes = submitter.maxBatchBytes;
      maxBlobs = Array.from({ length: MAX_PCASH_BATCH_BLOBS }, (_, index) => index + 1)
        .find((count) => relayBatchCapacity(count) >= maxBatchBytes)!;
    }
    await submitter.assertAvailable();
    if (daMode !== "auto" && !submitter.supportedCarriers.includes(daMode)) {
      throw new RelayValidationError(`relay submitter does not support ${daMode}`);
    }
    return { submitter, daMode, maxBlobs, maxBatchBytes, requested };
  }

  async #allMempoolItems(): Promise<MempoolItemResult[]> {
    const seen = new Set<string>();
    const items: MempoolItemResult[] = [];
    let cursor: string | undefined;
    for (let pageNumber = 0; pageNumber < this.#maxPages; pageNumber += 1) {
      const page = await this.#nodeRpc("reading a mempool page", () => this.#node.getMempool({
        ...(cursor === undefined ? {} : { cursor }),
        limit: DEFAULT_PAGE_ITEMS,
      }));
      for (const item of page.items) {
        if (!seen.has(item.contentHash.toLowerCase())) {
          seen.add(item.contentHash.toLowerCase());
          items.push(item);
        }
      }
      if (
        page.nextCursor === null
        || page.items.length === 0
        || page.nextCursor.toLowerCase() === cursor?.toLowerCase()
      ) {
        break;
      }
      cursor = page.nextCursor;
    }
    return items;
  }

  async #inspectReadyEntries(
    items: readonly MempoolItemResult[],
    status: StatusResult,
    recipient: RelayPayoutRecipient,
  ): Promise<PrivateTransactionInspection> {
    const inspection: PrivateTransactionInspection = {
      privateFeeByContentHash: new Map(),
      collectibleByContentHash: new Map(),
      controlledByContentHash: new Map(),
    };
    if (recipient.mlKemSecretKey === undefined) return inspection;
    const candidates = items.filter((item) => item.status === "ready"
      && item.openFeeAmount === 0n && item.kind !== "userAccountCreation"
      && item.kind !== "contractAccount");
    for (const candidate of candidates) {
      const full = candidate.rawTransaction === null
        ? await this.#nodeRpc("reading mempool content " + candidate.contentHash, () =>
          this.#node.getMempoolTransaction(candidate.contentHash))
        : candidate;
      if (full?.rawTransaction === null || full?.rawTransaction === undefined) continue;
      const raw = fromHex(full.rawTransaction, "mempool transaction");
      if (full.contentHash.toLowerCase() !== candidate.contentHash.toLowerCase()
        || toHex(keccak256(raw)).toLowerCase() !== candidate.contentHash.toLowerCase()) {
        throw new RelayUpstreamError("mempool transaction content hash changed during private fee inspection");
      }
      const value = inspectPrivateRelayValue({
        transactionBytes: raw, status,
        recipient: {
          address: recipient.address, nkRoot: recipient.nkRoot,
          mlKemSecretKey: recipient.mlKemSecretKey,
        },
      });
      const contentHash = candidate.contentHash.toLowerCase();
      if (value.nativeAmount > 0n) {
        inspection.collectibleByContentHash.set(contentHash, value.nativeAmount);
      }
      if (value.nativeAmount > 0n && value.nativeAmount >= this.#minPrivateFee) {
        inspection.privateFeeByContentHash.set(contentHash, value.nativeAmount);
      }
      if (value.issuanceOwnerCommitment !== null) {
        inspection.controlledByContentHash.set(contentHash, value.issuanceOwnerCommitment);
      }
    }
    return inspection;
  }

  #controlledWords(contentHashes: readonly string[], items: readonly MempoolItemResult[]): string[] {
    const byHash = new Map(items.map((item) => [item.contentHash.toLowerCase(), item]));
    const values = new Set<string>();
    for (const hash of contentHashes) {
      const normalized = hash.toLowerCase();
      const commitment = byHash.get(normalized)?.issuanceRoute === "designated"
        && this.#controlled.has(BigInt(byHash.get(normalized)!.issuanceOwnerCommitment))
        ? BigInt(byHash.get(normalized)!.issuanceOwnerCommitment) : undefined;
      if (commitment !== undefined) values.add("0x" + commitment.toString(16).padStart(64, "0"));
    }
    return [...values];
  }

  #controlledHashes(contentHashes: readonly string[], inspection: PrivateTransactionInspection): string[] {
    return contentHashes.filter((hash) => inspection.controlledByContentHash.has(hash.toLowerCase()));
  }

  /**
   * Issuance terms and other posters' expected actions for the block after the
   * quote's canonical parent, which a node without a canonical tip replaces
   * with `status`.
   */
  async #valuation(status: StatusResult, inspection: PrivateTransactionInspection): Promise<{ valuation: RelayValuation; parent: ValuationParent }> {
    const quote = await this.#nodeRpc("reading the issuance quote", () => nextBlockIssuanceQuote(this.#node, status));
    const economics = await this.#nodeRpc("reading block economics", () =>
      recentBlockEconomics(this.#node, status.latestBlock, this.#issuanceWindowBlocks));
    return {
      valuation: {
        terms: issuanceTerms(quote),
        otherQualifyingActions: estimateOtherQualifyingActions(economics.records),
        selfMinedActions: this.#selfMinedActions,
        issuanceHaircutBps: this.#issuanceHaircutBps,
        controlled: this.#controlled,
        controlledByContentHash: inspection.controlledByContentHash,
        privateFeeByContentHash: inspection.privateFeeByContentHash,
      },
      parent: quote?.parent ?? { blockNumber: status.latestBlock, blockHash: status.latestBlockHash },
    };
  }

  #prepare(what: string, contentHashes: string[], maxBatchBytes: bigint,
    controlledIssuanceOwnerCommitments: readonly string[] = this.#controlledIssuanceOwnerCommitments,
    controlledIssuanceContentHashes: readonly string[] = []): Promise<PrepareRelayResult> {
    return this.#nodeRpc(what, () => this.#node.prepareRelay({
      contentHashes,
      controlledIssuanceOwnerCommitments,
      controlledIssuanceContentHashes,
      maxBatchBytes,
    }));
  }

  async #prepareAutomatic(
    submitter: RelaySubmitter,
    maxBatchBytes: bigint,
  ): Promise<{ requested: string[]; prepared: PrepareRelayResult; considered: number; valuation: RelayValuation | null; parent: ValuationParent; inspection: PrivateTransactionInspection; recipient?: RelayPayoutRecipient }> {
    // Transactions this account already carries in an unsettled batch still read
    // as ready until the node derives it; posting them again would waste a carrier.
    const inFlight = new Set(await submitter.inFlight());
    const items = (await this.#allMempoolItems()).filter((item) => !inFlight.has(item.contentHash.toLowerCase()));
    if (items.length === 0) {
      const prepared = await this.#prepare("preparing an empty automatic relay batch", [], maxBatchBytes);
      return {
        requested: [],
        prepared,
        considered: 0,
        valuation: null,
        inspection: { privateFeeByContentHash: new Map(), collectibleByContentHash: new Map(), controlledByContentHash: new Map() },
        parent: { blockNumber: prepared.headCheckedBlock, blockHash: prepared.headCheckedBlockHash },
      };
    }

    const status = await this.#nodeRpc("reading node status for private relay inspection", () => this.#node.status());
    const recipient = typeof this.#payoutRecipient === "function" ? await this.#payoutRecipient(status) : this.#payoutRecipient;
    const inspection = await this.#inspectReadyEntries(items, status, recipient);

    const isSafeFeeOnly = this.#selfMinedActions === 0n && !this.#sponsorUnpaid;
    const feeOnlyValuation: RelayValuation = {
      terms: issuanceTerms(null),
      otherQualifyingActions: 0n,
      selfMinedActions: 0n,
      issuanceHaircutBps: 10_000,
      controlled: this.#controlled,
      controlledByContentHash: inspection.controlledByContentHash,
      privateFeeByContentHash: inspection.privateFeeByContentHash,
    };

    let valuationForSelection: RelayValuation;
    let valuation: RelayValuation | null;
    let parent: ValuationParent | null;

    if (isSafeFeeOnly && this.#issuanceHaircutBps === 10_000) {
      valuationForSelection = feeOnlyValuation;
      valuation = null;
      parent = null;
    } else {
      try {
        const result = await this.#valuation(status, inspection);
        valuationForSelection = result.valuation;
        valuation = result.valuation;
        parent = result.parent;
      } catch (error) {
        if (isSafeFeeOnly && (error instanceof RelayUpstreamError || error instanceof RelayDeadlineError)) {
          valuationForSelection = feeOnlyValuation;
          valuation = null;
          parent = null;
        } else {
          throw error;
        }
      }
    }

    const policy = {
      maxBatchBytes,
      maxTransactions: this.#maxTransactions,
      minValuePerByte: this.#minValuePerByte,
      sponsorUnpaid: this.#sponsorUnpaid,
      ...(this.#maxWaitMs === undefined ? {} : { maxWaitMs: this.#maxWaitMs }),
      nowUnixMs: this.#nowUnixMs(),
    };
    const select = (candidates: readonly MempoolItemResult[]) =>
      selectRelayCandidates(candidates, policy, valuationForSelection).map((item) => item.contentHash);
    let requested = select(items);
    let prepared = await this.#prepare("preparing an automatic relay batch", requested, maxBatchBytes,
      this.#controlledWords(requested, items), this.#controlledHashes(requested, inspection));

    // Revalidation can remove a conflicting transaction after selection. Select once
    // more without it; a second current-head preparation remains authoritative.
    const permanentlyRejected = new Set(
      prepared.rejected
        .filter((entry) => entry.reason !== "max batch bytes")
        .map((entry) => entry.contentHash.toLowerCase()),
    );
    if (permanentlyRejected.size > 0) {
      const refilled = select(items.filter((item) => !permanentlyRejected.has(item.contentHash.toLowerCase())));
      if (!sameContentHashes(refilled, requested)) {
        requested = refilled;
        prepared = await this.#prepare("re-preparing an automatic relay batch", requested, maxBatchBytes,
          this.#controlledWords(requested, items), this.#controlledHashes(requested, inspection));
      }
    }
    return {
      requested,
      prepared,
      considered: items.length,
      valuation,
      inspection,
      recipient,
      parent: parent ?? { blockNumber: prepared.headCheckedBlock, blockHash: prepared.headCheckedBlockHash },
    };
  }

  /** Select, prepare, quote, and broadcast; the returned function settles the broadcast batch. */
  async #relay(options: RelayerOptions): Promise<() => Promise<RelayerResult>> {
    const preflight = await this.#preflight(options);
    const { submitter, daMode, maxBlobs, maxBatchBytes } = preflight;

    const automatic = preflight.requested === null;
    let requested: string[];
    let prepared: PrepareRelayResult;
    let considered: number;
    let valuation: RelayValuation | null;
    let status: StatusResult;
    let inspection: PrivateTransactionInspection;
    let payoutRecipient: RelayPayoutRecipient | undefined;
    if (preflight.requested === null) {
      // Issuance terms describe the block after their quote's parent. Publish
      // only a batch prepared at that parent while it is still the head;
      // otherwise value, select, and prepare again.
      for (let attempt = 0; ; attempt += 1) {
        const batch = await this.#prepareAutomatic(submitter, maxBatchBytes);
        status = await this.#nodeRpc("reading node status for relay", () => this.#node.status());
        if (preparedAt(batch.prepared, batch.parent) && preparedAtStatusHead(batch.prepared, status)) {
          ({ requested, prepared, considered, valuation, inspection, recipient: payoutRecipient } = batch);
          break;
        }
        if (attempt === MAX_AUTOMATIC_REVALUATIONS) {
          throw new RelayUpstreamError("Node head moved during relay valuation; try again");
        }
      }
    } else {
      requested = preflight.requested;
      considered = 0;
      valuation = null;
      const inspectionStatus = await this.#nodeRpc("reading node status for explicit relay inspection", () => this.#node.status());
      const inspectionRecipient = typeof this.#payoutRecipient === "function"
        ? await this.#payoutRecipient(inspectionStatus) : this.#payoutRecipient;
      const requestedItems = (await Promise.all(requested.map((hash) =>
        this.#nodeRpc("reading explicit mempool content " + hash, () => this.#node.getMempoolTransaction(hash)))))
        .filter((item): item is MempoolItemResult => item !== null);
      inspection = await this.#inspectReadyEntries(requestedItems, inspectionStatus, inspectionRecipient);
      payoutRecipient = inspectionRecipient;
      const controlledWords = this.#controlledWords(requested, requestedItems);
      const controlledHashes = this.#controlledHashes(requested, inspection);
      prepared = await this.#prepare("preparing an explicit relay batch", requested, maxBatchBytes,
        controlledWords, controlledHashes);
      status = await this.#nodeRpc("reading node status for relay", () => this.#node.status());
      if (!preparedAtStatusHead(prepared, status)) {
        prepared = await this.#prepare("re-preparing a relay batch at the current head", requested, maxBatchBytes,
          controlledWords, controlledHashes);
        status = await this.#nodeRpc("re-reading node status for relay", () => this.#node.status());
      }
      if (!preparedAtStatusHead(prepared, status)) {
        throw new RelayUpstreamError("Node head moved during relay preparation; try again");
      }
    }
    if (prepared.selectedTransactions.length !== prepared.selectedContentHashes.length) throw new RelayUpstreamError("Node selection lengths disagree");
    const entries = prepared.selectedTransactions.map((hex, index) => {
      const entry = fromHex(hex, "selected transaction");
      if (toHex(keccak256(entry)).toLowerCase() !== prepared.selectedContentHashes[index]!.toLowerCase()) throw new RelayUpstreamError("Node selection content hash mismatch");
      try {
        assertMempoolAdmissible(status, entry);
      } catch (error) {
        throw new RelayUpstreamError("Node selected a transaction its mempool cannot admit", error);
      }
      return entry;
    });
    const collectiblePrivateFee = prepared.selectedContentHashes.reduce((sum, hash) =>
      sum + (inspection.collectibleByContentHash.get(hash.toLowerCase()) ?? 0n), 0n);
    payoutRecipient ??= typeof this.#payoutRecipient === "function" ? await this.#payoutRecipient(status) : this.#payoutRecipient;
    const poster = posterPayoutOpening(payoutRecipient.address, payoutRecipient.nkRoot, randomFieldEntropy());
    const batchBytes = encodeBatchForVersion(entries, selectBatchVersion(status), poster.ownerCommitment, poster.context);
    if (BigInt(batchBytes.length) > maxBatchBytes || prepared.batchBytes !== BigInt(batchBytes.length)) throw new RelayUpstreamError("Node relay selection size is inconsistent");
    const batch = toHex(batchBytes);
    const common = {
      ...prepared,
      batch,
      status,
      automatic,
      requested,
      maxBlobs,
      maxBatchBytes,
      considered,
      valuation: valuation === null ? null : batchValuation(valuation, prepared),
      collectiblePrivateFee,
    };
    if (prepared.selectedContentHashes.length === 0) {
      const result: RelayerResult = {
        ...common,
        submitted: false,
        carrier: null,
        quotes: null,
      };
      return async () => result;
    }

    const quotes = await submitter.quote(status, batch, preferredRelayDaMode(entries, daMode, submitter.supportedCarriers));
    if (options.noSubmit === true) {
      const result: RelayerResult = {
        ...common,
        submitted: false,
        carrier: quotes.selected.carrier,
        quotes,
      };
      return async () => result;
    }

    const broadcast = await submitter.send(status, batch, quotes.selected, {
      selected: prepared.selectedContentHashes,
      collectibleOpenFee: prepared.collectibleOpenFee,
      headCheckedBlock: prepared.headCheckedBlock,
      headCheckedBlockHash: prepared.headCheckedBlockHash,
    });
    return async () => {
      const submission = await broadcast.settle();
      return {
        ...common,
        submitted: true,
        carrier: quotes.selected.carrier,
        quotes,
        txHash: submission.txHash,
        receipt: submission.receipt,
        observed: submission.observed,
        ...(submission.outcomes === undefined ? {} : { outcomes: submission.outcomes }),
      };
    };
  }

  async #nodeRpc<T>(what: string, operation: () => Promise<T>): Promise<T> {
    try {
      return await withRelayDeadline(what, this.#nodeRpcTimeoutMs, operation);
    } catch (error) {
      throw relayFailure(what, error);
    }
  }
}

export type { MempoolQuery, PrepareRelayRejection };
