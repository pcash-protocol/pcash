// Records the seeded chain as Explorer fixture data: every read the Explorer
// makes, taken from the node and Pscan and written as JSON. The web fixture
// reader pages and filters over these files; nothing in the browser derives
// chain state.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Config } from "@pcash/sdk/bcfg";
import { logger } from "../framework/logger.ts";
import {
  createPscanClient,
  PcashNodeClient,
  type AccountResult,
  type IssuanceQuoteResult,
  type PayoutRecordResult,
  type PayoutCursor,
  type BlockPayoutsResult,
  type BlockResult,
  type ContractSourceBundle,
  type ContractSourceView,
  type ContractSummaryResult,
  type ExplorerCursor,
  type ImplementationSourceFile,
  type ImplementationSourceView,
  type L1DeliveryBatchResult,
  type MempoolItemResult,
  type PscanClient,
  type ReceiptResult,
  type SourceVerificationInfo,
  type StatusResult,
  type TransactionSummaryResult,
} from "@pcash/sdk/clients";
import type { TransactionOutcome } from "@pcash/sdk/protocol";
import { isItemExclusion } from "./richSeedPlan.ts";
import type { RichSeedResult } from "./richSeed.ts";
import { controlAddress } from "./seedControls.ts";

const PAGE_LIMIT = 100;
const BLOCK_RANGE = 100;
const MAX_CAPTURE_ATTEMPTS = 5;

export interface RecordedTransaction {
  summary: TransactionSummaryResult;
  rawTransaction: string;
  receipts: ReceiptResult[];
}

export interface RecordedSources {
  info: SourceVerificationInfo;
  contracts: Array<[address: string, view: ContractSourceView]>;
  bundles: Array<[address: string, bundle: ContractSourceBundle]>;
  implementations: Array<[applicationVkHash: string, view: ImplementationSourceView]>;
  files: Array<[applicationVkHash: string, files: ImplementationSourceFile[]]>;
}

export interface RecordedAccount {
  address: string;
  account: AccountResult | null;
  history: TransactionSummaryResult[];
}

/** Named entry points into the recording, one per state the Explorer renders. */
export interface RecordedIds {
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

export type RecorderNode = Pick<
  PcashNodeClient,
  | "status"
  | "getBlocks"
  | "getTransactions"
  | "getTransaction"
  | "getReceipt"
  | "getL1DeliveryBatches"
  | "getContracts"
  | "getMempool"
  | "getBlockPayouts"
  | "getIssuanceQuote"
  | "getPayouts"
  | "getAccount"
  | "getAccountHistory"
>;

export type RecorderPscan = Pick<
  PscanClient,
  | "sourceVerificationInfo"
  | "getContractSource"
  | "getContractSourceBundle"
  | "getImplementationSource"
  | "getImplementationSourceFile"
>;

export interface ChainSnapshot {
  status: StatusResult;
  blocks: BlockResult[];
  transactions: RecordedTransaction[];
  batches: L1DeliveryBatchResult[];
  contracts: ContractSummaryResult[];
  sources: RecordedSources;
  mempool: MempoolItemResult[];
  blockPayouts: BlockPayoutsResult[];
  issuance: IssuanceQuoteResult | null;
  payouts: PayoutRecordResult[];
  accounts: RecordedAccount[];
}

export interface CaptureChainSnapshotParams {
  node: RecorderNode;
  pscan: RecorderPscan;
  /**
   * Carriers to record even when no receipt names them: the seed's own,
   * including those the node excluded whole or whose every item it excluded.
   * Every carrier with a canonical inclusion is named by its own receipts.
   */
  carrierHashes: readonly string[];
  addresses: readonly string[];
  log?: (message: string) => void;
}

export interface RecordExplorerFixtureParams {
  node: PcashNodeClient;
  pscan: PscanClient;
  evidence: RichSeedResult;
  outDir: string;
  log?: (message: string) => void;
}

function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? { $bigint: value.toString() } : value;
}

