import { defineRecordSchema, packed, type DataRecord } from "@pcash/sdk/delivery";
import { beBytes, concatBytes, fromHexSized, keccak256, toHex, utf8 } from "@pcash/sdk/utils";

export interface BoardNetwork { chainId: bigint; genesisHash: string }
export interface Post { id: string; board: string; parent: string | null; nonce: string; text: string }
export const MAX_TEXT_BYTES = 1024;

/** A public post: its board, the post it replies to, a nonce that keeps equal texts distinct, and the text. */
export const boardPostSchema = defineRecordSchema("org.pcash.board.post", packed.struct({
  board: packed.bytes(32),
  parent: packed.optional(packed.bytes(32)),
  nonce: packed.bytes(32),
  text: packed.rest.text(),
}));

const digest = (bytes: Uint8Array) => toHex(keccak256(bytes));

export function boardId(name: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) throw new Error("board name must be 1–64 lowercase letters, digits or hyphens");
  return digest(concatBytes(utf8("pcash.board.name\0"), utf8(name)));
}
/** The record bytes bound to one network: the same record on another chain is another post. */
function postId(network: BoardNetwork, data: Uint8Array): string {
  return digest(concatBytes(utf8("pcash.board.post\0"), beBytes(network.chainId, 4), fromHexSized(network.genesisHash, 32, "genesis hash"), data));
}
function textBytes(text: string): number {
  return utf8(text).length;
}
export function encodePost(network: BoardNetwork, input: { board: string; parent?: string | null; text: string; nonce?: string }): { post: Post; record: DataRecord } {
  const length = textBytes(input.text);
  if (length === 0 || length > MAX_TEXT_BYTES) throw new Error(`post must contain 1–${MAX_TEXT_BYTES} UTF-8 bytes`);
  const record = boardPostSchema.encode({
    board: fromHexSized(input.board, 32, "board"),
    ...(input.parent === undefined || input.parent === null ? {} : { parent: fromHexSized(input.parent, 32, "parent") }),
    nonce: input.nonce === undefined ? crypto.getRandomValues(new Uint8Array(32)) : fromHexSized(input.nonce, 32, "nonce"),
    text: input.text,
  });
  return { post: decodePost(network, [record])!, record };
}
/** Untrusted public records: a missing, malformed or oversized post is not a post. */
export function decodePost(network: BoardNetwork, records: readonly DataRecord[] | null): Post | null {
  const record = records?.find(candidate => candidate.schema === boardPostSchema.id);
  if (record === undefined) return null;
  let value: ReturnType<typeof boardPostSchema.decode>;
  try {
    value = boardPostSchema.decode(record.data);
  } catch {
    return null;
  }
  const length = textBytes(value.text);
  if (length === 0 || length > MAX_TEXT_BYTES) return null;
  return {
    id: postId(network, record.data),
    board: toHex(value.board),
    parent: value.parent === undefined ? null : toHex(value.parent),
    nonce: toHex(value.nonce),
    text: value.text,
  };
}
