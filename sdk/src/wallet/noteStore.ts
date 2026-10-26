import type { StoredTransactionData } from "@pcash/sdk/delivery";
import type { BulkJob, BulkRecoveryObservation } from "./bulkJobs.ts";
import { PRIVATE_VALUE_PROFILES } from "@pcash/sdk/constants";
// PCASH note inventory — pure logic.
//
// The note-selection, scan-range, rebuild, spent-flag, and pending
// transfer/note bookkeeping that operates on an in-memory wallet inventory, with NO
// node: I/O so it is consumable from a browser. Persistence lives in platform
// store adapters, while CLI and browser consumers share this logic. Note secrets
// live only in wallet persistence and are never printed.

import { maxSpendable, selectNotes } from "./coinSelect.ts";
import { decodeDirectSendOpening, directSendOutputKey, type AssetDefinition, type PayoutComponent, type PayoutSourceKind } from "@pcash/sdk/protocol";
import { numberToHex } from "viem";
import { fixedHex, fromHex, sameHex, toHex } from "@pcash/sdk/utils";
import { fieldToHex } from "@pcash/sdk/crypto";

/** Account fee sections and default balance presentation use S. */
const MAX_TRANSFER_INPUTS = PRIVATE_VALUE_PROFILES.S.inputs;

/** The source and value component of one system payout note. */
interface NotePayout {
  sourceKind: PayoutSourceKind;
  component: PayoutComponent;
}

/** Canonical PCASH position at which a recovered note was delivered. */
interface NoteCursor {
  kind: "ordinary" | "system";
  /** The payout this system note settled, or null for an ordinary envelope. */
  payout: NotePayout | null;
  blockNumber: string;
  blockHash: string;
  /** Decimal seconds: the block header's timestamp. */
  blockTimestamp: string;
  transactionId: string | null;
  outputIndex: string;
}

/** One note the wallet controls. All scalars are decimal (amounts, indexes) or
 *  0x-hex (owner address, note secret, commitment) strings for stable JSON. */
export interface WalletNote {
  /** Absolute output-commitment tree leaf index (decimal), or null while pending. */
  leafIndex: string | null;
  outputIndex: number;
  /** Field-encoded asset identifier; zero is native PCASH. */
  assetId: string;
  amount: string;
  owner: string;
  noteSecret: string;
  /** Full note commitment (0x-hex), or null while pending (leaf not yet assigned). */
  commitment: string | null;
  /** Nullifier spent on-chain (recomputed from the node at scan time). */
  spent: boolean;
  /** Locally-expected but not yet observed on the canonical feed (e.g. change). */
  pending: boolean;
  /** Exact transaction that is expected to create this pending output. */
  pendingContentHash?: string;
  cursor?: NoteCursor;
  /** Memo bytes (0x-hex) the sender wrote into this note. Absent when it wrote none. */
  memo?: string;
  /** Address (0x-hex) the sender wrote as its own. Unauthenticated. */
  sender?: string;
}

/** Application records in a sender region, with 0x-hex data. */
export type StoredSenderRecords = Array<{ schema: string; data: string }>;

/** One output of this wallet's own transaction, reopened through the sender region it wrote. */
export interface StoredSentOutput {
  noteSecret: string;
  assetDefinition?: string;
  transactionId: string;
  /** Keccak-256 of the exact canonical transaction bytes. */
  contentHash: string;
  /** Private-value profile that created the output; null for account transactions. */
  privateValueShape: 0 | 1 | null;
  /** Output slot within the transaction. */
  slot: number;
  /** Absolute output-tree index (decimal). */
  leafIndex: string;
  recipientAddress: string;
  assetId: string;
  amount: string;
  /** Memo bytes (0x-hex) delivered to the recipient. */
  memo?: string;
  /** The recipient's note named this wallet as its sender. */
  senderIncluded: boolean;
  /** A direct send: this wallet delivers the opening to its owner by link. */
  directSend?: true;
  /** The transaction's sender-region application records, repeated on each output it sent. */
  senderRecords?: StoredSenderRecords;
  blockNumber: string;
  blockHash: string;
  blockTimestamp: string;
}

/** Static node identity copied from `pcash_status` and bound to one wallet database. */
export interface WalletNetworkIdentity {
  /** Decimal PCASH chain id. */
  chainId: string;
  genesisHash: string;
}

export interface WalletNetworkIdentityLike {
  chainId: bigint | number | string;
  genesisHash: string;
}

export interface WalletSyncBoundary {
  blockNumber: string;
  blockHash: string;
}

/** One locally-owned receive key. Entries are append-only across account
 * rotations and clears so a genesis rescan can decrypt every prior delivery. */
export interface StoredReceiveKeyPair {
  receiveKeyHash: string;
  mlKemPublicKey: string;
  mlKemSecretKey: string;
}

/** Durable transfer journal written before a transfer can reach an external relayer. It
 * reserves the inputs until their nullifiers show consumed on chain or
 * finalized chain time passes the deadline. A skipped inclusion alone is not
 * terminal. */
