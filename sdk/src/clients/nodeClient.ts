import { verifyResultProof, type ResultProofRpc, type ResultPosition } from "./resultProof.ts";
import { PRIVATE_VALUE_PROFILES, privateValueProfile, type PrivateValueProfile, type PrivateValueShape } from "../constants/privateValueProfiles.ts";
// PCASH node JSON-RPC client. Thin, typed wrapper over the
// `pcash_*` namespace served by node/crates/rpc. Byte strings are lowercase
// fixed-width 0x hex; quantities are minimal JSON-RPC hex ("0x0" for zero). The
// transport's fetch is injectable so request/response shaping is unit-testable
// without a live node.

import {
  assertCatalogRecordIdentity,
  decodeCatalogInfo,
  decodeCatalogPage,
  decodeCatalogRecord,
  encodeCatalogArtifact,
  encodeCatalogGetQuery,
  encodeCatalogListQuery,
  type CatalogArtifact,
  type CatalogInfo,
  type CatalogListQuery,
  type CatalogPage,
  type CatalogRecord,
} from "../protocol/catalog.ts";
import {
  decodeContractBody,
  verifyContract,
  type FunctionSelector,
} from "../protocol/contract.ts";
import { decodeTransaction, TX_KIND_CONTRACT_ACCOUNT_CREATION } from "../protocol/codec.ts";
import type { DataRecord } from "../protocol/records.ts";
import {
  parseCurrentBoundaryEnvelope,
  type CurrentBoundaryEnvelope,
  type CurrentBoundaryEnvelopeRpc,
} from "../protocol/boundary.ts";
import { rootFromIndex } from "../crypto/merkle.ts";
import { accountStateCommitment, receiveKeyHash } from "../protocol/account.ts";
import { numberToHex } from "viem";
import { addressHex, bytes32Hex, fixedHex, fromHex, parseHexQuantity, toHex, type Hex } from "../utils/hex.ts";
import {
  array,
  bool,
  nodeRpc,
  nullable,
  oneOf,
  present,
  quantity,
  rpcObject,
  MAX_RPC_RESPONSE_BODY_BYTES,
  rpcOwn,
  rpcString,
  shape,
  str,
  type NodeRpcOptions,
  type Parser,
} from "./jsonRpc.ts";
import { bytesEqual } from "../utils/bytes.ts";
import { fieldToHex, toField } from "../crypto/field.ts";
import type { OutputFrontier } from "../crypto/outputWitnessTree.ts";
import type { PayoutComponent } from "../protocol/payout.ts";
import {
  nullifierProofRoot,
  nullifierProofSpent,
  parseCanonicalNullifier,
} from "../protocol/nullifierTree.ts";
import {
  BLOCK_HEADER_KEY_L1_ORIGIN_ROOT,
  BLOCK_HEADER_KEY_HISTORY_ROOT,
  BLOCK_HEADER_KEY_STATE_ROOT,
  BLOCK_HEADER_TREE_DEPTH,
  L1_ORIGIN_TREE_DEPTH,
  HISTORY_TREE_DEPTH,
  MERKLE_DEPTH,
  ML_KEM_768_PUBLIC_KEY_LENGTH,
  STATE_KEY_ACCOUNT_STATE_ROOT,
  STATE_TREE_DEPTH,
} from "../constants/params.ts";
import {
  TRANSACTION_OUTCOMES,
  verifyBlockHeaderPath,
  verifyL1OriginPath,
  verifyHistoryPath,
  verifyStatePath,
  type TransactionOutcome,
} from "../protocol/block.ts";

export type { TransactionOutcome };
import {
  L1_LOG_TREE_DEPTH,
  verifyNormalizedL1LogPath,
  type L1LogInput,
} from "../protocol/l1Logs.ts";

export interface ProverAssetsResult {
  assetSetId: string;
  baseUrl: string;
}

/**
 * Whether the node is deriving. `l1BlockNumber` is the first L1 block it has not derived, and
 * `sinceUnixMs` is when the state began. A stalled node retries its input; a halted one stays
 * halted until it is restarted.
 */
export type DerivationResult =
  | { state: "following"; sinceUnixMs: bigint }
  | { state: "stalled"; cause: "l1Rpc" | "blobs"; l1BlockNumber: bigint; sinceUnixMs: bigint }
  | {
    state: "halted";
    cause: "verifier" | "storage" | "l1Input" | "internal";
    l1BlockNumber: bigint;
    sinceUnixMs: bigint;
  };

export interface StatusResult {
  latestBlock: bigint;
  latestBlockHash: string;
  latestBlockTimestamp: bigint;
  finalizedBlock: bigint;
  finalizedBlockHash: string;
  finalizedBlockTimestamp: bigint;
  latestL1BlockNumber: bigint;
  latestL1BlockHash: string;
  /** Latest upstream L1 head observed by the node, or null before the follower's first refresh. */
  observedL1BlockNumber: bigint | null;
  derivation: DerivationResult;
  finalizedL1BlockNumber: bigint;
  finalizedL1BlockHash: string;
  stateRoot: string;
  l1OriginRoot: string;
  historyRoot: string;
  outputCount: bigint;
  issuedSoFar: bigint;
  supplyCap: bigint;
  totalSucceeded: bigint | null;
  totalFailed: bigint | null;
  totalTransactions: bigint | null;
  index: {
    status: string;
    cursor: { blockNumber: bigint; blockHash: string } | null;
  };
  /** Browser proving assets advertised by this deployment, or null when it hosts none. */
  proverAssets: ProverAssetsResult | null;
  pcashChainId: number;
  genesisHash: string;
  /** Transaction types accepted for mempool admission at the derived head. */
  acceptedTransactionTypes: number[];
  /** Batch encodings accepted when deriving L1 inbox carriers. */
  acceptedBatchVersions: number[];
  l1ChainId: bigint;
  inboxAddress: string;
  genesisL1Block: bigint;
  genesisL1BlockHash: string;
  forkCapability: {
    chainId: bigint;
    genesisHash: string;
    headTimestamp: bigint;
    currentForkCount: bigint;
    currentPrefixHash: string;
    nextActivationTimestamp: bigint;
    nextPrefixHash: string;
  };
}

/** Canonical PCASH block (`pcash_getBlockByNumber` / `pcash_getBlocks`). */
export interface BlockResult {
  number: bigint;
  hash: string;
  parentHash: string;
  timestamp: bigint;
  transactionResultsRoot: string;
  stateRoot: string;
  l1OriginRoot: string;
  historyRoot: string;
  transactionResultCount: bigint;
  transactionResults: BlockTransactionResult[];
  /** Exact canonical transaction bodies in the full response; null in compact form. */
  transactionBytes: string[] | null;
  l1Origin: {
    blockNumber: bigint;
    blockHash: string;
    blockTimestamp: bigint;
    l1LogsRoot: string;
    l1LogCount: bigint;
  };
}

export interface BlockTransactionResult {
  inclusion: InclusionIdResult;
  contentHash: string;
  transactionId: string;
  outcome: TransactionOutcome;
}

export interface IssuanceQuoteResult {
  parent: BlockIdResult & { timestamp: bigint };
  candidateTimestamp: bigint;
  supplyCap: bigint;
  issuedSoFar: bigint;
  baseline: bigint;
  internalOffer: bigint;
  blockAllowance: bigint;
  maxSingleActionReward: bigint;
  /** The lag multiplier applied to the baseline, scaled by 2^128. */
  multiplierQ: bigint;
  /** The parent's post-settlement lag in seconds, scaled by 2^128. */
  lagQ: bigint;
  exhausted: boolean;
  rewardPossible: boolean;
}

export interface BlockEconomicsQuery {
  fromBlock?: bigint;
  limit?: number;
  /** Consecutive PCASH blocks per record, aligned to multiples of this value. */
  bucket?: number;
}

/** One bucket of the per-block issuance series: totals sum over the bucket, rates and lag are the last block's. */
export interface BlockEconomicsRecordResult {
  firstBlock: bigint;
  lastBlock: bigint;
  firstTimestamp: bigint;
  lastTimestamp: bigint;
  blocks: bigint;
  qualifyingActions: bigint;
  issuanceTotal: bigint;
  openFeesTotal: bigint;
  rewardEach: bigint;
  baseline: bigint;
  internalOffer: bigint;
  blockAllowance: bigint;
  /** Post-settlement lag in seconds, scaled by 2^128. */
  lagQ: bigint;
}

export interface BlockEconomicsPageResult {
  atBlockNumber: bigint;
  atBlockHash: string;
  records: BlockEconomicsRecordResult[];
  /** The first block of the next bucket to request, or null at the indexed head. */
  nextBlock: bigint | null;
}

/** One system payout note, with one tagged component and its amount. */
interface SystemPayoutFields {
  amount: bigint;
  ownerCommitment: bigint;
  outputIndex: bigint;
  /** Designated: the transaction context. Poster: every contributing batch context. */
  contexts: bigint[];
}

export type SystemPayoutResult = SystemPayoutFields & (
  | { source: DesignatedPayoutSourceResult; component: "issuance" }
  | { source: PosterPayoutSourceResult; component: PayoutComponent }
);

export type PayoutRecordResult = SystemPayoutResult & {
  /** Poster groups have no source transaction ID. */
  transactionId: string | null;
  blockNumber: bigint;
  blockHash: string;
};

export type DesignatedPayoutSourceResult = { kind: "designatedIssuance"; l1TransactionIndex: bigint; batchItemIndex: bigint };
export type PosterPayoutSourceResult = { kind: "posterPayout"; l1TransactionIndices: bigint[] };
export type PayoutSourceResult = DesignatedPayoutSourceResult | PosterPayoutSourceResult;

function parsePayoutSource(value: unknown): PayoutSourceResult {
  const source = rpcObject(value, "payout source");
  const index = (value: unknown): bigint => {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("invalid payout source index");
    return BigInt(value);
  };
  if (source.kind === "designatedIssuance") {
    return { kind: source.kind, l1TransactionIndex: index(source.l1TransactionIndex), batchItemIndex: index(source.batchItemIndex) };
  }
  if (source.kind === "posterPayout" && Array.isArray(source.l1TransactionIndices)) {
    return { kind: source.kind, l1TransactionIndices: source.l1TransactionIndices.map(index) };
  }
  throw new Error("invalid payout source");
}

function parsePayoutContexts(value: unknown, label: string): bigint[] {
  const contexts = array(field)(value, label);
  if (contexts.length === 0) throw new Error(`${label} must not be empty`);
  return contexts;
}

const systemPayoutFields = {
  source: parsePayoutSource,
  component: oneOf("openFee", "issuance"),
  amount: quantity,
  ownerCommitment: field,
  outputIndex: quantity,
  contexts: parsePayoutContexts,
};
const parseSystemPayoutFields = shape(systemPayoutFields);
const parseSystemPayout: Parser<SystemPayoutResult> = (value, label) => {
  const payout = parseSystemPayoutFields(value, label);
  if (payout.source.kind === "designatedIssuance" && payout.component !== "issuance") {
    throw new Error(`${label} designated issuance must contain issuance`);
  }
  return payout as SystemPayoutResult;
};
const parseOutputPayout: Parser<Omit<PayoutRecordResult, "blockNumber" | "blockHash">> = (value, label) => ({
  ...shape({ transactionId: nullable(str) })(value, label),
  ...parseSystemPayout(value, label),
});
const parsePayoutRecord: Parser<PayoutRecordResult> = (value, label) => ({
  ...shape({ blockNumber: quantity, blockHash: str, transactionId: nullable(str) })(value, label),
  ...parseSystemPayout(value, label),
});

export interface PayoutCursor {
  anchor: BlockIdResult;
  nextBlock: bigint;
  nextPayoutIndex: bigint;
}

export interface PayoutPageResult {
  atBlockNumber: bigint;
  atBlockHash: string;
  records: PayoutRecordResult[];
  nextCursor: PayoutCursor | null;
}

export interface BlockPayoutsResult {
  block: BlockIdResult;
  openFeesTotal: bigint;
  issuanceTotal: bigint;
  payouts: SystemPayoutResult[];
}

export interface BlockIdResult {
  blockNumber: bigint;
  blockHash: string;
}

/** none: no issuance; open: the including poster; designated: a proof-bound commitment. */
export type IssuanceRoute = "none" | "open" | "designated";

/** PCASH-wei per tier, already scaled to the estimate's byte size. */
export interface FeeTiersResult {
  low: bigint;
  standard: bigint;
  fast: bigint;
}

export interface FeeEstimateBasisResult {
  includedSamples: bigint;
  included: FeeTiersResult | null;
  pendingSamples: bigint;
  pending: FeeTiersResult | null;
}

export interface FeeEstimateResult {
  head: BlockIdResult;
  windowBlocks: bigint;
  byteSize: bigint;
  tiers: FeeTiersResult;
  basis: FeeEstimateBasisResult;
}

export type FeeBearingKind = "privateValue" | "contractAccount" | "userAccountUpdate";

/** Supply a size or a kind's conservative default; explicit size takes precedence. */
export type FeeEstimateQuery =
  | { kind: FeeBearingKind; byteSize?: bigint }
  | { kind?: FeeBearingKind; byteSize: bigint };

export interface InclusionIdResult {
  l1BlockNumber: bigint;
  l1BlockHash: string;
  l1TransactionIndex: bigint;
  /** The L1 transaction that carried this batch. */
  l1TransactionHash: string;
  batchItemIndex: bigint;
}

export interface AccountReceiptResult {
  address: string;
  accountRevision: bigint;
}

