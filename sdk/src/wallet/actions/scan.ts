import { PRIVATE_VALUE_PROFILES, privateValueProfile, type PrivateValueShape } from "@pcash/sdk/constants";
// Dense private-output discovery. The node returns commitments ordered by
// output-tree index in whole transactions, each with the nullifiers it
// consumed and its arena; wallets trial-decrypt ordinary and system notes
// locally, open their records and the sender regions they wrote, and match
// their own nullifiers against the feed, so no request names a note they hold.

import {
  type FieldNumberish,
  toAddressField,
  toField,
  toNonnegativeBigInt,
} from "@pcash/sdk/crypto";
import {
  OutputOpeningMismatchError,
  pollReceipt,
  samePcashIdentity,
  statusPcashIdentity,
  type OutputResult,
  type PcashNodeClient,
  type StatusResult,
} from "@pcash/sdk/clients";
import {
  assetDefinitionAssetId,
  decodeDeliveryPayload,
  RECORD_SCHEMA,
  isBuiltinSchema,
  claimedSenderSchema,
  type DataRecord,
  decodeAssetDefinition,
  directSendOutputCommitment,
  directSendOutputKey,
  encodeAssetDefinition,
  openEnvelope,
  openSenderRecords,
  readPublicRecords,
  deliveryRecords,
  directSendRecords,
  noteAssetRecords,
  payoutSeed,
  recoverPayoutOpening,
  trialOpenEnvelope,
  ML_KEM_768_SECRET_KEY_LENGTH,
  noteBodyCommitment,
  outputCommitment,
  noteNk,
  nullifier,
  ownerCommitment,
  TX_KIND_PRIVATE_VALUE,
  TX_KIND_USER_ACCOUNT_UPDATE,
  type ArenaTransactionType,
  type AssetDefinition,
  type DirectSendOpening,
  type NotePayload,
  type OutputArena,
  type PayoutComponent,
  type PayoutSourceKind,
  type MlKemKeyPair,
  type WalletProfile,
  type WalletProfileWithReceiveKeys,
  networkConfigFromStatus,
} from "@pcash/sdk/protocol";
import { addressHex, bytes32Hex, fromHex, toHex } from "@pcash/sdk/utils";
import {
  genesisChainState,
  WalletChainState,
  WalletSyncRequiredError,
  type ChainBlock,
  type ChainCommit,
} from "../chainState.ts";
import type { WalletStateStore } from "../store.ts";
import {
  assertPcashProfileMatchesAccount,
  type PcashProfile,
  type PcashProfileAccountView,
} from "../externalIdentity.ts";
import {
  addWalletAsset,
  mergeRecoveredWalletNotes,
  type StoredSentOutput,
  type WalletFileData,
  type WalletNote,
} from "../noteStore.ts";
import {
  assertCurrentReceiveKeyOwned,
  receiveKeyPairs,
  retainWalletReceiveKey,
} from "../receiveKeyring.ts";
import { reconcileBulkRecoveryObservations } from "../bulkJobs.ts";
import { addDirectSendOpening, directSendNote, directSendOpenings, dropDirectSendRecords } from "../directSends.ts";

export interface SpendableNote {
  chainId: bigint;
  leafIndex: bigint;
  outputIndex: number;
  assetId: bigint;
  /** The note owner's address. */
  owner: bigint;
  noteSecret: bigint;
  amount: bigint;
  noteBodyCommitment: bigint;
  outputCommitment: bigint;
  memo: Uint8Array;
  /** Opaque application data retained for application-level recovery. */
  applicationRecords?: readonly DataRecord[];
  /** Address the sender wrote as its own. Unauthenticated. */
  sender?: bigint;
  /** Delivered with the note and already verified against its assetId. */
  assetDefinition?: AssetDefinition;
}

/** A system note's payout source and one tagged value component. */
interface ScanPayout {
  sourceKind: PayoutSourceKind;
  component: PayoutComponent;
  amount: bigint;
  ownerCommitment: bigint;
  contexts: readonly bigint[];
}

/** System notes have no envelope slot; recovered ones share this synthetic output index. */
export const SYSTEM_NOTE_OUTPUT_INDEX = 5;

/** The arena and ordered nullifiers of the section an ordinary output belongs to. */
export interface ScanArena {
  arena: Uint8Array;
  nullifiers: readonly FieldNumberish[];
}

export type ScanFeedItem = {
  outputIndex: number;
  leafIndex: bigint;
  outputCommitment: bigint;
} & ({
  kind: number;
  shape: PrivateValueShape | null;
  outputData: Uint8Array;
  /** The transaction's content hash, which names a direct send's funding output. */
  contentHash?: string;
  /** Without it the output's records are unavailable; the note itself is unaffected. */
  arena?: ScanArena;
} | {
  kind: "system";
  payout: ScanPayout;
});

type KnownPayoutOpening = { owner: bigint; noteSecret: bigint };

export interface ScanParams {
  chainId: FieldNumberish;
  mlKemSecretKeys: Iterable<Uint8Array>;
  /** The addresses whose notes this scan recovers. */
  owners: Iterable<FieldNumberish>;
  feed: Iterable<ScanFeedItem>;
  recoveryWallet?: Pick<WalletProfile, "address" | "nkRoot">;
  knownPayoutOpenings?: Map<bigint, KnownPayoutOpening>;
  /** Direct sends whose funding outputs open without an envelope, by `directSendOutputKey`. */
  directSendOpenings?: ReadonlyMap<string, DirectSendOpening>;
}

export interface ScanReport {
  scanned: number;
  /** ML-KEM envelope trial decryptions, including unsuccessful key attempts. */
  trialDecryptAttempts: number;
  decrypted: number;
  recovered: SpendableNote[];
  receivedData: { leafIndex: bigint; slot: number; records: DataRecord[] }[];
}

const ARENA_TRANSACTION_TYPES: ReadonlySet<number> = new Set([
  TX_KIND_PRIVATE_VALUE, TX_KIND_USER_ACCOUNT_UPDATE,
]);

/**
 * The arena an ordinary output's records open against, or null when the feed
 * cannot name one: an unknown transaction type, a missing arena, or a context
 * that is not well formed. Arena bytes themselves are checked by the reader.
 */
function outputArena(
  chainId: bigint,
  transactionType: number,
  shape: PrivateValueShape | null,
  arena: ScanArena | undefined,
): OutputArena | null {
  if (arena === undefined || !ARENA_TRANSACTION_TYPES.has(transactionType)) return null;
  const profile = transactionType === TX_KIND_PRIVATE_VALUE ? shape === null ? null : privateValueProfile(shape) : PRIVATE_VALUE_PROFILES.S;
  if (profile === null || arena.nullifiers.length !== profile.inputs) return null;
  try {
    return {
      arena: arena.arena,
      shape: profile.shapeId,
      context: {
        chainId,
        transactionType: transactionType as ArenaTransactionType,
        nullifiers: arena.nullifiers.map((value) => toField(value, "nullifier")),
      },
    };
  } catch {
    return null;
  }
}

