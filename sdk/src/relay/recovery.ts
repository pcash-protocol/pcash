// Recovery for the exact transactions and injected-wallet intents of one relay journal.

import {
  createPublicClient,
  http,
  type Hash,
  type TransactionReceipt,
  type Transport,
} from "viem";
import type { L1DeliveryBatchResult, PcashNodeClient } from "../clients/index.ts";
import { pcashL1Chain, requireL1Identity } from "../l1/index.ts";
import type {
  RelayJournal,
  RelayJournalEntry,
  RelayJournalEntryReconciliation,
  RelayJournalReconciliation,
  RelayJournalRecovery,
  RelayJournalResolution,
  RelayJournalView,
} from "./journal.ts";
import {
  RelayDeadlineError,
  RelayUpstreamError,
  relayFailure,
  withRelayDeadline,
} from "./errors.ts";

export const RECOVERY_RPC_TIMEOUT_MS = 30_000;

export interface RelayL1Receipt {
  status: "success" | "reverted";
  blockNumber: bigint;
  blockHash: string;
  transactionIndex: number;
  gasUsed: bigint;
}

export interface RelayJournalReads {
  readL1Receipt(entry: RelayJournalEntry, transactionHash: string): Promise<RelayL1Receipt | null>;
  readDelivery(l1TransactionHash: string): Promise<L1DeliveryBatchResult | null>;
}

export interface RelayJournalRecoveryManagerConfig {
  journal: RelayJournal;
  node: Pick<PcashNodeClient, "getInboxDeliveryBatch">;
  l1Rpc?: string;
  runExclusive?: <T>(operation: () => Promise<T>) => Promise<T>;
  transportFor?: (rpcUrl: string) => Transport;
  readL1Receipt?: RelayJournalReads["readL1Receipt"];
}

/** The viem failure a public client raises while a transaction is not mined. */
function isReceiptNotFound(error: unknown): boolean {
  return error instanceof Error
    && (error.name === "TransactionReceiptNotFoundError" || /transaction receipt.*not found/i.test(error.message));
}

/** Read one attempt's L1 receipt; null while it is not mined. */
export async function journalL1Receipt(
  entry: RelayJournalEntry,
  rpcUrl: string,
  transport: Transport,
  transactionHash: string,
): Promise<TransactionReceipt | null> {
  const client = createPublicClient({
    chain: pcashL1Chain(BigInt(entry.chainId), rpcUrl),
    transport,
  });
  try {
    const receipt = await client.getTransactionReceipt({ hash: transactionHash as Hash });
    if (receipt.transactionHash.toLowerCase() !== transactionHash.toLowerCase()) {
      throw new RelayUpstreamError(`L1 returned receipt for ${receipt.transactionHash}, expected ${transactionHash}`);
    }
    return receipt;
  } catch (error) {
    if (isReceiptNotFound(error)) return null;
    throw relayFailure("reading the journal L1 receipt", error);
  }
}

/** Find whichever attempt at this nonce mined, including an earlier transaction. */
export async function findJournalReceipt<T extends RelayL1Receipt>(
  entry: RelayJournalEntry,
  read: (transactionHash: string) => Promise<T | null>,
): Promise<{ transactionHash: string; receipt: T } | null> {
  if (entry.transactionHash === null) return null;
  for (const transactionHash of [entry.transactionHash, ...entry.previousTransactionHashes]) {
    const receipt = await read(transactionHash);
    if (receipt !== null) return { transactionHash, receipt };
  }
  return null;
}

/** Bound one recovery read so a hung RPC cannot hold the journal's exclusive queue. */
function withRecoveryDeadline<T>(what: string, operation: () => Promise<T>): Promise<T> {
  return withRelayDeadline(what, RECOVERY_RPC_TIMEOUT_MS, operation);
}

/**
 * Settle every in-flight transaction of one journal. A batch entry covers two
 * windows: broadcast to inclusion, where a second send would spend a second
 * nonce on the same batch, and inclusion to the node's derivation of that
 * block, where its transactions still read as ready and a fresh relay would post
 * them again. Batch carriers clear once the node has recorded their delivery,
 * regardless of Ethereum receipt status. Other calls clear at their receipt.
 */
export async function reconcileRelayJournal(
  journal: RelayJournal,
  reads: RelayJournalReads,
): Promise<RelayJournalReconciliation> {
  const entries = await Promise.all((await journal.read()).map((entry) => reconcileEntry(journal, entry, reads)));
  return { latched: entries.some((entry) => entry.outcome !== "cleared"), entries };
}

