import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { custom } from "viem";
import { MemoryRelayJournal, PrivateKeyRelaySubmitter } from "@pcash/sdk/node";
import { encodeContractAccountCreation, transactionId } from "@pcash/sdk/protocol";
import { concatBytes, fromHex, keccak256, toHex } from "@pcash/sdk/utils";
import {
  parseRawTransactionBatch,
  rawBatchExitCode,
  readRawTransactionBatch,
  submitRawTransactionBatch,
  type RawBatchResult,
} from "../src/exactBatch.ts";

function contractTransaction(): Uint8Array {
  return encodeContractAccountCreation(8191, concatBytes(
    Uint8Array.of(0), new Uint8Array(32), Uint8Array.of(0, 0),
  ), { recentPcashBlockHash: 0x4321n, validUntilTimestamp: 1_900_000_000n });
}

describe("raw transaction batches", () => {
  it("parses an ordered JSON array without fixture metadata", () => {
    expect(parseRawTransactionBatch(["0xAABB", "0x01"])).toEqual(["0xaabb", "0x01"]);
  });

  it("reads the same format from stdin", async () => {
    const stdin = Readable.from(['["0xAABB","0x01"]']);
    await expect(readRawTransactionBatch("-", stdin)).resolves.toEqual(["0xaabb", "0x01"]);
  });

  it("rejects manifests, empty batches, and malformed raw bytes", () => {
    expect(() => parseRawTransactionBatch({ entries: ["0x01"] })).toThrow(/JSON array/);
    expect(() => parseRawTransactionBatch([])).toThrow(/nonempty/);
    expect(() => parseRawTransactionBatch(["0x0"])).toThrow(/byte hex/);
    expect(() => parseRawTransactionBatch(["not-hex"])).toThrow(/byte hex/);
  });

  it("distinguishes complete success from a finalized partial result", () => {
    const result = {
      items: [{
        index: 0,
        contentHash: "0x01",
        transactionId: "0x02",
        outcome: "succeeded",
        exclusionReason: null,
      }],
    } as RawBatchResult;
    expect(rawBatchExitCode(result)).toBe(0);
    expect(rawBatchExitCode({
      ...result,
      items: [{ ...result.items[0]!, outcome: "proofRejected" }],
    })).toBe(3);
    expect(rawBatchExitCode({
      ...result,
      items: [{
        ...result.items[0]!,
        transactionId: null,
        outcome: null,
        exclusionReason: "unknownKind",
      }],
    })).toBe(3);
  });

  it("submits locally signed bytes directly without mempool preparation", async () => {
    const transaction = contractTransaction();
    const rawTransaction = toHex(transaction);
    const contentHash = toHex(keccak256(transaction));
    const transactionHash = `0x${"11".repeat(32)}`;
    const l1BlockHash = `0x${"22".repeat(32)}`;
    const transactionId = `0x${"33".repeat(32)}`;
    let submittedMetadata: unknown;
    const node = {
      status: async () => ({
        pcashChainId: 8191,
        acceptedBatchVersions: [1],
        latestBlock: 7n,
        latestBlockHash: `0x${"44".repeat(32)}`,
      }),
      getInboxDeliveryBatch: async () => ({
        l1BlockNumber: 9n,
        l1BlockHash,
        l1TransactionIndex: 0n,
        l1TransactionHash: transactionHash,
        l1Sender: `0x${"55".repeat(20)}`,
        carrierType: "calldata" as const,
        carrierHash: transactionHash,
        carrierLength: BigInt(transaction.length),
        blobVersionedHashes: [],
        exclusionReason: null,
        items: [{
          batchItemIndex: 0n,
          contentHash,
          byteOffset: 0n,
          byteLength: BigInt(transaction.length),
          exclusionReason: null,
        }],
      }),
    };
    const submitter = {
      assertAvailable: async () => undefined,
      quote: async () => ({ selected: {} }),
      send: async (_status: unknown, _batch: unknown, _quote: unknown, metadata: unknown) => {
        submittedMetadata = metadata;
        const delivery = await node.getInboxDeliveryBatch();
        return { txHash: transactionHash, settle: async () => ({
          txHash: transactionHash,
          receipt: {
            status: 1,
            blockNumber: 9n,
            blockHash: l1BlockHash,
            transactionIndex: 0,
            gasUsed: 21_000n,
          },
          observed: true,
          delivery,
          outcomes: [{
            transactionId: transactionId,
            outcome: "succeeded" as const,
            accepted: true,
            kind: "contractAccount",
            l1BlockHash,
            l1TransactionIndex: 0n,
            batchItemIndex: 0n,
          }],
        }) };
      },
    };

    await expect(submitRawTransactionBatch({
      transactions: [rawTransaction],
      payoutRecipient: () => ({ address: 1n, nkRoot: 2n }),
      node: node as never,
      submitter: submitter as never,
      daMode: "calldata",
      maxBatchBytes: 1_000_000n,
      maxTransactions: 64,
    })).resolves.toMatchObject({
      transactionHash,
      items: [{ index: 0, contentHash, transactionId, outcome: "succeeded", exclusionReason: null }],
    });
    expect(submittedMetadata).toEqual(expect.objectContaining({
      selected: [contentHash],
      batchItemIndexes: [0],
      observationMode: "batch",
    }));
  });

  it.each(["length", "order"] as const)("rejects malformed settled delivery %s", async (defect) => {
    const transaction = contractTransaction();
    const contentHash = toHex(keccak256(transaction));
    const raw = toHex(transaction);
    const transactionHash = `0x${"11".repeat(32)}`;
    const l1BlockHash = `0x${"22".repeat(32)}`;
    const item = (index: bigint) => ({
      batchItemIndex: index,
      contentHash,
      exclusionReason: null,
    });
    const items = defect === "length" ? [item(0n)] : [item(1n), item(0n)];
    const node = { status: async () => ({
      pcashChainId: 8191, acceptedBatchVersions: [1], latestBlock: 7n,
      latestBlockHash: `0x${"44".repeat(32)}`,
    }) };
    const submitter = {
      assertAvailable: async () => undefined,
      quote: async () => ({ selected: {} }),
      send: async () => ({ txHash: transactionHash, settle: async () => ({
        txHash: transactionHash,
        receipt: { status: 1, blockNumber: 9n, blockHash: l1BlockHash, transactionIndex: 0, gasUsed: 21_000n },
        observed: true,
        delivery: { items },
        outcomes: [0n, 1n].map((batchItemIndex) => ({
          transactionId: `0x${"33".repeat(32)}`, outcome: "succeeded" as const,
          accepted: true, kind: "contractAccount", l1BlockHash, l1TransactionIndex: 0n, batchItemIndex,
        })),
      }) }),
    };
    await expect(submitRawTransactionBatch({
      transactions: [raw, raw],
      payoutRecipient: () => ({ address: 1n, nkRoot: 2n }),
      node: node as never, submitter: submitter as never,
      daMode: "calldata", maxBatchBytes: 1_000_000n, maxTransactions: 64,
    })).rejects.toThrow(defect === "length" ? /diagnostics are missing or inconsistent/ : /different delivery coordinates/);
  });

  it("maps duplicate raw content by batch index through the SDK submitter", async () => {
    const raw = toHex(contractTransaction());
    const contentHash = toHex(keccak256(fromHex(raw)));
    const l1BlockHash = `0x${"77".repeat(32)}`;
    const genesisL1BlockHash = `0x${"33".repeat(32)}`;
    const inboxAddress = `0x${"22".repeat(20)}`;
    const status = {
      pcashChainId: 8191,
      genesisHash: `0x${"12".repeat(32)}`,
      l1ChainId: 1n,
      inboxAddress,
      genesisL1Block: 5n,
      genesisL1BlockHash,
      finalizedL1BlockNumber: 9n,
      finalizedL1BlockHash: l1BlockHash,
      acceptedBatchVersions: [1],
      latestBlock: 8n,
      latestBlockHash: `0x${"44".repeat(32)}`,
    };
    const includedId = toHex(transactionId({
      l1BlockHash: fromHex(l1BlockHash), l1TransactionIndex: 0n, batchItemIndex: 0n,
    }));
    const journal = new MemoryRelayJournal();
    const receiptQueries: unknown[] = [];
    let l1TxHash = "";
    const node = {
      status: async () => status,
      getInboxDeliveryBatch: async (txHash: string) => ({
        l1BlockNumber: 9n, l1BlockHash, l1TransactionIndex: 0n,
        l1TransactionHash: txHash,
        l1Sender: `0x${"88".repeat(20)}`,
        carrierType: "calldata" as const, carrierHash: txHash,
        carrierLength: BigInt(fromHex(raw).length * 2), blobVersionedHashes: [],
        exclusionReason: null,
        items: [
          { batchItemIndex: 0n, contentHash, byteOffset: 0n, byteLength: BigInt(fromHex(raw).length),
            exclusionReason: null },
          { batchItemIndex: 1n, contentHash, byteOffset: BigInt(fromHex(raw).length), byteLength: BigInt(fromHex(raw).length),
            exclusionReason: "truncated" },
        ],
      }),
      getReceipt: async (query: unknown) => {
        receiptQueries.push(query);
        return [{
          contentHash, transactionId: includedId, outcome: "succeeded", kind: "contractAccount",
          inclusion: {
            l1BlockNumber: 9n, l1BlockHash, l1TransactionIndex: 0n,
            l1TransactionHash: l1TxHash, batchItemIndex: 0n,
          },
        }];
      },
    };
    const transport = custom({
      async request({ method, params }) {
        switch (method) {
          case "eth_chainId": return "0x1";
          case "eth_getBlockByNumber": {
            const number = (params as [string])[0];
            return { hash: number === "0x5" ? genesisL1BlockHash : l1BlockHash,
              number: number.startsWith("0x") ? number : "0x9", baseFeePerGas: "0x1" };
          }
          case "eth_maxPriorityFeePerGas": return "0x1";
          case "eth_feeHistory": return { oldestBlock: "0x5", baseFeePerGas: ["0x1", "0x2"],
            baseFeePerBlobGas: ["0x1", "0x1"], gasUsedRatio: [0.5], reward: [[]] };
          case "eth_estimateGas": return "0x5208";
          case "eth_getTransactionCount": return "0x3";
          case "eth_getBalance": return "0xf4240";
          case "eth_sendRawTransaction": {
            l1TxHash = toHex(keccak256(fromHex((params as [string])[0])));
            return l1TxHash;
          }
          case "eth_getTransactionReceipt": return {
            transactionHash: l1TxHash, blockNumber: "0x9", blockHash: l1BlockHash,
            transactionIndex: "0x0", gasUsed: "0x5208", cumulativeGasUsed: "0x5208",
            effectiveGasPrice: "0x1", contractAddress: null, logs: [],
            logsBloom: `0x${"00".repeat(256)}`, type: "0x2", status: "0x1",
            from: `0x${"88".repeat(20)}`, to: inboxAddress,
          };
          default: throw new Error(`unexpected RPC method ${method}`);
        }
      },
    });
    const submitter = new PrivateKeyRelaySubmitter({
      privateKey: `0x${"11".repeat(32)}`, rpcUrl: "http://unused",
      node: node as never, journal, transport,
      receiptTimeoutMs: 100, receiptPollMs: 1,
      observationTimeoutMs: 100, observationPollMs: 1,
    });
    const result = await submitRawTransactionBatch({
      transactions: [raw, raw], payoutRecipient: () => ({ address: 1n, nkRoot: 2n }),
      node: node as never, submitter, daMode: "calldata", maxBatchBytes: 1_000_000n, maxTransactions: 64,
    });
    expect(result.items).toEqual([
      { index: 0, contentHash, transactionId: includedId, outcome: "succeeded", exclusionReason: null },
      { index: 1, contentHash, transactionId: null, outcome: null, exclusionReason: "truncated" },
    ]);
    expect(receiptQueries).toEqual([{ inclusionId: { l1BlockHash, l1TransactionIndex: 0, batchItemIndex: 0 } }]);
    await expect(journal.read()).resolves.toEqual([]);
  });
});