export interface PendingNoteFundedTransfer {
  kind: "mine" | "payment";
  contentHash: string;
  transactionHex: string;
  notBeforeTimestamp: string;
  validUntilTimestamp: string;
  transferAmount: string;
  openFeeAmount: string;
  privateRelayFeeAmount: string;
  privateRelayRecipient: string | null;
  issuanceOwnerCommitment: string;
  /** The authenticated selected issuance recipient, or null on the open
   *  route. A retry reviews and reports this saved destination. */
  issuanceRecipient: string | null;
  /** Original address or receive code used to resolve delivery. Retry identity
   *  compares this exact user-supplied target. */
  recipient: string;
  /** Canonical resolved 20-byte recipient address for wallet presentation. */
  recipientAddress: string;
  data?: StoredTransactionData;
  /** The real inputs reserved by this transfer. A consumed nullifier resolves the
   *  action and identifies the local note that must be marked spent. */
  inputs: {
    nullifier: string;
    /** Null for a note-free input slot. */
    spentCommitment: string | null;
  }[];
  change: {
    amount: string;
    owner: string;
    noteSecret: string;
  } | null;
  /** A direct send's slot-0 note secret, until scanning recovers it from the sender region. */
  directSendNoteSecret?: string;
  /** The Ethereum transaction carrying these exact bytes, once the connected
   *  wallet returned its hash. Absent while the transfer awaits approval. */
  l1TxHash?: string;
}

/** Completed outgoing payments, retained independently of spend reservations. */
export interface StoredPaymentHistory {
  kind: "mine" | "payment";
  contentHash: string;
  recipient: string;
  recipientAddress: string;
  data?: StoredTransactionData;
  transferAmount: string;
  openFeeAmount: string;
  privateRelayFeeAmount: string;
  privateRelayRecipient: string | null;
  validUntilTimestamp: string;
  /** Local time when synchronization observed the terminal result. */
  resolvedAtUnixMs: string;
  state: "succeeded" | "expired" | "conflicted";
  /** The canonical inclusion that consumed the payment's inputs. */
  receipt?: { transactionId: string; pcashBlockNumber: string; pcashBlockHash: string };
}

/** Durable standard asset action. Exact transaction bytes and all profile-selected public
 * nullifiers are retained before admission. Locally opened outputs are kept so
 * scanning can replace them with their canonical leaf assignments. */
export interface PendingAssetAction {
  contentHash: string;
  transactionHex: string;
  assetId: string;
  owner: string | null;
  notBeforeTimestamp: string;
  validUntilTimestamp: string;
  openFeeAmount: string;
  privateRelayFeeAmount?: string;
  privateRelayRecipient?: string;
  /** Present only for standard asset creation; binds an explicit exact-byte retry to reviewed terms. */
  assetCreationReview?: { metadataCommitment: string; initialSupply: string };
  /** Present only for a wallet asset payment or burn; binds an explicit exact-byte retry to reviewed terms. */
  assetTransferReview?: {
    /** Recipients as requested, in output-slot order. */
    outputs: Array<{ to: string; amount: string; noteSecret?: string }>;
    burnAmount: string;
    /** Application records the caller wrote to this wallet's sender region. */
    data?: StoredTransactionData;
  };
  /** Recipient selected for a claim-link spend; checked before resubmitting saved bytes. */
  claimLinkRecipient?: string;
  issuanceOwnerCommitment: string;
  /** The authenticated selected issuance recipient; absent on the open
   *  route. A resumed action reports this saved destination. */
  issuanceRecipient?: string;
  inputs: Array<{
    nullifier: string;
    spentCommitment: string | null;
  }>;
  ownedOutputs: Array<{
    outputIndex: number;
    assetId: string;
    amount: string;
    owner: string;
    noteSecret: string;
  }>;
}

/** A standard asset this wallet can identify. Only a definition verified against
 * `assetId` is recorded: delivered ones come from senders, imported ones from users. */
interface WalletAssetRecord {
  assetId: string;
  definition: {
    /** Decimal. */
    initialSupply: string;
    assetSecretCommitment: string;
    name: string;
    symbol: string;
    decimals: number;
    contentDigest: string;
  };
  /** Present only for an asset this wallet created. */
  assetSecret?: string;
}

/** Exact type-0x03 bytes retained until the account advances, the transaction
 * settles canonically, or its deadline expires. The current revision is the
 * conflict key for one address. */
export interface PendingUserAccountUpdate {
  contentHash: string;
  transactionHex: string;
  address: string;
  currentAccountRevision: string;
  newRuleSetCommitment: string;
  receiveKeyOperation: "keep" | "clear" | "replace";
  /** Zero when the update leaves the account without a receive key. */
  newReceiveKeyHash: string;
  validUntilTimestamp: string;
  openFeeAmount: string;
  privateRelayFeeAmount: string;
  privateRelayRecipient: string | null;
  issuanceOwnerCommitment: string;
  /** The authenticated selected issuance recipient, or null on the open
   *  route. A retry reports this saved destination. */
  issuanceRecipient: string | null;
  /** The account's own notes the fee spends; empty for a zero-fee update. */
  inputs: {
    nullifier: string;
    spentCommitment: string;
  }[];
  change: {
    amount: string;
    owner: string;
    noteSecret: string;
  } | null;
}

