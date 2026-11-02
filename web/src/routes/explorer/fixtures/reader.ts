// The explorer reader over the fixture world. Pure and synchronous underneath,
// async at the surface so every page takes the same code path it takes against
// a node. Pagination is keyset over the same order the node serves: newest
// first, ties broken by the dense transaction ordinal.

import type {
  AccountHistoryQuery,
  BlockPayoutsResult,
  BlockIdResult,
  BlockResult,
  ContractPageResult,
  ContractQuery,
  ContractSummaryResult,
  ExplorerCursor,
  MempoolItemResult,
  MempoolPageResult,
  MempoolQuery,
  ReceiptResult,
  TransactionPageResult,
  TransactionQuery,
  TransactionResult,
} from "@pcash/sdk/clients";
import type { ExplorerReader } from "../ExplorerProvider.tsx";
import { fixtureBlockEconomics } from "./economics.ts";
import { fixtureWorld, type FixtureTransaction } from "./world.ts";

const world = fixtureWorld;

function head(): BlockIdResult {
  return { blockNumber: world.status.latestBlock, blockHash: world.status.latestBlockHash };
}

function limitOf(value: bigint | number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const requested = Number(value);
  if (!Number.isFinite(requested) || requested <= 0) return fallback;
  return Math.min(requested, 500);
}

/** Newest first: descending block, then descending ordinal within the block. */
function descending(
  left: { blockNumber: bigint; pcashTransactionIndex: bigint },
  right: { blockNumber: bigint; pcashTransactionIndex: bigint },
): number {
  if (left.blockNumber !== right.blockNumber) return left.blockNumber > right.blockNumber ? -1 : 1;
  if (left.pcashTransactionIndex !== right.pcashTransactionIndex) return left.pcashTransactionIndex > right.pcashTransactionIndex ? -1 : 1;
  return 0;
}

function afterCursor(
  entry: { blockNumber: bigint; pcashTransactionIndex: bigint },
  cursor: ExplorerCursor,
): boolean {
  if (entry.blockNumber !== cursor.blockNumber) return entry.blockNumber < cursor.blockNumber;
  return entry.pcashTransactionIndex < cursor.pcashTransactionIndex;
}

const transactionKey = (entry: FixtureTransaction) => ({
  blockNumber: entry.summary.block.blockNumber,
  pcashTransactionIndex: entry.summary.pcashTransactionIndex,
});

const contractKey = (entry: ContractSummaryResult) => ({
  blockNumber: entry.block.blockNumber,
  pcashTransactionIndex: entry.pcashTransactionIndex,
});

const transactionsNewestFirst = [...world.transactions]
  .sort((left, right) => descending(transactionKey(left), transactionKey(right)));

const contractsNewestFirst = [...world.contracts]
  .sort((left, right) => descending(contractKey(left), contractKey(right)));

function transactionPage(query: TransactionQuery | undefined): TransactionPageResult {
  const limit = limitOf(query?.limit, 25);
  let matching = transactionsNewestFirst;
  if (query?.kind !== undefined) matching = matching.filter((entry) => entry.summary.kind === query.kind);
  if (query?.blockNumber !== undefined) {
    const block = BigInt(query.blockNumber);
    matching = matching.filter((entry) => entry.summary.block.blockNumber === block);
  }
  const cursor = query?.cursor;
  if (cursor !== undefined) matching = matching.filter((entry) => afterCursor(transactionKey(entry), cursor));
  const page = matching.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page.map((entry) => entry.summary),
    nextCursor: last === undefined || matching.length <= limit
      ? null
      : { head: head(), ...transactionKey(last) },
    head: head(),
  };
}

function contractPage(query: ContractQuery | undefined): ContractPageResult {
  const limit = limitOf(query?.limit, 25);
  let matching = contractsNewestFirst;
  if (query?.verifiedOnly === true) matching = matching.filter((entry) => entry.sourceVerification === "verified");
  const cursor = query?.cursor;
  if (cursor !== undefined) matching = matching.filter((entry) => afterCursor(contractKey(entry), cursor));
  const page = matching.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page,
    nextCursor: last === undefined || matching.length <= limit ? null : { head: head(), ...contractKey(last) },
    head: head(),
  };
}

