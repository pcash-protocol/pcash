import { Transaction } from "ethers";
import { commitmentToVersionedHash, custom, TimeoutError, type Hex } from "viem";
import { describe, expect, it, vi } from "vitest";
import { encodeBatchForVersion, transactionId } from "../src/protocol/index.ts";
import { fromHex, keccak256, toHex } from "../src/utils/index.ts";
import type { L1DeliveryBatchResult, PcashNodeClient, ReceiptResult, StatusResult } from "../src/clients/index.ts";
import type { RelayCarrierQuote, RelayJournalEntry, RelaySubmissionMetadata } from "../src/relay/index.ts";
import { MemoryRelayJournal } from "../src/node/relayJournal.ts";
import { PrivateKeyRelaySubmitter, retryableInitialization } from "../src/node/privateKeyRelaySubmitter.ts";
import { RECOVERY_RPC_TIMEOUT_MS } from "../src/relay/recovery.ts";
import {
  RelayDeadlineError,
  RelayJournalConflictError,
  RelayUpstreamError,
  RelayValidationError,
  RelayFeeCeilingError,
} from "../src/relay/errors.ts";

const PRIVATE_KEY = `0x${"11".repeat(32)}`;
const INBOX = `0x${"22".repeat(20)}`;
const RECIPIENT = `0x${"99".repeat(20)}`;
const ANCHOR_HASH = `0x${"33".repeat(32)}`;
const L1_BLOCK_HASH = `0x${"77".repeat(32)}`;
// A real selected entry: verification re-hashes these exact bytes.
const ENTRY = fromHex(`0x${"ab".repeat(48)}`, "entry");
const TX_ID = toHex(keccak256(ENTRY));
const OTHER_TX_ID = `0x${"98".repeat(32)}`;
const inclusionTxId = (batchItemIndex: bigint): string => toHex(transactionId({
  l1BlockHash: fromHex(L1_BLOCK_HASH, "block hash"),
  l1TransactionIndex: 0n,
  batchItemIndex,
}));
const BATCH = toHex(encodeBatchForVersion([ENTRY], 1, 1n, 0n));
const COMMITMENT = `0x${"55".repeat(48)}` as Hex;
const CELL_PROOF = `0x${"66".repeat(48)}`;

const status = {
  pcashChainId: 8191,
  genesisHash: `0x${"12".repeat(32)}`,
  l1ChainId: 1n,
  inboxAddress: INBOX,
  genesisL1Block: 5n,
  genesisL1BlockHash: ANCHOR_HASH,
  finalizedL1BlockNumber: 9n,
  finalizedL1BlockHash: L1_BLOCK_HASH,
  acceptedBatchVersions: [1],
} as StatusResult;

const receipt = {
  transactionHash: `0x${"00".repeat(32)}`,
  blockNumber: "0x9",
  blockHash: L1_BLOCK_HASH,
  transactionIndex: "0x0",
  gasUsed: "0x5208",
  cumulativeGasUsed: "0x5208",
  effectiveGasPrice: "0x1",
  contractAddress: null,
  logs: [],
  logsBloom: `0x${"00".repeat(256)}`,
  type: "0x3",
  status: "0x1",
  from: `0x${"88".repeat(20)}`,
  to: INBOX,
};

/** The shared in-memory journal, recording when entries are created and cleared. */
class EventJournal extends MemoryRelayJournal {
  readonly events: string[];

  constructor(events: string[]) {
    super();
    this.events = events;
  }

  override async create(entry: RelayJournalEntry): Promise<void> {
    await super.create(entry);
    this.events.push("journal");
  }

  override async clear(resolutionId: string): Promise<void> {
    await super.clear(resolutionId);
    this.events.push("clear");
  }
}

function quote(carrier: "calldata" | "blobs"): RelayCarrierQuote {
  const blobVersionedHashes = carrier === "blobs"
    ? [commitmentToVersionedHash({ commitment: COMMITMENT })]
    : [];
  return {
    ...(carrier === "blobs" ? { carrier, sidecars: [] } : { carrier }),
    gasLimit: 30_000n,
    maxFeePerGas: 10n,
    maxPriorityFeePerGas: 1n,
    maxFeePerBlobGas: carrier === "blobs" ? 4n : null,
    blobCount: carrier === "blobs" ? 1 : 0,
    blobVersionedHashes,
    estimatedCostWei: 200_000n,
    maximumCostWei: 900_000n,
    balanceWei: 1_000_000n,
  };
}

const metadata = {
  selected: [TX_ID],
  collectibleOpenFee: 7n,
  headCheckedBlock: 8n,
  headCheckedBlockHash: ANCHOR_HASH,
};

/** Broadcast, then wait for settlement, as a one-shot relay does. */
async function submit(
  submitter: PrivateKeyRelaySubmitter,
  batch: string,
  carrierQuote: RelayCarrierQuote,
  submission: RelaySubmissionMetadata,
) {
  return (await submitter.send(status, batch, carrierQuote, submission)).settle();
}

function acceptedReceipt(): ReceiptResult {
  return {
    contentHash: TX_ID,
    transactionId: inclusionTxId(0n),
    outcome: "succeeded",
    failureDetail: null,
    l1Sender: "0x0000000000000000000000000000000000000000",
    issuanceOwnerCommitment: null,
    settledOpenFeeAmount: 0n,
    settledIssuanceAmount: 0n,
    kind: "privateValue",
    fundingMode: null,
    inclusion: {
      l1BlockNumber: 9n,
      l1BlockHash: L1_BLOCK_HASH,
      l1TransactionIndex: 0n,
      l1TransactionHash: "0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd",
      batchItemIndex: 0n,
    },
    outputLeafStart: 0n,
    outputsAdded: 0n,
    nullifiers: [],
    account: null,
  };
}

interface SetupOptions {
  broadcast?: "success" | "error" | "mismatch";
  receipt?: "success" | "pending" | "reverted";
  getReceipt?: PcashNodeClient["getReceipt"];
  getInboxDeliveryBatch?: PcashNodeClient["getInboxDeliveryBatch"];
  receiptTimeoutMs?: number;
  observationTimeoutMs?: number;
  nodeStatus?: PcashNodeClient["status"];
  runExclusive?: <T>(operation: () => Promise<T>) => Promise<T>;
  rpcUrl?: string;
  maxInFlight?: number;
  journal?: EventJournal;
  events?: string[];
  l1?: { block: bigint; baseFee: bigint; blobBaseFee: bigint; tip: bigint; minedHash?: string };
  beforeBroadcast?: (raw: string, attempt: number) => Promise<void>;
  knownHash?: string;
  maxFeePerGas?: bigint;
  replacementAfterBlocks?: number;
}

