// The explorer fixture world is a recording of a seeded local chain.
// The reader pages and filters the recorded node and Pscan responses.

import type {
  AccountResult,
  IssuanceQuoteResult, PayoutRecordResult,
  BlockPayoutsResult,
  BlockResult,
  ContractSourceBundle,
  ContractSourceView,
  ContractSummaryResult,
  ImplementationSourceFile,
  ImplementationSourceView,
  L1DeliveryBatchResult,
  MempoolItemResult,
  ReceiptResult,
  SourceVerificationInfo,
  StatusResult,
  TransactionSummaryResult,
} from "@pcash/sdk/clients";
import type { TransactionOutcome } from "@pcash/sdk/protocol";
import { FIXTURE_CHAIN_ID } from "./constants.ts";
import issuanceRaw from "./recorded/issuance.json?raw";
import payoutsRaw from "./recorded/payouts.json?raw";
import accountsRaw from "./recorded/accounts.json?raw";
import batchesRaw from "./recorded/batches.json?raw";
import blocksRaw from "./recorded/blocks.json?raw";
import contractsRaw from "./recorded/contracts.json?raw";
import idsRaw from "./recorded/ids.json?raw";
import blockPayoutsRaw from "./recorded/blockPayouts.json?raw";
import mempoolRaw from "./recorded/mempool.json?raw";
import sourcesRaw from "./recorded/sources.json?raw";
import statusRaw from "./recorded/status.json?raw";
import transactionsRaw from "./recorded/transactions.json?raw";

export { FIXTURE_CHAIN_ID };

export interface FixtureTransaction {
  summary: TransactionSummaryResult;
  rawTransaction: string;
  receipts: ReceiptResult[];
}

export interface FixtureAccount {
  address: string;
  account: AccountResult | null;
  history: TransactionSummaryResult[];
}

interface RecordedSources {
  info: SourceVerificationInfo;
  contracts: Array<[string, ContractSourceView]>;
  bundles: Array<[string, ContractSourceBundle]>;
  implementations: Array<[string, ImplementationSourceView]>;
  files: Array<[string, ImplementationSourceFile[]]>;
}

/** Named entry points into the recording, one per state the explorer renders. Written by the recorder. */
export interface FixtureIds {
  transactions: Record<string, string>;
  outcomes: Partial<Record<TransactionOutcome, string>>;
  batches: {
    allAdmitted: string;
    /** Admitted and excluded items side by side, so the item indexes have gaps. */
    withExclusions: string;
    /** Every item excluded; the carrier itself was admitted. */
    allExcluded: string;
    blob: string;
    /** A carrier event: the Marketplace router's buy, which paid and carried its claim. */
    event: string;
    excluded: Record<string, string>;
  };
  blocks: { latest: string; withTransactions: string };
  contracts: { verified: string[]; unverified: string };
  addresses: {
    actors: Record<string, string>;
    relayer: string;
    keyless: string;
    unknown: string;
  };
  applicationVkHash: string;
  pending: string[];
  spentNullifier: string;
}

export interface FixtureWorld {
  readonly status: StatusResult;
  readonly issuance: IssuanceQuoteResult | null;
  readonly payouts: readonly PayoutRecordResult[];
  readonly blocks: readonly BlockResult[];
  readonly blocksByHash: ReadonlyMap<string, BlockResult>;
  readonly transactions: readonly FixtureTransaction[];
  readonly transactionsById: ReadonlyMap<string, FixtureTransaction>;
  readonly batches: readonly L1DeliveryBatchResult[];
  /** Every carrier's manifest of each Ethereum transaction, in carrier order. */
  readonly batchesByHash: ReadonlyMap<string, readonly L1DeliveryBatchResult[]>;
  readonly contracts: readonly ContractSummaryResult[];
  readonly contractSources: ReadonlyMap<string, ContractSourceView>;
  readonly contractBundles: ReadonlyMap<string, ContractSourceBundle>;
  readonly implementations: ReadonlyMap<string, ImplementationSourceView>;
  readonly implementationFiles: ReadonlyMap<string, readonly ImplementationSourceFile[]>;
  readonly mempool: readonly MempoolItemResult[];
  /** Each block's blockPayouts record, keyed by lowercase block hash. */
  readonly blockPayouts: ReadonlyMap<string, BlockPayoutsResult>;
  readonly sourceInfo: SourceVerificationInfo;
  readonly accounts: ReadonlyMap<string, FixtureAccount>;
}

/** The recorder writes every bigint as `{ "$bigint": "<decimal>" }`. */
function revive(_key: string, value: unknown): unknown {
  if (typeof value === "object" && value !== null && "$bigint" in value) {
    const encoded = (value as { $bigint: unknown }).$bigint;
    if (typeof encoded === "string") return BigInt(encoded);
  }
  return value;
}

function recorded<T>(raw: string): T {
  return JSON.parse(raw, revive) as T;
}

const lower = (value: string): string => value.toLowerCase();

const recordedStatus = recorded<Omit<StatusResult, "observedL1BlockNumber">>(statusRaw);
// Fixture mode has no live L1; the recorded derived head is its observed head.
const status: StatusResult = {
  ...recordedStatus,
  observedL1BlockNumber: recordedStatus.latestL1BlockNumber,
};
if (status.pcashChainId !== FIXTURE_CHAIN_ID) {
  throw new Error(`recorded status reports chain ${status.pcashChainId}, constants say ${FIXTURE_CHAIN_ID}`);
}
const blocks = recorded<BlockResult[]>(blocksRaw);
const transactions = recorded<FixtureTransaction[]>(transactionsRaw);
const batches = recorded<L1DeliveryBatchResult[]>(batchesRaw);
const contracts = recorded<ContractSummaryResult[]>(contractsRaw);
const sources = recorded<RecordedSources>(sourcesRaw);
const blockPayouts = recorded<BlockPayoutsResult[]>(blockPayoutsRaw);
const accounts = recorded<FixtureAccount[]>(accountsRaw);

export const fixtureStatus: StatusResult = status;

export const fixtureWorld: FixtureWorld = {
  status,
  issuance: recorded<IssuanceQuoteResult | null>(issuanceRaw),
  payouts: recorded<PayoutRecordResult[]>(payoutsRaw),
  blocks,
  blocksByHash: new Map(blocks.map((block) => [lower(block.hash), block])),
  transactions,
  transactionsById: new Map(transactions.map((entry) => [lower(entry.summary.transactionId), entry])),
  batches,
  batchesByHash: batches.reduce((byHash, batch) => {
    const hash = lower(batch.l1TransactionHash);
    byHash.set(hash, [...byHash.get(hash) ?? [], batch]);
    return byHash;
  }, new Map<string, L1DeliveryBatchResult[]>()),
  contracts,
  contractSources: new Map(sources.contracts.map(([address, view]) => [lower(address), view])),
  contractBundles: new Map(sources.bundles.map(([address, bundle]) => [lower(address), bundle])),
  implementations: new Map(sources.implementations.map(([hash, view]) => [lower(hash), view])),
  implementationFiles: new Map(sources.files.map(([hash, files]) => [lower(hash), files])),
  mempool: recorded<MempoolItemResult[]>(mempoolRaw),
  blockPayouts: new Map(blockPayouts.map((entry) => [lower(entry.block.blockHash), entry])),
  sourceInfo: sources.info,
  accounts: new Map(accounts.map((entry) => [lower(entry.address), entry])),
};

export const fixtureIds: FixtureIds = recorded<FixtureIds>(idsRaw);