async function pageAll<T, C>(
  fetch: (cursor: C | undefined) => Promise<{ items: T[]; nextCursor: C | null }>,
): Promise<T[]> {
  const items: T[] = [];
  let cursor: C | undefined;
  for (let page = 0; page < 10_000; page += 1) {
    const result = await fetch(cursor);
    items.push(...result.items);
    if (result.nextCursor === null) return items;
    cursor = result.nextCursor;
  }
  throw new Error("fixture recording paged without reaching the end");
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.toLowerCase()))];
}

function sameHead(a: StatusResult, b: StatusResult): boolean {
  return a.latestBlock === b.latestBlock && a.latestBlockHash.toLowerCase() === b.latestBlockHash.toLowerCase();
}

function inclusionKey(l1TransactionHash: string, batchItemIndex: bigint): string {
  return `${l1TransactionHash.toLowerCase()}:${batchItemIndex}`;
}

/**
 * Capture every Explorer read at one ready head. The reads agree with each
 * other only if no block lands between the first and the last, and the node
 * serves rankings only as of its current head, so a capture during which the
 * head moves is discarded and taken again.
 */
export async function captureChainSnapshot(params: CaptureChainSnapshotParams): Promise<ChainSnapshot> {
  const log = params.log ?? (() => undefined);
  for (let attempt = 1; ; attempt += 1) {
    const status = await params.node.status();
    let snapshot: ChainSnapshot;
    try {
      snapshot = await captureAt(status, params, log);
    } catch (error) {
      const now = await params.node.status();
      if (sameHead(now, status)) throw error;
      if (attempt >= MAX_CAPTURE_ATTEMPTS) {
        throw new Error(
          `the head moved during ${MAX_CAPTURE_ATTEMPTS} captures in a row; stop block production and record again`,
          { cause: error },
        );
      }
      log(`head moved from ${status.latestBlock} to ${now.latestBlock} during capture; capturing again`);
      continue;
    }
    const after = await params.node.status();
    if (sameHead(after, status)) return snapshot;
    if (attempt >= MAX_CAPTURE_ATTEMPTS) {
      throw new Error(`the head moved during ${MAX_CAPTURE_ATTEMPTS} captures in a row; stop block production and record again`);
    }
    log(`head moved from ${status.latestBlock} to ${after.latestBlock} during capture; capturing again`);
  }
}