/** Exact standalone creation or attached setup action retained before submission. */
export interface PendingUserAccountCreation {
  contentHash: string;
  publication: "self" | "open";
  transactionHex: string;
  address: string;
  pcashChainId: string;
  pcashGenesisHash: string;
  l1ChainId: string;
  inboxAddress: string;
  genesisL1Block: string;
  genesisL1BlockHash: string;
  ruleSetCommitment: string;
  receiveKeyHash: string;
  recentPcashBlockNumber: string;
  recentPcashBlockHash: string;
  validUntilTimestamp: string;
  state: "prepared" | "mempool-submitted" | "broadcast-requested" | "l1-submitted";
  l1TxHash: string | null;
  preparedAtUnixMs: string;
}

/** Exact browser-produced transaction bytes retained until the corresponding
 * wallet action reaches canonical settlement or expiry.
 * `prepared` means the durable write completed before the admission call;
 * `admitted` means the configured node acknowledged the exact transaction. */
export interface MempoolOutboxEntry {
  contentHash: string;
  transactionHex: string;
  kind: "noteFundedTransfer" | "assetAction" | "userAccountUpdate";
  state: "prepared" | "admitted";
  createdAtUnixMs: string;
}

/** A short-lived durable claim held while work runs outside a transaction. */
export interface WalletResourceReservation {
  reservationId: string;
  resources: string[];
  createdAtUnixMs: string;
  heartbeatAtUnixMs: string;
  expiresAtUnixMs: string;
}

/** Canonical transaction data retained independently of spendable notes. */
export interface StoredTransactionRecords {
  transactionId: string;
  contentHash: string;
  leafIndex: string;
  blockNumber: string;
  blockHash: string;
  timestamp: string;
  received: { slot: number; records: StoredSenderRecords }[];
  sent: { slot: number; to: string; records: StoredSenderRecords }[];
  self: StoredSenderRecords;
  /** Application records this wallet published in the transaction's public segment. */
  public: StoredSenderRecords;
}

/** A direct send this wallet owns, imported from its link or read back from the wallet's own record. */
export interface StoredDirectSendOpening {
  /** The encoded opening (0x-hex). */
  opening: string;
  /** The canonical transaction whose sender region records this opening, while one is known. */
  record?: { leafIndex: string; blockNumber: string; blockHash: string };
}

export interface WalletFileData {
  /** Cancels setup work already signing or proving in another browser tab. */
  accountActivationRevision?: string;
  /** The address of the wallet account this file belongs to (0x-hex). */
  address: string;
  /** Immutable chain/genesis identity. A file is never silently rebound. */
  network: WalletNetworkIdentity;
  /** Durable append-only receive-key keyring. Canonical account state selects
   * which public key is advertised; reorgs do not remove local secrets. */
  receiveKeys: StoredReceiveKeyPair[];
  /** A newly retained historical key must be replayed from genesis before an
   * incremental cursor is safe again. Cleared atomically by a full rescan. */
  fullRescanRequired?: true;
  notes: WalletNote[];
  /** First output-tree index not yet examined by the dense output scan. */
  nextOutputIndex?: string;
  /** First output covered by this inventory; zero means full history. */
  historyStartOutputIndex?: string;
  /** Changes when history is rebuilt, including a canonical reorg. */
  historyRevision?: string;
  /** Canonical block against which `nextOutputIndex` was established. */
  syncedThrough?: WalletSyncBoundary;
  /** Finalized head observed during the most recent synchronization. */
  finalizedThrough?: WalletSyncBoundary;
  pendingNoteFundedTransfers?: PendingNoteFundedTransfer[];
  paymentHistory?: StoredPaymentHistory[];
  sentOutputs?: StoredSentOutput[];
  transactionRecords?: StoredTransactionRecords[];
  /** Notes without an envelope, which scanning cannot find: it matches their funding outputs instead. */
  directSendOpenings?: StoredDirectSendOpening[];
  pendingAssetActions?: PendingAssetAction[];
  bulkJobs?: BulkJob[];
  /** First/current canonical observation of each recoverable bulk-job chunk set. */
  bulkRecoveryObservations?: BulkRecoveryObservation[];
  assets?: WalletAssetRecord[];
  pendingUserAccountCreations?: PendingUserAccountCreation[];
  pendingUserAccountUpdates?: PendingUserAccountUpdate[];
  mempoolOutbox?: MempoolOutboxEntry[];
  resourceReservations?: WalletResourceReservation[];
}

export type WalletArrayField = Exclude<{
  [K in keyof WalletFileData]: WalletFileData[K] extends readonly unknown[] | undefined ? K : never
}[keyof WalletFileData], undefined>;

/**
 * The durable identity of one entry in each keyed section. Two entries sharing a
 * key are the same thing, so a document never holds both, and `store.ts` merges
 * concurrent edits by these keys. Sections absent here have no entry identity:
 * `resourceReservations` leases are replaced wholesale, never merged.
 */
