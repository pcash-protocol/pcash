import { beBytes, splitHash256 } from "../utils/bytes.ts";
import { keccak256 } from "../utils/keccak.ts";
import { toHex, type Hex } from "../utils/hex.ts";
import {
  BLOCK_HEADER_DOMAIN,
  GENESIS_PARENT_DOMAIN,
  HISTORY_LEAF_DOMAIN,
  PAYOUT_RESULT_DOMAIN,
  STATE_COMMITMENT_DOMAIN,
  TRANSACTION_RESULT_DOMAIN,
  TRANSACTION_ID_DOMAIN,
  TRANSACTION_RESULTS_ROOT_DOMAIN,
  TRANSACTION_STATEMENT_DOMAIN,
} from "../constants/domainTags.ts";
import { DenseMerkleTree } from "../crypto/denseMerkleTree.ts";
import { type FieldNumberish, toField } from "../crypto/field.ts";
import { domainSeparatedRootFromIndex, rootFromIndex } from "../crypto/merkle.ts";
import { type NetworkConfigLike, resolveNetworkConfig } from "./network.ts";
import {
  BLOCK_HEADER_KEY_L1_ORIGIN_ROOT,
  BLOCK_HEADER_KEY_HISTORY_ROOT,
  BLOCK_HEADER_KEY_NUMBER,
  BLOCK_HEADER_KEY_PARENT_HASH,
  BLOCK_HEADER_KEY_STATE_ROOT,
  BLOCK_HEADER_KEY_TIMESTAMP,
  BLOCK_HEADER_KEY_TRANSACTION_RESULTS_ROOT,
  BLOCK_HEADER_TREE_DEPTH,
  L1_ORIGIN_TREE_DEPTH,
  HISTORY_TREE_DEPTH,
  STATE_KEY_ISSUED_SO_FAR,
  STATE_KEY_LAG_HIGH128,
  STATE_KEY_LAG_LOW128,
  STATE_KEY_OUTPUT_COUNT,
  STATE_KEY_OUTPUT_ROOT,
  STATE_KEY_NULLIFIER_ROOT,
  STATE_KEY_NULLIFIER_COUNT,
  STATE_KEY_ACCOUNT_COUNT,
  STATE_KEY_ACCOUNT_STATE_ROOT,
  STATE_TREE_DEPTH,
} from "../constants/params.ts";
import { poseidon } from "../crypto/poseidon2.ts";
import { l1OriginLeaf } from "./l1Logs.ts";
import { type MembershipProof } from "../crypto/tree.ts";
import { U128_LIMIT, U40_LIMIT, U64_LIMIT, uintBelow } from "../utils/validate.ts";

/** Depth of the tree of a block's transaction and payout results. */
export const TRANSACTION_RESULTS_TREE_DEPTH = 64;

/** §10.6: a proof executes only while its recentPcashBlockHash is at most this much older than the candidate block. */
export const RECENT_PCASH_BLOCK_WINDOW_SECONDS = 3_600n;

export const TRANSACTION_OUTCOME_CODE = Object.freeze({
  succeeded: 0,
  publicInputNotInField: 1,
  recentPcashBlockNotInWindow: 2,
  expired: 3,
  notYetValid: 4,
  zeroNullifier: 5,
  duplicateInputNullifier: 6,
  nullifierAlreadySpent: 7,
  proofRejected: 8,
  outputCapacity: 9,
  accountCapacity: 10,
  invalidAccountSignature: 11,
  accountNotFound: 12,
  accountAlreadyExists: 13,
  accountRevisionExhausted: 14,
  wrongAccountKind: 15,
  clearWithoutReceiveKey: 16,
  replaceWithIdenticalReceiveKey: 17,
  accountUpdateCommitmentMismatch: 18,
  nonCanonicalAccountField: 19,
  contractAddressExists: 20,
  nonCanonicalContractField: 21,
  emptyContractFunctionSet: 22,
  selectorsNotStrictlyIncreasing: 23,
  carrierContextMismatch: 24,
  accountCreationMismatch: 25,
} as const);