function setup(carrier: "calldata" | "blobs", options: SetupOptions = {}) {
  const events = options.events ?? [];
  const journal = options.journal ?? new EventJournal(events);
  const raws: string[] = [];
  const transport = custom({
    async request({ method, params }) {
      switch (method) {
        case "eth_chainId":
          return "0x1";
        case "eth_getBlockByNumber": {
          const blockNumber = (params as [string])[0];
          return blockNumber === "0x5"
            ? { hash: ANCHOR_HASH, number: "0x5", baseFeePerGas: "0x1" }
            : { hash: L1_BLOCK_HASH, number: blockNumber.startsWith("0x") ? blockNumber : `0x${(options.l1?.block ?? 9n).toString(16)}`, baseFeePerGas: `0x${(options.l1?.baseFee ?? 1n).toString(16)}` };
        }
        case "eth_maxPriorityFeePerGas":
          return `0x${(options.l1?.tip ?? 1n).toString(16)}`;
        case "eth_feeHistory":
          if (options.l1 !== undefined) return {
            oldestBlock: `0x${options.l1.block.toString(16)}`,
            baseFeePerGas: [options.l1.baseFee, options.l1.baseFee].map((fee) => `0x${fee.toString(16)}`),
            baseFeePerBlobGas: [options.l1.blobBaseFee, options.l1.blobBaseFee].map((fee) => `0x${fee.toString(16)}`),
            gasUsedRatio: [0.5], reward: [[]],
          };
          return { oldestBlock: "0x5", baseFeePerGas: ["0x1", "0x2"], baseFeePerBlobGas: ["0x1", "0x1"], gasUsedRatio: [0.5], reward: [[]] };
        case "eth_estimateGas":
          return "0x5208";
        case "eth_getTransactionCount":
          return "0x3";
        case "eth_getBalance":
          return "0xf4240";
        case "eth_getTransactionByHash":
          return options.knownHash === (params as [string])[0] ? { hash: options.knownHash } : null;
        case "eth_sendRawTransaction": {
          events.push("broadcast");
          const raw = (params as [string])[0];
          raws.push(raw);
          await options.beforeBroadcast?.(raw, raws.length);
          const hash = Transaction.from(raw).hash;
          if (hash === null) throw new Error("signed transaction has no hash");
          if (options.broadcast === "error") throw new Error("socket closed after send");
          if (options.broadcast === "mismatch") return `0x${"99".repeat(32)}`;
          receipt.transactionHash = hash;
          return hash;
        }
        case "eth_getTransactionReceipt":
          events.push("receipt");
          if (options.l1 !== undefined && options.l1.minedHash !== (params as [string])[0]) return null;
          if (options.receipt === "pending") return null;
          return { ...receipt, transactionHash: (params as [string])[0], status: options.receipt === "reverted" ? "0x0" : "0x1" };
        default:
          throw new Error(`unexpected RPC method ${method}`);
      }
    },
  });
  const kzgCalls = { commitment: 0, proofs: 0 };
  const fakeKzg = {
    blobToKZGCommitment: () => { kzgCalls.commitment += 1; return COMMITMENT; },
    computeCellsAndKZGProofs: () => { kzgCalls.proofs += 1; return {
      cells: Array.from({ length: 128 }, () => `0x${"00".repeat(2_048)}`),
      proofs: Array.from({ length: 128 }, () => CELL_PROOF),
    }; },
  };
  const submitter = new PrivateKeyRelaySubmitter({
    rpcUrl: options.rpcUrl ?? "http://unused",
    privateKey: PRIVATE_KEY,
    node: {
      status: options.nodeStatus ?? (async () => status),
      getReceipt: options.getReceipt ?? (async () => [acceptedReceipt()]),
      getInboxDeliveryBatch: options.getInboxDeliveryBatch ?? (async () => null),
    },
    journal,
    transport,
    loadKzg: async () => fakeKzg as never,
    receiptTimeoutMs: options.receiptTimeoutMs ?? 100,
    receiptPollMs: 1,
    observationTimeoutMs: options.observationTimeoutMs ?? 100,
    observationPollMs: 1,
    ...(options.maxFeePerGas === undefined ? {} : { maxFeePerGas: options.maxFeePerGas }),
    ...(options.replacementAfterBlocks === undefined ? {} : { replacementAfterBlocks: options.replacementAfterBlocks }),
    ...(options.maxInFlight === undefined ? {} : { maxInFlight: options.maxInFlight }),
    ...(options.runExclusive === undefined ? {} : { runExclusive: options.runExclusive }),
  });
  return { events, journal, submitter, kzgCalls, raw: () => raws.at(-1), raws, quote: quote(carrier) };
}

