import { decodeBatch, encodeBatchForVersion, encodeUserAccountCreation, posterPayoutOpening } from "../src/protocol/index.ts";
import { buildDirectReferenceUserAccountCreation } from "../src/builders/index.ts";
import { TEST_DEFAULT_RULE_SECRETS } from "@pcash/test-support/protocol-fixtures";
import { deriveTestWallet } from "./testWallet.ts";
import { fromHex, keccak256, toHex, type Hex } from "../src/utils/index.ts";
import { describe, expect, it, vi } from "vitest";
import { PcashNodeRpcError, type MempoolItemResult, type MempoolQuery } from "../src/clients/index.ts";
import { HttpRequestError } from "viem";
import { BN254_SCALAR_MODULUS } from "../src/crypto/field.ts";
import {
  publicErrorMessage,
  Relayer,
  RelayDeadlineError,
  RelayPreBroadcastError,
  RelayUpstreamError,
  RelayValidationError,
  relayBatchCapacity,
  type RelayCarrierQuote,
  type RelaySubmitter,
} from "../src/relay/index.ts";

const RELAYER = `0x${"aa".repeat(20)}`;
const DESTINATION = `0x${"01".repeat(32)}`;
const OTHER_DESTINATION = `0x${"02".repeat(32)}`;
const PAYOUT = { address: 1n, nkRoot: 2n };
const ZERO = `0x${"00".repeat(32)}`;
const word = (value: bigint) => `0x${value.toString(16).padStart(64, "0")}`;
const rawById = new Map<string, string>();
/** A private-value entry (type byte 0) named by one distinguishing byte. */
const contentHashFor = (byte: string) => { const raw = Uint8Array.of(0, Number.parseInt(byte, 16)); const id = toHex(keccak256(raw)); rawById.set(id, toHex(raw)); return id; };
const rawFor = (id: string) => rawById.get(id)!;
/** The batch for `ids` under the poster context the relayer drew for `posted`. */
const batchFor = (ids: string[], posted: string) => {
  const poster = posterPayoutOpening(PAYOUT.address, PAYOUT.nkRoot, decodeBatch(fromHex(posted)).posterContext);
  return toHex(encodeBatchForVersion(ids.map((id) => fromHex(rawFor(id))), 1, poster.ownerCommitment, poster.context));
};

function item(
  byte: string,
  openFeeAmount: bigint,
  byteSize: bigint,
  overrides: Partial<MempoolItemResult> = {},
): MempoolItemResult {
  return {
    contentHash: contentHashFor(byte),
    statementId: contentHashFor("9"),
    stableId: contentHashFor("8"),
    conflictKeys: [],
    kind: "privateValue",
    fundingMode: null,
    byteSize,
    openFeeAmount,
    issuanceOwnerCommitment: ZERO,
    issuanceRoute: "open",
    validUntil: null,
    status: "ready",
    conflictCount: 0n,
    receivedAtUnixMs: 1n,
    headCheckedBlock: 2n,
    headCheckedBlockHash: contentHashFor("7"),
    recentPcashBlockHash: null,
    publicRecords: [],
    rawTransaction: null,
    ...overrides,
  };
}

const quote: RelayCarrierQuote = {
  carrier: "calldata",
  gasLimit: 21_000n,
  maxFeePerGas: 10n,
  maxPriorityFeePerGas: 1n,
  maxFeePerBlobGas: null,
  blobCount: 0,
  blobVersionedHashes: [],
  estimatedCostWei: 189_000n,
  maximumCostWei: 210_000n,
  balanceWei: 1_000_000n,
};

function submitter(inFlight: string[] = []): RelaySubmitter {
  return {
    address: RELAYER,
    supportedCarriers: ["calldata", "blobs"],
    assertAvailable: vi.fn(async () => undefined),
    inFlight: vi.fn(async () => inFlight.map((hash) => hash.toLowerCase())),
    quote: vi.fn(async () => ({ selected: quote, calldata: quote })),
    send: vi.fn(async () => ({
      txHash: contentHashFor("6"),
      settle: async () => ({
        txHash: contentHashFor("6"),
        receipt: {
          status: 1,
          blockNumber: 9n,
          blockHash: contentHashFor("5"),
          transactionIndex: 0,
          gasUsed: 20_000n,
        },
        observed: true,
      }),
    })),
  };
}

/** The node double's default head, which every default quote is computed over. */
const HEAD_PARENT = { blockNumber: 2n, blockHash: contentHashFor("7"), timestamp: 1_000n };
const ZERO_QUOTE = { internalOffer: 0n, blockAllowance: 0n, supplyCap: 10n ** 9n, issuedSoFar: 0n, exhausted: false, parent: HEAD_PARENT };
const OFFER_QUOTE = { internalOffer: 100n, blockAllowance: 1_000n, supplyCap: 10n ** 9n, issuedSoFar: 0n, exhausted: false, parent: HEAD_PARENT };
const quoteAt = (terms: typeof OFFER_QUOTE, blockNumber: bigint, blockHash: string) =>
  ({ ...terms, parent: { blockNumber, blockHash, timestamp: 1_000n + blockNumber * 12n } });
const qualifyingCount = (contentHashes: readonly string[], items: readonly MempoolItemResult[]) =>
  BigInt(contentHashes.filter((hash) => items.find((item) => item.contentHash === hash)?.kind === "privateValue").length);

/** The node's mempool filter: entries without a designated destination, or designated to a listed commitment. */
const mempoolFilter = (items: readonly MempoolItemResult[], query: MempoolQuery) =>
  query.controlledIssuanceOwnerCommitments === undefined
    ? items
    : items.filter((entry) => entry.issuanceRoute !== "designated"
      || query.controlledIssuanceOwnerCommitments!.some((commitment) => BigInt(commitment) === BigInt(entry.issuanceOwnerCommitment)));

