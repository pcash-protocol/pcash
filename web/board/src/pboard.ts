import type { MempoolQuery, PcashNodeClient } from "@pcash/sdk/clients";
import { decodePost, boardPostSchema, type BoardNetwork, type Post } from "./codec.ts";

/** A post where the chain first included it, read from the node's board index. */
export interface BoardPost extends Post {
  pending: false;
  /** The root post of the post's thread. */
  threadId: string;
  /** The post replies to a post that is not on its board. */
  missingParent: boolean;
  blockNumber: bigint;
  blockHash: string;
  /** Block timestamp, in seconds. */
  timestamp: bigint;
  outputIndex: bigint;
  transactionId: string;
  contentHash: string;
}
/** A post waiting in the node's mempool: submitted, not yet included. */
export interface PendingPost extends Post {
  pending: true;
  contentHash: string;
  /** When the node received it, in milliseconds. */
  receivedAtUnixMs: bigint;
  /** The last block timestamp, in seconds, that can include it. */
  validUntil: bigint;
  /** The recent PCASH block its proof is built against. */
  recentPcashBlockHash: string;
}
export interface BoardThread {
  root: BoardPost;
  /** The root and every reply. */
  postCount: bigint;
  latestOutputIndex: bigint;
  latestTimestamp: bigint;
}
export interface BoardPage<T> {
  items: T[];
  /** Pass as the next request's cursor; null on the last page. */
  nextCursor: bigint | null;
}
export interface BoardStatus {
  /** The block the board index has reached; null before its first sync. */
  cursor: { blockNumber: bigint; blockHash: string; nextOutputIndex: bigint } | null;
  postCount: bigint;
}
export type BoardNode = Pick<PcashNodeClient, "call" | "getMempool">;

type Json = Record<string, unknown>;

function object(value: unknown, label: string): Json {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Json;
}
function quantity(value: unknown, label: string): bigint {
  if (typeof value !== "string" || !/^0x[0-9a-f]+$/i.test(value)) throw new Error(`${label} must be a hex quantity`);
  return BigInt(value);
}
function hash(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^0x[0-9a-f]{64}$/i.test(value)) throw new Error(`${label} must be a 32-byte hex string`);
  return value.toLowerCase();
}
function cursorParam(cursor: bigint | null | undefined): Json {
  return cursor === undefined || cursor === null ? {} : { cursor: `0x${cursor.toString(16)}` };
}
function limitParam(limit: number | undefined): Json {
  return limit === undefined ? {} : { limit: `0x${limit.toString(16)}` };
}

function parsePost(value: unknown, label: string): BoardPost {
  const post = object(value, label);
  const origin = object(post.origin, `${label}.origin`);
  if (typeof post.text !== "string") throw new Error(`${label}.text must be a string`);
  if (typeof post.missingParent !== "boolean") throw new Error(`${label}.missingParent must be a boolean`);
  return {
    pending: false,
    id: hash(post.id, `${label}.id`),
    board: hash(post.board, `${label}.board`),
    parent: post.parent === null ? null : hash(post.parent, `${label}.parent`),
    nonce: hash(post.nonce, `${label}.nonce`),
    text: post.text,
    threadId: hash(post.threadId, `${label}.threadId`),
    missingParent: post.missingParent,
    blockNumber: quantity(origin.blockNumber, `${label}.origin.blockNumber`),
    blockHash: hash(origin.blockHash, `${label}.origin.blockHash`),
    timestamp: quantity(post.timestamp, `${label}.timestamp`),
    outputIndex: quantity(post.outputIndex, `${label}.outputIndex`),
    transactionId: hash(post.transactionId, `${label}.transactionId`),
    contentHash: hash(post.contentHash, `${label}.contentHash`),
  };
}
function parseThread(value: unknown, label: string): BoardThread {
  const thread = object(value, label);
  return {
    root: parsePost(thread.root, `${label}.root`),
    postCount: quantity(thread.postCount, `${label}.postCount`),
    latestOutputIndex: quantity(thread.latestOutputIndex, `${label}.latestOutputIndex`),
    latestTimestamp: quantity(thread.latestTimestamp, `${label}.latestTimestamp`),
  };
}
function parsePage<T>(value: unknown, label: string, item: (value: unknown, label: string) => T): BoardPage<T> {
  const page = object(value, label);
  if (!Array.isArray(page.items)) throw new Error(`${label}.items must be an array`);
  return {
    items: page.items.map((entry, index) => item(entry, `${label}.items[${index}]`)),
    nextCursor: page.nextCursor === null ? null : quantity(page.nextCursor, `${label}.nextCursor`),
  };
}