export const WALLET_SECTION_KEYS: Partial<Record<WalletArrayField, (value: never) => string>> = {
  bulkJobs: (value) => (value as BulkJob).jobId,
  bulkRecoveryObservations: (value) => (value as BulkRecoveryObservation).recoveryJobId,
  assets: (value) => (value as WalletAssetRecord).assetId.toLowerCase(),
  receiveKeys: (value) => (value as WalletFileData["receiveKeys"][number]).receiveKeyHash.toLowerCase(),
  notes: (value) => {
    const note = value as WalletFileData["notes"][number];
    return note.pending
      ? `pending:${note.pendingContentHash!.toLowerCase()}:${note.outputIndex}`
      : `confirmed:${note.commitment!.toLowerCase()}`;
  },
  paymentHistory: (value) => (value as StoredPaymentHistory).contentHash.toLowerCase(),
  transactionRecords: (value) => (value as StoredTransactionRecords).transactionId.toLowerCase(),
  directSendOpenings: (value) => directSendOutputKey(decodeDirectSendOpening(fromHex((value as StoredDirectSendOpening).opening))),
  sentOutputs: (value) => {
    const output = value as StoredSentOutput;
    return `${output.transactionId.toLowerCase()}:${output.slot}`;
  },
  pendingNoteFundedTransfers: (value) =>
    (value as NonNullable<WalletFileData["pendingNoteFundedTransfers"]>[number]).contentHash.toLowerCase(),
  pendingAssetActions: (value) =>
    (value as NonNullable<WalletFileData["pendingAssetActions"]>[number]).contentHash.toLowerCase(),
  pendingUserAccountCreations: (value) =>
    (value as NonNullable<WalletFileData["pendingUserAccountCreations"]>[number]).address.toLowerCase(),
  pendingUserAccountUpdates: (value) =>
    (value as NonNullable<WalletFileData["pendingUserAccountUpdates"]>[number]).address.toLowerCase(),
  mempoolOutbox: (value) =>
    (value as NonNullable<WalletFileData["mempoolOutbox"]>[number]).contentHash.toLowerCase(),
};

function pendingNoteIdentity(note: Pick<WalletNote, "pendingContentHash" | "outputIndex">): string {
  if (note.pendingContentHash === undefined) throw new Error("pending note is missing pendingContentHash");
  return `${note.pendingContentHash.toLowerCase()}:${note.outputIndex}`;
}

function recoveredNoteIdentity(note: WalletNote): string | null {
  if (note.cursor === undefined || note.cursor.kind !== "ordinary" || note.cursor.transactionId === null) return null;
  return `${note.cursor.transactionId.toLowerCase()}:${Number(note.cursor.outputIndex)}`;
}

function sameNoteOpening(left: WalletNote, right: WalletNote): boolean {
  return left.outputIndex === right.outputIndex
    && BigInt(left.assetId) === BigInt(right.assetId)
    && BigInt(left.amount) === BigInt(right.amount)
    && BigInt(left.owner) === BigInt(right.owner)
    && BigInt(left.noteSecret) === BigInt(right.noteSecret);
}

export function assertPendingAssetActionBelongsToWallet(
  data: WalletFileData,
  pending: PendingAssetAction,
): void {
  const address = BigInt(data.address);
  if (pending.owner !== null && BigInt(pending.owner) !== address) {
    throw new Error("asset action input owner does not match this wallet");
  }
  for (const output of pending.ownedOutputs) {
    if (BigInt(output.owner) !== address) {
      throw new Error(`owned output ${output.outputIndex} belongs to another owner`);
    }
  }
}

export function removePendingNotesForTransaction(data: WalletFileData, contentHash: string): void {
  const target = contentHash.toLowerCase();
  data.notes = data.notes.filter((note) =>
    !(note.pending && note.pendingContentHash?.toLowerCase() === target)
  );
}

export function addPendingNoteFundedTransfer(data: WalletFileData, pending: PendingNoteFundedTransfer): void {
  const list = data.pendingNoteFundedTransfers ?? (data.pendingNoteFundedTransfers = []);
  const existing = list.find((transfer) => transfer.contentHash.toLowerCase() === pending.contentHash.toLowerCase());
  if (existing !== undefined) return;
  const reserved = reservedNoteNullifiers(data);
  const conflict = pending.inputs.find((input) => reserved.has(BigInt(input.nullifier).toString()));
  if (conflict !== undefined) {
    throw new Error(`note nullifier ${conflict.nullifier} is already reserved by another pending transfer`);
  }
  list.push(pending);
}

/**
 * Drop the journal rows a predicate matches, and the empty array with them.
 *
 * Every pending list is optional in the document, so "no rows" must be an
 * absent key rather than `[]`.
 */
type JournalField =
  | "pendingNoteFundedTransfers"
  | "pendingAssetActions"
  | "pendingUserAccountCreations"
  | "pendingUserAccountUpdates"
  | "mempoolOutbox";

function removeJournalRows<Row>(
  data: WalletFileData,
  field: JournalField,
  matches: (row: Row) => boolean,
): void {
  const list = data[field] as Row[] | undefined;
  if (list === undefined) return;
  const kept = list.filter((row) => !matches(row));
  if (kept.length === 0) delete data[field];
  else (data[field] as unknown) = kept;
}

/**
 * Every transaction nullifier already reserved by a pending note-funded
 * transfer or asset action. A raw-nullifier collision conflicts regardless of
 * for an ordinary note input.
 */