function noteRecords(records: DataRecord[] | null): Pick<SpendableNote, "memo" | "applicationRecords" | "sender" | "assetDefinition"> {
  const memo = records?.find(record => record.schema === RECORD_SCHEMA.memo)?.data;
  const sender = records?.find(record => record.schema === RECORD_SCHEMA.sender);
  const definition = records?.find(record => record.schema === RECORD_SCHEMA.assetDefinition);
  const applicationRecords = records?.filter(record => !isBuiltinSchema(record.schema)) ?? [];
  return {
    memo: memo ?? new Uint8Array(),
    ...(applicationRecords.length === 0 ? {} : { applicationRecords }),
    ...(sender === undefined ? {} : { sender: claimedSenderSchema.decode(sender.data) }),
    ...(definition === undefined ? {} : { assetDefinition: decodeAssetDefinition(definition.data) }),
  };
}

export async function scanFeed(params: ScanParams): Promise<ScanReport> {
  const chainId = toNonnegativeBigInt(params.chainId, "chainId");
  const owners = new Set<bigint>();
  for (const owner of params.owners) owners.add(toAddressField(owner, "owner"));
  const secretKeys: Uint8Array[] = [];
  const seenSecretKeys = new Set<string>();
  for (const key of params.mlKemSecretKeys) {
    if (!(key instanceof Uint8Array) || key.length !== ML_KEM_768_SECRET_KEY_LENGTH) {
      throw new Error(`ML-KEM-768 secret key must be ${ML_KEM_768_SECRET_KEY_LENGTH} bytes`);
    }
    const identity = toHex(key);
    if (!seenSecretKeys.has(identity)) {
      seenSecretKeys.add(identity);
      secretKeys.push(key);
    }
  }
  if (secretKeys.length === 0 && params.recoveryWallet === undefined) throw new Error("scanning requires receive keys or a payout recovery profile");
  const knownOpenings = params.knownPayoutOpenings ?? new Map<bigint, KnownPayoutOpening>();
  const seed = params.recoveryWallet === undefined ? undefined : payoutSeed(params.recoveryWallet.nkRoot);

  const recovered: SpendableNote[] = [];
  const receivedData: ScanReport["receivedData"] = [];
  const recoveredIdentities = new Set<string>();
  let scanned = 0;
  let trialDecryptAttempts = 0;
  let decrypted = 0;
  for (const item of params.feed) {
    scanned += 1;
    let payload: NotePayload;
    let records: () => DataRecord[] | null = () => null;
    if (item.kind === "system") {
      let opening = knownOpenings.get(item.payout.ownerCommitment);
      if (opening === undefined && seed !== undefined && params.recoveryWallet !== undefined) {
        opening = recoverPayoutOpening({ owner: params.recoveryWallet.address, seed }, item.payout) ?? undefined;
        if (opening !== undefined) knownOpenings.set(item.payout.ownerCommitment, opening);
      }
      if (opening === undefined) continue;
      payload = { version: 1, chainId, assetId: 0n, amount: item.payout.amount, owner: opening.owner, noteSecret: opening.noteSecret, outputIndex: item.outputIndex };
    } else {
      const profile = item.kind === 0 ? privateValueProfile(item.shape!) : PRIVATE_VALUE_PROFILES.S;
      if (!Number.isInteger(item.outputIndex) || item.outputIndex < 0 || item.outputIndex >= profile.outputs) continue;
      const direct = item.contentHash === undefined ? undefined
        : params.directSendOpenings?.get(directSendOutputKey({ contentHash: item.contentHash, slot: item.outputIndex }));
      if (direct !== undefined) {
        // The kept opening is checked against the commitment below; it also opens the envelope that carries the records.
        payload = { version: 1, chainId, assetId: 0n, amount: direct.amount, owner: direct.owner, noteSecret: direct.noteSecret, outputIndex: item.outputIndex };
        records = () => {
          const source = outputArena(chainId, item.kind, item.shape, item.arena);
          return source === null ? null : directSendRecords(direct, item.outputData, source);
        };
      } else {
        let opened: ReturnType<typeof trialOpenEnvelope> = null;
        for (const secretKey of secretKeys) {
          trialDecryptAttempts += 1;
          opened = trialOpenEnvelope(secretKey, item.outputData);
          if (opened !== null) break;
        }
        if (opened === null) continue;
        try {
          const delivery = decodeDeliveryPayload(opened.plaintext, { chainId });
          if (delivery.outputIndex !== item.outputIndex) continue;
          if ("kind" in delivery) {
            const source = outputArena(chainId, item.kind, item.shape, item.arena);
            const records = source === null ? null : deliveryRecords(delivery, opened.sharedSecret, source);
            if (records !== null) receivedData.push({ leafIndex: item.leafIndex, slot: item.outputIndex, records });
            decrypted++;
            continue;
          }
          payload = delivery;
        } catch {
          continue;
        }
        const { sharedSecret } = opened;
        const decoded = payload;
        records = () => {
          const source = outputArena(chainId, item.kind, item.shape, item.arena);
          return source === null ? null : deliveryRecords(decoded, sharedSecret, source);
        };
      }
    }
    decrypted += 1;
    if (payload.outputIndex !== item.outputIndex
      || !owners.has(payload.owner)
      || payload.amount === 0n) continue;
    const oc = ownerCommitment(payload.owner, payload.noteSecret);
    const body = noteBodyCommitment(oc, payload.assetId, payload.amount);
    const leaf = outputCommitment(body, item.leafIndex);
    if (leaf !== toField(item.outputCommitment, "outputCommitment")) continue;
    knownOpenings.set(oc, { owner: payload.owner, noteSecret: payload.noteSecret });
    const identity = `${item.leafIndex}:${leaf}`;
    if (recoveredIdentities.has(identity)) continue;
    recoveredIdentities.add(identity);
    const delivered = records();
    if (item.kind !== "system" && delivered !== null) receivedData.push({ leafIndex: item.leafIndex, slot: item.outputIndex, records: delivered });
    recovered.push({
      chainId,
      leafIndex: item.leafIndex,
      outputIndex: item.outputIndex,
      assetId: payload.assetId,
      owner: payload.owner,
      noteSecret: payload.noteSecret,
      amount: payload.amount,
      noteBodyCommitment: body,
      outputCommitment: leaf,
      // An unavailable region leaves the note recovered without records.
      ...noteRecords(noteAssetRecords(delivered, payload.assetId)),
    });
  }
  return { scanned, trialDecryptAttempts, decrypted, recovered, receivedData };
}

// ===========================================================================
// Sender regions
// ===========================================================================

/** One output this wallet paid, reopened from its sender region and checked against the chain. */
export interface RecoveredSentOutput {
  slot: number;
  leafIndex: bigint;
  recipientAddress: bigint;
  assetId: bigint;
  amount: bigint;
  noteSecret: bigint;
  /** The recipient region's records, for an output delivered by envelope. */
  records?: DataRecord[];
  /** A direct send, delivered to its owner by link. */
  directSend?: true;
}

/** A transaction whose sender region this wallet's outgoing key opened. */
export interface RecoveredSentTransaction {
  /** Leaf index of the transaction's first output. */
  leafIndex: bigint;
  outputs: RecoveredSentOutput[];
  /** The definition of the asset the transaction moved, as the sender region records it. */
  assetDefinition?: AssetDefinition;
  applicationRecords: readonly DataRecord[];
  self: DataRecord[];
  /** The application records this wallet published in the transaction's public segment. */
  public: DataRecord[];
  messages: { slot: number; to: string; records: DataRecord[] }[];
  /** Direct sends this wallet received, as it recorded them. Not checked against any output. */
  directSendOpenings: DirectSendOpening[];
}

