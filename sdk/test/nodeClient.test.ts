// PcashNodeClient request/response shaping (offline) via an injected fetch.
// Verifies the method names, positional params, and DTO decoding without a
// live node.

describe("system payout records", () => {
  const hash = `0x${"11".repeat(32)}`;
  const posterRecord = () => ({
    transactionId: null,
    source: { kind: "posterPayout", l1TransactionIndices: [0, 2] },
    component: "openFee", amount: "0x2", ownerCommitment: fieldToHex(9n),
    outputIndex: "0xa", contexts: [fieldToHex(4n), fieldToHex(5n)],
  });
  const designatedRecord = () => ({
    transactionId: `0x${"33".repeat(32)}`,
    source: { kind: "designatedIssuance", l1TransactionIndex: 1, batchItemIndex: 3 },
    component: "issuance", amount: "0x64", ownerCommitment: fieldToHex(8n),
    outputIndex: "0x9", contexts: [fieldToHex(6n)],
  });

  it("decodes both kinds with fee and issuance components from pcash_getPayouts", async () => {
    const client = new PcashNodeClient("http://n", stub({
      atBlockNumber: "0x1", atBlockHash: hash, nextCursor: null,
      records: [
        { blockNumber: "0x1", blockHash: hash, ...designatedRecord() },
        { blockNumber: "0x1", blockHash: hash, ...posterRecord() },
      ],
    }, []));
    const page = await client.getPayouts();
    expect(page.records[0]).toEqual({ blockNumber: 1n, blockHash: hash, transactionId: `0x${"33".repeat(32)}`,
      source: { kind: "designatedIssuance", l1TransactionIndex: 1n, batchItemIndex: 3n },
      component: "issuance", amount: 100n, ownerCommitment: 8n, outputIndex: 9n, contexts: [6n] });
    expect(page.records[1]).toEqual({ blockNumber: 1n, blockHash: hash, transactionId: null,
      source: { kind: "posterPayout", l1TransactionIndices: [0n, 2n] },
      component: "openFee", amount: 2n, ownerCommitment: 9n, outputIndex: 10n, contexts: [4n, 5n] });
  });

  it("decodes pcash_getBlockPayouts totals and every payout of the block", async () => {
    const captured: Captured[] = [];
    const client = new PcashNodeClient("http://n", stub({
      block: { blockNumber: "0x1", blockHash: hash }, openFeesTotal: "0x2", issuanceTotal: "0x64",
      payouts: [designatedRecord(), posterRecord()],
    }, captured));
    const result = await client.getBlockPayouts({ blockNumber: 1n, blockHash: hash });
    expect(captured[0]!.body.method).toBe("pcash_getBlockPayouts");
    expect(captured[0]!.body.params).toEqual([{ blockNumber: "0x1", blockHash: hash }]);
    expect(result).toMatchObject({ block: { blockNumber: 1n, blockHash: hash }, openFeesTotal: 2n, issuanceTotal: 100n });
    expect(result!.payouts.map((payout) => [payout.source.kind, payout.component, payout.amount, payout.outputIndex]))
      .toEqual([["designatedIssuance", "issuance", 100n, 9n], ["posterPayout", "openFee", 2n, 10n]]);
  });

  it.each([
    ["removed kind", (record: any) => { record.source = { kind: "reward", l1TransactionIndex: 0, batchItemIndex: 0 }; }],
    ["missing component", (record: any) => { delete record.component; }],
    ["unknown component", (record: any) => { record.component = "reward"; }],
    ["an open-fee component from a designated source", (record: any) => { record.component = "openFee"; }],
    ["numeric outputIndex", (record: any) => { record.outputIndex = 9; }],
  ])("rejects a payout record with %s", async (_label, mutate) => {
    const record = designatedRecord();
    mutate(record);
    const client = new PcashNodeClient("http://n", stub({
      block: { blockNumber: "0x1", blockHash: hash }, openFeesTotal: "0x0", issuanceTotal: "0x64", payouts: [record],
    }, []));
    await expect(client.getBlockPayouts({ blockNumber: 1n, blockHash: hash })).rejects.toThrow();
  });
});

describe("block economics", () => {
  it("decodes bucketed records with signed lag and passes hex query fields", async () => {
    const hash = `0x${"22".repeat(32)}`;
    const captured: Captured[] = [];
    const client = new PcashNodeClient("http://n", stub({
      atBlockNumber: "0x9", atBlockHash: hash, nextBlock: "0xa",
      records: [{ firstBlock: "0x8", lastBlock: "0x9", firstTimestamp: "0x60", lastTimestamp: "0x6c",
        blocks: "0x2", qualifyingActions: "0x3", issuanceTotal: "0x12c", openFeesTotal: "0x7",
        rewardEach: "0x64", baseline: "0x64", internalOffer: "0x64", blockAllowance: "0x12c",
        lagQ: "-8166776806102523123120990578362437074944" }],
    }, captured));
    const page = await client.getBlockEconomics({ fromBlock: 8n, limit: 1, bucket: 2 });
    expect(captured[0]!.body.method).toBe("pcash_getBlockEconomics");
    expect(captured[0]!.body.params).toEqual([{ fromBlock: "0x8", limit: "0x1", bucket: "0x2" }]);
    expect(page.nextBlock).toBe(10n);
    expect(page.records[0]).toMatchObject({ firstBlock: 8n, lastBlock: 9n, blocks: 2n, qualifyingActions: 3n,
      issuanceTotal: 300n, lagQ: -24n << 128n });
  });

  it("rejects a lag that is not a signed decimal", async () => {
    const hash = `0x${"22".repeat(32)}`;
    const client = new PcashNodeClient("http://n", stub({ atBlockNumber: "0x1", atBlockHash: hash, nextBlock: null,
      records: [{ firstBlock: "0x1", lastBlock: "0x1", firstTimestamp: "0x1", lastTimestamp: "0x1", blocks: "0x1",
        qualifyingActions: "0x0", issuanceTotal: "0x0", openFeesTotal: "0x0", rewardEach: "0x0", baseline: "0x1",
        internalOffer: "0x1", blockAllowance: "0x3", lagQ: "0x10" }] }, []));
    await expect(client.getBlockEconomics()).rejects.toThrow("signed decimal");
  });
});

import { testForkCapabilityDto } from "./statusFixture.ts";
import { describe, expect, it } from "vitest";
import { bytesEqual } from "../src/utils/bytes.ts";
import {
  computeBlockHash,
  computeStateRoot,
  type CurrentBoundaryEnvelopeRpc,
  type PcashBlockHeader,
  type StateComponents,
} from "../src/protocol/boundary.ts";
import { buildCatalogArtifact, catalogContentId } from "../src/protocol/catalog.ts";
import {
  blockHeaderTree,
  transactionResultsRoot,
  historyLeaf,
  stateTree,
} from "../src/protocol/block.ts";
import { l1OriginLeaf, normalizeL1Logs } from "../src/protocol/l1Logs.ts";
import {
  BLOCK_HEADER_KEY_L1_ORIGIN_ROOT,
  BLOCK_HEADER_KEY_HISTORY_ROOT,
  BLOCK_HEADER_KEY_STATE_ROOT,
  STATE_KEY_ACCOUNT_STATE_ROOT,
} from "../src/constants/params.ts";
import { BN254_SCALAR_MODULUS, fieldToHex } from "../src/crypto/field.ts";
import { PcashNodeClient } from "../src/clients/nodeClient.ts";
import { MAX_RPC_RESPONSE_BODY_BYTES, PcashNodeRpcError } from "../src/clients/jsonRpc.ts";
import { BaseError, HttpRequestError, ResponseBodyTooLargeError } from "viem";
import { rpcFetch, rpcResult } from "./rpcFetch.ts";
import { nullifierProofRpc, nullifierTreeFixture } from "@pcash/test-support/protocol-fixtures";
import { accountStateCommitment, receiveKeyHash as protocolReceiveKeyHash } from "../src/protocol/account.ts";
import { SparseMerkleTree } from "../src/crypto/tree.ts";
import { outputFrontierRoot, OutputWitnessTree } from "../src/crypto/outputWitnessTree.ts";
import { PRIVATE_VALUE_PROFILES } from "../src/constants/privateValueProfiles.ts";

interface Captured {
  url: string;
  body: { jsonrpc: string; id: number; method: string; params: unknown[] };
}

const MARKETPLACE_NAMESPACE = "pcash.marketplace.offer.v1";
/** Not JSON and not UTF-8: catalog payloads are opaque bytes. */
const PAYLOAD = Uint8Array.of(0x00, 0xff, 0x80, 0x7f, 0x01);

function catalogRecordResult(payload: Uint8Array, createdAt: string): Record<string, string> {
  return {
    namespace: MARKETPLACE_NAMESPACE,
    pcashChainId: "0x1",
    contentId: catalogContentId({
      namespace: MARKETPLACE_NAMESPACE,
      pcashChainId: 1,
      payload,
    }),
    payload: `0x${Array.from(payload, (b) => b.toString(16).padStart(2, "0")).join("")}`,
    createdAt,
  };
}

function catalogInfoResult(): Record<string, unknown> {
  return {
    status: "available",
    writable: true,
    pcashChainId: "0x1",
    namespaces: [MARKETPLACE_NAMESPACE],
    limits: {
      maxPayloadBytes: "0x40000",
      maxRecords: "0x1388",
      maxAggregatePayloadBytes: "0xa00000",
      defaultPageItems: "0xc8",
      maxPageItems: "0x1f4",
      maxPagePayloadBytes: "0x100000",
    },
  };
}

function statusResult(): Record<string, unknown> {
  return {
    latestBlock: "0x10",
    latestBlockHash: fieldHex(0x10n),
    latestBlockTimestamp: "0x6553f100",
    finalizedBlock: "0xa",
    finalizedBlockHash: fieldHex(0xan),
    finalizedBlockTimestamp: "0x6553f0b8",
    latestL1BlockNumber: "0x15",
    latestL1BlockHash: `0x${"15".repeat(32)}`,
    observedL1BlockNumber: "0x18",
    derivation: { state: "following", sinceUnixMs: "0x18bcfe56800" },
    finalizedL1BlockNumber: "0xf",
    finalizedL1BlockHash: `0x${"0f".repeat(32)}`,
    stateRoot: fieldHex(1n),
    l1OriginRoot: fieldHex(2n),
    historyRoot: fieldHex(3n),
    outputCount: "0x5",
    issuedSoFar: "0x3782dace9d900000",
    supplyCap: "0x33b2e3c9fd0803ce8000000",
    totalSucceeded: "0xc",
    totalFailed: "0x3",
    totalTransactions: "0xf",
    index: {
      status: "Ready",
      cursor: { blockNumber: "0x10", blockHash: fieldHex(0x10n) },
    },
    proverAssets: null,
    pcashChainId: "0xaa36a7",
    genesisHash: `0x${"11".repeat(32)}`,
    acceptedTransactionTypes: ["0x0", "0x1", "0x2", "0x3"],
    acceptedBatchVersions: ["0x1"],
    l1ChainId: "0x1",
    inboxAddress: `0x${"22".repeat(20)}`,
    genesisL1Block: "0x5",
    genesisL1BlockHash: `0x${"33".repeat(32)}`,
    forkCapability: testForkCapabilityDto(
      "0xaa36a7",
      `0x${"11".repeat(32)}`,
      "0x6553f100",
      fieldHex(3n),
    ),
  };
}

function mempoolItemResult(): Record<string, unknown> {
  return {
    contentHash: `0x${"21".repeat(32)}`,
    statementId: `0x${"22".repeat(32)}`,
    stableId: `0x${"23".repeat(32)}`,
    conflictKeys: [],
    kind: "userAccountCreation",
    fundingMode: null,
    byteSize: "0x80",
    openFeeAmount: "0x0",
    issuanceOwnerCommitment: `0x${"00".repeat(32)}`,
    issuanceRoute: "none",
    validUntil: null,
    recentPcashBlockHash: `0x${"ff".repeat(32)}`,
    status: "ready",
    conflictCount: "0x0",
    receivedAtUnixMs: "0x6553f000",
    headCheckedBlock: "0x20",
    headCheckedBlockHash: `0x${"cd".repeat(32)}`,
    publicRecords: [{ schema: "0xdce9a228", data: "0x0102" }],
    rawTransaction: null,
  };
}

function mempoolPageResult(): Record<string, unknown> {
  return {
    items: [mempoolItemResult()],
    nextCursor: null,
    headCheckedBlock: "0x20",
    headCheckedBlockHash: `0x${"cd".repeat(32)}`,
    peerCount: null,
  };
}

function receiptResult(): Record<string, unknown> {
  return {
    inclusion: {
      l1BlockNumber: "0x1",
      l1BlockHash: `0x${"45".repeat(32)}`,
      l1TransactionIndex: "0x0",
      l1TransactionHash: "0x7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c",
      batchItemIndex: "0x0",
    },
    contentHash: `0x${"47".repeat(32)}`,
    transactionId: `0x${"46".repeat(32)}`,
    outcome: "succeeded",
    failureDetail: null,
    l1Sender: `0x${"48".repeat(20)}`,
    issuanceOwnerCommitment: `0x${"48".repeat(32)}`,
    settledOpenFeeAmount: "0x2",
    settledIssuanceAmount: "0x64",
    kind: "privateValue",
    fundingMode: null,
    outputLeafStart: "0x0",
    outputsAdded: "0x5",
    nullifiers: [0, 1, 2, 3].map((value) => `0x${value.toString(16).padStart(64, "0")}`),
    account: null,
  };
}

function transactionSummaryResult(): Record<string, unknown> {
  const receipt = receiptResult();
  return {
    l1Sender: receipt.l1Sender,
    issuanceOwnerCommitment: receipt.issuanceOwnerCommitment,
    settledOpenFeeAmount: receipt.settledOpenFeeAmount,
    settledIssuanceAmount: receipt.settledIssuanceAmount,
    transactionId: receipt.transactionId,
    contentHash: `0x${"47".repeat(32)}`,
    outcome: receipt.outcome,
    failureDetail: receipt.failureDetail,
    declaredOpenFeeAmount: "0x2",
    declaredIssuanceOwnerCommitment: `0x${"00".repeat(32)}`,
    issuanceRoute: "open",
    kind: receipt.kind,
    fundingMode: receipt.fundingMode,
    block: { blockNumber: "0x7", blockHash: `0x${"07".repeat(32)}` },
    pcashTransactionIndex: "0x2",
    timestamp: "0x6553f100",
    inclusion: receipt.inclusion,
    byteSize: "0x120",
    outputLeafStart: receipt.outputLeafStart,
    outputsAdded: receipt.outputsAdded,
    nullifiers: receipt.nullifiers,
    account: receipt.account,
  };
}

function explorerCursorResult(): Record<string, unknown> {
  return {
    head: { blockNumber: "0x9", blockHash: `0x${"09".repeat(32)}` },
    blockNumber: "0x7",
    pcashTransactionIndex: "0x2",
  };
}

function contractSummaryResult(): Record<string, unknown> {
  return {
    address: `0x${"11".repeat(20)}`,
    block: { blockNumber: "0x7", blockHash: `0x${"07".repeat(32)}` },
    pcashTransactionIndex: "0x2",
    timestamp: "0x6553f100",
    transactionId: `0x${"46".repeat(32)}`,
    origin: receiptResult().inclusion,
    functions: [{
      selector: "0x1",
      applicationVkHash: `0x${"22".repeat(32)}`,
      configurationCommitment: `0x${"33".repeat(32)}`,
    }],
    sourceVerification: "verified",
    configurationOpeningCount: "0x1",
  };
}

/** A fetch stub that records the last request and replies with `result`. */
function stub(result: unknown, captured: Captured[] = []) {
  return rpcFetch((body, url) => {
    captured.push({ url, body });
    return rpcResult(body, result);
  });
}

