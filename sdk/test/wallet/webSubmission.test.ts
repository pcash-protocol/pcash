import { browserSubmissionHarness } from "./browserSubmissionHarness.ts";
import { describe, expect, it, vi } from "vitest";
import type { PcashNodeClient, StatusResult } from "@pcash/sdk/clients";
import { posterPayoutOpening, decodeBatch, decodeTransaction, encodePrivateValueTransaction, encodeUserAccountCreation, deliveryCommitment, randomArena, WIRE_PROOF_BYTES, sizeClassFiller, TX_KIND_PRIVATE_VALUE, TX_KIND_USER_ACCOUNT_CREATION } from "@pcash/sdk/protocol";
import { fromHex, keccak256, toHex, beBytes, concatBytes } from "@pcash/sdk/utils";
import { PRIVATE_VALUE_PROFILES } from "@pcash/sdk/constants";
import { MAX_RELAY_CONTENT_HASHES, batchEntries, type RelayBatchJournalEntry, type RelayJournalRecovery } from "@pcash/sdk/relay";
import { createWalletClient, custom, type Address } from "viem";
import { createMempoolSubmissionAdapter } from "../../src/wallet/submission.ts";
import { createBrowserL1SubmissionAdapter } from "../../src/wallet/web/submission.ts";

const word = (byte: string): string => `0x${byte.repeat(32)}`;
const account = `0x${"12".repeat(20)}` as Address;
const inbox = `0x${"50".repeat(20)}` as Address;
const l1Hash = word("ab") as `0x${string}`;

/** The one batch the adapter's journal holds in flight. */
async function journaled(adapter: { l1Recovery?(): Promise<RelayJournalRecovery> }): Promise<RelayBatchJournalEntry | undefined> {
  return batchEntries((await (await adapter.l1Recovery!()).show()).entries)[0];
}

function status(): StatusResult {
  return {
    latestBlock: 2n,
    latestBlockHash: word("22"),
    latestBlockTimestamp: 2n,
    finalizedBlock: 1n,
    finalizedBlockHash: word("11"),
    finalizedBlockTimestamp: 1n,
    latestL1BlockNumber: 10n,
    latestL1BlockHash: word("33"),
    observedL1BlockNumber: 10n,
    derivation: { state: "following", sinceUnixMs: 0n },
    finalizedL1BlockNumber: 9n,
    finalizedL1BlockHash: word("44"),
    stateRoot: word("55"),
    l1OriginRoot: word("66"),
    historyRoot: word("77"),
    outputCount: 0n,
    issuedSoFar: 0n,
  supplyCap: 1_000_000_000n * 10n ** 18n,
    totalSucceeded: 0n,
    totalFailed: 0n,
    totalTransactions: 0n,
    index: { status: "ready", cursor: { blockNumber: 2n, blockHash: word("22") } },
    proverAssets: null,
    pcashChainId: 1_346_589_512,
    genesisHash: word("88"),
    acceptedTransactionTypes: [TX_KIND_USER_ACCOUNT_CREATION],
    acceptedBatchVersions: [1],
    l1ChainId: 11_155_111n,
    inboxAddress: inbox,
    genesisL1Block: 1n,
    genesisL1BlockHash: word("99"),
    forkCapability: { chainId: 1_346_589_512n, genesisHash: word("88"), headTimestamp: 2n, currentForkCount: 0n, currentPrefixHash: word("00"), nextActivationTimestamp: 0n, nextPrefixHash: word("00") },
  };
}

function entry(chainId = status().pcashChainId, authorization: "direct" | "signed" = "direct"): Uint8Array {
  return encodeUserAccountCreation(chainId, concatBytes(
    Uint8Array.of(authorization === "direct" ? 0 : 1), beBytes(1n, 32), beBytes(2n, 32),
    Uint8Array.of(0), beBytes(3n, 32), beBytes(100n, 8),
    ...(authorization === "signed" ? [beBytes(1n, 32), beBytes(2n, 32), Uint8Array.of(0)] : []),
  ));
}

