import { test } from "node:test";
import assert from "node:assert/strict";
import { applicationSchemaId, memoSchema, type DataRecord } from "@pcash/sdk/delivery";
import { toHex } from "@pcash/sdk/utils";
import { boardId, decodePost, encodePost, type Post } from "../src/codec.ts";
import { getThread, getThreads, pendingPosts, type BoardNode } from "../src/pboard.ts";
import { board, fixture, network } from "./fixture.ts";

const nonce = (n: number) => "0x" + n.toString(16).padStart(2, "0").repeat(32);
test("UTF-8 byte bounds and malformed records", () => {
  const { record, post } = encodePost(network, { board, text: "🙂".repeat(256) });
  assert.equal(decodePost(network, [record])?.text, post.text);
  assert.throws(() => encodePost(network, { board, text: "🙂".repeat(257) }));
  assert.throws(() => encodePost(network, { board, text: "\ud800" }));
  assert.throws(() => encodePost(network, { board, text: "" }));
  const reply = encodePost(network, { board, parent: post.id, text: "a" }).record;
  for (const data of [
    record.data.subarray(0, 64), // truncated nonce
    Uint8Array.of(0x01, ...record.data.subarray(1)), // unused bitmap bit
    Uint8Array.of(...record.data.subarray(0, 65), 0xff), // invalid UTF-8
    record.data.subarray(0, 65), // empty text
    Uint8Array.of(0x00, ...reply.data.subarray(1)), // parent read as the nonce, nonce bytes as text
  ]) assert.equal(decodePost(network, [{ ...record, data }]), null);
  assert.equal(decodePost(network, [memoSchema.encode("hi")]), null);
  assert.equal(decodePost(network, null), null);
  assert.throws(() => boardId("General"));
});

test("nonce, parent, board and chain bind post identity", () => {
  const a = fixture();
  assert.notEqual(encodePost(network, { board, text: "hello" }).post.id, a.post.id);
  assert.notEqual(decodePost({ ...network, chainId: network.chainId + 1n }, [a.record])!.id, a.post.id);
  assert.notEqual(decodePost({ ...network, genesisHash: "0x" + "12".repeat(32) }, [a.record])!.id, a.post.id);
  assert.notEqual(encodePost(network, { board, text: "hello", nonce: a.post.nonce, parent: a.post.id }).post.id, a.post.id);
  assert.notEqual(encodePost(network, { board: boardId("other"), text: "hello", nonce: a.post.nonce }).post.id, a.post.id);
});

test("frozen post encoding and identifier vector", () => {
  const root = encodePost({ chainId: 1n, genesisHash: "0x" + "11".repeat(32) }, { board: boardId("general"), text: "Hello, PCASH! 🌏", nonce: "0x" + "22".repeat(32) });
  const general = "56706d86e8fd3368489abd4b5bb347102ba126afae50c82520b527205d8cc921";
  const text = "48656c6c6f2c2050434153482120f09f8c8f";
  assert.equal(root.record.schema, applicationSchemaId("org.pcash.board.post"));
  // bitmap (no parent) ‖ board ‖ nonce ‖ text
  assert.equal(toHex(root.record.data), "0x00" + general + "22".repeat(32) + text);
  assert.equal(root.post.id, "0x33db8ba0a749c8de6746eb67c67e9486501ba4637fc2d7d81ea5d372d03355b2");
  const reply = encodePost({ chainId: 1n, genesisHash: "0x" + "11".repeat(32) }, { board: boardId("general"), parent: root.post.id, text: "Hello, PCASH! 🌏", nonce: "0x" + "22".repeat(32) });
  // bitmap (parent present) ‖ board ‖ parent ‖ nonce ‖ text
  assert.equal(toHex(reply.record.data), "0x80" + general + root.post.id.slice(2) + "22".repeat(32) + text);
});

const word = (n: number) => "0x" + n.toString(16).padStart(64, "0");

function postJson(post: Post, at: number, threadId = post.id) {
  return { ...post, threadId, missingParent: false, origin: { blockNumber: "0x1", blockHash: word(1) }, timestamp: "0x64",
    outputIndex: `0x${at.toString(16)}`, transactionId: word(at + 100), contentHash: word(at + 200) };
}

test("board reads page through the pboard namespace", async () => {
  const root = fixture("root", nonce(1)).post;
  const reply = encodePost(network, { board, parent: root.id, text: "reply", nonce: nonce(2) }).post;
  const calls: { method: string; params: unknown[] }[] = [];
  const node = {
    call: async (method: string, params: unknown[] = []) => {
      calls.push({ method, params });
      const thread = { root: postJson(root, 0), postCount: "0x2", latestOutputIndex: "0x5", latestTimestamp: "0x65" };
      if (method === "pboard_getThreads") return { items: [thread], nextCursor: "0x5" };
      if (method === "pboard_getThread") return { thread, replies: { items: [postJson(reply, 5, root.id)], nextCursor: null } };
      throw new Error(method);
    },
    getMempool: async () => { throw new Error("unused"); },
  } as unknown as BoardNode;
  const threads = await getThreads(node, { board, limit: 20 });
  assert.equal(threads.nextCursor, 5n);
  assert.equal(threads.items[0]!.root.text, "root");
  assert.equal(threads.items[0]!.postCount, 2n);
  await getThreads(node, { board, cursor: 5n });
  assert.deepEqual(calls.map(call => call.params[0]), [{ board, limit: "0x14" }, { board, cursor: "0x5" }]);
  const thread = await getThread(node, { id: reply.id });
  assert.equal(thread!.replies.items[0]!.parent, root.id);
  assert.equal(thread!.replies.items[0]!.threadId, root.id);
  assert.equal(thread!.replies.items[0]!.pending, false);
});

test("pending posts come from the mempool's arena filter and are decoded again", async () => {
  const a = fixture("waiting", nonce(1));
  const other = encodePost(network, { board: boardId("other"), text: "elsewhere", nonce: nonce(2) });
  const queries: unknown[] = [];
  const item = (records: readonly DataRecord[], n: number) => ({ contentHash: word(n), receivedAtUnixMs: BigInt(n), validUntil: BigInt(1000 + n), recentPcashBlockHash: word(100 + n), publicRecords: records });
  const node = {
    call: async () => { throw new Error("unused"); },
    getMempool: async (query: unknown) => {
      queries.push(query);
      return queries.length === 1
        ? { items: [item([a.record], 1), item([memoSchema.encode("not a post")], 2)], nextCursor: word(2) }
        : { items: [item([a.record], 3), item([other.record], 4)], nextCursor: null };
    },
  } as unknown as BoardNode;
  const pending = await pendingPosts(node, network, board);
  assert.deepEqual(pending.map(post => [post.id, post.pending, post.contentHash, post.validUntil, post.recentPcashBlockHash]),
    [[a.post.id, true, word(1), 1001n, word(101)]]);
  const query = { kind: "privateValue", arena: { schema: a.record.schema, data: [{ offset: 1, bytes: board }] }, limit: 256 };
  assert.deepEqual(queries[0], query);
  assert.deepEqual(queries[1], { ...query, cursor: word(2) });
});