/** Fee per byte, scaled so the ordering is integral. */
function feeDensity(item: MempoolItemResult): bigint {
  return item.byteSize === 0n ? 0n : (item.openFeeAmount * 1_000_000n) / item.byteSize;
}

function mempoolKey(item: MempoolItemResult, sort: MempoolQuery["sort"]): bigint {
  return sort === "feeDensity" ? feeDensity(item) : item.receivedAtUnixMs;
}

function mempoolPage(query: MempoolQuery | undefined): MempoolPageResult {
  const sort = query?.sort ?? "receivedAt";
  const limit = limitOf(query?.limit, 50);
  let matching = [...world.mempool]
    .sort((left, right) => {
      const leftKey = mempoolKey(left, sort);
      const rightKey = mempoolKey(right, sort);
      if (leftKey !== rightKey) return leftKey > rightKey ? -1 : 1;
      return left.contentHash.localeCompare(right.contentHash);
    });
  if (query?.kind !== undefined) matching = matching.filter((item) => item.kind === query.kind);
  if (query?.status !== undefined) matching = matching.filter((item) => item.status === query.status);
  if (query?.minOpenFee !== undefined) {
    const minimum = BigInt(query.minOpenFee);
    matching = matching.filter((item) => item.openFeeAmount >= minimum);
  }
  const commitments = query?.controlledIssuanceOwnerCommitments?.map((value) => value.toLowerCase());
  if (commitments !== undefined) {
    matching = matching.filter((item) => item.issuanceRoute === "open"
      || (item.issuanceRoute === "designated" && commitments.includes(item.issuanceOwnerCommitment.toLowerCase())));
  }
  const cursor = query?.cursor;
  if (cursor !== undefined) {
    const separator = cursor.indexOf(":");
    if (separator === -1 || !/^[0-9]+$/.test(cursor.slice(0, separator))) {
      throw new Error("explorer mempool cursor is malformed");
    }
    const key = BigInt(cursor.slice(0, separator));
    const contentHash = cursor.slice(separator + 1);
    matching = matching.filter((item) => {
      const itemKey = mempoolKey(item, sort);
      return itemKey < key || (itemKey === key && item.contentHash > contentHash);
    });
  }
  const page = matching.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page,
    nextCursor: last === undefined || matching.length <= limit
      ? null
      : `${mempoolKey(last, sort)}:${last.contentHash}`,
    headCheckedBlock: world.status.latestBlock,
    headCheckedBlockHash: world.status.latestBlockHash,
    peerCount: 7n,
  };
}

/** Every inclusion of one exact transaction body, newest first. */
function submissionPage(contentHash: string, cursor?: ExplorerCursor): TransactionPageResult {
  const key = contentHash.toLowerCase();
  const matching = world.transactions
    .filter((entry) => entry.summary.contentHash.toLowerCase() === key)
    .map((entry) => entry.summary)
    .sort((left, right) => {
      if (left.block.blockNumber !== right.block.blockNumber) {
        return left.block.blockNumber > right.block.blockNumber ? -1 : 1;
      }
      return left.pcashTransactionIndex > right.pcashTransactionIndex ? -1 : 1;
    });
  const remaining = cursor === undefined ? matching : matching.filter((summary) => afterCursor({ blockNumber: summary.block.blockNumber, pcashTransactionIndex: summary.pcashTransactionIndex }, cursor));
  const items = remaining.slice(0, 25);
  const last = items.at(-1);
  return { items, nextCursor: remaining.length <= 25 || last === undefined ? null : { head: head(), blockNumber: last.block.blockNumber, pcashTransactionIndex: last.pcashTransactionIndex }, head: head() };
}



function blocksInRange(from: bigint, to: bigint): BlockResult[] {
  return world.blocks.filter((block) => block.number >= from && block.number <= to);
}

function blockBlockPayoutsOf(block: BlockIdResult): BlockPayoutsResult | null {
  const entry = world.blockPayouts.get(block.blockHash.toLowerCase());
  return entry !== undefined && entry.block.blockNumber === block.blockNumber ? entry : null;
}

function canonical(transactionId: string): TransactionResult | null {
  const entry = world.transactionsById.get(transactionId.toLowerCase());
  if (entry === undefined) return null;
  return { summary: entry.summary, rawTransaction: entry.rawTransaction };
}