describe("PrivateKeyRelaySubmitter", () => {
  it("quotes both carriers and chooses the lower execution-plus-blob cost", async () => {
    let estimateCalls = 0;
    const transport = custom({
      async request({ method, params }) {
        switch (method) {
          case "eth_chainId":
            return "0x1";
          case "eth_getBlockByNumber":
            return { hash: ANCHOR_HASH, number: "0x5", baseFeePerGas: "0x1" };
          case "eth_maxPriorityFeePerGas":
            return "0x1";
          case "eth_getBalance":
            return "0xf4240";
          case "eth_feeHistory":
            return {
              oldestBlock: "0x5",
              baseFeePerGas: ["0x1", "0x2"],
              gasUsedRatio: [0.5],
              reward: [[]],
              baseFeePerBlobGas: ["0x1", "0x1"],
            };
          case "eth_estimateGas": {
            estimateCalls += 1;
            const request = (params as [Record<string, unknown>])[0];
            return "blobVersionedHashes" in request ? "0x5208" : "0xf4240";
          }
          default:
            throw new Error(`unexpected RPC method ${method}`);
        }
      },
    });
    const fakeKzg = {
      blobToKZGCommitment: () => COMMITMENT,
      computeCellsAndKZGProofs: () => ({ proofs: Array.from({ length: 128 }, () => CELL_PROOF) }),
    };
    const submitter = new PrivateKeyRelaySubmitter({
      rpcUrl: "http://unused",
      privateKey: PRIVATE_KEY,
      node: {
        getReceipt: async () => [],
        status: async () => status,
        getInboxDeliveryBatch: async () => null,
      },
      journal: new MemoryRelayJournal(),
      transport,
      loadKzg: async () => fakeKzg as never,
    });

    const quotes = await submitter.quote(status, "0x010000", "auto");

    expect(quotes.calldata).toMatchObject({ carrier: "calldata", gasLimit: 1_000_000n });
    expect(quotes.blobs).toMatchObject({ carrier: "blobs", gasLimit: 21_000n, blobCount: 1 });
    expect(quotes.selected).toBe(quotes.blobs);
    expect(quotes.blobs!.estimatedCostWei).toBeLessThan(quotes.calldata!.estimatedCostWei);
    expect(estimateCalls).toBe(2);

    const fixed = new PrivateKeyRelaySubmitter({
      rpcUrl: "http://unused",
      privateKey: PRIVATE_KEY,
      node: {
        getReceipt: async () => [],
        status: async () => status,
        getInboxDeliveryBatch: async () => null,
      },
      journal: new MemoryRelayJournal(),
      transport,
      loadKzg: async () => fakeKzg as never,
      gasLimit: 42_000n,
    });
    const fixedQuotes = await fixed.quote(status, "0x010000", "auto");
    expect(fixedQuotes.calldata?.gasLimit).toBe(42_000n);
    expect(fixedQuotes.blobs?.gasLimit).toBe(42_000n);
    expect(estimateCalls).toBe(2);

    const capped = new PrivateKeyRelaySubmitter({
      rpcUrl: "http://unused",
      privateKey: PRIVATE_KEY,
      node: {
        getReceipt: async () => [],
        status: async () => status,
        getInboxDeliveryBatch: async () => null,
      },
      journal: new MemoryRelayJournal(),
      transport,
      loadKzg: async () => fakeKzg as never,
      maxFeePerGas: 0n,
    });
    await expect(capped.quote(status, "0x010000", "calldata"))
      .rejects.toBeInstanceOf(RelayValidationError);
  });

  it("does not store l1Rpc in the journal", async () => {
    const test = setup("calldata", {
      rpcUrl: "http://key:secret@127.0.0.1:8545/path",
      broadcast: "error",
    });
    await expect(submit(test.submitter, BATCH, test.quote, metadata))
      .rejects.toThrow(/broadcasting the signed relay transaction failed/);
    const [held] = await test.journal.read();
    expect("l1Rpc" in (held ?? {})).toBe(false);
    expect(held).toMatchObject({ kind: "batch", batchItemIndexes: ["0"] });
  });

  it("journals exact calldata bytes before broadcast and clears after observation", async () => {
    const test = setup("calldata");
    const batch = BATCH;

    const result = await submit(test.submitter, batch, test.quote, {
      selected: [TX_ID],
      collectibleOpenFee: 7n,
      headCheckedBlock: 8n,
      headCheckedBlockHash: ANCHOR_HASH,
    });

    expect(test.events).toEqual(["journal", "broadcast", "receipt", "clear"]);
    await expect(test.journal.read()).resolves.toEqual([]);
    expect(result).toMatchObject({
      observed: true,
      receipt: { status: 1, blockNumber: 9n },
      outcomes: [{
        transactionId: inclusionTxId(0n),
        accepted: true,
        kind: "privateValue",
        l1BlockHash: L1_BLOCK_HASH,
        l1TransactionIndex: 0n,
        batchItemIndex: 0n,
      }],
    });
    const transaction = Transaction.from(test.raw()!);
    expect(transaction.type).toBe(2);
    expect(transaction.to).toBe(INBOX);
    expect(transaction.data).toBe(batch);
    expect(transaction.nonce).toBe(3);
  });

  it("returns at broadcast and settles separately", async () => {
    const test = setup("calldata");

    const broadcast = await test.submitter.send(status, BATCH, test.quote, metadata);

    expect(test.events).toEqual(["journal", "broadcast"]);
    expect(broadcast.txHash).toBe(Transaction.from(test.raw()!).hash);
    await expect(test.journal.read()).resolves.toMatchObject([{
      kind: "batch",
      phase: "broadcast_accepted",
      transactionHash: broadcast.txHash,
      selected: [TX_ID],
      nonce: "3",
    }]);
    await expect(test.submitter.inFlight()).resolves.toEqual([TX_ID.toLowerCase()]);

    await expect(broadcast.settle()).resolves.toMatchObject({ txHash: broadcast.txHash, observed: true });
    expect(test.events).toEqual(["journal", "broadcast", "receipt", "clear"]);
    await expect(test.submitter.inFlight()).resolves.toEqual([]);
  });

  it("attributes mixed accepted and skipped outcomes to the exact mined batch", async () => {
    const secondTxId = `0x${"99".repeat(32)}`;
    const queries: unknown[] = [];
    const test = setup("calldata", {
      getReceipt: async (query) => {
        queries.push(query);
        if (typeof query === "string" || !("inclusionId" in query)) throw new Error("expected inclusion query");
        const index = BigInt(query.inclusionId.batchItemIndex);
        return [{
          contentHash: index === 0n ? TX_ID : secondTxId,
          transactionId: inclusionTxId(index),
          outcome: index === 0n ? "succeeded" : "nullifierAlreadySpent",
          failureDetail: index === 0n ? null : {
            type: "nullifierAlreadySpent",
            inputSlot: "0x0" as unknown as bigint,
            nullifier: TX_ID,
            spendingTransactionId: TX_ID,
          },
          l1Sender: "0x0000000000000000000000000000000000000000",
          issuanceOwnerCommitment: null,
          settledOpenFeeAmount: 0n,
          settledIssuanceAmount: 0n,
          kind: "privateValue",
          fundingMode: null,
          inclusion: {
            l1BlockNumber: 9n,
            l1BlockHash: L1_BLOCK_HASH,
            l1TransactionIndex: 0n,
            l1TransactionHash: "0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd",
            batchItemIndex: index,
          },
          outputLeafStart: index === 0n ? 0n : null,
          outputsAdded: 0n,
          nullifiers: [],
          account: null,
        }];
      },
    });

    const result = await submit(test.submitter, BATCH, test.quote, {
      ...metadata,
      selected: [TX_ID, secondTxId],
      batchItemIndexes: [0, 2],
    });

    expect(result.outcomes).toEqual([
      expect.objectContaining({ transactionId: inclusionTxId(0n), accepted: true, batchItemIndex: 0n }),
      expect.objectContaining({ transactionId: inclusionTxId(2n), accepted: false, batchItemIndex: 2n }),
    ]);
    expect(queries).toEqual([
      { inclusionId: { l1BlockHash: L1_BLOCK_HASH, l1TransactionIndex: 0, batchItemIndex: 0 } },
      { inclusionId: { l1BlockHash: L1_BLOCK_HASH, l1TransactionIndex: 0, batchItemIndex: 2 } },
    ]);
    await expect(test.journal.read()).resolves.toEqual([]);
  });

  it("uses delivery diagnostics to finish excluded raw batch items without waiting for receipts", async () => {
    const getReceipt = vi.fn<PcashNodeClient["getReceipt"]>(async () => []);
    const test = setup("calldata", {
      getReceipt,
      getInboxDeliveryBatch: async (txHash) => delivery(txHash, {
        items: [{
          batchItemIndex: 0n,
          contentHash: TX_ID,
          byteOffset: 0n,
          byteLength: BigInt(ENTRY.length),
          exclusionReason: "unknownKind",
        }],
      }),
    });

    const result = await submit(test.submitter, BATCH, test.quote, {
      ...metadata,
      observationMode: "batch",
    });

    expect(result.outcomes).toEqual([]);
    expect(getReceipt).not.toHaveBeenCalled();
    await expect(test.journal.read()).resolves.toEqual([]);
  });

  it("uses delivery diagnostics to observe transaction-bearing raw batch items", async () => {
    const test = setup("calldata", {
      getInboxDeliveryBatch: async (txHash) => delivery(txHash),
    });

    const result = await submit(test.submitter, BATCH, test.quote, {
      ...metadata,
      observationMode: "batch",
    });

    expect(result.outcomes).toEqual([
      expect.objectContaining({ transactionId: inclusionTxId(0n), outcome: "succeeded" }),
    ]);
    await expect(test.journal.read()).resolves.toEqual([]);
  });

  it("returns this batch's skipped outcome even when the transaction was accepted elsewhere", async () => {
    const getReceipt = vi.fn<PcashNodeClient["getReceipt"]>(async (query) => {
      if (typeof query === "string") {
        return [{
          contentHash: TX_ID,
          transactionId: inclusionTxId(0n),
          outcome: "succeeded",
          failureDetail: null,
          l1Sender: "0x0000000000000000000000000000000000000000",
          issuanceOwnerCommitment: null,
          settledOpenFeeAmount: 0n,
          settledIssuanceAmount: 0n,
          kind: "privateValue",
          fundingMode: null,
          inclusion: {
            l1BlockNumber: 8n,
            l1BlockHash: ANCHOR_HASH,
            l1TransactionIndex: 1n,
            l1TransactionHash: "0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd",
            batchItemIndex: 0n,
          },
          outputLeafStart: 0n,
          outputsAdded: 0n,
          nullifiers: [],
          account: null,
        }];
      }
      return [{
        contentHash: TX_ID,
        transactionId: inclusionTxId(0n),
        outcome: "nullifierAlreadySpent",
        failureDetail: {
          type: "nullifierAlreadySpent",
          inputSlot: "0x0" as unknown as bigint,
          nullifier: TX_ID,
          spendingTransactionId: TX_ID,
        },
        l1Sender: "0x0000000000000000000000000000000000000000",
        issuanceOwnerCommitment: null,
        settledOpenFeeAmount: 0n,
        settledIssuanceAmount: 0n,
        kind: "privateValue",
        fundingMode: null,
        inclusion: {
          l1BlockNumber: 9n,
          l1BlockHash: L1_BLOCK_HASH,
          l1TransactionIndex: 0n,
          l1TransactionHash: "0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd",
          batchItemIndex: 0n,
        },
        outputLeafStart: null,
        outputsAdded: 0n,
        nullifiers: [],
        account: null,
      }];
    });
    const test = setup("calldata", { getReceipt });

    await expect(submit(test.submitter, BATCH, test.quote, metadata)).resolves.toMatchObject({
      outcomes: [{ transactionId: inclusionTxId(0n), accepted: false, batchItemIndex: 0n }],
    });
    expect(getReceipt).toHaveBeenCalledWith({ inclusionId: {
      l1BlockHash: L1_BLOCK_HASH,
      l1TransactionIndex: 0,
      batchItemIndex: 0,
    } });
    expect(getReceipt).not.toHaveBeenCalledWith(TX_ID);
  });

  it("clears the journal only after the node has served the inclusion", async () => {
    let latchedWhileObserving: boolean | undefined;
    const test: ReturnType<typeof setup> = setup("calldata", {
      getReceipt: async () => {
        latchedWhileObserving = (await test.journal.read()).length === 1;
        return [acceptedReceipt()];
      },
    });

    await expect(submit(test.submitter, BATCH, test.quote, metadata)).resolves.toMatchObject({
      observed: true,
    });
    expect(latchedWhileObserving).toBe(true);
    expect(test.events.at(-1)).toBe("clear");
    await expect(test.journal.read()).resolves.toEqual([]);
  });

  it.each(["success", "reverted"] as const)("settles a carrier with %s receipt once the node records its delivery, and not before", async receiptStatus => {
    let recorded: L1DeliveryBatchResult | null = null;
    const test = setup("calldata", {
      receipt: receiptStatus,
      getReceipt: async () => [],
      getInboxDeliveryBatch: async () => recorded,
      observationTimeoutMs: 10,
    });
    await expect(submit(test.submitter, BATCH, test.quote, metadata))
      .rejects.toBeInstanceOf(RelayDeadlineError);
    const [held] = await test.journal.read();
    expect(held).toBeDefined();

    // The node has not derived the inclusion block: its entries still read as
    // ready, so a fresh relay would post them again.
    await expect(test.submitter.assertAvailable()).rejects.toThrow(/unobserved/);
    await expect(test.journal.read()).resolves.toHaveLength(1);

    recorded = { l1TransactionHash: held!.transactionHash! } as L1DeliveryBatchResult;
    await expect(test.submitter.assertAvailable()).resolves.toBeUndefined();
    await expect(test.journal.read()).resolves.toEqual([]);
    expect(test.events.filter((event) => event === "broadcast")).toHaveLength(1);
  });

  it("settles canonical PCASH outcomes despite an Ethereum receipt status of zero", async () => {
    const test = setup("calldata", { receipt: "reverted", getInboxDeliveryBatch: async hash => delivery(hash) });
    const result = await submit(test.submitter, BATCH, test.quote, { ...metadata, observationMode: "batch" });
    expect(result.receipt.status).toBe(0);
    expect(result.observed).toBe(true);
    expect(result.outcomes).toEqual([expect.objectContaining({ transactionId: inclusionTxId(0n), outcome: "succeeded" })]);
    expect(test.events.at(-1)).toBe("clear");
    await expect(test.journal.read()).resolves.toEqual([]);
  });

  it("serializes a post-Fusaka EIP-7594 blob wrapper with cell proofs", async () => {
    const test = setup("blobs");
    const preparedQuote = structuredClone((await test.submitter.quote(status, BATCH, "blobs")).selected);

    await submit(test.submitter, BATCH, preparedQuote, {
      selected: [TX_ID],
      collectibleOpenFee: 7n,
      headCheckedBlock: 8n,
      headCheckedBlockHash: ANCHOR_HASH,
    });

    const transaction = Transaction.from(test.raw()!);
    expect(transaction.type).toBe(3);
    expect(transaction.data).toBe("0x");
    expect(transaction.blobWrapperVersion).toBe(1);
    expect(transaction.blobVersionedHashes).toEqual(preparedQuote.blobVersionedHashes);
    expect(transaction.blobs).toHaveLength(1);
    expect(transaction.blobs?.[0]?.proof.length).toBe(2 + 128 * 48 * 2);
    expect(test.kzgCalls).toEqual({ commitment: 1, proofs: 1 });
  });

  it("retries cached KZG initialization after a rejection", async () => {
    let attempts = 0;
    const initialize = retryableInitialization(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("initialization failed");
      return "ready";
    });

    await expect(initialize()).rejects.toThrow(/initialization failed/);
    await expect(initialize()).resolves.toBe("ready");
    await expect(initialize()).resolves.toBe("ready");
    expect(attempts).toBe(2);
  });

  it.each([
    ["ambiguous broadcast", { broadcast: "error" as const }, RelayUpstreamError],
    ["returned-hash mismatch", { broadcast: "mismatch" as const }, RelayUpstreamError],
    ["receipt timeout", { receipt: "pending" as const, receiptTimeoutMs: 10 }, RelayDeadlineError],
  ])("keeps the journal entry after %s", async (_label, options, ExpectedError) => {
    const test = setup("calldata", options);

    await expect(submit(test.submitter, BATCH, test.quote, metadata))
      .rejects.toBeInstanceOf(ExpectedError);

    await expect(test.journal.read()).resolves.toHaveLength(1);
    await expect(submit(test.submitter, BATCH, test.quote, metadata))
      .rejects.toBeInstanceOf(RelayJournalConflictError);
  });

  it("bounds automatic journal recovery: a hung delivery read keeps the entry and releases the queue", async () => {
    let tail = Promise.resolve();
    const runExclusive = <T>(operation: () => Promise<T>): Promise<T> => {
      const running = tail.then(operation, operation);
      tail = running.then(() => undefined, () => undefined);
      return running;
    };
    const test = setup("calldata", {
      getReceipt: async () => [],
      getInboxDeliveryBatch: () => new Promise<never>(() => undefined),
      observationTimeoutMs: 10,
      runExclusive,
    });
    await expect(submit(test.submitter, BATCH, test.quote, metadata))
      .rejects.toBeInstanceOf(RelayDeadlineError);
    await expect(test.journal.read()).resolves.toHaveLength(1);

    vi.useFakeTimers();
    try {
      const recovery = expect(test.submitter.assertAvailable()).rejects.toBeInstanceOf(RelayDeadlineError);
      const queued = runExclusive(async () => "ran");
      await vi.advanceTimersByTimeAsync(RECOVERY_RPC_TIMEOUT_MS);
      await recovery;
      await expect(queued).resolves.toBe("ran");
    } finally {
      vi.useRealTimers();
    }
    await expect(test.journal.read()).resolves.toHaveLength(1);
  });

  it("holds the exclusive queue only through broadcast, never across settlement", async () => {
    let held = 0;
    let tail = Promise.resolve();
    const runExclusive = <T>(operation: () => Promise<T>): Promise<T> => {
      const running = tail.then(async () => {
        held += 1;
        try { return await operation(); } finally { held -= 1; }
      });
      tail = running.then(() => undefined, () => undefined);
      return running;
    };
    let heldWhileObserving: number | undefined;
    const test = setup("calldata", {
      getReceipt: async () => {
        heldWhileObserving = held;
        return [acceptedReceipt()];
      },
      runExclusive,
    });

    await submit(test.submitter, BATCH, test.quote, metadata);
    expect(heldWhileObserving).toBe(0);
  });

  it("bounds a stalled observation RPC, releases submission serialization, and keeps the entry", async () => {
    let tail = Promise.resolve();
    const runExclusive = <T>(operation: () => Promise<T>): Promise<T> => {
      const running = tail.then(operation, operation);
      tail = running.then(() => undefined, () => undefined);
      return running;
    };
    const test = setup("calldata", {
      getReceipt: async () => [],
      observationTimeoutMs: 10,
      runExclusive,
    });

    // A second attempt proves the queue is no longer held by the unresolved
    // node read, while the mined but unobserved first carrier still holds the journal.
    await expect(submit(test.submitter, BATCH, test.quote, metadata))
      .rejects.toBeInstanceOf(RelayDeadlineError);
    await expect(submit(test.submitter, BATCH, test.quote, metadata))
      .rejects.toBeInstanceOf(RelayJournalConflictError);
    expect(test.events.filter((event) => event === "broadcast")).toHaveLength(1);
  });

  it("keeps the journal entry while the exact batch entry has no receipt yet", async () => {
    const test = setup("calldata", {
      getReceipt: async () => [],
      observationTimeoutMs: 10,
    });

    await expect(submit(test.submitter, BATCH, test.quote, metadata))
      .rejects.toBeInstanceOf(RelayDeadlineError);
    await expect(test.journal.read()).resolves.toHaveLength(1);
  });

  it("treats an entry already cleared by a concurrent reconcile as a successful relay", async () => {
    const test: ReturnType<typeof setup> = setup("calldata", {
      getReceipt: async () => {
        // Another reconcile saw the recorded delivery and released the entry.
        for (const held of await test.journal.read()) await test.journal.clear(held.resolutionId);
        return [acceptedReceipt()];
      },
    });

    await expect(submit(test.submitter, BATCH, test.quote, metadata)).resolves.toMatchObject({
      observed: true,
    });
    await expect(test.journal.read()).resolves.toEqual([]);
  });

  it("still fails when its own entry cannot be cleared", async () => {
    const test = setup("calldata");
    test.journal.clear = async () => {
      throw new Error("disk full");
    };

    await expect(submit(test.submitter, BATCH, test.quote, metadata)).rejects.toThrow(/disk full/);
    await expect(test.journal.read()).resolves.toHaveLength(1);
  });

  it.each([
    ["an L1 timeout as a deadline", async () => {
      throw new TimeoutError({ body: {}, url: "http://unused" });
    }, RelayDeadlineError, /verifying L1 identity timed out/],
    ["an L1 identity mismatch with its message", async () => "0x2", RelayUpstreamError, /L1 endpoint chain id 2 does not match/],
  ])("reports %s", async (_label, chainId, ExpectedError, message) => {
    const submitter = new PrivateKeyRelaySubmitter({
      rpcUrl: "http://unused",
      privateKey: PRIVATE_KEY,
      node: {
        getReceipt: async () => [],
        status: async () => status,
        getInboxDeliveryBatch: async () => null,
      },
      journal: new MemoryRelayJournal(),
      transport: custom({
        async request({ method }) {
          if (method === "eth_chainId") return chainId();
          throw new Error(`unexpected RPC method ${method}`);
        },
      }),
    });

    const failure = await submitter.quote(status, BATCH, "calldata").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ExpectedError);
    expect((failure as Error).message).toMatch(message);
  });

  it("submits the prepared batch without querying the mempool", async () => {
    const test = setup("calldata");

    await expect(submit(test.submitter, BATCH, test.quote, metadata)).resolves.toMatchObject({
      observed: true,
    });
    expect(test.events.filter((event) => event === "broadcast")).toHaveLength(1);
  });
});

