import issuanceVectors from "../../../vectors/issuance.json" with { type: "json" };
import { createServer } from "node:http";
import { encodeAbiParameters } from "viem";
import { computeBlockHash, deliveryCommitment, encodePrivateValueTransaction, randomArena, WIRE_PROOF_BYTES, sizeClassFiller, genesisParentHash, encodeBatchForVersion, transactionId, transactionResultsRoot, stateRoot } from "@pcash/sdk/protocol";
import { SparseMerkleTree } from "@pcash/sdk/crypto";
import { MERKLE_DEPTH, PRIVATE_VALUE_PROFILES } from "@pcash/sdk/constants";
import { bytes32FromHex, fromHex, keccak256, toHex } from "@pcash/sdk/utils";
import { nullifierProofRpc, nullifierTreeFixture } from "@pcash/test-support/protocol-fixtures";
import { FIXED_ACCOUNT } from "./injected_provider.mjs";

const repeatedWord = (byte) => `0x${byte.repeat(32)}`;
const zeroWord = repeatedWord("00");
const emptyRoot = new SparseMerkleTree(MERKLE_DEPTH).root;
const emptyNullifiers = nullifierTreeFixture();
const emptyState = { outputRoot: emptyRoot, outputCount: 0n, issuedSoFar: 0n, lagQ: 0n,
  accountStateRoot: emptyRoot, accountCount: 0n, nullifierRoot: emptyNullifiers.root, nullifierCount: emptyNullifiers.count };
const EMPTY_STATE_ROOT = `0x${stateRoot(emptyState).toString(16).padStart(64, "0")}`;
const fieldWord = (value) => `0x${value.toString(16).padStart(64, "0")}`;
const EMPTY_ENTRY_RESULTS_ROOT = fieldWord(transactionResultsRoot([], []));
export const TEST_RELAY_L1_HASH = `0x${"cd".repeat(32)}`;
const relayProfile = PRIVATE_VALUE_PROFILES.S;
const relayOutputData = Array.from({ length: relayProfile.outputs }, () => sizeClassFiller());
const relayArena = randomArena(relayProfile.shapeId);
const relayNullifiers = Array.from({ length: relayProfile.inputs }, (_, index) => BigInt(index + 1));
export const TEST_RELAY_RAW = toHex(encodePrivateValueTransaction({
  shape: relayProfile.shapeId,
  publicInputs: [0x50435348n, 9n, ...relayNullifiers,
    ...Array.from({ length: relayProfile.outputs }, (_, index) => BigInt(100 + index)),
    deliveryCommitment(relayOutputData, relayArena), 10n ** 18n, 0n, 0n, 2_000_000_000n, 0n, 0n, 0n],
  proof: new Uint8Array(WIRE_PROOF_BYTES).fill(1), outputData: relayOutputData, arena: relayArena,
}));
export const TEST_RELAY_CONTENT_HASH = toHex(keccak256(fromHex(TEST_RELAY_RAW)));
const TEST_RELAY_ENTRIES = [fromHex(TEST_RELAY_RAW)];
const TEST_RELAY_BATCH_BYTES = encodeBatchForVersion(TEST_RELAY_ENTRIES, 1, 1n, 0n);
export const TEST_RELAY_BATCH = toHex(TEST_RELAY_BATCH_BYTES);
export const TEST_RELAY_CONFLICT_CONTENT_HASH = toHex(keccak256(Uint8Array.from([6, 7, 8])));
export const TEST_RELAY_OVERSIZED_CONTENT_HASH = repeatedWord("fa");

