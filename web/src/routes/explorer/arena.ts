import { decodePost, type BoardNetwork } from "@pcash/board/codec";
import {
  ARENA_CELL_BYTES,
  ARENA_SALT_BYTES,
  decodeTransaction,
  readPublicRecords,
  TX_KIND_PRIVATE_VALUE,
  TX_KIND_USER_ACCOUNT_UPDATE,
  type DataRecord,
} from "@pcash/sdk/protocol";
import { fromHex, toHex } from "@pcash/sdk/utils";

/** The arena of the transaction's private-value section, or null when it carries none. */
export function transactionArena(rawTransaction: string): Uint8Array | null {
  const transaction = decodeTransaction(fromHex(rawTransaction, "raw transaction"));
  if (transaction.kind === TX_KIND_PRIVATE_VALUE) return transaction.arena;
  if (transaction.kind === TX_KIND_USER_ACCOUNT_UPDATE) return transaction.section.arena;
  return null;
}

export type DecodedRecord =
  | { kind: "boardPost"; schema: string; data: string; postId: string; board: string; parent: string | null; text: string }
  | { kind: "unknown"; schema: string; data: string; text: string | null };

export interface DecodedArena {
  salt: string;
  cells: number;
  /** The public segment's records, or null when the arena has none. */
  publicRecords: DecodedRecord[] | null;
}

function utf8Text(data: Uint8Array): string | null {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(data);
    // Control characters other than whitespace mean the bytes are not meant as text.
    return text.length > 0 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text) ? text : null;
  } catch {
    return null;
  }
}

function decodeRecord(network: BoardNetwork, record: DataRecord): DecodedRecord {
  const data = toHex(record.data);
  const post = decodePost(network, [record]);
  if (post !== null) return { kind: "boardPost", schema: record.schema, data, postId: post.id, board: post.board, parent: post.parent, text: post.text };
  return { kind: "unknown", schema: record.schema, data, text: utf8Text(record.data) };
}

/**
 * Everything a reader without keys can learn from an arena: its salt, cells,
 * and the plaintext public segment. Every other cell is encrypted to a
 * recipient or the sender, or random filler, and needs their keys to read.
 */
export function decodeArena(network: BoardNetwork, arena: Uint8Array): DecodedArena {
  return {
    salt: toHex(arena.subarray(0, ARENA_SALT_BYTES)),
    cells: (arena.length - ARENA_SALT_BYTES) / ARENA_CELL_BYTES,
    publicRecords: readPublicRecords(arena)?.map(record => decodeRecord(network, record)) ?? null,
  };
}
