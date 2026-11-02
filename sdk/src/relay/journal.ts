import type { RelayCarrier } from "./relayer.ts";
import { RelayJournalConflictError, RelayValidationError } from "./errors.ts";

export type RelayJournalPhase = "broadcast_attempted" | "broadcast_accepted";
export type RelaySubmissionKind = "signed_raw" | "eip1193_intent";

/** What every journaled L1 transaction records, whatever it carries. */
interface RelayJournalEntryCommon {
  createdAt: string;
  resolutionId: string;
  phase: RelayJournalPhase;
  submissionKind: RelaySubmissionKind;
  transactionHash: string | null;
  signedTransaction: string | null;
  /** Earlier signed transactions at this nonce; any one can still be mined. */
  previousTransactionHashes: string[];
  /** L1 head of the latest private-key batch send, including an exact-byte retry. */
  lastBroadcastBlock: string | null;
  /** The L1 account that signs every transaction in this journal. */
  relayerAddress: string;
  chainId: string;
  nonce: string;
  gasLimit: string;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
  genesisL1Block: string;
  genesisL1BlockHash: string;
}

/** A PCASH batch posted to the inbox; it settles once the node derives its block. */
export interface RelayBatchJournalEntry extends RelayJournalEntryCommon {
  kind: "batch";
  carrier: RelayCarrier;
  batch: string;
  selected: string[];
  batchItemIndexes: string[];
  observationMode: "selected" | "batch";
  collectibleOpenFee: string;
  inboxAddress: string;
  maxFeePerBlobGas: string | null;
  headCheckedBlock: string;
  headCheckedBlockHash: string;
}

/** Any other L1 transaction the account sends; it settles at its receipt. */
export interface RelayCallJournalEntry extends RelayJournalEntryCommon {
  kind: "call";
  to: string;
  value: string;
  data: string;
}

/** One L1 submission and all its same-nonce attempts, retained until settlement. */
export type RelayJournalEntry = RelayBatchJournalEntry | RelayCallJournalEntry;

/**
 * Every in-flight transaction of one L1 account. An entry is created before its
 * transaction is broadcast and cleared once the transaction settles, so a
 * restarted host never reuses a nonce or posts a batch twice.
 */
export interface RelayJournal {
  /** Serialize a complete journal operation across processes, when the backend is shared. */
  runExclusive?<T>(operation: () => Promise<T>): Promise<T>;
  /** In-flight entries in nonce order. */
  read(): Promise<RelayJournalEntry[]>;
  /** Record one more in-flight transaction; its nonce and resolutionId must be new. */
  create(entry: RelayJournalEntry): Promise<void>;
  replace(entry: RelayJournalEntry): Promise<void>;
  clear(resolutionId: string): Promise<void>;
  archive(resolutionId: string): Promise<string>;
}

export interface RelayJournalView {
  latched: boolean;
  entries: RelayJournalEntry[];
}

/**
 * `ambiguous`: broadcast without a hash, so only an operator can settle it.
 * `pending`: broadcast, not yet mined. `unobserved`: a batch mined, but the
 * node has not yet derived its inclusion block, so its transactions still read
 * as ready. `cleared`: the entry is released. Ethereum receipt status determines
 * generic call success; batch delivery is determined by the PCASH node.
 */
export interface RelayJournalEntryReconciliation {
  outcome: "ambiguous" | "pending" | "unobserved" | "cleared";
  resolutionId: string;
  transactionHash?: string;
  l1Receipt?: {
    status: 0 | 1;
    blockNumber: bigint;
    blockHash: string;
    transactionIndex: number;
    gasUsed: bigint;
  };
}

export interface RelayJournalReconciliation {
  /** Whether any entry is still in flight after reconciliation. */
  latched: boolean;
  entries: RelayJournalEntryReconciliation[];
}

export interface RelayJournalResolution {
  latched: boolean;
  resolutionId: string;
  transactionHash?: string;
  archivePath: string;
}

export interface RelayJournalRecovery {
  show(): Promise<RelayJournalView>;
  reconcile(): Promise<RelayJournalReconciliation>;
  resolve(resolutionId: string): Promise<RelayJournalResolution>;
}

/**
 * Where a journal keeps its records. Backends store opaque records by key;
 * every journal rule lives in `StoredRelayJournal`.
 */
export interface RelayJournalRecords {
  /** Every stored record, unparsed. */
  list(): Promise<unknown[]>;
  /** Store a record under a key no record holds; a taken key is a conflict. */
  add(key: string, record: RelayJournalEntry): Promise<void>;
  /** Replace the record under an existing key. */
  put(key: string, record: RelayJournalEntry): Promise<void>;
  remove(key: string): Promise<void>;
  /** Move a record out of the journal, returning where it went. */
  archive(key: string, record: RelayJournalEntry): Promise<string>;
}