export async function boardStatus(node: BoardNode): Promise<BoardStatus> {
  const status = object(await node.call("pboard_status"), "pboard_status");
  const cursor = status.cursor === null ? null : object(status.cursor, "pboard_status.cursor");
  return {
    cursor: cursor === null ? null : {
      blockNumber: quantity(object(cursor.block, "cursor.block").blockNumber, "cursor.block.blockNumber"),
      blockHash: hash(object(cursor.block, "cursor.block").blockHash, "cursor.block.blockHash"),
      nextOutputIndex: quantity(cursor.nextOutputIndex, "cursor.nextOutputIndex"),
    },
    postCount: quantity(status.postCount, "pboard_status.postCount"),
  };
}

/** A board's threads, newest activity first. */
export async function getThreads(node: BoardNode, query: { board: string; cursor?: bigint | null; limit?: number }): Promise<BoardPage<BoardThread>> {
  const value = await node.call("pboard_getThreads", [{ board: query.board, ...cursorParam(query.cursor), ...limitParam(query.limit) }]);
  return parsePage(value, "pboard_getThreads", parseThread);
}

/** A board's posts, newest first. */
export async function getPosts(node: BoardNode, query: { board: string; cursor?: bigint | null; limit?: number }): Promise<BoardPage<BoardPost>> {
  const value = await node.call("pboard_getPosts", [{ board: query.board, ...cursorParam(query.cursor), ...limitParam(query.limit) }]);
  return parsePage(value, "pboard_getPosts", parsePost);
}

/** The thread a post belongs to, whether it is the root or a reply, and its replies in chain order. */
export async function getThread(node: BoardNode, query: { id: string; cursor?: bigint | null; limit?: number }): Promise<{ thread: BoardThread; replies: BoardPage<BoardPost> } | null> {
  const value = await node.call("pboard_getThread", [{ id: query.id, ...cursorParam(query.cursor), ...limitParam(query.limit) }]);
  if (value === null) return null;
  const page = object(value, "pboard_getThread");
  return { thread: parseThread(page.thread, "pboard_getThread.thread"), replies: parsePage(page.replies, "pboard_getThread.replies", parsePost) };
}

export async function getPost(node: BoardNode, id: string): Promise<BoardPost | null> {
  const value = await node.call("pboard_getPost", [id]);
  return value === null ? null : parsePost(value, "pboard_getPost");
}

/** Mempool pages a pending read follows; the mempool holds a few thousand entries at most. */
const MAX_PENDING_PAGES = 20;

/**
 * Posts to `board` in the node's mempool, newest received first. The node
 * matches the board in each arena's public record; the records are untrusted,
 * so each is decoded again here.
 */
export async function pendingPosts(node: BoardNode, network: BoardNetwork, board: string): Promise<PendingPost[]> {
  const posts = new Map<string, PendingPost>();
  // The board indexes only private-value transactions. The record's data opens
  // with a one-byte bitmap, then the board.
  const query: MempoolQuery = { kind: "privateValue", arena: { schema: boardPostSchema.id, data: [{ offset: 1, bytes: board }] }, limit: 256 };
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PENDING_PAGES; page++) {
    const result = await node.getMempool({ ...query, ...(cursor === undefined ? {} : { cursor }) });
    for (const item of result.items) {
      const post = decodePost(network, item.publicRecords);
      if (post === null || post.board !== board.toLowerCase() || posts.has(post.id)) continue;
      // A private-value section always carries both.
      posts.set(post.id, { ...post, pending: true, contentHash: item.contentHash, receivedAtUnixMs: item.receivedAtUnixMs,
        validUntil: item.validUntil!, recentPcashBlockHash: item.recentPcashBlockHash! });
    }
    if (result.nextCursor === null) break;
    cursor = result.nextCursor;
  }
  return [...posts.values()];
}