/** One whole transaction from the output feed. */
export interface ScanTransaction {
  transactionType: number;
  shape: PrivateValueShape | null;
  arena: ScanArena;
  /** Its ordinary rows, in slot order. */
  outputs: readonly { slot: number; leafIndex: bigint; outputCommitment: bigint; outputData: Uint8Array }[];
}

/**
 * Open the sender region an outgoing key wrote in one transaction. Every
 * recovered output must open the streamed commitment at its slot for its named
 * recipient: decryption alone is not proof of inclusion. Null when no sender
 * region of this key is there.
 */
export function recoverSentTransaction(params: {
  chainId: bigint;
  outgoingKey: Uint8Array;
  transaction: ScanTransaction;
}): RecoveredSentTransaction | null {
  const { chainId, transaction } = params;
  const source = outputArena(chainId, transaction.transactionType, transaction.shape, transaction.arena);
  if (source === null || transaction.outputs.length === 0) return null;
  const region = openSenderRecords({ ...source, outgoingKey: params.outgoingKey });
  if (region === null) return null;
  const rows = new Map(transaction.outputs.map((row) => [row.slot, row]));
  const opens = (slot: number, owner: bigint, noteSecret: bigint, assetId: bigint, amount: bigint): boolean => {
    const row = rows.get(slot);
    return row !== undefined && amount > 0n
      && outputCommitment(noteBodyCommitment(ownerCommitment(owner, noteSecret), assetId, amount), row.leafIndex) === row.outputCommitment;
  };
  const outputs: RecoveredSentOutput[] = [];
  const messages: RecoveredSentTransaction["messages"] = [];
  for (const sent of region.sentEnvelopes) {
    const row = rows.get(sent.slot);
    const plaintext = row === undefined ? null : openEnvelope(sent.sharedSecret, row.outputData);
    if (row === undefined || plaintext === null) continue;
    let payload: ReturnType<typeof decodeDeliveryPayload>;
    try { payload = decodeDeliveryPayload(plaintext, { chainId }); } catch { continue; }
    if (payload.outputIndex !== sent.slot) continue;
    if ("kind" in payload) {
      const records = deliveryRecords(payload, sent.sharedSecret, source);
      if (records !== null) messages.push({ slot: sent.slot, to: addressHex(sent.recipientAddress), records });
      continue;
    }
    if (payload.outputIndex !== sent.slot || payload.owner !== sent.recipientAddress
      || !opens(sent.slot, payload.owner, payload.noteSecret, payload.assetId, payload.amount)) continue;
    const records = deliveryRecords(payload, sent.sharedSecret, source);
    if (records !== null) messages.push({ slot: sent.slot, to: addressHex(sent.recipientAddress), records });
    if (sent.recordsOnly) continue;
    outputs.push({
      slot: sent.slot, leafIndex: row.leafIndex, recipientAddress: sent.recipientAddress,
      assetId: payload.assetId, amount: payload.amount, noteSecret: payload.noteSecret,
      ...(records === null ? {} : { records: noteAssetRecords(records, payload.assetId)! }),
    });
  }
  for (const opening of region.sentOpenings) {
    const row = rows.get(opening.slot);
    if (row === undefined || !opens(opening.slot, opening.recipientAddress, opening.noteSecret, opening.assetId, opening.amount)) continue;
    const records = opening.directSend ? directSendRecords({ chainId, slot: opening.slot, noteSecret: opening.noteSecret }, row.outputData, source) : null;
    if (records !== null) messages.push({ slot: opening.slot, to: addressHex(opening.recipientAddress), records });
    outputs.push({
      slot: opening.slot, leafIndex: row.leafIndex, recipientAddress: opening.recipientAddress,
      assetId: opening.assetId, amount: opening.amount, noteSecret: opening.noteSecret,
      ...(records === null ? {} : { records }),
      ...(opening.directSend ? { directSend: true as const } : {}),
    });
  }
  outputs.sort((left, right) => left.slot - right.slot);
  const self = noteRecords(region.records);
  return {
    leafIndex: transaction.outputs[0]!.leafIndex - BigInt(transaction.outputs[0]!.slot),
    outputs,
    ...(self.assetDefinition === undefined ? {} : { assetDefinition: self.assetDefinition }),
    applicationRecords: self.applicationRecords ?? [],
    self: region.records,
    public: readPublicRecords(source.arena) ?? [],
    messages,
    directSendOpenings: region.directSendOpenings,
  };
}

type OrdinaryOutput = Extract<OutputResult, { kind: "ordinary" }>;

/**
 * The transactions of one page: each slot-0 row with its arena and the rows of
 * the same transaction that follow it. The node client has already checked
 * that pages hold whole transactions.
 */
function pageTransactions(outputs: readonly OutputResult[]): { first: OrdinaryOutput; transaction: ScanTransaction }[] {
  const transactions: { first: OrdinaryOutput; transaction: ScanTransaction & { outputs: ScanTransaction["outputs"][number][] } }[] = [];
  for (const output of outputs) {
    if (output.kind !== "ordinary") continue;
    const row = { slot: output.outputSlot, leafIndex: output.outputIndex, outputCommitment: BigInt(output.outputCommitment), outputData: output.outputData };
    if (output.outputSlot === 0) {
      if (output.arena !== null) {
        transactions.push({
          first: output,
          transaction: {
            transactionType: output.transactionType,
            shape: output.privateValueShape,
            arena: { arena: output.arena, nullifiers: output.nullifiers },
            outputs: [row],
          },
        });
      }
      continue;
    }
    const open = transactions.at(-1);
    if (open !== undefined && open.first.transactionId.toLowerCase() === output.transactionId.toLowerCase()) {
      open.transaction.outputs.push(row);
    }
  }
  return transactions;
}

function addSentOutputs(data: WalletFileData, outputs: readonly StoredSentOutput[]): void {
  if (outputs.length === 0) return;
  const known = new Set((data.sentOutputs ?? []).map((output) => `${output.transactionId}:${output.slot}`));
  data.sentOutputs = [
    ...(data.sentOutputs ?? []),
    ...outputs.filter((output) => !known.has(`${output.transactionId}:${output.slot}`)),
  ];
}

/** Stored form of a recovered transaction's outputs; every output repeats the transaction's sender records. */
function storedSentOutputs(sent: RecoveredSentTransaction, first: OrdinaryOutput): StoredSentOutput[] {
  const senderRecords = sent.applicationRecords.map(({ schema, data }) => ({ schema, data: toHex(data) }));
  return sent.outputs.map((output) => {
    const records = noteRecords(output.records ?? null);
    const memo = output.records?.find(record => record.schema === RECORD_SCHEMA.memo)?.data;
    let definition = records.assetDefinition;
    if (definition === undefined && sent.assetDefinition !== undefined && output.assetId !== 0n) {
      try {
        if (assetDefinitionAssetId(sent.assetDefinition) === output.assetId) definition = sent.assetDefinition;
      } catch {
        definition = undefined;
      }
    }
    return {
      transactionId: first.transactionId.toLowerCase(),
      contentHash: first.contentHash.toLowerCase(),
      privateValueShape: first.privateValueShape,
      slot: output.slot,
      leafIndex: output.leafIndex.toString(),
      recipientAddress: addressHex(output.recipientAddress),
      assetId: `0x${output.assetId.toString(16)}`,
      amount: output.amount.toString(),
      noteSecret: bytes32Hex(output.noteSecret),
      ...(definition === undefined ? {} : { assetDefinition: toHex(encodeAssetDefinition(definition)) }),
      ...(memo === undefined ? {} : { memo: toHex(memo) }),
      senderIncluded: records.sender !== undefined,
      ...(output.directSend ? { directSend: true as const } : {}),
      ...(senderRecords.length === 0 ? {} : { senderRecords }),
      blockNumber: first.origin.pcashNumber.toString(),
      blockHash: first.origin.pcashHash.toLowerCase(),
      blockTimestamp: first.origin.timestamp.toString(),
    };
  });
}

