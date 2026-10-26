import { IDBFactory } from "fake-indexeddb";
import { custom } from "viem";
import { describe, expect, it, vi } from "vitest";
import type { MempoolItemResult, ReceiptResult } from "../src/clients/index.ts";
import { encodeBatchForVersion, transactionId } from "../src/protocol/index.ts";
import { fromHex, keccak256, toHex } from "../src/utils/index.ts";
import {
  browserRelayJournalKey,
  browserRelayOperationQueue,
  createBrowserRelayer,
  Eip1193RelaySubmitter,
  IndexedDbRelayJournal,
  MAX_BROWSER_RELAY_BATCH_BYTES,
  RelayDeadlineError,
  RelayJournalConflictError,
  RelayJournalRecoveryManager,
  RelayUpstreamError,
  RelayValidationError,
  type Eip1193Provider,
  type RelayCarrierQuote,
  type RelayJournalEntry,
  type RelaySubmissionMetadata,
  type RelaySubmissionResult,
} from "../src/relay/index.ts";
import { MemoryRelayJournal } from "../src/node/relayJournal.ts";
import { NETWORKS } from "../src/constants/networkProfile.ts";

const ADDRESS = `0x${"11".repeat(20)}`;
const INBOX = `0x${"22".repeat(20)}`;
const ANCHOR = `0x${"33".repeat(32)}`;
const L1_HASH = `0x${"55".repeat(32)}`;
const L1_BLOCK_HASH = `0x${"66".repeat(32)}`;
// A real selected entry so submit-time verification can re-encode the batch.
const ENTRY = fromHex(`0x${"ab".repeat(48)}`, "entry");
const TX_ID = toHex(keccak256(ENTRY));
const INCLUSION_TX_ID = toHex(transactionId({
  l1BlockHash: fromHex(L1_BLOCK_HASH, "block hash"),
  l1TransactionIndex: 0n,
  batchItemIndex: 0n,
}));
const BATCH = toHex(encodeBatchForVersion([ENTRY], 1, 1n, 0n));

function selectedMempoolItem(): MempoolItemResult {
  return {
    contentHash: TX_ID,
    statementId: `0x${"aa".repeat(32)}`,
    stableId: "1",
    conflictKeys: [],
    kind: "privateValue",
    byteSize: BigInt(ENTRY.length),
    openFeeAmount: 7n,
    issuanceOwnerCommitment: `0x${"00".repeat(20)}`,
    issuanceRoute: "open",
    validUntil: null,
    status: "ready",
    conflictCount: 0n,
    receivedAtUnixMs: 0n,
    headCheckedBlock: 5n,
    headCheckedBlockHash: ANCHOR,
    recentPcashBlockHash: null,
    publicRecords: [],
    rawTransaction: toHex(ENTRY),
  };
}