function reservedNoteNullifiers(data: WalletFileData): Set<string> {
  return new Set([
    ...(data.pendingNoteFundedTransfers ?? []).flatMap((transfer) =>
      transfer.inputs.map((input) => BigInt(input.nullifier).toString())
    ),
    ...(data.pendingAssetActions ?? []).flatMap((action) =>
      action.inputs.map((input) => BigInt(input.nullifier).toString())
    ),
    ...(data.pendingUserAccountUpdates ?? []).flatMap((update) =>
      update.inputs.map((input) => BigInt(input.nullifier).toString())
    ),
  ]);
}

/** Commitments every pending action has reserved as inputs. */
export function reservedNoteCommitments(data: WalletFileData): Set<string> {
  return new Set(
    [
      ...(data.pendingNoteFundedTransfers ?? [])
        .flatMap((p) => p.inputs.map((input) => input.spentCommitment))
        .filter((commitment): commitment is string => commitment !== null),
      ...(data.pendingAssetActions ?? [])
        .flatMap((action) => action.inputs.map((input) => input.spentCommitment))
        .filter((commitment): commitment is string => commitment !== null),
      ...(data.pendingUserAccountUpdates ?? [])
        .flatMap((update) => update.inputs.map((input) => input.spentCommitment)),
    ].map((c) => BigInt(c).toString()),
  );
}

export function removePendingNoteFundedTransfer(data: WalletFileData, contentHash: string): void {
  removeJournalRows<PendingNoteFundedTransfer>(data, "pendingNoteFundedTransfers", (row) => sameHex(row.contentHash, contentHash));
}

/** Record the Ethereum transaction that carries a journaled transfer; false once it has been retired. */
export function markPendingNoteFundedTransferL1Submitted(data: WalletFileData, contentHash: string, l1TxHash: string): boolean {
  const transfer = data.pendingNoteFundedTransfers?.find((row) => sameHex(row.contentHash, contentHash));
  if (transfer !== undefined) transfer.l1TxHash = fixedHex(l1TxHash, 32, "l1TxHash");
  return transfer !== undefined;
}

/** Setup mining of a pending activation that no Ethereum transaction has carried yet. */
export function unsentSetupMining(data: WalletFileData, transfer: PendingNoteFundedTransfer): boolean {
  return transfer.l1TxHash === undefined && (data.pendingUserAccountCreations ?? [])
    .some((creation) => sameHex(creation.transactionHex, transfer.transactionHex));
}

/** Reserve every private input nullifier for one exact asset action. */
export function addPendingAssetAction(data: WalletFileData, pending: PendingAssetAction): void {
  assertPendingAssetActionBelongsToWallet(data, pending);
  const list = data.pendingAssetActions ?? (data.pendingAssetActions = []);
  const existing = list.find((action) => action.contentHash.toLowerCase() === pending.contentHash.toLowerCase());
  if (existing !== undefined) return;
  const reserved = reservedNoteNullifiers(data);
  const conflict = pending.inputs.find((input) => reserved.has(BigInt(input.nullifier).toString()));
  if (conflict !== undefined) {
    throw new Error(`nullifier ${conflict.nullifier} is already reserved by another pending action`);
  }
  list.push(pending);
}

export function removePendingAssetAction(data: WalletFileData, contentHash: string): void {
  removeJournalRows<PendingAssetAction>(data, "pendingAssetActions", (row) => sameHex(row.contentHash, contentHash));
}

export function pendingUserAccountCreation(
  data: WalletFileData | null,
  address: string,
): PendingUserAccountCreation | null {
  const target = address.toLowerCase();
  return data?.pendingUserAccountCreations?.find((pending) => pending.address.toLowerCase() === target) ?? null;
}

export function addPendingUserAccountCreation(
  data: WalletFileData,
  pending: PendingUserAccountCreation,
): void {
  const list = data.pendingUserAccountCreations ?? (data.pendingUserAccountCreations = []);
  const existing = list.find((creation) => creation.address.toLowerCase() === pending.address.toLowerCase());
  if (existing !== undefined) {
    if (
      existing.contentHash.toLowerCase() === pending.contentHash.toLowerCase()
      && existing.transactionHex.toLowerCase() === pending.transactionHex.toLowerCase()
    ) return;
    throw new Error(`user account ${pending.address} already has an unresolved creation`);
  }
  list.push(pending);
}

/** The setup mining transfer carried in the activation's Ethereum transaction. */
function setupMiningTransfer(data: WalletFileData, creation: PendingUserAccountCreation): PendingNoteFundedTransfer | undefined {
  return data.pendingNoteFundedTransfers?.find((transfer) => sameHex(transfer.transactionHex, creation.transactionHex));
}

export function markPendingUserAccountCreationBroadcastRequested(
  data: WalletFileData,
  address: string,
): void {
  const pending = pendingUserAccountCreation(data, address);
  if (pending === null) throw new Error(`user account ${address} has no prepared creation`);
  if (pending.state !== "prepared") throw new Error(`user account ${address} activation is already being submitted`);
  pending.state = "broadcast-requested";
  pending.l1TxHash = null;
}

export function markPendingUserAccountCreationPrepared(
  data: WalletFileData,
  address: string,
): void {
  const pending = pendingUserAccountCreation(data, address);
  if (pending === null) throw new Error(`user account ${address} has no prepared creation`);
  pending.state = "prepared";
  pending.l1TxHash = null;
}