describe("browser direct account activation", () => {
  it.each(["eth_getTransactionByHash", "eth_getTransactionReceipt"])("exposes and journals the hash before a %s outage", async (failedMethod) => {
    const current = status();
    const node = { status: async () => current } as PcashNodeClient;
    const harness = browserSubmissionHarness(node, current, account);
    const adapter = createBrowserL1SubmissionAdapter({ node, account, ...harness });
    const onL1Submitted = vi.fn(async (hash: string) => {
      expect(hash).toBe(l1Hash);
      expect((await journaled(adapter))).toMatchObject({ selected: [context.contentHash], transactionHash: hash });
    });
    const failLookup = <T,>(original: (request: { method: string; params?: unknown }) => Promise<T>) => async (request: { method: string; params?: unknown }) => {
      if (request.method === failedMethod) {
        expect(onL1Submitted).toHaveBeenCalledOnce();
        throw new Error("Ethereum RPC unavailable");
      }
      return original(request);
    };
    harness.read.mockImplementation(failLookup(harness.read.getMockImplementation()!));
    harness.provider.mockImplementation(failLookup(harness.provider.getMockImplementation()!));
    const bytes = entry();
    const context = { transactionBytes: bytes, contentHash: toHex(keccak256(bytes)), status: current, retry: false };
    const prepared = await adapter.preflight(context);
    await expect(adapter.submit({ ...context, prepared, onL1Submitted })).rejects.toThrow();
    expect(onL1Submitted).toHaveBeenCalledOnce();
    expect(onL1Submitted).toHaveBeenCalledWith(l1Hash);
    expect(harness.sent).toHaveLength(1);
    expect((await journaled(adapter))).toMatchObject({ selected: [context.contentHash], transactionHash: l1Hash });
  });

  it("builds and sends one exact zero-value L1 batch through viem", async () => {
    const current = status();
    const node = { status: vi.fn(async () => current) } as unknown as PcashNodeClient;
    const { publicClient, walletClient, sent } = browserSubmissionHarness(node, current, account);
    const adapter = createBrowserL1SubmissionAdapter({ node, publicClient, walletClient, account, payoutRecipient: { address: BigInt(account), nkRoot: 123n } });
    const bytes = entry();
    const contentHash = toHex(keccak256(bytes));
    const prepared = await adapter.preflight({ transactionBytes: bytes, status: current, retry: false });
    const description = adapter.describeBatch(prepared);
    expect(description.transactions).toEqual([bytes]);
    expect(description.selected).toEqual([contentHash]);
    const result = await adapter.submit({ transactionBytes: bytes, status: current, retry: false, prepared });

    expect(result).toMatchObject({ accepted: true, queued: false, l1Hash, output: { path: "l1", relay: { txHash: l1Hash } } });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      from: account,
      to: inbox,
      value: "0x0",
      gas: "0x1e240",
      maxPriorityFeePerGas: "0x2",
    });
    const data = (sent[0] as { data: `0x${string}` }).data;
    const batch = decodeBatch(fromHex(data));
    expect(batch.items).toEqual([bytes]);
    expect(batch.posterOwnerCommitment).toBe(posterPayoutOpening(BigInt(account), 123n, batch.posterContext).ownerCommitment);
    expect(description.posterOwnerCommitment).toBe(batch.posterOwnerCommitment);
    expect(decodeTransaction(bytes)).toMatchObject({ authorization: { kind: "direct" }, kind: TX_KIND_USER_ACCOUNT_CREATION, pcashChainId: current.pcashChainId });
  });

  it("names the connected account as the sender a direct creation activates", () => {
    const current = status();
    const node = { status: vi.fn(async () => current) } as unknown as PcashNodeClient;
    const { publicClient, walletClient } = browserSubmissionHarness(node, current, account);
    const adapter = createBrowserL1SubmissionAdapter({ node, publicClient, walletClient, account, payoutRecipient: { address: BigInt(account), nkRoot: 123n } });
    expect(adapter.l1Sender).toBe(account);
  });

  it("rejects direct activation from the mempool adapter before admission", async () => {
    const node = { submitRawTransaction: vi.fn() } as unknown as PcashNodeClient;
    const adapter = createMempoolSubmissionAdapter(node);
    const bytes = entry();
    await expect(adapter.preflight({ transactionBytes: bytes, status: status(), retry: false })).rejects.toThrow(/dedicated owner L1/);
    expect(node.submitRawTransaction).not.toHaveBeenCalled();
  });

  it("retains signed creation transport", async () => {
    const current = status();
    const node = { status: vi.fn(async () => current) } as unknown as PcashNodeClient;
    const { publicClient, walletClient, sent } = browserSubmissionHarness(node, current, account);
    const adapter = createBrowserL1SubmissionAdapter({ node, publicClient, walletClient, account, payoutRecipient: { address: BigInt(account), nkRoot: 123n } });
    const bytes = entry(current.pcashChainId, "signed");
    const prepared = await adapter.preflight({ transactionBytes: bytes, status: current, retry: false });
    await adapter.submit({ transactionBytes: bytes, status: current, retry: false, prepared });
    expect(sent).toHaveLength(1);
    expect(decodeTransaction(bytes)).toMatchObject({ authorization: { kind: "signed" } });
  });

  it("rejects another transaction type before any viem call", async () => {
    const current = status();
    const node = { status: vi.fn(async () => current) } as unknown as PcashNodeClient;
    const { publicClient, walletClient, read } = browserSubmissionHarness(node, current, account);
    const adapter = createBrowserL1SubmissionAdapter({ node, publicClient, walletClient, account, payoutRecipient: { address: BigInt(account), nkRoot: 123n } });
    const bytes = Uint8Array.of(0, 1, 2);
    await expect(adapter.preflight({ transactionBytes: bytes, status: current, retry: false }))
      .rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
  });

  it("rejects an activation envelope for another PCASH chain before estimating gas", async () => {
    const current = status();
    const node = { status: vi.fn(async () => current) } as unknown as PcashNodeClient;
    const { publicClient, walletClient, read } = browserSubmissionHarness(node, current, account);
    const adapter = createBrowserL1SubmissionAdapter({ node, publicClient, walletClient, account, payoutRecipient: { address: BigInt(account), nkRoot: 123n } });
    const bytes = entry(current.pcashChainId + 1);
    await expect(adapter.preflight({ transactionBytes: bytes, status: current, retry: false }))
      .rejects.toThrow("wrong PCASH chain ID");
    expect(read).not.toHaveBeenCalled();
  });

  it("treats a known wallet refusal as definitely pre-broadcast", async () => {
    const current = status();
    const node = { status: vi.fn(async () => current) } as unknown as PcashNodeClient;
    const { publicClient, walletClient, setSend } = browserSubmissionHarness(node, current, account);
    setSend(async () => { throw { code: 4001, message: "User rejected" }; });
    const adapter = createBrowserL1SubmissionAdapter({ node, publicClient, walletClient, account, payoutRecipient: { address: BigInt(account), nkRoot: 123n } });
    const bytes = entry();
    const prepared = await adapter.preflight({ transactionBytes: bytes, status: current, retry: false });

    let caught: unknown;
    try {
      await adapter.submit({ transactionBytes: bytes, status: current, retry: false, prepared });
    } catch (cause) {
      caught = cause;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(adapter.isDefinitePreBroadcastError?.(caught)).toBe(true);
  });

  it("asks the wallet once when its client would retry an unclear failure", async () => {
    const current = status();
    const node = { status: vi.fn(async () => current) } as unknown as PcashNodeClient;
    const { publicClient, provider, sent, setSend } = browserSubmissionHarness(node, current, account);
    setSend(async () => { throw { code: -32603, message: "Internal JSON-RPC error." }; });
    // viem's default transport retries -32603 three times.
    const walletClient = createWalletClient({ transport: custom({ request: provider }) });
    const adapter = createBrowserL1SubmissionAdapter({ node, publicClient, walletClient, account, payoutRecipient: { address: BigInt(account), nkRoot: 123n } });
    const bytes = entry();
    const prepared = await adapter.preflight({ transactionBytes: bytes, status: current, retry: false });

    const caught = await adapter.submit({ transactionBytes: bytes, status: current, retry: false, prepared }).then(() => undefined, (cause: unknown) => cause);
    expect(caught).toBeInstanceOf(Error);
    expect(adapter.isDefinitePreBroadcastError?.(caught)).toBe(false);
    expect(sent).toHaveLength(1);
  });
});

