import { describe, expect, it, vi } from "vitest";
import { PRIVATE_VALUE_PROFILES } from "../src/constants/privateValueProfiles.ts";
import { encodePayload, encryptEnvelope, generateMlKemKeyPair, sizeClassFiller } from "../src/protocol/envelope.ts";
import { encodeBatchForVersion, encodePrivateValueTransaction, WIRE_PROOF_BYTES } from "../src/protocol/codec.ts";
import { DEFAULT_NETWORK_CONFIG } from "../src/protocol/network.ts";
import { noteBodyCommitment, ownerCommitment } from "../src/protocol/notes.ts";
import { issuancePayoutOpening, posterPayoutOpening } from "../src/protocol/payout.ts";
import { deliveryCommitment, randomArena } from "../src/protocol/transfer.ts";
import { Relayer } from "../src/relay/relayer.ts";
import { inspectPrivateRelayValue } from "../src/relay/selected.ts";
import { keccak256, toHex } from "../src/utils/index.ts";

const chainId = Number(DEFAULT_NETWORK_CONFIG.pcashChainId);
const address = 123n;
const nkRoot = 456n;
const receive = generateMlKemKeyPair(new Uint8Array(64).fill(7));
const recipient = { address, nkRoot, mlKemSecretKey: receive.secretKey };
const headHash = `0x${"11".repeat(32)}`;
const status = { pcashChainId: chainId, l1ChainId: 1n, latestBlock: 2n, latestBlockHash: headHash,
  latestBlockTimestamp: 500n, acceptedBatchVersions: [1], acceptedTransactionTypes: [0, 1, 2, 3] };
const nullifiersA = [11n, 12n, 13n, 14n];
const nullifiersB = [21n, 22n, 23n, 24n];
const issuanceCommitment = issuancePayoutOpening(address, nkRoot, chainId, nullifiersA).ownerCommitment;
const issuanceWord = `0x${issuanceCommitment.toString(16).padStart(64, "0")}`;

function transaction(nullifiers: bigint[], privateFeeAmount: bigint) {
  const outputData = Array.from({ length: PRIVATE_VALUE_PROFILES.S.outputs }, () => sizeClassFiller());
  const bodies = [1n, 2n, 3n, 4n, 5n];
  if (privateFeeAmount > 0n) {
    const noteSecret = 777n;
    outputData[0] = encryptEnvelope(receive.publicKey, encodePayload({
      chainId: BigInt(chainId), assetId: 0n, amount: privateFeeAmount,
      owner: address, noteSecret, outputIndex: 0,
    }));
    bodies[0] = noteBodyCommitment(ownerCommitment(address, noteSecret), 0n, privateFeeAmount);
  }
  const arena = randomArena(PRIVATE_VALUE_PROFILES.S.shapeId);
  const publicInputs = [BigInt(chainId), nkRoot, ...nullifiers, ...bodies,
    deliveryCommitment(outputData, arena), 0n, issuanceCommitment, 0n, 1_000n, 0n, 0n, 0n];
  const raw = encodePrivateValueTransaction({ shape: PRIVATE_VALUE_PROFILES.S.shapeId, publicInputs,
    proof: new Uint8Array(WIRE_PROOF_BYTES), outputData, arena });
  const contentHash = toHex(keccak256(raw));
  return { raw, metadata: { contentHash, statementId: contentHash, stableId: contentHash, conflictKeys: [],
    kind: "privateValue", byteSize: BigInt(raw.length), openFeeAmount: 0n,
    issuanceOwnerCommitment: issuanceWord, issuanceRoute: "designated", validUntil: null,
    status: "ready", conflictCount: 0n, receivedAtUnixMs: 1n,
    headCheckedBlock: 2n, headCheckedBlockHash: headHash, rawTransaction: null } };
}

