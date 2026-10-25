import { readFile } from "node:fs/promises";
import type { Readable } from "node:stream";
import type { ItemExclusionReason, PcashNodeClient } from "@pcash/sdk/clients";
import type { PrivateKeyRelaySubmitter } from "@pcash/sdk/node";
import {
  decodeTransactionForChain,
  transactionIdentity,
  encodeBatchForVersion,
  posterPayoutOpening,
  selectBatchVersion,
  type TransactionOutcome,
} from "@pcash/sdk/protocol";
import type { RelayDaMode, RelaySubmissionResult } from "@pcash/sdk/relay";
import { fromHex, randomFieldEntropy, toHex } from "@pcash/sdk/utils";

const MAX_RAW_BATCH_TRANSACTIONS = 64;

export class RawBatchInputError extends Error {
  override readonly name = "RawBatchInputError";
}

/** Parse the operational submit-batch format: one ordered JSON array of raw PCASH transactions. */
export function parseRawTransactionBatch(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("raw transaction batch must be a nonempty JSON array");
  }
  if (value.length > MAX_RAW_BATCH_TRANSACTIONS) {
    throw new Error(`raw transaction batch accepts at most ${MAX_RAW_BATCH_TRANSACTIONS} transactions`);
  }
  return value.map((candidate, index) => {
    if (typeof candidate !== "string" || !/^0x(?:[0-9a-fA-F]{2})+$/.test(candidate)) {
      throw new Error(`raw transaction ${index} must be nonempty 0x-prefixed byte hex`);
    }
    return candidate.toLowerCase();
  });
}

async function readStream(stream: Readable): Promise<string> {
  stream.setEncoding("utf8");
  let contents = "";
  for await (const chunk of stream) contents += String(chunk);
  return contents;
}

export async function readRawTransactionBatch(
  path: string,
  stdin: Readable = process.stdin,
): Promise<string[]> {
  try {
    const contents = path === "-" ? await readStream(stdin) : await readFile(path, "utf8");
    return parseRawTransactionBatch(JSON.parse(contents));
  } catch (error) {
    const source = path === "-" ? "stdin" : path;
    throw new Error(`could not read raw transaction batch from ${source}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export interface RawBatchItemResult {
  index: number;
  contentHash: string;
  transactionId: string | null;
  outcome: TransactionOutcome | null;
  exclusionReason: ItemExclusionReason | null;
}

export interface RawBatchResult {
  transactionHash: string;
  items: RawBatchItemResult[];
  receipt: RelaySubmissionResult["receipt"];
}

/** Submit locally produced transaction bytes directly to L1 without mempool admission or gossip. */
export async function submitRawTransactionBatch(params: {
  transactions: readonly string[];
  payoutRecipient: (status: Awaited<ReturnType<PcashNodeClient["status"]>>) => { address: bigint; nkRoot: bigint };
  node: PcashNodeClient;
  submitter: PrivateKeyRelaySubmitter;
  daMode: RelayDaMode;
  maxBatchBytes: bigint;
  maxTransactions: number;
}): Promise<RawBatchResult> {
  if (params.transactions.length > params.maxTransactions) {
    throw new RawBatchInputError(`raw transaction batch has ${params.transactions.length} transactions, exceeding --max-transactions ${params.maxTransactions}`);
  }
  const status = await params.node.status();
  const rawTransactions = params.transactions.map((transaction, index) => {
    const raw = fromHex(transaction, `raw transaction ${index}`);
    try {
      decodeTransactionForChain(raw, status.pcashChainId);
    } catch (error) {
      throw new RawBatchInputError(`raw transaction ${index} failed local structural validation: ${error instanceof Error ? error.message : String(error)}`);
    }
    return raw;
  });
  const contentHashes = rawTransactions.map((transaction) => transactionIdentity(transaction).contentHash);
  const batchItemIndexes = rawTransactions.map((_transaction, index) => index);
  const recipient = params.payoutRecipient(status);
  const poster = posterPayoutOpening(recipient.address, recipient.nkRoot, randomFieldEntropy());
  const batch = encodeBatchForVersion(rawTransactions, selectBatchVersion(status), poster.ownerCommitment, poster.context);
  if (BigInt(batch.length) > params.maxBatchBytes) {
    throw new RawBatchInputError(`raw transaction batch is ${batch.length} bytes, exceeding --max-batch-bytes ${params.maxBatchBytes}`);
  }

  await params.submitter.assertAvailable();
  const batchHex = toHex(batch);
  const quotes = await params.submitter.quote(status, batchHex, params.daMode);
  const broadcast = await params.submitter.send(status, batchHex, quotes.selected, {
    selected: contentHashes,
    batchItemIndexes,
    observationMode: "batch",
    collectibleOpenFee: 0n,
    headCheckedBlock: status.latestBlock,
    headCheckedBlockHash: status.latestBlockHash,
  });
  const submission = await broadcast.settle();
  const delivery = submission.delivery;
  if (
    delivery === undefined
    || delivery.items.length !== rawTransactions.length
  ) {
    throw new Error("raw transaction batch delivery diagnostics are missing or inconsistent");
  }

  const observedByIndex = new Map(
    (submission.outcomes ?? []).map((outcome) => [Number(outcome.batchItemIndex), outcome]),
  );
  const items = delivery.items.map((item, index): RawBatchItemResult => {
    if (
      item.batchItemIndex !== BigInt(index)
    ) {
      throw new Error(`raw transaction ${index} returned different delivery coordinates`);
    }
    const observed = observedByIndex.get(index);
    if (item.exclusionReason !== null) {
      return {
        index,
        contentHash: contentHashes[index]!,
        transactionId: null,
        outcome: null,
        exclusionReason: item.exclusionReason,
      };
    }
    if (observed === undefined) {
      throw new Error(`raw transaction ${index} is missing its canonical outcome`);
    }
    return {
      index,
      contentHash: contentHashes[index]!,
      transactionId: observed.transactionId,
      outcome: observed.outcome,
      exclusionReason: null,
    };
  });
  return { transactionHash: submission.txHash, items, receipt: submission.receipt };
}

export function rawBatchExitCode(result: RawBatchResult): 0 | 3 {
  return result.items.every((item) => item.exclusionReason === null && item.outcome === "succeeded")
    ? 0
    : 3;
}
