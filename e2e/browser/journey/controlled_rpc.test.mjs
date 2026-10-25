import protocolVectors from "../../../vectors/protocol_vectors.json" with { type: "json" };
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeBlockHash, computeStateRoot, genesisParentHash, transactionId } from "@pcash/sdk/protocol";
import { SparseMerkleTree } from "@pcash/sdk/crypto";
import { MERKLE_DEPTH } from "@pcash/sdk/constants";
import { PcashNodeClient } from "@pcash/sdk/clients";
import { createPublicClient, http } from "viem";
import { bytes32FromHex, bytes32Hex, fromHex, keccak256, toHex } from "@pcash/sdk/utils";
import {
  startControlledRpc,
  TEST_BLOCK_0,
  TEST_BLOCK_1,
  TEST_STATUS,
  TEST_RELAY_L1_HASH,
  TEST_RELAY_CONTENT_HASH,
  TEST_RELAY_BATCH,
  TEST_RELAY_RAW,
  TEST_RELAY_CONFLICT_CONTENT_HASH,
  TEST_RELAY_OVERSIZED_CONTENT_HASH,
} from "./controlled_rpc.mjs";
import { FIXED_ACCOUNT } from "./injected_provider.mjs";

const FIXED_ADDRESS = `0x${"ab".repeat(20)}`;

function header(block) {
  return {
    parentHash: BigInt(block.parentHash),
    number: BigInt(block.number),
    timestamp: BigInt(block.timestamp),
    transactionResultsRoot: BigInt(block.transactionResultsRoot),
    stateRoot: BigInt(block.stateRoot),
    l1OriginRoot: BigInt(block.l1OriginRoot),
    historyRoot: BigInt(block.historyRoot),
  };
}

function deliveredTransactionId(batch, item) {
  return toHex(transactionId({
    l1BlockHash: bytes32FromHex(batch.l1BlockHash),
    l1TransactionIndex: batch.l1TransactionIndex,
    batchItemIndex: item.batchItemIndex,
  }));
}

