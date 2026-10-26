import { describe, expect, it, vi } from "vitest";
import type { MempoolItemResult, PcashNodeClient, StatusResult } from "@pcash/sdk/clients";
import { MAX_BROWSER_RELAY_BATCH_BYTES } from "@pcash/sdk/relay";
import { transactionIdentity } from "@pcash/sdk/protocol";
import { fromHex } from "@pcash/sdk/utils";
import { planFastBatch } from "./fastBatch.ts";

const hash = (byte: string) => `0x${byte.repeat(32)}`;
// Each test transaction is one byte, and its ID is that byte's content hash.
const transactionBytes = new Map<string, string>();
const txId = (byte: string) => {
  const id = transactionIdentity(fromHex(`0x${byte}`)).contentHash;
  transactionBytes.set(id, `0x${byte}`);
  return id;
};
const OWN = txId("01");
const PAYING = txId("02");
const UNPAID = txId("03");

function item(contentHash: string, overrides: Partial<MempoolItemResult> = {}): MempoolItemResult {
  return {
    contentHash, statementId: contentHash, stableId: contentHash, conflictKeys: [], kind: "privateValue",
    byteSize: 1_000n, openFeeAmount: 0n, issuanceOwnerCommitment: `0x${"00".repeat(32)}`, issuanceRoute: "open",
    validUntil: null, status: "ready", conflictCount: 0n, receivedAtUnixMs: 1n,
    headCheckedBlock: 1n, headCheckedBlockHash: hash("aa"), recentPcashBlockHash: null, publicRecords: [], rawTransaction: null, ...overrides,
  };
}

function node(items: MempoolItemResult[], rejected: string[] = []) {
  const prepareRelay = vi.fn(async ({ contentHashes }: { contentHashes: string[] }) => {
    const kept = contentHashes.filter((id) => !rejected.includes(id));
    const chosen = items.filter((entry) => kept.includes(entry.contentHash));
    return {
      selectedTransactions: kept.map((id) => transactionBytes.get(id)!),
      selectedContentHashes: kept,
      rejected: contentHashes.filter((id) => rejected.includes(id)).map((contentHash) => ({ contentHash, reason: "conflict" })),
      collectibleOpenFee: chosen.reduce((sum, entry) => sum + entry.openFeeAmount, 0n),
      collectibleQualifyingActions: BigInt(chosen.length),
      selectedQualifyingActions: BigInt(chosen.length),
      batchBytes: 0n, headCheckedBlock: 1n, headCheckedBlockHash: hash("aa"),
    };
  });
  return {
    prepareRelay,
    client: {
      getMempool: vi.fn(async () => ({ items, nextCursor: null })),
      getMempoolTransaction: vi.fn(async () => null),
      getIssuanceQuote: vi.fn(async () => { throw new Error("no quote"); }),
      getBlockEconomics: vi.fn(async () => { throw new Error("no economics"); }),
      prepareRelay,
    } as unknown as PcashNodeClient,
  };
}

const status = { pcashChainId: 1, latestBlock: 5n, latestBlockTimestamp: 10n } as StatusResult;
const plan = (client: PcashNodeClient, ownPendingContentHashes: string[]) => planFastBatch({
  node: client, status, profile: { address: 1n, nkRoot: 2n }, ownPendingContentHashes, transactionByteSize: 2_000n,
});

describe("Fast batch planning", () => {
  it("reserves the bytes and framing of every required claim", async () => {
    const { client, prepareRelay } = node([item(OWN, { byteSize: 2_000n }), item(PAYING, { byteSize: 2_000n, openFeeAmount: 5n })]);
    const result = await planFastBatch({ node: client, status, profile: { address: 1n, nkRoot: 2n },
      ownPendingContentHashes: [OWN], transactionByteSize: 120_000n, requiredTransactionCount: 2 });
    expect(prepareRelay).toHaveBeenCalledWith(expect.objectContaining({ contentHashes: [OWN], maxBatchBytes: MAX_BROWSER_RELAY_BATCH_BYTES - 120_000n - 8n }));
    expect(result.own).toHaveLength(1);
  });

  it("always carries the wallet's own pending payments first, then entries that pay this wallet", async () => {
    const { client, prepareRelay } = node([item(UNPAID, { issuanceRoute: "designated", issuanceOwnerCommitment: hash("09") }), item(PAYING, { openFeeAmount: 5n }), item(OWN)]);
    const result = await plan(client, [OWN]);
    expect(prepareRelay).toHaveBeenCalledWith(expect.objectContaining({
      contentHashes: [OWN, PAYING],
      maxBatchBytes: MAX_BROWSER_RELAY_BATCH_BYTES - 2_000n - 4n,
    }));
    expect(result.own.map((entry) => [...entry])).toEqual([[0x01]]);
    expect(result.companions.transactions.map((entry) => [...entry])).toEqual([[0x02]]);
    expect(result.companions.collectibleOpenFee).toBe(5n);
  });

  it("does not take bytes the node returns under an ID they do not hash to", async () => {
    const { client, prepareRelay } = node([item(OWN), item(PAYING, { openFeeAmount: 5n })]);
    const honest = prepareRelay.getMockImplementation()!;
    prepareRelay.mockImplementation(async (request) => ({ ...await honest(request), selectedTransactions: ["0x09", "0x0a"] }));
    const result = await plan(client, [OWN]);
    expect(result.own).toHaveLength(0);
    expect(result.companions.transactions).toHaveLength(0);
  });

  it("re-selects without entries the node rejects", async () => {
    const { client, prepareRelay } = node([item(OWN), item(PAYING, { openFeeAmount: 5n })], [PAYING]);
    const result = await plan(client, [OWN]);
    expect(prepareRelay).toHaveBeenCalledTimes(2);
    expect(prepareRelay.mock.calls[1]![0].contentHashes).toEqual([OWN]);
    expect(result.own).toHaveLength(1);
    expect(result.companions.transactions).toHaveLength(0);
  });

  it("posts the payment alone when nothing in the mempool is worth carrying", async () => {
    const { client, prepareRelay } = node([item(UNPAID, { issuanceRoute: "designated", issuanceOwnerCommitment: hash("09") })]);
    const result = await plan(client, []);
    expect(prepareRelay).not.toHaveBeenCalled();
    expect(result.companions.transactions).toEqual([]);
    expect(result.own).toEqual([]);
  });
});