describe("RelayL1Submitter in-flight transactions", () => {
  const THIRD_TX_ID = `0x${"97".repeat(32)}`;

  /** An entry a crashed process left behind: nothing in this process is settling it. */
  function leftover(nonce: number): RelayJournalEntry {
    const hash = `0x${(0xe0 + nonce).toString(16).repeat(32)}`;
    return {
      kind: "call",
      createdAt: "2026-08-25T00:00:00.000Z",
      resolutionId: hash,
      phase: "broadcast_accepted",
      submissionKind: "signed_raw",
      transactionHash: hash,
      signedTransaction: "0x02aa",
      previousTransactionHashes: [],
      lastBroadcastBlock: "9",
      relayerAddress: `0x${"88".repeat(20)}`,
      chainId: "1",
      nonce: String(nonce),
      gasLimit: "21000",
      maxFeePerGas: "10",
      maxPriorityFeePerGas: "1",
      genesisL1Block: "5",
      genesisL1BlockHash: ANCHOR_HASH,
      to: RECIPIENT,
      value: "1",
      data: "0x",
    };
  }

  it("broadcasts up to maxInFlight transactions at consecutive nonces", async () => {
    const test = setup("calldata", { maxInFlight: 2, receipt: "pending" });

    const first = await test.submitter.send(status, BATCH, test.quote, metadata);
    const second = await test.submitter.send(status, BATCH, test.quote, { ...metadata, selected: [OTHER_TX_ID] });

    // The node still reports pending nonce 3: the journal holds the next one.
    expect(test.raws.map((raw) => Transaction.from(raw).nonce)).toEqual([3, 4]);
    expect([first.txHash, second.txHash]).toEqual(test.raws.map((raw) => Transaction.from(raw).hash));
    await expect(test.journal.read()).resolves.toMatchObject([{ nonce: "3" }, { nonce: "4" }]);
    await expect(test.submitter.inFlight()).resolves.toEqual([TX_ID.toLowerCase(), OTHER_TX_ID.toLowerCase()]);
  });

  it("refuses at once when the journal is full of transactions nothing here is settling", async () => {
    const test = setup("calldata", { maxInFlight: 2, receipt: "pending" });
    await test.journal.create(leftover(7));
    await test.journal.create(leftover(8));

    const failure = await test.submitter.send(status, BATCH, test.quote, metadata).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(RelayJournalConflictError);
    expect((failure as Error).message).toMatch(/2 L1 transactions are in flight \(relay journal 0x.* is pending; relay journal 0x.* is pending\)/);
    await expect(test.submitter.assertAvailable()).rejects.toThrow(/2 L1 transactions are in flight/);
    await expect(test.submitter.sendCall({ to: RECIPIENT, value: 1n })).rejects.toBeInstanceOf(RelayJournalConflictError);
    expect(test.raws).toEqual([]);
  });

  it("allocates past a leftover entry when the journal has room", async () => {
    const test = setup("calldata", { maxInFlight: 2, receipt: "pending" });
    await test.journal.create(leftover(7));

    await test.submitter.send(status, BATCH, test.quote, metadata);

    expect(Transaction.from(test.raw()!).nonce).toBe(8);
  });

  it("waits for this process's own settling transaction when the journal is full, then broadcasts at the next nonce", async () => {
    const test = setup("calldata", { maxInFlight: 2 });
    const first = await test.submitter.send(status, BATCH, test.quote, metadata);
    await test.submitter.send(status, BATCH, test.quote, { ...metadata, selected: [OTHER_TX_ID] });

    let sent = false;
    const third = test.submitter.send(status, BATCH, test.quote, { ...metadata, selected: [THIRD_TX_ID] })
      .then((broadcast) => { sent = true; return broadcast; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sent).toBe(false);
    expect(test.raws).toHaveLength(2);

    await first.settle();
    await third;

    // The first nonce is settled; the second is still journaled at 4.
    expect(test.raws.map((raw) => Transaction.from(raw).nonce)).toEqual([3, 4, 5]);
    await expect(test.journal.read()).resolves.toMatchObject([{ nonce: "4" }, { nonce: "5" }]);
  });

  it("fails a waiting send when the settlement it waited for leaves its entry behind", async () => {
    const test = setup("calldata", { receipt: "pending", receiptTimeoutMs: 10 });
    const first = await test.submitter.send(status, BATCH, test.quote, metadata);

    const second = test.submitter.send(status, BATCH, test.quote, { ...metadata, selected: [OTHER_TX_ID] })
      .catch((error: unknown) => error);
    await expect(first.settle()).rejects.toBeInstanceOf(RelayDeadlineError);

    const failure = await second;
    expect(failure).toBeInstanceOf(RelayJournalConflictError);
    expect((failure as Error).message).toMatch(/is pending/);
    expect(test.raws).toHaveLength(1);
  });

  it("stops waiting on a broadcast nobody settles once its receipt and observation could have timed out", async () => {
    const test = setup("calldata", { receipt: "pending", receiptTimeoutMs: 10, observationTimeoutMs: 10 });
    await test.submitter.send(status, BATCH, test.quote, metadata);

    const failure = await test.submitter.send(status, BATCH, test.quote, { ...metadata, selected: [OTHER_TX_ID] })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RelayJournalConflictError);
    expect((failure as Error).message).toMatch(/is pending/);
    expect(test.raws).toHaveLength(1);
  });

  it("refuses to broadcast a content hash an unsettled batch already carries", async () => {
    const test = setup("calldata", { maxInFlight: 2, receipt: "pending" });
    await test.submitter.send(status, BATCH, test.quote, metadata);

    const failure = await test.submitter.send(status, BATCH, test.quote, { ...metadata, selected: [OTHER_TX_ID, TX_ID] })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(RelayJournalConflictError);
    expect((failure as Error).message).toMatch(new RegExp(`content hash ${TX_ID} is already in flight: .* is pending`));
    expect(test.raws).toHaveLength(1);
  });

  it("queues a second send at maxInFlight 1 behind this process's settling batch", async () => {
    const test = setup("calldata", { maxInFlight: 1 });
    const first = await test.submitter.send(status, BATCH, test.quote, metadata);
    const second = test.submitter.send(status, BATCH, test.quote, { ...metadata, selected: [OTHER_TX_ID] });

    await first.settle();
    await second;

    // The first nonce is settled; the node's pending nonce is the floor again.
    expect(test.raws.map((raw) => Transaction.from(raw).nonce)).toEqual([3, 3]);
    expect(test.events.filter((event) => event !== "receipt"))
      .toEqual(["journal", "broadcast", "clear", "journal", "broadcast"]);
  });

  it("allocates distinct nonces to concurrent sends from separate submitters of one account", async () => {
    const events: string[] = [];
    const journal = new EventJournal(events);
    const left = setup("calldata", { maxInFlight: 2, receipt: "pending", journal, events });
    const right = setup("calldata", { maxInFlight: 2, receipt: "pending", journal, events });

    await Promise.all([
      left.submitter.send(status, BATCH, left.quote, metadata),
      right.submitter.send(status, BATCH, right.quote, { ...metadata, selected: [OTHER_TX_ID] }),
    ]);

    const nonces = [...left.raws, ...right.raws].map((raw) => Transaction.from(raw).nonce).sort();
    expect(nonces).toEqual([3, 4]);
    await expect(journal.read()).resolves.toHaveLength(2);
  });

  it("rejects a non-positive maxInFlight or receipt polling interval", () => {
    const config = {
      rpcUrl: "http://unused",
      privateKey: PRIVATE_KEY,
      node: {
        getReceipt: async () => [],
        status: async () => status,
        getInboxDeliveryBatch: async () => null,
      },
      journal: new MemoryRelayJournal(),
    };
    expect(() => new PrivateKeyRelaySubmitter({ ...config, maxInFlight: 0 })).toThrow(/maxInFlight must be a positive integer/);
    expect(() => new PrivateKeyRelaySubmitter({ ...config, receiptPollMs: 0 })).toThrow(/receiptPollMs must be a positive integer/);
  });
});

