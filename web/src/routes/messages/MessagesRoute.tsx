import { useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { BoardPost, BoardThread, PendingPost } from "@pcash/board";
import { Notice } from "../../components/Notice.tsx";
import { RelativeTime } from "../../components/RelativeTime.tsx";
import { RouteHeader } from "../../components/RouteHeader.tsx";
import { useWallet } from "../../lib/WalletProvider.tsx";
import { searchPath, transactionPath } from "../explorer/paths.ts";
import { Metadata } from "../Metadata.tsx";
import { NotFound } from "../NotFound.tsx";
import { routeById } from "../routeManifest.ts";
import { shortValue } from "../wallet/model.ts";
import paper from "../PaperPage.module.css";
import { Composer } from "./Composer.tsx";
import { useBoardThreads, useThread, type BoardView, type MessagesNode } from "./useBoard.ts";
import styles from "./Messages.module.css";

const messagesRoute = routeById("messages");
const threadRoute = routeById("message-thread");
const TITLE_CHARACTERS = 60;

export default function MessagesRoute() {
  const { "*": rest = "" } = useParams();
  const node = useWallet().node as MessagesNode;
  const postId = rest === "" ? undefined : rest.toLowerCase();
  if (postId !== undefined && !/^0x[0-9a-f]{64}$/.test(postId)) return <NotFound />;
  return <section className={`${paper.page} ${styles.stack}`}>
    {postId === undefined ? <Board node={node} /> : <Thread key={postId} node={node} postId={postId} />}
  </section>;
}

function Board({ node }: { node: MessagesNode }) {
  const { view, loadMore, refresh } = useBoardThreads(node);
  return <>
    <Metadata {...messagesRoute.metadata} />
    <RouteHeader eyebrow="Testnet board" title="Messages" description="Anonymous public posts on PCASH. Anyone can read them; no one can tell which account wrote one." />
    <BoardStatus view={view} />
    {view.state === "ready" && <div className={styles.columns}>
      <section aria-labelledby="threads-heading">
        <h2 id="threads-heading" className={styles.heading}>Threads</h2>
        {view.data.threads.length === 0 && view.data.pending.length === 0
          ? <p className={styles.empty}><strong>No threads yet</strong>Start the first one.</p>
          : <ol className={styles.threads}>
            {view.data.pending.map((post) => <PendingThreadRow key={post.id} post={post} />)}
            {view.data.threads.map((thread) => <ThreadRow key={thread.root.id} thread={thread} />)}
          </ol>}
        {view.data.next !== null && <MoreButton label="Older threads" load={loadMore} />}
      </section>
      <section className="panel" aria-labelledby="compose-heading">
        <h2 id="compose-heading" className={styles.heading}>Start a thread</h2>
        <Composer network={view.network} onSent={refresh} />
      </section>
    </div>}
  </>;
}

function ThreadRow({ thread }: { thread: BoardThread }) {
  const replies = thread.postCount - 1n;
  return <li><Link to={`${messagesRoute.path}/${thread.root.id}`} className={styles.threadRow}>
    <span className={`${styles.text} ${styles.excerpt}`} dir="auto">{thread.root.text}</span>
    <span className={styles.meta}>
      {thread.root.missingParent && <span>Replies to a post that is not on this board</span>}
      <span>{replies === 1n ? "1 reply" : `${replies} replies`}</span>
      <span>Last post <RelativeTime seconds={thread.latestTimestamp} suffix /></span>
    </span>
  </Link></li>;
}

function PendingThreadRow({ post }: { post: PendingPost }) {
  return <li><Link to={`${messagesRoute.path}/${post.id}`} className={`${styles.threadRow} ${styles.pending}`}>
    <span className={`${styles.text} ${styles.excerpt}`} dir="auto">{post.text}</span>
    <span className={styles.meta}><span>Pending: waiting for the network to include it</span></span>
  </Link></li>;
}

function MoreButton({ label, load }: { label: string; load: () => Promise<void> }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  return <div className={styles.more}>
    <button type="button" className="button" disabled={loading} onClick={() => {
      setLoading(true);
      setError(undefined);
      load().catch((cause: unknown) => setError(String(cause instanceof Error ? cause.message : cause))).finally(() => setLoading(false));
    }}>{loading ? "Loading…" : label}</button>
    {error !== undefined && <Notice tone="error">{error}</Notice>}
  </div>;
}

type ThreadPost = BoardPost | PendingPost;

function Thread({ node, postId }: { node: MessagesNode; postId: string }) {
  const { phase, busy } = useWallet();
  const { view, loadMore, refresh } = useThread(node, postId);
  const [replyTo, setReplyTo] = useState<ThreadPost>();
  const field = useRef<HTMLTextAreaElement>(null);
  const data = view.state === "ready" ? view.data : undefined;
  const root: ThreadPost | undefined = data?.thread?.root ?? data?.pending[0];
  const posts: ThreadPost[] = data === undefined ? [] : data.thread === null ? data.pending : [data.thread.root, ...data.replies, ...data.pending];
  const reply = (post: ThreadPost | undefined) => {
    setReplyTo(post);
    field.current?.focus();
  };
  return <>
    <Metadata title={root === undefined ? threadRoute.metadata.title : threadTitle(root.text)} description={threadRoute.metadata.description} />
    <RouteHeader eyebrow="Messages" title="Thread" description="A post and every reply to it, in the order the network included them." />
    <p><Link to={messagesRoute.path}>← All threads</Link></p>
    <BoardStatus view={view} />
    {view.state === "ready" && (root === undefined
      ? <Notice>This post is not on the board yet. A new post appears once the network includes it.</Notice>
      : <div className={styles.columns}>
        <div className={styles.stack}>
          <ol className={styles.posts} aria-label="Posts">
            {posts.map((post) => <li key={post.id}>
              <article id={post.id} className={`${styles.post} ${post.pending ? styles.pending : ""}`} data-pending={post.pending || undefined}
                data-selected={(post !== root && post.id === postId) || undefined}>
                <header className={styles.meta}>
                  <Link to={transactionPath(post.pending ? post.contentHash : post.transactionId)} title="View the transaction"><code>{shortValue(post.id)}</code></Link>
                  {post.pending ? <>
                    <span>Pending</span>
                    <span>expires in <RelativeTime seconds={post.validUntil} until /></span>
                    {/* Search resolves the hash to its block's page. */}
                    <span>recent block <Link to={searchPath(post.recentPcashBlockHash)}><code>{shortValue(post.recentPcashBlockHash)}</code></Link></span>
                  </> : <RelativeTime seconds={post.timestamp} suffix />}
                  {!post.pending && post.missingParent ? <span>Replies to a post that is not on this board</span>
                    : post.parent !== null && post.parent !== root.id && <a href={`#${post.parent}`}>replying to <code>{shortValue(post.parent)}</code></a>}
                </header>
                <p className={styles.text} dir="auto">{post.text}</p>
                {phase === "ready" && <button type="button" className={styles.linkButton} disabled={busy} aria-label={`Reply to ${shortValue(post.id)}`}
                  onClick={() => reply(post === root ? undefined : post)}>Reply</button>}
              </article>
            </li>)}
          </ol>
          {data?.next !== null && data?.next !== undefined && <MoreButton label="More replies" load={loadMore} />}
        </div>
        <section className="panel" aria-labelledby="reply-heading">
          <h2 id="reply-heading" className={styles.heading}>Reply</h2>
          {replyTo !== undefined && <div className={styles.replyingTo}>
            <p className={styles.meta}>
              <span>Replying to <a href={`#${replyTo.id}`}><code>{shortValue(replyTo.id)}</code></a></span>
              <button type="button" className={styles.linkButton} disabled={busy} onClick={() => reply(undefined)}>Reply to the thread instead</button>
            </p>
            <p className={`${styles.text} ${styles.excerpt}`} dir="auto">{replyTo.text}</p>
          </div>}
          <Composer ref={field} network={view.network} parent={(replyTo ?? root).id} onSent={refresh} />
        </section>
      </div>)}
  </>;
}

/** A thread's tab title: the first line of its root post, shortened. */
function threadTitle(text: string): string {
  const characters = Array.from(text.trim().split("\n")[0]!);
  return characters.length > TITLE_CHARACTERS ? `${characters.slice(0, TITLE_CHARACTERS).join("").trimEnd()}…` : characters.join("");
}

function BoardStatus({ view }: { view: BoardView<unknown> }) {
  if (view.state === "loading") return <p className={styles.statusLine} role="status"><span className="spinner" aria-hidden="true" />Reading posts from the network…</p>;
  return view.state === "failed" ? <Notice tone="error">The board could not be read: {view.message}</Notice> : null;
}