interface OutputScanRange {
  fromOutputIndex?: bigint;
  target?: { pcashNumber: bigint; pcashHash: string };
  receiveKeyPairs?: Iterable<MlKemKeyPair>;
}

/**
 * The newest boundary an output scan may be pinned to, or null when the node's
 * derived index is not serving reads. The index advances after the canonical
 * commit, so the canonical tip routinely names a block the index cannot serve
 * yet; its own ready cursor is the newest boundary that can answer for outputs.
 */
export function readyOutputScanBoundary(
  status: StatusResult,
): { pcashNumber: bigint; pcashHash: string } | null {
  const { status: lifecycle, cursor } = status.index;
  return lifecycle === "ready" && cursor !== null
    ? { pcashNumber: cursor.blockNumber, pcashHash: cursor.blockHash }
    : null;
}

/**
 * Whether a wallet synced through `syncedThrough` has folded in every output
 * the node can serve. Comparing against the canonical tip instead would read as
 * unsynchronized for as long as the derived index trails the commit it follows;
 * with no readable boundary nothing can be synchronized.
 */
export function synchronizedThrough(
  status: StatusResult,
  syncedThrough: { pcashNumber: bigint; pcashHash: string } | null,
): boolean {
  const boundary = readyOutputScanBoundary(status);
  return boundary !== null && syncedThrough !== null
    && syncedThrough.pcashNumber === boundary.pcashNumber
    && syncedThrough.pcashHash.toLowerCase() === boundary.pcashHash.toLowerCase();
}

/** The scan boundary, for a caller that cannot proceed without one. */
export function outputScanBoundary(
  status: StatusResult,
): { pcashNumber: bigint; pcashHash: string } {
  const boundary = readyOutputScanBoundary(status);
  if (boundary === null) {
    throw new Error(`node derived index is ${status.index.status}: output scanning is unavailable`);
  }
  return boundary;
}

function scanPayout(payout: Extract<OutputResult, { kind: "system" }>["payout"]): ScanPayout {
  return {
    sourceKind: payout.source.kind, component: payout.component, amount: payout.amount,
    ownerCommitment: payout.ownerCommitment, contexts: payout.contexts,
  };
}

/** A page's recipient recoveries and the transactions whose sender regions the outgoing key opened. */
export interface OutputScanReport extends ScanReport {
  sent: RecoveredSentTransaction[];
  transactionRecords: import("../noteStore.ts").StoredTransactionRecords[];
}

/**
 * Scan every output from `fromOutputIndex` to the target, page by page. Pages
 * hold whole transactions, so each transaction's arena arrives once with its
 * rows and both its recipient regions and the wallet's sender region open
 * without another request.
 */
export async function scanOutputPages(params: {
  node: Pick<PcashNodeClient, "getOutputs">;
  fromOutputIndex: bigint;
  target: { pcashNumber: bigint; pcashHash: string };
  chainId: FieldNumberish;
  mlKemSecretKeys: readonly Uint8Array[];
  owners: readonly FieldNumberish[];
  recoveryWallet?: Pick<WalletProfile, "address" | "nkRoot">;
  /** Opens the sender regions this wallet wrote. */
  outgoingKey?: Uint8Array;
  knownPayoutOpenings?: Map<bigint, KnownPayoutOpening>;
  /**
   * Direct sends to match by funding output. Openings the owners' own sender
   * regions record are added as their pages are read, before the page is
   * matched, so a funding output in the same page is found.
   */
  directSendOpenings?: Map<string, DirectSendOpening>;
  onPage?: (report: OutputScanReport, outputs: readonly OutputResult[]) => void | Promise<void>;
}): Promise<OutputScanReport & { outputCount: bigint }> {
  const chainId = toNonnegativeBigInt(params.chainId, "chainId");
  const recovered: SpendableNote[] = [];
  const receivedData: ScanReport["receivedData"] = [];
  const sent: RecoveredSentTransaction[] = [];
  const transactionRecords: OutputScanReport["transactionRecords"] = [];
  let scanned = 0;
  let trialDecryptAttempts = 0;
  let decrypted = 0;
  const knownPayoutOpenings = params.knownPayoutOpenings ?? new Map<bigint, KnownPayoutOpening>();
  const directOpenings = params.directSendOpenings ?? new Map<string, DirectSendOpening>();
  const owners = new Set(params.owners.map((owner) => toAddressField(owner, "owner")));
  let continuation: Record<string, unknown> | null | undefined;
  let outputCount: bigint | undefined;
  let lastOutputIndex: bigint | undefined;
  const seenContinuations = new Set<string>();
  do {
    const page = await params.node.getOutputs({
      fromOutputIndex: params.fromOutputIndex,
      target: params.target,
      ...(continuation !== undefined ? { continuation } : {}),
    });
    outputCount ??= page.target.outputCount;
    if (page.target.outputCount !== outputCount) throw new Error("output target count changed across pages");
    if (page.outputs.some((output) => lastOutputIndex !== undefined && output.outputIndex <= lastOutputIndex)) {
      throw new Error("output pages overlap or regress");
    }
    const transactions = pageTransactions(page.outputs);
    const arenas = new Map(transactions.flatMap(({ transaction }) =>
      transaction.outputs.map((row) => [row.leafIndex, transaction.arena] as const)));
    const pageSent = params.outgoingKey === undefined ? [] : transactions.flatMap(({ transaction }) => {
      const opened = recoverSentTransaction({ chainId, outgoingKey: params.outgoingKey!, transaction });
      return opened === null ? [] : [opened];
    });
    for (const opening of pageSent.flatMap((sent) => sent.directSendOpenings)) {
      if (opening.chainId === chainId && owners.has(opening.owner)) directOpenings.set(directSendOutputKey(opening), opening);
    }
    const pageReport = await scanFeed({
      chainId,
      mlKemSecretKeys: params.mlKemSecretKeys,
      owners: params.owners,
      ...(params.recoveryWallet === undefined ? {} : { recoveryWallet: params.recoveryWallet }),
      knownPayoutOpenings,
      directSendOpenings: directOpenings,
      feed: page.outputs.map((output): ScanFeedItem => output.kind === "ordinary" ? {
        outputData: output.outputData, kind: output.transactionType, shape: output.privateValueShape, outputIndex: output.outputSlot,
        leafIndex: output.outputIndex, outputCommitment: BigInt(output.outputCommitment), contentHash: output.contentHash,
        ...(arenas.has(output.outputIndex) ? { arena: arenas.get(output.outputIndex)! } : {}),
      } : {
        kind: "system", payout: scanPayout(output.payout), outputIndex: SYSTEM_NOTE_OUTPUT_INDEX,
        leafIndex: output.outputIndex, outputCommitment: BigInt(output.outputCommitment),
      }),
    });
    scanned += pageReport.scanned;
    trialDecryptAttempts += pageReport.trialDecryptAttempts;
    decrypted += pageReport.decrypted;
    recovered.push(...pageReport.recovered);
    receivedData.push(...pageReport.receivedData);
    sent.push(...pageSent);
    const storeRecords = (records: readonly DataRecord[]) => records.map(({ schema, data }) => ({ schema, data: toHex(data) }));
    const pageRecords = transactions.flatMap(({ first, transaction }) => {
      const received = pageReport.receivedData.filter(item => transaction.outputs.some(row => row.leafIndex === item.leafIndex));
      const own = pageSent.find(sent => sent.leafIndex === first.outputIndex);
      if (received.length === 0 && own === undefined && !pageReport.recovered.some(note => transaction.outputs.some(row => row.leafIndex === note.leafIndex))) return [];
      return [{ transactionId: first.transactionId.toLowerCase(), contentHash: first.contentHash.toLowerCase(), leafIndex: first.outputIndex.toString(),
        blockNumber: first.origin.pcashNumber.toString(), blockHash: first.origin.pcashHash.toLowerCase(), timestamp: first.origin.timestamp.toString(),
        received: received.map(item => ({ slot: item.slot, records: storeRecords(item.records) })),
        sent: (own?.messages ?? []).map(item => ({ ...item, records: storeRecords(item.records) })),
        self: storeRecords(own?.self ?? []),
        public: storeRecords(own?.public ?? []),
      }];
    });
    transactionRecords.push(...pageRecords);
    await params.onPage?.({ ...pageReport, sent: pageSent, transactionRecords: pageRecords }, page.outputs);
    if (page.outputs.length > 0) lastOutputIndex = page.outputs[page.outputs.length - 1]!.outputIndex;
    continuation = page.continuation;
    if (page.complete) break;
    const continuationKey = JSON.stringify(continuation);
    if (seenContinuations.has(continuationKey)) throw new Error("output continuation did not advance");
    seenContinuations.add(continuationKey);
  } while (continuation !== null);
  if (outputCount === undefined) throw new Error("output scan returned no target");
  return { scanned, trialDecryptAttempts, decrypted, recovered, sent, receivedData, transactionRecords, outputCount };
}