it("excludes returned own pending fees from earnings while retaining third-party fees", async () => {
  const { client } = node([item(OWN, { openFeeAmount: 7n }), item(PAYING, { openFeeAmount: 5n })]);
  const result = await plan(client, [OWN]);
  expect(result.own).toEqual([Uint8Array.of(1)]);
  expect(result.companions.collectibleOpenFee).toBe(5n);
  expect(result.companions.collectibleOpenFees).toEqual([5n]);
});


it("reserves space for the pending action without selecting it again as a companion", async () => {
  const { client, prepareRelay } = node([item(OWN, { openFeeAmount: 7n }), item(PAYING, { openFeeAmount: 5n })]);
  const result = await planFastBatch({ node: client, status,
    profile: { address: 1n, nkRoot: 2n }, ownPendingContentHashes: [OWN], transactionByteSize: 2_000n, excludeContentHashes: [OWN.toUpperCase()] });
  expect(prepareRelay).toHaveBeenCalledWith(expect.objectContaining({ contentHashes: [PAYING] }));
  expect(result.companions.transactions).toEqual([Uint8Array.of(2)]);
  expect(result.own).toEqual([]);
});

it("reuses display issuance inputs without reading quote or economics again", async () => {
  const { client } = node([]);
  const result = await planFastBatch({ node: client, status, profile: { address: 1n, nkRoot: 2n },
    ownPendingContentHashes: [], transactionByteSize: 2_000n,
    issuanceInputs: {
      quote: { status: "fulfilled", value: null },
      economics: { status: "rejected", reason: new Error("index unavailable") },
    },
  });
  expect(result.companions.transactions).toEqual([]);
  expect(client.getIssuanceQuote).not.toHaveBeenCalled();
  expect(client.getBlockEconomics).not.toHaveBeenCalled();
});

it("Get PCASH carries the wallet's own pending entry first, then the best-paying others", async () => {
  const { client, prepareRelay } = node([
    item(OWN, { byteSize: 30_000n, openFeeAmount: 1n }),
    item(PAYING, { byteSize: 30_000n, openFeeAmount: 5n }),
    item(UNPAID, { byteSize: 30_000n, openFeeAmount: 9n }),
  ]);
  const result = await planFastBatch({ node: client, status, profile: { address: 1n, nkRoot: 2n },
    ownPendingContentHashes: [OWN], transactionByteSize: 60_000n, requiredTransactionCount: 2 });
  expect(prepareRelay).toHaveBeenCalledWith(expect.objectContaining({ contentHashes: [OWN, UNPAID] }));
  expect(result.own).toEqual([Uint8Array.of(1)]);
  expect(result.companions.collectibleOpenFee).toBe(9n);
});

it("plans relay-only without reserving a fictitious mine action", async () => {
  const { client, prepareRelay } = node([item(PAYING, { openFeeAmount: 5n })]);
  const result = await planFastBatch({ node: client, status, profile: { address: 1n, nkRoot: 2n },
    ownPendingContentHashes: [], transactionByteSize: 0n, requiredTransactionCount: 0 });
  expect(prepareRelay).toHaveBeenCalledWith(expect.objectContaining({ maxBatchBytes: MAX_BROWSER_RELAY_BATCH_BYTES }));
  expect(result.companions.transactions).toHaveLength(1);
  expect(result.companions.collectibleOpenFee).toBe(5n);
});

