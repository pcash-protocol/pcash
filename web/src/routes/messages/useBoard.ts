import { useCallback, useEffect, useRef, useState } from "react";
import { boardId, getThread, getThreads, pendingPosts, type BoardNetwork, type BoardNode, type BoardPage, type BoardPost, type BoardThread, type PendingPost } from "@pcash/board";
import type { PcashNodeClient } from "@pcash/sdk/clients";
import { errorMessage } from "../../lib/WalletProvider.tsx";

/** The one board this site shows. */
export const BOARD = boardId("general");
/** Posts arrive with Ethereum blocks; a few polls a minute find them without loading the node. */
const POLL_MS = 10_000;
/** Threads or replies one request reads. */
export const PAGE_SIZE = 30;

export type MessagesNode = BoardNode & Pick<PcashNodeClient, "status">;
export type BoardView<T> =
  | { state: "loading" }
  | { state: "failed"; message: string }
  | { state: "ready"; network: BoardNetwork; data: T };
export interface Polled<T> {
  view: BoardView<T>;
  /** Read the next page, if any. */
  loadMore: () => Promise<void>;
  /** Refresh at once, as after sending a post. */
  refresh: () => void;
}

export interface BoardData {
  threads: BoardThread[];
  next: bigint | null;
  /** Pages read so far; each refresh reads them again from the start. */
  pages: number;
  /** New threads waiting in the node's mempool. */
  pending: PendingPost[];
}
export interface ThreadData {
  /** Null while the post is not on the board. */
  thread: BoardThread | null;
  replies: BoardPost[];
  next: bigint | null;
  pages: number;
  /** The thread's posts still in the node's mempool, the root too when it is pending. */
  pending: PendingPost[];
}

/**
 * Reads `load` from the node's board index while the tab is visible. A failed
 * refresh keeps what was already read.
 */
function usePolled<T>(node: MessagesNode, key: string,
  load: (network: BoardNetwork, current: T | undefined) => Promise<T>,
  more: (network: BoardNetwork, current: T) => Promise<T>): Polled<T> {
  const [view, setView] = useState<BoardView<T>>({ state: "loading" });
  const latest = useRef<{ network: BoardNetwork; data: T }>(undefined);
  const pollNow = useRef<() => void>(() => {});
  const loader = useRef({ load, more });
  loader.current = { load, more };
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    latest.current = undefined;
    setView({ state: "loading" });
    const poll = async () => {
      clearTimeout(timer);
      if (document.visibilityState !== "hidden") {
        try {
          let network = latest.current?.network;
          if (network === undefined) {
            const status = await node.status();
            network = { chainId: BigInt(status.pcashChainId), genesisHash: status.genesisHash };
          }
          const data = await loader.current.load(network, latest.current?.data);
          if (!stopped) {
            latest.current = { network, data };
            setView({ state: "ready", network, data });
          }
        } catch (cause) {
          const message = errorMessage(cause);
          if (!stopped) setView((current) => current.state === "ready" ? current : { state: "failed", message });
        }
      }
      if (!stopped) timer = setTimeout(() => void poll(), POLL_MS);
    };
    pollNow.current = () => void poll();
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [node, key]);
  const loadMore = useCallback(async () => {
    const current = latest.current;
    if (current === undefined) return;
    const data = await loader.current.more(current.network, current.data);
    if (latest.current !== current) return;
    latest.current = { network: current.network, data };
    setView({ state: "ready", network: current.network, data });
  }, []);
  const refresh = useCallback(() => pollNow.current(), []);
  return { view, loadMore, refresh };
}

function byActivity(threads: Iterable<BoardThread>): BoardThread[] {
  const unique = new Map<string, BoardThread>();
  for (const thread of threads) if (!unique.has(thread.root.id)) unique.set(thread.root.id, thread);
  return [...unique.values()].sort((a, b) => a.latestOutputIndex > b.latestOutputIndex ? -1 : a.latestOutputIndex < b.latestOutputIndex ? 1 : 0);
}

