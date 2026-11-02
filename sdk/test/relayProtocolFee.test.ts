import { describe, expect, it, vi } from "vitest";
import { PRIVATE_VALUE_PROFILES } from "../src/constants/privateValueProfiles.ts";
import { OUTPUT_DATA_BYTES } from "../src/constants/params.ts";
import { ProtocolFeeTooLowError, type MempoolItemResult, type PcashNodeClient, type StatusResult } from "../src/clients/index.ts";
import { decodeBatch, encodePrivateValueTransaction, MAX_WAIVED_BASE_FEE, WIRE_PROOF_BYTES } from "../src/protocol/index.ts";
import {
  prepareTransactionForL1,
  Relayer,
  submitPreparedTransactionToL1,
  RelayPreBroadcastError,
  type RelayCarrierQuote,
  type RelaySubmitter,
} from "../src/relay/index.ts";
import { fromHex, keccak256, toHex, type Hex } from "../src/utils/index.ts";
import { createL1SubmissionAdapter } from "../src/wallet/submission.ts";

const CHAIN_ID = 8191;
const HEAD_HASH = `0x${"77".repeat(32)}`;
const S = PRIVATE_VALUE_PROFILES.S;

/** A structurally valid profile S transaction that burns `burn`; `tag` keeps content hashes apart. */
function privateValue(burn: bigint, tag: bigint): Uint8Array {
  const publicInputs = Array.from({ length: S.publicInputs }, () => 0n);
  publicInputs[S.offsets.chainId] = BigInt(CHAIN_ID);
  publicInputs[S.offsets.recentBlockHash] = tag;
  publicInputs[S.offsets.nativeBurnAmount] = burn;
  return encodePrivateValueTransaction({
    shape: S.shapeId,
    publicInputs,
    proof: new Uint8Array(WIRE_PROOF_BYTES),
    outputData: Array.from({ length: S.outputs }, () => new Uint8Array(OUTPUT_DATA_BYTES)),
    arena: new Uint8Array(S.arenaBytes),
  });
}

function status(baseFee: bigint): StatusResult {
  return {
    latestBlock: 2n, latestBlockHash: HEAD_HASH, latestBlockTimestamp: 1_000n,
    l1ChainId: 1n, pcashChainId: CHAIN_ID, acceptedBatchVersions: [1], acceptedTransactionTypes: [0, 1, 2, 3],
    genesisHash: `0x${"11".repeat(32)}`, inboxAddress: `0x${"22".repeat(20)}`, genesisL1Block: 0n, genesisL1BlockHash: `0x${"33".repeat(32)}`,
    feeExcess: 0n, baseFee,
  } as StatusResult;
}

const quote: RelayCarrierQuote = {
  carrier: "calldata", gasLimit: 21_000n, maxFeePerGas: 10n, maxPriorityFeePerGas: 1n,
  maxFeePerBlobGas: null, blobCount: 0, blobVersionedHashes: [],
  estimatedCostWei: 189_000n, maximumCostWei: 210_000n, balanceWei: 1_000_000n,
};

function submitter(): RelaySubmitter {
  return {
    address: `0x${"aa".repeat(20)}`,
    supportedCarriers: ["calldata", "blobs"],
    assertAvailable: vi.fn(async () => undefined),
    inFlight: vi.fn(async () => []),
    quote: vi.fn(async () => ({ selected: quote, calldata: quote })),
    send: vi.fn(async () => { throw new Error("not sent in these tests"); }),
  };
}