function receiptsOf(transactionId: string): ReceiptResult[] {
  return world.transactionsById.get(transactionId.toLowerCase())?.receipts ?? [];
}

function accountHistoryPage(query: AccountHistoryQuery): TransactionPageResult {
  const limit = limitOf(query.limit, 25);
  let matching = world.accounts.get(query.address.toLowerCase())?.history ?? [];
  const cursor = query.cursor;
  if (cursor !== undefined) {
    matching = matching.filter((entry) => afterCursor({ blockNumber: entry.block.blockNumber, pcashTransactionIndex: entry.pcashTransactionIndex }, cursor));
  }
  const page = matching.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page,
    nextCursor: last === undefined || matching.length <= limit
      ? null
      : { head: head(), blockNumber: last.block.blockNumber, pcashTransactionIndex: last.pcashTransactionIndex },
    head: head(),
  };
}

export function createFixtureReader(): ExplorerReader {
  return {
    dashboard: async (from, to) => [
      blocksInRange(from, to),
      transactionPage({ limit: 10 }),
    ],
    blocks: async (from, to) => blocksInRange(from, to),
    block: async (number) => world.blocks.find((block) => block.number === number) ?? null,
    blockSnapshot: async (number) => {
      const block = world.blocks.find((entry) => entry.number === number) ?? null;
      return {
        block,
        status: world.status,
        blockPayouts: block === null ? null : blockBlockPayoutsOf({ blockNumber: block.number, blockHash: block.hash }),
      };
    },
    blockByHash: async (blockHash) => world.blocksByHash.get(blockHash.toLowerCase()) ?? null,
    transactions: async (query) => transactionPage(query),
    transaction: async (transactionId) => canonical(transactionId),
    l1DeliveryBatches: async (l1TransactionHash) =>
      [...world.batchesByHash.get(l1TransactionHash.toLowerCase()) ?? []],
    blockBlockPayouts: async (block) => blockBlockPayoutsOf(block),
    issuanceQuote: async () => world.issuance,
    blockEconomics: async (query = {}) => fixtureBlockEconomics(world, query),
    payouts: async (query = {}) => {
      const anchor = query.cursor?.anchor ?? head();
      const counters = new Map<bigint, bigint>();
      const positioned = world.payouts.map((record) => { const index = counters.get(record.blockNumber) ?? 0n; counters.set(record.blockNumber, index + 1n); return { record, index }; });
      const remaining = positioned.filter(({ record, index }) => record.blockNumber <= anchor.blockNumber && record.blockNumber >= (query.cursor?.nextBlock ?? query.fromBlock ?? 0n) && (record.blockNumber !== query.cursor?.nextBlock || index >= query.cursor.nextPayoutIndex));
      const page = remaining.slice(0, query.limit ?? 100);
      const last = page.at(-1);
      return { atBlockNumber: anchor.blockNumber, atBlockHash: anchor.blockHash, records: page.map(({ record }) => record), nextCursor: last === undefined || page.length === remaining.length ? null : { anchor, nextBlock: last.record.blockNumber, nextPayoutIndex: last.index + 1n } };
    },
    submission: async (contentHash, cursor) => submissionPage(contentHash, cursor),
    mempoolTransaction: async (contentHash) =>
      world.mempool.find((item) => item.contentHash.toLowerCase() === contentHash.toLowerCase()) ?? null,
    contracts: async (query) => contractPage(query),
    mempool: async (query) => mempoolPage(query),
    receipt: async (transactionId) => receiptsOf(transactionId),
    accountSnapshot: async (address) => {
      const account = world.accounts.get(address.toLowerCase())?.account ?? null;
      return account === null ? { account, headHash: undefined } : { account, headHash: world.status.latestBlockHash };
    },
    accountHistory: async (query) => accountHistoryPage(query),
    sourceInfo: async () => ({ info: world.sourceInfo, status: world.status }),
    contractSource: async (address) => world.contractSources.get(address.toLowerCase()) ?? null,
    implementationSource: async (applicationVkHash) =>
      world.implementations.get(applicationVkHash.toLowerCase()) ?? null,
    sourceFile: async (applicationVkHash, path) =>
      world.implementationFiles.get(applicationVkHash.toLowerCase())?.find((file) => file.path === path) ?? null,
    contractBundle: async (address) => world.contractBundles.get(address.toLowerCase()) ?? null,
  };
}
