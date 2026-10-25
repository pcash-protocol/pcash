// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { boardId, decodePost, encodePost, type Post } from "@pcash/board";
import type { WalletPaymentStage } from "../../lib/WalletProvider.tsx";
import { shortValue } from "../wallet/model.ts";

const PCASH = 10n ** 18n;
const network = { chainId: 7n, genesisHash: `0x${"11".repeat(32)}` };
const hash = (n: number): `0x${string}` => `0x${n.toString(16).padStart(64, "0")}`;

const state = vi.hoisted(() => ({
  wallet: {
    phase: "ready", busy: false, paymentStage: { state: "idle" } as WalletPaymentStage, progress: undefined, awaitingSignature: false, walletPromptOpen: false,
    selfPublication: {} as object | undefined,
    funds: { spendablePrivate: 0n } as { spendablePrivate: bigint } | undefined,
    wallet: { address: "0x" + "ab".repeat(20) },
    node: undefined as unknown,
    preflightPrivateSend: vi.fn(), sendPrivate: vi.fn(), cancelPrivateSend: vi.fn(), resetPrivateSend: vi.fn(), signIn: vi.fn(),
  },
}));
vi.mock("../../lib/WalletProvider.tsx", () => ({
  errorMessage: (error: unknown) => String(error),
  useWallet: () => state.wallet,
  WalletPaymentCanceledError: class extends Error {},
}));
vi.mock("../../lib/EthereumProvider.tsx", () => ({ useEthereumNetwork: () => ({ l1ChainId: 1 }) }));
vi.mock("../../lib/usePaymentIssuance.ts", () => ({ usePaymentIssuance: () => ({ issuance: PCASH / 5n, inputs: {} }) }));
vi.mock("../../lib/useFastSendEstimate.ts", () => ({ useFastSendEstimate: (enabled: boolean) => enabled
  ? { state: "ready", estimatedCostWei: 10n ** 14n, maximumCostWei: 2n * 10n ** 14n, collectibleOpenFee: 0n, expectedIssuance: 0n, companions: 0, ownIncluded: 0 }
  : undefined }));
vi.mock("../wallet/OwnerPanels.tsx", () => ({ useWalletPanel: () => ({ openOverview: vi.fn() }) }));
import MessagesRoute from "./MessagesRoute.tsx";

const board = boardId("general");
const quantity = (n: number | bigint) => `0x${n.toString(16)}`;
type Served = { call: (method: string, params: [{ id?: string; board?: string; cursor?: string; limit?: string }]) => Promise<unknown>; mempool: () => unknown };
const served: { current: Served | undefined } = { current: undefined };
/**
 * Serves the board index over `posts`, in chain order, and the mempool
 * holding `pending`, through one node object that later calls re-serve. A
 * post's thread is its oldest indexed ancestor's, as when a late parent
 * adopts earlier replies.
 */
function feed(posts: readonly { text: string; parent?: Post | undefined }[], pending: readonly { text: string; parent?: Post | undefined }[] = []) {
  const encode = (list: typeof posts, offset: number) => list.map(({ text, parent }, index) => encodePost(network, { board, text, parent: parent?.id ?? null, nonce: hash(offset + index + 1) }));
  const encoded = encode(posts, 0);
  const waiting = encode(pending, 1000);
  const byId = new Map(encoded.map(({ post }) => [post.id, post]));
  const rootOf = (post: Post): string => post.parent !== null && byId.has(post.parent) ? rootOf(byId.get(post.parent)!) : post.id;
  const rows = encoded.map(({ post }, index) => ({ ...post, threadId: rootOf(post), missingParent: post.parent !== null && !byId.has(post.parent),
    origin: { blockNumber: quantity(index), blockHash: hash(index) }, timestamp: quantity(1_700_000_000 + index),
    outputIndex: quantity(index), transactionId: hash(100 + index), contentHash: hash(200 + index) }));
  const thread = (id: string) => {
    const members = rows.filter((row) => row.threadId === id);
    const latest = members.at(-1)!;
    return { root: rows.find((row) => row.id === id)!, postCount: quantity(members.length), latestOutputIndex: latest.outputIndex, latestTimestamp: latest.timestamp };
  };
  const page = <T,>(items: T[], limit: string | undefined, cursorOf: (item: T) => string) => {
    const size = limit === undefined ? 50 : Number(limit);
    return { items: items.slice(0, size), nextCursor: items.length > size ? cursorOf(items[size - 1]!) : null };
  };
  served.current = {
    call: async (method, [query]) => {
      if (method === "pboard_getThreads") {
        const roots = [...new Set(rows.map((row) => row.threadId))].map(thread)
          .sort((a, b) => Number(BigInt(b.latestOutputIndex) - BigInt(a.latestOutputIndex)))
          .filter((entry) => query.cursor === undefined || BigInt(entry.latestOutputIndex) < BigInt(query.cursor));
        return page(roots, query.limit, (entry) => entry.latestOutputIndex);
      }
      if (method === "pboard_getThread") {
        const row = rows.find((candidate) => candidate.id === query.id);
        if (row === undefined) return null;
        const replies = rows.filter((candidate) => candidate.threadId === row.threadId && candidate.id !== row.threadId
          && (query.cursor === undefined || BigInt(candidate.outputIndex) > BigInt(query.cursor)));
        return { thread: thread(row.threadId), replies: page(replies, query.limit, (reply) => reply.outputIndex) };
      }
      throw new Error(`unexpected ${method}`);
    },
    mempool: () => ({ items: waiting.map(({ record }, index) => ({ contentHash: hash(500 + index), receivedAtUnixMs: BigInt(index),
      validUntil: BigInt(Math.floor(Date.now() / 1000) + 600), recentPcashBlockHash: hash(600), publicRecords: [record] })), nextCursor: null }),
  };
  return [...encoded, ...waiting].map(({ post }) => post);
}