function node(
  items: MempoolItemResult[] = [],
  issuanceQuote: typeof OFFER_QUOTE | null = ZERO_QUOTE,
  economics: { blocks: bigint; qualifyingActions: bigint }[] = [{ blocks: 1n, qualifyingActions: 0n }],
) {
  return {
    status: vi.fn(async () => ({
      latestBlock: 2n,
      latestBlockHash: contentHashFor("7"),
      latestBlockTimestamp: 1_000n,
      l1ChainId: 1n, pcashChainId: 1, acceptedBatchVersions: [1], acceptedTransactionTypes: [0,1,2,3],
    }) as never),
    getIssuanceQuote: vi.fn(async (_candidateTimestamp: bigint) => issuanceQuote as never),
    getBlockEconomics: vi.fn(async (_query: unknown) => ({ atBlockNumber: 2n, atBlockHash: contentHashFor("7"), nextBlock: null, records: economics }) as never),
    getMempool: vi.fn(async (query: MempoolQuery = {}) => ({
      items: mempoolFilter(items, query),
      nextCursor: null,
      headCheckedBlock: 2n,
      headCheckedBlockHash: contentHashFor("7"),
      peerCount: 1n,
    })),
    getMempoolTransaction: vi.fn(async () => null),
    prepareRelay: vi.fn(async ({ contentHashes }: { contentHashes: string[] }) => ({
      selectedTransactions: contentHashes.map(rawFor),
      selectedContentHashes: contentHashes,
      rejected: [] as { contentHash: string; reason: string }[],
      collectibleOpenFee: contentHashes.length === 0 ? 0n : 10n,
      collectibleQualifyingActions: qualifyingCount(contentHashes, items),
      selectedQualifyingActions: qualifyingCount(contentHashes, items),
      batchBytes: contentHashes.reduce((size, id) => size + 4n + BigInt(fromHex(rawFor(id)).length), 67n),
      headCheckedBlock: 2n,
      headCheckedBlockHash: contentHashFor("7"),
    })),
  };
}