/**
 * The journal rules every storage backend shares. Entries are keyed by nonce,
 * so the backend's own atomic create refuses a second transaction at a nonce
 * even across processes or tabs.
 */
export class StoredRelayJournal implements RelayJournal {
  readonly label: string;
  readonly #records: RelayJournalRecords;

  constructor(label: string, records: RelayJournalRecords) {
    this.label = label;
    this.#records = records;
  }

  async read(): Promise<RelayJournalEntry[]> {
    const entries = (await this.#records.list()).map((record) => {
      try {
        return parseRelayJournalEntry(record);
      } catch (error) {
        throw new RelayJournalConflictError(`${this.label} is malformed and must be resolved by an operator`, error);
      }
    });
    return entries.sort((left, right) => BigInt(left.nonce) < BigInt(right.nonce) ? -1 : 1);
  }

  async create(entry: RelayJournalEntry): Promise<void> {
    const parsed = parseRelayJournalEntry(entry);
    if ((await this.read()).some((current) => sameId(current.resolutionId, parsed.resolutionId))) {
      throw new RelayJournalConflictError(`${this.label} already holds resolution ${parsed.resolutionId}`);
    }
    await this.#records.add(nonceKey(parsed.nonce), parsed);
  }

  async replace(entry: RelayJournalEntry): Promise<void> {
    const parsed = parseRelayJournalEntry(entry);
    const current = await this.#matching(parsed.resolutionId);
    // The matched record may have been written by another process. An update
    // must still name that submission, never another nonce's storage key.
    if (current.createdAt !== parsed.createdAt) {
      throw new RelayValidationError("relay journal replacement cannot change createdAt");
    }
    if (current.nonce !== parsed.nonce || current.kind !== parsed.kind) {
      throw new RelayValidationError("relay journal replacement cannot change its nonce or kind");
    }
    await this.#records.put(nonceKey(parsed.nonce), parsed);
  }

  /** Release a settled entry; one already released, for example by a concurrent reconcile, is a no-op. */
  async clear(resolutionId: string): Promise<void> {
    assertResolutionId(resolutionId);
    const current = (await this.read()).find((entry) => sameId(entry.resolutionId, resolutionId));
    if (current !== undefined) await this.#records.remove(nonceKey(current.nonce));
  }

  async archive(resolutionId: string): Promise<string> {
    const current = await this.#matching(resolutionId);
    return this.#records.archive(nonceKey(current.nonce), current);
  }

  async #matching(resolutionId: string): Promise<RelayJournalEntry> {
    assertResolutionId(resolutionId);
    const found = (await this.read()).find((entry) => sameId(entry.resolutionId, resolutionId));
    if (found === undefined) throw new RelayValidationError(`${this.label} holds no resolution ${resolutionId}`);
    return found;
  }
}

/** The storage key of the entry at `nonce`: one entry per nonce. */
export function nonceKey(nonce: string): string {
  return `nonce-${nonce}`;
}

function assertResolutionId(resolutionId: string): void {
  if (resolutionId === "" || resolutionId.length > 256) {
    throw new RelayValidationError("resolutionId is invalid");
  }
}