let element: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.wallet.phase = "ready";
  state.wallet.paymentStage = { state: "idle" };
  state.wallet.funds = { spendablePrivate: 10n * PCASH };
  state.wallet.selfPublication = {};
  for (const mock of [state.wallet.preflightPrivateSend, state.wallet.sendPrivate, state.wallet.resetPrivateSend]) mock.mockReset();
  served.current = undefined;
  state.wallet.node = {
    status: async () => ({ pcashChainId: network.chainId, genesisHash: network.genesisHash }),
    call: (method: string, params: Parameters<Served["call"]>[1]) => served.current!.call(method, params),
    getMempool: async () => served.current!.mempool(),
  };
  element = document.createElement("div");
  document.body.append(element);
  root = createRoot(element);
});
afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
  element.remove();
  vi.unstubAllGlobals();
});

async function render(path: string) {
  await act(async () => {
    root.render(<MemoryRouter initialEntries={[path]}><Routes><Route path="/messages/*" element={<MessagesRoute />} /></Routes></MemoryRouter>);
  });
  await settle();
}
async function settle() {
  for (let flush = 0; flush < 5; flush++) {
    await act(async () => { await (vi.isFakeTimers() ? vi.advanceTimersByTimeAsync(0) : new Promise((resolve) => setTimeout(resolve, 0))); });
  }
}
/** Lets the page's next poll read the node again. */
async function poll() {
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  await settle();
}
const texts = () => Array.from(element.querySelectorAll("article")).map((article) => article.querySelector("p")!.textContent);
function button(label: string): HTMLButtonElement {
  return Array.from(element.querySelectorAll("button")).find((candidate) => candidate.textContent === label)!;
}
function speed(label: "Faster" | "More private"): HTMLInputElement {
  return Array.from(element.querySelectorAll<HTMLInputElement>("input[type=radio]")).find((input) => input.parentElement?.textContent === label)!;
}
async function type(text: string) {
  const textarea = element.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, text);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("Messages", () => {
  it("lists threads by latest activity with their reply counts", async () => {
    const [first] = feed([{ text: "first thread" }, { text: "second thread" }]);
    feed([{ text: "first thread" }, { text: "second thread" }, { text: "a late reply", parent: first }]);
    await render("/messages");
    const rows = Array.from(element.querySelectorAll("li")).map((row) => row.textContent);
    expect(rows[0]).toContain("first thread");
    expect(rows[0]).toContain("1 reply");
    expect(rows[1]).toContain("second thread");
    expect(rows[1]).toContain("0 replies");
    expect(element.querySelector(`a[href="/messages/${first!.id}"]`)).not.toBeNull();
  });

  it("shows posts still in the mempool as pending", async () => {
    const [rootPost] = feed([{ text: "root" }]);
    feed([{ text: "root" }], [{ text: "waiting thread" }, { text: "waiting reply", parent: rootPost }]);
    await render("/messages");
    const rows = Array.from(element.querySelectorAll("li"));
    expect(rows[0]!.textContent).toContain("waiting thread");
    expect(rows[0]!.textContent).toContain("Pending");
    expect(rows[0]!.querySelector("a")!.className).toContain("pending");
    expect(rows).toHaveLength(2);

    act(() => root.unmount());
    root = createRoot(element);
    await render(`/messages/${rootPost!.id}`);
    const articles = Array.from(element.querySelectorAll("article"));
    expect(articles.map((article) => article.querySelector("p")!.textContent)).toEqual(["root", "waiting reply"]);
    expect(articles[1]!.dataset.pending).toBe("true");
    expect(articles[0]!.dataset.pending).toBeUndefined();
    // Each post's hash opens its transaction: the included one, or the submission still in the mempool.
    expect(articles.map((article) => article.querySelector("header a")!.getAttribute("href"))).toEqual([`/tx/${hash(100)}`, `/tx/${hash(501)}`]);
    // A pending post names when it expires and the recent block its proof uses.
    expect(articles[1]!.textContent).toMatch(/expires in (9|10)m/);
    expect(articles[1]!.querySelector(`a[href="/search?q=${hash(600)}"]`)).not.toBeNull();
  });

  it("drops a thread that a reorg removed on the next poll", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    feed([{ text: "kept" }, { text: "replaced" }]);
    await render("/messages");
    expect(element.querySelectorAll("li")).toHaveLength(2);
    feed([{ text: "kept" }]);
    await poll();
    const rows = Array.from(element.querySelectorAll("li")).map((row) => row.textContent);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain("kept");
  });

  it("drops a reply that a reorg removed on the next poll", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const [rootPost] = feed([{ text: "root" }]);
    feed([{ text: "root" }, { text: "replaced reply", parent: rootPost }]);
    await render(`/messages/${rootPost!.id}`);
    expect(texts()).toEqual(["root", "replaced reply"]);
    feed([{ text: "root" }]);
    await poll();
    expect(texts()).toEqual(["root"]);
  });

  it("shows earlier replies a late parent brings into a thread whose pages are all loaded", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    // The orphan comes first in chain order; its parent, a reply to the root, arrives last.
    const rootPost = encodePost(network, { board, text: "root", parent: null, nonce: hash(2) }).post;
    const replies = Array.from({ length: 31 }, (_, index) => ({ text: `reply ${index}`, parent: rootPost }));
    const lateParent = encodePost(network, { board, text: "late parent", parent: rootPost.id, nonce: hash(34) }).post;
    const before = [{ text: "orphan", parent: lateParent }, { text: "root" }, ...replies];
    expect(feed(before)[1]!.id).toBe(rootPost.id);
    await render(`/messages/${rootPost.id}`);
    await act(async () => { button("More replies").click(); });
    await settle();
    expect(texts()).toHaveLength(32);
    expect(feed([...before, { text: "late parent", parent: rootPost }])[33]!.id).toBe(lateParent.id);
    await poll();
    expect(texts()).toEqual(["root", "orphan", ...replies.map((reply) => reply.text), "late parent"]);
  });

  it("shows every reply in a thread as plain text, and marks a reply to a reply", async () => {
    const [root] = feed([{ text: "root" }]);
    const reply = encodePost(network, { board, text: "reply", parent: root!.id, nonce: hash(2) }).post;
    feed([{ text: "root" }, { text: "reply", parent: root }, { text: "<b>nested</b>", parent: reply }, { text: "elsewhere" }]);
    await render(`/messages/${root!.id}`);
    const posts = Array.from(element.querySelectorAll("article")).map((article) => article.querySelector("p")!.textContent);
    expect(posts).toEqual(["root", "reply", "<b>nested</b>"]);
    expect(element.querySelector("article b")).toBeNull();
    expect(element.querySelectorAll("article")[2]!.textContent).toContain(`replying to ${shortValue(reply.id)}`);
  });

  it("sends a reply to a reply in one click as a relayed zero-value publication of one public record", async () => {
    const [root] = feed([{ text: "root" }]);
    const [, reply] = feed([{ text: "root" }, { text: "reply", parent: root }]);
    await render(`/messages/${root!.id}`);
    const review = { openFeeAmount: PCASH, publication: "open", retry: false };
    state.wallet.preflightPrivateSend.mockResolvedValue(review);
    state.wallet.sendPrivate.mockResolvedValue({ contentHash: hash(999), accepted: true });
    await act(async () => element.querySelector<HTMLButtonElement>(`button[aria-label="Reply to ${shortValue(reply!.id)}"]`)!.click());
    expect(document.activeElement).toBe(element.querySelector("textarea"));
    expect(element.textContent).toContain(`Replying to ${shortValue(reply!.id)}`);
    await type("hello back");
    expect(element.textContent).toContain("Network fee: 1");
    await act(async () => button("Post").click());

    const intent = state.wallet.preflightPrivateSend.mock.calls[0]![0];
    expect(intent).toEqual({ to: state.wallet.wallet.address, amount: 0n, openFeeAmount: PCASH, publication: "open", data: { public: [expect.anything()] } });
    expect(decodePost(network, intent.data.public)).toMatchObject({ board, parent: reply!.id, text: "hello back" });
    expect(state.wallet.sendPrivate).toHaveBeenCalledWith(intent, review);
    expect(element.querySelector("textarea")!.value).toBe("");
    expect(element.textContent).toContain(`Transaction successful ${shortValue(hash(999))}`);
    expect(element.querySelector(`a[href="/tx/${hash(999)}"]`)).not.toBeNull();

    // Changing speed clears the result so the next post starts fresh.
    await act(async () => speed("Faster").click());
    expect(element.textContent).not.toContain("Transaction successful");
  });

  it("posts Faster from the Ethereum wallet, which needs no PCASH and is named as the sender", async () => {
    feed([{ text: "root" }]);
    state.wallet.funds = { spendablePrivate: 0n };
    await render("/messages");
    await type("hello");
    expect(element.textContent).toContain("Get PCASH first, or choose Faster.");
    expect(button("Post").disabled).toBe(true);

    await act(async () => speed("Faster").click());
    expect(element.textContent).toContain("anyone can link that account to your post");
    expect(button("Post").disabled).toBe(false);
    const review = { openFeeAmount: 0n, publication: "self", retry: false };
    state.wallet.preflightPrivateSend.mockResolvedValue(review);
    state.wallet.sendPrivate.mockResolvedValue({ contentHash: hash(999), publication: "self", accepted: true });
    expect(element.textContent).toMatch(/Network fee: Ethereum gas about .+, up to .+, paid by your Ethereum wallet/);
    await act(async () => button("Post").click());

    const intent = state.wallet.preflightPrivateSend.mock.calls[0]![0];
    expect(intent).toEqual({ to: state.wallet.wallet.address, amount: 0n, publication: "self", data: { public: [expect.anything()] } });
    expect(decodePost(network, intent.data.public)).toMatchObject({ board, parent: null, text: "hello" });
    expect(state.wallet.sendPrivate).toHaveBeenCalledWith(intent, review);
    expect(speed("More private").disabled).toBe(false);
  });

  it("says a Faster post is waiting on Ethereum once the wallet has sent it", async () => {
    feed([{ text: "root" }]);
    await render("/messages");
    await type("hello");
    await act(async () => speed("Faster").click());
    state.wallet.preflightPrivateSend.mockResolvedValue({ openFeeAmount: 0n, publication: "self", retry: false });
    state.wallet.sendPrivate.mockImplementation(() => {
      state.wallet.paymentStage = { state: "l1-submitted", attemptId: 1, l1Hash: hash(7) };
      return new Promise(() => {});
    });
    await act(async () => button("Post").click());
    expect(element.textContent).toContain("Sent to Ethereum. Waiting for it to be included");
    expect(element.textContent).not.toContain("Proving your post");
    expect(element.querySelector(`a[href="https://etherscan.io/tx/${hash(7)}"]`)).not.toBeNull();
  });

  it("offers Faster only once the Ethereum wallet can post", async () => {
    feed([{ text: "root" }]);
    state.wallet.selfPublication = undefined;
    await render("/messages");
    expect(speed("Faster").disabled).toBe(true);
    expect(speed("More private").checked).toBe(true);
  });

  it("moves focus to the composer when replying to the thread, keeping the draft", async () => {
    const [root] = feed([{ text: "root" }]);
    const [, reply] = feed([{ text: "root" }, { text: "reply", parent: root }]);
    await render(`/messages/${root!.id}`);
    await act(async () => element.querySelector<HTMLButtonElement>(`button[aria-label="Reply to ${shortValue(reply!.id)}"]`)!.click());
    await type("kept text");
    await act(async () => button("Reply to the thread instead").click());
    expect(document.activeElement).toBe(element.querySelector("textarea"));
    expect(element.querySelector("textarea")!.value).toBe("kept text");
  });

  it("asks for a wallet instead of offering to post, and refuses a malformed post link", async () => {
    feed([{ text: "root" }]);
    state.wallet.phase = "disconnected";
    await render("/messages");
    expect(element.textContent).toContain("Connect a wallet to start a thread.");
    expect(element.querySelector("textarea")).toBeNull();
    act(() => root.unmount());
    root = createRoot(element);
    await render("/messages/0x1234");
    expect(element.textContent).toContain("Not found");
  });
});