describe("Relayer", () => {
  it("computes exact one-through-six blob batch capacities", () => {
    expect(relayBatchCapacity(1)).toBe(126_945n);
    expect(relayBatchCapacity(3)).toBe(380_897n);
    expect(relayBatchCapacity(6)).toBe(761_825n);
    expect(() => relayBatchCapacity(0)).toThrow(/1 through 6/);
    expect(() => relayBatchCapacity(7)).toThrow(/1 through 6/);
  });

  it("prepares explicit transaction ids and returns the batch without submitting", async () => {
    const relayNode = node();
    const l1 = submitter();
    const relay = new Relayer({ payoutRecipient: PAYOUT, controlledIssuanceOwnerCommitments: [DESTINATION], node: relayNode as never, submitterFor: () => l1 });
    const ids = [contentHashFor("1"), contentHashFor("2")];

    const result = await relay.relay({ contentHashes: ids, maxBlobs: 1, noSubmit: true });

    expect(relayNode.prepareRelay).toHaveBeenCalledWith({
      contentHashes: ids,
      controlledIssuanceOwnerCommitments: [],
      controlledIssuanceContentHashes: [],
      maxBatchBytes: 126_945n,
    });
    expect(l1.quote).toHaveBeenCalledWith(expect.anything(), batchFor(ids, result.batch), "auto");
    expect(l1.send).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      automatic: false,
      requested: ids,
      batch: batchFor(ids, result.batch),
      submitted: false,
      carrier: "calldata",
      maxBlobs: 1,
      considered: 0,
    });
  });

  it("submits the exact prepared batch and reports receipt observation", async () => {
    const relayNode = node();
    const l1 = submitter();
    const relay = new Relayer({ payoutRecipient: PAYOUT, controlledIssuanceOwnerCommitments: [DESTINATION], node: relayNode as never, submitterFor: () => l1 });

    const result = await relay.relay({ contentHashes: [contentHashFor("1")], daMode: "calldata" });

    const sent = vi.mocked(l1.send).mock.calls[0]![1];
    expect(l1.send).toHaveBeenCalledWith(
      expect.anything(),
      batchFor([contentHashFor("1")], sent),
      quote,
      expect.objectContaining({ selected: [contentHashFor("1")], collectibleOpenFee: 10n }),
    );
    expect(result).toMatchObject({
      submitted: true,
      txHash: contentHashFor("6"),
      receipt: { status: 1, blockNumber: 9n },
      observed: true,
    });
  });

  it("re-prepares once when the node head advances during preparation", async () => {
    const relayNode = node();
    relayNode.status.mockResolvedValue({
      latestBlock: 3n,
      latestBlockHash: contentHashFor("8"),
      l1ChainId: 1n, pcashChainId: 1, acceptedBatchVersions: [1], acceptedTransactionTypes: [0,1,2,3],
    } as never);
    relayNode.prepareRelay
      .mockResolvedValueOnce({
        selectedTransactions: [rawFor(contentHashFor("1"))],
        selectedContentHashes: [contentHashFor("1")],
        rejected: [],
        collectibleOpenFee: 10n,
        collectibleQualifyingActions: 0n,
        selectedQualifyingActions: 0n,
        batchBytes: 73n,
        headCheckedBlock: 2n,
        headCheckedBlockHash: contentHashFor("7"),
      })
      .mockResolvedValueOnce({
        selectedTransactions: [rawFor(contentHashFor("1"))],
        selectedContentHashes: [contentHashFor("1")],
        rejected: [],
        collectibleOpenFee: 10n,
        collectibleQualifyingActions: 0n,
        selectedQualifyingActions: 0n,
        batchBytes: 73n,
        headCheckedBlock: 3n,
        headCheckedBlockHash: contentHashFor("8"),
      });
    const l1 = submitter();
    const relay = new Relayer({ payoutRecipient: PAYOUT, controlledIssuanceOwnerCommitments: [DESTINATION], node: relayNode as never, submitterFor: () => l1 });

    await expect(relay.relay({ contentHashes: [contentHashFor("1")], noSubmit: true }))
      .resolves.toMatchObject({ headCheckedBlock: 3n, headCheckedBlockHash: contentHashFor("8") });
    expect(relayNode.prepareRelay).toHaveBeenCalledTimes(2);
    expect(relayNode.status).toHaveBeenCalledTimes(3);
    expect(l1.quote).toHaveBeenCalledTimes(1);
  });

  it("fails before quoting when the node head moves across both preparations", async () => {
    const relayNode = node();
    relayNode.status
      .mockResolvedValueOnce({ latestBlock: 3n, latestBlockHash: contentHashFor("8") } as never)
      .mockResolvedValueOnce({ latestBlock: 4n, latestBlockHash: contentHashFor("9") } as never);
    relayNode.prepareRelay
      .mockResolvedValueOnce({
        selectedTransactions: [rawFor(contentHashFor("1"))],
        selectedContentHashes: [contentHashFor("1")],
        rejected: [],
        collectibleOpenFee: 10n,
        collectibleQualifyingActions: 0n,
        selectedQualifyingActions: 0n,
        batchBytes: 73n,
        headCheckedBlock: 2n,
        headCheckedBlockHash: contentHashFor("7"),
      })
      .mockResolvedValueOnce({
        selectedTransactions: [rawFor(contentHashFor("1"))],
        selectedContentHashes: [contentHashFor("1")],
        rejected: [],
        collectibleOpenFee: 10n,
        collectibleQualifyingActions: 0n,
        selectedQualifyingActions: 0n,
        batchBytes: 73n,
        headCheckedBlock: 3n,
        headCheckedBlockHash: contentHashFor("8"),
      });
    const l1 = submitter();
    const relay = new Relayer({ payoutRecipient: PAYOUT, controlledIssuanceOwnerCommitments: [DESTINATION], node: relayNode as never, submitterFor: () => l1 });

    await expect(relay.relay({ contentHashes: [contentHashFor("1")], noSubmit: true }))
      .rejects.toThrow("Node head moved during relay preparation; try again");
    expect(l1.quote).not.toHaveBeenCalled();
  });

  it("automatically chooses collectible ready entries by value density", async () => {
    const denseTargeted = item("2", 300n, 100n, { issuanceOwnerCommitment: DESTINATION, issuanceRoute: "designated" });
    const open = item("1", 100n, 100n);
    const targetedElsewhere = item("3", 10_000n, 10n, { issuanceOwnerCommitment: OTHER_DESTINATION, issuanceRoute: "designated" });
    const sponsoredRecord = item("4", 0n, 10n, { issuanceRoute: "none", kind: "contractAccount" });
    const suspended = item("5", 20_000n, 10n, { status: "suspended" });
    const zeroAtFloor = item("6", 0n, 10n);
    const relayNode = node([
      open, targetedElsewhere, sponsoredRecord, denseTargeted, suspended, zeroAtFloor,
    ]);
    const l1 = submitter();
    const relay = new Relayer({ payoutRecipient: PAYOUT, controlledIssuanceOwnerCommitments: [DESTINATION], node: relayNode as never, submitterFor: () => l1 });

    const result = await relay.relay({ noSubmit: true });

    expect(relayNode.prepareRelay).toHaveBeenCalledWith(expect.objectContaining({
      contentHashes: [targetedElsewhere.contentHash, denseTargeted.contentHash, open.contentHash],
      controlledIssuanceOwnerCommitments: [DESTINATION],
      maxBatchBytes: 380_897n,
    }));
    expect(result.automatic).toBe(true);
    expect(result.requested).toEqual([targetedElsewhere.contentHash, denseTargeted.contentHash, open.contentHash]);
  });

  it("applies the value-per-byte floor only to automatic selection", async () => {
    const belowFloor = item("1", 199n, 100n);
    const atFloor = item("2", 200n, 100n);
    const relayNode = node([belowFloor, atFloor]);
    const l1 = submitter();
    const relay = new Relayer({ payoutRecipient: PAYOUT, controlledIssuanceOwnerCommitments: [DESTINATION],
      node: relayNode as never,
      submitterFor: () => l1,
      minValuePerByte: 2n,
    });

    const automatic = await relay.relay({ noSubmit: true });
    expect(automatic.requested).toEqual([atFloor.contentHash]);

    const explicit = await relay.relay({ contentHashes: [belowFloor.contentHash], noSubmit: true });
    expect(explicit.requested).toEqual([belowFloor.contentHash]);
    expect(relayNode.prepareRelay).toHaveBeenLastCalledWith(expect.objectContaining({
      contentHashes: [belowFloor.contentHash],
    }));
  });

  it("sponsors account classes and prioritizes overdue entries oldest first", async () => {
    const account = item("1", 0n, 100n, { kind: "contractAccount", receivedAtUnixMs: 900n });
    const overdueNewer = item("2", 0n, 100n, {
      issuanceOwnerCommitment: OTHER_DESTINATION,
      issuanceRoute: "designated",
      receivedAtUnixMs: 800n,
    });
    const overdueOlder = item("3", 0n, 100n, {
      issuanceOwnerCommitment: OTHER_DESTINATION,
      issuanceRoute: "designated",
      receivedAtUnixMs: 700n,
    });
    const relayNode = node([account, overdueNewer, overdueOlder]);
    const relay = new Relayer({ payoutRecipient: PAYOUT, controlledIssuanceOwnerCommitments: [DESTINATION],
      node: relayNode as never,
      submitterFor: () => submitter(),
      sponsorUnpaid: true,
      maxWaitMs: 200n,
      maxTransactions: 2,
      nowUnixMs: () => 1_000n,
    });

    const result = await relay.relay({ noSubmit: true, maxBatchBytes: 500n });

    expect(result.requested).toEqual([overdueOlder.contentHash, overdueNewer.contentHash]);
    expect(result.considered).toBe(3);
    expect(result.maxBatchBytes).toBe(500n);
    expect(result.maxBlobs).toBe(1);
  });

  it("validates exact operator batch caps independently from blob-count caps", async () => {
    const relay = new Relayer({ payoutRecipient: PAYOUT, controlledIssuanceOwnerCommitments: [DESTINATION], node: node() as never, submitterFor: () => submitter() });
    await expect(relay.relay({ maxBatchBytes: 0n })).rejects.toThrow(/between 1/);
    await expect(relay.relay({ maxBatchBytes: relayBatchCapacity(6) + 1n })).rejects.toThrow(/between 1/);
    await expect(relay.relay({ maxBatchBytes: 100n, maxBlobs: 1 })).rejects.toThrow(/mutually exclusive/);
  });

  it("does not quote or post an empty automatic selection", async () => {
    const relayNode = node([item("1", 0n, 100n, { kind: "contractAccount", issuanceRoute: "none" })]);
    const l1 = submitter();
    const relay = new Relayer({ payoutRecipient: PAYOUT, controlledIssuanceOwnerCommitments: [DESTINATION], node: relayNode as never, submitterFor: () => l1 });

    const result = await relay.relay();

    expect(result).toMatchObject({ submitted: false, carrier: null, quotes: null, selectedContentHashes: [] });
    expect(l1.quote).not.toHaveBeenCalled();
    expect(l1.send).not.toHaveBeenCalled();
  });

  it("rejects malformed, duplicate, and oversized explicit selections", async () => {
    const relay = new Relayer({ payoutRecipient: PAYOUT, controlledIssuanceOwnerCommitments: [DESTINATION], node: node() as never, submitterFor: () => submitter() });
    await expect(relay.relay({ contentHashes: ["0x12"] })).rejects.toThrow(/32-byte/);
    await expect(relay.relay({ contentHashes: [contentHashFor("1"), contentHashFor("1")] })).rejects.toThrow(/duplicate/);
    await expect(relay.relay({ contentHashes: Array.from({ length: 65 }, (_, index) =>
      `0x${index.toString(16).padStart(64, "0")}`
    ) })).rejects.toThrow(/at most 64/);
  });

  it("refuses a direct account creation among the node's selected bytes before quoting", async () => {
    const account = deriveTestWallet();
    const creation = encodeUserAccountCreation(1n, buildDirectReferenceUserAccountCreation({
      chainId: 1n, wallet: account, defaultRuleSecrets: TEST_DEFAULT_RULE_SECRETS,
      recentPcashBlockHash: 0x1234n, validUntilTimestamp: 987_654n,
    }).body);
    const id = toHex(keccak256(creation));
    rawById.set(id, toHex(creation));
    const l1 = submitter();
    const relay = new Relayer({ payoutRecipient: PAYOUT, controlledIssuanceOwnerCommitments: [], node: node() as never, submitterFor: () => l1 });

    await expect(relay.relay({ contentHashes: [contentHashFor("1"), id] })).rejects.toThrow(RelayUpstreamError);
    expect(l1.quote).not.toHaveBeenCalled();
    expect(l1.send).not.toHaveBeenCalled();
  });

  it("gives a caller our message, a viem error's short description, and a node error's code and words", () => {
    const url = "https://node.example/rpc/SECRETKEY?apikey=SECRET2";
    const transport = new HttpRequestError({ url, details: "fetch failed", body: { method: "pcash_status" } });
    expect(publicErrorMessage(transport)).toBe("HTTP request failed.");
    expect(publicErrorMessage(new RelayPreBroadcastError(transport))).toBe("HTTP request failed.");
    expect(publicErrorMessage(new RelayUpstreamError("reading the mempool failed (HttpRequestError)", transport)))
      .toBe("reading the mempool failed (HttpRequestError)");
    const refusal = new PcashNodeRpcError({ code: -32_011, message: "invalid transaction: proof rejected" }, { method: "pcash_submitRawTransaction", url });
    expect(publicErrorMessage(refusal)).toBe("node RPC error -32011: invalid transaction: proof rejected");
    expect(publicErrorMessage(new Error("recipient has no published ML-KEM receive key"))).toBe("recipient has no published ML-KEM receive key");
  });

  it("names the failed node read without the upstream text, which stays on the cause", async () => {
    const relayNode = node();
    const upstream = new Error("HTTP request failed. URL: https://node.example/rpc/SECRETKEY?apikey=SECRET2");
    relayNode.getMempool.mockRejectedValueOnce(upstream);
    const relay = new Relayer({ payoutRecipient: PAYOUT, node: relayNode as never, submitterFor: () => submitter() });

    const failure = await relay.getMempool({}).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(RelayUpstreamError);
    expect((failure as Error).message).toBe("reading the mempool failed (Error)");
    expect((failure as Error).cause).toBe(upstream);
  });

  it("times out a stalled node request and releases the next serialized relay", async () => {
    const relayNode = node();
    relayNode.prepareRelay.mockImplementationOnce(() => new Promise<never>(() => {}));
    const relay = new Relayer({ payoutRecipient: PAYOUT, controlledIssuanceOwnerCommitments: [DESTINATION],
      node: relayNode as never,
      submitterFor: () => submitter(),
      nodeRpcTimeoutMs: 20,
    });

    const stalled = relay.relay({ contentHashes: [contentHashFor("1")], noSubmit: true });
    const queued = relay.relay({ contentHashes: [contentHashFor("2")], noSubmit: true });

    await expect(stalled).rejects.toBeInstanceOf(RelayDeadlineError);
    await expect(queued).resolves.toMatchObject({ selectedContentHashes: [contentHashFor("2")], submitted: false });
    expect(relayNode.prepareRelay).toHaveBeenCalledTimes(2);
  });

  it("skips entries an unsettled batch of this account already carries", async () => {
    const carried = item("1", 300n, 100n);
    const waiting = item("2", 200n, 100n);
    const relayNode = node([carried, waiting]);
    const l1 = submitter([carried.contentHash.toUpperCase().replace("0X", "0x")]);
    const relay = new Relayer({ payoutRecipient: PAYOUT, node: relayNode as never, submitterFor: () => l1 });

    const result = await relay.relay({ noSubmit: true });

    expect(result.requested).toEqual([waiting.contentHash]);
    expect(result.considered).toBe(1);
    expect(relayNode.prepareRelay).toHaveBeenCalledWith(expect.objectContaining({ contentHashes: [waiting.contentHash] }));
  });

  it("serializes selection through broadcast but settles concurrent relays in parallel", async () => {
    const relayNode = node();
    const l1 = submitter();
    const settlements: Array<() => void> = [];
    const events: string[] = [];
    vi.mocked(l1.send).mockImplementation(async (_status, _batch, _quote, metadata) => {
      events.push(`send ${metadata.selected[0]}`);
      return {
        txHash: contentHashFor("6"),
        settle: () => new Promise((resolve) => {
          settlements.push(() => {
            events.push(`settled ${metadata.selected[0]}`);
            resolve({
              txHash: contentHashFor("6"),
              receipt: { status: 1, blockNumber: 9n, blockHash: contentHashFor("5"), transactionIndex: 0, gasUsed: 20_000n },
              observed: true,
            });
          });
        }),
      };
    });
    const relay = new Relayer({ payoutRecipient: PAYOUT, node: relayNode as never, submitterFor: () => l1 });

    const first = relay.relay({ contentHashes: [contentHashFor("1")] });
    const second = relay.relay({ contentHashes: [contentHashFor("2")] });
    await vi.waitFor(() => expect(settlements).toHaveLength(2));

    // Both batches were broadcast before either settled.
    expect(events).toEqual([`send ${contentHashFor("1")}`, `send ${contentHashFor("2")}`]);
    settlements[1]!();
    await expect(second).resolves.toMatchObject({ submitted: true, requested: [contentHashFor("2")] });
    settlements[0]!();
    await expect(first).resolves.toMatchObject({ submitted: true, requested: [contentHashFor("1")] });
  });
});

