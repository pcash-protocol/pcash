import { randomBytes } from "@noble/hashes/utils.js";
import type { FieldNumberish } from "../crypto/field.ts";
import { sameL1Identity, samePcashIdentity, statusPcashIdentity, type StatusResult } from "../clients/index.ts";
import type { PcashNodeClient } from "../clients/nodeClient.ts";
import { decodeTransactionForChain, transactionPublication, TX_KIND_PRIVATE_VALUE, TX_KIND_CONTRACT_ACCOUNT_CREATION, encodeBatchForVersion, transactionIdentity, selectBatchVersion, assertTransactionTypeAccepted, transactionTypeOf } from "../protocol/index.ts";
import { keccak256, toHex } from "../utils/index.ts";
import { RelayJournalConflictError, RelayPreBroadcastError } from "./errors.ts";
import { preferredRelayDaMode } from "./relayer.ts";
import type { RelayCarrierQuote, RelayDaMode, RelaySubmitter, RelaySubmissionResult } from "./relayer.ts";

/** Mempool transactions selected for a Fast send, with third-party fee income. */
export interface L1BatchCompanions {
  transactions: readonly Uint8Array[];
  collectibleOpenFee: bigint;
  /** Public open fees aligned with companion transaction bytes. */
  collectibleOpenFees: readonly bigint[];
}

export interface PreparedL1Transaction {
  contentHash: string;
  transactionHex: string;
  selected: string[];
  orderedTransactions: string[];
  actionBatchIndex: number;
  collectibleOpenFee: bigint;
  status: StatusResult;
  batch: string;
  quote: RelayCarrierQuote;
}

/** Finalize exact transactions and network, dropping companions if quoting fails or gas is unaffordable. */
export async function prepareTransactionForL1(
  transaction: Uint8Array,
  status: StatusResult,
  submitter: RelaySubmitter,
  posterOwnerCommitment: FieldNumberish,
  posterContext: FieldNumberish,
  daMode: RelayDaMode = "auto",
  following: { required?: readonly Uint8Array[]; optional?: readonly Uint8Array[]; collectibleOpenFee?: bigint; companions?: L1BatchCompanions; randomIndex?: (upperExclusive: number) => number } = {},
): Promise<PreparedL1Transaction> {
  try {
    const required = [transaction, ...(following.required ?? [])];
    const validateTransaction = (item: Uint8Array) => {
      decodeTransactionForChain(item, status.pcashChainId);
      assertTransactionTypeAccepted(status, transactionTypeOf(item));
    };
    required.forEach(validateTransaction);
    // Optional bytes and companions come from the node. Only private-value transactions are
    // taken: a direct user-account creation registers at the batch's L1 sender, this submitter.
    // One invalid item must not block the prefix.
    const takesNodeItem = (item: Uint8Array) => {
      try {
        validateTransaction(item);
        return transactionTypeOf(item) === TX_KIND_PRIVATE_VALUE;
      } catch {
        return false;
      }
    };
    let transactions = [...required, ...(following.optional ?? []).filter(takesNodeItem)];
    let collectibleOpenFee = following.collectibleOpenFee ?? 0n;
    const independentAction = required.every(item => transactionTypeOf(item) === TX_KIND_PRIVATE_VALUE)
      || (required.length === 1 && transactionTypeOf(transaction) === TX_KIND_CONTRACT_ACCOUNT_CREATION);
    if (following.companions !== undefined && independentAction) {
      const independent = independentCompanions(required, following.companions.transactions, status);
      transactions = shuffleEntries([...required, ...independent.map(index => following.companions!.transactions[index]!)], following.randomIndex);
      collectibleOpenFee = independent.reduce((sum, index) => sum + following.companions!.collectibleOpenFees[index]!, 0n);
    }
    if (following.companions !== undefined && !independentAction) {
      // Explicit setup dependencies retain their ordering; companions are still optional.
      const kept = following.companions.transactions.flatMap((item, index) => takesNodeItem(item) ? [index] : []);
      transactions = [...required, ...kept.map(index => following.companions!.transactions[index]!)];
      collectibleOpenFee = kept.reduce((sum, index) => sum + following.companions!.collectibleOpenFees[index]!, 0n);
    }
    const quoteTransactions = async (items: readonly Uint8Array[]) => {
      const batch = toHex(encodeBatchForVersion(items, selectBatchVersion(status), posterOwnerCommitment, posterContext));
      const { selected: quote } = await submitter.quote(status, batch, preferredRelayDaMode(items, daMode, submitter.supportedCarriers));
      return { batch, quote };
    };
    await submitter.assertAvailable();
    let prepared;
    try {
      prepared = await quoteTransactions(transactions);
    } catch (cause) {
      if (transactions.length === required.length) throw cause;
      transactions = required;
      collectibleOpenFee = 0n;
      prepared = await quoteTransactions(transactions);
    }
    if (prepared.quote.balanceWei < prepared.quote.maximumCostWei && transactions.length > required.length) {
      transactions = required;
      collectibleOpenFee = 0n;
      prepared = await quoteTransactions(transactions);
    }
    if (prepared.quote.balanceWei < prepared.quote.maximumCostWei) {
      throw new Error(`not enough ETH for direct submission gas. Fund Ethereum address ${submitter.address} on L1 chain ${status.l1ChainId}: direct submission requires ${prepared.quote.maximumCostWei} wei for gas; available ${prepared.quote.balanceWei} wei`);
    }
    return { ...transactionIdentity(transaction), selected: transactions.map((value) => transactionIdentity(value).contentHash), orderedTransactions: transactions.map(toHex), actionBatchIndex: transactions.indexOf(transaction), collectibleOpenFee, status, ...prepared };
  } catch (cause) {
    if (cause instanceof RelayJournalConflictError) throw cause;
    throw new RelayPreBroadcastError(cause);
  }
}