export type TransactionOutcome = keyof typeof TRANSACTION_OUTCOME_CODE;
export const TRANSACTION_OUTCOMES = Object.freeze(
  Object.keys(TRANSACTION_OUTCOME_CODE) as TransactionOutcome[],
);

/** One admitted transaction's committed result; its position in the block is its `pcashTransactionIndex`. */
export interface TransactionResultCommitment {
  txType: number;
  /** A contract-account creation's funding mode; zero for other types. */
  accountCreation: number;
  l1TransactionIndex: bigint;
  batchItemIndex: bigint;
  outcome: TransactionOutcome;
  /** The `posterOwnerCommitment` of the transaction's batch. */
  posterOwnerCommitment: FieldNumberish;
  /** The first output index a successful private-value section appended; zero for any other result. */
  outputStartIndex: bigint;
  /** `transactionStatementHash` of a successful transaction's statement; zero for a failed one. */
  statementHash: FieldNumberish;
}

/** One system payout's committed result, in settlement order after the block's transaction results. */
export interface PayoutResultCommitment {
  outputIndex: bigint;
  ownerCommitment: FieldNumberish;
  openFeeAmount: bigint;
  issuanceAmount: bigint;
}

function treeCount(value: FieldNumberish, name: string): bigint {
  const result = toField(value, name);
  if (result > U40_LIMIT) throw new Error(`${name} is out of range`);
  return result;
}

export interface StateCommitment {
  outputRoot: FieldNumberish;
  outputCount: FieldNumberish;
  issuedSoFar: FieldNumberish;
  /** Signed seconds times 2^128. */
  lagQ: bigint;
  accountStateRoot: FieldNumberish;
  accountCount: FieldNumberish;
  nullifierRoot: FieldNumberish;
  nullifierCount: FieldNumberish;
}

export interface BlockHeaderCommitment {
  parentHash: FieldNumberish;
  number: FieldNumberish;
  timestamp: FieldNumberish;
  /** `transactionResultsRoot(results, payouts)`. */
  transactionResultsRoot: FieldNumberish;
  stateRoot: FieldNumberish;
  l1OriginRoot: FieldNumberish;
  historyRoot: FieldNumberish;
}

function transactionOutcomeCode(outcome: TransactionOutcome): number {
  const value: unknown = TRANSACTION_OUTCOME_CODE[outcome];
  if (typeof value !== "number") throw new Error(`unknown transaction outcome ${String(outcome)}`);
  return value;
}

export type DecodedTransactionOutcome =
  | { supported: true; outcome: TransactionOutcome }
  | { supported: false; code: number };

export function transactionOutcomeFromCode(code: number): DecodedTransactionOutcome {
  if (!Number.isInteger(code) || code < 0 || code > 0xffff) {
    throw new Error("transaction outcome code must fit in u16");
  }
  for (const outcome of TRANSACTION_OUTCOMES) {
    if (TRANSACTION_OUTCOME_CODE[outcome] === code) return { supported: true, outcome };
  }
  return { supported: false, code };
}

/**
 * A transaction's statement hash. A proof-bearing transaction's statement is
 * its verifier's ordered public inputs; a user-account creation or unfunded
 * contract creation states `[address, nullifierKeyCommitment,
 * accountRuleSetCommitment, receiveKeyHash]` of the account it writes.
 */
export function transactionStatementHash(statement: readonly FieldNumberish[]): bigint {
  return poseidon([
    TRANSACTION_STATEMENT_DOMAIN,
    ...statement.map((value, index) => toField(value, `statement[${index}]`)),
  ]);
}