async function captureAt(
  status: StatusResult,
  params: CaptureChainSnapshotParams,
  log: (message: string) => void,
): Promise<ChainSnapshot> {
  const { node, pscan } = params;
  const blocks: BlockResult[] = [];
  for (let from = 0n; from <= status.latestBlock; from += BigInt(BLOCK_RANGE)) {
    const to = from + BigInt(BLOCK_RANGE) - 1n < status.latestBlock ? from + BigInt(BLOCK_RANGE) - 1n : status.latestBlock;
    blocks.push(...await node.getBlocks(from, to));
  }
  if (blocks.at(-1)?.number !== status.latestBlock) {
    throw new Error(`recorded ${blocks.length} blocks but the last is not head ${status.latestBlock}`);
  }
  log(`${blocks.length} blocks`);

  const summaries = await pageAll<TransactionSummaryResult, ExplorerCursor>((cursor) =>
    node.getTransactions({ limit: PAGE_LIMIT, ...(cursor === undefined ? {} : { cursor }) }));
  const transactions: RecordedTransaction[] = [];
  for (const summary of summaries) {
    const [canonical, receipts] = await Promise.all([node.getTransaction(summary.transactionId), node.getReceipt(summary.transactionId)]);
    if (canonical === null) throw new Error(`transaction ${summary.transactionId} listed but not readable`);
    transactions.push({ summary: canonical.summary, rawTransaction: canonical.rawTransaction, receipts });
  }
  log(`${transactions.length} transactions`);

  const carrierHashes = new Set(params.carrierHashes.map((hash) => hash.toLowerCase()));
  for (const { receipts } of transactions) {
    for (const { inclusion } of receipts) {
      carrierHashes.add(inclusion.l1TransactionHash.toLowerCase());
    }
  }
  const batches: L1DeliveryBatchResult[] = [];
  for (const hash of carrierHashes) {
    const delivered = await node.getL1DeliveryBatches(hash);
    if (delivered.length === 0) throw new Error(`L1 delivery ${hash} is unknown to the node`);
    batches.push(...delivered);
  }
  const items = new Map<string, L1DeliveryBatchResult["items"][number]>();
  for (const batch of batches) {
    for (const item of batch.items) {
      items.set(inclusionKey(batch.l1TransactionHash, item.batchItemIndex), item);
    }
  }
  for (const { summary, receipts } of transactions) {
    for (const { inclusion } of receipts) {
      const item = items.get(inclusionKey(inclusion.l1TransactionHash, inclusion.batchItemIndex));
      if (item === undefined || item.exclusionReason !== null
        || item.contentHash.toLowerCase() !== summary.contentHash.toLowerCase()) {
        throw new Error(`transaction ${summary.transactionId} has no admitted item in its recorded L1 delivery batch`);
      }
    }
  }
  log(`${batches.length} L1 delivery batches`);

  const contracts = await pageAll<ContractSummaryResult, ExplorerCursor>((cursor) =>
    node.getContracts({ limit: PAGE_LIMIT, ...(cursor === undefined ? {} : { cursor }) }));
  const sources: RecordedSources = {
    info: await pscan.sourceVerificationInfo(),
    contracts: [],
    bundles: [],
    implementations: [],
    files: [],
  };
  const applicationVkHashes = new Set<string>();
  for (const contract of contracts) {
    const address = contract.address.toLowerCase();
    const view = await pscan.getContractSource(address);
    if (view !== null) sources.contracts.push([address, view]);
    const bundle = await pscan.getContractSourceBundle(address);
    if (bundle !== null) sources.bundles.push([address, bundle]);
    for (const implementation of view?.implementations ?? []) applicationVkHashes.add(implementation.applicationVkHash.toLowerCase());
    for (const fn of contract.functions) applicationVkHashes.add(fn.applicationVkHash.toLowerCase());
  }
  for (const hash of applicationVkHashes) {
    const view = await pscan.getImplementationSource(hash);
    if (view === null) continue;
    sources.implementations.push([hash, view]);
    const files: ImplementationSourceFile[] = [];
    for (const { path } of view.sourceFiles) {
      const file = await pscan.getImplementationSourceFile(hash, path);
      if (file === null) throw new Error(`implementation ${hash} lists ${path} but does not serve it`);
      files.push(file);
    }
    sources.files.push([hash, files]);
  }
  log(`${contracts.length} contracts, ${sources.contracts.length} with source, ${sources.implementations.length} implementations`);

  const mempool = await pageAll<MempoolItemResult, string>((cursor) =>
    node.getMempool({ limit: PAGE_LIMIT, sort: "receivedAt", ...(cursor === undefined ? {} : { cursor }) }));
  log(`${mempool.length} mempool items`);

  const blockPayouts: BlockPayoutsResult[] = [];
  for (const block of blocks) {
    const entry = await node.getBlockPayouts({ blockNumber: block.number, blockHash: block.hash });
    if (entry !== null) blockPayouts.push(entry);
  }
  log(`${blockPayouts.length} block blockPayouts records`);
  const issuance = await node.getIssuanceQuote(status.latestBlockTimestamp);
  const payouts: PayoutRecordResult[] = [];
  let payoutCursor: PayoutCursor | undefined;
  do {
    const page = await node.getPayouts({limit:PAGE_LIMIT,...(payoutCursor === undefined ? {} : {cursor:payoutCursor})});
    payouts.push(...page.records);
    payoutCursor = page.nextCursor ?? undefined;
  } while (payoutCursor !== undefined);

  // Every recorded contract is an account the explorer links to.
  const accounts: RecordedAccount[] = [];
  for (const address of unique([...params.addresses, ...contracts.map((contract) => contract.address)])) {
    const [account, history] = await Promise.all([
      node.getAccount(address),
      pageAll<TransactionSummaryResult, ExplorerCursor>((cursor) =>
        node.getAccountHistory({ address, limit: PAGE_LIMIT, ...(cursor === undefined ? {} : { cursor }) })),
    ]);
    accounts.push({ address, account, history });
  }
  log(`${accounts.length} addresses`);

  return { status, blocks, transactions, batches, contracts, sources, mempool, blockPayouts, issuance, payouts, accounts };
}