function harness(entries: ReturnType<typeof transaction>[]) {
  const byHash = new Map<string, ReturnType<typeof transaction>>(
    entries.map((entry) => [entry.metadata.contentHash, entry]));
  const poster = posterPayoutOpening(address, nkRoot, 2n);
  const prepareRelay = vi.fn(async (request: { contentHashes: string[];
    controlledIssuanceOwnerCommitments: string[]; controlledIssuanceContentHashes: string[] }) => {
    const selected = request.contentHashes.map((hash) => byHash.get(hash)!);
    return { selectedTransactions: selected.map((entry) => toHex(entry.raw)),
      selectedContentHashes: request.contentHashes, rejected: [],
      collectibleOpenFee: 0n,
      collectibleQualifyingActions: BigInt(selected.filter((entry) =>
        request.controlledIssuanceContentHashes.includes(entry.metadata.contentHash)
        || request.controlledIssuanceOwnerCommitments.includes(entry.metadata.issuanceOwnerCommitment)).length),
      selectedQualifyingActions: BigInt(selected.length),
      batchBytes: BigInt(encodeBatchForVersion(selected.map((entry) => entry.raw), 1,
        poster.ownerCommitment, poster.context).length),
      headCheckedBlock: 2n, headCheckedBlockHash: headHash };
  });
  const node = { status: vi.fn(async () => status),
    getMempool: vi.fn(async () => ({ items: entries.map((entry) => entry.metadata), nextCursor: null })),
    getMempoolTransaction: vi.fn(async (hash: string) => {
      const entry = byHash.get(hash);
      return entry === undefined ? null : { ...entry.metadata, rawTransaction: toHex(entry.raw) };
    }),
    getIssuanceQuote: vi.fn(async () => ({ internalOffer: 100n, blockAllowance: 1_000n,
      supplyCap: 10n ** 9n, issuedSoFar: 0n, exhausted: false,
      parent: { blockNumber: 2n, blockHash: headHash, timestamp: 500n } })),
    getBlockEconomics: vi.fn(async () => ({ atBlockNumber: 2n, atBlockHash: headHash,
      nextBlock: null, records: [{ blocks: 1n, qualifyingActions: 0n }] })),
    prepareRelay, getReceipt: vi.fn(async () => null) };
  const submitter = { address: `0x${"aa".repeat(20)}`, supportedCarriers: ["calldata"],
    assertAvailable: vi.fn(async () => undefined),
    inFlight: vi.fn(async () => []),
    quote: vi.fn(async () => ({ selected: { carrier: "calldata", gasLimit: 1n,
      maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, maxFeePerBlobGas: null,
      blobCount: 0, blobVersionedHashes: [], estimatedCostWei: 1n, maximumCostWei: 1n,
      balanceWei: 2n } })),
    send: vi.fn(async () => ({ txHash: `0x${"33".repeat(32)}`, settle: async () => ({ txHash: `0x${"33".repeat(32)}`,
      receipt: { status: 1, blockNumber: 3n, blockHash: `0x${"44".repeat(32)}`,
        transactionIndex: 0, gasUsed: 1n }, observed: true }) })) };
  return { node, submitter, prepareRelay, relayer: new Relayer({ node: node as never,
    payoutRecipient: recipient, submitterFor: () => submitter as never, issuanceHaircutBps: 0 }) };
}

describe("per-entry designated issuance control", () => {
  it("never selects or broadcasts zero-fee B from A's different issuance context", async () => {
    const a = transaction(nullifiersA, 0n);
    const b = transaction(nullifiersB, 0n);
    const { relayer, prepareRelay, submitter } = harness([b, a]);
    const result = await relayer.relay();
    expect(result.requested).toEqual([a.metadata.contentHash]);
    expect(result.selectedContentHashes).toEqual([a.metadata.contentHash]);
    expect(result.submitted).toBe(true);
    expect(prepareRelay).toHaveBeenCalledWith(expect.objectContaining({
      contentHashes: [a.metadata.contentHash],
      controlledIssuanceOwnerCommitments: [],
      controlledIssuanceContentHashes: [a.metadata.contentHash],
    }));
    expect(result.collectibleQualifyingActions).toBe(1n);
    expect(result.selectedQualifyingActions).toBe(1n);
    expect(submitter.send).toHaveBeenCalledWith(expect.anything(), expect.anything(),
      expect.anything(), expect.objectContaining({ selected: [a.metadata.contentHash] }));
  });

  it("prepares only B for a one-entry batch while A's different context remains ready", async () => {
    const a = transaction(nullifiersA, 0n);
    const b = transaction(nullifiersB, 1_000n);
    expect(inspectPrivateRelayValue({ transactionBytes: a.raw, status, recipient }).issuanceOwnerCommitment)
      .toBe(issuanceCommitment);
    expect(inspectPrivateRelayValue({ transactionBytes: b.raw, status, recipient }).issuanceOwnerCommitment)
      .toBeNull();
    const { node, prepareRelay, submitter } = harness([b, a]);
    const relayer = new Relayer({ node: node as never, payoutRecipient: recipient,
      submitterFor: () => submitter as never, issuanceHaircutBps: 0, maxTransactions: 1 });
    const result = await relayer.relay({ noSubmit: true });
    expect(result.considered).toBe(2);
    expect(result.requested).toEqual([b.metadata.contentHash]);
    expect(prepareRelay).toHaveBeenCalledWith(expect.objectContaining({
      contentHashes: [b.metadata.contentHash],
      controlledIssuanceOwnerCommitments: [], controlledIssuanceContentHashes: [],
    }));
    expect(result.collectibleQualifyingActions).toBe(0n);
    expect(result.valuation?.expectedIssuance).toBe(0n);
    expect(submitter.send).not.toHaveBeenCalled();
  });

  it("sends A by exact hash and never credits B's reused commitment", async () => {
    const a = transaction(nullifiersA, 0n);
    const b = transaction(nullifiersB, 1_000n);
    const { relayer, prepareRelay, submitter } = harness([b, a]);
    const result = await relayer.relay({ noSubmit: true });
    expect(result.requested).toEqual([b.metadata.contentHash, a.metadata.contentHash]);
    expect(prepareRelay).toHaveBeenCalledWith(expect.objectContaining({
      contentHashes: [b.metadata.contentHash, a.metadata.contentHash],
      controlledIssuanceOwnerCommitments: [], controlledIssuanceContentHashes: [a.metadata.contentHash],
    }));
    expect(result.collectibleQualifyingActions).toBe(1n);
    expect(result.selectedQualifyingActions).toBe(2n);
    expect(result.valuation?.expectedIssuance).toBe(100n);
    expect(submitter.send).not.toHaveBeenCalled();
  });
});