describe("RelayL1Submitter.sendCall", () => {
  it("journals a plain call, broadcasts it at the account's next nonce, and clears it at the receipt", async () => {
    const test = setup("calldata", { maxInFlight: 2 });
    const batch = await test.submitter.send(status, BATCH, test.quote, metadata);

    const call = await test.submitter.sendCall({ to: RECIPIENT, value: 1_000n });

    const transaction = Transaction.from(test.raw()!);
    expect(call.txHash).toBe(transaction.hash);
    expect(transaction.type).toBe(2);
    expect(transaction.to?.toLowerCase()).toBe(RECIPIENT);
    expect(transaction.value).toBe(1_000n);
    expect(transaction.data).toBe("0x");
    expect(transaction.nonce).toBe(4);
    expect(transaction.gasLimit).toBe(21_000n);
    await expect(test.journal.read()).resolves.toMatchObject([
      { kind: "batch", nonce: "3" },
      { kind: "call", nonce: "4", to: RECIPIENT, value: "1000", data: "0x", phase: "broadcast_accepted" },
    ]);
    // A call carries no PCASH entries.
    await expect(test.submitter.inFlight()).resolves.toEqual([TX_ID.toLowerCase()]);

    await expect(call.settle()).resolves.toMatchObject({ txHash: call.txHash, blockNumber: 9n, gasUsed: 21_000n });
    await expect(test.journal.read()).resolves.toMatchObject([{ kind: "batch" }]);
    await batch.settle();
    await expect(test.journal.read()).resolves.toEqual([]);
  });

  it("clears a reverted call and reports the revert", async () => {
    const test = setup("calldata", { receipt: "reverted" });
    const call = await test.submitter.sendCall({ to: RECIPIENT, value: 1n, gasLimit: 30_000n });
    expect(Transaction.from(test.raw()!).gasLimit).toBe(30_000n);

    await expect(call.settle()).rejects.toThrow(/L1 call .* reverted/);
    await expect(test.journal.read()).resolves.toEqual([]);
  });

  it("refuses an unaffordable or malformed call before journaling it", async () => {
    const test = setup("calldata");
    await expect(test.submitter.sendCall({ to: RECIPIENT, value: 1_000_000n }))
      .rejects.toThrow(/underfunded: balance 1000000 wei < maximum call cost/);
    await expect(test.submitter.sendCall({ to: "0x99", value: 1n })).rejects.toBeInstanceOf(RelayValidationError);
    await expect(test.submitter.sendCall({ to: RECIPIENT, value: -1n })).rejects.toBeInstanceOf(RelayValidationError);
    expect(test.events).toEqual([]);
  });

  it("shares the account's in-flight limit with batches", async () => {
    const test = setup("calldata");
    const call = await test.submitter.sendCall({ to: RECIPIENT, value: 1n });
    const batch = test.submitter.send(status, BATCH, test.quote, metadata);

    await call.settle();
    await batch;

    // The batch took no nonce of its own past the call: it was admitted only
    // once the call's entry was released, by its settlement or a reconcile.
    expect(test.raws.map((raw) => Transaction.from(raw).nonce)).toEqual([3, 3]);
    expect(test.events.indexOf("clear")).toBeLessThan(test.events.lastIndexOf("journal"));
    await expect(test.journal.read()).resolves.toMatchObject([{ kind: "batch" }]);
  });
});