export async function scanWallet(
  node: PcashNodeClient,
  wallet: WalletProfileWithReceiveKeys & { outgoingKey?: Uint8Array },
  chainId: FieldNumberish,
  range: OutputScanRange = {},
): Promise<OutputScanReport> {
  const normalizedChainId = toNonnegativeBigInt(chainId, "chainId");
  const status = range.target === undefined ? await node.status() : null;
  if (status !== null && BigInt(status.pcashChainId) !== normalizedChainId) {
    throw new Error("node PCASH chain id does not match this wallet");
  }
  const target = range.target ?? outputScanBoundary(status!);
  const { outputCount: _outputCount, ...report } = await scanOutputPages({
    node,
    fromOutputIndex: range.fromOutputIndex ?? 0n,
    target,
    chainId: normalizedChainId,
    mlKemSecretKeys: [
      wallet.mlKemSecretKey,
      ...Array.from(range.receiveKeyPairs ?? [], (pair) => pair.secretKey),
    ],
    owners: [wallet.address],
    recoveryWallet: wallet,
    ...(wallet.outgoingKey === undefined ? {} : { outgoingKey: wallet.outgoingKey }),
  });
  return report;
}

export interface WalletInventorySyncReport extends OutputScanReport {
  startedAtOutputIndex: bigint;
  syncedThrough: { pcashNumber: bigint; pcashHash: string };
  nextOutputIndex: bigint;
}

function publishInventory(target: WalletFileData, next: WalletFileData): void {
  const targetRecord = target as unknown as Record<string, unknown>;
  for (const key of Object.keys(targetRecord)) delete targetRecord[key];
  Object.assign(targetRecord, structuredClone(next));
}

function walletHasPendingActivity(data: WalletFileData): boolean {
  return data.notes.length !== 0
    || data.fullRescanRequired === true
    || (data.pendingNoteFundedTransfers?.length ?? 0) !== 0
    || (data.pendingAssetActions?.length ?? 0) !== 0
    || (data.pendingUserAccountCreations?.length ?? 0) !== 0
    || (data.pendingUserAccountUpdates?.length ?? 0) !== 0
    || (data.mempoolOutbox?.length ?? 0) !== 0;
}

export function assertWalletCanAnchorAtCurrentBoundary(
  data: WalletFileData,
  allowedReservationId?: string,
): void {
  const unrelatedReservations = data.resourceReservations?.filter(
    (reservation) => reservation.reservationId !== allowedReservationId,
  ) ?? [];
  if (data.nextOutputIndex !== undefined
    || data.syncedThrough !== undefined
    || walletHasPendingActivity(data)
    || unrelatedReservations.length !== 0) {
    throw new Error("current-boundary initialization requires a fresh action-free wallet");
  }
}

async function persistAndPublish(
  destination: WalletFileData,
  staged: WalletFileData,
  persist: () => Promise<WalletFileData | void>,
): Promise<void> {
  const committed = await persist();
  publishInventory(destination, committed ?? staged);
}

const nullifierCache = new Map<string, string>();

/** The nullifier of one of this wallet's confirmed notes, computed once per process. */
function noteNullifier(note: WalletNote, nk: bigint): string {
  const key = `${nk}:${note.commitment}:${note.noteSecret}`;
  let value = nullifierCache.get(key);
  if (value === undefined) {
    value = bytes32Hex(nullifier(BigInt(note.commitment!), nk, BigInt(note.noteSecret)));
    nullifierCache.set(key, value);
  }
  return value;
}

/**
 * Every nullifier whose consumption this wallet tracks: its confirmed notes,
 * its journaled actions, and bulk chunks whose outcome is still open.
 */
function watchedNullifiers(data: WalletFileData, nk: bigint): Set<string> {
  const watched = new Set<string>();
  for (const note of data.notes) {
    if (!note.pending && note.commitment !== null) watched.add(noteNullifier(note, nk));
  }
  for (const pending of [
    ...(data.pendingNoteFundedTransfers ?? []),
    ...(data.pendingAssetActions ?? []),
    ...(data.pendingUserAccountUpdates ?? []),
    ...(data.bulkJobs ?? []).flatMap((job) => job.chunks.filter((chunk) => chunk.outcome === "unresolved").map((chunk) => chunk.action)),
  ]) {
    for (const input of pending.inputs) watched.add(input.nullifier.toLowerCase());
  }
  return watched;
}

function dropConfirmedNotes(data: WalletFileData, fromLeafIndex: bigint): void {
  data.notes = data.notes.filter((note) => note.pending || note.leafIndex === null || BigInt(note.leafIndex) < fromLeafIndex);
  dropDirectSendRecords(data, fromLeafIndex);
  if (data.sentOutputs !== undefined) {
    data.sentOutputs = data.sentOutputs.filter((output) => BigInt(output.leafIndex) < fromLeafIndex);
    if (data.sentOutputs.length === 0) delete data.sentOutputs;
  }
  if (data.transactionRecords !== undefined) data.transactionRecords = data.transactionRecords.filter(row => BigInt(row.leafIndex) < fromLeafIndex);
  data.historyRevision = (BigInt(data.historyRevision ?? "0") + 1n).toString();
}

/** A direct send whose funding output a scan passed before the wallet knew its opening. */
interface PassedDirectSend {
  opening: DirectSendOpening;
  leafIndex: bigint;
  commitment: bigint;
  nullifier: string;
}