const ADDRESS = "0x00000000000000000000000000000000000000ab";
const OUTPUT_COMMITMENT = 101n;
const ACCOUNT_P = 44n;
const ACCOUNT_RULE_SET = 55n;
const NULLIFIER = `0x${"00".repeat(31)}05`;
const S_NULLIFIERS = [1, 2, 3, 4].map((fill) => hex(bytes32(fill)));

function bytes32(fill: number): Uint8Array {
  return Uint8Array.from({ length: 32 }, () => fill);
}

function hex(bytes: Uint8Array): `0x${string}` {
  return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function quantity(value: bigint | number): string {
  return `0x${BigInt(value).toString(16)}`;
}

function fieldHex(value: bigint): `0x${string}` {
  return fieldToHex(value);
}

/**
 * Another 32-byte word with the same residue mod p: what a full-width digest
 * looks like next to the field value a commitment holds.
 */
function fullWidthAlias(word: string): `0x${string}` {
  const value = BigInt(word);
  const alias = value >= BN254_SCALAR_MODULUS ? value - BN254_SCALAR_MODULUS : value + BN254_SCALAR_MODULUS;
  return `0x${alias.toString(16).padStart(64, "0")}`;
}

function fields(values: readonly bigint[]): string[] {
  return values.map(fieldHex);
}

type MaterialStatus = "notPresent" | "available" | "unavailable";

interface RpcFixture {
  boundary: CurrentBoundaryEnvelopeRpc;
  block: Record<string, unknown>;
  note: { root: bigint; path: { siblings: bigint[] } };
  account: { root: bigint; path: { siblings: bigint[] }; dto: Record<string, unknown> };
  state: {
    root: bigint;
    tree: OpeningTree;
  };
  header: {
    hash: bigint;
    tree: OpeningTree;
    dto: Record<string, unknown>;
  };
  ethereum: {
    tree: SparseMerkleTree;
    hashes: Uint8Array[];
    logsRoot: bigint;
    timestamps: bigint[];
    log: {
      transactionIndex: bigint;
      logIndex: bigint;
      emitter: bigint;
      topics: Uint8Array[];
      data: Uint8Array;
      leaf: bigint;
      siblings: bigint[];
    };
    dto: Record<string, unknown>;
  };
  history: {
    tree: SparseMerkleTree;
    hashes: bigint[];
    dto: Record<string, unknown>;
  };
  accountProof: Record<string, unknown>;
  nullifiers: ReturnType<typeof nullifierTreeFixture>;
  nullifierProofs: Record<string, unknown>;
}

interface OpeningTree {
  proof(index: number): { siblings: bigint[] };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function makeFixture(materialStatus: MaterialStatus = "notPresent", spent = false): RpcFixture {
  const ethereumHashes = [bytes32(0x90), bytes32(0x91), bytes32(0x92)];
  const emptyL1LogsRoot = new SparseMerkleTree(64).root;
  const l1Log = {
    transactionIndex: 2n,
    logIndex: 1n,
    emitter: 0x1234567890abcdef1234567890abcdef12345678n,
    topics: [bytes32(0xa1), bytes32(0xa2)],
    data: Uint8Array.of(1, 2, 3, 4, 5),
  };
  const normalizedLogs = normalizeL1Logs([l1Log]);
  const l1LogsRoots = [emptyL1LogsRoot, normalizedLogs.root, emptyL1LogsRoot];
  const l1LogCounts = [0, 1, 0];
  const ethereumTimestamps = [200n, 201n, 202n];
  const l1OriginTree = new SparseMerkleTree(40);
  for (let index = 0; index < ethereumHashes.length; index++) {
    l1OriginTree.setLeaf(index, l1OriginLeaf({
      blockNumber: 100n + BigInt(index),
      blockHash: ethereumHashes[index]!,
      timestamp: ethereumTimestamps[index]!,
      logsRoot: l1LogsRoots[index]!,
      logCount: l1LogCounts[index]!,
    }));
  }
  const historicalHashes = [0x501n, 0x502n];
  const historyTree = new SparseMerkleTree(40);
  historicalHashes.forEach((hash, index) => historyTree.setLeaf(index, historyLeaf(hash)));

  const noteTree = new SparseMerkleTree(40);
  noteTree.setLeaf(0, OUTPUT_COMMITMENT);
  const receiveKey = Uint8Array.from({ length: 1184 }, (_, index) => (index * 17 + 3) & 0xff);
  const receiveKeyHash = materialStatus === "notPresent" ? 0n : protocolReceiveKeyHash(receiveKey);
  const accountStateTree = new SparseMerkleTree(40);
  accountStateTree.setLeaf(0, accountStateCommitment(
    BigInt(ADDRESS),
    ACCOUNT_P,
    ACCOUNT_RULE_SET,
    0n,
    1n,
    receiveKeyHash,
  ));

  // Before the nullifier is inserted, its low leaf is the one holding 3, whose next value is 9.
  const nullifiers = nullifierTreeFixture([9n, 3n, ...(spent ? [BigInt(NULLIFIER)] : [])]);
  const state: StateComponents = {
    outputRoot: noteTree.root,
    outputCount: 1n,
    issuedSoFar: 0n,
    lagQ: 0n,
    accountStateRoot: accountStateTree.root,
    accountCount: 1n,
    nullifierRoot: nullifiers.root,
    nullifierCount: nullifiers.count,
  };
  const committedStateRoot = computeStateRoot(state);
  const committedStateTree = stateTree(state);
  const header: PcashBlockHeader = {
    parentHash: historicalHashes[1]!,
    number: 2n,
    timestamp: 1_000n,
    transactionResultsRoot: transactionResultsRoot([], []),
    stateRoot: committedStateRoot,
    l1OriginRoot: l1OriginTree.root,
    historyRoot: historyTree.root,
  };
  const blockHash = computeBlockHash(header);
  const committedHeaderTree = blockHeaderTree(header);
  const boundary: CurrentBoundaryEnvelopeRpc = {
    state: {
      outputRoot: fieldHex(state.outputRoot),
      outputCount: quantity(state.outputCount),
      issuedSoFar: quantity(state.issuedSoFar),
      lagQ: state.lagQ.toString(),
      accountStateRoot: fieldHex(state.accountStateRoot),
      accountCount: quantity(state.accountCount),
      nullifierRoot: fieldHex(state.nullifierRoot),
      nullifierCount: quantity(state.nullifierCount),
    },
    header: {
      parentHash: fieldHex(header.parentHash),
      number: quantity(header.number),
      timestamp: quantity(header.timestamp),
      transactionResultsRoot: fieldHex(header.transactionResultsRoot),
      stateRoot: fieldHex(header.stateRoot),
      l1OriginRoot: fieldHex(header.l1OriginRoot),
      historyRoot: fieldHex(header.historyRoot),
    },
    blockHash: fieldHex(blockHash),
  };
  const material = materialStatus === "notPresent"
    ? { status: "notPresent" }
    : materialStatus === "available"
      ? { status: "available", mlKem768PublicKey: hex(receiveKey) }
      : { status: "unavailable", lifecycle: "catchingUp" };
  const accountDto = {
    address: ADDRESS,
    index: "0x0",
    accountRevision: "0x1",
    accountKind: "0x0",
    nullifierKeyCommitment: fieldHex(ACCOUNT_P),
    accountRuleSetCommitment: fieldHex(ACCOUNT_RULE_SET),
    receiveKeyHash: fieldHex(receiveKeyHash),
    material,
  };
  const accountProof = {
    status: "present",
    account: accountDto,
    accountStateRoot: fieldHex(accountStateTree.root),
    accountSiblings: fields(accountStateTree.proof(0).siblings),
    accountCount: "0x1",
    stateRootHeaderSiblings: fields(committedHeaderTree.proof(BLOCK_HEADER_KEY_STATE_ROOT).siblings),
    accountStateRootStateSiblings: fields(committedStateTree.proof(STATE_KEY_ACCOUNT_STATE_ROOT).siblings),
    boundary,
  };
  const origin = (index: number) => ({
    blockNumber: quantity(100 + index),
    blockHash: hex(ethereumHashes[index]!),
    blockTimestamp: quantity(ethereumTimestamps[index]!),
    l1LogsRoot: fieldHex(l1LogsRoots[index]!),
    l1LogCount: quantity(l1LogCounts[index]!),
  });
  const headerDto = {
    recentPcashBlockHash: fieldHex(blockHash),
    boundary,
  };
  const l1OriginDto = {
    recentPcashBlockHash: fieldHex(blockHash),
    l1OriginRoot: fieldHex(l1OriginTree.root),
    l1OriginRootSiblings: fields(committedHeaderTree.proof(BLOCK_HEADER_KEY_L1_ORIGIN_ROOT).siblings),
    l1BlockNumber: "0x65",
    l1BlockHash: hex(ethereumHashes[1]!),
    l1BlockTimestamp: quantity(ethereumTimestamps[1]!),
    l1LogsRoot: fieldHex(normalizedLogs.root),
    l1LogCount: "0x1",
    l1OriginIndex: "0x1",
    l1OriginSiblings: fields(l1OriginTree.proof(1).siblings),
    boundary,
  };
  const historyDto = {
    recentPcashBlockHash: fieldHex(blockHash),
    historyRoot: fieldHex(historyTree.root),
    historyRootSiblings: fields(committedHeaderTree.proof(BLOCK_HEADER_KEY_HISTORY_ROOT).siblings),
    historicalBlockNumber: "0x1",
    historicalBlockHash: fieldHex(historicalHashes[1]!),
    historySiblings: fields(historyTree.proof(1).siblings),
    boundary,
  };
  const block = {
    number: boundary.header.number,
    hash: boundary.blockHash,
    parentHash: boundary.header.parentHash,
    timestamp: boundary.header.timestamp,
    transactionResultsRoot: boundary.header.transactionResultsRoot,
    stateRoot: boundary.header.stateRoot,
    l1OriginRoot: boundary.header.l1OriginRoot,
    historyRoot: boundary.header.historyRoot,
    transactionResultCount: "0x0",
    transactionResults: [],
    transactionBytes: null,
    l1Origin: origin(2),
  };
  return {
    boundary,
    block,
    note: { root: noteTree.root, path: noteTree.proof(0) },
    account: { root: accountStateTree.root, path: accountStateTree.proof(0), dto: accountDto },
    state: { root: committedStateRoot, tree: committedStateTree },
    header: { hash: blockHash, tree: committedHeaderTree, dto: headerDto },
    ethereum: {
      tree: l1OriginTree,
      hashes: ethereumHashes,
      logsRoot: normalizedLogs.root,
      timestamps: ethereumTimestamps,
      log: { ...l1Log, leaf: normalizedLogs.logs[0]!.leaf, siblings: normalizedLogs.proof(0) },
      dto: l1OriginDto,
    },
    history: { tree: historyTree, hashes: historicalHashes, dto: historyDto },
    accountProof,
    nullifiers,
    nullifierProofs: {
      nullifierRoot: fieldHex(state.nullifierRoot),
      proofs: [nullifierProofRpc(nullifiers.proof(BigInt(NULLIFIER)))],
      boundary,
    },
  };
}

describe("PcashNodeClient authenticated block, state, Ethereum, and history reads", () => {
  it("closes the latest typed block header to one boundary", async () => {
    const fixture = makeFixture();
    const captured: Captured[] = [];
    const result = await new PcashNodeClient("http://n", stub(fixture.header.dto, captured)).getBlockHeader();

    expect(captured[0]!.body).toMatchObject({ method: "pcash_getBlockHeader", params: ["latest"] });
    expect(result.recentPcashBlockHash).toBe(fixture.header.hash);
    expect(result.boundary.header.stateRoot).toBe(fixture.state.root);
    expect(result.boundary.header.l1OriginRoot).toBe(fixture.ethereum.tree.root);
    expect(result.boundary.header.historyRoot).toBe(fixture.history.tree.root);
  });

  it.each([
    ["state", (response: any) => { response.boundary.state.outputCount = "0x2"; }],
    ["header", (response: any) => { response.boundary.header.timestamp = "0x3e9"; }],
    ["full-width nullifier root", (response: any) => {
      response.boundary.state.nullifierRoot = fullWidthAlias(response.boundary.state.nullifierRoot);
    }],
    ["full-width transaction-results root", (response: any) => {
      response.boundary.header.transactionResultsRoot = fullWidthAlias(response.boundary.header.transactionResultsRoot);
    }],
    ["hash echo", (response: any) => { response.recentPcashBlockHash = fieldHex(1n); }],
  ])("rejects a mutated block %s", async (_label, mutate) => {
    const response = clone(makeFixture().header.dto);
    mutate(response);
    await expect(new PcashNodeClient("http://n", stub(response)).getBlockHeader()).rejects.toThrow();
  });

  it("reads a block header by hash", async () => {
    const fixture = makeFixture();
    const captured: Captured[] = [];
    const result = await new PcashNodeClient("http://n", stub(fixture.header.dto, captured)).getBlockHeader({
      hash: fixture.header.hash,
    });

    expect(captured[0]!.body).toMatchObject({ method: "pcash_getBlockHeader", params: [fieldHex(fixture.header.hash)] });
    expect(result.boundary.blockHash).toBe(fixture.header.hash);
  });

  it("rejects a header for a different block than the hash asked for", async () => {
    const fixture = makeFixture();
    await expect(new PcashNodeClient("http://n", stub(fixture.header.dto)).getBlockHeader({
      hash: fixture.header.hash ^ 1n,
    })).rejects.toThrow("block-header hash mismatch");
  });

  it("verifies an L1 origin proof rooted in the recent PCASH block", async () => {
    const fixture = makeFixture();
    const captured: Captured[] = [];
    const result = await new PcashNodeClient("http://n", stub(fixture.ethereum.dto, captured)).getL1OriginProof(
      fixture.header.hash,
      101n,
    );

    expect(captured[0]!.body.params).toEqual([fieldHex(fixture.header.hash), "0x65"]);
    expect(result.l1BlockNumber).toBe(101n);
    expect(result.l1OriginIndex).toBe(1n);
    expect(result.l1BlockHash).toEqual(fixture.ethereum.hashes[1]);
    expect(result.l1BlockTimestamp).toBe(fixture.ethereum.timestamps[1]);
    expect(result.l1LogsRoot).toBe(fixture.ethereum.logsRoot);
    expect(result.l1LogCount).toBe(1n);
  });

  it("rejects a block hash that agrees with the committed one only modulo p", async () => {
    const fixture = makeFixture();
    const response = clone(fixture.ethereum.dto) as any;
    response.l1BlockHash = fullWidthAlias(response.l1BlockHash);
    await expect(new PcashNodeClient("http://n", stub(response)).getL1OriginProof(fixture.header.hash, 101n))
      .rejects.toThrow("invalid L1 origin proof");
  });

  it("verifies a normalized L1 log under the authenticated block", async () => {
    const fixture = makeFixture();
    const captured: Captured[] = [];
    const response = {
      ...fixture.ethereum.dto,
      logLeafIndex: "0x0",
      logSiblings: fields(fixture.ethereum.log.siblings),
      transactionIndex: quantity(fixture.ethereum.log.transactionIndex),
      logIndex: quantity(fixture.ethereum.log.logIndex),
    };
    const result = await new PcashNodeClient("http://n", stub(response, captured)).getL1LogProof(
      fixture.header.hash,
      101n,
      2n,
      1n,
      fixture.ethereum.log,
    );
    expect(captured[0]!.body.method).toBe("pcash_getL1LogProof");
    expect(captured[0]!.body.params).toEqual([fieldHex(fixture.header.hash), "0x65", "0x2", "0x1"]);
    expect(result.l1LogsRoot).toBe(fixture.ethereum.logsRoot);
    expect(result.logLeafIndex).toBe(0n);
  });

  it.each([
    ["public log data", (_response: any, log: any) => { log.data = Uint8Array.of(1, 2, 3, 4, 6); }],
    ["log opening", (response: any) => { response.logSiblings[0] = fieldHex(1n); }],
    ["transaction coordinate", (response: any) => { response.transactionIndex = "0x3"; }],
  ])("rejects a normalized Ethereum proof with bad %s", async (_label, mutate) => {
    const fixture = makeFixture();
    const response = {
      ...clone(fixture.ethereum.dto),
      logLeafIndex: "0x0",
      logSiblings: fields(fixture.ethereum.log.siblings),
      transactionIndex: quantity(fixture.ethereum.log.transactionIndex),
      logIndex: quantity(fixture.ethereum.log.logIndex),
    };
    const log = { ...fixture.ethereum.log, data: fixture.ethereum.log.data.slice() };
    mutate(response, log);
    await expect(new PcashNodeClient("http://n", stub(response)).getL1LogProof(
      fixture.header.hash,
      101n,
      2n,
      1n,
      log,
    )).rejects.toThrow();
  });

  it.each([
    ["recent block echo", (response: any) => { response.recentPcashBlockHash = fieldHex(1n); }],
    ["header opening", (response: any) => { response.l1OriginRootSiblings = []; }],
    ["block hash", (response: any) => { response.l1BlockHash = hex(bytes32(0xfe)); }],
    ["block timestamp", (response: any) => { response.l1BlockTimestamp = "0xff"; }],
    ["logs root", (response: any) => { response.l1LogsRoot = fieldHex(1n); }],
    ["log count", (response: any) => { response.l1LogCount = "0x2"; }],
    ["number", (response: any) => { response.l1BlockNumber = "0x66"; }],
    ["leaf index", (response: any) => { response.l1OriginIndex = "0x2"; }],
  ])("rejects an L1 origin proof with a bad %s", async (_label, mutate) => {
    const fixture = makeFixture();
    const response = clone(fixture.ethereum.dto);
    mutate(response);
    await expect(new PcashNodeClient("http://n", stub(response)).getL1OriginProof(
      fixture.header.hash,
      101n,
    )).rejects.toThrow();
  });

  it("verifies a historical PCASH block proof rooted in the recent block", async () => {
    const fixture = makeFixture();
    const captured: Captured[] = [];
    const result = await new PcashNodeClient("http://n", stub(fixture.history.dto, captured)).getHistoryProof(
      fixture.header.hash,
      1n,
    );

    expect(captured[0]!.body.params).toEqual([fieldHex(fixture.header.hash), "0x1"]);
    expect(result.historicalBlockNumber).toBe(1n);
    expect(result.historicalBlockHash).toBe(fixture.history.hashes[1]);
  });

  it.each([
    ["recent block echo", (response: any) => { response.recentPcashBlockHash = fieldHex(1n); }],
    ["header opening", (response: any) => { response.historyRootSiblings = []; }],
    ["historical hash", (response: any) => { response.historicalBlockHash = fieldHex(1n); }],
    ["number", (response: any) => { response.historicalBlockNumber = "0x0"; }],
  ])("rejects a history proof with a bad %s", async (_label, mutate) => {
    const fixture = makeFixture();
    const response = clone(fixture.history.dto);
    mutate(response);
    await expect(new PcashNodeClient("http://n", stub(response)).getHistoryProof(
      fixture.header.hash,
      1n,
    )).rejects.toThrow();
  });

  it("keeps contract lookup result states distinct", async () => {
    await expect(new PcashNodeClient("http://n", stub({
      status: "notFound",
      address: ADDRESS,
      authenticated: false,
    })).getContract(ADDRESS)).resolves.toEqual({
      status: "notFound",
      address: ADDRESS,
      authenticated: false,
    });
    await expect(new PcashNodeClient("http://n", stub({
      status: "unavailable",
      address: ADDRESS,
      lifecycle: "catchingUp",
    })).getContract(ADDRESS)).resolves.toEqual({
      status: "unavailable",
      address: ADDRESS,
      lifecycle: "catchingUp",
    });
    const fixture = makeFixture();
    await expect(new PcashNodeClient("http://n", stub({
      status: "notContract",
      accountProof: fixture.accountProof,
    })).getContract(ADDRESS)).resolves.toMatchObject({ status: "notContract" });
  });

  it.each([
    ["missing miss authentication", { status: "notFound", address: ADDRESS }],
    ["wrong miss authentication", { status: "notFound", address: ADDRESS, authenticated: true }],
    ["substituted miss address", {
      status: "notFound",
      address: `0x${"00".repeat(19)}ac`,
      authenticated: false,
    }],
    ["missing unavailable lifecycle", { status: "unavailable", address: ADDRESS }],
    ["substituted unavailable address", {
      status: "unavailable",
      address: `0x${"00".repeat(19)}ac`,
      lifecycle: "catchingUp",
    }],
  ])("rejects a contract lookup with %s", async (_label, response) => {
    await expect(new PcashNodeClient("http://n", stub(response)).getContract(ADDRESS)).rejects.toThrow();
  });
});

describe("PcashNodeClient reads", () => {
  const deliveryTransactionHash = `0x${"31".repeat(32)}`;
  const blobHash = `0x01${"32".repeat(31)}`;
  const inboxDelivery = {
    l1BlockNumber: "0x64",
    l1BlockHash: `0x${"33".repeat(32)}`,
    l1TransactionIndex: "0x2",
    l1TransactionHash: deliveryTransactionHash,
    l1Sender: `0x${"34".repeat(20)}`,
    carrierType: "blob",
    logIndex: null,
    emitter: null,
    context: null,
    carrierHash: `0x${"35".repeat(32)}`,
    carrierLength: "0x1000",
    blobVersionedHashes: [blobHash],
    posterOwnerCommitment: null,
    posterContext: null,
    exclusionReason: null,
    items: [
      { batchItemIndex: "0x0", contentHash: `0x${"36".repeat(32)}`, byteOffset: "0x47", byteLength: "0x20", exclusionReason: null },
      { batchItemIndex: "0x1", contentHash: `0x${"37".repeat(32)}`, byteOffset: "0x67", byteLength: "0x1", exclusionReason: "unknownKind" },
    ],
  };
  const eventDelivery = {
    ...inboxDelivery,
    carrierType: "event",
    logIndex: "0x3",
    emitter: `0x${"38".repeat(20)}`,
    context: "0xc017e0",
    carrierHash: `0x${"39".repeat(32)}`,
    carrierLength: "0x200",
    blobVersionedHashes: [],
    items: [
      { batchItemIndex: "0x2", contentHash: `0x${"3a".repeat(32)}`, byteOffset: "0x47", byteLength: "0x20", exclusionReason: "directModeOutsideInbox" },
    ],
  };
  const malformedEvent = {
    ...eventDelivery,
    logIndex: "0x4",
    context: null,
    exclusionReason: "invalidCarrierEncoding",
    items: [],
  };

  const deliveryContinuation = (nextBatch: number) => ({
    block: { blockNumber: "0x7", blockHash: `0x${"3c".repeat(32)}` },
    nextBatch: quantity(nextBatch),
  });
  const deliveryPage = (batches: unknown[], nextBatch: number | null) => ({
    l1TransactionHash: deliveryTransactionHash,
    batches,
    continuation: nextBatch === null ? null : deliveryContinuation(nextBatch),
    complete: nextBatch === null,
  });
  /** A node that serves `batches` `perPage` at a time from where each continuation points. */
  function pagedDeliveries(batches: unknown[], perPage: number, captured: Captured[] = []) {
    return rpcFetch((body, url) => {
      captured.push({ url, body });
      const continuation = (body.params[0] as { continuation?: { nextBatch: string } }).continuation;
      const start = continuation === undefined ? 0 : Number(BigInt(continuation.nextBatch));
      const end = Math.min(start + perPage, batches.length);
      return rpcResult(body, deliveryPage(batches.slice(start, end), end < batches.length ? end : null));
    });
  }

  it("reads every carrier's delivery manifest of one L1 transaction across pages, in carrier order", async () => {
    const captured: Captured[] = [];
    const result = await new PcashNodeClient("http://n", pagedDeliveries([inboxDelivery, eventDelivery, malformedEvent], 2, captured))
      .getL1DeliveryBatches(deliveryTransactionHash);
    expect(captured.map((call) => [call.body.method, call.body.params])).toEqual([
      ["pcash_getL1DeliveryBatches", [{ l1TransactionHash: deliveryTransactionHash }]],
      ["pcash_getL1DeliveryBatches", [{ l1TransactionHash: deliveryTransactionHash, continuation: deliveryContinuation(2) }]],
    ]);
    expect(result.map((batch) => [batch.carrierType, batch.logIndex, batch.emitter, batch.context])).toEqual([
      ["blob", null, null, null],
      ["event", 3n, `0x${"38".repeat(20)}`, "0xc017e0"],
      ["event", 4n, `0x${"38".repeat(20)}`, null],
    ]);
    expect(result[0]!.blobVersionedHashes).toEqual([blobHash]);
    expect(result[0]!.items.map((item) => [item.batchItemIndex, item.exclusionReason])).toEqual([[0n, null], [1n, "unknownKind"]]);
    expect(result[1]!.items.map((item) => [item.batchItemIndex, item.exclusionReason])).toEqual([[2n, "directModeOutsideInbox"]]);
    expect(result[2]!.exclusionReason).toBe("invalidCarrierEncoding");
    await expect(new PcashNodeClient("http://n", stub(deliveryPage([], null))).getL1DeliveryBatches(deliveryTransactionHash)).resolves.toEqual([]);
    await expect(new PcashNodeClient("http://n", stub(deliveryPage([{ ...eventDelivery, carrierType: "log" }], null)))
      .getL1DeliveryBatches(deliveryTransactionHash)).rejects.toThrow();
  });

  it("reads the Inbox carrier's manifest from the first page alone, where carrier order puts it", async () => {
    const captured: Captured[] = [];
    const inbox = await new PcashNodeClient("http://n", pagedDeliveries([inboxDelivery, eventDelivery], 1, captured))
      .getInboxDeliveryBatch(deliveryTransactionHash);
    expect(captured.map((call) => call.body.params)).toEqual([
      [{ l1TransactionHash: deliveryTransactionHash, limits: { maxBatches: "0x1" } }],
    ]);
    expect(inbox?.carrierType).toBe("blob");
    expect(inbox?.items).toHaveLength(2);
    await expect(new PcashNodeClient("http://n", pagedDeliveries([eventDelivery, malformedEvent], 1))
      .getInboxDeliveryBatch(deliveryTransactionHash)).resolves.toBeNull();
    await expect(new PcashNodeClient("http://n", stub(deliveryPage([], null)))
      .getInboxDeliveryBatch(deliveryTransactionHash)).resolves.toBeNull();
  });

  function feeEstimateResponse() {
    const tiers = { low: "0x1", standard: "0x2", fast: "0x3" };
    return {
      head: { blockNumber: "0x10", blockHash: `0x${"11".repeat(32)}` },
      windowBlocks: "0x40",
      byteSize: "0x8121",
      tiers,
      basis: {
        includedSamples: "0x7", included: tiers, pendingSamples: "0x0", pending: null,
      },
    };
  }

  it.each([
    { query: { kind: "privateValue" }, request: { kind: "privateValue" } },
    { query: { kind: "contractAccount" }, request: { kind: "contractAccount" } },
    { query: { kind: "userAccountUpdate" }, request: { kind: "userAccountUpdate" } },
    { query: { byteSize: 33_057n }, request: { byteSize: "0x8121" } },
    { query: { kind: "privateValue", byteSize: 33_057n }, request: { kind: "privateValue", byteSize: "0x8121" } },
  ] as const)("estimateFee() encodes $query and decodes a byte-based quote", async ({ query, request }) => {
    const captured: Captured[] = [];
    const estimate = await new PcashNodeClient("http://n", stub(feeEstimateResponse(), captured)).estimateFee(query);
    expect(captured[0]!.body).toMatchObject({ method: "pcash_estimateFee", params: [request] });
    expect(captured[0]!.body.params).toEqual([request]);
    expect(estimate.byteSize).toBe(33_057n);
    expect(estimate.windowBlocks).toBe(64n);
    expect(estimate.tiers).toEqual({ low: 1n, standard: 2n, fast: 3n });
    expect(estimate.basis.includedSamples).toBe(7n);
    expect(estimate.basis.pendingSamples).toBe(0n);
    expect(estimate.basis.included).toEqual({ low: 1n, standard: 2n, fast: 3n });
    expect(estimate.basis.pending).toBeNull();
  });

  it.each(["tiers", "basis"])("estimateFee() requires %s in every quote", async (field) => {
    const response = { ...feeEstimateResponse(), [field]: null };
    await expect(new PcashNodeClient("http://n", stub(response, [])).estimateFee({ byteSize: 1_000n }))
      .rejects.toThrow(`pcash_estimateFee.${field}`);
  });

  it("status() decodes quantities to bigints", async () => {
    const cap: Captured[] = [];
    const client = new PcashNodeClient(
      "http://node",
      stub(statusResult(), cap),
    );
    const s = await client.status();
    expect(cap[0]!.body.method).toBe("pcash_status");
    expect(cap[0]!.body.params).toEqual([]);
    expect(s.latestBlock).toBe(16n);
    expect(s.latestBlockHash).toBe(fieldHex(0x10n));
    expect(s.latestBlockTimestamp).toBe(0x6553f100n);
    expect(s.finalizedBlock).toBe(10n);
    expect(s.finalizedBlockHash).toBe(fieldHex(0xan));
    expect(s.finalizedBlockTimestamp).toBe(0x6553f0b8n);
    expect(s.stateRoot).toBe(fieldHex(1n));
    expect(s.l1OriginRoot).toBe(fieldHex(2n));
    expect(s.historyRoot).toBe(fieldHex(3n));
    expect(s.outputCount).toBe(5n);
    expect(s.issuedSoFar).toBe(4_000_000_000_000_000_000n);
    expect(s.supplyCap).toBe(1_000_000_000n * 10n ** 18n);
    expect(s.totalSucceeded).toBe(12n);
    expect(s.totalFailed).toBe(3n);
    expect(s.totalTransactions).toBe(15n);
    expect(s.index).toEqual({
      status: "Ready",
      cursor: { blockNumber: 16n, blockHash: fieldHex(0x10n) },
    });
    expect(s.proverAssets).toBeNull();
    expect(s.pcashChainId).toBe(0xaa36a7);
    expect(s.genesisHash).toBe(`0x${"11".repeat(32)}`);
    expect(s.acceptedTransactionTypes).toEqual([0, 1, 2, 3]);
    expect(s.acceptedBatchVersions).toEqual([1]);
    expect(s.l1ChainId).toBe(1n);
    expect(s.genesisL1Block).toBe(5n);
    expect(s.latestL1BlockNumber).toBe(21n);
    expect(s.latestL1BlockHash).toBe(`0x${"15".repeat(32)}`);
    expect(s.observedL1BlockNumber).toBe(24n);
    expect(s.derivation).toEqual({ state: "following", sinceUnixMs: 1_700_000_000_000n });
    expect(s.finalizedL1BlockNumber).toBe(15n);
    expect(s.finalizedL1BlockHash).toBe(`0x${"0f".repeat(32)}`);
  });

  it.each([
    [
      { state: "stalled", cause: "l1Rpc", l1BlockNumber: "0x16", sinceUnixMs: "0x18bcfe56800" },
      { state: "stalled", cause: "l1Rpc", l1BlockNumber: 22n, sinceUnixMs: 1_700_000_000_000n },
    ],
    [
      { state: "stalled", cause: "blobs", l1BlockNumber: "0x16", sinceUnixMs: "0x18bcfe56800" },
      { state: "stalled", cause: "blobs", l1BlockNumber: 22n, sinceUnixMs: 1_700_000_000_000n },
    ],
    [
      { state: "halted", cause: "verifier", l1BlockNumber: "0x16", sinceUnixMs: "0x18bcfe56800" },
      { state: "halted", cause: "verifier", l1BlockNumber: 22n, sinceUnixMs: 1_700_000_000_000n },
    ],
  ])("status() decodes derivation %o", async (wire, decoded) => {
    const response = statusResult();
    response.derivation = wire;
    const result = await new PcashNodeClient("http://n", stub(response)).status();
    expect(result.derivation).toEqual(decoded);
  });

  it.each([
    ["missing", (response: any) => { delete response.derivation; }],
    ["unknown state", (response: any) => { response.derivation = { state: "paused", sinceUnixMs: "0x1" }; }],
    ["stall cause on a halt", (response: any) => {
      response.derivation = { state: "halted", cause: "blobs", l1BlockNumber: "0x16", sinceUnixMs: "0x1" };
    }],
    ["stalled without a block", (response: any) => {
      response.derivation = { state: "stalled", cause: "l1Rpc", sinceUnixMs: "0x1" };
    }],
  ])("status() rejects malformed derivation: %s", async (_label, mutate) => {
    const response = statusResult();
    mutate(response);
    await expect(new PcashNodeClient("http://n", stub(response)).status()).rejects.toThrow();
  });

  it("status() accepts explicit nulls for unavailable values", async () => {
    const response = statusResult();
    response.observedL1BlockNumber = null;
    response.totalSucceeded = null;
    response.totalFailed = null;
    response.totalTransactions = null;
    response.index = { status: "Building", cursor: null };
    const result = await new PcashNodeClient("http://n", stub(response)).status();
    expect(result.observedL1BlockNumber).toBeNull();
    expect(result.index.cursor).toBeNull();
  });

  it("status() decodes advertised browser prover assets", async () => {
    const response = statusResult();
    response.proverAssets = {
      assetSetId: "42".repeat(32),
      baseUrl: `/proving/${"42".repeat(32)}/`,
    };
    await expect(new PcashNodeClient("http://n", stub(response)).status()).resolves.toMatchObject({
      proverAssets: response.proverAssets,
    });
  });

  it.each([
    ["missing capability", (response: any) => {
      delete response.proverAssets;
    }],
    ["bad asset set ID", (response: any) => {
      response.proverAssets = { assetSetId: "AA", baseUrl: "/proving/AA/" };
    }],
    ["empty base URL", (response: any) => {
      response.proverAssets = { assetSetId: "42".repeat(32), baseUrl: "" };
    }],
  ])("status() rejects malformed prover assets: %s", async (_label, mutate) => {
    const response = statusResult();
    mutate(response);
    await expect(new PcashNodeClient("http://n", stub(response)).status()).rejects.toThrow();
  });

  it("exposes the configured RPC endpoint verbatim", () => {
    expect(new PcashNodeClient("/rpc").rpcUrl).toBe("/rpc");
  });

  it.each([
    ["supplyCap", (response: any) => { delete response.supplyCap; }],
    ["supplyCap type", (response: any) => { response.supplyCap = false; }],
    ["index cursor", (response: any) => { delete response.index.cursor; }],
    ["index cursor type", (response: any) => { response.index.cursor = false; }],
  ])("status() rejects malformed %s", async (_label, mutate) => {
    const response = statusResult();
    mutate(response);
    await expect(new PcashNodeClient("http://n", stub(response)).status()).rejects.toThrow();
  });

  it("getBlock() decodes a canonical PCASH block and its nested L1 origin", async () => {
    const fixture = makeFixture();
    const cap: Captured[] = [];
    const client = new PcashNodeClient("http://node", stub(fixture.block, cap));
    await expect(client.getBlock(2n)).resolves.toMatchObject({
      number: 2n,
      hash: fixture.block.hash,
      transactionResultCount: 0n,
      transactionResults: [],
      l1Origin: { blockNumber: 102n },
    });
    expect(cap[0]!.body.method).toBe("pcash_getBlockByNumber");
    expect(cap[0]!.body.params).toEqual(["0x2", false]);
  });

  it("getBlock() requests and decodes full transaction bodies", async () => {
    const fixture = makeFixture();
    const bytes = "0x010203";
    const response = {
      ...fixture.block,
      transactionResultCount: "0x1",
      transactionResults: [{
        inclusion: {
          l1BlockNumber: "0xc",
          l1BlockHash: `0x${"44".repeat(32)}`,
          l1TransactionIndex: "0x2",
          l1TransactionHash: `0x${"7c".repeat(32)}`,
          batchItemIndex: "0x3",
        },
        contentHash: `0x${"55".repeat(32)}`,
        transactionId: `0x${"66".repeat(32)}`,
        outcome: "proofRejected",
      }],
      transactionBytes: [bytes],
    };
    const captured: Captured[] = [];
    const block = await new PcashNodeClient("http://n", stub(response, captured)).getBlock(2n, true);
    expect(captured[0]!.body.params).toEqual(["0x2", true]);
    expect(block?.transactionBytes).toEqual([bytes]);
    expect(block?.transactionResults[0]).toMatchObject({ outcome: "proofRejected", inclusion: { batchItemIndex: 3n } });
  });

  it("getTransactions() encodes an anchored cursor and decodes typed summaries", async () => {
    const captured: Captured[] = [];
    const cursor = explorerCursorResult();
    const client = new PcashNodeClient("http://n", stub({
      items: [transactionSummaryResult()],
      nextCursor: cursor,
      head: cursor.head,
    }, captured));
    const page = await client.getTransactions({
      cursor: {
        head: { blockNumber: 9n, blockHash: `0x${"09".repeat(32)}` },
        blockNumber: 7n,
        pcashTransactionIndex: 2n,
      },
      limit: 25,
      kind: "privateValue",
      blockNumber: 7n,
    });
    expect(captured[0]!.body).toMatchObject({
      method: "pcash_getTransactions",
      params: [{ cursor, limit: "0x19", kind: "privateValue", blockNumber: "0x7" }],
    });
    expect(page.items[0]).toMatchObject({
      kind: "privateValue",
      pcashTransactionIndex: 2n,
      byteSize: 0x120n,
      block: { blockNumber: 7n },
      declaredOpenFeeAmount: 2n,
      declaredIssuanceOwnerCommitment: `0x${"00".repeat(32)}`,
      issuanceRoute: "open",
    });
    expect(page.nextCursor?.head.blockNumber).toBe(9n);
  });

  it("getTransactions() rejects an unknown issuance route", async () => {
    const summary = transactionSummaryResult();
    summary.issuanceRoute = "unknown";
    await expect(new PcashNodeClient("http://n", stub({ items: [summary], nextCursor: null, head: explorerCursorResult().head }))
      .getTransactions()).rejects.toThrow(/issuanceRoute/);
  });

  it("getTransactions() decodes failure details and detail-free failures", async () => {
    const zeroInput = transactionSummaryResult();
    zeroInput.outcome = "zeroNullifier";
    zeroInput.failureDetail = { type: "zeroNullifier", inputSlot: "0x2" };
    const rejected = transactionSummaryResult();
    rejected.outcome = "proofRejected";
    rejected.failureDetail = null;
    const head = explorerCursorResult().head;

    const page = await new PcashNodeClient("http://n", stub({
      items: [transactionSummaryResult(), zeroInput, rejected],
      nextCursor: null,
      head,
    })).getTransactions();

    expect(page.items.map((item) => [item.outcome, item.failureDetail])).toEqual([
      ["succeeded", null],
      ["zeroNullifier", { type: "zeroNullifier", inputSlot: 2n }],
      ["proofRejected", null],
    ]);
  });

  it("getBlockByHash() performs a canonical block point read", async () => {
    const fixture = makeFixture();
    const captured: Captured[] = [];
    const blockHash = fixture.block.hash as string;
    const block = await new PcashNodeClient("http://n", stub(fixture.block, captured)).getBlockByHash(blockHash);
    expect(captured[0]!.body).toMatchObject({ method: "pcash_getBlockByHash", params: [blockHash, false] });
    expect(block).toMatchObject({ hash: blockHash, number: 2n, transactionResultCount: 0n });
  });

  it("getTransaction() returns null or exact bytes with one canonical inclusion", async () => {
    const transactionId = transactionSummaryResult().transactionId as string;
    await expect(new PcashNodeClient("http://n", stub(null)).getTransaction(transactionId)).resolves.toBeNull();
    const result = await new PcashNodeClient("http://n", stub({
      summary: transactionSummaryResult(),
      rawTransaction: "0x010203",
    })).getTransaction(transactionId);
    expect(result).toMatchObject({
      rawTransaction: "0x010203",
      summary: { transactionId, pcashTransactionIndex: 2n },
    });
  });

  it("getContracts() encodes verified-only pagination and decodes directory rows", async () => {
    const captured: Captured[] = [];
    const cursor = explorerCursorResult();
    const client = new PcashNodeClient("http://n", stub({
      items: [contractSummaryResult()],
      nextCursor: null,
      head: cursor.head,
    }, captured));
    const page = await client.getContracts({
      cursor: {
        head: { blockNumber: 9n, blockHash: `0x${"09".repeat(32)}` },
        blockNumber: 7n,
        pcashTransactionIndex: 2n,
      },
      limit: 50,
      verifiedOnly: true,
    });
    expect(captured[0]!.body).toMatchObject({
      method: "pcash_getContracts",
      params: [{ cursor, limit: "0x32", verifiedOnly: true }],
    });
    expect(page.items[0]).toMatchObject({
      sourceVerification: "verified",
      configurationOpeningCount: 1n,
      functions: [{ selector: 1n }],
    });
  });

  it("areNullifiersSpent() wraps the list in a single array param", async () => {
    const cap: Captured[] = [];
    const nulls = [`0x${"11".repeat(32)}`, `0x${"22".repeat(32)}`];
    const client = new PcashNodeClient("http://n", stub([true, false], cap));
    expect(await client.areNullifiersSpent(nulls)).toEqual([true, false]);
    expect(cap[0]!.body.method).toBe("pcash_areNullifiersSpent");
    expect(cap[0]!.body.params).toEqual([nulls]);
  });

  it("catalogInfo() decodes status, policy, and limits", async () => {
    const cap: Captured[] = [];
    const client = new PcashNodeClient("http://n", stub(catalogInfoResult(), cap));
    const info = await client.catalogInfo();

    expect(cap[0]!.body).toMatchObject({ method: "pcash_catalogInfo", params: [] });
    expect(info.status).toBe("available");
    expect(info.writable).toBe(true);
    expect(info.pcashChainId).toBe(1);
    expect(info.namespaces).toEqual([MARKETPLACE_NAMESPACE]);
    expect(info.limits.maxPayloadBytes).toBe(262144n);
    expect(info.limits.maxRecords).toBe(5000n);
    expect(info.limits.maxAggregatePayloadBytes).toBe(10485760n);
  });

  it("catalogList() sends one positional object and decodes a page", async () => {
    const cap: Captured[] = [];
    const client = new PcashNodeClient(
      "http://n",
      stub({ items: [catalogRecordResult(PAYLOAD, "0x1e")], nextCursor: null }, cap),
    );
    const page = await client.catalogList({ namespace: MARKETPLACE_NAMESPACE });

    expect(cap[0]!.body).toMatchObject({
      method: "pcash_catalogList",
      params: [{ namespace: MARKETPLACE_NAMESPACE }],
    });
    expect(page.nextCursor).toBeNull();
    expect(page.items).toHaveLength(1);
    expect(bytesEqual(page.items[0]!.artifact.payload, PAYLOAD)).toBe(true);
    expect(page.items[0]!.createdAt).toBe(30n);
  });

  it("catalogList() rejects a record from another namespace", async () => {
    const foreign = {
      ...catalogRecordResult(PAYLOAD, "0x1e"),
      namespace: "other",
      contentId: catalogContentId({ namespace: "other", pcashChainId: 1, payload: PAYLOAD }),
    };
    const client = new PcashNodeClient("http://n", stub({ items: [foreign], nextCursor: null }));
    await expect(client.catalogList({ namespace: MARKETPLACE_NAMESPACE })).rejects.toThrow(/namespace other/);
  });

  it("catalogList() encodes an optional cursor and limit", async () => {
    const cap: Captured[] = [];
    const cursor = `0x${"77".repeat(32)}`;
    const client = new PcashNodeClient("http://n", stub({ items: [], nextCursor: cursor }, cap));
    const page = await client.catalogList({ namespace: MARKETPLACE_NAMESPACE, cursor, limit: 25 });

    expect(cap[0]!.body.params).toEqual([
      { namespace: MARKETPLACE_NAMESPACE, cursor, limit: "0x19" },
    ]);
    expect(page.nextCursor).toBe(cursor);
  });

  it("catalogPublish() sends an artifact and returns the node-assigned createdAt", async () => {
    const cap: Captured[] = [];
    const client = new PcashNodeClient("http://n", stub(catalogRecordResult(PAYLOAD, "0x3c"), cap));
    const artifact = buildCatalogArtifact({
      namespace: MARKETPLACE_NAMESPACE,
      pcashChainId: 1,
      payload: PAYLOAD,
    });
    const stored = await client.catalogPublish(artifact);

    expect(cap[0]!.body.method).toBe("pcash_catalogPublish");
    // No createdAt on the way out: only the node may assign it.
    expect(cap[0]!.body.params).toEqual([
      {
        namespace: MARKETPLACE_NAMESPACE,
        pcashChainId: "0x1",
        contentId: artifact.contentId,
        payload: "0x00ff807f01",
      },
    ]);
    expect(stored.createdAt).toBe(60n);
    expect(stored.artifact.contentId).toBe(artifact.contentId);
  });

  it("catalogGet() point-reads a record and decodes null for an absent one", async () => {
    const cap: Captured[] = [];
    const contentId = catalogContentId({
      namespace: MARKETPLACE_NAMESPACE,
      pcashChainId: 1,
      payload: PAYLOAD,
    });
    const client = new PcashNodeClient("http://n", stub(catalogRecordResult(PAYLOAD, "0x3c"), cap));
    const found = await client.catalogGet(MARKETPLACE_NAMESPACE, contentId);

    expect(cap[0]!.body).toMatchObject({
      method: "pcash_catalogGet",
      params: [{ namespace: MARKETPLACE_NAMESPACE, contentId }],
    });
    expect(found?.createdAt).toBe(60n);

    const absent = new PcashNodeClient("http://n", stub(null));
    await expect(absent.catalogGet(MARKETPLACE_NAMESPACE, contentId)).resolves.toBeNull();
  });

  it("rejects a point read answered with a different record", async () => {
    // The substitute is perfectly well-formed — its contentId commits to its own
    // payload — so only binding it to the requested id catches the swap.
    const requested = catalogContentId({
      namespace: MARKETPLACE_NAMESPACE,
      pcashChainId: 1,
      payload: PAYLOAD,
    });
    const substitute = Uint8Array.of(0x11, 0x22, 0x33);
    const client = new PcashNodeClient(
      "http://n",
      stub(catalogRecordResult(substitute, "0x3c")),
    );
    await expect(client.catalogGet(MARKETPLACE_NAMESPACE, requested)).rejects.toThrow(
      "is not the requested",
    );
  });

  it("rejects a publish answered with a different record", async () => {
    const client = new PcashNodeClient(
      "http://n",
      stub(catalogRecordResult(Uint8Array.of(0x11, 0x22, 0x33), "0x3c")),
    );
    await expect(
      client.catalogPublish(
        buildCatalogArtifact({
          namespace: MARKETPLACE_NAMESPACE,
          pcashChainId: 1,
          payload: PAYLOAD,
        }),
      ),
    ).rejects.toThrow("is not the requested");
  });

  it("rejects a catalog record whose contentId does not commit to its payload", async () => {
    const tampered = catalogRecordResult(PAYLOAD, "0x1e");
    tampered.payload = "0x00ff807f02";
    const client = new PcashNodeClient("http://n", stub({ items: [tampered], nextCursor: null }));
    await expect(client.catalogList({ namespace: MARKETPLACE_NAMESPACE })).rejects.toThrow(
      "contentId does not match",
    );
  });

  it("rejects malformed catalog responses", async () => {
    await expect(
      new PcashNodeClient("http://n", stub({ status: "weird" })).catalogInfo(),
    ).rejects.toThrow("unknown catalog status");

    await expect(
      new PcashNodeClient("http://n", stub({ items: {} })).catalogList({
        namespace: MARKETPLACE_NAMESPACE,
      }),
    ).rejects.toThrow("items must be an array");

    await expect(
      new PcashNodeClient("http://n", stub({ items: [] })).catalogList({
        namespace: MARKETPLACE_NAMESPACE,
      }),
    ).rejects.toThrow("nextCursor is required");

    await expect(
      new PcashNodeClient("http://n", stub(null)).catalogList({
        namespace: MARKETPLACE_NAMESPACE,
      }),
    ).rejects.toThrow("malformed result");
  });

  it("refuses to send a record whose contentId does not commit to its payload", async () => {
    const artifact = buildCatalogArtifact({
      namespace: MARKETPLACE_NAMESPACE,
      pcashChainId: 1,
      payload: PAYLOAD,
    });
    const client = new PcashNodeClient("http://n", stub(catalogRecordResult(PAYLOAD, "0x1e")));
    await expect(
      client.catalogPublish({ ...artifact, payload: Uint8Array.of(0x01) }),
    ).rejects.toThrow("contentId does not match");
  });

  it("refuses to send an unusable catalog request", async () => {
    const client = new PcashNodeClient("http://n", stub({ items: [], nextCursor: null }));
    await expect(client.catalogList({ namespace: "Bad Namespace" })).rejects.toThrow(
      "catalog namespace must be",
    );
    await expect(
      client.catalogList({ namespace: MARKETPLACE_NAMESPACE, limit: 0 }),
    ).rejects.toThrow("limit must be a positive integer");
    await expect(
      client.catalogList({ namespace: MARKETPLACE_NAMESPACE, cursor: "0x1234" }),
    ).rejects.toThrow("cursor must be a 32-byte 0x hex string");
  });

  it("getReceipt() encodes content, inclusion, and account-revision selectors", async () => {
    const cap: Captured[] = [];
    const client = new PcashNodeClient("http://n", stub([], cap));
    const l1BlockHash = `0x${"33".repeat(32)}`;
    await client.getReceipt({
      inclusionId: { l1BlockHash, l1TransactionIndex: 2n, batchItemIndex: 3 },
    });
    await client.getReceipt({ contentHash: `0x${"44".repeat(32)}` });
    await client.getReceipt({
      address: "0x00000000000000000000000000000000000000aa",
      accountRevision: 7n,
    });
    expect(cap[0]!.body.params).toEqual([{
      inclusionId: {
        l1BlockHash,
        l1TransactionIndex: "0x2",
        batchItemIndex: "0x3",
      },
    }]);
    expect(cap[1]!.body.params).toEqual([{ contentHash: `0x${"44".repeat(32)}` }]);
    expect(cap[2]!.body.params).toEqual([{
      address: "0x00000000000000000000000000000000000000aa",
      accountRevision: "0x7",
    }]);
  });

  it("decodes an unrecoverable creation signature without failure detail", async () => {
    const failed = receiptResult();
    failed.outcome = "invalidAccountSignature";
    failed.failureDetail = null;
    const receipts = await new PcashNodeClient("http://n", stub([failed])).getReceipt(failed.transactionId as string);
    expect(receipts[0]).toMatchObject({ outcome: "invalidAccountSignature", failureDetail: null });
    failed.failureDetail = { type: "invalidAccountSignature" };
    await expect(new PcashNodeClient("http://n", stub([failed])).getReceipt(failed.transactionId as string))
      .rejects.toThrow(/must be null for outcome invalidAccountSignature/);
  });

  it("decodes deterministic failure detail and rejects outcome/detail mismatches", async () => {
    const failed = receiptResult();
    failed.outcome = "expired";
    failed.failureDetail = {
      type: "expired",
      validUntil: "0x10",
      blockTimestamp: "0x11",
    };
    const parsed = await new PcashNodeClient("http://n", stub([failed])).getReceipt(failed.transactionId as string);
    expect(parsed[0]?.failureDetail).toEqual({ type: "expired", validUntil: 16n, blockTimestamp: 17n });
    (failed.failureDetail as Record<string, unknown>).type = "notYetValid";
    await expect(new PcashNodeClient("http://n", stub([failed])).getReceipt(failed.transactionId as string)).rejects.toThrow(/must equal outcome expired/);
  });

  it("decodes a carrier context mismatch with the required and delivered hashes", async () => {
    const failed = receiptResult();
    failed.outcome = "carrierContextMismatch";
    failed.failureDetail = {
      type: "carrierContextMismatch",
      required: `0x${"5a".repeat(32)}`,
      carrier: `0x${"5b".repeat(32)}`,
    };
    const parsed = await new PcashNodeClient("http://n", stub([failed])).getReceipt(failed.transactionId as string);
    expect(parsed[0]?.failureDetail).toEqual({
      type: "carrierContextMismatch",
      required: `0x${"5a".repeat(32)}`,
      carrier: `0x${"5b".repeat(32)}`,
    });
    failed.failureDetail = null;
    await expect(new PcashNodeClient("http://n", stub([failed])).getReceipt(failed.transactionId as string))
      .rejects.toThrow(/required for outcome carrierContextMismatch/);
  });

  it("getReceipt() decodes the resolved issuance destination and settled components", async () => {
    const open = receiptResult();
    const unregistered = receiptResult();
    unregistered.kind = "userAccountCreation";
    unregistered.issuanceOwnerCommitment = null;
    unregistered.settledOpenFeeAmount = "0x0";
    unregistered.settledIssuanceAmount = "0x0";
    const parsed = await new PcashNodeClient("http://n", stub([open, unregistered])).getReceipt(open.transactionId as string);
    expect(parsed.map((receipt) => [receipt.issuanceOwnerCommitment, receipt.settledOpenFeeAmount, receipt.settledIssuanceAmount]))
      .toEqual([[`0x${"48".repeat(32)}`, 2n, 100n], [null, 0n, 0n]]);
    delete open.settledIssuanceAmount;
    await expect(new PcashNodeClient("http://n", stub([open])).getReceipt(open.transactionId as string)).rejects.toThrow(/settledIssuanceAmount/);
  });

  it("decodes unfunded contract creation receipts, summaries, and mempool entries", async () => {
    const receipt: Record<string, unknown> = {
      ...receiptResult(),
      kind: "contractAccount",
      fundingMode: "unfunded",
      issuanceOwnerCommitment: null,
      settledOpenFeeAmount: "0x0",
      settledIssuanceAmount: "0x0",
      outputLeafStart: null,
      outputsAdded: "0x0",
      nullifiers: null,
    };
    const parsed = await new PcashNodeClient("http://n", stub([receipt])).getReceipt(receipt.transactionId as string);
    expect(parsed[0]).toMatchObject({ kind: "contractAccount", fundingMode: "unfunded", settledOpenFeeAmount: 0n, settledIssuanceAmount: 0n, outputsAdded: 0n, nullifiers: null });
    const page = { ...mempoolPageResult(), items: [{ ...mempoolItemResult(), kind: "contractAccount", fundingMode: "unfunded", validUntil: "0x10" }] };
    const mempool = await new PcashNodeClient("http://n", stub(page)).getMempool();
    expect(mempool.items[0]).toMatchObject({ kind: "contractAccount", fundingMode: "unfunded", openFeeAmount: 0n, issuanceRoute: "none", validUntil: 16n });
    const summary = { ...transactionSummaryResult(), kind: "contractAccount", fundingMode: "unfunded", declaredOpenFeeAmount: null, declaredIssuanceOwnerCommitment: null, issuanceRoute: "none", outputsAdded: "0x0", nullifiers: null };
    const summaries = await new PcashNodeClient("http://n", stub({ items: [summary], nextCursor: null, head: explorerCursorResult().head })).getTransactions();
    expect(summaries.items[0]).toMatchObject({ kind: "contractAccount", fundingMode: "unfunded", declaredOpenFeeAmount: null, declaredIssuanceOwnerCommitment: null, issuanceRoute: "none" });
  });

  it("requires an explicit funding mode from the known set", async () => {
    const sponsored: Record<string, unknown> = { ...receiptResult(), kind: "contractAccount", fundingMode: "sponsored" };
    expect((await new PcashNodeClient("http://n", stub([sponsored])).getReceipt(sponsored.transactionId as string))[0]?.fundingMode).toBe("sponsored");
    const unknown: Record<string, unknown> = { ...receiptResult(), kind: "contractAccount", fundingMode: "paid" };
    await expect(new PcashNodeClient("http://n", stub([unknown])).getReceipt(unknown.transactionId as string)).rejects.toThrow(/fundingMode must be one of/);
    const missing = receiptResult();
    delete missing.fundingMode;
    await expect(new PcashNodeClient("http://n", stub([missing])).getReceipt(missing.transactionId as string)).rejects.toThrow(/fundingMode is required/);
    const page = { ...mempoolPageResult(), items: [{ ...mempoolItemResult(), fundingMode: undefined }] };
    await expect(new PcashNodeClient("http://n", stub(page)).getMempool()).rejects.toThrow(/fundingMode is required/);
  });

  it("getReceipt() decodes failure details and detail-free failures", async () => {
    const zeroInput = receiptResult();
    zeroInput.outcome = "zeroNullifier";
    zeroInput.failureDetail = { type: "zeroNullifier", inputSlot: "0x4" };
    const rejected = receiptResult();
    rejected.outcome = "proofRejected";
    rejected.failureDetail = null;
    const parsed = await new PcashNodeClient("http://n", stub([zeroInput, rejected]))
      .getReceipt(zeroInput.transactionId as string);

    expect(parsed.map((receipt) => [receipt.outcome, receipt.failureDetail])).toEqual([
      ["zeroNullifier", { type: "zeroNullifier", inputSlot: 4n }],
      ["proofRejected", null],
    ]);
  });

  it.each([
    ["outputLeafStart", (response: any) => { delete response.outputLeafStart; }],
    ["nullifiers", (response: any) => { delete response.nullifiers; }],
    ["account", (response: any) => { delete response.account; }],
  ])("getReceipt() rejects a missing nullable %s", async (_label, mutate) => {
    const response = receiptResult();
    mutate(response);
    await expect(new PcashNodeClient("http://n", stub([response])).getReceipt(response.transactionId as string)).rejects.toThrow();
  });

  it("submitRawTransaction() passes exact bytes and decodes the admission result", async () => {
    const cap: Captured[] = [];
    const admission = {
      contentHash: `0x${"11".repeat(32)}`,
      statementId: `0x${"12".repeat(32)}`,
      stableId: `0x${"13".repeat(32)}`,
      status: "ready",
      headCheckedBlock: "0x10",
      headCheckedBlockHash: `0x${"ab".repeat(32)}`,
    };
    const client = new PcashNodeClient("http://n", stub(admission, cap));

    const result = await client.submitRawTransaction("0xdeadbeef");
    expect(cap[0]!.body).toMatchObject({
      method: "pcash_submitRawTransaction",
      params: ["0xdeadbeef"],
    });
    expect(result.contentHash).toBe(admission.contentHash);
    expect(result.headCheckedBlock).toBe(16n);
  });

  it("checkRawTransaction() sends exact bytes with each carrier form and decodes the check", async () => {
    const cap: Captured[] = [];
    const router = `0x${"7a".repeat(20)}`;
    const client = new PcashNodeClient("http://n", stub({ outcome: "succeeded" }, cap));
    const transaction = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);

    expect(await client.checkRawTransaction(transaction, { kind: "event", address: router, context: new Uint8Array([1, 2]) }))
      .toEqual({ outcome: "succeeded" });
    await client.checkRawTransaction(transaction, { kind: "event", address: router, context: new Uint8Array() });
    await client.checkRawTransaction(transaction, { kind: "inbox", address: router });
    expect(cap.map((call) => call.body.method)).toEqual(Array(3).fill("pcash_checkRawTransaction"));
    expect(cap.map((call) => call.body.params)).toEqual([
      [{ transaction: "0xdeadbeef", carrier: { kind: "event", address: router, context: "0x0102" } }],
      [{ transaction: "0xdeadbeef", carrier: { kind: "event", address: router, context: "0x" } }],
      [{ transaction: "0xdeadbeef", carrier: { kind: "inbox", address: router } }],
    ]);
  });

  const checkCarrier = { kind: "inbox", address: `0x${"7a".repeat(20)}` } as const;

  it.each([
    [{ outcome: "succeeded" }],
    [{ outcome: "proofRejected" }],
    [{ outcome: "directModeOutsideInbox" }],
  ])("checkRawTransaction() decodes %j", async (response) => {
    const client = new PcashNodeClient("http://n", stub(response));
    expect(await client.checkRawTransaction(new Uint8Array([1]), checkCarrier)).toEqual(response);
  });

  it.each([
    ["an unknown outcome", { outcome: "admitted" }],
    ["a numeric outcome", { outcome: 0 }],
    ["a missing outcome", {}],
  ])("checkRawTransaction() rejects a response with %s", async (_label, response) => {
    const client = new PcashNodeClient("http://n", stub(response));
    await expect(client.checkRawTransaction(new Uint8Array([1]), checkCarrier)).rejects.toThrow();
  });

  it("getMempool() quantity-encodes the query and decodes explicit nullable fields", async () => {
    const cap: Captured[] = [];
    const client = new PcashNodeClient("http://n", stub(mempoolPageResult(), cap));

    const relayerAddress = `0x${"99".repeat(20)}`;
    const page = await client.getMempool({
      cursor: "next",
      limit: 50,
      kind: "privateValue",
      minOpenFee: 100n,
      status: "ready",
      controlledIssuanceOwnerCommitments: [relayerAddress],
      sort: "feeDensity",
      arena: { schema: "0xdce9a228", data: [{ offset: 33, bytes: "0xabcd" }] },
    });
    expect(cap[0]!.body).toMatchObject({
      method: "pcash_getMempool",
      params: [{
        cursor: "next",
        limit: "0x32",
        kind: "privateValue",
        minOpenFee: "0x64",
        status: "ready",
        controlledIssuanceOwnerCommitments: [relayerAddress],
        sort: "feeDensity",
        arena: { schema: "0xdce9a228", data: [{ offset: "0x21", bytes: "0xabcd" }] },
      }],
    });
    expect(page.items[0]!.publicRecords).toEqual([{ schema: "0xdce9a228", data: new Uint8Array([1, 2]) }]);
    expect(page.items[0]!.recentPcashBlockHash).toBe(`0x${"ff".repeat(32)}`);
    expect(page.items[0]!.issuanceRoute).toBe("none");
    expect(page.items[0]!.validUntil).toBeNull();
    expect(page.nextCursor).toBeNull();
    expect(page.peerCount).toBeNull();
    expect(page.headCheckedBlock).toBe(32n);
    expect(page.items[0]!.receivedAtUnixMs).toBe(0x6553f000n);
    expect(page.items[0]!.headCheckedBlock).toBe(32n);
  });

  it.each([
    ["validUntil", (response: any) => { delete response.items[0].validUntil; }],
    ["validUntil type", (response: any) => { response.items[0].validUntil = false; }],
    ["publicRecords", (response: any) => { delete response.items[0].publicRecords; }],
    ["recentPcashBlockHash", (response: any) => { delete response.items[0].recentPcashBlockHash; }],
    ["rawTransaction", (response: any) => { delete response.items[0].rawTransaction; }],
    ["rawTransaction type", (response: any) => { response.items[0].rawTransaction = false; }],
    ["nextCursor", (response: any) => { delete response.nextCursor; }],
    ["nextCursor type", (response: any) => { response.nextCursor = false; }],
    ["peerCount", (response: any) => { delete response.peerCount; }],
    ["peerCount type", (response: any) => { response.peerCount = false; }],
    ["issuanceRoute", (response: any) => { delete response.items[0].issuanceRoute; }],
    ["unknown issuanceRoute", (response: any) => { response.items[0].issuanceRoute = "unknown"; }],
    ["canonical receipt timestamp", (response: any) => {
      delete response.items[0].receivedAtUnixMs;
    }],
    ["decimal issuanceOwnerCommitment", (response: any) => {
      response.items[0].issuanceOwnerCommitment = "12345";
    }],
    ["out-of-field issuanceOwnerCommitment", (response: any) => {
      response.items[0].issuanceOwnerCommitment = `0x${BN254_SCALAR_MODULUS.toString(16)}`;
    }],
  ])("getMempool() rejects malformed %s", async (_label, mutate) => {
    const response = mempoolPageResult();
    mutate(response);
    await expect(new PcashNodeClient("http://n", stub(response)).getMempool()).rejects.toThrow();
  });

  it("getMempoolTransaction() returns null unchanged", async () => {
    const cap: Captured[] = [];
    const transactionId = `0x${"31".repeat(32)}`;
    const client = new PcashNodeClient("http://n", stub(null, cap));
    await expect(client.getMempoolTransaction(transactionId)).resolves.toBeNull();
    expect(cap[0]!.body).toMatchObject({ method: "pcash_getMempoolTransaction", params: [transactionId] });
  });

  it("getMempoolTransaction() returns the requested transaction", async () => {
    const response = mempoolItemResult();
    const contentHash = response.contentHash as string;
    const client = new PcashNodeClient("http://n", stub(response));
    await expect(client.getMempoolTransaction(contentHash)).resolves.toMatchObject({ contentHash });
  });

  it("getMempoolTransaction() rejects a result for a different content hash", async () => {
    const transactionId = `0x${"31".repeat(32)}`;
    const client = new PcashNodeClient("http://n", stub(mempoolItemResult()));
    await expect(client.getMempoolTransaction(transactionId)).rejects.toThrow("does not match the requested content");
  });

  it("prepareRelay() quantity-encodes the byte cap and decodes selection metadata", async () => {
    const cap: Captured[] = [];
    const contentHashes = [`0x${"41".repeat(32)}`, `0x${"42".repeat(32)}`];
    const client = new PcashNodeClient("http://n", stub({
      selectedTransactions: ["0x01"],
      selectedContentHashes: [contentHashes[0]],
      rejected: [{ contentHash: contentHashes[1], reason: "conflict" }],
      collectibleOpenFee: "0x64",
      collectibleQualifyingActions: "0x2",
      selectedQualifyingActions: "0x3",
      batchBytes: "0x28",
      headCheckedBlock: "0x30",
      headCheckedBlockHash: `0x${"ef".repeat(32)}`,
    }, cap));

    const controlled = [fieldToHex(7n)];
    const controlledContentHashes = [contentHashes[0]!];
    const result = await client.prepareRelay({
      contentHashes, controlledIssuanceOwnerCommitments: controlled,
      controlledIssuanceContentHashes: controlledContentHashes, maxBatchBytes: 256_000,
    });
    expect(cap[0]!.body).toEqual(expect.objectContaining({
      method: "pcash_prepareRelay",
      params: [{ contentHashes,
        controlledIssuanceOwnerCommitments: controlled, controlledIssuanceContentHashes: controlledContentHashes,
        maxBatchBytes: "0x3e800" }],
    }));
    expect(result.selectedContentHashes).toEqual([contentHashes[0]]);
    expect(result.rejected).toEqual([{ contentHash: contentHashes[1], reason: "conflict" }]);
    expect(result.collectibleOpenFee).toBe(100n);
    expect(result.collectibleQualifyingActions).toBe(2n);
    expect(result.selectedQualifyingActions).toBe(3n);
    expect(result.batchBytes).toBe(40n);
  });

  // --- note-output feed: pages of whole transactions, each arena on its slot-0 row ---
  const OUTPUT_TARGET = { pcashNumber: 2n, pcashHash: hex(bytes32(0x22)) };
  const OUTPUT_ORIGIN = { blockNumber: "0x2", blockHash: OUTPUT_TARGET.pcashHash, blockTimestamp: "0x6b49d20c" };
  const S_ARENA = Uint8Array.from({ length: PRIVATE_VALUE_PROFILES.S.arenaBytes }, (_, index) => index & 0xff);
  const L_ARENA = Uint8Array.from({ length: PRIVATE_VALUE_PROFILES.L.arenaBytes }, (_, index) => (index * 7) & 0xff);
  const L_NULLIFIERS = Array.from({ length: PRIVATE_VALUE_PROFILES.L.inputs }, (_, index) => hex(bytes32(index + 1)));

  /**
   * Every row of one transaction as the node serves it: slots in order,
   * nullifiers and the arena on slot 0 only. `shape: null` is an account
   * section (type 3), which uses the S layout.
   */
  function transactionRows(firstIndex: number, options: { shape?: 0 | 1 | null; tag?: number } = {}): any[] {
    const shape = options.shape === undefined ? 0 : options.shape;
    const large = shape === 1;
    const profile = large ? PRIVATE_VALUE_PROFILES.L : PRIVATE_VALUE_PROFILES.S;
    const tag = options.tag ?? 0x41;
    return Array.from({ length: profile.outputs }, (_, slot) => ({
      kind: "ordinary",
      outputIndex: quantity(firstIndex + slot),
      outputCommitment: fieldHex(OUTPUT_COMMITMENT + BigInt(slot)),
      outputData: hex(Uint8Array.of(0xde, 0xad, slot)),
      transactionId: hex(bytes32(tag)),
      contentHash: hex(bytes32(tag + 1)),
      transactionType: shape === null ? "0x3" : "0x0",
      privateValueShape: shape === null ? null : quantity(shape),
      outputSlot: quantity(slot),
      nullifiers: slot === 0 ? (large ? L_NULLIFIERS : S_NULLIFIERS) : [],
      ...(slot === 0 ? { arena: hex(large ? L_ARENA : S_ARENA) } : {}),
      origin: { ...OUTPUT_ORIGIN },
    }));
  }

  function systemRow(outputIndex: number): any {
    return {
      kind: "system",
      outputIndex: quantity(outputIndex),
      outputCommitment: fieldHex(OUTPUT_COMMITMENT),
      origin: { ...OUTPUT_ORIGIN },
      payout: {
        transactionId: null,
        source: { kind: "posterPayout", l1TransactionIndices: [1] },
        component: "issuance", amount: "0x5", ownerCommitment: fieldHex(9n),
        outputIndex: quantity(outputIndex), contexts: [fieldHex(4n)],
      },
    };
  }

  function outputContinuation(fromOutputIndex: number, outputCount: number, nextOutputIndex: number) {
    return {
      fromOutputIndex: quantity(fromOutputIndex),
      target: { blockNumber: "0x2", blockHash: OUTPUT_TARGET.pcashHash },
      targetOutputCount: quantity(outputCount),
      nextOutputIndex: quantity(nextOutputIndex),
    };
  }

  /** A page from `fromOutputIndex`; complete unless `next` names its continuation. */
  function outputPage(fromOutputIndex: number, outputCount: number, outputs: any[], next?: number): any {
    return {
      fromOutputIndex: quantity(fromOutputIndex),
      target: { block: { blockNumber: "0x2", blockHash: OUTPUT_TARGET.pcashHash }, outputCount: quantity(outputCount) },
      outputs,
      continuation: next === undefined ? null : outputContinuation(fromOutputIndex, outputCount, next),
      complete: next === undefined,
    };
  }

  function readOutputs(response: unknown, fromOutputIndex = 0n, continuation?: Record<string, unknown>) {
    return new PcashNodeClient("http://n", stub(response)).getOutputs({
      fromOutputIndex,
      target: OUTPUT_TARGET,
      ...(continuation === undefined ? {} : { continuation }),
    });
  }

  it("decodes a page of whole transactions with each arena on its slot-0 row", async () => {
    const captured: Captured[] = [];
    const rows = [
      ...transactionRows(0),
      ...transactionRows(5, { shape: 1, tag: 0x51 }),
      systemRow(37),
      ...transactionRows(38, { shape: null, tag: 0x61 }),
    ];
    const result = await new PcashNodeClient("http://n", stub(outputPage(0, 43, rows), captured)).getOutputs({
      fromOutputIndex: 0n,
      target: OUTPUT_TARGET,
      limits: { maxOutputs: 64, maxBytes: 65536 },
    });

    expect(captured[0]!.body.method).toBe("pcash_getOutputs");
    expect(captured[0]!.body.params).toEqual([{
      fromOutputIndex: "0x0",
      target: { blockNumber: "0x2", blockHash: OUTPUT_TARGET.pcashHash },
      limits: { maxOutputs: "0x40", maxBytes: "0x10000" },
    }]);
    expect(result.complete).toBe(true);
    expect(result.fromOutputIndex).toBe(0n);
    expect(result.target.outputCount).toBe(43n);
    expect(result.outputs.map((output) => output.outputIndex)).toEqual(Array.from({ length: 43 }, (_, index) => BigInt(index)));
    const ordinary = (index: number) => {
      const output = result.outputs[index]!;
      if (output.kind !== "ordinary") throw new Error(`expected an ordinary output at ${index}`);
      return output;
    };
    const first = ordinary(0);
    expect(first.origin).toEqual({ ...OUTPUT_TARGET, timestamp: 1_800_000_012n });
    expect(bytesEqual(first.outputData, Uint8Array.of(0xde, 0xad, 0))).toBe(true);
    expect(first.contentHash).toBe(hex(bytes32(0x42)));
    expect(first.nullifiers).toEqual(S_NULLIFIERS);
    expect(bytesEqual(first.arena!, S_ARENA)).toBe(true);
    for (const index of [1, 2, 3, 4]) {
      expect(ordinary(index)).toMatchObject({ outputSlot: index, nullifiers: [], arena: null });
    }
    const large = ordinary(5);
    expect(large.privateValueShape).toBe(1);
    expect(large.nullifiers).toEqual(L_NULLIFIERS);
    expect(bytesEqual(large.arena!, L_ARENA)).toBe(true);
    expect(ordinary(36)).toMatchObject({ outputSlot: 31, arena: null });
    expect(result.outputs[37]!.kind).toBe("system");
    const account = ordinary(38);
    expect(account).toMatchObject({ transactionType: 3, privateValueShape: null, outputSlot: 0 });
    expect(bytesEqual(account.arena!, S_ARENA)).toBe(true);
  });

  it.each([
    ["missing content hash", (rows: any[]) => { delete rows[0].contentHash; }],
    ["short content hash", (rows: any[]) => { rows[0].contentHash = hex(new Uint8Array(31)); }],
    ["missing nullifiers", (rows: any[]) => { delete rows[0].nullifiers; }],
    ["too few slot-0 nullifiers", (rows: any[]) => { rows[0].nullifiers = S_NULLIFIERS.slice(1); }],
    ["nullifiers on a later slot", (rows: any[]) => { rows[1].nullifiers = S_NULLIFIERS; }],
    ["short nullifier", (rows: any[]) => { rows[0].nullifiers = [...S_NULLIFIERS.slice(1), hex(new Uint8Array(31))]; }],
    ["missing origin timestamp", (rows: any[]) => { delete rows[0].origin.blockTimestamp; }],
    ["no slot-0 arena", (rows: any[]) => { delete rows[0].arena; }],
    ["a null slot-0 arena", (rows: any[]) => { rows[0].arena = null; }],
    ["a short slot-0 arena", (rows: any[]) => { rows[0].arena = hex(S_ARENA.subarray(1)); }],
    ["a long slot-0 arena", (rows: any[]) => { rows[0].arena = hex(Uint8Array.from([...S_ARENA, 0])); }],
    ["an L arena on an S transaction", (rows: any[]) => { rows[0].arena = hex(L_ARENA); }],
    ["an arena on a later slot", (rows: any[]) => { rows[2].arena = hex(S_ARENA); }],
  ] as [string, (rows: any[]) => void][])("rejects an ordinary output row with %s", async (_label, mutate) => {
    const rows = transactionRows(0);
    await expect(readOutputs(outputPage(0, 5, rows))).resolves.toBeDefined();
    mutate(rows);
    await expect(readOutputs(outputPage(0, 5, rows))).rejects.toThrow();
  });

  it.each([
    ["an L transaction with an S arena", () => {
      const rows = transactionRows(0, { shape: 1 });
      rows[0].arena = hex(S_ARENA);
      return rows;
    }],
    ["an account section with an L arena", () => {
      const rows = transactionRows(0, { shape: null });
      rows[0].arena = hex(L_ARENA);
      return rows;
    }],
  ] as [string, () => any[]][])("rejects %s", async (_label, rows) => {
    const page = rows();
    await expect(readOutputs(outputPage(0, page.length, page))).rejects.toThrow("output arena must be");
  });

  it("decodes a system payout output with its payout record", async () => {
    const result = await readOutputs(outputPage(0, 1, [systemRow(0)]));
    const output = result.outputs[0]!;
    if (output.kind !== "system") throw new Error("expected system output");
    expect(output.payout).toEqual({
      transactionId: null, source: { kind: "posterPayout", l1TransactionIndices: [1n] },
      component: "issuance", amount: 5n, ownerCommitment: 9n, outputIndex: 0n, contexts: [4n],
    });
  });

  it.each([
    ["a page that ends inside a transaction", () => readOutputs(outputPage(0, 10, transactionRows(0).slice(0, 3), 3))],
    ["a page that starts after a transaction's first slot", () =>
      readOutputs(outputPage(1, 10, [...transactionRows(0).slice(1), ...transactionRows(5, { tag: 0x51 })]), 1n)],
    ["a row of another transaction inside a transaction", () => {
      const rows = transactionRows(0);
      rows[3].transactionId = hex(bytes32(0x99));
      return readOutputs(outputPage(0, 5, rows));
    }],
    ["a row with another content hash inside a transaction", () => {
      const rows = transactionRows(0);
      rows[4].contentHash = hex(bytes32(0x99));
      return readOutputs(outputPage(0, 5, rows));
    }],
    ["slots out of order", () => {
      const rows = transactionRows(0);
      [rows[1].outputSlot, rows[2].outputSlot] = [rows[2].outputSlot, rows[1].outputSlot];
      return readOutputs(outputPage(0, 5, rows));
    }],
    ["a system row inside a transaction", () => {
      const rows = transactionRows(0);
      rows[2] = systemRow(2);
      return readOutputs(outputPage(0, 5, rows));
    }],
    ["a row of another shape inside a transaction", () => {
      const rows = transactionRows(0);
      rows[4].transactionType = "0x3";
      rows[4].privateValueShape = null;
      return readOutputs(outputPage(0, 5, rows));
    }],
  ] as [string, () => Promise<unknown>][])("rejects %s", async (_label, read) => {
    await expect(read()).rejects.toThrow("output page splits a transaction");
  });

  it("accepts a rewind to the first output of the transaction the request fell inside", async () => {
    const small = await readOutputs(outputPage(5, 10, transactionRows(5)), 9n);
    expect(small.fromOutputIndex).toBe(5n);
    expect(small.outputs.map((output) => output.outputIndex)).toEqual([5n, 6n, 7n, 8n, 9n]);
    const large = await readOutputs(outputPage(5, 37, transactionRows(5, { shape: 1 })), 36n);
    expect(large.fromOutputIndex).toBe(5n);
    expect(large.outputs).toHaveLength(32);
    // A request at a transaction's first output is not rewound.
    expect((await readOutputs(outputPage(5, 10, transactionRows(5)), 5n)).fromOutputIndex).toBe(5n);
  });

  it.each([
    ["a later index than requested", 5n, () => outputPage(6, 10, transactionRows(6).slice(0, 4))],
    ["a rewind as long as the transaction", 10n, () => outputPage(5, 15, [...transactionRows(5), ...transactionRows(10, { tag: 0x51 })])],
    ["a rewind to a row that is not slot 0", 8n, () => outputPage(6, 15, [...transactionRows(5).slice(1), ...transactionRows(10, { tag: 0x51 })])],
    ["a rewind onto a system row", 6n, () => outputPage(5, 11, [systemRow(5), ...transactionRows(6)])],
    ["a rewind with no rows", 3n, () => outputPage(0, 5, [])],
  ] as [string, bigint, () => unknown][])("rejects a from-index echo with %s", async (_label, requested, page) => {
    await expect(readOutputs(page(), requested)).rejects.toThrow("output from index echo mismatch");
  });

  it("rejects an incomplete page with no rows", async () => {
    await expect(readOutputs(outputPage(0, 10, [], 5))).rejects.toThrow("output page does not end at its continuation");
  });

  it.each([4, 6])("rejects a continuation at %s after a page that ends at 5", async (next) => {
    await expect(readOutputs(outputPage(0, 10, transactionRows(0), next))).rejects.toThrow("output page does not end at its continuation");
  });

  it("rejects a complete page that ends before the target count", async () => {
    await expect(readOutputs(outputPage(0, 10, transactionRows(0)))).rejects.toThrow("output page does not end at its continuation");
  });

  it("reads continuation pages from the previous page's end within one interval", async () => {
    const first = await readOutputs(outputPage(0, 15, [...transactionRows(0), systemRow(5)], 6));
    expect(first.continuation).toEqual(outputContinuation(0, 15, 6));
    const second = await readOutputs(outputPage(0, 15, transactionRows(6), 11), 0n, first.continuation!);
    expect(second.fromOutputIndex).toBe(0n);
    expect(second.outputs.map((output) => output.outputIndex)).toEqual([6n, 7n, 8n, 9n, 10n]);
    const third = await readOutputs(outputPage(0, 15, [11, 12, 13, 14].map(systemRow)), 0n, second.continuation!);
    expect(third.complete).toBe(true);
    expect(third.outputs).toHaveLength(4);
  });

  it("keeps a rewound interval start on its continuation pages", async () => {
    const first = await readOutputs(outputPage(5, 15, transactionRows(5), 10), 7n);
    expect(first.fromOutputIndex).toBe(5n);
    const second = await readOutputs(outputPage(5, 15, transactionRows(10, { tag: 0x51 })), 7n, first.continuation!);
    expect(second.fromOutputIndex).toBe(5n);
    expect(second.outputs[0]!.outputIndex).toBe(10n);
  });

  it.each([
    ["the requested index instead of the interval start", () => outputPage(7, 15, transactionRows(10, { tag: 0x51 })), "output from index echo mismatch"],
    ["rows from the interval start", () => outputPage(5, 15, transactionRows(5)), "outputs are not contiguous"],
    ["rows past the continuation index", () => outputPage(5, 20, transactionRows(15, { tag: 0x51 })), "outputs are not contiguous"],
  ] as [string, () => unknown, string][])("rejects a continuation page with %s", async (_label, page, message) => {
    const continuation = outputContinuation(5, 15, 10);
    await expect(readOutputs(page(), 7n, continuation)).rejects.toThrow(message);
  });

  it.each([
    [-32602, "invalid", "invalid derived-index request: limits are too small for one transaction"],
    [-32001, "cursorMismatch", "continuation cursor mismatch"],
  ] as const)("surfaces the node's %s output error", async (code, kind, message) => {
    const client = new PcashNodeClient("http://n", rpcFetch((body) => new Response(JSON.stringify({
      jsonrpc: "2.0", id: body.id, error: { code, message, data: { kind } },
    }))));
    const error = await client.getOutputs({ fromOutputIndex: 0n, target: OUTPUT_TARGET, limits: { maxOutputs: 1 } })
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(PcashNodeRpcError);
    expect(error).toMatchObject({ code, kind, details: message });
  });

  it.each([
    ["from index echo", (response: any) => { response.fromOutputIndex = "0x1"; }],
    ["target echo", (response: any) => { response.target.block.blockHash = hex(bytes32(0xff)); }],
    ["unordered outputs", (response: any) => { [response.outputs[0], response.outputs[1]] = [response.outputs[1], response.outputs[0]]; }],
    ["missing continuation", (response: any) => {
      response.complete = false;
      delete response.continuation;
    }],
    ["continuation after completion", (response: any) => { response.continuation = outputContinuation(0, 6, 5); }],
  ])("rejects note-output %s corruption", async (_label, mutate) => {
    const response = () => outputPage(0, 6, [...transactionRows(0), systemRow(5)]);
    await expect(readOutputs(response())).resolves.toBeDefined();
    const corrupted = response();
    mutate(corrupted);
    await expect(readOutputs(corrupted)).rejects.toThrow();
  });
});

describe("PcashNodeClient authenticated state openings", () => {
  it("verifies one note opening and a batched opening against the returned StateRoot", async () => {
    const fixture = makeFixture();
    const noteResponse = {
      outputIndex: "0x0",
      root: fieldHex(fixture.note.root),
      count: "0x1",
      siblings: fields(fixture.note.path.siblings),
      boundary: fixture.boundary,
    };
    const captured: Captured[] = [];
    const note = await new PcashNodeClient("http://n", stub(noteResponse, captured)).getOutputPath(0n, OUTPUT_COMMITMENT);
    expect(note).not.toBeNull();
    expect(captured[0]!.body.params).toEqual(["0x0"]);
    expect(note!.outputIndex).toBe(0n);
    expect(note!.count).toBe(1n);
    expect(note!.boundary.header.number).toBe(2n);

    const batchResponse = {
      root: fieldHex(fixture.note.root),
      count: "0x1",
      paths: [{ outputIndex: "0x0", siblings: fields(fixture.note.path.siblings) }],
      boundary: fixture.boundary,
    };
    const batch = await new PcashNodeClient("http://n", stub(batchResponse)).getOutputPaths([
      { outputIndex: 0n, outputCommitment: OUTPUT_COMMITMENT },
    ]);
    expect(batch).not.toBeNull();
    expect(batch!.paths).toHaveLength(1);
    expect(batch!.root).toBe(fieldHex(fixture.note.root));
  });

  it("returns decoded openings and rejects loosely typed ones", async () => {
    const fixture = makeFixture();
    const upper = (value: string) => `0x${value.slice(2).toUpperCase()}`;
    const noteResponse = {
      outputIndex: "0x0",
      root: upper(fieldHex(fixture.note.root)),
      count: "0x1",
      siblings: fields(fixture.note.path.siblings).map(upper),
      boundary: fixture.boundary,
    };
    const note = await new PcashNodeClient("http://n", stub(noteResponse)).getOutputPath(0n, OUTPUT_COMMITMENT);
    expect(note!.root).toBe(fieldHex(fixture.note.root));
    expect(note!.siblings).toEqual(fixture.note.path.siblings);

    const batch = await new PcashNodeClient("http://n", stub({
      root: noteResponse.root,
      count: "0x1",
      paths: [{ outputIndex: "0x0", siblings: noteResponse.siblings }],
      boundary: fixture.boundary,
    })).getOutputPaths([{ outputIndex: 0n, outputCommitment: OUTPUT_COMMITMENT }]);
    expect(batch!.root).toBe(fieldHex(fixture.note.root));
    expect(batch!.paths[0]!.siblings).toEqual(note!.siblings);

    const decimalRoot = { ...noteResponse, root: fixture.note.root.toString() };
    await expect(new PcashNodeClient("http://n", stub(decimalRoot)).getOutputPath(0n, OUTPUT_COMMITMENT))
      .rejects.toThrow(/0x-hex/);
    const objectSiblings = { ...noteResponse, siblings: { length: 32 } };
    await expect(new PcashNodeClient("http://n", stub(objectSiblings)).getOutputPath(0n, OUTPUT_COMMITMENT))
      .rejects.toThrow(/array/);
  });

  it("preserves absent output openings as null", async () => {
    const client = new PcashNodeClient("http://n", stub(null));
    await expect(client.getOutputPath(0n, OUTPUT_COMMITMENT)).resolves.toBeNull();
    await expect(client.getOutputPaths([{ outputIndex: 0n, outputCommitment: OUTPUT_COMMITMENT }]))
      .resolves.toBeNull();
  });

  it.each([
    ["leaf", (response: any) => { response.siblings[0] = fieldHex(1n); }],
    ["index", (response: any) => { response.outputIndex = "0x1"; }],
    ["count", (response: any) => { response.count = "0x0"; }],
    ["state component", (response: any) => { response.root = fieldHex(2n); }],
    ["StateRoot", (response: any) => { response.boundary.state.outputRoot = fieldHex(2n); }],
    ["header", (response: any) => { response.boundary.header.parentHash = hex(bytes32(0xee)); }],
    ["block hash", (response: any) => { response.boundary.blockHash = hex(bytes32(0xef)); }],
  ])("rejects a note opening with a mutated %s", async (_label, mutate) => {
    const fixture = makeFixture();
    const response: any = {
      outputIndex: "0x0",
      root: fieldHex(fixture.note.root),
      count: "0x1",
      siblings: fields(fixture.note.path.siblings),
      boundary: clone(fixture.boundary),
    };
    mutate(response);
    await expect(new PcashNodeClient("http://n", stub(response)).getOutputPath(0n, OUTPUT_COMMITMENT)).rejects.toThrow();
  });

  it("decodes the account convenience view without claiming a proof", async () => {
    const fixture = makeFixture("unavailable");
    const captured: Captured[] = [];
    const result = await new PcashNodeClient("http://n", stub(fixture.account.dto, captured)).getAccount(ADDRESS);
    expect(captured[0]!.body).toMatchObject({ method: "pcash_getAccount", params: [ADDRESS] });
    expect(result).toMatchObject({
      address: ADDRESS,
      index: 0n,
      accountRevision: 1n,
      accountKind: 0,
      receiveKeyHash: fixture.account.dto.receiveKeyHash,
      material: { status: "unavailable", lifecycle: "catchingUp" },
    });
  });

  it("rejects an account-proof envelope in place of the flat convenience view", async () => {
    const fixture = makeFixture("available");
    await expect(new PcashNodeClient("http://n", stub(fixture.accountProof)).getAccount(ADDRESS))
      .rejects.toThrow();
  });

  it.each(["notPresent", "available", "unavailable"] as const)(
    "verifies unified account state with %s material",
    async (status) => {
      const fixture = makeFixture(status);
      const result = await new PcashNodeClient("http://n", stub(fixture.accountProof)).getAccountProof(ADDRESS);
      expect(result).toMatchObject({
        status: "present",
        account: {
          address: ADDRESS,
          receiveKeyHash: fixture.account.dto.receiveKeyHash,
          material: { status },
        },
      });
    },
  );

  it("returns an explicitly unauthenticated address lookup miss", async () => {
    const response = { status: "notFound", address: ADDRESS, authenticated: false };
    await expect(new PcashNodeClient("http://n", stub(response)).getAccountProof(ADDRESS)).resolves.toEqual(response);
  });

  it.each([
    ["address", (response: any) => { response.account.address = `0x${"00".repeat(19)}ac`; }],
    ["revision", (response: any) => { response.account.accountRevision = "0x0"; }],
    ["account state commitment", (response: any) => { response.account.nullifierKeyCommitment = fieldHex(45n); }],
    ["account path", (response: any) => { response.accountSiblings[0] = fieldHex(1n); }],
    ["receive-key digest", (response: any) => { response.account.receiveKeyHash = hex(bytes32(0x01)); }],
    // The leaf commits keccak(key) mod p; a full-width word with the same residue is not that value.
    ["full-width receive-key digest", (response: any) => {
      response.account.receiveKeyHash = fullWidthAlias(response.account.receiveKeyHash);
    }],
    ["shared count", (response: any) => { response.accountCount = "0x0"; }],
    ["state-root header path", (response: any) => { response.stateRootHeaderSiblings[0] = fieldHex(1n); }],
    ["account-state-root state path", (response: any) => { response.accountStateRootStateSiblings[0] = fieldHex(2n); }],
  ])("rejects a unified account proof with a mutated %s", async (_label, mutate) => {
    const response = clone(makeFixture("available").accountProof) as any;
    mutate(response);
    await expect(new PcashNodeClient("http://n", stub(response)).getAccountProof(ADDRESS)).rejects.toThrow();
  });

  it("rejects every material/presence mismatch and bad available preimage", async () => {
    const cleared = clone(makeFixture("notPresent").accountProof) as any;
    cleared.account.material = { status: "unavailable", lifecycle: "Ready" };
    await expect(new PcashNodeClient("http://n", stub(cleared)).getAccountProof(ADDRESS)).rejects.toThrow();

    const present = clone(makeFixture("available").accountProof) as any;
    present.account.material = { status: "notPresent" };
    await expect(new PcashNodeClient("http://n", stub(present)).getAccountProof(ADDRESS)).rejects.toThrow();

    const wrongLength = clone(makeFixture("available").accountProof) as any;
    wrongLength.account.material.mlKem768PublicKey = "0x01";
    await expect(new PcashNodeClient("http://n", stub(wrongLength)).getAccountProof(ADDRESS)).rejects.toThrow();

    const wrongDigest = clone(makeFixture("available").accountProof) as any;
    wrongDigest.account.material.mlKem768PublicKey = `0x${"00".repeat(1184)}`;
    await expect(new PcashNodeClient("http://n", stub(wrongDigest)).getAccountProof(ADDRESS)).rejects.toThrow();
  });

  it("verifies nullifier absence, membership, order, and duplicates", async () => {
    const empty = makeFixture("notPresent", false);
    const absent = await new PcashNodeClient("http://n", stub(empty.nullifierProofs)).getCurrentNullifierStatuses([NULLIFIER]);
    expect(absent.statuses).toEqual([{ nullifier: NULLIFIER, spent: false }]);

    const spent = makeFixture("notPresent", true);
    const duplicateResponse = clone(spent.nullifierProofs) as any;
    duplicateResponse.proofs.push(clone(duplicateResponse.proofs[0]));
    const present = await new PcashNodeClient("http://n", stub(duplicateResponse)).getCurrentNullifierStatuses([
      NULLIFIER,
      NULLIFIER,
    ]);
    expect(present.statuses).toEqual([
      { nullifier: NULLIFIER, spent: true },
      { nullifier: NULLIFIER, spent: true },
    ]);
  });

  it.each([
    ["root", (response: any) => { response.nullifierRoot = hex(bytes32(0xff)); }],
    ["full-width root", (response: any) => { response.nullifierRoot = fullWidthAlias(response.nullifierRoot); }],
    ["echo", (response: any) => { response.proofs[0].nullifier = `0x${"00".repeat(31)}02`; }],
    ["leaf next value", (response: any) => { response.proofs[0].leaf.nextValue = fieldHex(6n); }],
    ["leaf next index", (response: any) => { response.proofs[0].leaf.nextIndex = "0x0"; }],
    ["leaf index", (response: any) => { response.proofs[0].leafIndex = "0x1"; }],
    ["leaf index beyond the tree", (response: any) => { response.proofs[0].leafIndex = quantity(1n << 41n); }],
    ["sibling", (response: any) => { response.proofs[0].siblings[0] = fieldHex(1n); }],
    ["full-width sibling", (response: any) => {
      response.proofs[0].siblings[0] = fullWidthAlias(response.proofs[0].siblings[0]);
    }],
    ["path depth", (response: any) => { response.proofs[0].siblings.pop(); }],
  ])("rejects nullifier proof corruption in the %s", async (_label, mutate) => {
    const response = clone(makeFixture().nullifierProofs) as any;
    mutate(response);
    await expect(new PcashNodeClient("http://n", stub(response)).getCurrentNullifierStatuses([NULLIFIER])).rejects.toThrow();
  });

  it("rejects an opening leaf that neither holds nor brackets the nullifier, and a stale low leaf", async () => {
    const fixture = makeFixture("notPresent", true);
    // The leaf holding 9 opens under the root but says nothing about 5.
    const unrelated = clone(fixture.nullifierProofs) as any;
    unrelated.proofs = [{ ...nullifierProofRpc(fixture.nullifiers.proof(9n)), nullifier: NULLIFIER }];
    await expect(new PcashNodeClient("http://n", stub(unrelated)).getCurrentNullifierStatuses([NULLIFIER]))
      .rejects.toThrow("nullifier proof mismatch");
    // The low leaf from before the nullifier was inserted claims it is absent.
    const stale = clone(fixture.nullifierProofs) as any;
    stale.proofs = clone(makeFixture("notPresent", false).nullifierProofs).proofs;
    await expect(new PcashNodeClient("http://n", stub(stale)).getCurrentNullifierStatuses([NULLIFIER]))
      .rejects.toThrow("nullifier proof mismatch");
  });

  it("rejects noncanonical or oversized nullifier requests without using the network", async () => {
    let calls = 0;
    const client = new PcashNodeClient("http://n", rpcFetch(() => {
      calls += 1;
      throw new Error("network must not be used");
    }));
    await expect(client.getCurrentNullifierStatuses([])).resolves.toEqual({ statuses: [], boundary: null });
    await expect(client.getCurrentNullifierStatuses([`0x${"00".repeat(32)}`])).rejects.toThrow("nonzero canonical");
    await expect(client.getCurrentNullifierStatuses([`0x${BN254_SCALAR_MODULUS.toString(16).padStart(64, "0")}`])).rejects.toThrow("nonzero canonical");
    await expect(client.getCurrentNullifierStatuses(Array.from({ length: 257 }, () => NULLIFIER))).rejects.toThrow("256");
    await expect(client.areNullifiersSpent(Array.from({ length: 257 }, () => NULLIFIER))).rejects.toThrow("256");
    expect(calls).toBe(0);
  });
});

describe("PcashNodeClient errors", () => {
  it("rejects a successful JSON-RPC envelope with no result", async () => {
    const missingResult = rpcFetch((body) => new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id })));
    await expect(new PcashNodeClient("http://n", missingResult).status()).rejects.toThrow("result is required");
  });

  it("surfaces a JSON-RPC error object as a typed error", async () => {
    const errFetch = rpcFetch((body) => new Response(JSON.stringify({
      jsonrpc: "2.0", id: body.id, error: { code: -32000, message: "queue full", data: { kind: "queueFull" } },
    }), { status: 400 }));
    const error = await new PcashNodeClient("http://n", errFetch).status().catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(PcashNodeRpcError);
    expect(error).toMatchObject({
      name: "PcashNodeRpcError",
      code: -32000,
      kind: "queueFull",
      details: "queue full",
      message: "node RPC error -32000 (queueFull): queue full",
    });
  });

  it("throws on non-2xx HTTP", async () => {
    const httpErr = rpcFetch(() => new Response("down", { status: 503 }));
    await expect(new PcashNodeClient("http://n", httpErr).status()).rejects.toMatchObject({ status: 503 });
  });

  it("throws for a body that is not JSON", async () => {
    const html = rpcFetch(() => new Response("<html>proxy</html>"));
    await expect(new PcashNodeClient("http://n", html).status()).rejects.toBeInstanceOf(HttpRequestError);
  });

  it("stops reading a reply longer than the listener's limit", async () => {
    const chunk = new Uint8Array(1024 * 1024);
    let sent = 0;
    const endless = rpcFetch(() => new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += chunk.length;
        controller.enqueue(chunk);
      },
    })));
    const error = await new PcashNodeClient("http://n", endless).status().catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(BaseError);
    expect((error as BaseError).walk((cause) => cause instanceof ResponseBodyTooLargeError))
      .toBeInstanceOf(ResponseBodyTooLargeError);
    expect(sent).toBeLessThanOrEqual(MAX_RPC_RESPONSE_BODY_BYTES + 2 * chunk.length);
  });

  it("bounds every request with an abort signal", async () => {
    const hung = rpcFetch((_body, _url, init) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
    }));
    await expect(new PcashNodeClient("http://n", { ...hung, timeoutMs: 10 }).status())
      .rejects.toMatchObject({ name: "TimeoutError" });
    expect(() => new PcashNodeClient("http://n", { timeoutMs: 0 })).toThrow(/timeoutMs/);
  });
});