function sameId(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function hex(value: unknown, bytes?: number): value is string {
  if (typeof value !== "string") return false;
  return bytes === undefined
    ? /^0x(?:[0-9a-fA-F]{2})*$/.test(value)
    : new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`).test(value);
}

const UNSIGNED = /^(?:0|[1-9][0-9]*)$/;

function requireStrings(entry: Record<string, unknown>, fields: readonly string[]): void {
  for (const field of fields) {
    if (typeof entry[field] !== "string") {
      throw new RelayJournalConflictError(`relay journal field ${field} is invalid`);
    }
  }
}

function requireUnsigned(entry: Record<string, unknown>, fields: readonly string[]): void {
  for (const field of fields) {
    if (!UNSIGNED.test(entry[field] as string)) {
      throw new RelayJournalConflictError(`relay journal field ${field} is not an unsigned integer`);
    }
  }
}

/** Validate untrusted durable data before it can control recovery or submission. */
export function parseRelayJournalEntry(value: unknown): RelayJournalEntry {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new RelayJournalConflictError("relay journal entry is not an object");
  }
  const entry = value as Record<string, unknown>;
  const common = [
    "createdAt", "resolutionId", "relayerAddress", "chainId", "nonce", "gasLimit",
    "maxFeePerGas", "maxPriorityFeePerGas", "genesisL1Block", "genesisL1BlockHash",
  ];
  requireStrings(entry, common);
  if (entry.resolutionId === "" || (entry.resolutionId as string).length > 256) {
    throw new RelayJournalConflictError("relay journal resolutionId is invalid");
  }
  if (!["broadcast_attempted", "broadcast_accepted"].includes(String(entry.phase))) {
    throw new RelayJournalConflictError("relay journal phase is invalid");
  }
  if (entry.submissionKind !== "signed_raw" && entry.submissionKind !== "eip1193_intent") {
    throw new RelayJournalConflictError("relay journal submissionKind is invalid");
  }
  if (entry.transactionHash !== null && !hex(entry.transactionHash, 32)) {
    throw new RelayJournalConflictError("relay journal transactionHash is invalid");
  }
  if (entry.signedTransaction !== null && !hex(entry.signedTransaction)) {
    throw new RelayJournalConflictError("relay journal signedTransaction is invalid");
  }
  if (!Array.isArray(entry.previousTransactionHashes)
    || entry.previousTransactionHashes.some((hash) => !hex(hash, 32))) {
    throw new RelayJournalConflictError("relay journal previousTransactionHashes is invalid");
  }
  if (entry.lastBroadcastBlock !== null
    && (typeof entry.lastBroadcastBlock !== "string" || !UNSIGNED.test(entry.lastBroadcastBlock))) {
    throw new RelayJournalConflictError("relay journal lastBroadcastBlock is invalid");
  }
  if (!hex(entry.relayerAddress, 20) || !hex(entry.genesisL1BlockHash, 32)) {
    throw new RelayJournalConflictError("relay journal account identity is invalid");
  }
  requireUnsigned(entry, ["chainId", "nonce", "gasLimit", "maxFeePerGas", "maxPriorityFeePerGas", "genesisL1Block"]);
  if (entry.submissionKind === "signed_raw") {
    if (entry.transactionHash === null || entry.signedTransaction === null) {
      throw new RelayJournalConflictError("signed-raw relay journal is missing exact transaction bytes");
    }
  } else if (entry.signedTransaction !== null) {
    throw new RelayJournalConflictError("injected-wallet relay journal cannot contain signed transaction bytes");
  }
  if (entry.phase === "broadcast_accepted" && entry.transactionHash === null) {
    throw new RelayJournalConflictError("accepted relay journal is missing its transaction hash");
  }
  if (entry.kind === "call") {
    requireStrings(entry, ["to", "value", "data"]);
    if (!hex(entry.to, 20) || !hex(entry.data)) {
      throw new RelayJournalConflictError("relay journal call request is invalid");
    }
    requireUnsigned(entry, ["value"]);
    return entry as unknown as RelayCallJournalEntry;
  }
  if (entry.kind !== "batch") throw new RelayJournalConflictError("relay journal kind is invalid");
  requireStrings(entry, ["batch", "collectibleOpenFee", "inboxAddress", "headCheckedBlock", "headCheckedBlockHash"]);
  if (entry.carrier !== "calldata" && entry.carrier !== "blobs") {
    throw new RelayJournalConflictError("relay journal carrier is invalid");
  }
  if (!hex(entry.batch) || !hex(entry.inboxAddress, 20)) {
    throw new RelayJournalConflictError("relay journal transaction request is invalid");
  }
  if (!hex(entry.headCheckedBlockHash, 32)) {
    throw new RelayJournalConflictError("relay journal block identity is invalid");
  }
  if (
    !Array.isArray(entry.selected)
    || entry.selected.length === 0
    || entry.selected.some((contentHash) => !hex(contentHash, 32))
  ) {
    throw new RelayJournalConflictError("relay journal selected content hashes are invalid");
  }
  if (
    !Array.isArray(entry.batchItemIndexes)
    || entry.batchItemIndexes.length !== entry.selected.length
    || entry.batchItemIndexes.some((index) => typeof index !== "string" || !UNSIGNED.test(index))
    || new Set(entry.batchItemIndexes).size !== entry.batchItemIndexes.length
  ) {
    throw new RelayJournalConflictError("relay journal batch item indexes are invalid");
  }
  if (entry.observationMode !== "selected" && entry.observationMode !== "batch") {
    throw new RelayJournalConflictError("relay journal observation mode is invalid");
  }
  if (entry.maxFeePerBlobGas !== null && (typeof entry.maxFeePerBlobGas !== "string" || !UNSIGNED.test(entry.maxFeePerBlobGas))) {
    throw new RelayJournalConflictError("relay journal maxFeePerBlobGas is not an unsigned integer");
  }
  requireUnsigned(entry, ["collectibleOpenFee", "headCheckedBlock"]);
  return entry as unknown as RelayBatchJournalEntry;
}

/** The batch entries among a journal's in-flight transactions. */
export function batchEntries(entries: readonly RelayJournalEntry[]): RelayBatchJournalEntry[] {
  return entries.filter((entry): entry is RelayBatchJournalEntry => entry.kind === "batch");
}

/** The in-flight batch entry that carries `contentHash`, if any. */
export function batchEntryCarrying(
  entries: readonly RelayJournalEntry[],
  contentHash: string,
): RelayBatchJournalEntry | undefined {
  return batchEntries(entries).find((entry) => entry.selected.some((selected) => sameId(selected, contentHash)));
}