function acceptedReceipt(): ReceiptResult {
  return {
    contentHash: TX_ID,
    transactionId: INCLUSION_TX_ID,
    outcome: "succeeded",
    failureDetail: null,
    l1Sender: "0x0000000000000000000000000000000000000000",
    issuanceOwnerCommitment: null,
    settledOpenFeeAmount: 0n,
    settledIssuanceAmount: 0n,
    kind: "privateValue",
    accountCreation: 0 as const,
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

const status = {
  pcashChainId: 8191,
  genesisHash: `0x${"12".repeat(32)}`,
  l1ChainId: 1n,
  inboxAddress: INBOX,
  genesisL1Block: 5n,
  genesisL1BlockHash: ANCHOR,
  finalizedL1BlockNumber: 9n,
  finalizedL1BlockHash: L1_BLOCK_HASH,
  acceptedBatchVersions: [1],
  acceptedTransactionTypes: [0],
} as never;

/** Broadcast, then wait for settlement, as a one-shot relay does. */
async function submit(
  relay: Eip1193RelaySubmitter,
  batch: string,
  carrierQuote: RelayCarrierQuote,
  submission: RelaySubmissionMetadata,
): Promise<RelaySubmissionResult> {
  return (await relay.send(status, batch, carrierQuote, submission)).settle();
}

function l1Transport(options: { receipt?: "success" | "reverted" | "pending" } = {}) {
  return custom({
    async request({ method, params }) {
      switch (method) {
        case "eth_chainId": return "0x1";
        case "eth_getBlockByNumber": {
          const blockNumber = (params as [string])[0];
          return blockNumber === "0x5"
            ? { hash: ANCHOR, number: "0x5", baseFeePerGas: "0x1" }
            : {
                hash: L1_BLOCK_HASH,
                number: blockNumber === "latest" ? "0x9" : blockNumber,
                baseFeePerGas: "0x1",
              };
        }
        case "eth_maxPriorityFeePerGas": return "0x1";
        case "eth_feeHistory": return {
          oldestBlock: "0x5",
          baseFeePerGas: ["0x1", "0x2"],
          gasUsedRatio: [0.5],
          reward: [[]],
        };
        case "eth_getTransactionCount": return "0x3";
        case "eth_getBalance": return "0xf4240";
        case "eth_estimateGas": return "0x5208";
        case "eth_getTransactionReceipt":
          if (options.receipt === "pending") return null;
          return {
            transactionHash: L1_HASH,
            blockNumber: "0x9",
            blockHash: L1_BLOCK_HASH,
            transactionIndex: "0x0",
            gasUsed: "0x5208",
            cumulativeGasUsed: "0x5208",
            effectiveGasPrice: "0x2",
            contractAddress: null,
            logs: [],
            logsBloom: `0x${"00".repeat(256)}`,
            type: "0x2",
            status: options.receipt === "reverted" ? "0x0" : "0x1",
            from: ADDRESS,
            to: INBOX,
          };
        default: throw new Error(`unexpected L1 method ${method}`);
      }
    },
  });
}

function provider(options: {
  send?: "success" | "reject" | "ambiguous";
  sendError?: unknown;
  changedData?: boolean;
  transactionOverrides?: Record<string, string | undefined>;
  chainId?: string;
  accounts?: string[];
  transactionLookup?: "success" | "null-once" | "never";
} = {}): { provider: Eip1193Provider; calls: Array<{ method: string; params?: unknown }> } {
  const calls: Array<{ method: string; params?: unknown }> = [];
  let request: Record<string, unknown> | undefined;
  let transactionLookups = 0;
  return {
    calls,
    provider: {
      async request(args) {
        calls.push({ method: args.method, ...(args.params === undefined ? {} : { params: args.params }) });
        switch (args.method) {
          case "eth_chainId": return options.chainId ?? "0x1";
          case "eth_accounts": return options.accounts ?? [ADDRESS];
          case "eth_sendTransaction":
            request = (args.params as [Record<string, unknown>])[0];
            if (options.sendError !== undefined) throw options.sendError;
            if (options.send === "reject") throw { code: 4001, message: "rejected" };
            if (options.send === "ambiguous") throw new Error("provider disconnected");
            return L1_HASH;
          case "eth_getTransactionByHash":
            transactionLookups += 1;
            if (options.transactionLookup === "null-once" && transactionLookups === 1) return null;
            if (options.transactionLookup === "never") return new Promise(() => undefined);
            return {
              hash: L1_HASH,
              chainId: request?.chainId,
              from: ADDRESS,
              to: INBOX,
              input: options.changedData ? "0x99" : request?.data,
              nonce: request?.nonce,
              gas: request?.gas,
              maxFeePerGas: request?.maxFeePerGas,
              maxPriorityFeePerGas: request?.maxPriorityFeePerGas,
              value: request?.value,
              type: request?.type,
              ...options.transactionOverrides,
            };
          default: throw new Error(`unexpected provider method ${args.method}`);
        }
      },
    },
  };
}

function submitter(
  options: Parameters<typeof provider>[0] = {},
  config: {
    transactionLookupTimeoutMs?: number;
    runExclusive?: <T>(operation: () => Promise<T>) => Promise<T>;
    maxInFlight?: number;
    createResolutionId?: () => string;
  } = {},
) {
  const wallet = provider(options);
  const journal = new MemoryRelayJournal();
  const relay = new Eip1193RelaySubmitter({
    rpcUrl: "http://unused",
    provider: wallet.provider,
    address: ADDRESS,
    node: {
      status: async () => status,
      getInboxDeliveryBatch: async () => null,
      getReceipt: async () => [acceptedReceipt()],
    },
    journal,
    transport: l1Transport(),
    createResolutionId: config.createResolutionId ?? (() => "attempt-1"),
    receiptTimeoutMs: 100,
    receiptPollMs: 1,
    observationTimeoutMs: 100,
    observationPollMs: 1,
    ...(config.transactionLookupTimeoutMs === undefined
      ? {}
      : { transactionLookupTimeoutMs: config.transactionLookupTimeoutMs }),
    ...(config.runExclusive === undefined ? {} : { runExclusive: config.runExclusive }),
    ...(config.maxInFlight === undefined ? {} : { maxInFlight: config.maxInFlight }),
  });
  return { journal, relay, wallet };
}

const metadata = {
  selected: [TX_ID],
  collectibleOpenFee: 7n,
  headCheckedBlock: 8n,
  headCheckedBlockHash: ANCHOR,
};

describe("browser Relayer", () => {
  it("uses calldata in auto mode and clears its intent only after L1 and PCASH observation", async () => {
    const test = submitter();
    const quotes = await test.relay.quote(status, BATCH, "auto");
    expect(quotes.selected).toMatchObject({ carrier: "calldata", gasLimit: 21_000n });

    const result = await submit(test.relay, BATCH, quotes.selected, metadata);
    expect(result).toMatchObject({
      txHash: L1_HASH,
      observed: true,
      outcomes: [{
        transactionId: INCLUSION_TX_ID,
        accepted: true,
        kind: "privateValue",
        l1BlockHash: L1_BLOCK_HASH,
        l1TransactionIndex: 0n,
        batchItemIndex: 0n,
      }],
    });
    await expect(test.journal.read()).resolves.toEqual([]);
    const sent = test.wallet.calls.find((call) => call.method === "eth_sendTransaction");
    expect(sent?.params).toEqual([expect.objectContaining({
      chainId: "0x1",
      from: ADDRESS,
      to: INBOX,
      data: BATCH,
      nonce: "0x3",
      gas: "0x5208",
      type: "0x2",
    })]);
  });

  it("refuses an inbox other than the compiled network's before contacting the L1 wallet", async () => {
    const test = submitter();
    const testnet = { ...status as object, pcashChainId: Number(NETWORKS.testnet.pcashChainId) } as never;
    await expect(test.relay.quote(testnet, BATCH, "auto")).rejects.toThrow(/whose inbox is/);
    expect(test.wallet.calls).toEqual([]);
  });

  it("clears a definitively rejected prompt", async () => {
    const test = submitter({ send: "reject" });
    const quotes = await test.relay.quote(status, BATCH, "calldata");
    await expect(submit(test.relay, BATCH, quotes.selected, metadata))
      .rejects.toBeInstanceOf(RelayValidationError);
    await expect(test.journal.read()).resolves.toEqual([]);
  });

  it("rejects oversized browser batches before quoting or requesting wallet submission", async () => {
    const test = submitter();
    const oversized = `0x${"ab".repeat(Number(MAX_BROWSER_RELAY_BATCH_BYTES) + 1)}`;
    await expect(test.relay.quote(status, oversized, "auto")).rejects.toThrow(/maximum is 122880 bytes/);
    expect(test.wallet.calls).toEqual([]);
    const quotes = await test.relay.quote(status, BATCH, "calldata");
    test.wallet.calls.length = 0;
    await expect(submit(test.relay, oversized, quotes.selected, metadata)).rejects.toThrow(/maximum is 122880 bytes/);
    expect(test.wallet.calls).toEqual([]);
    await expect(test.journal.read()).resolves.toEqual([]);
  });

  it.each([
    { code: -32602, message: "Invalid params" },
    { code: 4100, message: "Unauthorized" },
    { code: 4200, message: "Unsupported method" },
    { code: -32601, message: "Method not found" },
    { code: -32000, message: "oversized data" },
    { code: -32000, message: "intrinsic gas too low" },
    { code: -32000, message: "exceeds block gas limit" },
    { code: -32000, message: "insufficient funds for gas * price + value" },
  ])("clears a nested definite refusal: $message", async (inner) => {
    const test = submitter({ sendError: { code: -32603, message: "Internal JSON-RPC error.", data: { originalError: inner } } });
    const quotes = await test.relay.quote(status, BATCH, "calldata");
    await expect(submit(test.relay, BATCH, quotes.selected, metadata)).rejects.toMatchObject({
      name: "RelayPreBroadcastError",
      message: expect.stringContaining(`[${inner.code}] ${inner.message}`),
    });
    await expect(test.journal.read()).resolves.toEqual([]);
    expect(test.wallet.calls.filter(({ method }) => method === "eth_sendTransaction")).toHaveLength(1);
  });

  it.each([
    { code: -32000, message: "upstream error" },
    { code: -32603, message: "Internal JSON-RPC error." },
    { code: -32000, message: "nonce too low" },
    { code: -32000, message: "already known" },
    { code: 4900, message: "provider disconnected" },
    { code: -32000, message: "request timed out" },
  ])("preserves the intent and details for uncertain failure: $message", async (inner) => {
    const test = submitter({ sendError: new Error("Wallet request failed", { cause: inner }) });
    const quotes = await test.relay.quote(status, BATCH, "calldata");
    await expect(submit(test.relay, BATCH, quotes.selected, metadata)).rejects.toMatchObject({
      name: "RelayUpstreamError",
      message: expect.stringContaining(`Wallet did not confirm whether the transaction was sent: Wallet request failed; [${inner.code}] ${inner.message}`),
    });
    await expect(test.journal.read()).resolves.toMatchObject([{ transactionHash: null, resolutionId: "attempt-1" }]);
    expect(test.wallet.calls.filter(({ method }) => method === "eth_sendTransaction")).toHaveLength(1);
  });

  it("limits provider diagnostics and omits transaction data and stack text", async () => {
    const data = `0x${"ab".repeat(2_000)}`;
    const test = submitter({ sendError: { code: -32603, message: `upstream failed data: ${data}\n at provider.js:10` } });
    const quotes = await test.relay.quote(status, BATCH, "calldata");
    const error = await submit(test.relay, BATCH, quotes.selected, metadata).catch((cause) => cause);
    expect(error).toBeInstanceOf(RelayUpstreamError);
    expect(error.message).toContain("[-32603] upstream failed data: [redacted]");
    expect(error.message).not.toContain(data);
    expect(error.message).not.toContain("provider.js");
    expect(error.message.length).toBeLessThan(1_100);
    await expect(test.journal.read()).resolves.toHaveLength(1);
  });

  it("retains a hashless intent after an ambiguous provider failure", async () => {
    const test = submitter({ send: "ambiguous" });
    const quotes = await test.relay.quote(status, BATCH, "calldata");
    await expect(submit(test.relay, BATCH, quotes.selected, metadata))
      .rejects.toBeInstanceOf(RelayUpstreamError);
    await expect(test.journal.read()).resolves.toMatchObject([{
      resolutionId: "attempt-1",
      phase: "broadcast_attempted",
      transactionHash: null,
      submissionKind: "eip1193_intent",
    }]);
    const recovery = new RelayJournalRecoveryManager({ journal: test.journal, node: { getInboxDeliveryBatch: async () => null } });
    await expect(recovery.reconcile()).resolves.toEqual({
      latched: true,
      entries: [{ outcome: "ambiguous", resolutionId: "attempt-1" }],
    });
    // Its nonce may or may not be spent, so nothing may follow it.
    await expect(test.relay.assertAvailable()).rejects.toThrow(/relay journal attempt-1 is ambiguous/);
  });

  it("retains the returned hash when the wallet changes transaction fields", async () => {
    const test = submitter({ changedData: true });
    const quotes = await test.relay.quote(status, BATCH, "calldata");
    await expect(submit(test.relay, BATCH, quotes.selected, metadata))
      .rejects.toThrow(/changed the relay sender, destination, or calldata/);
    await expect(test.journal.read()).resolves.toMatchObject([{
      resolutionId: "attempt-1",
      phase: "broadcast_accepted",
      transactionHash: L1_HASH,
    }]);
    const recovery = new RelayJournalRecoveryManager({ journal: test.journal, node: { getInboxDeliveryBatch: async () => null } });
    await expect(recovery.resolve("attempt-1")).resolves.toMatchObject({
      latched: false,
      resolutionId: "attempt-1",
      transactionHash: L1_HASH,
    });
    await expect(test.journal.read()).resolves.toEqual([]);
  });

  it("waits for the injected wallet transaction to become readable", async () => {
    const test = submitter({ transactionLookup: "null-once" });
    const quotes = await test.relay.quote(status, BATCH, "calldata");
    await expect(submit(test.relay, BATCH, quotes.selected, metadata)).resolves.toMatchObject({
      txHash: L1_HASH,
      observed: true,
    });
    expect(test.wallet.calls.filter((call) => call.method === "eth_getTransactionByHash"))
      .toHaveLength(2);
  });

  it.each([
    ["a higher gas limit", { gas: "0x10000" }],
    ["lower fees", { maxFeePerGas: "0x2", maxPriorityFeePerGas: "0x0" }],
    ["the max fee", { maxFeePerGas: "0x10" }],
    ["the priority fee", { maxPriorityFeePerGas: "0x2" }],
    ["gas and both fees", { gas: "0x10000", maxFeePerGas: "0x10", maxPriorityFeePerGas: "0x2" }],
  ] as Array<[string, Record<string, string>]>)("confirms the relay when the wallet adjusts %s", async (_label, transactionOverrides) => {
    const test = submitter({ transactionOverrides });
    const quotes = await test.relay.quote(status, BATCH, "calldata");
    await expect(submit(test.relay, BATCH, quotes.selected, metadata)).resolves.toMatchObject({
      txHash: L1_HASH,
      observed: true,
      receipt: { status: 1 },
    });
    expect(test.wallet.calls.filter(call => call.method === "eth_sendTransaction")).toHaveLength(1);
    await expect(test.journal.read()).resolves.toEqual([]);
  });

  it.each([
    ["chain", { chainId: "0x2" }],
    ["sender", { from: `0x${"99".repeat(20)}` }],
    ["destination", { to: `0x${"99".repeat(20)}` }],
    ["calldata", { input: "0x99" }],
    ["value", { value: "0x1" }],
    ["nonce", { nonce: "0x4" }],
  ])("retains recovery when the wallet changes the relay %s", async (_label, transactionOverrides) => {
    const test = submitter({ transactionOverrides });
    const quotes = await test.relay.quote(status, BATCH, "calldata");
    await expect(submit(test.relay, BATCH, quotes.selected, metadata)).rejects.toBeInstanceOf(RelayUpstreamError);
    await expect(test.journal.read()).resolves.toMatchObject([{ phase: "broadcast_accepted", transactionHash: L1_HASH }]);
    expect(test.wallet.calls.filter(call => call.method === "eth_sendTransaction")).toHaveLength(1);
  });

  it("confirms a wallet transaction read back without a chain id", async () => {
    const test = submitter({ transactionOverrides: { chainId: undefined } });
    const quotes = await test.relay.quote(status, BATCH, "calldata");
    await expect(submit(test.relay, BATCH, quotes.selected, metadata)).resolves.toMatchObject({
      txHash: L1_HASH, observed: true, receipt: { status: 1 },
    });
    await expect(test.journal.read()).resolves.toEqual([]);
  });

  it.each(["0x0", "0x1", "0x2", "0x4"])("confirms wallet transaction type %s using its receipt and PCASH outcome", async type => {
    const { relay, journal, wallet } = submitter({ transactionOverrides: { type } });
    const request = wallet.provider.request.bind(wallet.provider);
    wallet.provider.request = async args => {
      const response = await request(args);
      if (args.method === "eth_getTransactionByHash" && (type === "0x0" || type === "0x1")) {
        const transaction = response as Record<string, unknown>;
        delete transaction.maxFeePerGas;
        delete transaction.maxPriorityFeePerGas;
        transaction.gasPrice = "0x2";
      }
      return response;
    };
    const quotes = await relay.quote(status, BATCH, "calldata");
    await expect(submit(relay, BATCH, quotes.selected, metadata)).resolves.toMatchObject({
      txHash: L1_HASH, observed: true, receipt: { status: 1 },
    });
    expect(wallet.calls.filter(call => call.method === "eth_sendTransaction")).toHaveLength(1);
    await expect(journal.read()).resolves.toEqual([]);
  });

  it("times out a stalled transaction lookup, retains the hash, and releases the queue", async () => {
    let tail = Promise.resolve();
    const runExclusive = async <T>(operation: () => Promise<T>): Promise<T> => {
      const running = tail.then(operation, operation);
      tail = running.then(() => undefined, () => undefined);
      return running;
    };
    const test = submitter(
      { transactionLookup: "never" },
      { transactionLookupTimeoutMs: 10, runExclusive },
    );
    const quotes = await test.relay.quote(status, BATCH, "calldata");
    await expect(submit(test.relay, BATCH, quotes.selected, metadata))
      .rejects.toBeInstanceOf(RelayDeadlineError);
    await expect(test.journal.read()).resolves.toMatchObject([{
      phase: "broadcast_accepted",
      transactionHash: L1_HASH,
    }]);
    await expect(submit(test.relay, BATCH, quotes.selected, metadata))
      .rejects.toBeInstanceOf(RelayJournalConflictError);
  });

  it("allocates the next nonce past an in-flight intent when the journal has room", async () => {
    let attempts = 0;
    const test = submitter({}, { maxInFlight: 2, createResolutionId: () => `attempt-${attempts += 1}` });
    const quotes = await test.relay.quote(status, BATCH, "calldata");

    await test.relay.send(status, BATCH, quotes.selected, metadata);
    await test.relay.send(status, BATCH, quotes.selected, { ...metadata, selected: [`0x${"98".repeat(32)}`] });

    const nonces = test.wallet.calls
      .filter((call) => call.method === "eth_sendTransaction")
      .map((call) => (call.params as [{ nonce: string }])[0].nonce);
    expect(nonces).toEqual(["0x3", "0x4"]);
    await expect(test.journal.read()).resolves.toMatchObject([
      { resolutionId: "attempt-1", nonce: "3", phase: "broadcast_accepted" },
      { resolutionId: "attempt-2", nonce: "4", phase: "broadcast_accepted" },
    ]);
  });

  it("sends a journaled plain call through the injected wallet", async () => {
    const recipient = `0x${"99".repeat(20)}`;
    const test = submitter({ transactionOverrides: { to: recipient } });

    const call = await test.relay.sendCall({ to: recipient, value: 5n });

    expect(call.txHash).toBe(L1_HASH);
    const sent = test.wallet.calls.find((request) => request.method === "eth_sendTransaction");
    expect(sent?.params).toEqual([expect.objectContaining({
      chainId: "0x1",
      from: ADDRESS,
      to: recipient,
      data: "0x",
      value: "0x5",
      nonce: "0x3",
      gas: "0x5208",
    })]);
    await expect(test.journal.read()).resolves.toMatchObject([{
      kind: "call",
      submissionKind: "eip1193_intent",
      transactionHash: L1_HASH,
      to: recipient,
      value: "5",
    }]);
    await expect(call.settle()).resolves.toMatchObject({ txHash: L1_HASH, blockNumber: 9n });
    await expect(test.journal.read()).resolves.toEqual([]);
  });

  it.each([
    ["default selection", {}, MAX_BROWSER_RELAY_BATCH_BYTES],
    ["larger explicit capacity", { maxBatchBytes: 300_000n }, MAX_BROWSER_RELAY_BATCH_BYTES],
    ["blob-count capacity", { maxBlobs: 6 }, MAX_BROWSER_RELAY_BATCH_BYTES],
    ["smaller explicit capacity", { maxBatchBytes: 62_571n }, 62_571n],
  ])("packs browser batches before quoting with %s", async (_label, options, maximum) => {
    // Private-value stand-ins: type byte 0, then filler.
    const entries = [1, 2].map((fill) => Uint8Array.from({ length: 62_500 }, (_, index) => index === 0 ? 0 : fill));
    const items = entries.map((entry) => ({
      ...selectedMempoolItem(),
      contentHash: toHex(keccak256(entry)),
      byteSize: BigInt(entry.length),
      rawTransaction: toHex(entry),
    }));
    const currentStatus = { ...status as object, latestBlock: 5n, latestBlockHash: ANCHOR, latestBlockTimestamp: 60n };
    const prepareRelay = vi.fn(async ({ contentHashes, maxBatchBytes }: { contentHashes: string[]; maxBatchBytes: bigint }) => {
      const selected = contentHashes.map((hash) => entries[items.findIndex((item) => item.contentHash === hash)]!);
      const batch = toHex(encodeBatchForVersion(selected, 1, 1n, 0n));
      expect(BigInt(fromHex(batch, "batch").length)).toBeLessThanOrEqual(maxBatchBytes);
      return {
        selectedTransactions: selected.map((entry) => toHex(entry)),
        batchBytes: BigInt(fromHex(batch, "batch").length),
        selectedContentHashes: contentHashes,
        rejected: [],
        collectibleOpenFee: 7n,
        collectibleQualifyingActions: BigInt(contentHashes.length),
        selectedQualifyingActions: BigInt(contentHashes.length),
        headCheckedBlock: 5n,
        headCheckedBlockHash: ANCHOR,
      };
    });
    const wallet = provider();
    const relayer = createBrowserRelayer({
      payoutRecipient: { address: 1n, nkRoot: 2n },
      node: {
        status: async () => currentStatus,
        getIssuanceQuote: async () => null,
        getBlockEconomics: async () => ({ atBlockNumber: 5n, records: [{ blocks: 1n, qualifyingActions: 0n }] }),
        getMempool: async () => ({ items, nextCursor: null }),
        prepareRelay,
      } as never,
      rpcUrl: "http://unused",
      provider: wallet.provider,
      address: ADDRESS,
      journal: new MemoryRelayJournal(),
      runExclusive: async (operation) => operation(),
      transportFor: () => l1Transport(),
    });
    const result = await relayer.relay({ ...options, noSubmit: true });
    expect(result.maxBatchBytes).toBe(maximum);
    expect(result.selectedContentHashes).toHaveLength(1);
    expect(result.batchBytes).toBe(62_571n);
    expect(prepareRelay).toHaveBeenCalledWith(expect.objectContaining({ maxBatchBytes: maximum }));
    expect(wallet.calls.some((call) => call.method === "eth_sendTransaction")).toBe(false);
  });

  it("rejects explicit blob mode before node preparation or wallet RPC", async () => {
    const wallet = provider();
    const journal = new MemoryRelayJournal();
    const prepareRelay = vi.fn();
    const relayer = createBrowserRelayer({
      payoutRecipient: { address: 1n, nkRoot: 2n },
      node: {
        status: vi.fn(),
        getMempool: vi.fn(),
        getMempoolTransaction: vi.fn(),
        prepareRelay,
      } as never,
      rpcUrl: "http://unused",
      provider: wallet.provider,
      address: ADDRESS,
      journal,
      runExclusive: async (operation) => operation(),
    });

    await expect(relayer.relay({ contentHashes: [TX_ID], daMode: "blobs" }))
      .rejects.toThrow(/does not support blobs/);
    expect(prepareRelay).not.toHaveBeenCalled();
    expect(wallet.calls).toEqual([]);
  });

  it.each([
    ["chain", { chainId: "0x2" }],
    ["account", { accounts: [`0x${"99".repeat(20)}`] }],
  ])("fails closed when the injected wallet changes %s", async (_label, options) => {
    const test = submitter(options);
    await expect(test.relay.quote(status, BATCH, "calldata"))
      .rejects.toBeInstanceOf(RelayValidationError);
    expect(test.wallet.calls.some((call) => call.method === "eth_sendTransaction")).toBe(false);
  });


  it("submits the prepared batch without querying the mempool", async () => {
    const journal = new MemoryRelayJournal();
    const relay = new Eip1193RelaySubmitter({
      rpcUrl: "http://unused",
      provider: provider().provider,
      address: ADDRESS,
      node: {
        getReceipt: async () => [acceptedReceipt()],
        status: async () => status,
        getInboxDeliveryBatch: async () => null,
      },
      journal,
      transport: l1Transport(),
      createResolutionId: () => "attempt-1",
      receiptTimeoutMs: 100,
      observationTimeoutMs: 100,
      observationPollMs: 1,
    });

    await expect(submit(relay, BATCH, (await relay.quote(status, BATCH, "calldata")).selected, metadata))
      .resolves.toMatchObject({ txHash: L1_HASH, observed: true });
  });

  it("enforces the common maximum gas-fee policy before prompting", async () => {
    const wallet = provider();
    const relay = new Eip1193RelaySubmitter({
      rpcUrl: "http://unused",
      provider: wallet.provider,
      address: ADDRESS,
      node: {
        getReceipt: async () => [],
        status: async () => status,
        getInboxDeliveryBatch: async () => null,
      },
      journal: new MemoryRelayJournal(),
      transport: l1Transport(),
      maxFeePerGas: 1n,
    });
    await expect(relay.quote(status, BATCH, "calldata"))
      .rejects.toBeInstanceOf(RelayValidationError);
    expect(wallet.calls.some((call) => call.method === "eth_sendTransaction")).toBe(false);
  });

  it("serializes operations through the account-scoped browser lock", async () => {
    const events: string[] = [];
    let tail = Promise.resolve();
    const locks = {
      request: async <T>(_name: string, _options: { mode: "exclusive" }, operation: () => Promise<T>) => {
        const running = tail.then(operation);
        tail = running.then(() => undefined, () => undefined);
        return running;
      },
    };
    const run = browserRelayOperationQueue(ADDRESS, locks);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = run(async () => { events.push("first:start"); await gate; events.push("first:end"); });
    const second = run(async () => { events.push("second:start"); events.push("second:end"); });
    await Promise.resolve();
    expect(events).toEqual(["first:start"]);
    release();
    await Promise.all([first, second]);
    expect(events).toEqual(["first:start", "first:end", "second:start", "second:end"]);
  });
});

describe("IndexedDbRelayJournal", () => {
  it("atomically creates, replaces, archives, and namespaces network identities", async () => {
    Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: new IDBFactory() });
    const key = browserRelayJournalKey({ pcashChainId: 1n, l1ChainId: 31337n, genesisHash: `0x${"12".repeat(32)}` }, ADDRESS);
    const journal = new IndexedDbRelayJournal({ databaseName: "relay-test", accountKey: key });
    const source = submitter({ send: "ambiguous" });
    const quotes = await source.relay.quote(status, BATCH, "calldata");
    await expect(submit(source.relay, BATCH, quotes.selected, metadata)).rejects.toThrow();
    const [entry] = await source.journal.read();
    if (entry === undefined) throw new Error("the ambiguous send left no journal entry");

    await journal.create(entry);
    await expect(journal.create(entry)).rejects.toThrow(/already holds resolution attempt-1/);
    await expect(journal.create({ ...entry, resolutionId: "attempt-2" })).rejects.toThrow(/already holds nonce-3/);
    for (const network of [
      { pcashChainId: 1n, l1ChainId: 31338n, genesisHash: `0x${"12".repeat(32)}` },
      { pcashChainId: 1n, l1ChainId: 31337n, genesisHash: `0x${"13".repeat(32)}` },
    ]) {
      const other = new IndexedDbRelayJournal({ databaseName: "relay-test", accountKey: browserRelayJournalKey(network, ADDRESS) });
      await expect(other.read()).resolves.toEqual([]);
      await other.create(entry);
      await other.clear(entry.resolutionId);
      await other.close();
    }
    await expect(journal.read()).resolves.toMatchObject([{ resolutionId: entry.resolutionId }]);
    await journal.replace({ ...entry, phase: "broadcast_accepted", transactionHash: L1_HASH });
    await expect(journal.read()).resolves.toMatchObject([{ transactionHash: L1_HASH }]);
    const archive = await journal.archive("attempt-1");
    expect(archive).toMatch(/^indexeddb:\/\//);
    await expect(journal.read()).resolves.toEqual([]);
    await journal.close();
  });

  it("opens lazily and retries an open that failed", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: undefined });
      const journal = new IndexedDbRelayJournal({ databaseName: "relay-lazy-test", accountKey: "lazy" });
      await new Promise((resolve) => setTimeout(resolve, 0));
      await expect(journal.read()).rejects.toBeInstanceOf(RelayJournalConflictError);

      Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: new IDBFactory() });
      await expect(journal.read()).resolves.toEqual([]);
      await journal.close();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});