export function markPendingUserAccountCreationSubmitted(
  data: WalletFileData,
  address: string,
  l1TxHash: string,
): void {
  const pending = pendingUserAccountCreation(data, address);
  if (pending === null) throw new Error(`user account ${address} has no prepared creation`);
  pending.state = "l1-submitted";
  pending.l1TxHash = fixedHex(l1TxHash, 32, "l1TxHash");
  // The setup mining rides in the same Ethereum transaction. Its hash stays
  // when the activation is reset: that transaction did carry it.
  const mining = setupMiningTransfer(data, pending);
  if (mining !== undefined) mining.l1TxHash = pending.l1TxHash;
}

/**
 * Remove an activation. Setup mining that never reached Ethereum is removed
 * with it; once broadcast, the mine settles or expires on its own nullifiers.
 */
export function removePendingUserAccountCreation(data: WalletFileData, address: string): void {
  data.accountActivationRevision = (BigInt(data.accountActivationRevision ?? "0") + 1n).toString();
  const pending = pendingUserAccountCreation(data, address);
  if (pending === null) return;
  const mining = setupMiningTransfer(data, pending);
  if (mining !== undefined && mining.l1TxHash === undefined) removePendingNoteFundedTransfer(data, mining.contentHash);
  removeJournalRows<PendingUserAccountCreation>(
    data,
    "pendingUserAccountCreations",
    (row) => sameHex(row.address, address),
  );
}

export function addPendingUserAccountUpdate(
  data: WalletFileData,
  pending: PendingUserAccountUpdate,
): void {
  const list = data.pendingUserAccountUpdates ?? (data.pendingUserAccountUpdates = []);
  const existing = list.find((update) => update.address.toLowerCase() === pending.address.toLowerCase());
  if (existing !== undefined) {
    if (
      existing.contentHash.toLowerCase() === pending.contentHash.toLowerCase()
      && existing.transactionHex.toLowerCase() === pending.transactionHex.toLowerCase()
    ) return;
    throw new Error(`user account ${pending.address} already has an unresolved update ${existing.contentHash}`);
  }
  const reserved = reservedNoteNullifiers(data);
  const conflict = pending.inputs.find((input) => reserved.has(BigInt(input.nullifier).toString()));
  if (conflict !== undefined) {
    throw new Error(`note nullifier ${conflict.nullifier} is already reserved by another pending action`);
  }
  list.push(pending);
}

export function removePendingUserAccountUpdate(data: WalletFileData, address: string): void {
  removeJournalRows<PendingUserAccountUpdate>(data, "pendingUserAccountUpdates", (row) => sameHex(row.address, address));
}

/** Add exact prepared bytes idempotently. Reusing a contentHash for different bytes or
 * action metadata is a corrupt local journal and fails closed. */
export function addMempoolOutboxEntry(data: WalletFileData, entry: MempoolOutboxEntry): void {
  const list = data.mempoolOutbox ?? (data.mempoolOutbox = []);
  const existing = list.find((item) => item.contentHash.toLowerCase() === entry.contentHash.toLowerCase());
  if (existing) {
    if (
      existing.transactionHex.toLowerCase() !== entry.transactionHex.toLowerCase()
      || existing.kind !== entry.kind
    ) {
      throw new Error(`mempool outbox transaction ${entry.contentHash} has conflicting exact bytes or kind`);
    }
    return;
  }
  list.push(entry);
}

export function markMempoolOutboxAdmitted(data: WalletFileData, contentHash: string): void {
  const entry = data.mempoolOutbox?.find((item) => item.contentHash.toLowerCase() === contentHash.toLowerCase());
  if (!entry) throw new Error(`mempool outbox transaction ${contentHash} is missing`);
  entry.state = "admitted";
}

export function removeMempoolOutboxEntry(data: WalletFileData, contentHash: string): void {
  removeJournalRows<MempoolOutboxEntry>(data, "mempoolOutbox", (row) => sameHex(row.contentHash, contentHash));
}

export function walletAssetRecord(data: WalletFileData | null, assetId: bigint): WalletAssetRecord | undefined {
  return data?.assets?.find((asset) => BigInt(asset.assetId) === assetId);
}

export function storedAssetDefinition(record: WalletAssetRecord): AssetDefinition {
  const { definition } = record;
  return {
    initialSupply: BigInt(definition.initialSupply),
    assetSecretCommitment: BigInt(definition.assetSecretCommitment),
    metadata: {
      name: definition.name,
      symbol: definition.symbol,
      decimals: definition.decimals,
      contentDigest: fromHex(definition.contentDigest),
    },
  };
}

export function knownAssetDefinition(data: WalletFileData | null, assetId: bigint): AssetDefinition | undefined {
  const record = walletAssetRecord(data, assetId);
  return record === undefined ? undefined : storedAssetDefinition(record);
}

/**
 * Record a definition the caller verified against `assetId`. An existing record
 * is kept, gaining the asset secret when this wallet created the asset.
 * Returns whether a new record was inserted.
 */