describe("browser mempool submission", () => {
  it("returns after exact-byte admission and leaves acceptance to automatic Wallet sync", async () => {
    const current = status();
    const bytes = entry(current.pcashChainId, "signed");
    const contentHash = toHex(keccak256(bytes));
    const node = {
      status: vi.fn(async () => current),
      submitRawTransaction: vi.fn(async () => ({ contentHash })),
      getReceipt: vi.fn(async () => { throw new Error("submission must not poll for acceptance"); }),
    } as unknown as PcashNodeClient;
    const adapter = createMempoolSubmissionAdapter(node);
    const prepared = await adapter.preflight({ transactionBytes: bytes, status: current, retry: false });

    await expect(adapter.submit({ transactionBytes: bytes, status: current, retry: false, prepared }))
      .resolves.toMatchObject({ accepted: false, queued: true });
    expect(node.getReceipt).not.toHaveBeenCalled();
  });
});

it.each(["genesisHash", "inboxAddress"])("direct adapter rejects changed %s before broadcast", async (field) => {
  const current = status();
  const node = { status: vi.fn(async () => current) } as unknown as PcashNodeClient;
  const harness = browserSubmissionHarness(node, current, account);
  const adapter = createBrowserL1SubmissionAdapter({ node, account, ...harness });
  const bytes = entry();
  const context = { transactionBytes: bytes, contentHash: toHex(keccak256(bytes)), status: current, retry: false };
  const prepared = await adapter.preflight(context);
  node.status = async () => ({ ...current, [field]: field === "genesisHash" ? word("aa") : `0x${"aa".repeat(20)}` });
  await expect(adapter.submit({ ...context, prepared })).rejects.toThrow(/identity changed/);
  expect(harness.sent).toHaveLength(0);
});

