// Direct sends this wallet owns. A direct send's envelope is keyed by its note
// secret, so trial decryption cannot find it: the wallet keeps each opening,
// imported from its link or read back from its own sender regions, and
// synchronization matches the funding output it names. A link is imported
// only once that output is accepted and the link opens it, so the wallet keeps
// one opening per output. Until a final transaction of this wallet records an
// opening, the setup mining action, or else the first transaction that spends
// the note, carries that record.

import { OutputOpeningMismatchError, pollReceipt, type PcashNodeClient, type ReceiptResult } from "@pcash/sdk/clients";
import { PRIVATE_VALUE_PROFILES } from "@pcash/sdk/constants";
import {
  claimedSenderSchema,
  decodeDirectSendOpening,
  decodeTransaction,
  directSendOpeningsSchema,
  directSendOutputCommitment,
  directSendOutputKey,
  directSendRecords,
  encodeDirectSendOpening,
  encodeRecords,
  memoSchema,
  planArena,
  RECORD_SCHEMA,
  TX_KIND_PRIVATE_VALUE,
  type DirectSendOpening,
} from "@pcash/sdk/protocol";
import { addressHex, fromHex, toHex } from "@pcash/sdk/utils";
import type { StoredDirectSendOpening, WalletFileData, WalletNote } from "./noteStore.ts";

export function directSendOpenings(data: WalletFileData | null): DirectSendOpening[] {
  return (data?.directSendOpenings ?? []).map((stored) => decodeDirectSendOpening(fromHex(stored.opening)));
}

/**
 * Keep an opening, and the earliest transaction that records it when the
 * caller saw one. An opening that names a kept output replaces the kept one
 * when it comes from the wallet's own record, or when the kept one never
 * opened a note. Returns whether the wallet's opening for that output is new
 * or changed.
 */
export function addDirectSendOpening(
  data: WalletFileData,
  opening: DirectSendOpening,
  record?: NonNullable<StoredDirectSendOpening["record"]>,
): boolean {
  const key = directSendOutputKey(opening);
  const list = data.directSendOpenings ??= [];
  const existing = list.find((stored) => directSendOutputKey(decodeDirectSendOpening(fromHex(stored.opening))) === key);
  if (existing === undefined) {
    list.push({ opening: toHex(encodeDirectSendOpening(opening)), ...(record === undefined ? {} : { record }) });
    return true;
  }
  if (record !== undefined && (existing.record === undefined || BigInt(record.leafIndex) < BigInt(existing.record.leafIndex))) {
    existing.record = record;
  }
  return false;
}

/** Forget the records of transactions a reorganization removed. */
export function dropDirectSendRecords(data: WalletFileData, fromLeafIndex: bigint): void {
  for (const stored of data.directSendOpenings ?? []) {
    if (stored.record !== undefined && BigInt(stored.record.leafIndex) >= fromLeafIndex) delete stored.record;
  }
}

/** The confirmed note an opening created, once this wallet holds it. */
export function directSendNote(data: WalletFileData, opening: DirectSendOpening): WalletNote | undefined {
  return data.notes.find((note) => !note.pending && note.commitment !== null && isDirectSendNote(note, opening));
}

function isDirectSendNote(note: Pick<WalletNote, "owner" | "noteSecret" | "amount" | "assetId">, opening: DirectSendOpening): boolean {
  return BigInt(note.owner) === opening.owner && BigInt(note.noteSecret) === opening.noteSecret
    && BigInt(note.amount) === opening.amount && BigInt(note.assetId) === 0n;
}

/** Whether a transaction at or below the wallet's finalized head records the opening. */
export function directSendSaved(data: WalletFileData, opening: DirectSendOpening): boolean {
  const key = directSendOutputKey(opening);
  const record = data.directSendOpenings?.find((stored) => directSendOutputKey(decodeDirectSendOpening(fromHex(stored.opening))) === key)?.record;
  return record !== undefined && data.finalizedThrough !== undefined
    && BigInt(record.blockNumber) <= BigInt(data.finalizedThrough.blockNumber);
}

/**
 * The openings a transaction's sender region must record: with `spending`,
 * those its inputs spend; without, for the setup mining action, every opening
 * this wallet owns that its sender region holds. Openings a final transaction
 * already records are left out.
 */
export function directSendsToRecord(
  data: WalletFileData | null,
  owner: bigint,
  spending?: readonly Pick<WalletNote, "owner" | "noteSecret" | "amount" | "assetId">[],
): DirectSendOpening[] {
  if (data === null) return [];
  let openings = directSendOpenings(data)
    .filter((opening) => opening.owner === owner && !directSendSaved(data, opening))
    .filter((opening) => spending === undefined || spending.some((note) => isDirectSendNote(note, opening)));
  if (spending === undefined) {
    while (openings.length > 0 && !planArena({
      shape: PRIVATE_VALUE_PROFILES.S.shapeId, sender: encodeRecords([directSendOpeningsSchema.encode(openings)]).length, regions: [],
    }).fits) {
      openings = openings.slice(0, -1);
    }
  }
  return openings;
}