function clone(value) {
  return structuredClone(value);
}

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function block({ number, parentHash, timestamp, l1BlockNumber, l1BlockHash }) {
  const result = {
    number: `0x${number.toString(16)}`,
    parentHash,
    timestamp: `0x${timestamp.toString(16)}`,
    transactionResultsRoot: EMPTY_ENTRY_RESULTS_ROOT,
    stateRoot: EMPTY_STATE_ROOT,
    l1OriginRoot: zeroWord,
    historyRoot: zeroWord,
    transactionResultCount: "0x0",
    transactionResults: [],
    transactionBytes: null,
    l1Origin: {
      blockNumber: `0x${l1BlockNumber.toString(16)}`,
      blockHash: l1BlockHash,
      blockTimestamp: `0x${timestamp.toString(16)}`,
      l1LogsRoot: zeroWord,
      l1LogCount: "0x0",
    },
  };
  return {
    ...result,
    hash: fieldWord(computeBlockHash({
      parentHash: BigInt(result.parentHash),
      number: BigInt(result.number),
      timestamp: BigInt(result.timestamp),
      transactionResultsRoot: BigInt(result.transactionResultsRoot),
      stateRoot: BigInt(result.stateRoot),
      l1OriginRoot: BigInt(result.l1OriginRoot),
      historyRoot: BigInt(result.historyRoot),
    })),
  };
}

export const TEST_BLOCK_0 = deepFreeze(block({
  number: 0,
  parentHash: fieldWord(genesisParentHash({ pcashChainId: 0x50435348n, l1ChainId: 0xaa36a7n, inboxAddress: `0x${"50".repeat(20)}` })),
  timestamp: 100,
  l1BlockNumber: 1,
  l1BlockHash: repeatedWord("11"),
}));

export const TEST_BLOCK_1 = deepFreeze(block({
  number: 1,
  parentHash: TEST_BLOCK_0.hash,
  timestamp: 101,
  l1BlockNumber: 2,
  l1BlockHash: repeatedWord("12"),
}));

export const TEST_STATUS = deepFreeze({
  latestBlock: TEST_BLOCK_0.number,
  latestBlockHash: TEST_BLOCK_0.hash,
  latestBlockTimestamp: TEST_BLOCK_0.timestamp,
  finalizedBlock: TEST_BLOCK_0.number,
  finalizedBlockHash: TEST_BLOCK_0.hash,
  finalizedBlockTimestamp: TEST_BLOCK_0.timestamp,
  latestL1BlockNumber: TEST_BLOCK_0.l1Origin.blockNumber,
  latestL1BlockHash: TEST_BLOCK_0.l1Origin.blockHash,
  observedL1BlockNumber: TEST_BLOCK_0.l1Origin.blockNumber,
  derivation: { state: "following", sinceUnixMs: "0x0" },
  finalizedL1BlockNumber: TEST_BLOCK_0.l1Origin.blockNumber,
  finalizedL1BlockHash: TEST_BLOCK_0.l1Origin.blockHash,
  stateRoot: TEST_BLOCK_0.stateRoot,
  l1OriginRoot: TEST_BLOCK_0.l1OriginRoot,
  historyRoot: TEST_BLOCK_0.historyRoot,
  outputCount: "0x0",
  issuedSoFar: "0x0",
  supplyCap: `0x${BigInt(issuanceVectors.supplyCap).toString(16)}`,
  totalSucceeded: "0x0",
  totalFailed: "0x0",
  totalTransactions: "0x0",
  index: { status: "ready", cursor: { blockNumber: TEST_BLOCK_0.number, blockHash: TEST_BLOCK_0.hash } },
  proverAssets: null,
  pcashChainId: "0x50435348",
  genesisHash: TEST_BLOCK_0.hash,
  acceptedTransactionTypes: ["0x0", "0x1", "0x2", "0x3"],
  acceptedBatchVersions: ["0x1"],
  l1ChainId: "0xaa36a7",
  inboxAddress: `0x${"50".repeat(20)}`,
  genesisL1Block: TEST_BLOCK_0.l1Origin.blockNumber,
  genesisL1BlockHash: TEST_BLOCK_0.l1Origin.blockHash,
  forkCapability: {
    chainId: "0x50435348",
    genesisHash: TEST_BLOCK_0.hash,
    headTimestamp: TEST_BLOCK_0.timestamp,
    currentForkCount: "0x0",
    currentPrefixHash: zeroWord,
    nextActivationTimestamp: "0x0",
    nextPrefixHash: zeroWord,
  },
});