it("direct adapter preserves the prepared quote", async () => {
  const current = status();
  const node = { status: async () => current } as PcashNodeClient;
  const harness = browserSubmissionHarness(node, current, account);
  const adapter = createBrowserL1SubmissionAdapter({ node, account, ...harness });
  const bytes = entry();
  const context = { transactionBytes: bytes, contentHash: toHex(keccak256(bytes)), status: current, retry: false };
  const prepared = await adapter.preflight(context);
  if (prepared.path !== "l1") throw new Error("expected direct preparation");
  await adapter.submit({ ...context, prepared });
  expect(harness.read.mock.calls.filter(([request]) => request.method === "eth_estimateGas")).toHaveLength(1);
});

it("retains the required mining entry, poster, and quote when callers change preparation inputs", async () => {
  const { adapter, context, harness, mining, mempool } = setupBatch();
  const originalMining = mining.slice();
  const suppliedStatus = structuredClone(context.status);
  const prepared = await adapter.preflight({ ...context, status: suppliedStatus });
  suppliedStatus.inboxAddress = `0x${"ff".repeat(20)}`;
  suppliedStatus.latestBlock += 1n;
  mining.fill(255);
  context.additionalTransactions.length = 0;
  harness.setEstimateGas(() => 999_999n);
  await adapter.submit({ ...context, prepared, onL1Submitted: async () => {
    expect((await journaled(adapter))?.selected)
      .toEqual([context.transactionBytes, originalMining, mempool].map((bytes) => toHex(keccak256(bytes))));
  } });
  const batch = decodeBatch(fromHex(harness.sent[0]!.data!));
  expect(batch.items).toEqual([context.transactionBytes, originalMining, mempool]);
  const poster = posterPayoutOpening(harness.payoutRecipient.address, harness.payoutRecipient.nkRoot, batch.posterContext);
  expect(batch.posterOwnerCommitment).toBe(poster.ownerCommitment);
  expect(batch.posterOwnerCommitment).toBe(adapter.describeBatch(prepared).posterOwnerCommitment);
  expect(harness.sent[0]!.gas).toBe("0x1e240");
  expect(harness.read.mock.calls.filter(([request]) => request.method === "eth_estimateGas")).toHaveLength(1);
});

it("direct adapter posts companion entries after the action's entry", async () => {
  const current = { ...status(), acceptedTransactionTypes: [TX_KIND_PRIVATE_VALUE, TX_KIND_USER_ACCOUNT_CREATION] };
  const node = { status: async () => current } as PcashNodeClient;
  const harness = browserSubmissionHarness(node, current, account);
  const adapter = createBrowserL1SubmissionAdapter({ node, account, ...harness });
  const bytes = entry();
  const companion = privateValueEntry(current.pcashChainId, 5n, 0n);
  const context = { transactionBytes: bytes, contentHash: toHex(keccak256(bytes)), status: current, retry: false };
  const prepared = await adapter.preflight({ ...context, companions: { transactions: [companion], collectibleOpenFee: 5n, collectibleOpenFees: [5n] } });
  if (prepared.path !== "l1") throw new Error("expected direct preparation");
  await adapter.submit({ ...context, prepared, onL1Submitted: async () => {
    expect((await journaled(adapter))).toMatchObject({
      selected: [bytes, companion].map((item) => toHex(keccak256(item))), collectibleOpenFee: "5",
    });
  } });
  expect(decodeBatch(fromHex(harness.sent[0]!.data!)).items).toEqual([bytes, companion]);
  const quote = await adapter.quoteBatch({ status: current, transactions: [bytes, companion] });
  expect(quote.estimatedCostWei).toBeGreaterThan(0n);
  expect(quote.maximumCostWei).toBeGreaterThanOrEqual(quote.estimatedCostWei);
});

it.each([false, true])("pins explicit Fast-send companions after the setup prefix (companions: %s)", async (withCompanion) => {
  const { node, adapter, context, harness, mining, mempool } = setupBatch();
  const companions = { transactions: withCompanion ? [mempool.slice()] : [], collectibleOpenFee: withCompanion ? 1n : 0n, collectibleOpenFees: withCompanion ? [1n] : [] };
  const expected = [context.transactionBytes, mining, ...(withCompanion ? [mempool] : [])];
  const prepared = await adapter.preflight({ ...context, companions });
  companions.transactions[0]?.fill(255);
  companions.collectibleOpenFee = 999n;
  expect(node.getMempool).not.toHaveBeenCalled();
  expect(node.prepareRelay).not.toHaveBeenCalled();
  await adapter.submit({ ...context, prepared, onL1Submitted: async () => {
    expect((await journaled(adapter))).toMatchObject({
      selected: expected.map((item) => toHex(keccak256(item))), collectibleOpenFee: withCompanion ? "1" : "0",
    });
  } });
  expect(decodeBatch(fromHex(harness.sent[0]!.data!)).items).toEqual(expected);
});