export function addWalletAsset(
  data: WalletFileData,
  asset: { assetId: bigint; definition: AssetDefinition; assetSecret?: bigint },
): boolean {
  const existing = walletAssetRecord(data, asset.assetId);
  if (existing !== undefined) {
    if (asset.assetSecret !== undefined) existing.assetSecret = fieldToHex(asset.assetSecret);
    return false;
  }
  const { metadata } = asset.definition;
  (data.assets ??= []).push({
    assetId: fieldToHex(asset.assetId),
    definition: {
      initialSupply: asset.definition.initialSupply.toString(),
      assetSecretCommitment: fieldToHex(asset.definition.assetSecretCommitment),
      name: metadata.name,
      symbol: metadata.symbol,
      decimals: metadata.decimals,
      contentDigest: toHex(metadata.contentDigest),
    },
    ...(asset.assetSecret === undefined ? {} : { assetSecret: fieldToHex(asset.assetSecret) }),
  });
  return true;
}

export function removeWalletAsset(data: WalletFileData, assetId: bigint): void {
  const kept = (data.assets ?? []).filter((asset) => BigInt(asset.assetId) !== assetId);
  if (kept.length === 0) delete data.assets;
  else data.assets = kept;
}

/** A note that can currently be spent: not spent, not pending, fully assigned,
 * and not reserved by a pending action. `reserved` is `reservedNoteCommitments`. */
export function noteIsSpendable(note: WalletNote, reserved: ReadonlySet<string>): boolean {
  return !note.spent
    && !note.pending
    && note.leafIndex !== null
    && note.commitment !== null
    && BigInt(note.amount) > 0n
    && !reserved.has(BigInt(note.commitment).toString());
}

export function spendableNotes(data: WalletFileData, assetId?: bigint): WalletNote[] {
  const reserved = reservedNoteCommitments(data);
  return data.notes.filter(
    (n) => (assetId === undefined || BigInt(n.assetId) === assetId) && noteIsSpendable(n, reserved),
  );
}

/**
 * Select an input note. With `selector` (a 0x-hex commitment or a decimal array
 * index) the exact note is returned; otherwise the largest spendable note that
 * covers `need` is chosen (largest-first). Throws when nothing qualifies.
 */
/** Total private native balance: every unspent, non-pending native note. */
export function privateBalance(data: WalletFileData | null, assetId = 0n): bigint {
  if (data === null) return 0n;
  return data.notes
    .filter((note) => !note.spent && !note.pending && BigInt(note.assetId) === assetId)
    .reduce((total, note) => total + BigInt(note.amount), 0n);
}

/** Immediately spendable balance: excludes notes a pending transfer reserved. */
export function spendableBalance(data: WalletFileData | null, assetId = 0n): bigint {
  if (data === null) return 0n;
  return spendableNotes(data, assetId).reduce((total, note) => total + BigInt(note.amount), 0n);
}

type NoteStatus = "spendable" | "pending" | "spent";

/** Per-note display status. A note a pending transfer reserved reads as pending. */
export function noteStatus(data: WalletFileData, note: WalletNote, reserved = reservedNoteCommitments(data)): NoteStatus {
  if (note.spent) return "spent";
  if (note.pending || note.leafIndex === null || note.commitment === null) return "pending";
  return reserved.has(BigInt(note.commitment).toString()) ? "pending" : "spendable";
}

function selectInputNote(
  data: WalletFileData,
  selector: string | undefined,
  need: bigint,
  assetId = 0n,
): WalletNote {
  const spendable = spendableNotes(data, assetId);
  if (selector !== undefined) {
    let note: WalletNote | undefined;
    if (/^0x[0-9a-fA-F]+$/.test(selector)) {
      const target = BigInt(selector);
      note = spendable.find((n) => n.commitment !== null && BigInt(n.commitment) === target);
    } else if (/^\d+$/.test(selector)) {
      note = data.notes[Number(selector)];
      if (note && (note.spent || note.pending || note.leafIndex === null || note.commitment === null)) {
        throw new Error(`--note ${selector} refers to a spent/pending note`);
      }
    } else {
      throw new Error(`--note must be a 0x commitment or a note index, got "${selector}"`);
    }
    if (!note) throw new Error(`no spendable note matches --note ${selector}`);
    if (BigInt(note.assetId) !== assetId) {
      throw new Error(`selected note has asset ${note.assetId}; expected ${numberToHex(assetId)}`);
    }
    if (BigInt(note.amount) < need) {
      const total = BigInt(note.amount);
      throw new InsufficientNotesError({ need, maximumTransfer: total, totalBalance: total, maxInputs: 1, outputCount: 1 });
    }
    return note;
  }
  const covering = spendable
    .filter((n) => BigInt(n.amount) >= need)
    .sort((a, b) => (BigInt(b.amount) > BigInt(a.amount) ? 1 : -1));
  if (covering.length === 0) {
    const total = spendable.reduce((acc, n) => acc + BigInt(n.amount), 0n);
    throw new Error(`no single note covers ${need} (spendable balance ${total} across ${spendable.length} notes)`);
  }
  return covering[0]!;
}

/**
 * Select the input notes for a transfer. With an explicit `selector` a single named
 * note is used (it must cover `need` alone — an explicit choice is not silently
 * combined). Otherwise 1..`maxInputs` spendable notes are chosen to cover `need`
 * with the least overage, consolidating small notes when free (see coinSelect).
 * Throws when the best `maxInputs` notes still can't cover `need`.
 */