/**
 * Reads up to `pages` pages from the start. A reorg or a late parent can change
 * any page already read, so a refresh replaces them all rather than appending.
 */
async function readPages<T>(read: (cursor: bigint | null) => Promise<BoardPage<T> | null>, pages: number): Promise<{ items: T[]; next: bigint | null; pages: number } | null> {
  const items: T[] = [];
  let next: bigint | null = null;
  let count = 0;
  do {
    const page = await read(next);
    if (page === null) return null;
    items.push(...page.items);
    next = page.nextCursor;
    count++;
  } while (count < pages && next !== null);
  return { items, next, pages: count };
}

/** The board's threads, newest activity first, and new threads still pending. */
export function useBoardThreads(node: MessagesNode): Polled<BoardData> {
  const threadsFrom = (cursor: bigint | null) => getThreads(node, { board: BOARD, cursor, limit: PAGE_SIZE });
  return usePolled<BoardData>(node, BOARD, async (network, current) => {
    const [read, pending] = await Promise.all([readPages(threadsFrom, current?.pages ?? 1), pendingPosts(node, network, BOARD)]);
    const threads = byActivity(read!.items);
    const roots = new Set(threads.map((thread) => thread.root.id));
    return { threads, next: read!.next, pages: read!.pages, pending: pending.filter((post) => post.parent === null && !roots.has(post.id)) };
  }, async (_network, current) => {
    if (current.next === null) return current;
    const page = await threadsFrom(current.next);
    return { ...current, threads: byActivity([...current.threads, ...page.items]), next: page.nextCursor, pages: current.pages + 1 };
  });
}

/** Pending posts that join the thread of `members`: replies to a member, and replies to those. */
function pendingIn(pending: readonly PendingPost[], members: Iterable<string>): PendingPost[] {
  const known = new Set(members);
  const joined: PendingPost[] = [];
  for (let changed = true; changed;) {
    changed = false;
    for (const post of pending) {
      if (known.has(post.id) || post.parent === null || !known.has(post.parent)) continue;
      known.add(post.id);
      joined.push(post);
      changed = true;
    }
  }
  return joined.sort((a, b) => a.receivedAtUnixMs < b.receivedAtUnixMs ? -1 : a.receivedAtUnixMs > b.receivedAtUnixMs ? 1 : 0);
}

/** The thread `postId` belongs to, its replies in chain order, and its posts still pending. */
export function useThread(node: MessagesNode, postId: string): Polled<ThreadData> {
  return usePolled<ThreadData>(node, postId, async (network, current) => {
    // Every page names the thread; the last one read is the freshest.
    const seen: { thread?: BoardThread } = {};
    const repliesFrom = async (cursor: bigint | null) => {
      const page = await getThread(node, { id: postId, cursor, limit: PAGE_SIZE });
      if (page === null) return null;
      seen.thread = page.thread;
      return page.replies;
    };
    const [read, pending] = await Promise.all([readPages(repliesFrom, current?.pages ?? 1), pendingPosts(node, network, BOARD)]);
    if (read === null || seen.thread === undefined) {
      const waiting = pending.find((post) => post.id === postId);
      return { thread: null, replies: [], next: null, pages: 1, pending: waiting === undefined ? [] : [waiting, ...pendingIn(pending, [waiting.id])] };
    }
    const indexed = new Set([seen.thread.root.id, ...read.items.map((reply) => reply.id)]);
    return { thread: seen.thread, replies: read.items, next: read.next, pages: read.pages, pending: pendingIn(pending, indexed) };
  }, async (_network, current) => {
    if (current.thread === null || current.next === null) return current;
    const page = await getThread(node, { id: postId, cursor: current.next, limit: PAGE_SIZE });
    if (page === null) return current;
    return { ...current, replies: [...current.replies, ...page.replies.items], next: page.replies.nextCursor, pages: current.pages + 1 };
  });
}