it("direct claim readiness rejects an insufficient ETH reserve before requesting any transaction", async () => {
  const current = status();
  const node = { status: async () => current } as PcashNodeClient;
  const harness = browserSubmissionHarness(node, current, account);
  harness.setBalance(123_456n * 3n);
  const adapter = createBrowserL1SubmissionAdapter({ node, account, ...harness });
  await expect(adapter.preflightL1Budget!({ status: current, maxBatchBytes: 30_000, additionalValueWei: 1n })).rejects.toThrow(/claim gas reserve/);
  expect(harness.sent).toHaveLength(0);
});

function privateValueEntry(chainId: number, openFeeAmount: bigint, issuanceOwnerCommitment: bigint): Uint8Array {
  const outputData = [sizeClassFiller(), sizeClassFiller(), sizeClassFiller(), sizeClassFiller(), sizeClassFiller()] as const;
  const arena = randomArena(PRIVATE_VALUE_PROFILES.S.shapeId);
  const { offsets, publicInputs: words } = PRIVATE_VALUE_PROFILES.S;
  const publicInputs = Array<bigint>(words).fill(0n);
  publicInputs[offsets.chainId] = BigInt(chainId);
  for (let index = 0; index < 4; index++) publicInputs[offsets.nullifiers + index] = (openFeeAmount + issuanceOwnerCommitment + 1n) * 10n + BigInt(index);
  publicInputs[offsets.deliveryCommitment] = deliveryCommitment(outputData, arena);
  publicInputs[offsets.openFeeAmount] = openFeeAmount;
  publicInputs[offsets.issuanceOwner] = issuanceOwnerCommitment;
  publicInputs[offsets.validUntil] = 100n;
  return encodePrivateValueTransaction({ publicInputs, proof: new Uint8Array(WIRE_PROOF_BYTES), outputData, arena });
}

function setupBatch() {
  const current = { ...status(), acceptedTransactionTypes: [TX_KIND_PRIVATE_VALUE, TX_KIND_USER_ACCOUNT_CREATION] };
  const creation = entry();
  const mining = privateValueEntry(current.pcashChainId, 0n, 123n);
  const mempool = privateValueEntry(current.pcashChainId, 1n, 0n);
  const node = {
    status: vi.fn(async () => current),
    getMempool: vi.fn(async () => ({ items: [{ status: "ready", contentHash: toHex(keccak256(mempool)) }], nextCursor: null })),
    prepareRelay: vi.fn(async (_request: { contentHashes: string[] }) => ({ selectedTransactions: [toHex(mempool)] })),
  };
  const client = node as unknown as PcashNodeClient;
  const harness = browserSubmissionHarness(client, current, account);
  const adapter = createBrowserL1SubmissionAdapter({ node: client, account, ...harness, includeMempool: true });
  const context = { transactionBytes: creation, additionalTransactions: [mining], contentHash: toHex(keccak256(creation)), status: current, retry: false };
  return { node, harness, adapter, context, mining, mempool };
}

it.each(["getMempool", "prepareRelay"] as const)("publishes the exact setup/mining prefix when optional %s fails", async (method) => {
  const { node, adapter, context, harness, mining } = setupBatch();
  node[method].mockRejectedValueOnce(new Error("mempool unavailable"));
  const prepared = await adapter.preflight(context);
  await adapter.submit({ ...context, prepared });
  expect(decodeBatch(fromHex(harness.sent[0]!.data!)).items).toEqual([context.transactionBytes, mining]);
  if (method === "getMempool") expect(node.prepareRelay).not.toHaveBeenCalled();
});

it.each(["malformed", "wrong-chain", "unaccepted-type"] as const)(
  "omits an invalid optional %s entry but rejects it when required", async (reason) => {
    const { node, adapter, context, harness, mining, mempool } = setupBatch();
    let invalid: Uint8Array;
    if (reason === "malformed") invalid = Uint8Array.of(0);
    else if (reason === "wrong-chain") invalid = privateValueEntry(context.status.pcashChainId + 1, 0n, 123n);
    else {
      context.transactionBytes = mining;
      context.contentHash = toHex(keccak256(mining));
      context.additionalTransactions = [];
      context.status.acceptedTransactionTypes = [TX_KIND_PRIVATE_VALUE];
      invalid = entry();
    }
    node.prepareRelay.mockResolvedValue({ selectedTransactions: [toHex(invalid), toHex(mempool)] });
    const expected = [context.transactionBytes, ...context.additionalTransactions, mempool];
    const prepared = await adapter.preflight(context);
    await adapter.submit({ ...context, prepared, onL1Submitted: async () => {
      expect((await journaled(adapter))?.selected)
        .toEqual(expected.map((bytes) => toHex(keccak256(bytes))));
    } });
    expect(decodeBatch(fromHex(harness.sent[0]!.data!)).items).toEqual(expected);
    const estimates = harness.read.mock.calls.filter(([request]) => request.method === "eth_estimateGas");
    expect(estimates).toHaveLength(1);
    expect(decodeBatch(fromHex((estimates[0]![0].params as [{ data: string }])[0].data)).items).toEqual(expected);
    harness.read.mockClear();
    await expect(adapter.preflight({ ...context, additionalTransactions: [invalid] })).rejects.toThrow();
    expect(harness.read).not.toHaveBeenCalled();
    expect(harness.sent).toHaveLength(1);
  },
);