describe("atomic witness snapshots", () => {
  function snapshotFixture() {
    const fixture = makeFixture();
    const response = {
      status: { ...statusResult(), latestBlock: "0x2", latestBlockHash: fixture.boundary.blockHash },
      blockHeader: fixture.header.dto,
      block: { number: fixture.block.number, hash: fixture.block.hash,
        l1Origin: { blockNumber: (fixture.block.l1Origin as Record<string, unknown>).blockNumber,
          blockHash: (fixture.block.l1Origin as Record<string, unknown>).blockHash } },
      accounts: [fixture.accountProof],
      contracts: [],
            outputs: { root: fieldHex(fixture.note.root), count: "0x1",
        paths: [{ outputIndex: "0x0", siblings: fields(fixture.note.path.siblings) }], boundary: fixture.boundary },
      nullifiers: fixture.nullifierProofs,
      l1Logs: [{ ...fixture.ethereum.dto, logLeafIndex: "0x0", logSiblings: fields(fixture.ethereum.log.siblings),
        transactionIndex: quantity(fixture.ethereum.log.transactionIndex), logIndex: quantity(fixture.ethereum.log.logIndex) }],
    };
    const query = { accounts: [ADDRESS], outputs: [{ outputIndex: 0n, outputCommitment: OUTPUT_COMMITMENT }],
      nullifiers: [NULLIFIER], l1Logs: [{ l1BlockNumber: 101n, transactionIndex: 2n, logIndex: 1n, expectedLog: fixture.ethereum.log }] };
    return { fixture, response, query };
  }

  it("authenticates all openings with one request even when the tip advances after the response", async () => {
    const { response, query } = snapshotFixture();
    let tip = 2;
    const calls: Captured[] = [];
    const fetch = rpcFetch((body, url) => {
      calls.push({ url, body });
      if (body.method !== "pcash_getWitnessSnapshot") throw new Error("unexpected later head read");
      tip++;
      return rpcResult(body, response);
    });
    const snapshot = await new PcashNodeClient("http://n", fetch).getWitnessSnapshot(query);
    expect(tip).toBe(3);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body.params).toEqual([{ accounts: [ADDRESS], contracts: [], outputs: ["0x0"],
      nullifiers: [NULLIFIER], l1Logs: [{ l1BlockNumber: "0x65", transactionIndex: "0x2", logIndex: "0x1" }] }]);
    expect(snapshot.status.latestBlock).toBe(2n);
    expect(snapshot.accounts[0]!.status).toBe("present");
    expect(snapshot.outputs!.paths[0]!.outputIndex).toBe(0n);
    expect(snapshot.nullifiers.statuses[0]!.spent).toBe(false);
    expect(snapshot.l1Logs[0]!.transactionIndex).toBe(2n);
  });

  it.each([
    ["output proof", (r: any) => { r.outputs.paths[0].siblings[0] = fieldHex(1n); }],
    ["account proof", (r: any) => { r.accounts[0].accountSiblings[0] = fieldHex(1n); }],
    ["nullifier proof", (r: any) => { r.nullifiers.proofs[0].siblings[0] = fieldHex(1n); }],
    ["L1 log proof", (r: any) => { r.l1Logs[0].logSiblings[0] = fieldHex(1n); }],
    ["selected head", (r: any) => { r.status.latestBlock = "0x3"; }],
    ["response cardinality", (r: any) => { r.accounts = []; }],
    ["block origin", (r: any) => { delete r.block.l1Origin.blockHash; }],
    ["block identity", (r: any) => { r.block.number = "0x3"; }],
  ])("rejects malformed %s from the RPC peer", async (_name, mutate) => {
    const { response, query } = snapshotFixture();
    mutate(response);
    await expect(new PcashNodeClient("http://n", stub(response)).getWitnessSnapshot(query)).rejects.toThrow();
  });

});