export async function recordExplorerFixture(params: RecordExplorerFixtureParams): Promise<RecordedIds> {
  const { node, pscan, evidence } = params;
  const log = params.log ?? (() => undefined);
  const outDir = resolve(params.outDir);
  await mkdir(outDir, { recursive: true });

  const unknownAddress = controlAddress("account-not-found");
  const addresses = unique([
    ...Object.values(evidence.actors),
    evidence.explorer.relayerAddress,
    evidence.explorer.keylessAccountAddress,
    evidence.explorer.privateVaultAddress,
    ...evidence.contracts.marketplace,
    unknownAddress,
  ]);
  const snapshot = await captureChainSnapshot({
    node,
    pscan,
    carrierHashes: unique([
      ...evidence.canonicalEntries.map((entry) => entry.l1TransactionHash),
      ...evidence.explorer.excludedCarriers.map((carrier) => carrier.l1TransactionHash),
    ]),
    addresses,
    log,
  });
  log(`recorded chain ${snapshot.status.pcashChainId} at block ${snapshot.status.latestBlock} into ${outDir}`);

  const ids = namedIds(evidence, snapshot.status, snapshot.transactions, snapshot.sources, snapshot.contracts, unknownAddress);

  const files: Array<[string, unknown]> = [
    ["status.json", snapshot.status],
    ["blocks.json", snapshot.blocks],
    ["transactions.json", snapshot.transactions],
    ["batches.json", snapshot.batches],
    ["contracts.json", snapshot.contracts],
    ["sources.json", snapshot.sources],
    ["mempool.json", snapshot.mempool],
    ["blockPayouts.json", snapshot.blockPayouts],
    ["issuance.json", snapshot.issuance],
    ["payouts.json", snapshot.payouts],
    ["accounts.json", snapshot.accounts],
    ["ids.json", ids],
  ];
  for (const [name, value] of files) {
    await writeFile(join(outDir, name), `${JSON.stringify(value, jsonReplacer)}\n`);
  }
  log(`wrote ${files.length} files`);
  return ids;
}