it("requests ready mempool entries within the remaining batch capacity", async () => {
  const { node, adapter, context } = setupBatch();
  await adapter.preflight(context);
  expect(node.getMempool).toHaveBeenCalledWith({ status: "ready", limit: MAX_RELAY_CONTENT_HASHES - 2 });
});

it.each([false, true])("excludes every required prefix hash from mempool candidates (suffix: %s)", async (withSuffix) => {
  const { node, adapter, context, harness, mining, mempool } = setupBatch();
  const upperHash = (bytes: Uint8Array) => `0x${toHex(keccak256(bytes)).slice(2).toUpperCase()}` as const;
  const prefix = [context.transactionBytes, mining];
  const candidates = withSuffix ? [...prefix, mempool] : prefix;
  node.getMempool.mockResolvedValue({ items: candidates.map((bytes) => ({
    status: "ready", contentHash: upperHash(bytes),
  })), nextCursor: null });
  node.prepareRelay.mockImplementation(async ({ contentHashes }: { contentHashes: string[] }) => ({
    selectedTransactions: candidates.filter((bytes) => contentHashes.includes(upperHash(bytes))).map(toHex),
  }));
  const prepared = await adapter.preflight(context);
  await adapter.submit({ ...context, prepared });
  if (withSuffix) expect(node.prepareRelay).toHaveBeenCalledWith(expect.objectContaining({ contentHashes: [upperHash(mempool)] }));
  else expect(node.prepareRelay).not.toHaveBeenCalled();
  expect(decodeBatch(fromHex(harness.sent[0]!.data!)).items).toEqual(withSuffix ? [...prefix, mempool] : prefix);
});

it("quotes and publishes only the required prefix when quoting the optional suffix fails", async () => {
  const { adapter, context, harness, mining } = setupBatch();
  harness.setEstimateGas((data) => {
    if (decodeBatch(fromHex(data)).items.length > 2) throw new Error("optional batch cannot be estimated");
    return 200_000n;
  });
  const prepared = await adapter.preflight(context);
  await adapter.submit({ ...context, prepared });
  expect(decodeBatch(fromHex(harness.sent[0]!.data!)).items).toEqual([context.transactionBytes, mining]);
  expect(BigInt(harness.sent[0]!.gas!)).toBe(200_000n);
});

it.each([1_000_000n, 1n])("drops only optional entries when the enlarged batch exceeds an ETH balance of %s", async (balance) => {
  const { adapter, context, harness, mining, mempool } = setupBatch();
  harness.setEstimateGas((data) => decodeBatch(fromHex(data)).items.length === 2 ? 200_000n : 900_000n);
  harness.setBalance(balance);
  if (balance === 1n) {
    await expect(adapter.preflight(context)).rejects.toThrow(/not enough ETH/);
    expect(harness.sent).toHaveLength(0);
  } else {
    const prepared = await adapter.preflight(context);
    await adapter.submit({ ...context, prepared, onL1Submitted: async () => {
      expect((await journaled(adapter))?.selected)
        .toEqual([context.transactionBytes, mining].map((bytes) => toHex(keccak256(bytes))));
    } });
    expect(decodeBatch(fromHex(harness.sent[0]!.data!)).items).toEqual([context.transactionBytes, mining]);
    expect(BigInt(harness.sent[0]!.gas!)).toBe(200_000n);
  }
  const estimates = harness.read.mock.calls.filter(([request]) => request.method === "eth_estimateGas");
  expect(estimates.map(([request]) => decodeBatch(fromHex((request.params as [{ data: string }])[0].data)).items))
    .toEqual([[context.transactionBytes, mining, mempool], [context.transactionBytes, mining]]);
});

it("rejects an invalid required mining entry even when optional selection fails", async () => {
  const { node, adapter, context, harness } = setupBatch();
  node.getMempool.mockRejectedValueOnce(new Error("mempool unavailable"));
  context.additionalTransactions = [privateValueEntry(context.status.pcashChainId + 1, 0n, 123n)];
  await expect(adapter.preflight(context)).rejects.toThrow(/wrong PCASH chain ID/);
  expect(harness.sent).toHaveLength(0);
  expect(harness.read).not.toHaveBeenCalled();
});

it("keeps L1 identity checks mandatory when optional selection fails", async () => {
  const { node, adapter, context, harness } = setupBatch();
  node.getMempool.mockRejectedValueOnce(new Error("mempool unavailable"));
  const original = harness.provider.getMockImplementation()!;
  harness.provider.mockImplementation((request) => request.method === "eth_chainId" ? Promise.resolve("0x1") : original(request));
  await expect(adapter.preflight(context)).rejects.toThrow(/chain 1, expected/);
  expect(harness.sent).toHaveLength(0);
});