export type FailureDetail =
  | { type: "publicInputNotInField"; publicInputIndex: bigint; supplied: string }
  | { type: "recentPcashBlockNotInWindow"; referencedBlockHash: string; windowStartTimestamp: bigint; windowEndTimestamp: bigint }
  | { type: "expired"; validUntil: bigint; blockTimestamp: bigint }
  | { type: "notYetValid"; notBefore: bigint; blockTimestamp: bigint }
  | { type: "zeroNullifier"; inputSlot: bigint }
  | { type: "duplicateInputNullifier"; firstInputSlot: bigint; duplicateInputSlot: bigint; nullifier: string }
  | { type: "nullifierAlreadySpent"; inputSlot: bigint; nullifier: string; spendingTransactionId: string }
  | { type: "outputCapacity" | "accountCapacity"; requestedCount: bigint; limit: bigint }
  | { type: "accountNotFound" | "clearWithoutReceiveKey"; address: string }
  | { type: "accountAlreadyExists"; address: string; existingRevision: bigint }
  | { type: "accountRevisionExhausted"; address: string; revision: bigint }
  | { type: "wrongAccountKind"; address: string; expected: "user" | "contract"; actual: "user" | "contract" }
  | { type: "replaceWithIdenticalReceiveKey"; address: string; receiveKeyHash: string }
  | { type: "accountUpdateCommitmentMismatch"; expected: string; supplied: string }
  | { type: "nonCanonicalAccountField"; field: "nullifierKeyCommitment" | "ruleSetCommitment"; supplied: string }
  | { type: "contractAddressExists"; address: string }
  | { type: "nonCanonicalContractField"; field: "nullifierKeyMaterial" | "applicationVkHash" | "configurationCommitment"; functionIndex: bigint | null; supplied: string }
  | { type: "selectorsNotStrictlyIncreasing"; previousFunctionIndex: bigint; previousSelector: bigint; functionIndex: bigint; selector: bigint }
  | { type: "carrierContextMismatch"; required: string; carrier: string };

export interface ReceiptResult {
  inclusion: InclusionIdResult;
  contentHash: string;
  transactionId: string;
  outcome: TransactionOutcome;
  failureDetail: FailureDetail | null;
  l1Sender: string;
  /** Designated commitment, or the including batch's poster commitment for an open route; null without a destination. */
  issuanceOwnerCommitment: string | null;
  settledOpenFeeAmount: bigint;
  /** The block's rewardEach for a successful type 0x00 action, otherwise zero. */
  settledIssuanceAmount: bigint;
  kind: "privateValue" | "userAccountCreation" | "userAccountUpdate" | "contractAccount" | "unknown";
  /** 0: none; 1: inserted; 2: an attachment reused an existing account. */
  accountCreation: 0 | 1 | 2;
  outputLeafStart: bigint | null;
  outputsAdded: bigint;
  nullifiers: string[] | null;
  account: AccountReceiptResult | null;
}

export interface ExplorerCursor {
  head: BlockIdResult;
  blockNumber: bigint;
  pcashTransactionIndex: bigint;
}

export interface TransactionSummaryResult {
  l1Sender: string;
  issuanceOwnerCommitment: string | null;
  settledOpenFeeAmount: bigint;
  settledIssuanceAmount: bigint;
  transactionId: string;
  contentHash: string;
  outcome: TransactionOutcome;
  failureDetail: FailureDetail | null;
  declaredOpenFeeAmount: bigint | null;
  declaredIssuanceOwnerCommitment: string | null;
  issuanceRoute: IssuanceRoute;
  kind: string;
  /** 0: none; 1: inserted; 2: an attachment reused an existing account. */
  accountCreation: 0 | 1 | 2;
  block: BlockIdResult;
  pcashTransactionIndex: bigint;
  timestamp: bigint;
  inclusion: InclusionIdResult;
  byteSize: bigint;
  outputLeafStart: bigint | null;
  outputsAdded: bigint;
  nullifiers: string[] | null;
  account: AccountReceiptResult | null;
}

export interface TransactionQuery {
  cursor?: ExplorerCursor;
  limit?: bigint | number;
  kind?: string;
  blockNumber?: bigint | number;
}

export interface SubmissionQuery {
  contentHash: string;
  cursor?: ExplorerCursor;
  limit?: bigint | number;
}

export interface AccountHistoryQuery {
  address: string;
  cursor?: ExplorerCursor;
  limit?: bigint | number;
}

export type BatchExclusionReason =
  | "unsupportedCarrierEncoding"
  | "invalidCarrierEncoding"
  | "unsupportedBatchVersion"
  | "invalidPosterOwnerCommitment"
  | "invalidPosterContext"
  | "batchCountLimit"
  | "truncatedFraming"
  | "trailingBatchBytes";

const ITEM_EXCLUSION_REASONS = [
  "itemTooLarge",
  "empty",
  "unknownKind",
  "unknownPrivateValueShape",
  "unknownAuthorizationMode",
  "unknownAccountCreationTag",
  "directCreationAttachment",
  "unknownReceiveKeyMode",
  "unknownPublishesNkRootFlag",
  "unknownYParity",
  "truncated",
  "trailingBytes",
  "wrongChainId",
  "directModeOutsideInbox",
] as const;

export type ItemExclusionReason = (typeof ITEM_EXCLUSION_REASONS)[number];

/** The carrier assumed to deliver a checked transaction: an Inbox transaction's sender, or a `PcashBatch` event's emitter and context. */
export type CarrierContextInput =
  | { kind: "inbox"; address: string }
  | { kind: "event"; address: string; context: Uint8Array };

/** What the next block would do with exact transaction bytes, checked against the node's current head. */
export interface TransactionCheckResult {
  /** The item's non-admission class, or the admitted transaction's outcome. */
  outcome: TransactionOutcome | ItemExclusionReason;
}

/** How a carrier delivered its batch: an Inbox transaction's calldata or blobs, or a carrier event. */
export type CarrierType = "calldata" | "blob" | "event";

/** One carrier's delivery manifest. */
export interface L1DeliveryBatchResult {
  posterOwnerCommitment: string | null;
  posterContext: string | null;
  l1BlockNumber: bigint;
  l1BlockHash: string;
  l1TransactionIndex: bigint;
  l1TransactionHash: string;
  l1Sender: string;
  carrierType: CarrierType;
  /** A carrier event's receipt-local log index; null for an Inbox carrier. */
  logIndex: bigint | null;
  /** A carrier event's emitter; null for an Inbox carrier. */
  emitter: string | null;
  /** A carrier event's context bytes as hex when its data decodes; null otherwise and for an Inbox carrier. */
  context: string | null;
  /** For a carrier event, the hash and length of its whole log data. */
  carrierHash: string;
  carrierLength: bigint;
  blobVersionedHashes: string[];
  exclusionReason: BatchExclusionReason | null;
  items: Array<{
    batchItemIndex: bigint;
    contentHash: string;
    /**
     * The item's offset in its carrier's candidate batch. A carrier event's
     * batch is its decoded `batch` field, which starts after the log data's ABI
     * head, context, and batch length; `carrierHash` and `carrierLength` cover
     * the whole log data.
     */
    byteOffset: bigint;
    byteLength: bigint;
    exclusionReason: ItemExclusionReason | null;
  }>;
}

export interface TransactionPageResult {
  items: TransactionSummaryResult[];
  nextCursor: ExplorerCursor | null;
  head: BlockIdResult;
}

export interface TransactionResult {
  summary: TransactionSummaryResult;
  rawTransaction: string;
}

export interface ContractSummaryResult {
  address: string;
  block: BlockIdResult;
  pcashTransactionIndex: bigint;
  timestamp: bigint;
  transactionId: string;
  origin: InclusionIdResult;
  functions: Array<{
    selector: bigint;
    applicationVkHash: string;
    configurationCommitment: string;
  }>;
  sourceVerification: "verified" | "not_verified" | null;
  configurationOpeningCount: bigint | null;
}

export interface ContractQuery {
  cursor?: ExplorerCursor;
  limit?: bigint | number;
  verifiedOnly?: boolean;
}

export interface ContractPageResult {
  items: ContractSummaryResult[];
  nextCursor: ExplorerCursor | null;
  head: BlockIdResult;
}

/** Internally authenticated current output-commitment opening. */
export interface OutputPathResult {
  outputIndex: bigint;
  root: string;
  count: bigint;
  siblings: bigint[];
  boundary: CurrentBoundaryEnvelope;
}

/** One output leaf opening within a pcash_getOutputPaths batch (shared root). */
export interface OutputLeafPath {
  outputIndex: bigint;
  siblings: bigint[];
}

/** pcash_getOutputPaths — several openings against one output root and block snapshot. */
export interface OutputPathsResult {
  root: string;
  count: bigint;
  paths: OutputLeafPath[];
  boundary: CurrentBoundaryEnvelope;
}

/** The requested commitment no longer opens at its output-tree index. */
export class OutputOpeningMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutputOpeningMismatchError";
  }
}

export interface AccountResult {
  address: string;
  index: bigint;
  accountRevision: bigint;
  nullifierKeyCommitment: string;
  accountRuleSetCommitment: string;
  /** account kind: 0 user, 1 smart contract. */
  accountKind: number;
  /** `receiveKeyHash` of the receive key as a canonical 32-byte word; zero when the account has no receive key. */
  receiveKeyHash: string;
  material:
    | { status: "notPresent" }
    | { status: "available"; mlKem768PublicKey: string }
    | { status: "unavailable"; lifecycle: string };
}

export interface BlockHeaderResult {
  recentPcashBlockHash: bigint;
  boundary: CurrentBoundaryEnvelope;
}


export type AccountProofResult =
  | { status: "notFound"; address: string; authenticated: false }
  | {
      status: "present";
      account: AccountResult;
      accountStateRoot: bigint;
      accountSiblings: bigint[];
      accountCount: bigint;
      stateRootHeaderSiblings: bigint[];
      accountStateRootStateSiblings: bigint[];
      boundary: CurrentBoundaryEnvelope;
    };

export interface VerifiedContract {
  status: "contract";
  address: string;
  accountProof: Extract<AccountProofResult, { status: "present" }>;
  publishesNkRoot: boolean;
  nkRoot: string | null;
  functions: Array<{
    selector: FunctionSelector;
    applicationVkHash: string;
    configurationCommitment: string;
  }>;
  transaction: string;
  origin: ContractOrigin;
}

/** Where in the L1 data stream this contract's creating transaction landed. */
export interface ContractOrigin {
  l1BlockNumber: bigint;
  l1BlockHash: string;
  l1TransactionIndex: bigint;
  batchItemIndex: bigint;
}

export type ContractResult =
  | { status: "notFound"; address: string; authenticated: false }
  | { status: "notContract"; accountProof: Extract<AccountProofResult, { status: "present" }> }
  | VerifiedContract
  | { status: "unavailable"; address: string; lifecycle: string };

export interface L1OriginProofResult {
  recentPcashBlockHash: bigint;
  l1OriginRoot: bigint;
  l1OriginRootSiblings: bigint[];
  l1BlockNumber: bigint;
  /** The full Ethereum block hash, which the L1 origin leaf commits as two 128-bit halves. */
  l1BlockHash: Uint8Array;
  l1BlockTimestamp: bigint;
  l1LogsRoot: bigint;
  l1LogCount: bigint;
  l1OriginIndex: bigint;
  l1OriginSiblings: bigint[];
  boundary: CurrentBoundaryEnvelope;
}

export interface L1LogProofResult extends L1OriginProofResult {
  logLeafIndex: bigint;
  logSiblings: bigint[];
  transactionIndex: bigint;
  logIndex: bigint;
}

export interface HistoryProofResult {
  recentPcashBlockHash: bigint;
  historyRoot: bigint;
  historyRootSiblings: bigint[];
  historicalBlockNumber: bigint;
  historicalBlockHash: bigint;
  historySiblings: bigint[];
  boundary: CurrentBoundaryEnvelope;
}

export interface CurrentNullifierStatus {
  nullifier: string;
  spent: boolean;
}

export type CurrentNullifierStatuses =
  | { statuses: CurrentNullifierStatus[]; boundary: CurrentBoundaryEnvelope }
  | { statuses: []; boundary: null };

/** Witness inputs collected by the node under one current-state snapshot. */
export interface WitnessSnapshotQuery {
  accounts?: readonly string[];
  contracts?: readonly string[];
  outputs?: readonly { outputIndex: bigint | number; outputCommitment: bigint }[];
  nullifiers?: readonly string[];
  l1Logs?: readonly {
    l1BlockNumber: bigint | number;
    transactionIndex: bigint | number;
    logIndex: bigint | number;
    expectedLog: L1LogInput;
  }[];
}

export interface WitnessSnapshotBlockResult {
  number: bigint;
  hash: string;
  l1Origin: { blockNumber: bigint; blockHash: string };
}

export interface WitnessSnapshotResult {
  status: StatusResult;
  blockHeader: BlockHeaderResult | null;
  block: WitnessSnapshotBlockResult | null;
  accounts: AccountProofResult[];
  contracts: ContractResult[];
  outputs: OutputPathsResult | null;
  nullifiers: CurrentNullifierStatuses;
  l1Logs: (L1LogProofResult | null)[];
}

/** The canonical block that created an output. */
export interface OutputOrigin {
  pcashNumber: bigint;
  pcashHash: string;
  /** The block header's timestamp, in seconds. */
  timestamp: bigint;
}

export type OutputResult = {
  outputIndex: bigint;
  outputCommitment: string;
  origin: OutputOrigin;
} & ({
  kind: "ordinary";
  outputData: Uint8Array;
  transactionId: string;
  /** keccak256 of the creating transaction's bytes. */
  contentHash: Hex;
  transactionType: number;
  privateValueShape: PrivateValueShape | null;
  outputSlot: number;
  /** On the slot-0 row, every nullifier the creating transaction inserted, in input-slot order; empty on other rows. */
  nullifiers: Hex[];
  /** On the slot-0 row, the creating section's arena; null on other rows. */
  arena: Uint8Array | null;
} | {
  kind: "system";
  payout: Omit<PayoutRecordResult, "blockNumber" | "blockHash">;
});

/**
 * One page of outputs. Pages hold whole units: every row of a transaction (its
 * arena on the slot-0 row) or one system payout row. `fromOutputIndex` is the
 * request's index, or the first output of the transaction it fell inside.
 */
export interface OutputPageResult {
  fromOutputIndex: bigint;
  target: { pcashNumber: bigint; pcashHash: string; outputCount: bigint };
  outputs: OutputResult[];
  continuation: Record<string, unknown> | null;
  complete: boolean;
}

/** The output-tree count, root, and append frontier committed by one canonical block. */
export interface OutputFrontierResult {
  target: { pcashNumber: bigint; pcashHash: string };
  outputCount: bigint;
  outputRoot: bigint;
  frontier: OutputFrontier;
}