async function reconcileEntry(
  journal: RelayJournal,
  entry: RelayJournalEntry,
  reads: RelayJournalReads,
): Promise<RelayJournalEntryReconciliation> {
  const { resolutionId } = entry;
  if (entry.transactionHash === null) return { outcome: "ambiguous", resolutionId };
  const mined = await findJournalReceipt(entry, (hash) => reads.readL1Receipt(entry, hash));
  if (mined === null) return { outcome: "pending", resolutionId, transactionHash: entry.transactionHash };
  const { transactionHash, receipt } = mined;
  const l1Receipt: NonNullable<RelayJournalEntryReconciliation["l1Receipt"]> = {
    status: receipt.status === "success" ? 1 : 0,
    blockNumber: receipt.blockNumber,
    blockHash: receipt.blockHash,
    transactionIndex: receipt.transactionIndex,
    gasUsed: receipt.gasUsed,
  };
  if (entry.kind === "batch" && await reads.readDelivery(transactionHash) === null) {
    return { outcome: "unobserved", resolutionId, transactionHash, l1Receipt };
  }
  await journal.clear(resolutionId);
  return { outcome: "cleared", resolutionId, transactionHash, l1Receipt };
}

/** Reconcile, or deliberately archive, the entries of one platform-owned relay journal. */
export class RelayJournalRecoveryManager implements RelayJournalRecovery {
  readonly #journal: RelayJournal;
  readonly #node: Pick<PcashNodeClient, "getInboxDeliveryBatch">;
  readonly #l1Rpc: string | undefined;
  readonly #runExclusive: <T>(operation: () => Promise<T>) => Promise<T>;
  readonly #transportFor: (rpcUrl: string) => Transport;
  readonly #readL1ReceiptOverride: RelayJournalReads["readL1Receipt"] | undefined;

  constructor(config: RelayJournalRecoveryManagerConfig) {
    this.#journal = config.journal;
    this.#node = config.node;
    this.#l1Rpc = config.l1Rpc;
    const runExclusive = config.runExclusive ?? (async (operation) => operation());
    this.#runExclusive = (operation) => runExclusive(() =>
      this.#journal.runExclusive === undefined ? operation() : this.#journal.runExclusive(operation));
    this.#transportFor = config.transportFor ?? ((rpcUrl) => http(rpcUrl, { timeout: RECOVERY_RPC_TIMEOUT_MS }));
    this.#readL1ReceiptOverride = config.readL1Receipt;
  }

  async show(): Promise<RelayJournalView> {
    const entries = await this.#journal.read();
    return { latched: entries.length > 0, entries };
  }

  reconcile(): Promise<RelayJournalReconciliation> {
    return this.#runExclusive(() => reconcileRelayJournal(this.#journal, {
      readL1Receipt: (entry, hash) => this.#readL1Receipt(entry, hash),
      readDelivery: (hash) => this.#readDelivery(hash),
    }));
  }

  resolve(resolutionId: string): Promise<RelayJournalResolution> {
    return this.#runExclusive(async () => {
      const entry = (await this.#journal.read())
        .find((candidate) => candidate.resolutionId.toLowerCase() === resolutionId.toLowerCase());
      const archivePath = await this.#journal.archive(resolutionId);
      return {
        latched: (await this.#journal.read()).length > 0,
        resolutionId,
        ...(entry?.transactionHash === null || entry?.transactionHash === undefined
          ? {}
          : { transactionHash: entry.transactionHash }),
        archivePath,
      };
    });
  }

  async #defaultL1Receipt(entry: RelayJournalEntry, transactionHash: string): Promise<RelayL1Receipt | null> {
    if (this.#l1Rpc === undefined) {
      throw new RelayUpstreamError("recovery requires an L1 RPC URL to query transaction receipts");
    }
    const rpcUrl = this.#l1Rpc;
    const transport = this.#transportFor(rpcUrl);
    try {
      await withRecoveryDeadline("verifying journal L1 identity", () => requireL1Identity(rpcUrl, {
        chainId: BigInt(entry.chainId),
        anchorNumber: BigInt(entry.genesisL1Block),
        anchorHash: entry.genesisL1BlockHash,
      }, { transport }));
      const receipt = await withRecoveryDeadline(
        "reading the journal L1 receipt",
        () => journalL1Receipt(entry, rpcUrl, transport, transactionHash),
      );
      return receipt;
    } catch (error) {
      throw relayFailure("reading the journal L1 receipt", error);
    }
  }

  async #readL1Receipt(entry: RelayJournalEntry, transactionHash: string): Promise<RelayL1Receipt | null> {
    if (this.#readL1ReceiptOverride !== undefined) {
      try {
        return await withRecoveryDeadline(
          "reading the journal L1 receipt",
          () => this.#readL1ReceiptOverride!(entry, transactionHash),
        );
      } catch (error) {
        if (error instanceof RelayDeadlineError || error instanceof RelayUpstreamError) throw error;
        throw new RelayUpstreamError("reading the journal L1 receipt failed", error);
      }
    }
    return this.#defaultL1Receipt(entry, transactionHash);
  }

  async #readDelivery(l1TransactionHash: string): Promise<L1DeliveryBatchResult | null> {
    try {
      return await withRecoveryDeadline(
        "reading PCASH L1 delivery",
        () => this.#node.getInboxDeliveryBatch(l1TransactionHash),
      );
    } catch (error) {
      if (error instanceof RelayDeadlineError) throw error;
      throw new RelayUpstreamError("reading PCASH L1 delivery failed", error);
    }
  }
}