/** The leaf omits `pcashTransactionIndex`: the leaf's tree index is the transaction's position. */
export function transactionResultLeaf(result: TransactionResultCommitment): bigint {
  return poseidon([
    TRANSACTION_RESULT_DOMAIN,
    uintBelow(result.txType, 1n << 8n, "txType"),
    uintBelow(result.accountCreation, 1n << 8n, "accountCreation"),
    uintBelow(result.l1TransactionIndex, U64_LIMIT, "l1TransactionIndex"),
    uintBelow(result.batchItemIndex, U64_LIMIT, "batchItemIndex"),
    BigInt(transactionOutcomeCode(result.outcome)),
    toField(result.posterOwnerCommitment, "posterOwnerCommitment"),
    uintBelow(result.outputStartIndex, U40_LIMIT, "outputStartIndex"),
    toField(result.statementHash, "statementHash"),
  ]);
}

export function payoutResultLeaf(payout: PayoutResultCommitment): bigint {
  return poseidon([
    PAYOUT_RESULT_DOMAIN,
    uintBelow(payout.outputIndex, U40_LIMIT, "outputIndex"),
    toField(payout.ownerCommitment, "ownerCommitment"),
    uintBelow(payout.openFeeAmount, U128_LIMIT, "openFeeAmount"),
    uintBelow(payout.issuanceAmount, U128_LIMIT, "issuanceAmount"),
  ]);
}

/**
 * The header's transaction-results root: the depth-64 tree of every admitted
 * transaction's result in block order, then every system payout's result in
 * settlement order, bound with both counts.
 */
export function transactionResultsRoot(
  results: readonly TransactionResultCommitment[],
  payouts: readonly PayoutResultCommitment[],
): bigint {
  const leaves = [
    ...results.map(transactionResultLeaf),
    ...payouts.map(payoutResultLeaf),
  ];
  return poseidon([
    TRANSACTION_RESULTS_ROOT_DOMAIN,
    BigInt(results.length),
    BigInt(payouts.length),
    new DenseMerkleTree(TRANSACTION_RESULTS_TREE_DEPTH, leaves).root(),
  ]);
}

export function contentHash(txBytes: Uint8Array): Uint8Array {
  return keccak256(txBytes);
}

/** Exact transaction bytes as the hex the node admits, and their preinclusion content hash. */
export function transactionIdentity(transaction: Uint8Array): { contentHash: Hex; transactionHex: Hex } {
  return { contentHash: toHex(contentHash(transaction)), transactionHex: toHex(transaction) };
}

/** The ID of one exact canonical inclusion, as its canonical 32-byte field word. */
export function transactionId(input: {
  l1BlockHash: Uint8Array;
  l1TransactionIndex: bigint;
  batchItemIndex: bigint;
}): Uint8Array {
  const blockHash = splitHash256(input.l1BlockHash, "transaction ID L1 block hash");
  return beBytes(poseidon([
    TRANSACTION_ID_DOMAIN,
    blockHash.high128,
    blockHash.low128,
    uintBelow(input.l1TransactionIndex, U64_LIMIT, "l1TransactionIndex"),
    uintBelow(input.batchItemIndex, U64_LIMIT, "batchItemIndex"),
  ]), 32);
}

/** Fixed depth-4 tree used only for typed state and block-header commitments. */
export class TypedCommitmentTree {
  readonly depth = 4;
  private readonly domain: bigint;
  private readonly leaves = Array<bigint>(1 << this.depth).fill(0n);

  constructor(domain: FieldNumberish) {
    this.domain = toField(domain, "commitment tree domain");
  }

  setLeaf(index: FieldNumberish, value: FieldNumberish): void {
    const key = toField(index, "commitment tree key");
    if (key >= 1n << BigInt(this.depth)) throw new Error("commitment tree key is out of range");
    this.leaves[Number(key)] = toField(value, "commitment tree leaf");
  }

  leaf(index: number): bigint {
    if (!Number.isInteger(index) || index < 0 || index >= this.leaves.length) {
      throw new Error("commitment tree key is out of range");
    }
    return this.leaves[index]!;
  }