it("carries own entries of any kind oldest first and never lets a later one pass an earlier one", async () => {
  const LISTING = txId("04");
  const FUNDING = txId("05");
  const SMALL = txId("06");
  const { client, prepareRelay } = node([
    item(SMALL, { byteSize: 1_000n, receivedAtUnixMs: 3n }),
    item(FUNDING, { byteSize: 60_000n, receivedAtUnixMs: 2n }),
    item(LISTING, { kind: "privateValue", byteSize: 40_000n, receivedAtUnixMs: 1n }),
    item(PAYING, { byteSize: 1_000n, openFeeAmount: 5n }),
  ]);
  const result = await planFastBatch({ node: client, status, profile: { address: 1n, nkRoot: 2n },
    ownPendingContentHashes: [SMALL, FUNDING, LISTING], transactionByteSize: 40_000n, requiredTransactionCount: 1 });
  // The funding does not fit after the listing, so the smaller later entry waits too.
  expect(prepareRelay).toHaveBeenCalledWith(expect.objectContaining({ contentHashes: [LISTING, PAYING] }));
  expect(result.own).toEqual([Uint8Array.of(4)]);
  expect(result.companions.transactions).toEqual([Uint8Array.of(2)]);
});

const mineForecast = {
  quote: { status: "fulfilled", value: { internalOffer: 10n, blockAllowance: 100n, supplyCap: 1000n, issuedSoFar: 0n, exhausted: false } },
  economics: { status: "fulfilled", value: { records: [{ qualifyingActions: 0n, blocks: 1n }] } },
} as import("./usePaymentIssuance.ts").DisplayIssuanceInputs;

it.each(["getMempool", "prepareRelay"] as const)("keeps two required mines when optional %s fails", async method => {
  const { client } = node([item(PAYING, { openFeeAmount: 99n })]);
  vi.mocked(client[method]).mockRejectedValue(new Error("companion service unavailable"));
  const result = await planFastBatch({ node: client, status, profile: { address: 1n, nkRoot: 2n },
    ownPendingContentHashes: [], transactionByteSize: 60_000n, requiredTransactionCount: 2, companionsOptional: true, issuanceInputs: mineForecast });
  // The pending count is unknown, not zero.
  expect(result).toEqual({ own: [], companions: { transactions: [], collectibleOpenFee: 0n, collectibleOpenFees: [] }, expectedIssuance: 20n, rewardEach: 10n,
    actions: { qualifying: 2n, collectible: 2n }, actionsWithoutCompanions: { qualifying: 2n, collectible: 2n } });
  expect(client.getIssuanceQuote).not.toHaveBeenCalled();
  expect(client.getBlockEconomics).not.toHaveBeenCalled();
});

it.each(["getMempool", "prepareRelay"] as const)("keeps relay-only %s failures fatal", async method => {
  const { client } = node([item(PAYING, { openFeeAmount: 99n })]);
  vi.mocked(client[method]).mockRejectedValue(new Error("companion service unavailable"));
  await expect(planFastBatch({ node: client, status, profile: { address: 1n, nkRoot: 2n },
    ownPendingContentHashes: [], transactionByteSize: 0n, requiredTransactionCount: 0, companionsOptional: true, issuanceInputs: mineForecast })).rejects.toThrow("companion service unavailable");
});

it("refreshes the issuance forecast when final companion preparation fails", async () => {
  const { client } = node([item(PAYING, { openFeeAmount: 99n })]);
  vi.mocked(client.prepareRelay).mockRejectedValue(new Error("prepare unavailable"));
  vi.mocked(client.getIssuanceQuote).mockResolvedValue(mineForecast.quote.status === "fulfilled" ? mineForecast.quote.value : null);
  vi.mocked(client.getBlockEconomics).mockResolvedValue({ atBlockNumber: status.latestBlock, atBlockHash: hash("aa"), nextBlock: null,
    records: mineForecast.economics.status === "fulfilled" ? mineForecast.economics.value.records : [] });
  const result = await planFastBatch({ node: client, status, profile: { address: 1n, nkRoot: 2n },
    ownPendingContentHashes: [], transactionByteSize: 60_000n, requiredTransactionCount: 2, companionsOptional: true });
  expect(result.expectedIssuance).toBe(20n);
  expect(result.companions.collectibleOpenFee).toBe(0n);
  expect(client.getIssuanceQuote).toHaveBeenCalledOnce();
  expect(client.getBlockEconomics).toHaveBeenCalledOnce();
});

it("counts the pending entries it could carry and the batch's qualifying actions with and without companions", async () => {
  const { client } = node([
    item(OWN, { receivedAtUnixMs: 1n }),
    item(PAYING, { openFeeAmount: 5n }),
    item(UNPAID, { kind: "contractAccount" }),
  ]);
  const result = await planFastBatch({ node: client, status, profile: { address: 1n, nkRoot: 2n },
    ownPendingContentHashes: [OWN], transactionByteSize: 2_000n, requiredTransactionCount: 1, issuanceInputs: mineForecast });
  expect(result.pendingCount).toBe(2);
  expect(result.companions.transactions).toEqual([Uint8Array.of(2)]);
  expect(result.actionsWithoutCompanions).toEqual({ qualifying: 2n, collectible: 2n });
  expect(result.actions).toEqual({ qualifying: 3n, collectible: 3n });
  // The planner's own forecast: three collected actions at min(10, 100 / 3) each.
  expect(result.expectedIssuance).toBe(30n);
});