/**
 * The note of a direct send whose funding output the scan already passed. The
 * feed from that output to the step's target gives the note's provenance and
 * any transaction that consumed its nullifier, so a note spent before this
 * wallet knew the opening, as by another device on the same seed, stays spent.
 * A note not spent in a final block also needs its path, which must open the
 * wallet's own output root. Null while the node's answers do not match the
 * opening, so a later step tries again.
 */
async function passedDirectSendNote(
  node: PcashNodeClient,
  chain: WalletChainState,
  target: { pcashNumber: bigint; pcashHash: string },
  finalizedBlock: bigint,
  passed: PassedDirectSend,
): Promise<WalletNote | null> {
  const { opening, leafIndex, commitment, nullifier: spent } = passed;
  // From the funding transaction's first output, which carries its arena.
  const firstLeaf = leafIndex - BigInt(opening.slot);
  let first: OrdinaryOutput | undefined;
  let row: OrdinaryOutput | undefined;
  let spender: OrdinaryOutput | undefined;
  let continuation: Record<string, unknown> | null | undefined;
  const seen = new Set<string>();
  do {
    const page = await node.getOutputs({ fromOutputIndex: firstLeaf, target, ...(continuation === undefined ? {} : { continuation }) });
    for (const output of page.outputs) {
      if (output.kind !== "ordinary") continue;
      if (output.outputIndex === firstLeaf) first = output;
      if (output.outputIndex === leafIndex) row = output;
      if (output.nullifiers.some((value) => value.toLowerCase() === spent)) spender ??= output;
    }
    if (page.complete || spender !== undefined) break;
    continuation = page.continuation;
    const key = JSON.stringify(continuation);
    if (seen.has(key)) throw new Error("output continuation did not advance");
    seen.add(key);
  } while (continuation !== null);
  if (row === undefined || row.contentHash.toLowerCase() !== opening.contentHash
    || row.outputSlot !== opening.slot || BigInt(row.outputCommitment) !== commitment) return null;
  if (spender !== undefined && !chain.consumed.has(spent)) {
    chain.recordConsumption(spent, {
      pcashNumber: spender.origin.pcashNumber,
      pcashHash: spender.origin.pcashHash.toLowerCase(),
      timestamp: spender.origin.timestamp,
      transactionId: spender.transactionId.toLowerCase(),
      contentHash: spender.contentHash.toLowerCase(),
      nullifiers: spender.nullifiers.map((value) => value.toLowerCase()),
    });
  }
  // A spend a reorganization can still remove leaves the note spendable again, so it keeps its witness until final.
  const spentBy = chain.consumed.get(spent);
  if (spentBy === undefined || spentBy.pcashNumber > finalizedBlock) {
    let paths: Awaited<ReturnType<PcashNodeClient["getOutputPaths"]>>;
    try {
      paths = await node.getOutputPaths([{ outputIndex: leafIndex, outputCommitment: commitment }]);
    } catch (error) {
      if (error instanceof OutputOpeningMismatchError) return null;
      throw error;
    }
    if (paths === null || !chain.outputs.markPath(leafIndex, commitment, paths.paths[0]!.siblings)) return null;
  }
  const source = first?.arena == null ? null
    : outputArena(opening.chainId, first.transactionType, first.privateValueShape, { arena: first.arena, nullifiers: first.nullifiers });
  const { memo, sender } = noteRecords(source === null ? null : directSendRecords(opening, row.outputData, source));
  return {
    leafIndex: leafIndex.toString(),
    outputIndex: opening.slot,
    assetId: "0x0",
    amount: opening.amount.toString(),
    owner: `0x${opening.owner.toString(16)}`,
    noteSecret: `0x${opening.noteSecret.toString(16)}`,
    commitment: bytes32Hex(commitment),
    spent: false,
    pending: false,
    cursor: {
      kind: "ordinary",
      payout: null,
      blockNumber: row.origin.pcashNumber.toString(),
      blockHash: row.origin.pcashHash.toLowerCase(),
      blockTimestamp: row.origin.timestamp.toString(),
      transactionId: row.transactionId.toLowerCase(),
      outputIndex: opening.slot.toString(),
    },
    ...(memo.length === 0 ? {} : { memo: toHex(memo) }),
    ...(sender === undefined ? {} : { sender: addressHex(sender) }),
  };
}

/** The newest checkpoint still on the node's canonical chain, or null when a reorganization passed them all. */
async function canonicalCheckpoint(
  node: PcashNodeClient,
  chain: WalletChainState,
  status: StatusResult,
): Promise<ChainBlock | null> {
  for (const checkpoint of chain.checkpoints()) {
    if (checkpoint.pcashNumber > status.latestBlock) continue;
    const header = await node.getBlockHeader(checkpoint.pcashNumber);
    if (header.boundary.blockHash === BigInt(checkpoint.pcashHash)) return checkpoint;
  }
  return null;
}

/** A store whose outputs start at `block` from the node's frontier there. */
async function anchoredChainState(
  node: PcashNodeClient,
  block: { pcashNumber: bigint; pcashHash: string },
  previousRevision: number,
): Promise<WalletChainState> {
  const frontier = await node.getOutputFrontier(block);
  return WalletChainState.create(
    { pcashNumber: block.pcashNumber, pcashHash: block.pcashHash.toLowerCase(), outputCount: frontier.outputCount },
    frontier.frontier,
    previousRevision,
  );
}

/**
 * Apply the account changes after `fromBlock`. With `checkReceiveKeys`, a page
 * whose key does not hash to its committed digest is rejected, so a retry or
 * another node can recover; a fresh replay from genesis leaves the keys to the
 * check where they are used.
 */
async function applyAccountChanges(
  node: PcashNodeClient,
  chain: WalletChainState,
  fromBlock: bigint,
  target: { pcashNumber: bigint; pcashHash: string },
  checkReceiveKeys: boolean,
): Promise<void> {
  let continuation: Awaited<ReturnType<PcashNodeClient["getAccountChanges"]>>["continuation"] | undefined;
  const seen = new Set<string>();
  for (;;) {
    const page = await node.getAccountChanges({
      fromBlock,
      target,
      ...(continuation === undefined ? {} : { continuation }),
    });
    for (const change of page.changes) chain.applyAccountChange(change, { checkReceiveKey: checkReceiveKeys });
    if (page.complete || page.continuation === null) return;
    const key = JSON.stringify(page.continuation);
    if (seen.has(key)) throw new Error("account change continuation did not advance");
    seen.add(key);
    continuation = page.continuation;
  }
}

interface SynchronizeWalletInventoryOptions {
  /** The wallet's store; its local chain state advances in the same commit as the document. */
  store: WalletStateStore;
  target?: { pcashNumber: bigint; pcashHash: string };
  anchorAtTarget?: boolean;
  anchorReservationId?: string;
  /** Replace the local chain state and replay outputs from genesis. */
  rescan?: boolean;
  status?: StatusResult;
  /** Checks the wallet's synced account before anything is decrypted. */
  assertAccount?: (account: PcashProfileAccountView | null) => void;
  persist?: (
    data: WalletFileData,
    chain: { state: WalletChainState; commit: ChainCommit },
  ) => WalletFileData | void | Promise<WalletFileData | void>;
}