  private levels(): bigint[][] {
    const levels = [this.leaves.slice()];
    for (let height = 0; height < this.depth; height++) {
      const previous = levels[height]!;
      const next: bigint[] = [];
      for (let index = 0; index < previous.length; index += 2) {
        next.push(poseidon([this.domain, previous[index]!, previous[index + 1]!]));
      }
      levels.push(next);
    }
    return levels;
  }

  get root(): bigint {
    return this.levels()[this.depth]![0]!;
  }

  proof(index: FieldNumberish): MembershipProof {
    const key = toField(index, "commitment tree key");
    if (key >= 1n << BigInt(this.depth)) throw new Error("commitment tree key is out of range");
    const levels = this.levels();
    const siblings: bigint[] = [];
    let cursor = Number(key);
    for (let height = 0; height < this.depth; height++) {
      siblings.push(levels[height]![cursor ^ 1]!);
      cursor >>= 1;
    }
    return { leafIndex: Number(key), siblings, root: levels[this.depth]![0]! };
  }
}

export function stateTree(state: StateCommitment): TypedCommitmentTree {
  if (state.lagQ < -(1n << 255n) || state.lagQ >= 1n << 255n) throw new Error("lagQ must fit in i256");
  const encodedLag = state.lagQ < 0n ? (1n << 256n) + state.lagQ : state.lagQ;
  const lag = {
    high128: encodedLag >> 128n,
    low128: encodedLag & ((1n << 128n) - 1n),
  };
  const tree = new TypedCommitmentTree(STATE_COMMITMENT_DOMAIN);
  tree.setLeaf(STATE_KEY_OUTPUT_ROOT, toField(state.outputRoot, "outputRoot"));
  tree.setLeaf(STATE_KEY_OUTPUT_COUNT, treeCount(state.outputCount, "outputCount"));
  tree.setLeaf(STATE_KEY_ISSUED_SO_FAR, uintBelow(state.issuedSoFar, 1n << 192n, "issuedSoFar"));
  tree.setLeaf(STATE_KEY_LAG_HIGH128, lag.high128);
  tree.setLeaf(STATE_KEY_LAG_LOW128, lag.low128);
  tree.setLeaf(STATE_KEY_ACCOUNT_STATE_ROOT, toField(state.accountStateRoot, "accountStateRoot"));
  tree.setLeaf(STATE_KEY_ACCOUNT_COUNT, treeCount(state.accountCount, "accountCount"));
  tree.setLeaf(STATE_KEY_NULLIFIER_ROOT, toField(state.nullifierRoot, "nullifierRoot"));
  tree.setLeaf(STATE_KEY_NULLIFIER_COUNT, treeCount(state.nullifierCount, "nullifierCount"));
  return tree;
}

export function stateRoot(state: StateCommitment): bigint {
  return stateTree(state).root;
}

export function openStateKey(state: StateCommitment, key: number): MembershipProof & { value: bigint } {
  if (!Number.isInteger(key) || key < 0 || key >= 1 << STATE_TREE_DEPTH) {
    throw new Error("state key is out of range");
  }
  const tree = stateTree(state);
  return { ...tree.proof(key), value: tree.leaf(key) };
}

export function verifyStatePath(
  root: FieldNumberish,
  key: number,
  value: FieldNumberish,
  siblings: readonly FieldNumberish[],
): boolean {
  if (!Number.isInteger(key) || key < 0 || key >= 1 << STATE_TREE_DEPTH || siblings.length !== STATE_TREE_DEPTH) {
    return false;
  }
  return domainSeparatedRootFromIndex(STATE_COMMITMENT_DOMAIN, value, BigInt(key), siblings)
    === toField(root, "stateRoot");
}