function delivery(txHash: string, overrides: Partial<L1DeliveryBatchResult> = {}): L1DeliveryBatchResult {
  return {
    l1BlockNumber: 9n,
    l1BlockHash: L1_BLOCK_HASH,
    l1TransactionIndex: 0n,
    l1TransactionHash: txHash,
    l1Sender: `0x${"88".repeat(20)}`,
    carrierType: "calldata",
    logIndex: null,
    emitter: null,
    context: null,
    carrierHash: txHash,
    carrierLength: BigInt(ENTRY.length),
    blobVersionedHashes: [],
    posterOwnerCommitment: `0x${"0".repeat(63)}1`,
    posterContext: `0x${"00".repeat(32)}`,
    exclusionReason: null,
    items: [{
      batchItemIndex: 0n,
      contentHash: TX_ID,
      byteOffset: 0n,
      byteLength: BigInt(ENTRY.length),
      exclusionReason: null,
    }],
    ...overrides,
  };
}

/** A transport that can price both carriers, with estimateGas and KZG failures on demand. */
function quotingSubmitter(options: {
  estimateGas?: "fail" | "fail-calldata";
  kzg?: "fail";
  maxFeePerGas?: bigint;
} = {}) {
  const transport = custom({
    async request({ method, params }) {
      switch (method) {
        case "eth_chainId": return "0x1";
        case "eth_getBlockByNumber": return { hash: ANCHOR_HASH, number: "0x5", baseFeePerGas: "0x1" };
        case "eth_maxPriorityFeePerGas": return "0x1";
        case "eth_getBalance": return "0xf4240";
        case "eth_feeHistory":
          return {
            oldestBlock: "0x5",
            baseFeePerGas: ["0x1", "0x2"],
            gasUsedRatio: [0.5],
            reward: [[]],
            baseFeePerBlobGas: ["0x1", "0x1"],
          };
        case "eth_estimateGas": {
          const request = (params as [Record<string, unknown>])[0];
          if (options.estimateGas === "fail") throw new Error("execution reverted");
          if (options.estimateGas === "fail-calldata" && !("blobVersionedHashes" in request)) {
            throw new Error("execution reverted");
          }
          return "0x5208";
        }
        default:
          throw new Error(`unexpected RPC method ${method}`);
      }
    },
  }, { retryCount: 0 });
  return new PrivateKeyRelaySubmitter({
    rpcUrl: "http://unused",
    privateKey: PRIVATE_KEY,
    node: {
      getReceipt: async () => [],
      status: async () => status,
      getInboxDeliveryBatch: async () => null,
    },
    journal: new MemoryRelayJournal(),
    transport,
    loadKzg: options.kzg === "fail"
      ? async () => { throw new Error("kzg wasm missing at https://cdn.example/SECRETKEY"); }
      : async () => ({
        blobToKZGCommitment: () => COMMITMENT,
        computeCellsAndKZGProofs: () => ({ proofs: Array.from({ length: 128 }, () => CELL_PROOF) }),
      }) as never,
    ...(options.maxFeePerGas === undefined ? {} : { maxFeePerGas: options.maxFeePerGas }),
  });
}

describe("RelayL1Submitter error paths", () => {
  it("refuses to broadcast when the relay account is underfunded", async () => {
    const message = /underfunded: balance 1000000 wei < maximum relay cost 1000001 wei/;
    const test = setup("calldata");
    const underfunded = { ...test.quote, maximumCostWei: 1_000_001n };
    const failure = await submit(test.submitter, BATCH, underfunded, metadata)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RelayUpstreamError);
    expect((failure as Error).message).toMatch(message);
    expect(test.events).toEqual([]);
    await expect(test.journal.read()).resolves.toEqual([]);

    // A direct caller learns that nothing reached L1.
    const direct = await submit(test.submitter, BATCH, underfunded, {
      ...metadata,
      source: "direct",
    }).catch((error: unknown) => error);
    expect((direct as Error).name).toBe("RelayPreBroadcastError");
    expect((direct as Error).message).toMatch(message);
  });

  it("reports a journal conflict to a direct caller unwrapped", async () => {
    const test = setup("calldata", { receipt: "pending" });
    await test.submitter.send(status, BATCH, test.quote, metadata);

    const direct = await test.submitter.send(status, BATCH, test.quote, { ...metadata, source: "direct" })
      .catch((error: unknown) => error);
    expect(direct).toBeInstanceOf(RelayJournalConflictError);
  });

  it("rejects an empty batch before touching the journal or L1", async () => {
    const test = setup("calldata");
    await expect(submit(test.submitter, "0x", test.quote, metadata))
      .rejects.toThrow(/cannot submit an empty relay batch/);
    await expect(test.submitter.quote(status, "0x", "auto"))
      .rejects.toThrow(/cannot quote an empty relay batch/);
    expect(test.events).toEqual([]);
  });

  it("rejects duplicate or mismatched batch item indexes before broadcasting", async () => {
    const test = setup("calldata");
    for (const batchItemIndexes of [[0, 0], [0], [-1, 1]]) {
      await expect(submit(test.submitter, BATCH, test.quote, {
        ...metadata,
        selected: [TX_ID, TX_ID],
        batchItemIndexes,
      })).rejects.toThrow(/batch item indexes must be unique nonnegative safe integers/);
    }
    expect(test.events).toEqual([]);
  });

  it("reports both carrier failures when neither can be quoted, keeping upstream text on the cause", async () => {
    const failure = await quotingSubmitter({ estimateGas: "fail", kzg: "fail" })
      .quote(status, BATCH, "auto")
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RelayUpstreamError);
    expect((failure as Error).message).toBe(
      "neither relay carrier could be quoted (calldata: estimating relay gas failed (EstimateGasExecutionError); blobs: loading KZG failed (Error))",
    );
    const reasons = ((failure as Error).cause as AggregateError).errors as Error[];
    expect(reasons.map((reason) => reason.message)).toEqual([
      "estimating relay gas failed (EstimateGasExecutionError)",
      "loading KZG failed (Error)",
    ]);
    expect((reasons[1]!.cause as Error).message).toBe("kzg wasm missing at https://cdn.example/SECRETKEY");
  });

  it("falls back to the carrier that could be quoted", async () => {
    const blobsOnly = await quotingSubmitter({ estimateGas: "fail-calldata" }).quote(status, BATCH, "auto");
    expect(blobsOnly.calldata).toBeUndefined();
    expect(blobsOnly.selected).toBe(blobsOnly.blobs);

    const calldataOnly = await quotingSubmitter({ kzg: "fail" }).quote(status, BATCH, "auto");
    expect(calldataOnly.blobs).toBeUndefined();
    expect(calldataOnly.selected).toBe(calldataOnly.calldata);
  });

  it("caps the estimated max fee per gas at the configured maximum", async () => {
    const quotes = await quotingSubmitter().quote(status, BATCH, "calldata");
    const estimated = quotes.selected.maxFeePerGas;
    await expect(quotingSubmitter({ maxFeePerGas: estimated }).quote(status, BATCH, "calldata"))
      .resolves.toMatchObject({ selected: { maxFeePerGas: estimated } });
    const failure = await quotingSubmitter({ maxFeePerGas: estimated - 1n })
      .quote(status, BATCH, "calldata")
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RelayValidationError);
    expect((failure as Error).message).toBe(
      `estimated L1 max fee per gas ${estimated} wei exceeds configured maximum ${estimated - 1n} wei`,
    );
  });

  it.each([
    ["another L1 transaction", { l1TransactionHash: `0x${"99".repeat(32)}` }, /belong to another inclusion/],
    ["another L1 block", { l1BlockHash: ANCHOR_HASH }, /belong to another inclusion/],
    ["another transaction index", { l1TransactionIndex: 1n }, /belong to another inclusion/],
    ["a batch-level exclusion", { exclusionReason: "unsupportedVersion" }, /relay batch was excluded: unsupportedVersion/],
    ["a missing batch item", { items: [] }, /do not match batch item 0/],
    ["another content hash", {
      items: [{
        batchItemIndex: 0n,
        contentHash: `0x${"99".repeat(32)}`,
        byteOffset: 0n,
        byteLength: 1n,
        exclusionReason: "unknownKind",
      }],
    }, /do not match batch item 0/],
  ] as Array<[string, Partial<L1DeliveryBatchResult>, RegExp]>)(
    "keeps the journal entry when delivery diagnostics report %s",
    async (_label, overrides, message) => {
      const test = setup("calldata", {
        getInboxDeliveryBatch: async (txHash) => delivery(txHash, overrides),
      });
      const failure = await submit(test.submitter, BATCH, test.quote, { ...metadata, observationMode: "batch" })
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(RelayUpstreamError);
      expect((failure as Error).message).toMatch(message);
      await expect(test.journal.read()).resolves.toHaveLength(1);
    },
  );

  it.each([
    ["multiple receipts", () => [acceptedReceipt(), acceptedReceipt()], /multiple receipts for batch item 0/],
    ["another L1 inclusion", () => {
      const other = acceptedReceipt();
      return [{ ...other, inclusion: { ...other.inclusion, batchItemIndex: 1n } }];
    }, /Receipt 0 belongs to another L1 inclusion/],
  ] as Array<[string, () => ReceiptResult[], RegExp]>)(
    "keeps the journal entry when the node returns %s",
    async (_label, receipts, message) => {
      const test = setup("calldata", { getReceipt: async () => receipts() });
      const failure = await submit(test.submitter, BATCH, test.quote, metadata)
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(RelayUpstreamError);
      expect((failure as Error).message).toMatch(message);
      await expect(test.journal.read()).resolves.toHaveLength(1);
    },
  );
});