/** A direct-send link pays an address other than the wallet's own. */
export class DirectSendOwnerError extends Error {
  /** The address the link pays, lowercase 0x-hex. */
  readonly owner: string;

  constructor(owner: string) {
    super(`this direct send pays ${owner}; open it with that address's wallet`);
    this.name = "DirectSendOwnerError";
    this.owner = owner;
  }
}

/** What the node shows of a direct send's funding output; needs no wallet. */
export type DirectSendFunding =
  | { status: "pending" }
  /** Included without succeeding; a later inclusion of the same bytes can still succeed. */
  | { status: "rejected" }
  /** With the memo and claimed sender its envelope carries, if any. */
  | { status: "landed"; leafIndex: bigint; memo?: string; sender?: string }
  /** The output the opening names holds another note: the link is wrong. */
  | { status: "invalid" };

export async function inspectDirectSend(node: PcashNodeClient, opening: DirectSendOpening): Promise<DirectSendFunding> {
  const receipt = await pollReceipt(node, opening.contentHash);
  if (receipt === null) return { status: "pending" };
  if (receipt.outcome !== "succeeded" || receipt.outputLeafStart === null) return { status: "rejected" };
  if (BigInt(opening.slot) >= receipt.outputsAdded) return { status: "invalid" };
  const leafIndex = receipt.outputLeafStart + BigInt(opening.slot);
  try {
    const paths = await node.getOutputPaths([{ outputIndex: leafIndex, outputCommitment: directSendOutputCommitment(opening, leafIndex) }]);
    if (paths === null) return { status: "pending" };
  } catch (error) {
    if (error instanceof OutputOpeningMismatchError) return { status: "invalid" };
    throw error;
  }
  return { status: "landed", leafIndex, ...await directSendMessage(node, opening, receipt) };
}

/** The memo and claimed sender the funding transaction's envelope carries for the opening. */
async function directSendMessage(node: PcashNodeClient, opening: DirectSendOpening, receipt: ReceiptResult): Promise<{ memo?: string; sender?: string }> {
  const found = await node.getTransaction(receipt.transactionId);
  if (found === null || receipt.nullifiers === null) return {};
  try {
    const transaction = decodeTransaction(fromHex(found.rawTransaction));
    if (transaction.kind !== TX_KIND_PRIVATE_VALUE) return {};
    const records = directSendRecords(opening, transaction.outputData[opening.slot]!, {
      arena: transaction.arena,
      shape: transaction.shape,
      context: { chainId: opening.chainId, transactionType: TX_KIND_PRIVATE_VALUE, nullifiers: receipt.nullifiers.map(BigInt) },
    });
    const memo = records?.find((record) => record.schema === RECORD_SCHEMA.memo);
    const sender = records?.find((record) => record.schema === RECORD_SCHEMA.sender);
    return {
      ...(memo === undefined ? {} : { memo: memoSchema.decode(memo.data) }),
      ...(sender === undefined ? {} : { sender: addressHex(claimedSenderSchema.decode(sender.data)) }),
    };
  } catch {
    // The sender wrote these records; one that does not decode shows nothing.
    return {};
  }
}

/** A direct send this wallet received. */
export interface WalletReceivedDirectSend {
  opening: DirectSendOpening;
  /** `waiting` until this wallet holds the note, then `received`, then `spent`. */
  state: "waiting" | "received" | "spent";
  /** A final transaction of this wallet records the opening, so a restore from the seed finds it. */
  saved: boolean;
}

export function receivedDirectSends(data: WalletFileData | null): WalletReceivedDirectSend[] {
  if (data === null) return [];
  return directSendOpenings(data).filter((opening) => opening.owner === BigInt(data.address)).map((opening) => {
    const note = directSendNote(data, opening);
    return {
      opening,
      state: note === undefined ? "waiting" : note.spent ? "spent" : "received",
      saved: directSendSaved(data, opening),
    };
  });
}

/** A direct send this wallet paid: journaled until scanning recovers it from the sender region. */
export function paidDirectSends(data: WalletFileData | null, chainId: bigint): { opening: DirectSendOpening; included: boolean }[] {
  if (data === null) return [];
  const included = (data.sentOutputs ?? [])
    .filter((output) => output.directSend === true && BigInt(output.assetId) === 0n)
    .map((output) => ({ opening: {
      chainId, contentHash: output.contentHash.toLowerCase(), slot: output.slot, owner: BigInt(output.recipientAddress),
      amount: BigInt(output.amount), noteSecret: BigInt(output.noteSecret),
    }, included: true }));
  const known = new Set(included.map(({ opening }) => directSendOutputKey(opening)));
  const pending = (data.pendingNoteFundedTransfers ?? [])
    .filter((transfer) => transfer.directSendNoteSecret !== undefined)
    .map((transfer) => ({ opening: {
      chainId, contentHash: transfer.contentHash.toLowerCase(), slot: 0, owner: BigInt(transfer.recipientAddress),
      amount: BigInt(transfer.transferAmount), noteSecret: BigInt(transfer.directSendNoteSecret!),
    }, included: false }))
    .filter(({ opening }) => !known.has(directSendOutputKey(opening)));
  return [...included, ...pending];
}