function namedIds(
  evidence: RichSeedResult,
  status: StatusResult,
  transactions: readonly RecordedTransaction[],
  sources: RecordedSources,
  contracts: readonly ContractSummaryResult[],
  unknownAddress: string,
): RecordedIds {
  const byId = new Map(transactions.map((entry) => [entry.summary.transactionId.toLowerCase(), entry]));
  const canonical = evidence.canonicalEntries;
  const withIds = canonical.filter((entry): entry is typeof entry & { transactionId: string } => entry.transactionId !== null);
  const outcomes: Partial<Record<TransactionOutcome, string>> = {};
  for (const entry of withIds) {
    const outcome = entry.observedOutcome as TransactionOutcome;
    outcomes[outcome] ??= entry.transactionId;
  }
  const byCarrier = new Map<string, typeof canonical>();
  for (const entry of canonical) {
    const key = entry.l1TransactionHash.toLowerCase();
    byCarrier.set(key, [...(byCarrier.get(key) ?? []), entry]);
  }
  const allAdmitted = [...byCarrier.entries()].find(([, entries]) =>
    entries.length > 1 && entries.every((entry) => entry.observedOutcome === "succeeded"))?.[0];
  const excluded = (entry: { expectedOutcome: string }) => isItemExclusion(entry.expectedOutcome as never);
  const withExclusions = [...byCarrier.entries()].find(([, entries]) =>
    entries.some(excluded) && entries.some((entry) => !excluded(entry)))?.[0];
  const allExcluded = [...byCarrier.entries()].find(([, entries]) => entries.every(excluded))?.[0];
  const blob = evidence.waves.flatMap((wave) => wave.carriers).find((carrier) => carrier.carrierType === "blob")?.l1TransactionHash;
  if (allAdmitted === undefined || withExclusions === undefined || allExcluded === undefined || blob === undefined) {
    throw new Error("seed evidence lacks a fully admitted, a mixed, an all-excluded, or a blob carrier");
  }
  const transferId = withIds.find((entry) => entry.label === "transfer-s-r")?.transactionId;
  const transfer = transferId === undefined ? undefined : byId.get(transferId.toLowerCase());
  if (transfer === undefined) throw new Error("transfer-s-r is missing from the recorded transactions");
  // The Marketplace claim travels in the router's own carrier, not in a seed wave.
  const claimContentHash = evidence.marketplace.paidOffer.claimContentHash.toLowerCase();
  const claim = transactions.find(({ summary }) =>
    summary.contentHash.toLowerCase() === claimContentHash && summary.outcome === "succeeded");
  if (claim === undefined) throw new Error("the Marketplace claim is missing from the recorded transactions");
  const reuse = withIds.find((entry) => entry.label === "control-nullifier-reuse")?.transactionId;
  const reuseDetail = reuse === undefined ? undefined : byId.get(reuse.toLowerCase())?.summary.failureDetail;
  if (reuseDetail?.type !== "nullifierAlreadySpent") throw new Error("the nullifier reuse control did not record a spent nullifier");
  const verifiedView = sources.contracts.find(([, view]) => view.verificationStatus === "verified")?.[1];
  const applicationVkHash = verifiedView?.implementations[0]?.applicationVkHash
    ?? contracts[0]?.functions[0]?.applicationVkHash;
  if (applicationVkHash === undefined) throw new Error("no application VK hash to name");
  return {
    transactions: {
      ...Object.fromEntries(withIds.map((entry) => [entry.label, entry.transactionId])),
      "marketplace:claim": claim.summary.transactionId,
    },
    outcomes,
    batches: {
      allAdmitted,
      withExclusions,
      allExcluded,
      blob: blob.toLowerCase(),
      event: evidence.marketplace.paidOffer.paymentTxHash.toLowerCase(),
      excluded: Object.fromEntries(evidence.explorer.excludedCarriers.map((carrier) => [carrier.label, carrier.l1TransactionHash.toLowerCase()])),
    },
    blocks: {
      latest: status.latestBlock.toString(),
      withTransactions: transfer.summary.block.blockHash.toLowerCase(),
    },
    contracts: {
      verified: evidence.contracts.verified.map((address) => address.toLowerCase()),
      unverified: evidence.explorer.privateVaultAddress.toLowerCase(),
    },
    addresses: {
      actors: Object.fromEntries(Object.entries(evidence.actors).map(([name, address]) => [name, address.toLowerCase()])),
      relayer: evidence.explorer.relayerAddress.toLowerCase(),
      keyless: evidence.explorer.keylessAccountAddress.toLowerCase(),
      unknown: unknownAddress,
    },
    applicationVkHash: applicationVkHash.toLowerCase(),
    pending: evidence.pending.contentHashes.map((hash) => hash.toLowerCase()),
    spentNullifier: reuseDetail.nullifier,
  };
}

/** Re-record from a finished seed without running it again: `--evidence <seed-evidence.json> --out <dir>`. */
async function main(argv: readonly string[]): Promise<void> {
  // npm runs workspace scripts from the workspace directory; paths are relative to where the user typed the command.
  const invokedFrom = process.env.INIT_CWD?.trim() || process.cwd();
  const settings = new Config("pcash-e2e");
  settings.load({ argv: ["node", "record-fixtures", ...argv], env: process.env });
  const option = (name: string): string => {
    const value = settings.str(name);
    if (value === null) throw new Error(`--${name} <value> is required`);
    return resolve(invokedFrom, value);
  };
  const evidence = JSON.parse(await readFile(option("evidence"), "utf8")) as RichSeedResult;
  const rpcUrl = settings.str("rpc-url")?.trim() || "http://127.0.0.1:8645";
  const pscanUrl = settings.str("pscan-url")?.trim() || "http://127.0.0.1:8648";
  const node = new PcashNodeClient(rpcUrl);
  await recordExplorerFixture({
    node,
    pscan: createPscanClient(pscanUrl, undefined, node),
    evidence,
    outDir: option("out"),
    log: (message) => logger.context("record-fixtures").info(message),
  });
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    logger.error(`Fixture recording failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