it.each([
  ["zero-fee privateValue at a zero offer", { kind: "privateValue" }],
  ["zero-fee contractAccount", { kind: "contractAccount", fundingMode: "sponsored" as const }],
  ["zero-fee userAccountUpdate", { kind: "userAccountUpdate" }],
  ["userAccountCreation", { kind: "userAccountCreation", issuanceRoute: "none" as const }],
  ["unfunded contractAccount", { kind: "contractAccount", fundingMode: "unfunded" as const, issuanceRoute: "none" as const }],
  ["zero open fee designated elsewhere", { kind: "userAccountUpdate", issuanceOwnerCommitment: OTHER_DESTINATION, issuanceRoute: "designated" as const }],
])("maximum-wait escalation requires sponsorship for an unpaid %s", async (_label, overrides) => {
  const free = item("a", 0n, 100n, { ...overrides, receivedAtUnixMs: 0n });
  const relayNode = node([free]);
  const l1 = submitter();
  const ordinary = new Relayer({ payoutRecipient: PAYOUT, controlledIssuanceOwnerCommitments: [DESTINATION], node: relayNode as never, submitterFor: () => l1, maxWaitMs: 0n });
  expect((await ordinary.relay({ noSubmit: true })).requested).toEqual([]);
  const sponsor = new Relayer({ payoutRecipient: PAYOUT, controlledIssuanceOwnerCommitments: [DESTINATION], node: relayNode as never, submitterFor: () => l1, maxWaitMs: 0n, sponsorUnpaid: true });
  expect((await sponsor.relay({ noSubmit: true })).requested).toEqual([free.contentHash]);
});