describe("Eip1193RelaySubmitter error paths", () => {
  function relayWith(wallet: Eip1193Provider, extra: { onBroadcast?: (hash: string) => void | Promise<void> } = {}) {
    const journal = new MemoryRelayJournal();
    const relay = new Eip1193RelaySubmitter({
      rpcUrl: "http://unused",
      provider: wallet,
      address: ADDRESS,
      node: {
        status: async () => status,
        getInboxDeliveryBatch: async () => null,
        getReceipt: async () => [acceptedReceipt()],
      },
      journal,
      transport: l1Transport(),
      createResolutionId: () => "attempt-1",
      receiptTimeoutMs: 100,
      observationTimeoutMs: 100,
      observationPollMs: 1,
      ...extra,
    });
    return { journal, relay };
  }

  it("keeps the accepted hash latched when the onBroadcast hook throws", async () => {
    const wallet = provider();
    const hook = vi.fn(async () => { throw new Error("hook storage full"); });
    const { journal, relay } = relayWith(wallet.provider, { onBroadcast: hook });
    const quotes = await relay.quote(status, BATCH, "calldata");

    await expect(submit(relay, BATCH, quotes.selected, metadata)).rejects.toThrow(/hook storage full/);
    expect(hook).toHaveBeenCalledWith(L1_HASH);
    await expect(journal.read()).resolves.toMatchObject([{ phase: "broadcast_accepted", transactionHash: L1_HASH }]);
    expect(wallet.calls.some((call) => call.method === "eth_getTransactionByHash")).toBe(false);
  });

  it("calls onBroadcast once the hash is durable", async () => {
    const wallet = provider();
    let latched: RelayJournalEntry | null = null;
    const { journal, relay } = relayWith(wallet.provider, {
      onBroadcast: async () => { latched = (await journal.read())[0] ?? null; },
    });
    const quotes = await relay.quote(status, BATCH, "calldata");
    await expect(submit(relay, BATCH, quotes.selected, metadata)).resolves.toMatchObject({ txHash: L1_HASH });
    expect(latched).toMatchObject({ phase: "broadcast_accepted", transactionHash: L1_HASH });
    await expect(journal.read()).resolves.toEqual([]);
  });

  it("rechecks the wallet chain and account at submit time", async () => {
    let chainId = "0x1";
    let connected = [ADDRESS];
    const base = provider();
    const wallet: Eip1193Provider = {
      async request(args) {
        if (args.method === "eth_chainId") return chainId;
        if (args.method === "eth_accounts") return connected;
        return base.provider.request(args);
      },
    };
    const { journal, relay } = relayWith(wallet);
    const quotes = await relay.quote(status, BATCH, "calldata");

    chainId = "0xaa36a7";
    await expect(submit(relay, BATCH, quotes.selected, metadata))
      .rejects.toThrow("injected wallet is on chain 11155111, expected 1");
    chainId = "0x1";
    connected = [];
    await expect(submit(relay, BATCH, quotes.selected, metadata))
      .rejects.toThrow(`injected wallet is not connected to relay account ${ADDRESS}`);
    await expect(journal.read()).resolves.toEqual([]);
    expect(base.calls.some((call) => call.method === "eth_sendTransaction")).toBe(false);
  });

  it.each([
    ["a malformed account list", { eth_accounts: ["not-an-address"] }, /invalid account list/],
    ["a malformed chain id", { eth_chainId: "one" }, /invalid chain id/],
    ["a failing identity read", { eth_chainId: new Error("wallet locked") }, /reading injected wallet identity failed/],
  ] as Array<[string, Record<string, unknown>, RegExp]>)("reports %s as an upstream failure", async (_label, answers, message) => {
    const wallet: Eip1193Provider = {
      async request(args) {
        const answer = args.method in answers ? answers[args.method] : args.method === "eth_chainId" ? "0x1" : [ADDRESS];
        if (answer instanceof Error) throw answer;
        return answer;
      },
    };
    const failure = await relayWith(wallet).relay.quote(status, BATCH, "calldata").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RelayUpstreamError);
    expect((failure as Error).message).toMatch(message);
  });

  it("rejects an invalid wallet transaction hash as an ambiguous send and keeps the intent", async () => {
    const base = provider();
    const wallet: Eip1193Provider = {
      async request(args) {
        if (args.method === "eth_sendTransaction") return "0x1234";
        return base.provider.request(args);
      },
    };
    const { journal, relay } = relayWith(wallet);
    const quotes = await relay.quote(status, BATCH, "calldata");
    await expect(submit(relay, BATCH, quotes.selected, metadata))
      .rejects.toThrow(/Wallet did not confirm whether the transaction was sent/);
    await expect(journal.read()).resolves.toMatchObject([{ phase: "broadcast_attempted", transactionHash: null }]);
  });

  it("validates its configuration", () => {
    const wallet = provider().provider;
    const config = {
      rpcUrl: "http://unused",
      provider: wallet,
      address: ADDRESS,
      node: { status: async () => status, getInboxDeliveryBatch: async () => null, getReceipt: async () => [] },
      journal: new MemoryRelayJournal(),
      transport: l1Transport(),
    };
    expect(() => new Eip1193RelaySubmitter({ ...config, address: "0x1234" })).toThrow(/20-byte/);
    expect(() => new Eip1193RelaySubmitter({ ...config, receiptTimeoutMs: 0 })).toThrow(/receiptTimeoutMs/);
    expect(() => new Eip1193RelaySubmitter({ ...config, observationPollMs: 1.5 })).toThrow(/observationPollMs/);
    expect(() => new Eip1193RelaySubmitter({ ...config, maxFeePerGas: -1n })).toThrow(/maxFeePerGas/);
    expect(() => new Eip1193RelaySubmitter({ ...config, gasLimit: 0n })).toThrow(/gasLimit/);
    expect(() => new Eip1193RelaySubmitter({ ...config, transactionLookupTimeoutMs: 0 }))
      .toThrow(/transactionLookupTimeoutMs/);
  });

  it("rejects an empty resolution id before prompting", async () => {
    const wallet = provider();
    const relay = new Eip1193RelaySubmitter({
      rpcUrl: "http://unused",
      provider: wallet.provider,
      address: ADDRESS,
      node: { status: async () => status, getInboxDeliveryBatch: async () => null, getReceipt: async () => [] },
      journal: new MemoryRelayJournal(),
      transport: l1Transport(),
      createResolutionId: () => " ",
    });
    const quotes = await relay.quote(status, BATCH, "calldata");
    await expect(submit(relay, BATCH, quotes.selected, metadata)).rejects.toThrow(/resolution id is empty/);
    expect(wallet.calls.some((call) => call.method === "eth_sendTransaction")).toBe(false);
  });
});