/** One account write: the complete account row after the write, at its account-tree index. */
export interface AccountChange {
  origin: { pcashNumber: bigint; pcashHash: string };
  accountIndex: bigint;
  address: Hex;
  nullifierKeyCommitment: bigint;
  accountRuleSetCommitment: bigint;
  /** 0 user, 1 smart contract. */
  accountKind: 0 | 1;
  accountRevision: number;
  /** `receiveKeyHash` of the receive key as a canonical 32-byte word; zero when the account has no receive key. */
  receiveKeyHash: Hex;
  /**
   * The ML-KEM-768 public key this write introduced; null when it kept, cleared,
   * or has no key. Unchecked against `receiveKeyHash`: a reader verifies the
   * key before it encrypts to it.
   */
  receiveKey: Uint8Array | null;
}

export interface AccountChangePageResult {
  fromBlock: bigint;
  target: { pcashNumber: bigint; pcashHash: string; accountCount: bigint };
  changes: AccountChange[];
  continuation: Record<string, unknown> | null;
  complete: boolean;
}

export type ReceiptQuery =
  | string
  | { contentHash: string }
  | { inclusionId: {
      l1BlockHash: string;
      l1TransactionIndex: bigint | number;
      batchItemIndex: bigint | number;
    } }
  | { nullifier: string }
  | { address: string; accountRevision: bigint | number };

/** One exact transaction currently retained by this node's local P2P mempool. */
export interface MempoolItemResult {
  contentHash: string;
  statementId: string;
  stableId: string;
  conflictKeys: string[];
  kind: string;
  byteSize: bigint;
  openFeeAmount: bigint;
  issuanceOwnerCommitment: string;
  issuanceRoute: IssuanceRoute;
  validUntil: bigint | null;
  /** The recent PCASH block a private-value section proves against; null for kinds without one. */
  recentPcashBlockHash: string | null;
  status: string;
  conflictCount: bigint;
  receivedAtUnixMs: bigint;
  headCheckedBlock: bigint;
  headCheckedBlockHash: string;
  /** Untrusted application records from the arena's public segment, in identifier order. */
  publicRecords: DataRecord[];
  /** Present on pcash_getMempoolTransaction; null on list and submit responses. */
  rawTransaction: string | null;
}

export interface MempoolQuery {
  cursor?: string;
  limit?: bigint | number;
  kind?: string;
  minOpenFee?: bigint | number;
  status?: "ready" | "suspended";
  /** Keep open-route transactions and transactions designated to these commitments. */
  controlledIssuanceOwnerCommitments?: readonly string[];
  sort?: "receivedAt" | "feeDensity";
  /** Keep transactions whose arena carries a public record of `schema` holding each `bytes` at its `offset`. */
  arena?: { schema: string; data?: readonly { offset: bigint | number; bytes: string }[] };
}

export interface SubmitRawTransactionResult {
  contentHash: string;
  statementId: string;
  stableId: string;
  status: string;
  headCheckedBlock: bigint;
  headCheckedBlockHash: string;
}

export interface MempoolPageResult {
  items: MempoolItemResult[];
  nextCursor: string | null;
  headCheckedBlock: bigint;
  headCheckedBlockHash: string;
  /** P2P peer count, or null when P2P is disabled or unavailable. */
  peerCount: bigint | null;
}

export interface PrepareRelayRequest {
  contentHashes: string[];
  /** Designated commitments the relayer controls; open routes are always controlled. */
  controlledIssuanceOwnerCommitments?: readonly string[];
  /** Exact selected transactions whose designated issuance the relayer controls. */
  controlledIssuanceContentHashes?: readonly string[];
  maxBatchBytes: bigint | number;
}

export interface PrepareRelayRejection {
  contentHash: string;
  reason: string;
}

export interface PrepareRelayResult {
  selectedTransactions: string[];
  selectedContentHashes: string[];
  rejected: PrepareRelayRejection[];
  /** Explicit fees of selected transactions whose destination the relayer controls. */
  collectibleOpenFee: bigint;
  /** Selected type 0x00 transactions whose destination the relayer controls. */
  collectibleQualifyingActions: bigint;
  /** Every selected type 0x00 transaction; all of them dilute the block's issuance. */
  selectedQualifyingActions: bigint;
  batchBytes: bigint;
  headCheckedBlock: bigint;
  headCheckedBlockHash: string;
}

/** A signed 256-bit integer sent as a decimal string, the wire form of the issuance lag. */
function signedDecimal(value: unknown, label: string): bigint {
  if (typeof value !== "string" || !/^-?[0-9]+$/.test(value)) throw new Error(`${label} must be a signed decimal integer`);
  const parsed = BigInt(value);
  if (parsed < -(1n << 255n) || parsed >= 1n << 255n) throw new Error(`${label} must fit in i256`);
  return parsed;
}

function byteQuantities(value: unknown, label: string): number[] {
  const parsed = array(quantity)(value, label).map((item) => {
    if (item > 0xffn) throw new Error(`${label} values must be u8 quantities`);
    return Number(item);
  });
  if (new Set(parsed).size !== parsed.length) throw new Error(`${label} must not contain duplicates`);
  return parsed;
}

/** A quantity narrowed to a JS number, for small identifiers such as chain ids and kinds. */
const smallQuantity: Parser<number> = (value, label) => Number(parseHexQuantity(value, label));

const parseBlockId: Parser<BlockIdResult> = shape({ blockNumber: quantity, blockHash: str });

const parseIssuanceRoute: Parser<IssuanceRoute> = oneOf("none", "open", "designated");

const parseFeeTiers: Parser<FeeTiersResult> = shape({ low: quantity, standard: quantity, fast: quantity });

const receiptId: Parser<string> = (value, label) => fixedHex(value, 32, label);
const parseInclusionId: Parser<InclusionIdResult> = shape({
  l1BlockNumber: quantity,
  l1BlockHash: receiptId,
  l1TransactionIndex: quantity,
  l1TransactionHash: receiptId,
  batchItemIndex: quantity,
});

const parseAccountReceipt: Parser<AccountReceiptResult | null> = nullable(shape({
  address: str,
  accountRevision: quantity,
}));