function blockOneStatus(status) {
  return {
    ...clone(status),
    latestBlock: TEST_BLOCK_1.number,
    latestBlockHash: TEST_BLOCK_1.hash,
    latestBlockTimestamp: TEST_BLOCK_1.timestamp,
    latestL1BlockNumber: TEST_BLOCK_1.l1Origin.blockNumber,
    latestL1BlockHash: TEST_BLOCK_1.l1Origin.blockHash,
    observedL1BlockNumber: TEST_BLOCK_1.l1Origin.blockNumber,
    stateRoot: TEST_BLOCK_1.stateRoot,
    l1OriginRoot: TEST_BLOCK_1.l1OriginRoot,
    historyRoot: TEST_BLOCK_1.historyRoot,
    index: { status: "ready", cursor: { blockNumber: TEST_BLOCK_1.number, blockHash: TEST_BLOCK_1.hash } },
    forkCapability: {
      ...clone(status.forkCapability),
      headTimestamp: TEST_BLOCK_1.timestamp,
    },
  };
}

function json(response, status, body) {
  const encoded = JSON.stringify(body);
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.setHeader("content-length", Buffer.byteLength(encoded));
  response.end(encoded);
}

function rpcError(response, input, code, message) {
  json(response, 200, {
    jsonrpc: "2.0",
    id: input.id ?? null,
    error: { code, message },
  });
}

function requestObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function requestedBlock(params, head) {
  if (!Array.isArray(params) || params.length !== 2 || typeof params[0] !== "string" || typeof params[1] !== "boolean") {
    throw new Error("pcash_getBlockByNumber requires a block quantity and full-transaction flag");
  }
  if (params[0] === "0x0") return TEST_BLOCK_0;
  if (params[0] === "0x1" && head === 1) return TEST_BLOCK_1;
  return null;
}

function noteOutputPage(params, head) {
  if (!Array.isArray(params) || params.length !== 1) {
    throw new Error("pcash_getOutputs requires one request object");
  }
  const request = requestObject(params[0], "pcash_getOutputs request");
  if (request.fromOutputIndex !== "0x0") {
    throw new Error("pcash_getOutputs received an unknown note cursor");
  }
  const target = requestObject(request.target, "pcash_getOutputs.target");
  const expectedTarget = head === 0 ? TEST_BLOCK_0 : TEST_BLOCK_1;
  if (target.blockNumber !== expectedTarget.number || target.blockHash !== expectedTarget.hash) {
    throw new Error("pcash_getOutputs target is not the controlled head");
  }
  return {
    fromOutputIndex: request.fromOutputIndex,
    target: { block: clone(target), outputCount: "0x0" },
    outputs: [],
    continuation: null,
    complete: true,
  };
}

function blockBoundary(served) {
  const { hash, transactionResultCount, transactionResults, transactionBytes, l1Origin, ...header } = served;
  const stateFields = Object.fromEntries(Object.entries(emptyState).map(([key, value]) =>
    [key, key === "lagQ" ? value.toString() : key.endsWith("Count") ? `0x${value.toString(16)}` : fieldWord(value)]));
  return { state: stateFields, header, blockHash: hash };
}

function currentBoundary(state) {
  return blockBoundary(state.head === 0 ? TEST_BLOCK_0 : TEST_BLOCK_1);
}

/** The served block a `{ blockNumber, blockHash }` cursor names, or an error for any other. */
function servedCursor(value, head, label) {
  const cursor = requestObject(value, label);
  const served = [TEST_BLOCK_0, TEST_BLOCK_1].slice(0, head + 1)
    .find((candidate) => candidate.number === cursor.blockNumber && candidate.hash === cursor.blockHash);
  if (served === undefined) throw new Error(`${label} is not a served block`);
  return { blockNumber: served.number, blockHash: served.hash };
}