describe("PrivateKeyRelaySubmitter replacements", () => {
  const chain = (): NonNullable<SetupOptions["l1"]> => ({ block: 9n, baseFee: 1n, blobBaseFee: 1n, tip: 1n });

  async function waitFor(check: () => boolean) {
    const deadline = Date.now() + 3_000;
    while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 2));
    expect(check()).toBe(true);
  }

  it.each(["calldata", "blobs"] as const)("bumps a %s batch after three blocks, preserves its payload, and throttles attempts", async (carrier) => {
    const l1 = chain();
    const test = setup(carrier, { l1, receiptTimeoutMs: 5_000 });
    const carrierQuote = carrier === "blobs" ? (await test.submitter.quote(status, BATCH, "blobs")).selected : test.quote;
    const sent = await test.submitter.send(status, BATCH, carrierQuote, metadata);
    const settled = sent.settle();
    const failure = settled.catch((error: unknown) => error);
    l1.block = 11n;
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(test.raws).toHaveLength(1);
    l1.block = 12n;
    await waitFor(() => test.raws.length === 2);
    const original = Transaction.from(test.raws[0]!);
    const replacement = Transaction.from(test.raws[1]!);
    for (const field of ["nonce", "chainId", "to", "value", "data", "gasLimit", "type", "blobWrapperVersion", "blobVersionedHashes", "blobs"] as const) {
      expect(replacement[field]).toEqual(original[field]);
    }
    expect(replacement.maxFeePerGas).toBe(carrier === "blobs" ? 4n : 11n);
    expect(replacement.maxPriorityFeePerGas).toBe(2n);
    if (carrier === "blobs") {
      expect(replacement.maxFeePerBlobGas).toBe(4n);
      expect(test.kzgCalls).toEqual({ commitment: 1, proofs: 1 });
    }
    const recorded = (await test.journal.read())[0]!;
    expect(recorded).toMatchObject({
      resolutionId: sent.txHash, previousTransactionHashes: [sent.txHash],
      transactionHash: replacement.hash, lastBroadcastBlock: "12",
    });
    l1.baseFee = 100n;
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(test.raws).toHaveLength(2);
    l1.baseFee = 1n;
    l1.minedHash = replacement.hash!;
    expect(await failure).toMatchObject({ txHash: replacement.hash, observed: true });
    await expect(test.journal.read()).resolves.toEqual([]);
  });

  it.each(["execution", "blob"] as const)("replaces immediately on an %s base-fee spike and journals before sending", async (fee) => {
    const l1 = chain();
    let test: ReturnType<typeof setup>;
    test = setup(fee === "blob" ? "blobs" : "calldata", {
      l1, receiptTimeoutMs: 5_000,
      beforeBroadcast: async (raw, attempt) => {
        const saved = (await test.journal.read())[0]!;
        expect(saved.signedTransaction).toBe(raw);
        expect(saved.phase).toBe("broadcast_attempted");
        expect(saved.previousTransactionHashes).toHaveLength(attempt - 1);
        if (attempt === 2) l1.minedHash = Transaction.from(raw).hash!;
      },
    });
    const carrierQuote = fee === "blob" ? (await test.submitter.quote(status, BATCH, "blobs")).selected : test.quote;
    const sent = await test.submitter.send(status, BATCH, carrierQuote, metadata);
    l1.block += 1n;
    if (fee === "blob") l1.blobBaseFee = 3n;
    else l1.baseFee = 11n;
    const result = await sent.settle();
    expect(result.txHash).not.toBe(sent.txHash);
    const replacement = Transaction.from(test.raws[1]!);
    expect(replacement.maxFeePerGas).toBe(fee === "blob" ? 4n : 14n);
    expect(replacement.maxPriorityFeePerGas).toBe(2n);
    if (fee === "blob") expect(replacement.maxFeePerBlobGas).toBe(6n);
  });

  it("uses the ceiling when the fresh estimate is higher but an includable replacement fits", async () => {
    const l1 = chain();
    const test = setup("calldata", { l1, maxFeePerGas: 13n, receiptTimeoutMs: 1_000,
      beforeBroadcast: async (raw, attempt) => { if (attempt === 2) l1.minedHash = Transaction.from(raw).hash!; },
    });
    const sent = await test.submitter.send(status, BATCH, test.quote, metadata);
    l1.block += 1n;
    l1.baseFee = 11n;
    l1.tip = 8n;
    await sent.settle();
    const replacement = Transaction.from(test.raws[1]!);
    expect(replacement.maxFeePerGas).toBe(13n);
    expect(replacement.maxPriorityFeePerGas).toBe(2n);
  });

  it.each([10n, 12n])("stops at a %s wei ceiling, then recovers when the original mines", async (maxFeePerGas) => {
    const l1 = chain();
    const test = setup("calldata", { l1, maxFeePerGas,
      getInboxDeliveryBatch: async () => ({ l1TransactionHash: l1.minedHash }) as L1DeliveryBatchResult,
    });
    const sent = await test.submitter.send(status, BATCH, test.quote, metadata);
    l1.block += 1n;
    l1.baseFee = 11n;
    await expect(sent.settle()).rejects.toMatchObject({
      name: "RelayFeeCeilingError", resolutionId: sent.txHash, transactionHash: sent.txHash, maxFeePerGas,
    });
    await expect(test.submitter.assertAvailable()).rejects.toBeInstanceOf(RelayFeeCeilingError);
    expect(test.raws).toHaveLength(1);
    await expect(test.journal.read()).resolves.toHaveLength(1);
    l1.minedHash = sent.txHash;
    await expect(test.submitter.assertAvailable()).resolves.toBeUndefined();
    await expect(test.journal.read()).resolves.toEqual([]);
  });

  it("resumes repricing after a fee ceiling failure when fees fall", async () => {
    const l1 = chain();
    const test = setup("calldata", { l1, maxFeePerGas: 13n,
      getInboxDeliveryBatch: async () => ({ l1TransactionHash: l1.minedHash }) as L1DeliveryBatchResult,
    });
    const sent = await test.submitter.send(status, BATCH, test.quote, metadata);
    l1.block = 12n;
    l1.baseFee = 30n;
    await expect(sent.settle()).rejects.toBeInstanceOf(RelayFeeCeilingError);
    l1.baseFee = 11n;
    await expect(test.submitter.assertAvailable()).rejects.toBeInstanceOf(RelayJournalConflictError);
    expect(test.raws).toHaveLength(2);
    expect(Transaction.from(test.raws[1]!).maxFeePerGas).toBe(13n);
    l1.minedHash = Transaction.from(test.raws[1]!).hash!;
    await expect(test.submitter.assertAvailable()).resolves.toBeUndefined();
  });

  it("recovers after a timeout using a new submitter and retains hashes after an uncertain replacement send", async () => {
    const l1 = chain();
    const original = setup("calldata", { l1, receiptTimeoutMs: 10 });
    const sent = await original.submitter.send(status, BATCH, original.quote, metadata);
    await expect(sent.settle()).rejects.toBeInstanceOf(RelayDeadlineError);
    const restarted = setup("calldata", { l1, journal: original.journal, broadcast: "error",
      getInboxDeliveryBatch: async () => ({ l1TransactionHash: l1.minedHash }) as L1DeliveryBatchResult,
    });
    l1.block = 12n;
    await expect(restarted.submitter.assertAvailable()).rejects.toBeInstanceOf(RelayUpstreamError);
    const saved = (await original.journal.read())[0]!;
    expect(saved).toMatchObject({ phase: "broadcast_attempted", resolutionId: sent.txHash,
      previousTransactionHashes: [sent.txHash], transactionHash: Transaction.from(restarted.raws[0]!).hash });
    await expect(restarted.submitter.assertAvailable()).rejects.toBeInstanceOf(RelayJournalConflictError);
    expect(restarted.raws).toHaveLength(1);
    l1.minedHash = sent.txHash;
    await expect(restarted.submitter.assertAvailable()).resolves.toBeUndefined();
    await expect(original.journal.read()).resolves.toEqual([]);
  });

  it.each([false, true])("resends the exact saved replacement at the ceiling after a dropped send (restart: %s)", async (restart) => {
    const l1 = chain();
    const options: SetupOptions = { l1, maxFeePerGas: 13n,
      beforeBroadcast: async (_raw, attempt) => { if (attempt === 2) throw new Error("endpoint unavailable before send"); },
      getInboxDeliveryBatch: async () => l1.minedHash === undefined ? null
        : { l1TransactionHash: l1.minedHash } as L1DeliveryBatchResult,
    };
    const original = setup("calldata", options);
    const sent = await original.submitter.send(status, BATCH, original.quote, metadata);
    l1.block = 10n;
    l1.baseFee = 11n;
    await expect(sent.settle()).rejects.toBeInstanceOf(RelayUpstreamError);
    const saved = (await original.journal.read())[0]!;
    expect(saved).toMatchObject({ phase: "broadcast_attempted", maxFeePerGas: "13", maxPriorityFeePerGas: "2" });
    delete options.beforeBroadcast;
    const retrying = restart ? setup("calldata", { ...options, journal: original.journal }) : original;
    const sendsBeforeRetry = retrying.raws.length;
    await expect(retrying.submitter.assertAvailable()).rejects.toBeInstanceOf(RelayJournalConflictError);
    expect(retrying.raws).toHaveLength(sendsBeforeRetry);
    l1.block = 11n;
    await expect(retrying.submitter.assertAvailable()).rejects.toThrow(/is pending/);
    expect(retrying.raws.slice(sendsBeforeRetry)).toEqual([saved.signedTransaction]);
    await expect(original.journal.read()).resolves.toEqual([{ ...saved, phase: "broadcast_accepted", lastBroadcastBlock: "11" }]);
    await expect(retrying.submitter.assertAvailable()).rejects.toThrow(/is pending/);
    expect(retrying.raws).toHaveLength(sendsBeforeRetry + 1);
    l1.minedHash = saved.transactionHash!;
    await expect(retrying.submitter.assertAvailable()).resolves.toBeUndefined();
    await expect(original.journal.read()).resolves.toEqual([]);
  });

  it("recognizes an already-known retry and can subsequently reprice it", async () => {
    const l1 = chain();
    const options: SetupOptions = { l1,
      beforeBroadcast: async (_raw, attempt) => { if (attempt > 1) throw new Error("response lost"); },
      getInboxDeliveryBatch: async () => l1.minedHash === undefined ? null
        : { l1TransactionHash: l1.minedHash } as L1DeliveryBatchResult,
    };
    const test = setup("calldata", options);
    const sent = await test.submitter.send(status, BATCH, test.quote, metadata);
    l1.block = 12n;
    await expect(sent.settle()).rejects.toBeInstanceOf(RelayUpstreamError);
    const saved = (await test.journal.read())[0]!;
    l1.block = 13n;
    options.knownHash = saved.transactionHash!;
    await expect(test.submitter.assertAvailable()).rejects.toThrow(/is pending/);
    expect(test.raws[2]).toBe(test.raws[1]);
    await expect(test.journal.read()).resolves.toMatchObject([{ phase: "broadcast_accepted" }]);
    l1.block = 16n;
    delete options.beforeBroadcast;
    await expect(test.submitter.assertAvailable()).rejects.toThrow(/is pending/);
    expect(test.raws).toHaveLength(4);
    expect(Transaction.from(test.raws[3]!).hash).not.toBe(saved.transactionHash);
    l1.minedHash = Transaction.from(test.raws[3]!).hash!;
    await expect(test.submitter.assertAvailable()).resolves.toBeUndefined();
  });

  it("settles the original if it mines while the replacement send is rejected", async () => {
    const l1 = chain();
    const test = setup("calldata", { l1, receiptTimeoutMs: 1_000,
      beforeBroadcast: async (_raw, attempt) => {
        if (attempt === 2) { l1.minedHash = Transaction.from(test.raws[0]!).hash!; throw new Error("nonce too low"); }
      },
    });
    const sent = await test.submitter.send(status, BATCH, test.quote, metadata);
    l1.block = 12n;
    await expect(sent.settle()).resolves.toMatchObject({ txHash: sent.txHash, observed: true });
    await expect(test.journal.read()).resolves.toEqual([]);
  });

  it("lets settlement replace while a second submitter waits for admission", async () => {
    const l1 = chain();
    const first = setup("calldata", { l1, receiptTimeoutMs: 2_000 });
    const second = setup("calldata", { l1, journal: first.journal, receiptTimeoutMs: 2_000,
      getReceipt: async () => [{ ...acceptedReceipt(), contentHash: OTHER_TX_ID }],
    });
    const sent = await first.submitter.send(status, BATCH, first.quote, metadata);
    const waiting = second.submitter.send(status, BATCH, second.quote, { ...metadata, selected: [OTHER_TX_ID] });
    const completed = sent.settle();
    const firstResult = completed.catch((error: unknown) => error);
    l1.block = 12n;
    await waitFor(() => first.raws.length === 2);
    expect(second.raws).toHaveLength(0);
    l1.minedHash = Transaction.from(first.raws[1]!).hash!;
    expect(await firstResult).toMatchObject({ txHash: l1.minedHash });
    const next = await waiting;
    expect(second.raws).toHaveLength(1);
    l1.minedHash = next.txHash;
    await next.settle();
  });

  it("requires a one-wei increase from a zero tip", async () => {
    const l1 = chain();
    l1.tip = 0n;
    const test = setup("calldata", { l1, receiptTimeoutMs: 1_000,
      beforeBroadcast: async (raw, attempt) => { if (attempt === 2) l1.minedHash = Transaction.from(raw).hash!; },
    });
    const sent = await test.submitter.send(status, BATCH, { ...test.quote, maxPriorityFeePerGas: 0n }, metadata);
    l1.block = 12n;
    await sent.settle();
    expect(Transaction.from(test.raws[1]!).maxPriorityFeePerGas).toBe(1n);
  });

  it("rejects invalid replacement block configuration", () => {
    for (const replacementAfterBlocks of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => setup("calldata", { replacementAfterBlocks })).toThrow(/replacementAfterBlocks/);
    }
  });
});

describe("PrivateKeyRelaySubmitter broadcast", () => {
  it("reports the returned hash on a broadcast hash mismatch and keeps the exact bytes journaled", async () => {
    const test = setup("calldata", { broadcast: "mismatch" });
    const failure = await submit(test.submitter, BATCH, test.quote, metadata)
      .catch((error: unknown) => error);
    const signed = Transaction.from(test.raw()!).hash!;
    expect((failure as Error).message).toBe(`L1 returned transaction hash 0x${"99".repeat(32)}, expected ${signed}`);
    await expect(test.journal.read()).resolves.toMatchObject([{
      phase: "broadcast_attempted",
      transactionHash: signed,
      signedTransaction: test.raw(),
    }]);
  });
});