describe("output frontier", () => {
  const target = { pcashNumber: 7n, pcashHash: hex(bytes32(0x77)) };

  function frontierResponse(leaves: number) {
    const tree = new OutputWitnessTree();
    for (let leaf = 1; leaf <= leaves; leaf++) tree.append(BigInt(leaf));
    return {
      block: { blockNumber: "0x7", blockHash: target.pcashHash },
      outputCount: quantity(tree.count),
      outputRoot: fieldHex(tree.root()),
      ommers: fields(tree.frontier().ommers),
    };
  }

  it("decodes the frontier committed by the target block", async () => {
    const captured: Captured[] = [];
    const response = frontierResponse(5);
    const result = await new PcashNodeClient("http://n", stub(response, captured)).getOutputFrontier(target);
    expect(captured[0]!.body.method).toBe("pcash_getOutputFrontier");
    expect(captured[0]!.body.params).toEqual([{ blockNumber: "0x7", blockHash: target.pcashHash }]);
    expect(result.target).toEqual(target);
    expect(result.outputCount).toBe(5n);
    expect(result.frontier.count).toBe(5n);
    expect(result.frontier.ommers).toHaveLength(2);
    expect(outputFrontierRoot(result.frontier)).toBe(result.outputRoot);
  });

  it("decodes an empty frontier", async () => {
    const result = await new PcashNodeClient("http://n", stub(frontierResponse(0))).getOutputFrontier(target);
    expect(result.frontier).toEqual({ count: 0n, ommers: [] });
    expect(outputFrontierRoot(result.frontier)).toBe(result.outputRoot);
  });

  it.each([
    ["block echo", (response: any) => { response.block.blockHash = hex(bytes32(0x78)); }],
    ["missing ommer", (response: any) => { response.ommers.pop(); }],
    ["extra ommer", (response: any) => { response.ommers.push(fieldHex(1n)); }],
    ["count above capacity", (response: any) => {
      response.outputCount = quantity((1n << 41n) + 5n);
      response.ommers.push(fieldHex(1n));
    }],
    ["non-field ommer", (response: any) => { response.ommers[0] = hex(new Uint8Array(32).fill(0xff)); }],
  ])("rejects a frontier with a bad %s", async (_label, mutate) => {
    const response: any = frontierResponse(5);
    mutate(response);
    await expect(new PcashNodeClient("http://n", stub(response)).getOutputFrontier(target)).rejects.toThrow();
  });
});