it("rejects a wallet network change while quoting the affordable required prefix", async () => {
  const { adapter, context, harness } = setupBatch();
  harness.setBalance(1_000_000n);
  harness.setEstimateGas(() => 900_000n);
  const original = harness.provider.getMockImplementation()!;
  let identityReads = 0;
  harness.provider.mockImplementation((request) => request.method === "eth_chainId" && ++identityReads > 1
    ? Promise.resolve("0x1") : original(request));
  await expect(adapter.preflight(context)).rejects.toThrow(/chain 1, expected/);
  expect(harness.sent).toHaveLength(0);
});

describe("default browser publication", () => {
  it("admits a zero-fee open-route action through the node mempool", async () => {
    const current = { ...status(), acceptedTransactionTypes: [TX_KIND_PRIVATE_VALUE, TX_KIND_USER_ACCOUNT_CREATION] };
    const bytes = privateValueEntry(current.pcashChainId, 0n, 0n);
    const contentHash = toHex(keccak256(bytes));
    const node = {
      status: vi.fn(async () => current),
      submitRawTransaction: vi.fn(async () => ({ contentHash })),
    } as unknown as PcashNodeClient;
    const adapter = createMempoolSubmissionAdapter(node);
    const prepared = await adapter.preflight({ transactionBytes: bytes, status: current, retry: false });
    await expect(adapter.submit({ transactionBytes: bytes, status: current, retry: false, prepared }))
      .resolves.toMatchObject({ queued: true, output: { path: "mempool" } });
    expect(node.submitRawTransaction).toHaveBeenCalledTimes(1);
  });

  it("never routes an unpaid entry to Ethereum on its own", async () => {
    const current = { ...status(), acceptedTransactionTypes: [TX_KIND_PRIVATE_VALUE, TX_KIND_USER_ACCOUNT_CREATION] };
    const bytes = privateValueEntry(current.pcashChainId, 0n, 0x1234n);
    const contentHash = toHex(keccak256(bytes));
    const node = {
      status: vi.fn(async () => current),
      submitRawTransaction: vi.fn(async () => ({ contentHash })),
    } as unknown as PcashNodeClient;
    const adapter = createMempoolSubmissionAdapter(node);
    expect(adapter.mode).toBe("mempool");
    expect(adapter.preflightL1Budget).toBeUndefined();
    const prepared = await adapter.preflight({ transactionBytes: bytes, status: current, retry: false });
    expect(prepared.path).toBe("mempool");
    await adapter.submit({ transactionBytes: bytes, status: current, retry: false, prepared });
    expect(node.submitRawTransaction).toHaveBeenCalledWith(toHex(bytes));
  });
});


it.each(["succeeded", "accountAlreadyExists"])("journals setup, mining and the mempool suffix together (creation: %s)", async (creationOutcome) => {
  const current = { ...status(), acceptedTransactionTypes: [TX_KIND_PRIVATE_VALUE, TX_KIND_USER_ACCOUNT_CREATION] };
  const creation = entry();
  const mining = privateValueEntry(current.pcashChainId, 0n, 123n);
  const mempool = privateValueEntry(current.pcashChainId, 1n, 0n);
  const hash = (bytes: Uint8Array) => toHex(keccak256(bytes));
  const node = { status: async () => current,
    getMempool: vi.fn(async () => ({ items: [{ status: "ready", contentHash: hash(mempool) }], nextCursor: null })),
    prepareRelay: vi.fn(async (_request: { contentHashes: string[] }) => ({ selectedTransactions: [toHex(mempool)] })),
  } as unknown as PcashNodeClient;
  const harness = browserSubmissionHarness(node, current, account);
  harness.setOutcome(0, creationOutcome);
  const adapter = createBrowserL1SubmissionAdapter({ node, account, ...harness, includeMempool: true });
  const context = { transactionBytes: creation, additionalTransactions: [mining], contentHash: hash(creation), status: current, retry: false };
  const prepared = await adapter.preflight(context);
  const result = await adapter.submit({ ...context, prepared, onL1Submitted: async () => {
    expect((await journaled(adapter))?.selected).toEqual([creation, mining, mempool].map(hash));
  } });
  expect(decodeBatch(fromHex(harness.sent[0]!.data!)).items).toEqual([creation, mining, mempool]);
  expect(result.accepted).toBe(creationOutcome === "succeeded");
  expect(node.prepareRelay).toHaveBeenCalledOnce();
});


