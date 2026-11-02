import { memoSchema, readPublicRecords } from "@pcash/sdk/delivery";
import { openNodeWallet } from "@pcash/wallet";
import assert from "node:assert/strict";
import { boardId, boardPostSchema, boardStatus, decodePost, encodePost, getPosts, getThread, type BoardNode, type BoardPost } from "@pcash/board";
import { deferSubmission } from "@pcash/sdk/wallet";
import { fromHex, toHex, addressHex } from "@pcash/sdk/utils";
import { decodeTransactionForChain, encodeBatch, posterPayoutOpening } from "@pcash/sdk/protocol";
import { randomFieldEntropy } from "@pcash/sdk/utils";
import type { ScenarioFixture } from "../fixture/scenarioFixture.ts";
import { setupUserWallets } from "./setup.ts";
import { l1Rpc } from "../backends/rpc.ts";
import { eventually } from "../framework/eventually.ts";
import { listSpendableNotes } from "../actors/sdk.ts";

export async function runBoardScenario(fixture: ScenarioFixture): Promise<void> {
  await setupUserWallets(fixture, { actors: ["S", "R", "T"], accounts: ["S", "R", "T"], funded: ["S"] });
  const S = fixture.actors.S!, R = fixture.actors.R!, T = fixture.actors.T!;
  const status = await fixture.nodeA.client.status();
  const network = { chainId: fixture.network.pcashChainId, genesisHash: status.genesisHash };
  const board = boardId("general");
  // Each node's board index, oldest first; the index follows the node's derived index and may lag it.
  const listed = async (node: BoardNode): Promise<BoardPost[]> => (await getPosts(node, { board, limit: 200 })).items.reverse();
  const indexed = (label: string, node: BoardNode, satisfied: (ids: string[]) => boolean) =>
    eventually(label, () => listed(node), posts => satisfied(posts.map(post => post.id)), { timeoutMs: 60000, intervalMs: 250 });
  assert.equal((await fixture.nodeA.client.catalogInfo()).status, "disabled");
  const s = await S.client(), r = await R.client(), t = await T.client();
  const root = encodePost(network, { board, text: "A public post with a hidden account." });
  let rootBytes: Uint8Array = new Uint8Array();
  const rootResult = await s.publishData({
    data: { recipients: [{ to: R.address, records: [memoSchema.encode("Only R can read this.")] },
      { to: T.address, records: [memoSchema.encode("Only T can read this.")] }], self: [memoSchema.encode("Sender private annotation.")], public: [root.record] },
    openFeeAmount: 1n, onPrepared: (_hash, bytes) => { rootBytes = fromHex(bytes); },
  });
  await fixture.waitForAcceptedAcrossNodes(rootResult.contentHash, "board-root");
  for (const [wallet, expected] of [[r, "Only R can read this."], [t, "Only T can read this."]] as const) {
    await wallet.sync();
    const rows = await wallet.transactionData({ schema: memoSchema.id });
    const row = rows.find(row => row.contentHash === rootResult.contentHash)!;
    assert.ok(row);
    assert.deepEqual(row.received.flatMap(group => group.records), [memoSchema.encode(expected)]);
    assert.deepEqual(row.self, []); assert.deepEqual(row.sent, []);
    assert.equal((await wallet.balances({ assetId: 0n }))[0]?.private ?? 0n, 0n);
  }
  const fresh = await openNodeWallet({ dataDir: fixture.artifacts.path("board-sender-restored"), node: fixture.nodeA.client, profile: S.wallet });
  try {
    await fresh.sync();
    const row = (await fresh.transactionData({ schema: memoSchema.id })).find(row => row.contentHash === rootResult.contentHash)!;
    assert.deepEqual(row.self, [memoSchema.encode("Sender private annotation.")]);
    assert.deepEqual(row.sent.map(group => group.records), [[memoSchema.encode("Only R can read this.")], [memoSchema.encode("Only T can read this.")]]);
    assert.equal(decodePost(network, row.public)?.id, root.post.id);
  } finally { await fresh.close(); }
  const decoded = decodeTransactionForChain(rootBytes, network.chainId);
  assert.equal(decoded.kind, 0);
  if (decoded.kind !== 0) throw new Error("unexpected board transaction");
  assert.deepEqual(readPublicRecords(decoded.arena)?.map(record => record.schema), [boardPostSchema.id]);

  const reply = encodePost(network, { board, parent: root.post.id, text: "An independent anonymous reply." });
  const replyResult = await r.publishData({ openFeeAmount: 0n, data: { public: [reply.record] }, submission: fixture.harness.l1(R.wallet) });
  await fixture.waitForAcceptedAcrossNodes(replyResult.contentHash, "board-reply");
  // Another account republishing the root's record publishes the same post, listed once at its first inclusion.
  const copyResult = await r.publishData({ openFeeAmount: 0n, data: { public: [root.record] }, submission: fixture.harness.l1(R.wallet) });
  await fixture.waitForAcceptedAcrossNodes(copyResult.contentHash, "board-copied-envelope");
  const [rootReceipt] = await fixture.nodeA.client.getReceipt({ contentHash: rootResult.contentHash });
  assert.ok(rootReceipt);
  const carrier = await l1Rpc<{ blockHash: string; gasUsed: string; effectiveGasPrice: string; blobGasUsed?: string; blobGasPrice?: string }>(fixture.backend.rpcUrl, "eth_getTransactionReceipt", [rootReceipt.inclusion.l1TransactionHash]);
  assert.equal(carrier.blockHash.toLowerCase(), rootReceipt.inclusion.l1BlockHash.toLowerCase());
  const containingBatchCostWei = BigInt(carrier.gasUsed) * BigInt(carrier.effectiveGasPrice)
    + BigInt(carrier.blobGasUsed ?? "0") * BigInt(carrier.blobGasPrice ?? "0");
  const fundedBalance = await S.balance();
  const restored = await listSpendableNotes(fixture.nodeA.client, S.wallet, network.chainId);
  assert.equal(restored.reduce((sum, note) => sum + note.amount, 0n), fundedBalance);
  await fixture.waitForNodesAtL1Head();
  const both = (ids: string[]) => ids.length === 2;
  const onA = await indexed("node A to index the board", fixture.nodeA.client, both);
  const onB = await indexed("node B to index the board", fixture.nodeB.client, both);
  assert.deepEqual(onA.map(post => post.id), [root.post.id, reply.post.id]);
  assert.deepEqual(onA, onB);
  const thread = await getThread(fixture.nodeA.client, { id: reply.post.id });
  assert.equal(thread?.thread.root.id, root.post.id);
  assert.equal(thread?.thread.postCount, 2n);
  assert.deepEqual(thread?.replies.items.map(post => post.id), [reply.post.id]);
  const altered = rootBytes.slice(); altered[altered.length - 2632 + 32 + 20]! ^= 1;
  await fixture.submitExpectingRejection(altered, "board-altered-content");
  await S.close(); await R.close();
  await fixture.restartNode("B");
  assert.deepEqual(await indexed("node B to reopen its board index", fixture.nodeB.client, both), onA);

  // Prove before freezing L1; publish exact journaled bytes onto both branches.
  const rAgain = await R.client();
  const orphan = encodePost(network, { board, parent: root.post.id, text: "This reply follows a replaced branch." });
  let orphanBytes: Uint8Array = new Uint8Array();
  const prepared = await rAgain.publishData({ openFeeAmount: 0n, data: { public: [orphan.record], self: [memoSchema.encode("orphan-self")] },
    submission: deferSubmission(fixture.harness.mempool({ relay: false })),
    onPrepared: (_hash, bytes) => { orphanBytes = fromHex(bytes); },
  });
  await R.close();
  const resumed = await (await R.client()).publishData({ openFeeAmount: 0n, data: { public: [orphan.record], self: [memoSchema.encode("orphan-self")] },
    retryContentHash: prepared.contentHash, submission: deferSubmission(fixture.harness.mempool({ relay: false })),
    onPrepared: (_hash, bytes) => assert.deepEqual(fromHex(bytes), orphanBytes),
  });
  assert.equal(resumed.contentHash, prepared.contentHash);
  const backend = fixture.backend;
  if (!backend.snapshot || !backend.revert || !backend.mine || !backend.setNextTimestamp) throw new Error("board reorg needs Anvil controls");
  const interval = await l1Rpc<number>(backend.rpcUrl, "anvil_getIntervalMining", []);
  await l1Rpc(backend.rpcUrl, "evm_setAutomine", [false]);
  await l1Rpc(backend.rpcUrl, "evm_setIntervalMining", [0]);
  try {
    await fixture.waitForNodesAtL1Head();
    const parent = await l1Rpc<{ timestamp: string }>(backend.rpcUrl, "eth_getBlockByNumber", ["latest", false]);
    const snapshot = await backend.snapshot();
    const opening = posterPayoutOpening(S.wallet.address, S.wallet.nkRoot, randomFieldEntropy());
    const batch = encodeBatch([orphanBytes], opening.ownerCommitment, opening.context);
    const post = async () => {
      const sent = await fixture.harness.submitter.sendCall({ to: addressHex(fixture.network.inboxAddress), data: toHex(batch) });
      await backend.mine!(1); return sent.settle();
    };
    const receipt = await post();
    await fixture.waitForAcceptedAcrossNodes(prepared.contentHash, "board-before-reorg");
    await indexed("node B to index the reply before the reorg", fixture.nodeB.client, ids => ids.includes(orphan.post.id));
    await (await R.client()).sync();
    assert.ok((await (await R.client()).transactionData()).some(row => row.contentHash === prepared.contentHash));
    await backend.revert(snapshot);
    await l1Rpc(backend.rpcUrl, "anvil_dropTransaction", [receipt.txHash]);
    await backend.setNextTimestamp(BigInt(parent.timestamp) + 2n);
    // The follower discovers replacement parents when L1 advances beyond its old tip.
    await backend.mine(2);
    const replacement = await l1Rpc<{ hash: string }>(backend.rpcUrl, "eth_getBlockByNumber", ["latest", false]);
    await eventually("both board nodes to replace the suffix", async () => Promise.all([fixture.nodeA.client.status(), fixture.nodeB.client.status()]),
      states => states.every(state => state.latestL1BlockHash.toLowerCase() === replacement.hash.toLowerCase()), { timeoutMs: 120000, intervalMs: 250 });
    await indexed("node B to drop the replaced reply", fixture.nodeB.client, ids => !ids.includes(orphan.post.id));
    await (await R.client()).sync();
    assert.ok(!(await (await R.client()).transactionData()).some(row => row.contentHash === prepared.contentHash));
    await post(); await fixture.waitForAcceptedAcrossNodes(prepared.contentHash, "board-after-reorg");
    const three = (ids: string[]) => ids.length === 3 && ids.includes(orphan.post.id);
    const afterB = await indexed("node B to index the reply again", fixture.nodeB.client, three);
    const afterA = await indexed("node A to index the reply again", fixture.nodeA.client, three);
    await (await R.client()).sync();
    assert.equal((await (await R.client()).transactionData()).filter(row => row.contentHash === prepared.contentHash).length, 1);
    assert.deepEqual(afterB, afterA);
  } finally {
    await l1Rpc(backend.rpcUrl, "evm_setAutomine", [true]);
    await l1Rpc(backend.rpcUrl, "evm_setIntervalMining", [interval]);
  }
  fixture.artifacts.record("board-readiness", { rootPost: root.post.id, replyPost: reply.post.id, transactionBytes: rootBytes.length,
    containingBatchCostWei, openFeeAtomicUnits: rootReceipt.settledOpenFeeAmount, issuanceAtomicUnits: rootReceipt.settledIssuanceAmount,
    boardIndex: await boardStatus(fixture.nodeA.client),
    peakRssBytes: process.resourceUsage().maxRSS * 1024, catalogRequired: false, canonicality: "locally-derived-nodes" });
}