function resultFor(input, state) {
  if (input.method === "pcash_getMempool" && state.emptyMempool) {
    return { ...resultFor(input, { ...state, emptyMempool: false }), items: [] };
  }
  const relayBlock = state.relayCandidates ? TEST_BLOCK_1.l1Origin : TEST_BLOCK_0.l1Origin;
  const deliveryHash = input.method === "pcash_getL1DeliveryBatches"
    ? requestObject(input.params?.[0], "pcash_getL1DeliveryBatches request").l1TransactionHash?.toLowerCase()
    : undefined;
  const deliveryPage = (batches) => ({ l1TransactionHash: deliveryHash, batches, continuation: null, complete: true });
  if (state.relayCandidates && state.relayIncluded === false
    && (deliveryHash === TEST_RELAY_L1_HASH
      || (input.method === "eth_getTransactionReceipt" && input.params?.[0]?.toLowerCase() === TEST_RELAY_L1_HASH))) {
    return input.method === "pcash_getL1DeliveryBatches" ? deliveryPage([]) : null;
  }
  if (state.relayCandidates && input.method === "pcash_getMempool") {
    const result = resultFor(input, { ...state, relayCandidates: false });
    result.items.push(
      { ...result.items[0], contentHash: TEST_RELAY_CONFLICT_CONTENT_HASH, conflictCount: "0x1", rawTransaction: "0x060708" },
      { ...result.items[0], contentHash: TEST_RELAY_OVERSIZED_CONTENT_HASH, byteSize: "0x1e000", rawTransaction: null },
    );
    return result;
  }
  if (state.relayCandidates && input.method === "pcash_prepareRelay") {
    const request = input.params[0];
    const result = resultFor(input, { ...state, relayCandidates: false });
    let bytes = 67n;
    result.selectedContentHashes = [];
    result.rejected = [];
    for (const contentHash of request.contentHashes) {
      const size = contentHash === TEST_RELAY_OVERSIZED_CONTENT_HASH ? 122_880n : BigInt(fromHex(TEST_RELAY_RAW).length);
      if (bytes + 4n + size > BigInt(request.maxBatchBytes)) {
        result.rejected.push({ contentHash, reason: "max batch bytes" });
      } else if (contentHash === TEST_RELAY_CONFLICT_CONTENT_HASH) {
        bytes += 4n + size;
        result.rejected.push({ contentHash, reason: "NonceMismatch" });
      } else if (contentHash === TEST_RELAY_CONTENT_HASH) {
        bytes += 4n + size;
        result.selectedContentHashes.push(contentHash);
      } else {
        result.rejected.push({ contentHash, reason: "not found" });
      }
    }
    result.selectedTransactions = result.selectedContentHashes.map(() => TEST_RELAY_RAW);
    result.batchBytes = `0x${(67 + result.selectedTransactions.length * (4 + fromHex(TEST_RELAY_RAW).length)).toString(16)}`;
    return result;
  }
  switch (input.method) {
    case "eth_chainId":
      return state.status.l1ChainId;
    case "eth_blockNumber":
      return state.status.genesisL1Block;
    case "eth_getBlockByNumber": {
      if (![state.status.genesisL1Block, "latest"].includes(input.params?.[0])) {
        throw new Error("unknown Ethereum block");
      }
      return {
        number: state.status.genesisL1Block,
        hash: state.status.genesisL1BlockHash,
        parentHash: zeroWord,
        nonce: "0x0000000000000000",
        sha3Uncles: zeroWord,
        logsBloom: `0x${"00".repeat(256)}`,
        transactionsRoot: zeroWord,
        stateRoot: zeroWord,
        receiptsRoot: zeroWord,
        miner: `0x${"00".repeat(20)}`,
        difficulty: "0x0",
        totalDifficulty: "0x0",
        extraData: "0x",
        size: "0x1",
        gasLimit: "0x1c9c380",
        gasUsed: "0x0",
        timestamp: "0x64",
        transactions: [],
        uncles: [],
        baseFeePerGas: "0x1",
        mixHash: zeroWord,
      };
    }
    case "eth_estimateGas":
      return "0x1e240";
    case "eth_maxPriorityFeePerGas":
      return "0x1";
    case "eth_getTransactionCount":
      return `0x${state.transactionCount.toString(16)}`;
    case "eth_getTransactionByHash": {
      const requestedHash = input.params?.[0];
      if (!Array.isArray(input.params) || input.params.length !== 1 || typeof requestedHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(requestedHash)) {
        throw new Error("eth_getTransactionByHash requires one transaction hash");
      }
      const hash = requestedHash.toLowerCase();
      const transaction = state.transactions.get(hash);
      if (transaction === undefined) return null;
      const included = hash === TEST_RELAY_L1_HASH && state.relayIncluded !== false;
      return {
        ...transaction,
        hash,
        blockHash: included ? relayBlock.blockHash : null,
        blockNumber: included ? relayBlock.blockNumber : null,
        transactionIndex: included ? "0x0" : null,
      };
    }
    case "eth_feeHistory":
      return {
        oldestBlock: state.status.genesisL1Block,
        baseFeePerGas: ["0x1", "0x2"],
        gasUsedRatio: [0.5],
        reward: [[]],
      };
    case "eth_getBalance":
      return "0xde0b6b3a7640000";
    case "eth_getCode":
      return "0x";
    case "eth_call":
      return encodeAbiParameters(
        [{
          type: "tuple[]",
          components: [
            { name: "success", type: "bool" },
            { name: "returnData", type: "bytes" },
          ],
        }],
        [[{
          success: true,
          returnData: encodeAbiParameters([{ type: "uint256" }], [1_000_000_000_000_000_000n]),
        }]],
      );
    case "eth_getTransactionReceipt":
      return input.params?.[0]?.toLowerCase() === TEST_RELAY_L1_HASH ? {
        transactionHash: TEST_RELAY_L1_HASH,
        transactionIndex: "0x0",
        blockHash: relayBlock.blockHash,
        blockNumber: relayBlock.blockNumber,
        from: FIXED_ACCOUNT,
        to: state.status.inboxAddress,
        cumulativeGasUsed: "0x1e240",
        gasUsed: "0x1e240",
        contractAddress: null,
        logs: [],
        logsBloom: `0x${"00".repeat(256)}`,
        status: "0x1",
        effectiveGasPrice: "0x1",
        type: "0x2",
      } : null;
    case "pcash_status":
      return clone(state.status);
    case "pcash_getAccountProof": {
      const address = input.params?.[0];
      if (!Array.isArray(input.params) || input.params.length !== 1 || typeof address !== "string") {
        throw new Error("pcash_getAccountProof requires one address");
      }
      return { status: "notFound", address, authenticated: false };
    }
    case "pcash_getAccount":
      return null;
    case "pcash_getIssuanceQuote": {
      if (state.miningReward === undefined) return null;
      const quantity = (value) => `0x${value.toString(16)}`;
      return {
        parent: { blockNumber: state.status.latestBlock, blockHash: state.status.latestBlockHash, timestamp: state.status.latestBlockTimestamp },
        candidateTimestamp: input.params[0].candidateTimestamp,
        supplyCap: quantity(1_000_000_000n * 10n ** 18n), issuedSoFar: "0x0",
        baseline: quantity(state.miningReward), internalOffer: quantity(state.miningReward),
        blockAllowance: quantity(3n * state.miningReward), maxSingleActionReward: quantity(state.miningReward),
        multiplierQ: quantity(1n << 128n), lagQ: "0", exhausted: false, rewardPossible: state.miningReward > 0n,
      };
    }
    case "pcash_getPayouts":
      return { atBlockNumber:state.status.latestBlock,atBlockHash:state.status.latestBlockHash,records:[],nextCursor:null };
    case "pcash_getBlockEconomics":
      return { atBlockNumber:state.status.latestBlock,atBlockHash:state.status.latestBlockHash,records:[],nextBlock:null };
    case "pcash_getAccountHistory":
      return { items: [], nextCursor: null, head: { blockNumber: state.status.latestBlock, blockHash: state.status.latestBlockHash } };
    case "pcash_getNullifierProofs": {
      return { boundary: currentBoundary(state), nullifierRoot: fieldWord(emptyState.nullifierRoot),
        proofs: input.params[0].map((nullifier) => nullifierProofRpc(emptyNullifiers.proof(BigInt(nullifier)))) };
    }
    case "pcash_getWitnessSnapshot": {
      if (!Array.isArray(input.params) || input.params.length !== 1) {
        throw new Error("pcash_getWitnessSnapshot requires one request object");
      }
      const query = requestObject(input.params[0], "pcash_getWitnessSnapshot request");
      for (const [key, values] of Object.entries(query)) {
        if (!["accounts", "contracts", "outputs", "nullifiers", "l1Logs"].includes(key) || !Array.isArray(values)) {
          throw new Error(`invalid witness snapshot query field ${key}`);
        }
      }
      const read = (method, params) => resultFor({ method, params }, state);
      const boundary = currentBoundary(state);
      return {
        status: read("pcash_status", []),
        blockHeader: { recentPcashBlockHash: boundary.blockHash, boundary },
        block: clone(state.head === 0 ? TEST_BLOCK_0 : TEST_BLOCK_1),
        accounts: (query.accounts ?? []).map((address) => read("pcash_getAccountProof", [address])),
        contracts: (query.contracts ?? []).map((address) => ({ status: "notFound", address, authenticated: false })),
        outputs: null,
        nullifiers: query.nullifiers?.length ? read("pcash_getNullifierProofs", [query.nullifiers]) : null,
        l1Logs: (query.l1Logs ?? []).map(() => null),
      };
    }
    case "pcash_getOutputs":
      return noteOutputPage(input.params, state.head);
    case "pcash_getOutputFrontier": {
      if (!Array.isArray(input.params) || input.params.length !== 1) {
        throw new Error("pcash_getOutputFrontier requires one block cursor");
      }
      const block = servedCursor(input.params[0], state.head, "pcash_getOutputFrontier block");
      return { block, outputCount: "0x0", outputRoot: fieldWord(emptyRoot), ommers: [] };
    }
    case "pcash_getAccountChanges": {
      if (!Array.isArray(input.params) || input.params.length !== 1) {
        throw new Error("pcash_getAccountChanges requires one request object");
      }
      const request = requestObject(input.params[0], "pcash_getAccountChanges request");
      const block = servedCursor(request.target, state.head, "pcash_getAccountChanges.target");
      return {
        fromBlock: request.fromBlock,
        target: { block, accountCount: "0x0" },
        changes: [],
        continuation: null,
        complete: true,
      };
    }
    case "pcash_getBlockHeader": {
      const tag = input.params?.[0];
      const served = tag === "latest" ? (state.head === 0 ? TEST_BLOCK_0 : TEST_BLOCK_1) : requestedBlock([tag, false], state.head);
      if (served === null) return null;
      return { recentPcashBlockHash: served.hash, boundary: blockBoundary(served) };
    }
    case "pcash_getBlockByNumber":
      return clone(requestedBlock(input.params, state.head));
    case "pcash_getMempool":
      return {
        items: [{
          contentHash: TEST_RELAY_CONTENT_HASH,
          statementId: zeroWord,
          stableId: zeroWord,
          conflictKeys: [],
          kind: "privateValue",
          accountCreation: 0,
          byteSize: `0x${fromHex(TEST_RELAY_RAW).length.toString(16)}`,
          openFeeAmount: "0xde0b6b3a7640000",
          issuanceOwnerCommitment: zeroWord,
          issuanceRoute: "open",
          validUntil: null,
          recentPcashBlockHash: null,
          status: "ready",
          conflictCount: "0x0",
          receivedAtUnixMs: "0x1",
          headCheckedBlock: state.status.latestBlock,
          headCheckedBlockHash: state.status.latestBlockHash,
          publicRecords: [],
          rawTransaction: TEST_RELAY_RAW,
        }],
        nextCursor: null,
        headCheckedBlock: state.status.latestBlock,
        headCheckedBlockHash: state.status.latestBlockHash,
        peerCount: "0x1",
      };
    case "pcash_getMempoolTransaction":
      return input.params?.[0]?.toLowerCase() === TEST_RELAY_CONTENT_HASH ? {
        contentHash: TEST_RELAY_CONTENT_HASH,
        statementId: zeroWord,
        stableId: zeroWord,
        conflictKeys: [],
        kind: "privateValue",
        accountCreation: 0,
        byteSize: `0x${fromHex(TEST_RELAY_RAW).length.toString(16)}`,
        openFeeAmount: "0xde0b6b3a7640000",
        issuanceOwnerCommitment: zeroWord,
        issuanceRoute: "open",
        validUntil: null,
        recentPcashBlockHash: null,
        status: "ready",
        conflictCount: "0x0",
        receivedAtUnixMs: "0x1",
        headCheckedBlock: state.status.latestBlock,
        headCheckedBlockHash: state.status.latestBlockHash,
        publicRecords: [],
        rawTransaction: TEST_RELAY_RAW,
      } : null;
    case "pcash_prepareRelay":
      return {
        selectedTransactions: [TEST_RELAY_RAW],
        selectedContentHashes: [TEST_RELAY_CONTENT_HASH],
        rejected: [],
        collectibleOpenFee: "0xde0b6b3a7640000",
        collectibleQualifyingActions: "0x1",
        selectedQualifyingActions: "0x1",
        batchBytes: `0x${((TEST_RELAY_BATCH.length - 2) / 2).toString(16)}`,
        headCheckedBlock: state.status.latestBlock,
        headCheckedBlockHash: state.status.latestBlockHash,
      };
    case "pcash_getL1DeliveryBatches":
      return deliveryPage(deliveryHash === TEST_RELAY_L1_HASH ? [{
        l1BlockNumber: relayBlock.blockNumber,
        l1BlockHash: relayBlock.blockHash,
        l1TransactionIndex: "0x0",
        l1TransactionHash: TEST_RELAY_L1_HASH,
        l1Sender: FIXED_ACCOUNT,
        posterOwnerCommitment: fieldWord(1n),
        posterContext: fieldWord(0n),
        carrierType: "calldata",
        logIndex: null,
        emitter: null,
        context: null,
        carrierHash: toHex(keccak256(fromHex(TEST_RELAY_BATCH))),
        carrierLength: `0x${fromHex(TEST_RELAY_BATCH).length.toString(16)}`,
        blobVersionedHashes: [],
        exclusionReason: null,
        items: [{
          batchItemIndex: "0x0", contentHash: TEST_RELAY_CONTENT_HASH,
          byteOffset: `0x${(TEST_RELAY_BATCH_BYTES.length - TEST_RELAY_ENTRIES[0].length).toString(16)}`,
          byteLength: `0x${TEST_RELAY_ENTRIES[0].length.toString(16)}`,
          exclusionReason: null,
        }],
      }] : []);
    case "pcash_getReceipt": {
      const receipt = {
        contentHash: TEST_RELAY_CONTENT_HASH,
        transactionId: toHex(transactionId({
          l1BlockHash: bytes32FromHex(relayBlock.blockHash),
          l1TransactionIndex: 0n,
          batchItemIndex: 0n,
        })),
        outcome: "succeeded",
        failureDetail: null,
        l1Sender: FIXED_ACCOUNT,
        issuanceOwnerCommitment: fieldWord(1n),
        settledOpenFeeAmount: "0x0",
        settledIssuanceAmount: "0x0",
        kind: "privateValue",
        accountCreation: 0,
        inclusion: {
          l1BlockNumber: relayBlock.blockNumber,
          l1BlockHash: relayBlock.blockHash,
          l1TransactionIndex: "0x0",
          l1TransactionHash: TEST_RELAY_L1_HASH,
          batchItemIndex: "0x0",
        },
        outputLeafStart: null,
        outputsAdded: "0x0",
        nullifiers: relayNullifiers.map(fieldWord),
        account: null,
      };
      const query = input.params?.[0];
      const matches = typeof query === "string" ? query.toLowerCase() === receipt.transactionId
        : query?.contentHash !== undefined ? query.contentHash.toLowerCase() === receipt.contentHash
        : query?.nullifier !== undefined ? receipt.nullifiers.includes(query.nullifier.toLowerCase())
        : query?.inclusionId !== undefined ? query.inclusionId.l1BlockHash.toLowerCase() === receipt.inclusion.l1BlockHash
          && BigInt(query.inclusionId.l1TransactionIndex) === BigInt(receipt.inclusion.l1TransactionIndex)
          && BigInt(query.inclusionId.batchItemIndex) === BigInt(receipt.inclusion.batchItemIndex)
        : false;
      return matches ? [receipt] : [];
    }
    default:
      return undefined;
  }
}