async function rpc(server, id, method, params = []) {
  const response = await fetch(server.url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  assert.equal(response.status, 200);
  return response.json();
}

describe("controlled wallet journey RPC", () => {
  it("serves pending transaction lookups used by the browser client", async (t) => {
    const server = await startControlledRpc();
    t.after(() => server.close());
    const hash = `0x${"ab".repeat(32)}`;
    assert.equal((await rpc(server, 1, "eth_getTransactionByHash", [hash])).result, null);
    assert.match((await rpc(server, 2, "eth_getTransactionByHash", ["0x12"])).error.message, /requires one transaction hash/);
  });

  it("can simulate a receipt outage without losing broadcast transaction lookups", async (t) => {
    const server = await startControlledRpc();
    t.after(() => server.close());
    const hash = `0x${"ab".repeat(32)}`;
    server.recordTransaction(hash, { from: FIXED_ACCOUNT, data: TEST_RELAY_BATCH });
    server.setReceiptFailure("Receipt RPC unavailable");
    assert.equal((await rpc(server, 1, "eth_getTransactionByHash", [hash])).result.input, TEST_RELAY_BATCH);
    assert.deepEqual((await rpc(server, 2, "eth_getTransactionReceipt", [hash])).error, {
      code: -32000, message: "Receipt RPC unavailable",
    });
    server.setReceiptFailure(undefined);
    assert.equal((await rpc(server, 3, "eth_getTransactionReceipt", [hash])).result, null);
  });

  it("reads back broadcast transactions while pending and after relay inclusion", async (t) => {
    const server = await startControlledRpc();
    t.after(() => server.close());
    const client = createPublicClient({ transport: http(server.url) });
    const activationHash = `0x${"ab".repeat(32)}`;
    const transaction = {
      from: FIXED_ACCOUNT, to: TEST_STATUS.inboxAddress, data: TEST_RELAY_BATCH,
      nonce: "0x3", gas: "0x1e240", maxFeePerGas: "0x3", maxPriorityFeePerGas: "0x1",
      value: "0x0", type: "0x2",
    };
    assert.equal((await rpc(server, 1, "eth_getTransactionByHash", [activationHash])).result, null);
    server.recordTransaction(activationHash, transaction);
    server.advanceToBlock1();
    server.useRelayCandidates();
    assert.equal(server.recordTransaction(TEST_RELAY_L1_HASH, transaction), TEST_RELAY_L1_HASH);
    transaction.data = "0xff";
    for (const hash of [activationHash, TEST_RELAY_L1_HASH]) {
      const pending = await client.getTransaction({ hash });
      assert.equal(pending.input, TEST_RELAY_BATCH);
      assert.equal(pending.nonce, 3);
      assert.equal(pending.gas, 123456n);
      assert.equal(pending.type, "eip1559");
      assert.equal(pending.blockHash, null);
      assert.equal(pending.blockNumber, null);
      assert.equal(pending.transactionIndex, null);
      assert.equal((await rpc(server, 2, "eth_getTransactionReceipt", [hash])).result, null);
    }
    server.includeRelay();
    const included = await client.getTransaction({ hash: TEST_RELAY_L1_HASH });
    const receipt = await client.getTransactionReceipt({ hash: TEST_RELAY_L1_HASH });
    assert.equal(included.blockHash, receipt.blockHash);
    assert.equal(included.blockNumber, receipt.blockNumber);
    assert.equal(included.transactionIndex, receipt.transactionIndex);
    assert.equal((await client.getTransaction({ hash: activationHash })).blockNumber, null);
  });
  it("prepares compatible calldata candidates within the requested byte cap", async (t) => {
    const server = await startControlledRpc();
    t.after(() => server.close());
    server.useRelayCandidates();
    const node = new PcashNodeClient(server.url);
    const page = await node.getMempool();
    assert.equal(page.items.length, 3);
    const prepared = await node.prepareRelay({
      contentHashes: page.items.map((item) => item.contentHash), maxBatchBytes: 122_880n,
    });
    assert.deepEqual(prepared.selectedContentHashes, [TEST_RELAY_CONTENT_HASH]);
    assert.deepEqual(prepared.rejected, [
      { contentHash: TEST_RELAY_CONFLICT_CONTENT_HASH, reason: "NonceMismatch" },
      { contentHash: TEST_RELAY_OVERSIZED_CONTENT_HASH, reason: "max batch bytes" },
    ]);
    assert.equal(prepared.batchBytes, BigInt(fromHex(TEST_RELAY_BATCH).length));
    assert.deepEqual((await node.prepareRelay({ contentHashes: [TEST_RELAY_CONTENT_HASH], maxBatchBytes: BigInt(fromHex(TEST_RELAY_BATCH).length - 1) })).selectedContentHashes, []);
  });
  it("serves canonical relay delivery and receipt attribution for browser history", async (t) => {
    const server = await startControlledRpc();
    t.after(() => server.close());
    const node = new PcashNodeClient(server.url);
    const batch = await node.getInboxDeliveryBatch(TEST_RELAY_L1_HASH);
    assert.equal(batch.l1Sender.toLowerCase(), FIXED_ACCOUNT.toLowerCase());
    assert.equal(batch.l1TransactionHash, TEST_RELAY_L1_HASH);
    const bytes = fromHex(TEST_RELAY_BATCH);
    assert.equal(bytes.length, 71 + fromHex(TEST_RELAY_RAW).length);
    assert.equal(batch.carrierLength, BigInt(bytes.length));
    assert.equal(batch.carrierHash, toHex(keccak256(bytes)));
    assert.equal(batch.items[0].byteOffset, 71n);
    for (const item of batch.items) {
      const raw = bytes.subarray(Number(item.byteOffset), Number(item.byteOffset + item.byteLength));
      assert.equal(toHex(raw), TEST_RELAY_RAW);
      assert.equal(toHex(keccak256(raw)), item.contentHash);
    }
    const [receipt] = await node.getReceipt({ contentHash: TEST_RELAY_CONTENT_HASH });
    assert.equal(receipt.l1Sender.toLowerCase(), FIXED_ACCOUNT.toLowerCase());
    assert.equal(receipt.inclusion.l1TransactionHash, batch.l1TransactionHash);
    assert.equal(batch.items[0].exclusionReason, null);
    assert.equal(deliveredTransactionId(batch, batch.items[0]), receipt.transactionId);
    assert.notEqual(receipt.transactionId, receipt.contentHash);
    assert.deepEqual(await node.getReceipt(receipt.transactionId), [receipt]);
    assert.deepEqual(await node.getReceipt(TEST_RELAY_CONTENT_HASH), []);
    assert.deepEqual(await node.getReceipt({ contentHash: receipt.transactionId }), []);
    assert.deepEqual(await node.getReceipt({ contentHash: `0x${"ee".repeat(32)}` }), []);
    assert.ok(batch.l1BlockNumber <= (await node.status()).finalizedL1BlockNumber);
    assert.equal(await node.getInboxDeliveryBatch(`0x${"ee".repeat(32)}`), null);
  });

  it("advances relay observation from pending to inclusion and then finality", async (t) => {
    const server = await startControlledRpc();
    t.after(() => server.close());
    server.advanceToBlock1();
    server.useRelayCandidates();
    const node = new PcashNodeClient(server.url);
    assert.equal(await node.getInboxDeliveryBatch(TEST_RELAY_L1_HASH), null);
    server.includeRelay();
    const batch = await node.getInboxDeliveryBatch(TEST_RELAY_L1_HASH);
    assert.equal(batch.l1BlockNumber, 2n);
    assert.equal((await node.status()).finalizedL1BlockNumber, 1n);
    assert.equal(deliveredTransactionId(batch, batch.items[0]), (await node.getReceipt({ contentHash: TEST_RELAY_CONTENT_HASH }))[0].transactionId);
    server.finalizeRelay();
    assert.equal((await node.status()).finalizedL1BlockNumber, batch.l1BlockNumber);
  });

  it("serves verified discovery reads before an account exists", async (t) => {
    const server = await startControlledRpc();
    t.after(() => server.close());
    const node = new PcashNodeClient(server.url);
    assert.equal((await node.status()).totalTransactions, 0n);
    const nullifier = `0x${"01".repeat(32)}`;
    assert.equal(await node.getAccount(FIXED_ADDRESS), null);
    assert.equal(await node.getIssuanceQuote(100n), null);
    assert.deepEqual((await node.getPayouts()).records, []);
    assert.deepEqual((await node.getCurrentNullifierStatuses([nullifier])).statuses, [{ nullifier, spent: false }]);
    server.advanceToBlock1();
    assert.equal((await node.getCurrentNullifierStatuses([nullifier])).boundary.header.number, 1n);
  });

  it("serves a verified witness snapshot and keeps an earlier response usable after head advancement", async (t) => {
    const server = await startControlledRpc();
    t.after(() => server.close());
    const node = new PcashNodeClient(server.url);
    const nullifier = `0x${"01".repeat(32)}`;
    const query = { accounts: [FIXED_ADDRESS], contracts: [FIXED_ADDRESS], nullifiers: [nullifier] };
    const first = await node.getWitnessSnapshot(query);
    assert.deepEqual(server.requests.map(({ method }) => method), ["pcash_getWitnessSnapshot"]);
    server.advanceToBlock1();
    const second = await node.getWitnessSnapshot(query);
    for (const [snapshot, number] of [[first, 0n], [second, 1n]]) {
      assert.equal(snapshot.block.number, number);
      assert.equal(snapshot.status.latestBlock, number);
      assert.equal(snapshot.blockHeader.boundary.header.number, number);
      assert.equal(snapshot.nullifiers.boundary.header.number, number);
      assert.equal(snapshot.block.hash, snapshot.status.latestBlockHash);
      assert.deepEqual(snapshot.nullifiers.statuses, [{ nullifier, spent: false }]);
      assert.deepEqual(snapshot.accounts, [{ status: "notFound", address: FIXED_ADDRESS, authenticated: false }]);
      assert.deepEqual(snapshot.contracts, [{ status: "notFound", address: FIXED_ADDRESS, authenticated: false }]);
      assert.equal(snapshot.outputs, null);
    }
    assert.deepEqual(server.requests.map(({ method }) => method), ["pcash_getWitnessSnapshot", "pcash_getWitnessSnapshot"]);
  });

  it("serves the empty wallet synchronization reads in the SDK's decoded shapes", async (t) => {
    const server = await startControlledRpc();
    t.after(() => server.close());
    const node = new PcashNodeClient(server.url);
    const block0 = { pcashNumber: 0n, pcashHash: TEST_BLOCK_0.hash };

    const frontier = await node.getOutputFrontier(block0);
    assert.equal(frontier.outputCount, 0n);
    assert.equal(frontier.outputRoot, new SparseMerkleTree(MERKLE_DEPTH).root);
    const changes = await node.getAccountChanges({ fromBlock: 0n, target: block0 });
    assert.deepEqual(changes.changes, []);
    assert.equal(changes.complete, true);
    assert.equal((await node.getBlockHeader(0n)).boundary.blockHash, BigInt(TEST_BLOCK_0.hash));
    await assert.rejects(node.getOutputFrontier({ pcashNumber: 1n, pcashHash: TEST_BLOCK_1.hash }), /not a served block/);

    server.advanceToBlock1();
    const block1 = { pcashNumber: 1n, pcashHash: TEST_BLOCK_1.hash };
    assert.equal((await node.getAccountChanges({ fromBlock: 1n, target: block1 })).target.pcashNumber, 1n);
    assert.equal((await node.getBlockHeader()).boundary.blockHash, BigInt(TEST_BLOCK_1.hash));
  });

  it("can fail and restore output discovery independently of account reads", async (t) => {
    const server = await startControlledRpc();
    t.after(() => server.close());
    const request = [{ fromOutputIndex: "0x0", target: { blockNumber: TEST_BLOCK_0.number, blockHash: TEST_BLOCK_0.hash } }];
    server.setOutputFailure("discovery unavailable");
    assert.equal((await rpc(server, 1, "pcash_getOutputs", request)).error.message, "discovery unavailable");
    assert.equal((await rpc(server, 2, "pcash_getAccount", [FIXED_ADDRESS])).result, null);
    server.setOutputFailure(undefined);
    assert.equal((await rpc(server, 3, "pcash_getOutputs", request)).result.complete, true);
  });

  it("publishes two empty blocks with canonical state, genesis, and block hashes", () => {
    const emptyStateRoot = computeStateRoot({
      outputRoot: new SparseMerkleTree(MERKLE_DEPTH).root,
      outputCount: 0n,
      issuedSoFar: 0n,
      lagQ: 0n,
      accountStateRoot: new SparseMerkleTree(MERKLE_DEPTH).root,
      accountCount: 0n,
      nullifierRoot: BigInt(protocolVectors.nullifierTree.sentinel.root),
      nullifierCount: 0n,
    });
    const expectedParentHash = genesisParentHash({
      pcashChainId: BigInt(TEST_STATUS.pcashChainId),
      l1ChainId: BigInt(TEST_STATUS.l1ChainId),
      inboxAddress: TEST_STATUS.inboxAddress,
    });

    assert.equal(TEST_BLOCK_0.stateRoot, bytes32Hex(emptyStateRoot));
    assert.equal(TEST_BLOCK_0.parentHash, bytes32Hex(expectedParentHash));
    assert.equal(TEST_BLOCK_0.hash, bytes32Hex(computeBlockHash(header(TEST_BLOCK_0))));
    assert.equal(TEST_BLOCK_1.hash, bytes32Hex(computeBlockHash(header(TEST_BLOCK_1))));
    assert.equal(TEST_BLOCK_1.parentHash, TEST_BLOCK_0.hash);
    assert.equal(TEST_STATUS.genesisHash, TEST_BLOCK_0.hash);
    assert.equal(TEST_STATUS.latestBlockHash, TEST_BLOCK_0.hash);
    assert.deepEqual(TEST_BLOCK_0.transactionResults, []);
    assert.deepEqual(TEST_BLOCK_1.transactionResults, []);
  });

  it("serves an initial empty note-output page and unauthenticated account miss", async (t) => {
    const server = await startControlledRpc();
    t.after(() => server.close());

    const status = await rpc(server, 1, "pcash_status");
    assert.deepEqual(status.result, TEST_STATUS);

    const account = await rpc(server, 2, "pcash_getAccountProof", [FIXED_ADDRESS]);
    assert.deepEqual(account.result, {
      status: "notFound",
      address: FIXED_ADDRESS,
      authenticated: false,
    });

    const scanRequest = {
      fromOutputIndex: "0x0",
      target: { blockNumber: TEST_BLOCK_0.number, blockHash: TEST_BLOCK_0.hash },
    };
    const scan = await rpc(server, 3, "pcash_getOutputs", [scanRequest]);
    assert.deepEqual(scan.result, {
      fromOutputIndex: "0x0",
      target: { block: scanRequest.target, outputCount: "0x0" },
      outputs: [],
      continuation: null,
      complete: true,
    });

    assert.deepEqual((await rpc(server, 4, "pcash_getBlockByNumber", ["0x0", false])).result, TEST_BLOCK_0);
    assert.equal((await rpc(server, 5, "pcash_getBlockByNumber", ["0x1", false])).result, null);
    assert.deepEqual(server.requests.map(({ method }) => method), [
      "pcash_status",
      "pcash_getAccountProof",
      "pcash_getOutputs",
      "pcash_getBlockByNumber",
      "pcash_getBlockByNumber",
    ]);
  });

  it("advances once and resumes from the same dense note cursor", async (t) => {
    const server = await startControlledRpc();
    t.after(() => server.close());
    const advanced = server.advanceToBlock1();

    assert.deepEqual(server.blockBoundary(0), {
      blockNumber: TEST_BLOCK_0.number,
      blockHash: TEST_BLOCK_0.hash,
    });
    assert.deepEqual(server.blockBoundary(1), {
      blockNumber: TEST_BLOCK_1.number,
      blockHash: TEST_BLOCK_1.hash,
    });
    assert.throws(() => server.blockBoundary(2), /only has blocks 0 and 1/);
    assert.equal(advanced.status.latestBlock, TEST_BLOCK_1.number);
    assert.equal(advanced.status.latestBlockHash, TEST_BLOCK_1.hash);
    assert.deepEqual(advanced.block, TEST_BLOCK_1);
    assert.deepEqual(server.currentStatus(), advanced.status);
    assert.deepEqual((await rpc(server, 1, "pcash_getBlockByNumber", ["0x1", false])).result, TEST_BLOCK_1);

    const scanRequest = {
      fromOutputIndex: "0x0",
      target: { blockNumber: TEST_BLOCK_1.number, blockHash: TEST_BLOCK_1.hash },
    };
    const scan = await rpc(server, 2, "pcash_getOutputs", [scanRequest]);
    assert.deepEqual(scan.result, {
      fromOutputIndex: "0x0",
      target: { block: scanRequest.target, outputCount: "0x0" },
      outputs: [],
      continuation: null,
      complete: true,
    });

    server.clearRequests();
    assert.deepEqual(server.requests, []);
  });

  it("rejects unknown methods and note-output boundaries", async (t) => {
    const server = await startControlledRpc();
    t.after(() => server.close());

    const unknown = await rpc(server, 1, "pcash_unknown");
    assert.deepEqual(unknown.error, { code: -32601, message: "Journey RPC does not implement pcash_unknown" });

    const invalid = await rpc(server, 2, "pcash_getOutputs", [{
      fromOutputIndex: "0x0",
      target: { blockNumber: "0x1", blockHash: TEST_BLOCK_1.hash },
    }]);
    assert.equal(invalid.error.code, -32602);
    assert.match(invalid.error.message, /target is not the controlled head/);
  });
});