/** Node responses are external input: never adopt a new deployment after preparation. */
export async function submitPreparedTransactionToL1(
  node: PcashNodeClient,
  prepared: PreparedL1Transaction,
  submitter: RelaySubmitter,
): Promise<RelaySubmissionResult> {
  try {
    const current = await node.status();
    if (
      !samePcashIdentity(statusPcashIdentity(prepared.status), statusPcashIdentity(current))
      || !sameL1Identity(prepared.status, current)
    ) {
      throw new Error("node identity changed after direct submission preparation");
    }
    if (selectBatchVersion(prepared.status) !== selectBatchVersion(current)) {
      throw new Error("node batch version changed after direct submission preparation");
    }
  } catch (cause) {
    if (cause instanceof RelayJournalConflictError) throw cause;
    throw new RelayPreBroadcastError(cause);
  }
  const { status, batch, quote, selected } = prepared;
  const broadcast = await submitter.send(status, batch, quote, {
    source: "direct", selected, batchItemIndexes: selected.map((_, index) => index), observationMode: "batch",
    collectibleOpenFee: prepared.collectibleOpenFee, headCheckedBlock: status.latestBlock, headCheckedBlockHash: status.latestBlockHash,
  });
  return broadcast.settle();
}

/** Post exact bytes using the submitter's durable L1 journal, without a mempool round trip. */
export async function submitTransactionToL1(node: PcashNodeClient, transaction: Uint8Array, submitter: RelaySubmitter, posterOwnerCommitment: FieldNumberish, posterContext: FieldNumberish, daMode: RelayDaMode = "auto"): Promise<RelaySubmissionResult> {
  return submitPreparedTransactionToL1(node, await prepareTransactionForL1(transaction, await node.status(), submitter, posterOwnerCommitment, posterContext, daMode), submitter);
}

/** Unbiased bounded sampling from the platform CSPRNG. */
function secureIndex(upperExclusive: number): number {
  const limit = 0x1_0000_0000 - (0x1_0000_0000 % upperExclusive);
  let value: number;
  do { value = new DataView(randomBytes(4).buffer).getUint32(0); } while (value >= limit);
  return value % upperExclusive;
}

export function shuffleEntries<T>(entries: readonly T[], randomIndex = secureIndex): T[] {
  const result = [...entries];
  for (let index = result.length - 1; index > 0; index--) {
    const other = randomIndex(index + 1);
    [result[index], result[other]] = [result[other]!, result[index]!];
  }
  return result;
}

/**
 * Ready private-value transactions only append outputs and spend nullifiers.
 * Their proofs reference existing roots; they cannot require another selected
 * transaction's outputs. Output bodies can repeat because their tree positions distinguish
 * them. A required contract creation creates a new account that these current-head
 * private-value companions cannot depend on. Other account transitions stay ordered.
 */
function independentCompanions(required: readonly Uint8Array[], companions: readonly Uint8Array[], status: StatusResult): number[] {
  const hashes = new Set<string>();
  const nullifiers = new Set<bigint>();
  const add = (bytes: Uint8Array): boolean => {
    const decoded = decodeTransactionForChain(bytes, status.pcashChainId);
    if (decoded.kind !== TX_KIND_PRIVATE_VALUE) return false;
    assertTransactionTypeAccepted(status, decoded.kind);
    const hash = toHex(keccak256(bytes));
    const inputs = transactionPublication(decoded)!.nullifiers;
    if (hashes.has(hash) || inputs.some(value => nullifiers.has(value))) return false;
    hashes.add(hash);
    inputs.forEach(value => nullifiers.add(value));
    return true;
  };
  for (const entry of required) {
    const decoded = decodeTransactionForChain(entry, status.pcashChainId);
    hashes.add(toHex(keccak256(entry)));
    transactionPublication(decoded)?.nullifiers.forEach(value => nullifiers.add(value));
  }
  return companions.flatMap((bytes, index) => {
    try { return add(bytes) ? [index] : []; } catch { return []; }
  });
}