export async function startControlledRpc({ status = TEST_STATUS, emptyMempool = false } = {}) {
  let outputFailure;
  let receiptFailure;
  let receiptGate;
  let nextGasEstimateDelay = 0;
  const requests = [];
  const state = { head: 0, status: clone(status), transactions: new Map(), transactionCount: 3n, emptyMempool };
  const server = createServer((request, response) => {
    response.setHeader("access-control-allow-origin", "*");
    response.setHeader("access-control-allow-headers", "content-type");
    if (request.method === "OPTIONS") {
      response.statusCode = 204;
      response.end();
      return;
    }
    if (request.method !== "POST") {
      json(response, 405, { error: "POST required" });
      return;
    }
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", async () => {
      let input;
      try {
        input = JSON.parse(body);
      } catch {
        json(response, 400, { error: "invalid JSON" });
        return;
      }
      requests.push(clone(input));
      if (input.method === "pcash_getOutputs" && outputFailure !== undefined) {
        rpcError(response, input, -32000, outputFailure);
        return;
      }
      if (input.method === "eth_getTransactionReceipt") await receiptGate;
      if (input.method === "eth_getTransactionReceipt" && receiptFailure !== undefined) {
        rpcError(response, input, -32000, receiptFailure);
        return;
      }
      let result;
      try {
        result = resultFor(input, state);
      } catch (error) {
        rpcError(response, input, -32602, error instanceof Error ? error.message : String(error));
        return;
      }
      if (result === undefined) {
        rpcError(response, input, -32601, `Journey RPC does not implement ${String(input.method)}`);
        return;
      }
      if (input.method === "eth_estimateGas" && nextGasEstimateDelay > 0) {
        const delay = nextGasEstimateDelay;
        nextGasEstimateDelay = 0;
        setTimeout(() => json(response, 200, { jsonrpc: "2.0", id: input.id ?? null, result }), delay);
        return;
      }
      json(response, 200, { jsonrpc: "2.0", id: input.id ?? null, result });
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Journey RPC did not bind a TCP port");
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    setProverAssets(proverAssets) {
      state.status.proverAssets = proverAssets;
    },
    holdReceipts() {
      let release;
      receiptGate = new Promise((resolve) => { release = resolve; });
      return () => { receiptGate = undefined; release(); };
    },
    setReceiptFailure(message) {
      receiptFailure = message;
    },
    setMiningReward(reward) {
      state.miningReward = reward;
    },
    setLatestBlockTimestamp(timestamp) {
      state.status.latestBlockTimestamp = `0x${timestamp.toString(16)}`;
    },
    recordTransaction(hash, transaction) {
      const { data, ...fields } = clone(transaction);
      state.transactions.set(hash.toLowerCase(), { ...fields, input: data });
      return hash;
    },
    dropTransaction(hash) {
      state.transactions.delete(hash.toLowerCase());
    },
    setTransactionCount(count) {
      state.transactionCount = count;
    },
    useRelayCandidates() {
      state.emptyMempool = false;
      state.relayCandidates = true;
      state.relayIncluded = false;
    },
    delayNextGasEstimate(milliseconds) {
      nextGasEstimateDelay = milliseconds;
    },
    includeRelay() {
      state.relayIncluded = true;
    },
    finalizeRelay() {
      state.status.finalizedBlock = TEST_BLOCK_1.number;
      state.status.finalizedBlockHash = TEST_BLOCK_1.hash;
      state.status.finalizedBlockTimestamp = TEST_BLOCK_1.timestamp;
      state.status.finalizedL1BlockNumber = TEST_BLOCK_1.l1Origin.blockNumber;
      state.status.finalizedL1BlockHash = TEST_BLOCK_1.l1Origin.blockHash;
    },
    setOutputFailure(message) {
      outputFailure = message;
    },
    clearRequests() {
      requests.length = 0;
    },
    blockBoundary(number) {
      if (number === 0) return { blockNumber: TEST_BLOCK_0.number, blockHash: TEST_BLOCK_0.hash };
      if (number === 1) return { blockNumber: TEST_BLOCK_1.number, blockHash: TEST_BLOCK_1.hash };
      throw new RangeError("controlled RPC only has blocks 0 and 1");
    },
    advanceToBlock1() {
      state.head = 1;
      state.status = blockOneStatus(state.status);
      return { status: clone(state.status), block: clone(TEST_BLOCK_1) };
    },
    currentStatus() {
      return clone(state.status);
    },
    // server.close() waits for active connections, and a page that is still open keeps its keep-alive connections active.
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  };
}