export class InsufficientNotesError extends Error {
  readonly need: bigint;
  readonly maximumTransfer: bigint;
  readonly totalBalance: bigint;
  readonly maxInputs: number;
  readonly outputCount: number;

  constructor(params: {
    need: bigint;
    maximumTransfer: bigint;
    totalBalance: bigint;
    maxInputs: number;
    outputCount: number;
  }) {
    super(
      `insufficient notes to cover ${params.need}: most spendable in one transfer is ${params.maximumTransfer} `
        + `(best ${params.maxInputs} of ${params.outputCount} notes; total balance ${params.totalBalance})`,
    );
    this.name = "InsufficientNotesError";
    this.need = params.need;
    this.maximumTransfer = params.maximumTransfer;
    this.totalBalance = params.totalBalance;
    this.maxInputs = params.maxInputs;
    this.outputCount = params.outputCount;
  }
}

export function selectInputNotes(
  data: WalletFileData,
  selector: string | undefined,
  need: bigint,
  maxInputs: number = MAX_TRANSFER_INPUTS,
  assetId = 0n,
): WalletNote[] {
  if (selector !== undefined) {
    const selectors = selector.split(",");
    if (selectors.length === 1) return [selectInputNote(data, selector, need, assetId)];
    if (selectors.length > maxInputs) throw new Error(`at most ${maxInputs} explicit input notes are allowed`);
    const notes = selectors.map((item) => selectInputNote(data, item.trim(), 1n, assetId));
    if (new Set(notes.map((note) => note.commitment)).size !== notes.length) throw new Error("duplicate explicit note selection");
    const total = notes.reduce((sum, note) => sum + BigInt(note.amount), 0n);
    if (total < need) {
      throw new InsufficientNotesError({ need, maximumTransfer: total, totalBalance: total,
        maxInputs: notes.length, outputCount: notes.length });
    }
    return notes;
  }
  return selectSpendableInputNotes(spendableNotes(data, assetId), need, maxInputs);
}

/** Select from a caller's already filtered spendable inventory. */
export function selectSpendableInputNotes(
  spendable: readonly WalletNote[],
  need: bigint,
  maxInputs: number = MAX_TRANSFER_INPUTS,
): WalletNote[] {
  const candidates = spendable.map((note) => ({ amount: BigInt(note.amount), note }));
  const picked = selectNotes(candidates, need, maxInputs);
  if (picked === null) {
    const total = candidates.reduce((sum, candidate) => sum + candidate.amount, 0n);
    const best = maxSpendable(candidates, maxInputs);
    throw new InsufficientNotesError({
      need,
      maximumTransfer: best,
      totalBalance: total,
      maxInputs,
      outputCount: spendable.length,
    });
  }
  return picked.selected.map((s) => s.note);
}

/** Append a locally-expected (pending) note — e.g. a transfer's change output. */
export function addPendingNote(
  data: WalletFileData,
  contentHash: string,
  note: { outputIndex: number; assetId: bigint; amount: bigint; owner: bigint; noteSecret: bigint },
): void {
  const pendingContentHash = fixedHex(contentHash, 32, "pendingContentHash");
  if (note.owner !== BigInt(data.address)) {
    throw new Error(`pending output ${note.outputIndex} belongs to another owner`);
  }
  const pending: WalletNote = {
    leafIndex: null,
    outputIndex: note.outputIndex,
    assetId: numberToHex(note.assetId),
    amount: note.amount.toString(),
    owner: numberToHex(note.owner),
    noteSecret: numberToHex(note.noteSecret),
    commitment: null,
    spent: false,
    pending: true,
    pendingContentHash,
  };
  const identity = pendingNoteIdentity(pending);
  const existing = data.notes.find((candidate) =>
    candidate.pending && pendingNoteIdentity(candidate) === identity
  );
  if (existing !== undefined) {
    if (sameNoteOpening(existing, pending)) return;
    throw new Error(`pending output ${pending.outputIndex} for ${pendingContentHash} has different note fields`);
  }
  data.notes.push(pending);
}

/** Merge decrypted canonical outputs and reconcile matching locally pending notes. */
export function mergeRecoveredWalletNotes(
  data: WalletFileData,
  fresh: WalletNote[],
): void {
  const existing = new Set(
    data.notes.flatMap((note) => note.commitment === null ? [] : [BigInt(note.commitment).toString()]),
  );
  const recovered = fresh.map((note) => {
    if (note.commitment === null) throw new Error("a recovered note must have a commitment");
    return { note, key: BigInt(note.commitment).toString() };
  });
  const pendingByIdentity = new Map(
    data.notes.flatMap((note, index) => note.pending
      ? [[pendingNoteIdentity(note), { note, index }] as const]
      : []),
  );
  const removedIndexes = new Set<number>();
  for (const { note } of recovered) {
    const identity = recoveredNoteIdentity(note);
    if (identity === null) continue;
    const pending = pendingByIdentity.get(identity);
    if (pending !== undefined) removedIndexes.add(pending.index);
  }
  data.notes = data.notes.filter((_note, index) => !removedIndexes.has(index));
  for (const { note, key } of recovered) {
    if (existing.has(key)) continue;
    existing.add(key);
    data.notes.push(note);
  }
}