it.each(["succeeded", "failed", "unresolved"])("tracks the shuffled payment outcome %s and retains exact recovery bytes", async outcome => {
  const current = { ...status(), acceptedTransactionTypes: [TX_KIND_PRIVATE_VALUE] };
  const node = { status: async () => current } as PcashNodeClient;
  const harness = browserSubmissionHarness(node, current, account);
  const adapter = createBrowserL1SubmissionAdapter({ node, account, ...harness });
  const payment = privateValueEntry(current.pcashChainId, 3n, 123n);
  const companion = privateValueEntry(current.pcashChainId, 5n, 0n);
  const random = vi.spyOn(globalThis.crypto, "getRandomValues").mockImplementation(array => {
    new Uint8Array(array!.buffer, array!.byteOffset, array!.byteLength).fill(0);
    return array;
  });
  try {
    const context = { transactionBytes: payment, contentHash: toHex(keccak256(payment)), status: current, retry: false };
    const prepared = await adapter.preflight({ ...context, companions: { transactions: [companion], collectibleOpenFee: 5n, collectibleOpenFees: [5n] } });
    const expectedEntries = [companion, payment];
    harness.setOutcome(0, outcome === "succeeded" ? "failed" : "succeeded");
    harness.setOutcome(1, outcome === "failed" ? "failed" : "succeeded");
    const readReceipt = node.getReceipt;
    if (outcome === "unresolved") node.getReceipt = async query => {
      if (typeof query !== "string" && "inclusionId" in query && query.inclusionId?.batchItemIndex === 1) throw new Error("payment outcome unavailable");
      return readReceipt(query);
    };
    let journaledBatch: string | undefined;
    const submission = adapter.submit({ ...context, prepared, onL1Submitted: async () => {
      const retained = (await journaled(adapter))!;
      journaledBatch = retained.batch;
      expect(decodeBatch(fromHex(retained.batch)).items).toEqual(expectedEntries);
      expect(retained.selected).toEqual(expectedEntries.map(bytes => toHex(keccak256(bytes))));
      expect(retained.batchItemIndexes).toEqual(["0", "1"]);
    } });
    if (outcome === "unresolved") {
      await expect(submission).rejects.toThrow();
      node.getInboxDeliveryBatch = async () => null;
      const reopened = createBrowserL1SubmissionAdapter({ node, account, ...harness });
      expect((await journaled(reopened))?.batch).toBe(journaledBatch);
      await expect(reopened.preflight(context)).rejects.toThrow();
    } else {
      expect((await submission).accepted).toBe(outcome === "succeeded");
    }
    expect(harness.sent).toHaveLength(1);
    expect(harness.sent[0]!.data).toBe(journaledBatch);
    const estimates = harness.read.mock.calls.filter(([request]) => request.method === "eth_estimateGas");
    expect((estimates[0]![0].params as [{ data: string }])[0].data).toBe(journaledBatch);
  } finally { random.mockRestore(); }
});

it("journals fees from required relay-only entries even with an empty companion set", async () => {
  const current = { ...status(), acceptedTransactionTypes: [TX_KIND_PRIVATE_VALUE] };
  const node = { status: async () => current } as PcashNodeClient;
  const harness = browserSubmissionHarness(node, current, account);
  const adapter = createBrowserL1SubmissionAdapter({ node, account, ...harness });
  const first = privateValueEntry(current.pcashChainId, 5n, 0n);
  const second = privateValueEntry(current.pcashChainId, 8n, 0n);
  const context = { transactionBytes: first, contentHash: toHex(keccak256(first)), status: current, retry: false };
  const prepared = await adapter.preflight({ ...context, additionalTransactions: [second],
    companions: { transactions: [], collectibleOpenFee: 0n, collectibleOpenFees: [] }, requiredCollectibleOpenFee: 13n });
  await adapter.submit({ ...context, prepared, onL1Submitted: async () => {
    expect((await journaled(adapter))?.collectibleOpenFee).toBe("13");
  } });
  expect(harness.sent).toHaveLength(1);
});

it("exposes the durable journal identity before requesting wallet confirmation", async () => {
  const current = { ...status(), acceptedTransactionTypes: [TX_KIND_PRIVATE_VALUE] };
  const node = { status: async () => current } as PcashNodeClient;
  const harness = browserSubmissionHarness(node, current, account);
  const adapter = createBrowserL1SubmissionAdapter({ node, account, ...harness });
  const bytes = privateValueEntry(current.pcashChainId, 5n, 0n);
  const context = { transactionBytes: bytes, contentHash: toHex(keccak256(bytes)), status: current, retry: false };
  const prepared = await adapter.preflight(context);
  let resolutionId: string | undefined;
  const request = harness.provider.getMockImplementation()!;
  harness.provider.mockImplementation(async params => {
    if (params.method === "eth_sendTransaction") {
      expect(resolutionId).toBeDefined();
      expect((await journaled(adapter))?.resolutionId).toBe(resolutionId);
      expect((await journaled(adapter))?.selected).toEqual([context.contentHash]);
    }
    return request(params);
  });
  await adapter.submit({ ...context, prepared, onL1Journaled: async entry => {
    resolutionId = entry.resolutionId;
    entry.selected.length = 0;
  } });
  expect(harness.sent).toHaveLength(1);
});