describe("Relayer issuance valuation", () => {
  it("reads the head, the next-slot issuance quote, and the economics window before automatic selection", async () => {
    const relayNode = node([item("1", 0n, 100n)], OFFER_QUOTE, [{ blocks: 1n, qualifyingActions: 3n }]);
    const relay = new Relayer({ payoutRecipient: PAYOUT, controlledIssuanceOwnerCommitments: [DESTINATION], node: relayNode as never, submitterFor: () => submitter() });

    await relay.relay({ noSubmit: true });

    expect(relayNode.getIssuanceQuote).toHaveBeenCalledWith(1_012n);
    expect(relayNode.getBlockEconomics).toHaveBeenCalledWith({ fromBlock: 0n, limit: 64, bucket: 1 });
    expect(relayNode.status.mock.invocationCallOrder[0]).toBeLessThan(relayNode.getIssuanceQuote.mock.invocationCallOrder[0]!);
    expect(relayNode.getMempool).toHaveBeenCalledWith({ limit: 100 });
    expect(relayNode.prepareRelay).toHaveBeenCalledWith(expect.objectContaining({ controlledIssuanceOwnerCommitments: [] }));
  });

  it("anchors the economics window at the head", async () => {
    const relayNode = node([item("1", 0n, 100n)], OFFER_QUOTE);
    relayNode.status.mockResolvedValue({ latestBlock: 100n, latestBlockHash: contentHashFor("7"), latestBlockTimestamp: 5n, pcashChainId: 1, acceptedBatchVersions: [1] } as never);
    relayNode.prepareRelay.mockResolvedValue({
      selectedTransactions: [], selectedContentHashes: [], rejected: [], collectibleOpenFee: 0n, collectibleQualifyingActions: 0n,
      selectedQualifyingActions: 0n, batchBytes: 67n, headCheckedBlock: 100n, headCheckedBlockHash: contentHashFor("7"),
    });
    relayNode.getBlockEconomics.mockResolvedValue({ atBlockNumber: 100n, atBlockHash: contentHashFor("7"), nextBlock: null, records: [{ blocks: 10n, qualifyingActions: 0n }] } as never);
    relayNode.getIssuanceQuote.mockResolvedValue(quoteAt(OFFER_QUOTE, 100n, contentHashFor("7")) as never);
    const relay = new Relayer({ payoutRecipient: PAYOUT, node: relayNode as never, submitterFor: () => submitter(), issuanceWindowBlocks: 10 });
    await expect(relay.relay({ noSubmit: true })).resolves.toMatchObject({ submitted: false, selectedContentHashes: [] });
    expect(relayNode.getBlockEconomics.mock.calls).toEqual([[{ fromBlock: 91n, limit: 10, bucket: 1 }]]);
    expect(relayNode.getIssuanceQuote).toHaveBeenCalledWith(17n);
  });

  it("re-anchors the economics window at a lagging index head", async () => {
    const relayNode = node([item("1", 0n, 100n)], OFFER_QUOTE);
    relayNode.status.mockResolvedValue({ latestBlock: 100n, latestBlockHash: contentHashFor("7"), latestBlockTimestamp: 5n, pcashChainId: 1, acceptedBatchVersions: [1] } as never);
    relayNode.getBlockEconomics
      .mockResolvedValueOnce({ atBlockNumber: 50n, atBlockHash: contentHashFor("7"), nextBlock: null, records: [] } as never)
      .mockResolvedValueOnce({ atBlockNumber: 50n, atBlockHash: contentHashFor("7"), nextBlock: null, records: [{ blocks: 10n, qualifyingActions: 95n }] } as never);
    relayNode.prepareRelay.mockResolvedValue({
      selectedTransactions: [], selectedContentHashes: [], rejected: [], collectibleOpenFee: 0n, collectibleQualifyingActions: 1n,
      selectedQualifyingActions: 1n, batchBytes: 67n, headCheckedBlock: 100n, headCheckedBlockHash: contentHashFor("7"),
    });
    relayNode.getIssuanceQuote.mockResolvedValue(quoteAt(OFFER_QUOTE, 100n, contentHashFor("7")) as never);
    const relay = new Relayer({ payoutRecipient: PAYOUT, node: relayNode as never, submitterFor: () => submitter(), issuanceWindowBlocks: 10 });

    const result = await relay.relay({ noSubmit: true });

    expect(relayNode.getBlockEconomics.mock.calls).toEqual([
      [{ fromBlock: 91n, limit: 10, bucket: 1 }],
      [{ fromBlock: 41n, limit: 10, bucket: 1 }],
    ]);
    expect(result.valuation?.otherQualifyingActions).toBe(10n);
  });

  it("fails the automatic cycle when the index has no blocks in the window", async () => {
    const relayNode = node([item("1", 100n, 100n)], OFFER_QUOTE, []);
    const relay = new Relayer({ payoutRecipient: PAYOUT, selfMinedActions: 1n, node: relayNode as never, submitterFor: () => submitter() });
    await expect(relay.relay({ noSubmit: true })).rejects.toThrow(/block economics/);
    expect(relayNode.prepareRelay).not.toHaveBeenCalled();
  });

  it("reads the whole mempool so private notes and open fees are considered", async () => {
    const elsewhere = item("1", 1_000n, 100n, { kind: "userAccountUpdate", issuanceOwnerCommitment: OTHER_DESTINATION, issuanceRoute: "designated" });
    const relayNode = node([elsewhere]);
    const ordinary = new Relayer({ payoutRecipient: PAYOUT, controlledIssuanceOwnerCommitments: [DESTINATION], node: relayNode as never, submitterFor: () => submitter() });
    expect((await ordinary.relay({ noSubmit: true })).considered).toBe(1);
    expect(relayNode.getMempool.mock.lastCall![0]).not.toHaveProperty("controlledIssuanceOwnerCommitments");

    const sponsor = new Relayer({ payoutRecipient: PAYOUT, controlledIssuanceOwnerCommitments: [DESTINATION], node: relayNode as never, submitterFor: () => submitter(), sponsorUnpaid: true });
    expect((await sponsor.relay({ noSubmit: true })).requested).toEqual([elsewhere.contentHash]);
    expect(relayNode.getMempool.mock.lastCall![0]).not.toHaveProperty("controlledIssuanceOwnerCommitments");
  });

  it("relays zero-fee open actions by default and reports expected issuance from the node's counts", async () => {
    const zeroTip = [item("1", 0n, 100n), item("2", 0n, 100n)];
    const relayNode = node(zeroTip, OFFER_QUOTE, [{ blocks: 2n, qualifyingActions: 17n }]);
    const relay = new Relayer({ payoutRecipient: PAYOUT, node: relayNode as never, submitterFor: () => submitter() });

    const result = await relay.relay({ noSubmit: true });

    expect(result.requested).toEqual(zeroTip.map((entry) => entry.contentHash).sort());
    expect(result.collectibleQualifyingActions).toBe(2n);
    expect(result.selectedQualifyingActions).toBe(2n);
    // m = ceil(17 / 2) = 9, so each of the eleven actions receives floor(1000 / 11) = 90.
    expect(result.valuation).toEqual({ otherQualifyingActions: 9n, rewardEach: 90n, expectedIssuance: 180n, discountedExpectedIssuance: 90n });
  });

  it("makes no valuation reads for explicit selections", async () => {
    const relayNode = node([], OFFER_QUOTE);
    const relay = new Relayer({ payoutRecipient: PAYOUT, node: relayNode as never, submitterFor: () => submitter() });
    const result = await relay.relay({ contentHashes: [contentHashFor("1")], noSubmit: true });
    expect(result.valuation).toBeNull();
    expect(relayNode.getIssuanceQuote).not.toHaveBeenCalled();
    expect(relayNode.getBlockEconomics).not.toHaveBeenCalled();
  });

  it("quotes once more at a fresh head when a block lands between the status and quote reads", async () => {
    const relayNode = node([item("1", 0n, 100n)], OFFER_QUOTE);
    const head = await relayNode.status();
    let headTimestamp = 1_000n;
    relayNode.status.mockImplementation(async () => ({ ...(head as object), latestBlockTimestamp: headTimestamp }) as never);
    relayNode.getIssuanceQuote.mockImplementation(async (candidate: bigint) => {
      headTimestamp = 1_030n;
      if (candidate < headTimestamp) throw new Error(`invalid block timestamp: previous ${headTimestamp}, actual ${candidate}`);
      return OFFER_QUOTE as never;
    });
    const relay = new Relayer({ payoutRecipient: PAYOUT, node: relayNode as never, submitterFor: () => submitter() });

    const result = await relay.relay({ noSubmit: true });

    expect(relayNode.getIssuanceQuote.mock.calls).toEqual([[1_012n], [1_042n]]);
    expect(result.valuation).not.toBeNull();
  });

  describe("valuation bound to the prepared head", () => {
    const zeroTip = item("1", 0n, 100n);
    const head = (blockNumber: bigint, blockHash: string) => ({
      latestBlock: blockNumber, latestBlockHash: blockHash, latestBlockTimestamp: 1_000n + blockNumber * 12n,
      l1ChainId: 1n, pcashChainId: 1, acceptedBatchVersions: [1], acceptedTransactionTypes: [0, 1, 2, 3],
    }) as never;
    const preparedAt = (blockNumber: bigint, blockHash: Hex) => async ({ contentHashes }: { contentHashes: string[] }) => ({
      selectedTransactions: contentHashes.map(rawFor),
      selectedContentHashes: contentHashes,
      rejected: [] as { contentHash: string; reason: string }[],
      collectibleOpenFee: 0n,
      collectibleQualifyingActions: BigInt(contentHashes.length),
      selectedQualifyingActions: BigInt(contentHashes.length),
      batchBytes: 67n + BigInt(contentHashes.length) * 6n,
      headCheckedBlock: blockNumber,
      headCheckedBlockHash: blockHash,
    });

    it("publishes a batch prepared at its valuation's head", async () => {
      const relayNode = node([zeroTip], OFFER_QUOTE);
      const l1 = submitter();
      const result = await new Relayer({ payoutRecipient: PAYOUT, node: relayNode as never, submitterFor: () => l1 }).relay();
      expect(result).toMatchObject({ submitted: true, selectedContentHashes: [zeroTip.contentHash] });
      expect(result.valuation?.expectedIssuance).toBe(100n);
      expect(relayNode.getIssuanceQuote).toHaveBeenCalledTimes(1);
      expect(l1.send).toHaveBeenCalledTimes(1);
    });

    it("does not publish a zero-fee batch valued before the head exhausted issuance", async () => {
      const relayNode = node([zeroTip], OFFER_QUOTE);
      relayNode.status.mockResolvedValueOnce(head(2n, contentHashFor("7"))).mockResolvedValue(head(3n, contentHashFor("8")));
      relayNode.getIssuanceQuote
        .mockResolvedValueOnce(quoteAt(OFFER_QUOTE, 2n, contentHashFor("7")) as never)
        .mockResolvedValue(quoteAt({ ...ZERO_QUOTE, exhausted: true }, 3n, contentHashFor("8")) as never);
      relayNode.prepareRelay.mockImplementationOnce(preparedAt(2n, contentHashFor("7"))).mockImplementation(preparedAt(3n, contentHashFor("8")));
      const l1 = submitter();

      const result = await new Relayer({ payoutRecipient: PAYOUT, node: relayNode as never, submitterFor: () => l1 }).relay();

      expect(l1.send).not.toHaveBeenCalled();
      expect(result).toMatchObject({ submitted: false, selectedContentHashes: [], headCheckedBlock: 3n });
      expect(result.valuation?.expectedIssuance).toBe(0n);
      expect(relayNode.getIssuanceQuote).toHaveBeenCalledTimes(2);
    });

    it("values again when the first preparation already sits on a newer head", async () => {
      const relayNode = node([zeroTip], OFFER_QUOTE);
      relayNode.status.mockResolvedValueOnce(head(2n, contentHashFor("7"))).mockResolvedValue(head(3n, contentHashFor("8")));
      relayNode.getIssuanceQuote
        .mockResolvedValueOnce(quoteAt(OFFER_QUOTE, 2n, contentHashFor("7")) as never)
        .mockResolvedValue(quoteAt({ ...OFFER_QUOTE, internalOffer: 40n }, 3n, contentHashFor("8")) as never);
      relayNode.prepareRelay.mockImplementation(preparedAt(3n, contentHashFor("8")));
      const l1 = submitter();

      const result = await new Relayer({ payoutRecipient: PAYOUT, node: relayNode as never, submitterFor: () => l1 }).relay();

      expect(relayNode.getIssuanceQuote).toHaveBeenCalledTimes(2);
      expect(result).toMatchObject({ submitted: true, headCheckedBlock: 3n, selectedContentHashes: [zeroTip.contentHash] });
      expect(result.valuation?.expectedIssuance).toBe(40n);
      expect(l1.send).toHaveBeenCalledTimes(1);
    });

    it("stops without publishing when the head keeps moving past each valuation", async () => {
      const relayNode = node([zeroTip], OFFER_QUOTE);
      relayNode.status.mockResolvedValue(head(3n, contentHashFor("8")));
      relayNode.prepareRelay.mockImplementation(preparedAt(3n, contentHashFor("8")));
      const l1 = submitter();

      await expect(new Relayer({ payoutRecipient: PAYOUT, node: relayNode as never, submitterFor: () => l1 }).relay())
        .rejects.toThrow(/head moved during relay valuation/);
      expect(relayNode.getIssuanceQuote).toHaveBeenCalledTimes(3);
      expect(l1.quote).not.toHaveBeenCalled();
      expect(l1.send).not.toHaveBeenCalled();
    });
  });

  it("fails the automatic cycle when an issuance read fails in an unsafe configuration", async () => {
    const quoteDown = node([item("1", 100n, 100n)]);
    quoteDown.getIssuanceQuote.mockRejectedValueOnce(new Error("quote unavailable"));
    const relay = new Relayer({ payoutRecipient: PAYOUT, selfMinedActions: 1n, node: quoteDown as never, submitterFor: () => submitter() });
    await expect(relay.relay({ noSubmit: true })).rejects.toBeInstanceOf(RelayUpstreamError);
    const economicsDown = node([item("1", 100n, 100n)]);
    economicsDown.getBlockEconomics.mockRejectedValueOnce(new Error("index unavailable"));
    await expect(new Relayer({ payoutRecipient: PAYOUT, selfMinedActions: 1n, node: economicsDown as never, submitterFor: () => submitter() })
      .relay({ noSubmit: true })).rejects.toThrow(/block economics/);
    expect(economicsDown.prepareRelay).not.toHaveBeenCalled();
  });

  it("publishes eligible fee-only candidates when issuance quote or economics fails under safe configuration", async () => {
    const candidate = item("1", 100n, 100n);
    const quoteDown = node([candidate]);
    quoteDown.getIssuanceQuote.mockRejectedValueOnce(new Error("quote unavailable"));
    const relay = new Relayer({ payoutRecipient: PAYOUT, node: quoteDown as never, submitterFor: () => submitter() });
    const result = await relay.relay({ noSubmit: true });
    expect(result.requested).toEqual([candidate.contentHash]);
    expect(result.valuation).toBeNull();
    expect(quoteDown.prepareRelay).toHaveBeenCalled();
  });

  it("does not publish zero-fee candidates when issuance quote fails under safe configuration", async () => {
    const zeroFee = item("1", 0n, 100n);
    const quoteDown = node([zeroFee]);
    quoteDown.getIssuanceQuote.mockRejectedValueOnce(new Error("quote unavailable"));
    const relay = new Relayer({ payoutRecipient: PAYOUT, node: quoteDown as never, submitterFor: () => submitter() });
    const result = await relay.relay({ noSubmit: true });
    expect(result.requested).toEqual([]);
    expect(result.valuation).toBeNull();
    expect(quoteDown.prepareRelay).toHaveBeenCalledWith(expect.objectContaining({ contentHashes: [] }));
  });

  it("skips issuance analytics altogether with a 100% haircut under safe configuration", async () => {
    const candidate = item("1", 100n, 100n);
    const relayNode = node([candidate]);
    const relay = new Relayer({
      payoutRecipient: PAYOUT,
      issuanceHaircutBps: 10_000,
      node: relayNode as never,
      submitterFor: () => submitter(),
    });
    const result = await relay.relay({ noSubmit: true });
    expect(result.requested).toEqual([candidate.contentHash]);
    expect(result.valuation).toBeNull();
    expect(relayNode.getIssuanceQuote).not.toHaveBeenCalled();
    expect(relayNode.getBlockEconomics).not.toHaveBeenCalled();
  });

  it("skips issuance analytics when mempool is empty", async () => {
    const relayNode = node([]);
    const relay = new Relayer({ payoutRecipient: PAYOUT, node: relayNode as never, submitterFor: () => submitter() });
    const result = await relay.relay({ noSubmit: true });
    expect(result.requested).toEqual([]);
    expect(result.valuation).toBeNull();
    expect(relayNode.getIssuanceQuote).not.toHaveBeenCalled();
    expect(relayNode.getBlockEconomics).not.toHaveBeenCalled();
  });

  it("reruns selection without permanently rejected entries", async () => {
    const entries = [item("1", 300n, 100n), item("2", 200n, 100n), item("3", 100n, 100n)];
    const relayNode = node(entries);
    relayNode.prepareRelay.mockImplementationOnce(async ({ contentHashes }: { contentHashes: string[] }) => ({
      selectedTransactions: [rawFor(contentHashes[1]!)],
      selectedContentHashes: [contentHashes[1]!],
      rejected: [{ contentHash: contentHashes[0]!, reason: "conflict" }],
      collectibleOpenFee: 200n,
      collectibleQualifyingActions: 1n,
      selectedQualifyingActions: 1n,
      batchBytes: 73n,
      headCheckedBlock: 2n,
      headCheckedBlockHash: contentHashFor("7"),
    }));
    const relay = new Relayer({ payoutRecipient: PAYOUT, node: relayNode as never, submitterFor: () => submitter(), maxTransactions: 2 });

    const result = await relay.relay({ noSubmit: true });

    expect(relayNode.prepareRelay.mock.calls.map(([request]) => request.contentHashes)).toEqual([
      [entries[0]!.contentHash, entries[1]!.contentHash],
      [entries[1]!.contentHash, entries[2]!.contentHash],
    ]);
    expect(result.requested).toEqual([entries[1]!.contentHash, entries[2]!.contentHash]);
  });

  it.each([
    [{ issuanceHaircutBps: -1 }, /issuanceHaircutBps/],
    [{ issuanceHaircutBps: 10_001 }, /issuanceHaircutBps/],
    [{ issuanceHaircutBps: 0.5 }, /issuanceHaircutBps/],
    [{ issuanceWindowBlocks: 0 }, /issuanceWindowBlocks/],
    [{ issuanceWindowBlocks: 1_025 }, /issuanceWindowBlocks/],
    [{ selfMinedActions: -1n }, /selfMinedActions/],
    [{ minValuePerByte: -1n }, /minValuePerByte/],
    [{ controlledIssuanceOwnerCommitments: ["not hex"] }, /controlledIssuanceOwnerCommitments/],
    [{ controlledIssuanceOwnerCommitments: ["0x1"] }, /controlledIssuanceOwnerCommitments/],
    [{ controlledIssuanceOwnerCommitments: [`0x${"00".repeat(32)}`] }, /controlledIssuanceOwnerCommitments/],
    // The node rejects every prepareRelay request that lists a non-field commitment.
    [{ controlledIssuanceOwnerCommitments: [word(BN254_SCALAR_MODULUS)] }, /controlledIssuanceOwnerCommitments/],
    [{ controlledIssuanceOwnerCommitments: [`0x${"ff".repeat(32)}`] }, /controlledIssuanceOwnerCommitments/],
  ])("rejects invalid valuation configuration %o", (config, message) => {
    expect(() => new Relayer({ payoutRecipient: PAYOUT, node: node() as never, ...config })).toThrow(RelayValidationError);
    expect(() => new Relayer({ payoutRecipient: PAYOUT, node: node() as never, ...config })).toThrow(message);
  });

  it("accepts the largest canonical controlled commitment", () => {
    expect(() => new Relayer({
      payoutRecipient: PAYOUT, node: node() as never,
      controlledIssuanceOwnerCommitments: [word(BN254_SCALAR_MODULUS - 1n)],
    })).not.toThrow();
  });
});