export function blockHeaderTree(header: BlockHeaderCommitment): TypedCommitmentTree {
  const tree = new TypedCommitmentTree(BLOCK_HEADER_DOMAIN);
  tree.setLeaf(BLOCK_HEADER_KEY_PARENT_HASH, toField(header.parentHash, "parentHash"));
  tree.setLeaf(BLOCK_HEADER_KEY_NUMBER, uintBelow(header.number, U64_LIMIT, "number"));
  tree.setLeaf(BLOCK_HEADER_KEY_TIMESTAMP, uintBelow(header.timestamp, U64_LIMIT, "timestamp"));
  tree.setLeaf(
    BLOCK_HEADER_KEY_TRANSACTION_RESULTS_ROOT,
    toField(header.transactionResultsRoot, "transactionResultsRoot"),
  );
  tree.setLeaf(BLOCK_HEADER_KEY_STATE_ROOT, toField(header.stateRoot, "stateRoot"));
  tree.setLeaf(
    BLOCK_HEADER_KEY_L1_ORIGIN_ROOT,
    toField(header.l1OriginRoot, "l1OriginRoot"),
  );
  tree.setLeaf(BLOCK_HEADER_KEY_HISTORY_ROOT, toField(header.historyRoot, "historyRoot"));
  return tree;
}

export function blockHash(header: BlockHeaderCommitment): bigint {
  return blockHeaderTree(header).root;
}

export function openBlockHeaderKey(header: BlockHeaderCommitment, key: number): MembershipProof & { value: bigint } {
  if (!Number.isInteger(key) || key < 0 || key >= 1 << BLOCK_HEADER_TREE_DEPTH) {
    throw new Error("block-header key is out of range");
  }
  const tree = blockHeaderTree(header);
  return { ...tree.proof(key), value: tree.leaf(key) };
}

export function verifyBlockHeaderPath(
  hash: FieldNumberish,
  key: number,
  value: FieldNumberish,
  siblings: readonly FieldNumberish[],
): boolean {
  if (!Number.isInteger(key) || key < 0 || key >= 1 << BLOCK_HEADER_TREE_DEPTH || siblings.length !== BLOCK_HEADER_TREE_DEPTH) {
    return false;
  }
  return domainSeparatedRootFromIndex(BLOCK_HEADER_DOMAIN, value, BigInt(key), siblings)
    === toField(hash, "blockHash");
}

/** Block 0's `parentHash`: the commitment to the PCASH chain ID, L1 chain ID, and inbox address. */
export function genesisParentHash(network: NetworkConfigLike): bigint {
  const { pcashChainId, l1ChainId, inboxAddress } = resolveNetworkConfig(network);
  return poseidon([GENESIS_PARENT_DOMAIN, pcashChainId, l1ChainId, inboxAddress]);
}

export function verifyL1OriginPath(
  path: { leafIndex: FieldNumberish; root: FieldNumberish; siblings: readonly FieldNumberish[] },
  block: {
    blockNumber: bigint | number;
    blockHash: Uint8Array;
    timestamp: bigint | number;
    logsRoot: FieldNumberish;
    logCount: bigint | number;
  },
): boolean {
  if (path.siblings.length !== L1_ORIGIN_TREE_DEPTH) return false;
  const index = uintBelow(path.leafIndex, U40_LIMIT, "L1 origin index");
  return rootFromIndex(l1OriginLeaf(block), index, path.siblings) === toField(path.root, "root");
}

/** The history tree leaf at the block's number. */
export function historyLeaf(blockHash: FieldNumberish): bigint {
  return poseidon([HISTORY_LEAF_DOMAIN, toField(blockHash, "PCASH block hash")]);
}

export function verifyHistoryPath(
  root: FieldNumberish,
  blockNumber: FieldNumberish,
  hash: FieldNumberish,
  siblings: readonly FieldNumberish[],
): boolean {
  if (siblings.length !== HISTORY_TREE_DEPTH) return false;
  const index = uintBelow(blockNumber, U40_LIMIT, "PCASH block number");
  return rootFromIndex(historyLeaf(hash), index, siblings) === toField(root, "historyRoot");
}