const parseTransactionOutcome: Parser<TransactionOutcome> = oneOf(...TRANSACTION_OUTCOMES);
const parseTransactionCheck: Parser<TransactionCheckResult> = shape({
  outcome: oneOf(...TRANSACTION_OUTCOMES, ...ITEM_EXCLUSION_REASONS),
});
function parseNullableNullifiers(value: unknown, label: string): string[] | null {
  if (value === null) return null;
  if (!Array.isArray(value) || !Object.values(PRIVATE_VALUE_PROFILES).some(p => p.inputs === value.length) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${label} must be a profile-sized array of strings or null`);
  }
  return value.map((item, index) => fixedHex(item, 32, `${label}[${index}]`));
}

const parseExplorerCursor: Parser<ExplorerCursor> = shape({
  head: parseBlockId,
  blockNumber: quantity,
  pcashTransactionIndex: quantity,
});

function encodeExplorerCursor(cursor: ExplorerCursor): Record<string, unknown> {
  return {
    head: {
      blockNumber: numberToHex(cursor.head.blockNumber),
      blockHash: cursor.head.blockHash,
    },
    blockNumber: numberToHex(cursor.blockNumber),
    pcashTransactionIndex: numberToHex(cursor.pcashTransactionIndex),
  };
}

const parseAccountCreation: Parser<0 | 1 | 2> = (value, label) => {
  if (value !== 0 && value !== 1 && value !== 2) throw new Error(`${label} must be 0, 1, or 2`);
  return value;
};

const parseMempoolItem: Parser<MempoolItemResult> = shape({
  contentHash: str,
  statementId: str,
  stableId: str,
  conflictKeys: array(str),
  kind: str,
  byteSize: quantity,
  openFeeAmount: quantity,
  issuanceOwnerCommitment: (value, label) => bytes32Hex(field(value, label)),
  issuanceRoute: parseIssuanceRoute,
  validUntil: nullable(quantity),
  recentPcashBlockHash: nullable((value, label) => fixedHex(value, 32, label)),
  status: str,
  conflictCount: quantity,
  receivedAtUnixMs: quantity,
  headCheckedBlock: quantity,
  headCheckedBlockHash: str,
  publicRecords: array(shape({
    schema: (value, label) => fixedHex(value, 4, label),
    data: (value, label) => fromHex(str(value, label)),
  })),
  rawTransaction: nullable(str),
});

const OUTCOMES_WITHOUT_FAILURE_DETAIL = new Set<TransactionOutcome>([
  "succeeded",
  "proofRejected",
  "invalidAccountSignature",
  "emptyContractFunctionSet",
]);

const countAndLimit = shape({ requestedCount: quantity, limit: quantity });
const addressOnly = shape({ address: str });
const accountKind = oneOf("user", "contract");

/** Each failure outcome's detail fields; `type` repeats the outcome and is checked separately. */
const FAILURE_DETAIL_FIELDS: Partial<Record<TransactionOutcome, Parser<Record<string, unknown>>>> = {
  publicInputNotInField: shape({ publicInputIndex: quantity, supplied: str }),
  recentPcashBlockNotInWindow: shape({ referencedBlockHash: str, windowStartTimestamp: quantity, windowEndTimestamp: quantity }),
  expired: shape({ validUntil: quantity, blockTimestamp: quantity }),
  notYetValid: shape({ notBefore: quantity, blockTimestamp: quantity }),
  zeroNullifier: shape({ inputSlot: quantity }),
  duplicateInputNullifier: shape({ firstInputSlot: quantity, duplicateInputSlot: quantity, nullifier: str }),
  nullifierAlreadySpent: shape({ inputSlot: quantity, nullifier: str, spendingTransactionId: str }),
  outputCapacity: countAndLimit,
  accountCapacity: countAndLimit,
  accountNotFound: addressOnly,
  clearWithoutReceiveKey: addressOnly,
  contractAddressExists: addressOnly,
  accountAlreadyExists: shape({ address: str, existingRevision: quantity }),
  accountRevisionExhausted: shape({ address: str, revision: quantity }),
  wrongAccountKind: shape({ address: str, expected: accountKind, actual: accountKind }),
  replaceWithIdenticalReceiveKey: shape({ address: str, receiveKeyHash: str }),
  accountUpdateCommitmentMismatch: shape({ expected: str, supplied: str }),
  nonCanonicalAccountField: shape({
    field: oneOf("nullifierKeyCommitment", "ruleSetCommitment"),
    supplied: str,
  }),
  nonCanonicalContractField: shape({
    field: oneOf("nullifierKeyMaterial", "applicationVkHash", "configurationCommitment"),
    functionIndex: nullable(quantity),
    supplied: str,
  }),
  selectorsNotStrictlyIncreasing: shape({ previousFunctionIndex: quantity, previousSelector: quantity, functionIndex: quantity, selector: quantity }),
  carrierContextMismatch: shape({ required: str, carrier: str }),
};

export function parseFailureDetail(
  value: unknown,
  outcome: TransactionOutcome,
  label: string,
): FailureDetail | null {
  if (value === null) {
    if (!OUTCOMES_WITHOUT_FAILURE_DETAIL.has(outcome)) {
      throw new Error(`${label} is required for outcome ${outcome}`);
    }
    return null;
  }
  if (OUTCOMES_WITHOUT_FAILURE_DETAIL.has(outcome)) {
    throw new Error(`${label} must be null for outcome ${outcome}`);
  }
  const type = rpcString(rpcObject(value, label).type, `${label}.type`);
  if (type !== outcome) throw new Error(`${label}.type must equal outcome ${outcome}`);
  const fields = FAILURE_DETAIL_FIELDS[outcome];
  if (fields === undefined) throw new Error(`${label}.type is unsupported`);
  return { type, ...fields(value, label) } as FailureDetail;
}

/** Parses the rest of a receipt-like object, then its failure detail against its outcome. */
function withFailureDetail<T extends { outcome: TransactionOutcome; failureDetail: unknown }>(
  parse: Parser<T>,
): Parser<Omit<T, "failureDetail"> & { failureDetail: FailureDetail | null }> {
  return (value, label) => {
    const parsed = parse(value, label);
    return { ...parsed, failureDetail: parseFailureDetail(parsed.failureDetail, parsed.outcome, `${label}.failureDetail`) };
  };
}

const parseReceiptDto: Parser<ReceiptResult> = withFailureDetail(shape({
  inclusion: parseInclusionId,
  contentHash: receiptId,
  transactionId: receiptId,
  outcome: parseTransactionOutcome,
  failureDetail: present,
  l1Sender: str,
  issuanceOwnerCommitment: nullable(str),
  settledOpenFeeAmount: quantity,
  settledIssuanceAmount: quantity,
  kind: oneOf("privateValue", "userAccountCreation", "userAccountUpdate", "contractAccount", "unknown"),
  accountCreation: parseAccountCreation,
  outputLeafStart: nullable(quantity),
  outputsAdded: quantity,
  nullifiers: parseNullableNullifiers,
  account: parseAccountReceipt,
}));

const parseTransactionSummary: Parser<TransactionSummaryResult> = withFailureDetail(shape({
  l1Sender: str,
  issuanceOwnerCommitment: nullable(str),
  settledOpenFeeAmount: quantity,
  settledIssuanceAmount: quantity,
  transactionId: str,
  contentHash: str,
  outcome: parseTransactionOutcome,
  failureDetail: present,
  declaredOpenFeeAmount: nullable(quantity),
  declaredIssuanceOwnerCommitment: nullable(str),
  issuanceRoute: parseIssuanceRoute,
  kind: str,
  accountCreation: parseAccountCreation,
  block: parseBlockId,
  pcashTransactionIndex: quantity,
  timestamp: quantity,
  inclusion: parseInclusionId,
  byteSize: quantity,
  outputLeafStart: nullable(quantity),
  outputsAdded: quantity,
  nullifiers: parseNullableNullifiers,
  account: parseAccountReceipt,
}));

const parseTransactionResult: Parser<TransactionResult> = shape({
  summary: parseTransactionSummary,
  rawTransaction: str,
});

const parseContractFunctions = array(shape({ selector: quantity, applicationVkHash: str, configurationCommitment: str }));

const parseContractSummary: Parser<ContractSummaryResult> = shape({
  address: str,
  block: parseBlockId,
  pcashTransactionIndex: quantity,
  timestamp: quantity,
  transactionId: str,
  origin: parseInclusionId,
  functions: parseContractFunctions,
  sourceVerification: nullable(oneOf("verified", "not_verified")),
  configurationOpeningCount: nullable(quantity),
});

const parseBlock: Parser<BlockResult> = shape({
  number: quantity,
  hash: str,
  parentHash: str,
  timestamp: quantity,
  transactionResultsRoot: str,
  stateRoot: str,
  l1OriginRoot: str,
  historyRoot: str,
  transactionResultCount: quantity,
  transactionResults: array(shape({
    inclusion: parseInclusionId,
    contentHash: str,
    transactionId: str,
    outcome: parseTransactionOutcome,
  })),
  transactionBytes: nullable(array(str)),
  l1Origin: shape({
    blockNumber: quantity,
    blockHash: str,
    blockTimestamp: quantity,
    l1LogsRoot: str,
    l1LogCount: quantity,
  }),
});

/** A field element from an RPC response: 0x-hex below the scalar modulus. */
function field(value: unknown, name: string): bigint {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{1,64}$/.test(value)) {
    throw new Error(`${name} must be a 0x-hex field element`);
  }
  return toField(BigInt(value), name);
}

/** A sibling path from an RPC response, each element checked as a field element. */
function fields(value: unknown, name: string): bigint[] {
  if (!Array.isArray(value)) throw new Error(`${name} path must be an array`);
  return value.map((element) => field(element, name));
}

function parseBoundary(value: unknown): CurrentBoundaryEnvelope {
  return parseCurrentBoundaryEnvelope(value as CurrentBoundaryEnvelopeRpc);
}

function parseL1OriginProofResponse(
  r: Record<string, unknown>,
  recentPcashBlockHash: bigint,
  l1BlockNumber: bigint | number,
): L1OriginProofResult {
  const returnedHash = field(r.recentPcashBlockHash, "recentPcashBlockHash");
  if (returnedHash !== toField(recentPcashBlockHash, "recentPcashBlockHash")) {
    throw new Error("L1 origin proof recent block echo mismatch");
  }
  const l1OriginRoot = field(r.l1OriginRoot, "l1OriginRoot");
  const l1OriginRootSiblings = fields(r.l1OriginRootSiblings, "L1 origin root header sibling");
  const requestedNumber = parseHexQuantity(r.l1BlockNumber);
  const requestedHash = hexToBytes(r.l1BlockHash as string);
  const requestedTimestamp = parseHexQuantity(r.l1BlockTimestamp);
  const l1LogsRoot = field(r.l1LogsRoot, "l1LogsRoot");
  const l1LogCount = parseHexQuantity(r.l1LogCount);
  const l1OriginIndex = parseHexQuantity(r.l1OriginIndex);
  const l1OriginSiblings = fields(r.l1OriginSiblings, "L1 origin sibling");
  if (
    requestedNumber !== BigInt(l1BlockNumber) ||
    l1OriginRootSiblings.length !== BLOCK_HEADER_TREE_DEPTH ||
    l1OriginSiblings.length !== L1_ORIGIN_TREE_DEPTH ||
    !verifyBlockHeaderPath(
      returnedHash,
      BLOCK_HEADER_KEY_L1_ORIGIN_ROOT,
      l1OriginRoot,
      l1OriginRootSiblings,
    ) ||
    !verifyL1OriginPath(
      { leafIndex: l1OriginIndex, root: l1OriginRoot, siblings: l1OriginSiblings },
      {
        blockNumber: requestedNumber,
        blockHash: requestedHash,
        timestamp: requestedTimestamp,
        logsRoot: l1LogsRoot,
        logCount: l1LogCount,
      },
    )
  ) throw new Error("invalid L1 origin proof");
  const boundary = parseBoundary(r.boundary);
  if (boundary.blockHash !== returnedHash || boundary.header.l1OriginRoot !== l1OriginRoot) {
    throw new Error("L1 origin proof boundary mismatch");
  }
  return {
    recentPcashBlockHash: returnedHash,
    l1OriginRoot,
    l1OriginRootSiblings,
    l1BlockNumber: requestedNumber,
    l1BlockHash: requestedHash,
    l1BlockTimestamp: requestedTimestamp,
    l1LogsRoot,
    l1LogCount,
    l1OriginIndex,
    l1OriginSiblings,
    boundary,
  };
}

const parseReceiveMaterial: Parser<AccountResult["material"]> = (value, label) => {
  const status = str(rpcObject(value, label).status, `${label}.status`);
  if (status === "notPresent") return { status };
  if (status === "available") return { status, ...shape({ mlKem768PublicKey: str })(value, label) };
  if (status === "unavailable") return { status, ...shape({ lifecycle: str })(value, label) };
  throw new Error(`${label}.status is an unknown receive-material discriminant`);
};

const parseAccountValue: Parser<AccountResult> = shape({
  address: str,
  index: quantity,
  accountRevision: quantity,
  nullifierKeyCommitment: str,
  accountRuleSetCommitment: str,
  accountKind: smallQuantity,
  receiveKeyHash: fieldWord,
  material: parseReceiveMaterial,
});

function parseAndVerifyAccountProof(
  value: unknown,
): Extract<AccountProofResult, { status: "present" }> {
  const r = rpcObject(value, "pcash_getAccountProof result");
  if (r.status !== "present") throw new Error("expected a present account proof");
  const account = parseAccountValue(r.account, "pcash_getAccountProof.account");
  const boundary = parseBoundary(r.boundary);
  const accountStateRoot = field(r.accountStateRoot, "accountStateRoot");
  const accountCount = parseHexQuantity(r.accountCount);
  const accountSiblings = fields(r.accountSiblings, "account sibling");
  const stateRootHeaderSiblings = fields(r.stateRootHeaderSiblings, "state root header sibling");
  const accountStateRootStateSiblings = fields(r.accountStateRootStateSiblings, "account state root state sibling");
  if (
    account.index >= accountCount ||
    account.accountRevision === 0n ||
    accountSiblings.length !== MERKLE_DEPTH ||
    stateRootHeaderSiblings.length !== BLOCK_HEADER_TREE_DEPTH ||
    accountStateRootStateSiblings.length !== STATE_TREE_DEPTH
  ) throw new Error("invalid account proof metadata");
  if (
    accountStateRoot !== boundary.state.accountStateRoot ||
    accountCount !== boundary.state.accountCount
  ) throw new Error("account proof does not match boundary state");
  if (!verifyBlockHeaderPath(
    boundary.blockHash,
    BLOCK_HEADER_KEY_STATE_ROOT,
    boundary.header.stateRoot,
    stateRootHeaderSiblings,
  )) throw new Error("account proof stateRoot header path mismatch");
  if (!verifyStatePath(
    boundary.header.stateRoot,
    STATE_KEY_ACCOUNT_STATE_ROOT,
    accountStateRoot,
    accountStateRootStateSiblings,
  )) throw new Error("account proof accountStateRoot state path mismatch");
  const committedReceiveKeyHash = BigInt(account.receiveKeyHash);
  const rLeaf = accountStateCommitment(
    BigInt(account.address),
    field(account.nullifierKeyCommitment, "nullifierKeyCommitment"),
    field(account.accountRuleSetCommitment, "accountRuleSetCommitment"),
    account.accountKind,
    account.accountRevision,
    committedReceiveKeyHash,
  );
  if (rootFromIndex(rLeaf, account.index, accountSiblings) !== accountStateRoot) {
    throw new Error("account path mismatch");
  }
  if (committedReceiveKeyHash !== 0n) {
    if (account.material.status === "notPresent") throw new Error("a nonzero receive-key digest has notPresent material");
    if (account.material.status === "available") {
      const key = hexToBytes(account.material.mlKem768PublicKey);
      if (key.length !== ML_KEM_768_PUBLIC_KEY_LENGTH || receiveKeyHash(key) !== committedReceiveKeyHash) {
        throw new Error("available receive material does not match receive-key digest");
      }
    }
  } else if (account.material.status !== "notPresent") {
    throw new Error("a zero receive-key digest must use notPresent material");
  }
  return {
    status: "present",
    account,
    accountStateRoot,
    accountSiblings,
    accountCount,
    stateRootHeaderSiblings,
    accountStateRootStateSiblings,
    boundary,
  };
}

const parseProverAssets: Parser<ProverAssetsResult | null> = nullable(shape({
  assetSetId: (value, label) => {
    const assetSetId = str(value, label);
    if (!/^[0-9a-f]{64}$/.test(assetSetId)) throw new Error(`${label} must be lowercase SHA-256 hex`);
    return assetSetId;
  },
  baseUrl: (value, label) => {
    const baseUrl = str(value, label);
    if (baseUrl.length === 0) throw new Error(`${label} must not be empty`);
    return baseUrl;
  },
}));

const parseDerivation: Parser<DerivationResult> = (value, label) => {
  const state = str(rpcObject(value, label).state, `${label}.state`);
  if (state === "following") return { state, ...shape({ sinceUnixMs: quantity })(value, label) };
  if (state === "stalled") {
    return {
      state,
      ...shape({ cause: oneOf("l1Rpc", "blobs"), l1BlockNumber: quantity, sinceUnixMs: quantity })(value, label),
    };
  }
  if (state === "halted") {
    return {
      state,
      ...shape({
        cause: oneOf("verifier", "storage", "l1Input", "internal"),
        l1BlockNumber: quantity,
        sinceUnixMs: quantity,
      })(value, label),
    };
  }
  throw new Error(`${label}.state is an unknown derivation discriminant`);
};

const parseStatus: Parser<StatusResult> = shape({
  latestBlock: quantity,
  latestBlockHash: str,
  latestBlockTimestamp: quantity,
  finalizedBlock: quantity,
  finalizedBlockHash: str,
  finalizedBlockTimestamp: quantity,
  latestL1BlockNumber: quantity,
  latestL1BlockHash: str,
  observedL1BlockNumber: nullable(quantity),
  derivation: parseDerivation,
  finalizedL1BlockNumber: quantity,
  finalizedL1BlockHash: str,
  stateRoot: str,
  l1OriginRoot: str,
  historyRoot: str,
  outputCount: quantity,
  issuedSoFar: quantity,
  supplyCap: quantity,
  totalSucceeded: nullable(quantity),
  totalFailed: nullable(quantity),
  totalTransactions: nullable(quantity),
  index: shape({ status: str, cursor: nullable(parseBlockId) }),
  proverAssets: parseProverAssets,
  pcashChainId: smallQuantity,
  genesisHash: str,
  acceptedTransactionTypes: byteQuantities,
  acceptedBatchVersions: byteQuantities,
  l1ChainId: quantity,
  inboxAddress: str,
  genesisL1Block: quantity,
  genesisL1BlockHash: str,
  forkCapability: shape({
    chainId: quantity,
    genesisHash: str,
    headTimestamp: quantity,
    currentForkCount: quantity,
    currentPrefixHash: str,
    nextActivationTimestamp: quantity,
    nextPrefixHash: str,
  }),
});

const parseWitnessSnapshotBlock: Parser<WitnessSnapshotBlockResult | null> = nullable(shape({
  number: quantity,
  hash: str,
  l1Origin: shape({ blockNumber: quantity, blockHash: str }),
}));

const parseIssuanceQuote: Parser<IssuanceQuoteResult> = shape({
  parent: shape({ blockNumber: quantity, blockHash: str, timestamp: quantity }),
  candidateTimestamp: quantity,
  supplyCap: quantity,
  issuedSoFar: quantity,
  baseline: quantity,
  internalOffer: quantity,
  blockAllowance: quantity,
  maxSingleActionReward: quantity,
  multiplierQ: quantity,
  lagQ: signedDecimal,
  exhausted: bool,
  rewardPossible: bool,
});

const parseBlockEconomicsPage: Parser<BlockEconomicsPageResult> = shape({
  atBlockNumber: quantity,
  atBlockHash: str,
  records: array(shape({
    firstBlock: quantity,
    lastBlock: quantity,
    firstTimestamp: quantity,
    lastTimestamp: quantity,
    blocks: quantity,
    qualifyingActions: quantity,
    issuanceTotal: quantity,
    openFeesTotal: quantity,
    rewardEach: quantity,
    baseline: quantity,
    internalOffer: quantity,
    blockAllowance: quantity,
    lagQ: signedDecimal,
  })),
  nextBlock: nullable(quantity),
});

const parsePayoutPage: Parser<PayoutPageResult> = shape({
  atBlockNumber: quantity,
  atBlockHash: str,
  records: array(parsePayoutRecord),
  nextCursor: nullable(shape({ anchor: parseBlockId, nextBlock: quantity, nextPayoutIndex: quantity })),
});

const parseBlockPayouts: Parser<BlockPayoutsResult> = shape({
  block: parseBlockId,
  openFeesTotal: quantity,
  issuanceTotal: quantity,
  payouts: array(parseSystemPayout),
});

const parseContractOrigin: Parser<ContractOrigin> = shape({
  l1BlockNumber: quantity,
  l1BlockHash: (value, label) => {
    const hash = str(value, label);
    if (fromHex(hash, label).length !== 32) throw new Error(`${label} must be 32 bytes`);
    return hash;
  },
  l1TransactionIndex: quantity,
  batchItemIndex: quantity,
});

const parseNullifierProofs = array(shape({
  nullifier: str,
  leaf: shape({ value: field, nextValue: field, nextIndex: quantity }),
  leafIndex: quantity,
  siblings: array(field),
}));

const parseSubmitResult: Parser<SubmitRawTransactionResult> = shape({
  contentHash: str,
  statementId: str,
  stableId: str,
  status: str,
  headCheckedBlock: quantity,
  headCheckedBlockHash: str,
});

const parseMempoolPage: Parser<MempoolPageResult> = shape({
  items: array(parseMempoolItem),
  nextCursor: nullable(str),
  headCheckedBlock: quantity,
  headCheckedBlockHash: str,
  peerCount: nullable(quantity),
});

const parsePrepareRelay: Parser<PrepareRelayResult> = shape({
  selectedTransactions: array(str),
  selectedContentHashes: array(str),
  rejected: array(shape({ contentHash: str, reason: str })),
  collectibleOpenFee: quantity,
  collectibleQualifyingActions: quantity,
  selectedQualifyingActions: quantity,
  batchBytes: quantity,
  headCheckedBlock: quantity,
  headCheckedBlockHash: str,
});

const parseFeeEstimate: Parser<FeeEstimateResult> = shape({
  head: parseBlockId,
  windowBlocks: quantity,
  byteSize: quantity,
  tiers: parseFeeTiers,
  basis: shape({
    includedSamples: quantity,
    included: nullable(parseFeeTiers),
    pendingSamples: quantity,
    pending: nullable(parseFeeTiers),
  }),
});

const parseL1DeliveryBatch: Parser<L1DeliveryBatchResult> = shape({
  posterOwnerCommitment: nullable(str),
  posterContext: nullable(str),
  l1BlockNumber: quantity,
  l1BlockHash: str,
  l1TransactionIndex: quantity,
  l1TransactionHash: str,
  l1Sender: str,
  carrierType: oneOf("calldata", "blob", "event"),
  logIndex: nullable(quantity),
  emitter: nullable(str),
  context: nullable(str),
  carrierHash: str,
  carrierLength: quantity,
  blobVersionedHashes: array(str),
  exclusionReason: nullable(str) as Parser<BatchExclusionReason | null>,
  items: array(shape({
    batchItemIndex: quantity,
    contentHash: str,
    byteOffset: quantity,
    byteLength: quantity,
    exclusionReason: nullable(str) as Parser<ItemExclusionReason | null>,
  })),
});

export class PcashNodeClient {
  private readonly url: string;
  private readonly rpc: ReturnType<typeof nodeRpc>;

  constructor(url: string, options: NodeRpcOptions = {}) {
    this.url = url;
    this.rpc = nodeRpc(url, MAX_RPC_RESPONSE_BODY_BYTES, options);
  }

  /** The configured RPC endpoint, preserved verbatim for caller-side URL resolution. */
  get rpcUrl(): string {
    return this.url;
  }

  /** Low-level call: send one request, return the JSON-RPC `result` or throw. */
  async call<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
    return await this.rpc(method, params) as T;
  }

  /** One request, one snapshot; every returned opening is authenticated before use. */
  async getWitnessSnapshot(query: WitnessSnapshotQuery = {}): Promise<WitnessSnapshotResult> {
    const accounts = query.accounts ?? [];
    const contracts = query.contracts ?? [];
    const outputs = query.outputs ?? [];
    const nullifiers = (query.nullifiers ?? []).map((value) => toHex(parseCanonicalNullifier(value)));
    const l1Logs = query.l1Logs ?? [];
    const r = rpcObject(await this.call("pcash_getWitnessSnapshot", [{
      accounts, contracts,
      outputs: outputs.map(({ outputIndex }) => numberToHex(BigInt(outputIndex))),
      nullifiers,
      l1Logs: l1Logs.map(({ l1BlockNumber, transactionIndex, logIndex }) => ({
        l1BlockNumber: numberToHex(BigInt(l1BlockNumber)),
        transactionIndex: numberToHex(BigInt(transactionIndex)),
        logIndex: numberToHex(BigInt(logIndex)),
      })),
    }]), "witness snapshot");
    const array = (key: string, length: number): unknown[] => {
      const values = r[key];
      if (!Array.isArray(values) || values.length !== length) throw new Error(`witness snapshot ${key} count mismatch`);
      return values;
    };
    const status = parseStatus(r.status, "witness snapshot.status");
    const blockHeader = r.blockHeader === null ? null : this.parseBlockHeader(rpcObject(r.blockHeader, "witness snapshot header"));
    const block = parseWitnessSnapshotBlock(r.block, "witness snapshot.block");
    const result: WitnessSnapshotResult = {
      status, blockHeader, block,
      accounts: array("accounts", accounts.length).map((v, i) => this.parseAccountProof(rpcObject(v, "snapshot account"), accounts[i]!)),
      contracts: array("contracts", contracts.length).map((v, i) => this.parseContractResult(rpcObject(v, "snapshot contract"), contracts[i]!)),
      outputs: this.parseOutputPaths(r.outputs === null ? null : rpcObject(r.outputs, "snapshot outputs"), outputs),
      nullifiers: nullifiers.length === 0 ? { statuses: [], boundary: null } : this.parseNullifierStatuses(rpcObject(r.nullifiers, "snapshot nullifiers"), nullifiers),
      l1Logs: array("l1Logs", l1Logs.length).map((v, i) => {
        if (v === null) return null;
        if (blockHeader === null) throw new Error("witness snapshot log without block header");
        const request = l1Logs[i]!;
        return this.parseL1LogProof(rpcObject(v, "snapshot L1 log"), blockHeader.recentPcashBlockHash,
          request.l1BlockNumber, request.transactionIndex, request.logIndex, request.expectedLog);
      }),
    };
    // The RPC peer supplies this envelope: all proofs must describe its selected head.
    const checkBoundary = (boundary: CurrentBoundaryEnvelope): void => {
      if (boundary.blockHash !== BigInt(status.latestBlockHash) || boundary.header.number !== status.latestBlock) {
        throw new Error("witness snapshot proof does not match selected head");
      }
    };
    if (blockHeader) checkBoundary(blockHeader.boundary);
    for (const account of result.accounts) if (account.status === "present") checkBoundary(account.boundary);
    for (const contract of result.contracts) {
      if (contract.status === "contract" || contract.status === "notContract") checkBoundary(contract.accountProof.boundary);
    }
    if (result.outputs) checkBoundary(result.outputs.boundary);
    if (result.nullifiers.boundary) checkBoundary(result.nullifiers.boundary);
    for (const log of result.l1Logs) if (log) checkBoundary(log.boundary);
    if (block && (block.number !== status.latestBlock || BigInt(block.hash) !== BigInt(status.latestBlockHash))) {
      throw new Error("witness snapshot block does not match selected head");
    }
    return result;
  }

  async status(): Promise<StatusResult> {
    return parseStatus(await this.call<unknown>("pcash_status"), "pcash_status");
  }

  /** Exact node calculation at a specified candidate L1 timestamp, bound to its canonical parent. */
  async getIssuanceQuote(candidateTimestamp: bigint): Promise<IssuanceQuoteResult | null> {
    const value = await this.call("pcash_getIssuanceQuote", [{ candidateTimestamp: numberToHex(candidateTimestamp) }]);
    if (value === null) return null;
    const quote = parseIssuanceQuote(value, "pcash_getIssuanceQuote");
    if (quote.candidateTimestamp !== candidateTimestamp) throw new Error("issuance quote timestamp mismatch");
    return quote;
  }

  /** Bucketed per-block issuance economics from the derived index, bound to the indexed head. */
  async getBlockEconomics(query: BlockEconomicsQuery = {}): Promise<BlockEconomicsPageResult> {
    return parseBlockEconomicsPage(await this.call("pcash_getBlockEconomics", [{
      ...(query.fromBlock === undefined ? {} : { fromBlock: numberToHex(query.fromBlock) }),
      ...(query.limit === undefined ? {} : { limit: numberToHex(BigInt(query.limit)) }),
      ...(query.bucket === undefined ? {} : { bucket: numberToHex(BigInt(query.bucket)) }),
    }]), "pcash_getBlockEconomics");
  }

  /** Canonical retained payout history; an orphaned pagination cursor is rejected by the node. */
  async getPayouts(query: { cursor?: PayoutCursor; limit?: number; fromBlock?: bigint } = {}): Promise<PayoutPageResult> {
    return parsePayoutPage(await this.call("pcash_getPayouts", [{
      ...(query.cursor === undefined ? {} : { cursor: {
        anchor: { blockNumber: numberToHex(query.cursor.anchor.blockNumber), blockHash: query.cursor.anchor.blockHash },
        nextBlock: numberToHex(query.cursor.nextBlock), nextPayoutIndex: numberToHex(query.cursor.nextPayoutIndex),
      } }),
      ...(query.limit === undefined ? {} : { limit: numberToHex(BigInt(query.limit)) }),
      ...(query.fromBlock === undefined ? {} : { fromBlock: numberToHex(query.fromBlock) }),
    }]), "pcash_getPayouts");
  }

  /** Every system payout of one canonical block, with its open-fee and issuance totals. */
  async getBlockPayouts(block: BlockIdResult): Promise<BlockPayoutsResult | null> {
    const value = await this.call("pcash_getBlockPayouts", [{ blockNumber: numberToHex(block.blockNumber), blockHash: block.blockHash }]);
    return nullable(parseBlockPayouts)(value, "pcash_getBlockPayouts");
  }

  /** pcash_getBlockByNumber — null when the PCASH height isn't derived yet. */
  async getBlock(number: bigint | number, fullTransactions = false): Promise<BlockResult | null> {
    const value = await this.call("pcash_getBlockByNumber", [numberToHex(BigInt(number)), fullTransactions]);
    return nullable(parseBlock)(value, "pcash_getBlockByNumber");
  }

  /** pcash_getBlockByHash — one canonical PCASH block, or null after a reorg/for an unknown hash. */
  async getBlockByHash(blockHash: string, fullTransactions = false): Promise<BlockResult | null> {
    const value = await this.call("pcash_getBlockByHash", [blockHash, fullTransactions]);
    return nullable(parseBlock)(value, "pcash_getBlockByHash");
  }

  /** pcash_getBlocks — canonical blocks for the inclusive PCASH-height range, ascending. */
  async getBlocks(fromBlock: bigint | number, toBlock: bigint | number, fullTransactions = false): Promise<BlockResult[]> {
    if (fullTransactions && BigInt(fromBlock) !== BigInt(toBlock)) {
      throw new Error("full transaction bodies require a single-block range");
    }
    const value = await this.call("pcash_getBlocks", [
      { fromBlock: numberToHex(BigInt(fromBlock)), toBlock: numberToHex(BigInt(toBlock)), fullTransactions },
    ]);
    return array(parseBlock)(value, "pcash_getBlocks");
  }

  /**
   * Relay fee to declare on a transaction before submitting it. Call with the
   * exact `byteSize` once the bytes exist; otherwise supply a fee-bearing
   * `kind` to use its conservative size limit. All kinds share the same pricing.
   */
  async estimateFee(query: FeeEstimateQuery): Promise<FeeEstimateResult> {
    const request: Record<string, unknown> = {};
    if (query.kind !== undefined) request.kind = query.kind;
    if (query.byteSize !== undefined) request.byteSize = numberToHex(query.byteSize);
    return parseFeeEstimate(await this.call<unknown>("pcash_estimateFee", [request]), "pcash_estimateFee");
  }

  /**
   * One page of a derived index: encoded cursor/limit plus any extra filter
   * fields, with the shared page envelope and each item validated.
   */
  private async fetchPage<T>(
    method: string,
    cursor: ExplorerCursor | undefined,
    limit: bigint | number | undefined,
    extra: Record<string, unknown>,
    item: Parser<T>,
  ): Promise<{ items: T[]; nextCursor: ExplorerCursor | null; head: BlockIdResult }> {
    const encoded: Record<string, unknown> = { ...extra };
    if (cursor !== undefined) encoded.cursor = encodeExplorerCursor(cursor);
    if (limit !== undefined) encoded.limit = numberToHex(BigInt(limit));
    return shape({
      items: array(item),
      nextCursor: nullable(parseExplorerCursor),
      head: parseBlockId,
    })(await this.call<unknown>(method, [encoded]), method);
  }

  /** Newest-first canonical accepted transactions from the derived index. */
  async getTransactions(query: TransactionQuery = {}): Promise<TransactionPageResult> {
    return this.fetchPage("pcash_getTransactions", query.cursor, query.limit, {
      ...(query.kind === undefined ? {} : { kind: query.kind }),
      ...(query.blockNumber === undefined ? {} : { blockNumber: numberToHex(BigInt(query.blockNumber)) }),
    }, parseTransactionSummary);
  }

  /** Canonical inclusions of one exact serialized transaction, newest first. */
  async getSubmission(query: SubmissionQuery): Promise<TransactionPageResult> {
    return this.fetchPage("pcash_getSubmission", query.cursor, query.limit, { contentHash: query.contentHash }, parseTransactionSummary);
  }

  /** Account creation/update lifecycle, including failed transactions. */
  async getAccountHistory(query: AccountHistoryQuery): Promise<TransactionPageResult> {
    return this.fetchPage("pcash_getAccountHistory", query.cursor, query.limit, { address: query.address }, parseTransactionSummary);
  }

  /** Newest-first immutable contract creations from the canonical derived index. */
  async getContracts(query: ContractQuery = {}): Promise<ContractPageResult> {
    return this.fetchPage("pcash_getContracts", query.cursor, query.limit, {
      ...(query.verifiedOnly === undefined ? {} : { verifiedOnly: query.verifiedOnly }),
    }, parseContractSummary);
  }

  /** One canonical inclusion with its outcome and exact transaction bytes. */
  async getTransaction(transactionId: string): Promise<TransactionResult | null> {
    return this.lookupTransaction("pcash_getTransaction", transactionId);
  }

  /** The successful canonical transaction that consumed a nullifier. */
  async getTransactionByNullifier(nullifier: string): Promise<TransactionResult | null> {
    return this.lookupTransaction("pcash_getTransactionByNullifier", nullifier);
  }

  private async lookupTransaction(method: string, key: string): Promise<TransactionResult | null> {
    return nullable(parseTransactionResult)(await this.call<unknown>(method, [key]), method);
  }

  /** Carrier and item diagnostics for every carrier of one canonical L1 transaction, in carrier order, read page by page; empty when it carries none. */
  async getL1DeliveryBatches(l1TransactionHash: string): Promise<L1DeliveryBatchResult[]> {
    const batches: L1DeliveryBatchResult[] = [];
    let page = await this.l1DeliveryBatchPage(l1TransactionHash, {});
    batches.push(...page.batches);
    while (page.continuation !== null) {
      page = await this.l1DeliveryBatchPage(l1TransactionHash, { continuation: page.continuation });
      batches.push(...page.batches);
    }
    return batches;
  }

  /** The Inbox carrier's manifest of one canonical L1 transaction, or null when it has none. Carrier order puts an Inbox carrier first, so one manifest is read. */
  async getInboxDeliveryBatch(l1TransactionHash: string): Promise<L1DeliveryBatchResult | null> {
    const [first] = (await this.l1DeliveryBatchPage(l1TransactionHash, { limits: { maxBatches: 1 } })).batches;
    return first !== undefined && first.carrierType !== "event" ? first : null;
  }

  /** One page of an L1 transaction's manifests, and the node's continuation, which is null on the last page and otherwise passed back unread. */
  private async l1DeliveryBatchPage(
    l1TransactionHash: string,
    request: { continuation?: unknown; limits?: { maxBatches: number } },
  ): Promise<{ batches: L1DeliveryBatchResult[]; continuation: unknown }> {
    const label = "pcash_getL1DeliveryBatches";
    const raw = rpcObject(await this.call<unknown>(label, [{
      l1TransactionHash,
      ...(request.continuation === undefined ? {} : { continuation: request.continuation }),
      ...(request.limits === undefined ? {} : { limits: encodePageLimits(request.limits) }),
    }]), `${label} result`);
    return {
      batches: array(parseL1DeliveryBatch)(raw.batches, `${label}.batches`),
      continuation: rpcOwn(raw, "continuation", `${label}.continuation`),
    };
  }

  async getAccount(address: string): Promise<AccountResult | null> {
    return nullable(parseAccountValue)(await this.call<unknown>("pcash_getAccount", [address]), "pcash_getAccount");
  }

  /** Fetch and close one output opening, or return null when the index is absent. */
  async getOutputPath(
    outputIndex: bigint | number,
    outputCommitment: bigint,
  ): Promise<OutputPathResult | null> {
    const r = await this.call<Record<string, unknown> | null>("pcash_getOutputPath", [
      numberToHex(BigInt(outputIndex)),
    ]);
    if (r === null) return null;
    const index = parseHexQuantity(r.outputIndex);
    const count = parseHexQuantity(r.count);
    const root = field(r.root, "output root");
    const siblings = fields(r.siblings, "output sibling");
    const boundary = parseBoundary(r.boundary);
    if (index !== BigInt(outputIndex) || index >= count || siblings.length !== MERKLE_DEPTH) {
      throw new Error("invalid output opening metadata");
    }
    if (root !== boundary.state.outputRoot || count !== boundary.state.outputCount) {
      throw new Error("output opening does not match boundary state");
    }
    if (rootFromIndex(outputCommitment, index, siblings) !== root) {
      throw new OutputOpeningMismatchError("output path mismatch");
    }
    return { outputIndex: index, root: bytes32Hex(root), count, siblings, boundary };
  }

  /**
   * pcash_getOutputPaths — openings for up to 64 outputs taken against one
   * consistent output root and block snapshot, so a multi-input spend proves
   * every input against the selected snapshot's output root. The response `paths` are in
   * request order. Returns null when any requested output is absent.
   */
  async getOutputPaths(
    requests: readonly { outputIndex: bigint | number; outputCommitment: bigint }[],
  ): Promise<OutputPathsResult | null> {
    const r = await this.call<Record<string, unknown> | null>("pcash_getOutputPaths", [
      requests.map(({ outputIndex }) => numberToHex(BigInt(outputIndex))),
    ]);
    return this.parseOutputPaths(r, requests);
  }

  private parseOutputPaths(r: Record<string, unknown> | null, requests: readonly { outputIndex: bigint | number; outputCommitment: bigint }[]): OutputPathsResult | null {
    if (r === null) return null;
    const root = field(r.root, "output root");
    const count = parseHexQuantity(r.count);
    const boundary = parseBoundary(r.boundary);
    if (root !== boundary.state.outputRoot || count !== boundary.state.outputCount) {
      throw new Error("output openings do not match boundary state");
    }
    if (!Array.isArray(r.paths) || r.paths.length !== requests.length) {
      throw new Error("output path count mismatch");
    }
    const paths = r.paths.map((value: unknown, index) => {
      const path = rpcObject(value, "output path");
      const outputIndex = parseHexQuantity(path.outputIndex);
      const siblings = fields(path.siblings, "output sibling");
      if (outputIndex !== BigInt(requests[index]!.outputIndex) || outputIndex >= count || siblings.length !== MERKLE_DEPTH) {
        throw new Error("invalid batched output opening metadata");
      }
      if (rootFromIndex(requests[index]!.outputCommitment, outputIndex, siblings) !== root) {
        throw new OutputOpeningMismatchError("batched output path mismatch");
      }
      return { outputIndex, siblings };
    });
    return { root: bytes32Hex(root), count, paths, boundary };
  }

  async getAccountProof(address: string): Promise<AccountProofResult> {
    const r = await this.call<Record<string, unknown>>("pcash_getAccountProof", [address]);
    return this.parseAccountProof(r, address);
  }

  private parseAccountProof(r: Record<string, unknown>, address: string): AccountProofResult {
    if (r.status === "notFound") {
      if ((r.address as string).toLowerCase() !== address.toLowerCase() || r.authenticated !== false) {
        throw new Error("malformed unauthenticated account miss");
      }
      return { status: "notFound", address: r.address as string, authenticated: false };
    }
    const proof = parseAndVerifyAccountProof(r);
    if (proof.account.address.toLowerCase() !== address.toLowerCase()) throw new Error("account address mismatch");
    return proof;
  }

  /** The head, a block by number, or a block by hash; a hash read returns that exact block. */
  async getBlockHeader(block: "latest" | bigint | number | { hash: bigint } = "latest"): Promise<BlockHeaderResult> {
    const tag = block === "latest" ? block : typeof block === "object" ? bytes32Hex(block.hash) : numberToHex(BigInt(block));
    const result = this.parseBlockHeader(await this.call<Record<string, unknown>>("pcash_getBlockHeader", [tag]));
    if (typeof block === "object" && result.recentPcashBlockHash !== block.hash) throw new Error("block-header hash mismatch");
    return result;
  }

  private parseBlockHeader(r: Record<string, unknown>): BlockHeaderResult {
    const boundary = parseBoundary(r.boundary);
    const recentPcashBlockHash = field(r.recentPcashBlockHash, "recentPcashBlockHash");
    if (recentPcashBlockHash !== boundary.blockHash) throw new Error("block-header hash echo mismatch");
    return { recentPcashBlockHash, boundary };
  }

  async getContract(address: string): Promise<ContractResult> {
    return this.parseContractResult(
      await this.call<Record<string, unknown>>("pcash_getContract", [address]),
      address,
    );
  }

  /**
   * Authenticate one contract response: verify the account proof, decode the
   * origin transaction, and require the reconstructed contract to match the
   * authenticated account. Shared with the source-verification surface, which
   * embeds the same payload — an explorer must verify what it labels verified.
   */
  parseContractResult(r: Record<string, unknown>, address: string): ContractResult {
    const status = rpcString(r.status, "contract.status");
    if (status === "notFound") {
      const returnedAddress = rpcString(r.address, "contract.address");
      if (returnedAddress.toLowerCase() !== address.toLowerCase() || rpcOwn(r, "authenticated", "contract.authenticated") !== false) {
        throw new Error("malformed unauthenticated contract miss");
      }
      return { status, address: returnedAddress, authenticated: false };
    }
    if (status === "unavailable") {
      const returnedAddress = rpcString(r.address, "contract.address");
      if (returnedAddress.toLowerCase() !== address.toLowerCase()) throw new Error("contract address mismatch");
      return { status, address: returnedAddress, lifecycle: rpcString(r.lifecycle, "contract.lifecycle") };
    }
    if (status === "notContract") {
      const accountProof = parseAndVerifyAccountProof(r.accountProof);
      if (accountProof.account.address.toLowerCase() !== address.toLowerCase()) throw new Error("contract address mismatch");
      return { status, accountProof };
    }
    if (status !== "contract") throw new Error("unknown contract-result discriminant");
    const accountProof = parseAndVerifyAccountProof(r.accountProof);
    if (accountProof.account.accountKind !== 1) throw new Error("contract response has non-contract account kind");
    const returnedAddress = rpcString(r.address, "contract.address");
    const transaction = rpcString(r.transaction, "contract.transaction");
    const transactionBytes = hexToBytes(transaction);
    const decodedEntry = decodeTransaction(transactionBytes);
    const creationBody = decodedEntry.kind === TX_KIND_CONTRACT_ACCOUNT_CREATION ? decodedEntry.body
      : decodedEntry.kind === 0 && decodedEntry.accountCreation?.kind === "contract" ? decodedEntry.accountCreation.body : undefined;
    if (creationBody === undefined) throw new Error("contract origin carries no contract creation");
    const body = decodeContractBody(creationBody);
    const verification = verifyContract(body);
    if (
      verification.address !== BigInt(returnedAddress) ||
      verification.address !== BigInt(address) ||
      verification.address !== BigInt(accountProof.account.address) ||
      verification.nullifierKeyCommitment
        !== field(accountProof.account.nullifierKeyCommitment, "account nullifierKeyCommitment") ||
      verification.functionSetCommitment !== field(accountProof.account.accountRuleSetCommitment, "function set")
    ) throw new Error("contract body does not match authenticated account");
    if (body.mlKemPublicKey === undefined) {
      if (accountProof.account.material.status !== "notPresent") throw new Error("contract receive material mismatch");
    } else if (
      accountProof.account.material.status !== "available" ||
      !bytesEqual(body.mlKemPublicKey, hexToBytes(accountProof.account.material.mlKem768PublicKey))
    ) throw new Error("contract receive key does not match origin body");
    const origin = parseContractOrigin(r.origin, "contract.origin");
    return {
      status: "contract",
      address: addressHex(verification.address),
      accountProof,
      publishesNkRoot: body.nullifierKey.publishesNkRoot,
      nkRoot: body.nullifierKey.publishesNkRoot ? bytes32Hex(toField(body.nullifierKey.nkRoot, "nkRoot")) : null,
      functions: body.functions.map((entry) => ({
        selector: entry.selector,
        applicationVkHash: bytes32Hex(toField(entry.applicationVkHash, "applicationVkHash")),
        configurationCommitment: bytes32Hex(toField(entry.configurationCommitment, "configurationCommitment")),
      })),
      transaction,
      origin,
    };
  }

  async getResultProof(recentPcashBlockHash: bigint, blockNumber: bigint, position: ResultPosition): Promise<ResultProofRpc | null> {
    const wirePosition = "pcashTransactionIndex" in position ? { pcashTransactionIndex: numberToHex(position.pcashTransactionIndex) } : { payoutIndex: numberToHex(position.payoutIndex) };
    const proof = await this.call<ResultProofRpc | null>("pcash_getResultProof", [bytes32Hex(recentPcashBlockHash), numberToHex(blockNumber), wirePosition]);
    if (proof !== null) verifyResultProof(proof, recentPcashBlockHash, blockNumber, position);
    return proof;
  }

  async getL1OriginProof(
    recentPcashBlockHash: bigint,
    l1BlockNumber: bigint | number,
  ): Promise<L1OriginProofResult> {
    const r = await this.call<Record<string, unknown>>("pcash_getL1OriginProof", [
      bytes32Hex(recentPcashBlockHash),
      numberToHex(BigInt(l1BlockNumber)),
    ]);
    return parseL1OriginProofResponse(r, recentPcashBlockHash, l1BlockNumber);
  }

  async getL1LogProof(
    recentPcashBlockHash: bigint,
    l1BlockNumber: bigint | number,
    transactionIndex: bigint | number,
    logIndex: bigint | number,
    log: L1LogInput,
  ): Promise<L1LogProofResult> {
    const r = await this.call<Record<string, unknown>>("pcash_getL1LogProof", [
      bytes32Hex(recentPcashBlockHash),
      numberToHex(BigInt(l1BlockNumber)),
      numberToHex(BigInt(transactionIndex)),
      numberToHex(BigInt(logIndex)),
    ]);
    return this.parseL1LogProof(r, recentPcashBlockHash, l1BlockNumber, transactionIndex, logIndex, log);
  }

  private parseL1LogProof(r: Record<string, unknown>, recentPcashBlockHash: bigint, l1BlockNumber: bigint | number, transactionIndex: bigint | number, logIndex: bigint | number, log: L1LogInput): L1LogProofResult {
    const block = parseL1OriginProofResponse(r, recentPcashBlockHash, l1BlockNumber);
    const returnedTransactionIndex = parseHexQuantity(r.transactionIndex);
    const returnedLogIndex = parseHexQuantity(r.logIndex);
    const logLeafIndex = parseHexQuantity(r.logLeafIndex);
    const logSiblings = fields(r.logSiblings, "L1 log sibling");
    if (
      returnedTransactionIndex !== BigInt(transactionIndex) ||
      returnedLogIndex !== BigInt(logIndex) ||
      BigInt(log.transactionIndex) !== returnedTransactionIndex ||
      BigInt(log.logIndex) !== returnedLogIndex ||
      logSiblings.length !== L1_LOG_TREE_DEPTH
    ) throw new Error("invalid normalized L1 log proof shape");
    if (!verifyNormalizedL1LogPath(
      {
        logsRoot: block.l1LogsRoot,
        logCount: block.l1LogCount,
        logLeafIndex,
        logSiblings,
      },
      log,
    )) throw new Error("invalid normalized L1 log membership proof");
    return {
      ...block,
      logLeafIndex,
      logSiblings,
      transactionIndex: returnedTransactionIndex,
      logIndex: returnedLogIndex,
    };
  }

  async getHistoryProof(
    recentPcashBlockHash: bigint,
    historicalBlockNumber: bigint | number,
  ): Promise<HistoryProofResult> {
    const r = await this.call<Record<string, unknown>>("pcash_getHistoryProof", [
      bytes32Hex(recentPcashBlockHash),
      numberToHex(BigInt(historicalBlockNumber)),
    ]);
    const returnedHash = field(r.recentPcashBlockHash, "recentPcashBlockHash");
    const historyRoot = field(r.historyRoot, "historyRoot");
    const historyRootSiblings = fields(r.historyRootSiblings, "history root header sibling");
    const returnedNumber = parseHexQuantity(r.historicalBlockNumber);
    const historicalBlockHash = field(r.historicalBlockHash, "historicalBlockHash");
    const historySiblings = fields(r.historySiblings, "history sibling");
    if (
      returnedHash !== toField(recentPcashBlockHash, "recentPcashBlockHash") ||
      returnedNumber !== BigInt(historicalBlockNumber) ||
      historyRootSiblings.length !== BLOCK_HEADER_TREE_DEPTH ||
      historySiblings.length !== HISTORY_TREE_DEPTH ||
      !verifyBlockHeaderPath(returnedHash, BLOCK_HEADER_KEY_HISTORY_ROOT, historyRoot, historyRootSiblings) ||
      !verifyHistoryPath(historyRoot, returnedNumber, historicalBlockHash, historySiblings)
    ) throw new Error("invalid PCASH history proof");
    const boundary = parseBoundary(r.boundary);
    if (boundary.blockHash !== returnedHash || boundary.header.historyRoot !== historyRoot) {
      throw new Error("history proof boundary mismatch");
    }
    return {
      recentPcashBlockHash: returnedHash,
      historyRoot,
      historyRootSiblings,
      historicalBlockNumber: returnedNumber,
      historicalBlockHash,
      historySiblings,
      boundary,
    };
  }

  async getCurrentNullifierStatuses(nullifiers: readonly string[]): Promise<CurrentNullifierStatuses> {
    if (nullifiers.length === 0) return { statuses: [], boundary: null };
    if (nullifiers.length > 256) throw new Error("at most 256 nullifiers may be checked at once");
    const canonical = nullifiers.map((value) => toHex(parseCanonicalNullifier(value)));
    const r = await this.call<Record<string, unknown>>("pcash_getNullifierProofs", [canonical]);
    return this.parseNullifierStatuses(r, canonical);
  }

  /** `canonical` are the requested nullifiers as sent: canonical lowercase hex. */
  private parseNullifierStatuses(r: Record<string, unknown>, canonical: readonly string[]): CurrentNullifierStatuses {
    const boundary = parseBoundary(r.boundary);
    if (field(r.nullifierRoot, "nullifierRoot") !== boundary.state.nullifierRoot) {
      throw new Error("nullifier proof root does not match boundary state");
    }
    const proofs = parseNullifierProofs(r.proofs, "nullifier proofs");
    if (proofs.length !== canonical.length) throw new Error("nullifier proof count mismatch");
    const statuses = proofs.map((proof, index) => {
      const nullifier = canonical[index]!;
      if (toHex(parseCanonicalNullifier(proof.nullifier)) !== nullifier) throw new Error("nullifier proof echo mismatch");
      const opening = { ...proof, nullifier: BigInt(nullifier) };
      const spent = nullifierProofSpent(opening);
      if (spent === null || nullifierProofRoot(opening) !== boundary.state.nullifierRoot) {
        throw new Error("nullifier proof mismatch");
      }
      return { nullifier, spent };
    });
    return { statuses, boundary };
  }

  /**
   * Bounded latest-state read from the configured node. The booleans describe
   * whichever canonical head the node held while executing this call, are not
   * tied to a returned block identity, and may change as the head advances or
   * reorganizes. Suitable for refreshable wallet and UI views; callers needing
   * an explicit state boundary use `getCurrentNullifierStatuses`.
   */
  async areNullifiersSpent(nullifiers: readonly string[]): Promise<boolean[]> {
    if (nullifiers.length > 256) throw new Error("at most 256 nullifiers may be checked at once");
    const canonical = nullifiers.map((value) => {
      const bytes = parseCanonicalNullifier(value);
      return toHex(bytes);
    });
    if (canonical.length === 0) return [];
    const result = await this.call<unknown>("pcash_areNullifiersSpent", [canonical]);
    if (!Array.isArray(result) || result.length !== canonical.length || result.some((value) => typeof value !== "boolean")) {
      throw new Error("pcash_areNullifiersSpent returned a malformed response");
    }
    return result as boolean[];
  }

  async getReceipt(query: ReceiptQuery): Promise<ReceiptResult[]> {
    let rpcQuery: unknown = query;
    if (typeof query !== "string") {
      if ("inclusionId" in query) {
        rpcQuery = {
          inclusionId: {
            l1BlockHash: query.inclusionId.l1BlockHash,
            l1TransactionIndex: numberToHex(BigInt(query.inclusionId.l1TransactionIndex)),
            batchItemIndex: numberToHex(BigInt(query.inclusionId.batchItemIndex)),
          },
        };
      } else if ("contentHash" in query) {
        rpcQuery = { contentHash: query.contentHash };
      } else if ("accountRevision" in query) {
        rpcQuery = {
          address: query.address,
          accountRevision: numberToHex(BigInt(query.accountRevision)),
        };
      }
    }
    const receipts = array(parseReceiptDto)(await this.call<unknown>("pcash_getReceipt", [rpcQuery]), "pcash_getReceipt");
    const expectedTxId = typeof query === "string" ? fixedHex(query, 32, "expected transaction id") : undefined;
    const expectedContentHash = typeof query !== "string" && "contentHash" in query
      ? fixedHex(query.contentHash, 32, "expected content hash") : undefined;
    const expectedNullifier = typeof query !== "string" && "nullifier" in query
      ? fixedHex(query.nullifier, 32, "expected nullifier") : undefined;
    for (const [index, receipt] of receipts.entries()) {
      if (expectedTxId !== undefined && receipt.transactionId !== expectedTxId) {
        throw new Error(`pcash_getReceipt[${index}].transactionId does not match the requested transaction`);
      }
      if (expectedContentHash !== undefined && receipt.contentHash !== expectedContentHash) {
        throw new Error(`pcash_getReceipt[${index}].contentHash does not match the requested content`);
      }
      if (expectedNullifier !== undefined && !receipt.nullifiers?.includes(expectedNullifier)) {
        throw new Error(`pcash_getReceipt[${index}].nullifiers does not contain the requested nullifier`);
      }
    }
    return receipts;
  }

  /**
   * Capability and health of this node's optional publication catalog.
   *
   * Always answers, including on a node started without `--enable-catalog`, so
   * capability detection never depends on the service being up.
   */
  async catalogInfo(): Promise<CatalogInfo> {
    return decodeCatalogInfo(await this.call<unknown>("pcash_catalogInfo"));
  }

  /**
   * One page of catalog records. Results are untrusted and incomplete by
   * construction: the caller verifies anything it acts on.
   */
  async catalogList(query: CatalogListQuery): Promise<CatalogPage> {
    const result = await this.call<unknown>("pcash_catalogList", [encodeCatalogListQuery(query)]);
    const page = decodeCatalogPage(result);
    for (const record of page.items) {
      if (record.artifact.namespace !== query.namespace) {
        throw new Error(
          `catalog returned record ${record.artifact.contentId} from namespace ${record.artifact.namespace}, not the requested ${query.namespace}`,
        );
      }
    }
    return page;
  }

  /**
   * One catalog record by content ID, or `null` when the namespace has none.
   *
   * The record is bound to the content ID that was asked for, so a node cannot
   * answer a point read with a different record.
   */
  async catalogGet(namespace: string, contentId: string): Promise<CatalogRecord | null> {
    const query = encodeCatalogGetQuery(namespace, contentId);
    const result = await this.call<unknown>("pcash_catalogGet", [query]);
    if (result === null) return null;
    const record = decodeCatalogRecord(result);
    assertCatalogRecordIdentity(record, query.contentId);
    return record;
  }

  /**
   * Store one artifact, or return the existing record unchanged. Returns the
   * stored record, including the node-assigned `createdAt`.
   *
   * The returned record is bound to the artifact that was sent, so a content ID
   * taken from it — for a share link, say — always names these exact bytes.
   */
  async catalogPublish(artifact: CatalogArtifact): Promise<CatalogRecord> {
    const encoded = encodeCatalogArtifact(artifact);
    const result = await this.call<unknown>("pcash_catalogPublish", [encoded]);
    const record = decodeCatalogRecord(result);
    assertCatalogRecordIdentity(record, encoded.contentId);
    return record;
  }

  /** Submit exact encoded transaction bytes to this node's bounded local queue. */
  async submitRawTransaction(txBytes: string): Promise<SubmitRawTransactionResult> {
    return parseSubmitResult(
      await this.call<unknown>("pcash_submitRawTransaction", [txBytes]),
      "pcash_submitRawTransaction",
    );
  }

  /**
   * Check exact transaction bytes as the next block would execute them if `carrier` delivered them,
   * without admitting or broadcasting them.
   */
  async checkRawTransaction(transaction: Uint8Array, carrier: CarrierContextInput): Promise<TransactionCheckResult> {
    const query = {
      transaction: toHex(transaction),
      carrier: carrier.kind === "inbox"
        ? { kind: "inbox", address: carrier.address }
        : { kind: "event", address: carrier.address, context: toHex(carrier.context) },
    };
    return parseTransactionCheck(
      await this.call<unknown>("pcash_checkRawTransaction", [query]),
      "pcash_checkRawTransaction",
    );
  }

  /** List transactions seen by this node. This is a local view, not a global ordering. */
  async getMempool(query: MempoolQuery = {}): Promise<MempoolPageResult> {
    const encoded: Record<string, unknown> = { ...query };
    if (query.limit !== undefined) encoded.limit = numberToHex(BigInt(query.limit));
    if (query.minOpenFee !== undefined) encoded.minOpenFee = numberToHex(BigInt(query.minOpenFee));
    if (query.arena !== undefined) {
      encoded.arena = {
        schema: query.arena.schema,
        ...(query.arena.data === undefined ? {} : { data: query.arena.data.map(({ offset, bytes }) => ({ offset: numberToHex(BigInt(offset)), bytes })) }),
      };
    }
    return parseMempoolPage(await this.call<unknown>("pcash_getMempool", [encoded]), "pcash_getMempool");
  }

  /** Look up one queued transaction by its content hash. */
  async getMempoolTransaction(contentHash: string): Promise<MempoolItemResult | null> {
    const value = await this.call<unknown>("pcash_getMempoolTransaction", [contentHash]);
    const item = nullable(parseMempoolItem)(value, "pcash_getMempoolTransaction");
    if (item !== null && item.contentHash !== fixedHex(contentHash, 32, "expected content hash")) {
      throw new Error("pcash_getMempoolTransaction.contentHash does not match the requested content");
    }
    return item;
  }

  /** Revalidate a selection at the current head and assemble exact L1 batch calldata. */
  async prepareRelay(request: PrepareRelayRequest): Promise<PrepareRelayResult> {
    const encoded = {
      contentHashes: request.contentHashes,
      controlledIssuanceOwnerCommitments: request.controlledIssuanceOwnerCommitments ?? [],
      controlledIssuanceContentHashes: request.controlledIssuanceContentHashes ?? [],
      maxBatchBytes: numberToHex(BigInt(request.maxBatchBytes)),
    };
    return parsePrepareRelay(await this.call<unknown>("pcash_prepareRelay", [encoded]), "pcash_prepareRelay");
  }

  async getOutputs(params: {
    fromOutputIndex: bigint;
    target: { pcashNumber: bigint; pcashHash: string };
    continuation?: Record<string, unknown> | null;
    limits?: { maxOutputs?: number; maxBytes?: number };
  }): Promise<OutputPageResult> {
    const request = {
      fromOutputIndex: numberToHex(params.fromOutputIndex),
      target: encodeOutputBoundary(params.target),
      ...(params.continuation !== undefined ? { continuation: params.continuation } : {}),
      ...(params.limits !== undefined ? { limits: encodePageLimits(params.limits) } : {}),
    };
    const raw = rpcObject(
      await this.call<unknown>("pcash_getOutputs", [request]),
      "pcash_getOutputs result",
    );
    if (!Array.isArray(raw.outputs) || typeof raw.complete !== "boolean") throw new Error("malformed output page");
    const fromOutputIndex = parseHexQuantity(raw.fromOutputIndex);
    if (fromOutputIndex > params.fromOutputIndex) throw new Error("output from index echo mismatch");
    const targetRaw = rpcObject(raw.target, "pcash_getOutputs.target");
    const target = {
      ...decodeOutputBoundary(rpcObject(targetRaw.block, "pcash_getOutputs.target.block")),
      outputCount: parseHexQuantity(targetRaw.outputCount),
    };
    if (!sameOutputBoundary(target, params.target) || fromOutputIndex > target.outputCount) {
      throw new Error("output target mismatch");
    }
    const outputs = raw.outputs.map((value, index): OutputResult => {
      const output = rpcObject(value, `outputs[${index}]`);
      const outputCommitment = rpcString(output.outputCommitment, "output commitment");
      if (hexToBytes(outputCommitment).length !== 32) throw new Error("output commitment must have 32 bytes");
      const common = {
        outputIndex: parseHexQuantity(output.outputIndex), outputCommitment,
        origin: decodeOutputOrigin(rpcObject(output.origin, "output origin")),
      };
      if (output.kind === "system") {
        return { ...common, kind: "system", payout: parseOutputPayout(output.payout, "system payout") };
      }
      if (output.kind !== "ordinary") throw new Error("unknown output kind");
      const transactionId = rpcString(output.transactionId, "output transactionId");
      if (hexToBytes(transactionId).length !== 32) throw new Error("output transaction id must have 32 bytes");
      const contentHash = hexBytes(32)(output.contentHash, "output contentHash");
      const nullifiers = array(hexBytes(32))(output.nullifiers, "output nullifiers");
      const transactionType = parseHexQuantity(output.transactionType), outputSlot = parseHexQuantity(output.outputSlot);
      if (transactionType >= 1n << 8n || outputSlot >= 1n << 16n) throw new Error("output type or slot is out of range");
      const rawShape = rpcOwn(output, "privateValueShape", "output privateValueShape");
      let privateValueShape: PrivateValueShape | null = null;
      let profile: PrivateValueProfile = PRIVATE_VALUE_PROFILES.S;
      if (transactionType === 0n) {
        const value = parseHexQuantity(rawShape, "output privateValueShape");
        if (value > 255n) throw new Error("output private-value shape is out of range");
        profile = privateValueProfile(Number(value));
        privateValueShape = profile.shapeId;
        if (outputSlot >= BigInt(profile.outputs)) throw new Error("output slot exceeds the selected profile");
      } else {
        if (rawShape !== null) throw new Error("account output cannot select a private-value shape");
        if (outputSlot >= BigInt(PRIVATE_VALUE_PROFILES.S.outputs)) throw new Error("account output slot exceeds S");
      }
      if (nullifiers.length !== (outputSlot === 0n ? profile.inputs : 0)) {
        throw new Error("output nullifiers must list every input nullifier on slot 0 and nothing on other slots");
      }
      const rawArena = output.arena ?? null;
      const arena = rawArena === null ? null : hexToBytes(rpcString(rawArena, "output arena"));
      if (outputSlot === 0n ? arena?.length !== profile.arenaBytes : arena !== null) {
        throw new Error(`output arena must be ${profile.arenaBytes} bytes on slot 0 and absent on other slots`);
      }
      return {
        ...common, kind: "ordinary", outputData: hexToBytes(rpcString(output.outputData, "note output data")),
        transactionId, contentHash, transactionType: Number(transactionType), privateValueShape,
        outputSlot: Number(outputSlot), nullifiers, arena,
      };
    });
    // A first page starts at the interval's start; a continuation page at
    // the previous page's end.
    const resumed = params.continuation === undefined || params.continuation === null ? null : params.continuation;
    const start = resumed === null ? fromOutputIndex : parseHexQuantity(resumed.nextOutputIndex);
    if (outputs.some((output, index) => output.outputIndex !== start + BigInt(index)
      || output.outputIndex >= target.outputCount
      || output.origin.pcashNumber > target.pcashNumber)) {
      throw new Error("outputs are not contiguous within the requested interval");
    }
    // An interval starts earlier than requested only when the request fell
    // inside a transaction: it then starts at that transaction's first output.
    if (resumed !== null) {
      if (fromOutputIndex !== parseHexQuantity(resumed.fromOutputIndex)) throw new Error("output from index echo mismatch");
    } else if (fromOutputIndex !== params.fromOutputIndex) {
      const first = outputs[0];
      if (first?.kind !== "ordinary" || first.outputSlot !== 0
        || params.fromOutputIndex - fromOutputIndex >= BigInt(outputUnitRows(first))) {
        throw new Error("output from index echo mismatch");
      }
    }
    assertWholeOutputUnits(outputs);
    const continuationValue = rpcOwn(raw, "continuation", "pcash_getOutputs.continuation");
    const continuation = continuationValue === null
      ? null
      : parseOutputContinuation(continuationValue, fromOutputIndex, target);
    if (raw.complete && continuation !== null) throw new Error("complete output page has a continuation");
    if (!raw.complete && continuation === null) throw new Error("incomplete output page lacks a continuation");
    const end = start + BigInt(outputs.length);
    if (continuation === null ? end !== target.outputCount
      : outputs.length === 0 || parseHexQuantity(continuation.nextOutputIndex) !== end) {
      throw new Error("output page does not end at its continuation");
    }
    return { fromOutputIndex, target, outputs, continuation, complete: raw.complete };
  }

  /** The output-tree append frontier committed by a canonical block. */
  async getOutputFrontier(target: { pcashNumber: bigint; pcashHash: string }): Promise<OutputFrontierResult> {
    const raw = rpcObject(
      await this.call<unknown>("pcash_getOutputFrontier", [encodeOutputBoundary(target)]),
      "pcash_getOutputFrontier result",
    );
    const block = decodeOutputBoundary(rpcObject(raw.block, "pcash_getOutputFrontier.block"));
    if (!sameOutputBoundary(block, target)) throw new Error("output frontier block echo mismatch");
    const outputCount = parseHexQuantity(raw.outputCount, "output frontier count");
    const outputRoot = field(raw.outputRoot, "output frontier root");
    const ommers = fields(raw.ommers, "output frontier ommer");
    if (outputCount > 1n << BigInt(MERKLE_DEPTH) || ommers.length !== popcount(outputCount)) {
      throw new Error("output frontier ommers do not match its count");
    }
    return { target: block, outputCount, outputRoot, frontier: { count: outputCount, ommers } };
  }

  /** Every account write in blocks fromBlock..target, in canonical order, one page at a time. */
  async getAccountChanges(params: {
    fromBlock: bigint;
    target: { pcashNumber: bigint; pcashHash: string };
    continuation?: Record<string, unknown> | null;
    limits?: { maxChanges?: number; maxBytes?: number };
  }): Promise<AccountChangePageResult> {
    const request = {
      fromBlock: numberToHex(params.fromBlock),
      target: encodeOutputBoundary(params.target),
      ...(params.continuation !== undefined ? { continuation: params.continuation } : {}),
      ...(params.limits !== undefined ? { limits: encodePageLimits(params.limits) } : {}),
    };
    const raw = rpcObject(
      await this.call<unknown>("pcash_getAccountChanges", [request]),
      "pcash_getAccountChanges result",
    );
    if (!Array.isArray(raw.changes) || typeof raw.complete !== "boolean") throw new Error("malformed account change page");
    const fromBlock = parseHexQuantity(raw.fromBlock);
    if (fromBlock !== params.fromBlock) throw new Error("account change from block echo mismatch");
    const targetRaw = rpcObject(raw.target, "pcash_getAccountChanges.target");
    const target = {
      ...decodeOutputBoundary(rpcObject(targetRaw.block, "pcash_getAccountChanges.target.block")),
      accountCount: parseHexQuantity(targetRaw.accountCount),
    };
    if (!sameOutputBoundary(target, params.target) || fromBlock > target.pcashNumber + 1n) {
      throw new Error("account change target mismatch");
    }
    const changes = raw.changes.map((value, index) => parseAccountChange(value, `changes[${index}]`));
    if (changes.some((change, index) => change.origin.pcashNumber < fromBlock
      || change.origin.pcashNumber > target.pcashNumber
      || change.accountIndex >= target.accountCount
      || (index > 0 && change.origin.pcashNumber < changes[index - 1]!.origin.pcashNumber))) {
      throw new Error("account changes are not ordered within the requested interval");
    }
    const continuationValue = rpcOwn(raw, "continuation", "pcash_getAccountChanges.continuation");
    const continuation = continuationValue === null
      ? null
      : parseAccountChangeContinuation(continuationValue, fromBlock, target);
    if (raw.complete && continuation !== null) throw new Error("complete account change page has a continuation");
    if (!raw.complete && continuation === null) throw new Error("incomplete account change page lacks a continuation");
    return { fromBlock, target, changes, continuation, complete: raw.complete };
  }
}

const parseAccountChange: Parser<AccountChange> = (value, label) => {
  const change = shape({
    origin: (origin, originLabel) => decodeOutputBoundary(rpcObject(origin, originLabel)),
    accountIndex: quantity,
    address: hexBytes(20),
    nullifierKeyCommitment: field,
    accountRuleSetCommitment: field,
    accountKind: quantity,
    accountRevision: quantity,
    receiveKeyHash: fieldWord,
    receiveKey: nullable((key, keyLabel) => fromHex(str(key, keyLabel), keyLabel)),
  })(value, label);
  if (change.accountKind > 1n) throw new Error(`${label}.accountKind must be user or contract`);
  if (change.accountRevision === 0n || change.accountRevision >= 1n << 32n) {
    throw new Error(`${label}.accountRevision must be a nonzero u32`);
  }
  if (change.receiveKey !== null && change.receiveKey.length !== ML_KEM_768_PUBLIC_KEY_LENGTH) {
    throw new Error(`${label}.receiveKey must be a published ${ML_KEM_768_PUBLIC_KEY_LENGTH}-byte ML-KEM-768 key`);
  }
  return { ...change, accountKind: change.accountKind === 0n ? 0 : 1, accountRevision: Number(change.accountRevision) };
};

/** Fixed-width 0x hex from a node response, lowercased. */
function hexBytes(bytes: number): Parser<Hex> {
  return (value, label) => fixedHex(value, bytes, label) as Hex;
}

/** A field element carried as a canonical 32-byte big-endian word, lowercased; values >= p are rejected. */
function fieldWord(value: unknown, label: string): Hex {
  return fieldToHex(toField(BigInt(fixedHex(value, 32, label)), label));
}

function popcount(value: bigint): number {
  let count = 0;
  for (let rest = value; rest > 0n; rest >>= 1n) count += Number(rest & 1n);
  return count;
}

function encodePageLimits(limits: Record<string, number | undefined>): Record<string, string> {
  const encoded: Record<string, string> = {};
  for (const [key, value] of Object.entries(limits)) if (value !== undefined) encoded[key] = numberToHex(BigInt(value));
  return encoded;
}

function encodeOutputBoundary(boundary: { pcashNumber: bigint; pcashHash: string }): Record<string, string> {
  return { blockNumber: numberToHex(boundary.pcashNumber), blockHash: boundary.pcashHash };
}

function decodeOutputBoundary(boundary: Record<string, unknown>): { pcashNumber: bigint; pcashHash: string } {
  if (Object.keys(boundary).length !== 2) throw new Error("malformed output block cursor");
  return {
    pcashNumber: parseHexQuantity(boundary.blockNumber),
    pcashHash: rpcString(boundary.blockHash, "output block hash"),
  };
}

function decodeOutputOrigin(origin: Record<string, unknown>): OutputOrigin {
  if (Object.keys(origin).length !== 3) throw new Error("malformed output origin");
  return {
    pcashNumber: parseHexQuantity(origin.blockNumber),
    pcashHash: rpcString(origin.blockHash, "output block hash"),
    timestamp: parseHexQuantity(origin.blockTimestamp, "output block timestamp"),
  };
}

/** A paged feed's continuation object, holding exactly `keys`. */
function parseContinuation(
  value: unknown,
  label: string,
  keys: readonly string[],
): Record<string, unknown> {
  const continuation = rpcObject(value, label);
  if (
    Object.keys(continuation).length !== keys.length ||
    keys.some((key) => !Object.prototype.hasOwnProperty.call(continuation, key))
  ) throw new Error(`malformed ${label}`);
  return continuation;
}

/** Rows in one transaction's unit: every output slot of its section. */
function outputUnitRows(output: Extract<OutputResult, { kind: "ordinary" }>): number {
  return output.privateValueShape === null ? PRIVATE_VALUE_PROFILES.S.outputs : privateValueProfile(output.privateValueShape).outputs;
}

/** Every transaction on a page is whole: slots 0..O-1 of one transaction, in order. */
function assertWholeOutputUnits(outputs: readonly OutputResult[]): void {
  for (let index = 0; index < outputs.length;) {
    const first = outputs[index]!;
    if (first.kind === "system") {
      index += 1;
      continue;
    }
    const rows = outputUnitRows(first);
    if (first.outputSlot !== 0 || index + rows > outputs.length) throw new Error("output page splits a transaction");
    for (let slot = 1; slot < rows; slot++) {
      const row = outputs[index + slot]!;
      if (row.kind !== "ordinary" || row.outputSlot !== slot
        || row.transactionId.toLowerCase() !== first.transactionId.toLowerCase()
        || row.contentHash.toLowerCase() !== first.contentHash.toLowerCase()
        || row.transactionType !== first.transactionType
        || row.privateValueShape !== first.privateValueShape) {
        throw new Error("output page splits a transaction");
      }
    }
    index += rows;
  }
}

function parseOutputContinuation(
  value: unknown,
  expectedFrom: bigint,
  expectedTarget: { pcashNumber: bigint; pcashHash: string; outputCount: bigint },
): Record<string, unknown> {
  const continuation = parseContinuation(
    value,
    "output continuation",
    ["fromOutputIndex", "target", "targetOutputCount", "nextOutputIndex"],
  );
  const target = decodeOutputBoundary(rpcObject(continuation.target, "output continuation target"));
  if (parseHexQuantity(continuation.fromOutputIndex) !== expectedFrom
    || !sameOutputBoundary(target, expectedTarget)
    || parseHexQuantity(continuation.targetOutputCount) !== expectedTarget.outputCount) {
    throw new Error("output continuation interval mismatch");
  }
  const nextOutputIndex = parseHexQuantity(continuation.nextOutputIndex);
  if (nextOutputIndex <= expectedFrom || nextOutputIndex > expectedTarget.outputCount) {
    throw new Error("output continuation does not advance within its target");
  }
  return continuation;
}

function parseAccountChangeContinuation(
  value: unknown,
  expectedFrom: bigint,
  expectedTarget: { pcashNumber: bigint; pcashHash: string },
): Record<string, unknown> {
  const continuation = parseContinuation(
    value,
    "account change continuation",
    ["fromBlock", "target", "nextBlock", "nextOrdinal"],
  );
  const target = decodeOutputBoundary(rpcObject(continuation.target, "account change continuation target"));
  if (parseHexQuantity(continuation.fromBlock) !== expectedFrom || !sameOutputBoundary(target, expectedTarget)) {
    throw new Error("account change continuation interval mismatch");
  }
  // (nextBlock, nextOrdinal) must lie after (fromBlock, 0) and at or before (target + 1, 0).
  const nextBlock = parseHexQuantity(continuation.nextBlock);
  const nextOrdinal = parseHexQuantity(continuation.nextOrdinal);
  if (
    nextBlock < expectedFrom
    || (nextBlock === expectedFrom && nextOrdinal === 0n)
    || nextBlock > expectedTarget.pcashNumber + 1n
    || (nextBlock > expectedTarget.pcashNumber && nextOrdinal !== 0n)
  ) throw new Error("account change continuation does not advance within its target");
  return continuation;
}

function sameOutputBoundary(
  a: { pcashNumber: bigint; pcashHash: string },
  b: { pcashNumber: bigint; pcashHash: string },
): boolean {
  return a.pcashNumber === b.pcashNumber && a.pcashHash.toLowerCase() === b.pcashHash.toLowerCase();
}

// Strict: a malformed node response must fail rather than decode to bytes that
// still look well-formed.
const hexToBytes = (hex: string): Uint8Array => fromHex(hex, "node response");