describe("direct L1 posting and the protocol fee", () => {
  // Base fees in multiples of the waiver, so they are owed.
  const U = MAX_WAIVED_BASE_FEE;

  it("refuses a required transaction that burns less than the next block's fee", async () => {
    // Profile S pays for its 4 nullifiers: 4 units at a base fee of 10 U.
    const l1 = submitter();
    const failure = await prepareTransactionForL1(privateValue(40n * U - 1n, 1n), status(10n * U), l1, 1n, 2n)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RelayPreBroadcastError);
    const cause = (failure as RelayPreBroadcastError).cause;
    expect(cause).toBeInstanceOf(ProtocolFeeTooLowError);
    expect(cause).toMatchObject({ requiredFee: 40n * U, nativeBurnAmount: 40n * U - 1n });
    expect(l1.quote).not.toHaveBeenCalled();
  });

  it("posts a required transaction that covers the fee and drops an optional one that does not", async () => {
    const own = privateValue(40n * U, 1n);
    const prepared = await prepareTransactionForL1(own, status(10n * U), submitter(), 1n, 2n, "calldata", {
      optional: [privateValue(40n * U - 1n, 2n), privateValue(400n * U, 3n)],
    });
    expect(prepared.orderedTransactions).toEqual([toHex(own), toHex(privateValue(400n * U, 3n))]);
    expect(decodeBatch(fromHex(prepared.batch)).items).toHaveLength(2);
  });

  it("refuses before broadcast when the fee rises above the burn during signing and proving", async () => {
    const l1 = submitter();
    const node = { status: vi.fn(async () => status(0n)) } as unknown as PcashNodeClient;
    const adapter = createL1SubmissionAdapter({ node, submitterFor: () => l1, payoutRecipient: () => ({ address: 1n, nkRoot: 2n }) });
    const entry = privateValue(0n, 1n);
    const prepared = await adapter.preflight({ transactionBytes: entry, status: status(0n), retry: false });
    vi.mocked(node.status).mockResolvedValue(status(2n * U));
    const failure = await adapter.submit({ transactionBytes: entry, status: status(0n), retry: false, prepared })
      .catch((error: unknown) => error);
    expect(adapter.isDefinitePreBroadcastError!(failure)).toBe(true);
    // The adapter reaches the published relay module, so the class is matched by name.
    expect((failure as Error).cause).toMatchObject({ name: "ProtocolFeeTooLowError", baseFee: 2n * U, requiredFee: 8n * U, nativeBurnAmount: 0n });
    expect(l1.send).not.toHaveBeenCalled();
  });

  it("checks only the batch's own transactions against the fee at broadcast", async () => {
    const l1 = submitter();
    vi.mocked(l1.send).mockResolvedValue({ txHash: `0x${"33".repeat(32)}`, settle: async () => ({ txHash: `0x${"33".repeat(32)}`, observed: true }) } as never);
    const prepared = await prepareTransactionForL1(privateValue(80n * U, 1n), status(10n * U), l1, 1n, 2n, "calldata", {
      optional: [privateValue(40n * U, 2n)],
    });
    // At a base fee of 20 U the companion no longer covers its 80 U; the batch still carries the payment.
    await submitPreparedTransactionToL1({ status: async () => status(20n * U) } as unknown as PcashNodeClient, prepared, l1);
    expect(l1.send).toHaveBeenCalledOnce();
  });

  it("needs no burn while the base fee is zero or waived", async () => {
    for (const baseFee of [0n, 1n, U]) {
      const prepared = await prepareTransactionForL1(privateValue(0n, 1n), status(baseFee), submitter(), 1n, 2n);
      expect(prepared.orderedTransactions).toHaveLength(1);
    }
  });
});

describe("automatic relay and the protocol fee", () => {
  it("drops a transaction the node's preparation rejects for its fee and selects again without it", async () => {
    const low = privateValue(1n, 1n);
    const paying = privateValue(1_000n, 2n);
    const raw = new Map<string, Hex>([low, paying].map((bytes) => [toHex(keccak256(bytes)), toHex(bytes)]));
    const [lowHash, payingHash] = [...raw.keys()];
    const item = (contentHash: string, openFeeAmount: bigint): MempoolItemResult => ({
      contentHash, statementId: contentHash, stableId: contentHash, conflictKeys: [], kind: "privateValue",
      byteSize: BigInt(fromHex(raw.get(contentHash)!).length), openFeeAmount, nativeBurnAmount: 0n,
      issuanceOwnerCommitment: `0x${"00".repeat(32)}`, issuanceRoute: "open", validUntil: null,
      recentPcashBlockHash: null, status: "ready", conflictCount: 0n, receivedAtUnixMs: 1n,
      headCheckedBlock: 2n, headCheckedBlockHash: HEAD_HASH, publicRecords: [], rawTransaction: null,
    });
    const node = {
      status: vi.fn(async () => status(10n)),
      getMempool: vi.fn(async () => ({
        items: [item(lowHash!, 500n), item(payingHash!, 100n)],
        nextCursor: null, headCheckedBlock: 2n, headCheckedBlockHash: HEAD_HASH, peerCount: 0n,
      })),
      getMempoolTransaction: vi.fn(async () => null),
      getIssuanceQuote: vi.fn(),
      getBlockEconomics: vi.fn(),
      getReceipt: vi.fn(),
      prepareRelay: vi.fn(async ({ contentHashes }: { contentHashes: string[] }) => {
        const selected = contentHashes.filter((hash) => hash !== lowHash);
        return {
          selectedTransactions: selected.map((hash) => raw.get(hash)!),
          selectedContentHashes: selected,
          rejected: contentHashes.includes(lowHash!) ? [{ contentHash: lowHash!, reason: "ProtocolFeeTooLow" }] : [],
          collectibleOpenFee: 100n, collectibleQualifyingActions: 1n, selectedQualifyingActions: 1n,
          batchBytes: selected.reduce((size, hash) => size + 4n + BigInt(fromHex(raw.get(hash)!).length), 67n),
          headCheckedBlock: 2n, headCheckedBlockHash: HEAD_HASH,
        };
      }),
    };
    const relay = new Relayer({
      payoutRecipient: { address: 1n, nkRoot: 2n }, node: node as never, submitterFor: () => submitter(),
      issuanceHaircutBps: 10_000,
    });

    const result = await relay.relay({ noSubmit: true });

    expect(node.prepareRelay).toHaveBeenCalledTimes(2);
    expect(node.prepareRelay.mock.calls[0]![0].contentHashes).toEqual([lowHash, payingHash]);
    expect(node.prepareRelay.mock.calls[1]![0].contentHashes).toEqual([payingHash]);
    expect(result.selectedContentHashes).toEqual([payingHash]);
    expect(decodeBatch(fromHex(result.batch)).items.map((entry) => toHex(entry))).toEqual([raw.get(payingHash!)]);
  });
});