describe("account changes", () => {
  const target = { pcashNumber: 9n, pcashHash: hex(bytes32(0x99)) };
  const receiveKey = Uint8Array.from({ length: 1184 }, (_, index) => index % 251);

  function change(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      origin: { blockNumber: "0x3", blockHash: hex(bytes32(0x33)) },
      accountIndex: "0x0",
      address: ADDRESS,
      nullifierKeyCommitment: fieldHex(ACCOUNT_P),
      accountRuleSetCommitment: fieldHex(ACCOUNT_RULE_SET),
      accountKind: "0x0",
      accountRevision: "0x1",
      receiveKeyHash: fieldHex(protocolReceiveKeyHash(receiveKey)),
      receiveKey: hex(receiveKey),
      ...overrides,
    };
  }

  function page(overrides: Record<string, unknown> = {}): any {
    return {
      fromBlock: "0x2",
      target: { block: { blockNumber: "0x9", blockHash: target.pcashHash }, accountCount: "0x2" },
      changes: [
        change(),
        change({
          origin: { blockNumber: "0x5", blockHash: hex(bytes32(0x55)) },
          accountRevision: "0x2",
          receiveKey: null,
        }),
      ],
      continuation: null,
      complete: true,
      ...overrides,
    };
  }

  function continuation(nextBlock: string, nextOrdinal: string): Record<string, unknown> {
    return {
      fromBlock: "0x2",
      target: { blockNumber: "0x9", blockHash: target.pcashHash },
      nextBlock,
      nextOrdinal,
    };
  }

  it("decodes a page of account writes", async () => {
    const captured: Captured[] = [];
    const result = await new PcashNodeClient("http://n", stub(page(), captured)).getAccountChanges({
      fromBlock: 2n,
      target,
      limits: { maxChanges: 10, maxBytes: 4096 },
    });
    expect(captured[0]!.body.method).toBe("pcash_getAccountChanges");
    expect(captured[0]!.body.params).toEqual([{
      fromBlock: "0x2",
      target: { blockNumber: "0x9", blockHash: target.pcashHash },
      limits: { maxChanges: "0xa", maxBytes: "0x1000" },
    }]);
    expect(result.fromBlock).toBe(2n);
    expect(result.target).toEqual({ ...target, accountCount: 2n });
    expect(result.complete).toBe(true);
    expect(result.continuation).toBeNull();
    const [created, updated] = result.changes;
    expect(created).toEqual({
      origin: { pcashNumber: 3n, pcashHash: hex(bytes32(0x33)) },
      accountIndex: 0n,
      address: ADDRESS,
      nullifierKeyCommitment: ACCOUNT_P,
      accountRuleSetCommitment: ACCOUNT_RULE_SET,
      accountKind: 0,
      accountRevision: 1,
      receiveKeyHash: fieldHex(protocolReceiveKeyHash(receiveKey)),
      receiveKey,
    });
    expect(updated!.accountRevision).toBe(2);
    expect(updated!.receiveKey).toBeNull();
  });

  it("passes an incomplete page's continuation back unchanged", async () => {
    const next = continuation("0x5", "0x1");
    const captured: Captured[] = [];
    const client = new PcashNodeClient("http://n", stub(page({ continuation: next, complete: false }), captured));
    const first = await client.getAccountChanges({ fromBlock: 2n, target });
    expect(first.complete).toBe(false);
    expect(first.continuation).toEqual(next);
    await client.getAccountChanges({ fromBlock: 2n, target, continuation: first.continuation });
    expect((captured[1]!.body.params[0] as Record<string, unknown>).continuation).toEqual(next);
  });

  it.each([
    ["from block echo", (response: any) => { response.fromBlock = "0x3"; }],
    ["target echo", (response: any) => { response.target.block.blockHash = hex(bytes32(0x98)); }],
    ["receive key length", (response: any) => {
      const short = receiveKey.slice(1);
      response.changes[0].receiveKey = hex(short);
      response.changes[0].receiveKeyHash = fieldHex(protocolReceiveKeyHash(short));
    }],
    ["full-width receive key digest", (response: any) => {
      response.changes[0].receiveKeyHash = fullWidthAlias(response.changes[0].receiveKeyHash);
    }],
    ["address width", (response: any) => { response.changes[0].address = hex(bytes32(0xab)); }],
    ["account kind", (response: any) => { response.changes[0].accountKind = "0x2"; }],
    ["zero revision", (response: any) => { response.changes[0].accountRevision = "0x0"; }],
    ["revision above u32", (response: any) => { response.changes[0].accountRevision = quantity(1n << 32n); }],
    ["origin before the interval", (response: any) => { response.changes[0].origin.blockNumber = "0x1"; }],
    ["origin past the target", (response: any) => { response.changes[1].origin.blockNumber = "0xa"; }],
    ["descending origins", (response: any) => { response.changes[1].origin.blockNumber = "0x2"; }],
    ["index past the account count", (response: any) => { response.changes[1].accountIndex = "0x2"; }],
    ["missing continuation", (response: any) => {
      response.complete = false;
      delete response.continuation;
    }],
    ["incomplete page without continuation", (response: any) => { response.complete = false; }],
    ["continuation after completion", (response: any) => { response.continuation = continuation("0x5", "0x0"); }],
    ["continuation that does not advance", (response: any) => {
      response.complete = false;
      response.continuation = continuation("0x2", "0x0");
    }],
    ["continuation past the target", (response: any) => {
      response.complete = false;
      response.continuation = continuation("0xa", "0x1");
    }],
    ["continuation with an extra key", (response: any) => {
      response.complete = false;
      response.continuation = { ...continuation("0x5", "0x0"), extra: "0x0" };
    }],
    ["continuation for another interval", (response: any) => {
      response.complete = false;
      response.continuation = { ...continuation("0x5", "0x0"), fromBlock: "0x1" };
    }],
  ])("rejects an account change page with %s", async (_label, mutate) => {
    const response = page();
    mutate(response);
    await expect(new PcashNodeClient("http://n", stub(response)).getAccountChanges({ fromBlock: 2n, target }))
      .rejects.toThrow();
  });
});
