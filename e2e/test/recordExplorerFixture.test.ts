import { describe, expect, it } from "vitest";
import { PcashNodeRpcError } from "@pcash/sdk/clients";
import {
  captureChainSnapshot,
  type RecorderNode,
  type RecorderPscan,
} from "../src/seed/recordExplorerFixture.ts";

const word = (value: number): string => `0x${value.toString(16).padStart(64, "0")}`;
const l1BlockHash = (block: bigint): string => word(1_000 + Number(block));

interface FakeCarrier {
  hash: string;
  l1Block: bigint;
  l1Index: bigint;
  txIds: string[];
  /** Items the node's delivery record admits; defaults to every transactionId. */
  admitted?: string[];
}

interface FakeChainOptions {
  head: bigint;
  carriers: FakeCarrier[];
  /** Mine one block while the first capture is reading transactions. */
  headMovesDuringFirstCapture?: boolean;
}

function fakeChain(options: FakeChainOptions) {
  let head = options.head;
  let moved = false;
  const statusReads: bigint[] = [];
  const quotedAt: bigint[] = [];
  const status = () => ({ pcashChainId: 7n, latestBlock: head, latestBlockTimestamp: head, latestBlockHash: word(500 + Number(head)) });
  const summaryOf = (carrier: FakeCarrier, index: number) => ({
    transactionId: carrier.txIds[index]!,
    contentHash: word(1000 + Number(BigInt(carrier.txIds[index]!))),
    outcome: "succeeded",
    block: { blockNumber: carrier.l1Block, blockHash: word(500 + Number(carrier.l1Block)) },
    inclusion: {
      l1BlockNumber: carrier.l1Block,
      l1BlockHash: l1BlockHash(carrier.l1Block),
      l1TransactionIndex: carrier.l1Index,
      l1TransactionHash: carrier.hash,
      batchItemIndex: BigInt(index),
    },
  });
  const summaries = options.carriers.flatMap((carrier) => carrier.txIds.map((_, index) => summaryOf(carrier, index)));
  const byTxId = new Map(summaries.map((summary) => [summary.transactionId, summary]));
  const node = {
    status: async () => {
      statusReads.push(head);
      return status();
    },
    getBlocks: async (from: bigint, to: bigint) =>
      Array.from({ length: Number(to - from) + 1 }, (_, offset) => {
        const number = from + BigInt(offset);
        return { number, hash: word(500 + Number(number)) };
      }),
    getTransactions: async () => {
      if (options.headMovesDuringFirstCapture && !moved) {
        moved = true;
        head += 1n;
      }
      return { items: summaries, nextCursor: null, head: status() };
    },
    getTransaction: async (transactionId: string) => {
      const summary = byTxId.get(transactionId);
      return summary === undefined ? null : { summary, rawTransaction: "0x00" };
    },
    getReceipt: async (transactionId: string) => {
      const summary = byTxId.get(transactionId);
      return summary === undefined ? [] : [{ ...summary }];
    },
    getL1DeliveryBatches: async (hash: string) => {
      const carrier = options.carriers.find((candidate) => candidate.hash.toLowerCase() === hash.toLowerCase());
      if (carrier === undefined) return [];
      const admitted = new Set(carrier.admitted ?? carrier.txIds);
      return [{
        l1BlockNumber: carrier.l1Block,
        l1BlockHash: l1BlockHash(carrier.l1Block),
        l1TransactionIndex: carrier.l1Index,
        l1TransactionHash: carrier.hash,
        exclusionReason: null,
        items: carrier.txIds.map((transactionId, index) => ({
          batchItemIndex: BigInt(index),
          contentHash: summaryOf(carrier, index).contentHash,
          exclusionReason: admitted.has(transactionId) ? null : "unknownKind",
        })),
      }];
    },
    getContracts: async () => ({ items: [], nextCursor: null }),
    getMempool: async () => ({ items: [], nextCursor: null }),
    getBlockPayouts: async () => null,
    getIssuanceQuote: async (timestamp: bigint) => {
      quotedAt.push(timestamp);
      if (timestamp !== head) throw new PcashNodeRpcError({ code: -32_001, message: "cursorMismatch" }, { method: "pcash_getIssuanceQuote", url: "http://node" });
      return null;
    },
    getPayouts: async () => ({records:[],nextCursor:null}),
    getAccount: async () => null,
    getAccountHistory: async () => ({ items: [], nextCursor: null }),
  } as unknown as RecorderNode;
  const pscan = {
    sourceVerificationInfo: async () => ({}),
    getContractSource: async () => null,
    getContractSourceBundle: async () => null,
    getImplementationSource: async () => null,
    getImplementationSourceFile: async () => null,
  } as unknown as RecorderPscan;
  return { node, pscan, statusReads, quotedAt };
}

const SEED_CARRIER: FakeCarrier = { hash: word(1), l1Block: 3n, l1Index: 0n, txIds: [word(11), word(12)] };
const LATER_CARRIER: FakeCarrier = { hash: word(2), l1Block: 5n, l1Index: 1n, txIds: [word(21)] };

describe("captureChainSnapshot", () => {
  it("records the carrier of every canonical inclusion, not only the seed's", async () => {
    const chain = fakeChain({ head: 6n, carriers: [SEED_CARRIER, LATER_CARRIER] });

    const snapshot = await captureChainSnapshot({ ...chain, carrierHashes: [SEED_CARRIER.hash], addresses: [] });

    expect(snapshot.transactions.map(({ summary }) => summary.transactionId)).toEqual([word(11), word(12), word(21)]);
    expect(snapshot.batches.map((batch) => batch.l1TransactionHash)).toEqual([SEED_CARRIER.hash, LATER_CARRIER.hash]);
  });

  it("captures again when a block lands mid-capture, and publishes one consistent head", async () => {
    const chain = fakeChain({ head: 5n, carriers: [SEED_CARRIER], headMovesDuringFirstCapture: true });
    const log: string[] = [];

    const snapshot = await captureChainSnapshot({ ...chain, carrierHashes: [], addresses: [], log: (message) => log.push(message) });

    // The first ranking read was rejected for the stale head; the retry read every basis at the new one.
    expect(chain.quotedAt).toEqual([5n, 6n]);
    expect(snapshot.status.latestBlock).toBe(6n);
    expect(snapshot.blocks.map((block) => block.number)).toEqual([0n, 1n, 2n, 3n, 4n, 5n, 6n]);
    expect(chain.statusReads.at(-1)).toBe(6n);
    expect(log.some((message) => /head moved from 5 to 6/.test(message))).toBe(true);
  });

  it("refuses a recording whose transaction has no admitted item in its carrier", async () => {
    const chain = fakeChain({ head: 6n, carriers: [{ ...LATER_CARRIER, admitted: [] }] });

    await expect(captureChainSnapshot({ ...chain, carrierHashes: [], addresses: [] }))
      .rejects.toThrow(/no admitted item/);
  });
});