/**
 * Advance the wallet's local chain state and note inventory to one frozen
 * block, then commit both together.
 *
 * Every request is one every wallet with the same sync position makes:
 * headers by number for reorganization checks, the output frontier at the
 * birthday, every account change and every output in the interval, and the
 * anchor header. Trial decryption, nullifier matching, witness maintenance,
 * and account-tree updates all happen locally. The exception is a direct send
 * the wallet holds the opening of but has not matched: its funding
 * transaction's receipt, and once the scan has passed that output, the feed
 * from it and its path, all of which name that output to the node.
 */
export async function synchronizeWalletInventory(
  node: PcashNodeClient,
  /** With an outgoing key, the wallet also reopens what it sent from its sender regions. */
  wallet: WalletProfileWithReceiveKeys & { outgoingKey?: Uint8Array },
  chainIdValue: FieldNumberish,
  data: WalletFileData,
  options: SynchronizeWalletInventoryOptions,
): Promise<WalletInventorySyncReport> {
  const destination = data;
  data = structuredClone(data);
  const chainId = toNonnegativeBigInt(chainIdValue, "chainId");
  const status = options.status ?? await node.status();
  if (BigInt(status.pcashChainId) !== chainId || !samePcashIdentity(data.network, statusPcashIdentity(status))) {
    throw new Error("wallet inventory belongs to a different PCASH network");
  }
  const target = options.target ?? outputScanBoundary(status);
  if (options.anchorAtTarget === true) {
    if (options.target !== undefined) {
      throw new Error("current-boundary initialization requires the node's current head");
    }
    assertWalletCanAnchorAtCurrentBoundary(data, options.anchorReservationId);
  }
  const ownedReceiveKeys = [
    { publicKey: wallet.mlKemPublicKey, secretKey: wallet.mlKemSecretKey },
    ...receiveKeyPairs(data),
  ];
  const nk = noteNk(wallet.nkRoot);

  return options.store.chainStep(async (loaded) => {
    let chain = options.rescan === true || options.anchorAtTarget === true ? null : loaded;
    let rewound = false;
    if (chain !== null) {
      const fork = await canonicalCheckpoint(node, chain, status);
      if (fork === null) {
        chain = null;
      } else if (fork.pcashNumber !== chain.synced.pcashNumber) {
        chain.rewindTo(fork);
        dropConfirmedNotes(data, chain.outputs.count);
        rewound = true;
      }
    }
    // The node's index can trail this wallet's synced block, after a
    // reorganization that shortened the chain or an index rebuild. Without a
    // rewind there is nothing to add; after one, the rewound state is
    // committed at the checkpoint it returned to.
    let stepTarget = target;
    if (chain !== null && target.pcashNumber < chain.synced.pcashNumber) {
      if (!rewound) {
        return {
          scanned: 0,
          trialDecryptAttempts: 0,
          decrypted: 0,
          recovered: [],
          receivedData: [],
          transactionRecords: [],
          sent: [],
          startedAtOutputIndex: chain.outputs.count,
          syncedThrough: { pcashNumber: chain.synced.pcashNumber, pcashHash: chain.synced.pcashHash },
          nextOutputIndex: chain.outputs.count,
        };
      }
      stepTarget = { pcashNumber: chain.synced.pcashNumber, pcashHash: chain.synced.pcashHash };
    }
    const fresh = chain === null;
    if (chain === null) {
      const previousRevision = loaded?.revision ?? 0;
      if (data.syncedThrough !== undefined || loaded !== null) dropConfirmedNotes(data, 0n);
      // A wallet born at a later block restarts there after a reorganization
      // deeper than its checkpoints, but only while that exact block is still
      // canonical: a replacement block at the same height can hold a payment
      // below its own end frontier, so any other case replays from genesis.
      const birthday = options.rescan !== true && loaded !== null && loaded.birthday.outputCount !== 0n
        && loaded.birthday.pcashNumber <= status.latestBlock
        ? loaded.birthday
        : null;
      const birthdayCanonical = birthday !== null
        && (await node.getBlockHeader(birthday.pcashNumber)).boundary.blockHash === BigInt(birthday.pcashHash);
      if (options.anchorAtTarget === true) {
        chain = await anchoredChainState(node, target, previousRevision);
      } else if (birthdayCanonical) {
        chain = await anchoredChainState(node, birthday, previousRevision);
      } else {
        chain = genesisChainState({ pcashNumber: 0n, pcashHash: status.genesisHash.toLowerCase() }, previousRevision);
      }
      data.historyStartOutputIndex = chain.birthday.outputCount.toString();
    }
    const synced = chain;

    // Accounts first: the wallet's own account must agree with its profile
    // before any output is decrypted against it.
    const accountsFrom = fresh ? 0n : synced.synced.pcashNumber + 1n;
    if (accountsFrom <= stepTarget.pcashNumber) await applyAccountChanges(node, synced, accountsFrom, stepTarget, !fresh);
    const account = synced.accountResult(addressHex(wallet.address));
    options.assertAccount?.(account);
    if (account !== null) assertCurrentReceiveKeyOwned(account, ownedReceiveKeys);

    const startedAtOutputIndex = synced.outputs.count;
    const watched = watchedNullifiers(data, nk);
    const sentOutputs: StoredSentOutput[] = [];
    // The scan finds the funding output of every direct send it knows before
    // passing it. One it passed before learning the opening is added after the scan.
    const directOpenings = new Map(directSendOpenings(data)
      .filter((opening) => opening.owner === wallet.address && opening.chainId === chainId)
      .map((opening) => [directSendOutputKey(opening), opening]));
    const passed = new Map<string, PassedDirectSend>();
    const resolvePassed = async (opening: DirectSendOpening, before: bigint): Promise<void> => {
      const receipt = await pollReceipt(node, opening.contentHash);
      if (receipt?.outcome !== "succeeded" || receipt.outputLeafStart === null || BigInt(opening.slot) >= receipt.outputsAdded) return;
      const leafIndex = receipt.outputLeafStart + BigInt(opening.slot);
      if (leafIndex >= before) return;
      const commitment = directSendOutputCommitment(opening, leafIndex);
      // Watched from here on; a spend the scan already passed is read back from the feed.
      const spent = bytes32Hex(nullifier(commitment, nk, opening.noteSecret));
      watched.add(spent);
      passed.set(directSendOutputKey(opening), { opening, leafIndex, commitment, nullifier: spent });
    };
    if (stepTarget === target) {
      for (const opening of directOpenings.values()) {
        if (directSendNote(data, opening) === undefined) await resolvePassed(opening, startedAtOutputIndex);
      }
    }
    const { outputCount, ...report } = stepTarget !== target ? {
      scanned: 0, trialDecryptAttempts: 0, decrypted: 0, recovered: [], receivedData: [], transactionRecords: [], sent: [], outputCount: startedAtOutputIndex,
    } : await scanOutputPages({
      node,
      fromOutputIndex: startedAtOutputIndex,
      target,
      chainId,
      mlKemSecretKeys: ownedReceiveKeys.map((pair) => pair.secretKey),
      owners: [wallet.address],
      recoveryWallet: wallet,
      ...(wallet.outgoingKey === undefined ? {} : { outgoingKey: wallet.outgoingKey }),
      directSendOpenings: directOpenings,
      knownPayoutOpenings: new Map(data.notes.filter((note) => !note.pending).map((note) => [ownerCommitment(BigInt(note.owner), BigInt(note.noteSecret)), { owner: BigInt(note.owner), noteSecret: BigInt(note.noteSecret) }])),
      onPage: async (pageReport, outputs) => {
        data.transactionRecords = [...data.transactionRecords ?? [], ...pageReport.transactionRecords];
        const recoveredLeaves = new Set(pageReport.recovered.map((note) => note.leafIndex));
        for (const note of pageReport.recovered) {
          watched.add(bytes32Hex(nullifier(note.outputCommitment, nk, note.noteSecret)));
        }
        for (const sent of pageReport.sent) {
          const first = outputs.find((candidate) => candidate.outputIndex === sent.leafIndex);
          if (first?.kind === "ordinary") sentOutputs.push(...storedSentOutputs(sent, first));
          // The wallet's own copy of an action's definition, recovered with or without sent outputs.
          if (sent.assetDefinition !== undefined) {
            addWalletAsset(data, { assetId: assetDefinitionAssetId(sent.assetDefinition), definition: sent.assetDefinition });
          }
          for (const opening of sent.directSendOpenings) {
            if (first?.kind !== "ordinary" || opening.owner !== wallet.address || opening.chainId !== chainId) continue;
            const learned = addDirectSendOpening(data, opening, {
              leafIndex: sent.leafIndex.toString(), blockNumber: first.origin.pcashNumber.toString(), blockHash: first.origin.pcashHash.toLowerCase(),
            });
            const found = pageReport.recovered.some((note) => note.owner === opening.owner
              && note.noteSecret === opening.noteSecret && note.amount === opening.amount);
            if (learned && !found) await resolvePassed(opening, synced.outputs.count);
          }
        }
        for (const output of outputs) {
          if (output.outputIndex !== synced.outputs.count) {
            throw new Error(`output feed returned index ${output.outputIndex} where ${synced.outputs.count} was next`);
          }
          if (output.kind === "ordinary") {
            for (const consumed of output.nullifiers) {
              if (!watched.has(consumed.toLowerCase())) continue;
              synced.recordConsumption(consumed, {
                pcashNumber: output.origin.pcashNumber,
                pcashHash: output.origin.pcashHash.toLowerCase(),
                timestamp: output.origin.timestamp,
                transactionId: output.transactionId.toLowerCase(),
                contentHash: output.contentHash.toLowerCase(),
                nullifiers: output.nullifiers.map((value) => value.toLowerCase()),
              });
            }
          }
          synced.outputs.append(BigInt(output.outputCommitment), recoveredLeaves.has(output.outputIndex));
        }
        const positions = new Map(outputs.map((output) => [
          `${output.outputIndex}:${output.kind === "ordinary" ? output.outputSlot : SYSTEM_NOTE_OUTPUT_INDEX}`,
          output,
        ]));
        const recoveredNotes: WalletNote[] = pageReport.recovered.map((note) => {
          const position = positions.get(`${note.leafIndex}:${note.outputIndex}`)!;
          return {
            leafIndex: note.leafIndex.toString(),
            outputIndex: note.outputIndex,
            assetId: `0x${note.assetId.toString(16)}`,
            amount: note.amount.toString(),
            owner: `0x${note.owner.toString(16)}`,
            noteSecret: `0x${note.noteSecret.toString(16)}`,
            commitment: bytes32Hex(note.outputCommitment),
            spent: false,
            pending: false,
            cursor: {
              kind: position.kind,
              payout: position.kind === "system" ? {
                sourceKind: position.payout.source.kind,
                component: position.payout.component,
              } : null,
              blockNumber: position.origin.pcashNumber.toString(),
              blockHash: position.origin.pcashHash.toLowerCase(),
              blockTimestamp: position.origin.timestamp.toString(),
              transactionId: (position.kind === "ordinary" ? position.transactionId : position.payout.transactionId)?.toLowerCase() ?? null,
              outputIndex: note.outputIndex.toString(),
            },
            ...(note.memo.length === 0 ? {} : { memo: toHex(note.memo) }),
            ...(note.sender === undefined ? {} : { sender: addressHex(note.sender) }),
          };
        });
        mergeRecoveredWalletNotes(data, recoveredNotes);
        for (const note of pageReport.recovered) {
          if (note.assetDefinition !== undefined) {
            addWalletAsset(data, { assetId: note.assetId, definition: note.assetDefinition });
          }
        }
      },
    });

    addSentOutputs(data, sentOutputs);
    for (const output of sentOutputs) {
      if (output.assetDefinition !== undefined) {
        addWalletAsset(data, { assetId: BigInt(output.assetId), definition: decodeAssetDefinition(fromHex(output.assetDefinition)) });
      }
    }
    for (const direct of passed.values()) {
      if (directSendNote(data, direct.opening) !== undefined) continue;
      const note = await passedDirectSendNote(node, synced, stepTarget, status.finalizedBlock, direct);
      if (note !== null) mergeRecoveredWalletNotes(data, [note]);
    }

    const anchor = (await node.getBlockHeader(stepTarget.pcashNumber)).boundary;
    if (anchor.blockHash !== BigInt(stepTarget.pcashHash)) {
      throw new Error("PCASH head changed during wallet synchronization");
    }
    // The feed rows are the node's word; every committed step must reproduce
    // the roots of the anchor header, which is bound to the target's hash.
    if (synced.outputs.count !== anchor.state.outputCount || synced.outputs.root() !== anchor.state.outputRoot) {
      throw new Error("synchronized output tree does not match the anchor block's output root");
    }
    if (synced.accountCount !== anchor.state.accountCount || synced.accountRoot() !== anchor.state.accountStateRoot) {
      throw new Error("synchronized account set does not match the anchor block's account root");
    }
    reconcileBulkRecoveryObservations(data, status.latestBlockTimestamp, anchor.header.timestamp);

    for (const note of data.notes) {
      if (note.pending || note.commitment === null) continue;
      const consumption = synced.consumed.get(noteNullifier(note, nk));
      note.spent = consumption !== undefined;
      // A spend finality has settled no longer needs the note's witness.
      const leafIndex = BigInt(note.leafIndex!);
      if (consumption !== undefined && consumption.pcashNumber <= status.finalizedBlock
        && synced.outputs.isMarked(leafIndex)) {
        synced.outputs.unmark(leafIndex);
      }
    }

    data.nextOutputIndex = outputCount.toString();
    data.syncedThrough = { blockNumber: stepTarget.pcashNumber.toString(), blockHash: stepTarget.pcashHash.toLowerCase() };
    data.finalizedThrough = {
      blockNumber: status.finalizedBlock.toString(),
      blockHash: status.finalizedBlockHash.toLowerCase(),
    };
    retainWalletReceiveKey(data, wallet);
    const commit = synced.finishStep({ anchor, finalizedBlock: status.finalizedBlock, watched });
    const persist = options.persist ?? (() => undefined);
    await persistAndPublish(destination, data, async () => persist(data, { state: synced, commit }));
    return {
      ...report,
      startedAtOutputIndex,
      syncedThrough: stepTarget,
      nextOutputIndex: outputCount,
    };
  });
}

/** Check a restored profile against its synced account; null when the address has none. */
export async function assertPcashProfileAccount(
  store: WalletStateStore,
  profile: PcashProfile,
  status: StatusResult,
): Promise<PcashProfileAccountView | null> {
  const account = await store.readChain((chain) => {
    if (chain === null) throw new WalletSyncRequiredError("wallet has no synced account state; sync first");
    return chain.accountResult(addressHex(profile.address));
  });
  if (account !== null) {
    assertPcashProfileMatchesAccount(profile, account, networkConfigFromStatus(status));
  }
  return account;
}
