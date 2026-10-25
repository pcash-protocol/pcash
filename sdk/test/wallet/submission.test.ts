import { contractCreationFixture } from "./contractCreationFixture.ts";
import { describe, expect, it, vi } from "vitest";
import { DurablePreBroadcastError, type DurableSubmissionAdapter } from "../../src/wallet/actions/durableSubmission.ts";
import { PcashNodeRpcError, type PcashNodeClient, type ReceiptResult, type StatusResult } from "@pcash/sdk/clients";
import { RelayDeadlineError, RelayUpstreamError } from "@pcash/sdk/relay";
import { encodePrivateValueTransaction, encodeUserAccountCreation, transactionIdentity, deliveryCommitment, randomArena, WIRE_PROOF_BYTES, sizeClassFiller } from "@pcash/sdk/protocol";
import { PRIVATE_VALUE_PROFILES } from "@pcash/sdk/constants";
import { beBytes, concatBytes, fromHex } from "@pcash/sdk/utils";
import { awaitingAcceptance, createMempoolSubmissionAdapter, type SubmissionOutput } from "../../src/wallet/submission.ts";

const word = (byte: string): string => `0x${byte.repeat(32)}`;
const entry = contractCreationFixture(1);
const { contentHash } = transactionIdentity(entry);

/** A type 0x00 entry with the given public open fee and issuance destination. */
function privateValueEntry(openFeeAmount: bigint, issuanceOwnerCommitment: bigint): Uint8Array {
  const outputData = [sizeClassFiller(), sizeClassFiller(), sizeClassFiller(), sizeClassFiller(), sizeClassFiller()] as const;
  const arena = randomArena(PRIVATE_VALUE_PROFILES.S.shapeId);
  const { offsets, publicInputs: words } = PRIVATE_VALUE_PROFILES.S;
  const publicInputs = Array<bigint>(words).fill(0n);
  publicInputs[offsets.chainId] = 1n;
  publicInputs[offsets.deliveryCommitment] = deliveryCommitment(outputData, arena);
  publicInputs[offsets.openFeeAmount] = openFeeAmount;
  publicInputs[offsets.issuanceOwner] = issuanceOwnerCommitment;
  publicInputs[offsets.validUntil] = 100n;
  return encodePrivateValueTransaction({ publicInputs, proof: new Uint8Array(WIRE_PROOF_BYTES), outputData, arena });
}

function status(genesisByte = "11"): StatusResult {
  const hash = word("22");
  const genesisHash = word(genesisByte);
  return {
    latestBlock: 1n,
    latestBlockHash: hash,
    latestBlockTimestamp: 1n,
    finalizedBlock: 0n,
    finalizedBlockHash: hash,
    finalizedBlockTimestamp: 0n,
    latestL1BlockNumber: 1n,
    latestL1BlockHash: hash,
    observedL1BlockNumber: 1n,
    derivation: { state: "following", sinceUnixMs: 0n },
    finalizedL1BlockNumber: 1n,
    finalizedL1BlockHash: hash,
    stateRoot: hash,
    l1OriginRoot: hash,
    historyRoot: hash,
    outputCount: 0n,
    issuedSoFar: 0n,
    supplyCap: 1_000_000_000n * 10n ** 18n,
    totalSucceeded: 0n,
    totalFailed: 0n,
    totalTransactions: 0n,
    index: { status: "ready", cursor: { blockNumber: 1n, blockHash: hash } },
    proverAssets: null,
    pcashChainId: 1,
    genesisHash,
    acceptedTransactionTypes: [0, 2],
    acceptedBatchVersions: [1],
    l1ChainId: 1n,
    inboxAddress: "0x0000000000000000000000000000000000000001",
    genesisL1Block: 0n,
    genesisL1BlockHash: hash,
    forkCapability: {
      chainId: 1n,
      genesisHash,
      headTimestamp: 1n,
      currentForkCount: 0n,
      currentPrefixHash: hash,
      nextActivationTimestamp: 0n,
      nextPrefixHash: hash,
    },
  };
}

function accepted(): ReceiptResult {
  return {
    contentHash,
    transactionId: word("ac"),
    outcome: "succeeded",
    failureDetail: null,
    l1Sender: "0x0000000000000000000000000000000000000000",
    issuanceOwnerCommitment: null,
    settledOpenFeeAmount: 0n,
    settledIssuanceAmount: 0n,
    kind: "privateValue",
    fundingMode: null,
    inclusion: {
      l1BlockNumber: 1n,
      l1BlockHash: word("cc"),
      l1TransactionIndex: 0n,
      l1TransactionHash: word("7c"),
      batchItemIndex: 0n,
    },
    outputLeafStart: 0n,
    outputsAdded: 0n,
    nullifiers: [],
    account: null,
  };
}

function node() {
  return {
    status: vi.fn(async () => status()),
    submitRawTransaction: vi.fn(async (transactionHex: string) => ({
      contentHash: transactionIdentity(fromHex(transactionHex)).contentHash,
      statementId: word("01"),
      stableId: word("02"),
      status: "ready",
      headCheckedBlock: 1n,
      headCheckedBlockHash: word("22"),
    })),
    getReceipt: vi.fn(async () => [accepted()]),
  } as unknown as PcashNodeClient;
}

/** A transport that reports its bytes as posted to Ethereum without waiting for PCASH. */
function postedToL1(submit?: DurableSubmissionAdapter<undefined, SubmissionOutput>["submit"]): DurableSubmissionAdapter<undefined, SubmissionOutput> {
  return {
    mode: "l1",
    preflight: async () => undefined,
    submit: submit ?? (async () => ({
       accepted: false, queued: false, l1Hash: word("77"), output: { path: "l1" },
    })),
  };
}

describe("mempool submission adapter", () => {
  const openZeroTip = privateValueEntry(0n, 0n);
  const designatedZeroFee = privateValueEntry(0n, 0x1234n);
  const paid = privateValueEntry(1n, 0x1234n);

  it("rechecks PCASH identity before admission", async () => {
    const initial = status("11");
    let admissions = 0;
    const changedNode = {
      status: async () => status("33"),
      submitRawTransaction: async () => {
        admissions += 1;
        throw new Error("must not admit");
      },
    } as unknown as PcashNodeClient;
    const adapter = createMempoolSubmissionAdapter(changedNode);
    const prepared = await adapter.preflight({ transactionBytes: entry, status: initial, retry: false });

    await expect(adapter.submit({ transactionBytes: entry, status: initial, retry: false, prepared }))
      .rejects.toBeInstanceOf(DurablePreBroadcastError);
    expect(admissions).toBe(0);
  });

  it.each([
    ["a zero-fee open-route type 0x00 action", openZeroTip],
    ["a zero-fee designated action", designatedZeroFee],
    ["a zero-fee account operation", entry],
    ["a paid action", paid],
  ])("admits %s and returns without waiting for a receipt", async (_label, bytes) => {
    const relayNode = node();
    const adapter = createMempoolSubmissionAdapter(relayNode);
    expect(adapter.mode).toBe("mempool");
    const prepared = await adapter.preflight({ transactionBytes: bytes, status: status(), retry: false });
    await expect(adapter.submit({ transactionBytes: bytes, status: status(), retry: false, prepared }))
      .resolves.toMatchObject({ accepted: false, queued: true, output: { path: "mempool" } });
    expect(relayNode.submitRawTransaction).toHaveBeenCalledTimes(1);
    expect(relayNode.getReceipt).not.toHaveBeenCalled();
  });

  it("reports only a node's pre-insert refusal as definite", async () => {
    const submitWith = async (cause: Error) => {
      const refusingNode = { ...node(), submitRawTransaction: async () => { throw cause; } } as unknown as PcashNodeClient;
      const adapter = createMempoolSubmissionAdapter(refusingNode);
      const prepared = await adapter.preflight({ transactionBytes: entry, status: status(), retry: false });
      return adapter.submit({ transactionBytes: entry, status: status(), retry: false, prepared });
    };
    const nodeError = (code: number, message: string) =>
      new PcashNodeRpcError({ code, message }, { method: "pcash_submitRawTransaction", url: "http://node" });

    for (const cause of [
      nodeError(-32_011, "invalid transaction: proof rejected"),
      nodeError(-32_017, "transaction is ineligible at the current state: NullifierAlreadySpent"),
    ]) {
      await expect(submitWith(cause)).rejects.toBeInstanceOf(DurablePreBroadcastError);
    }

    for (const cause of [new Error("connection closed after request write"), nodeError(-32_013, "verification unavailable: admission task failed")]) {
      const failure = await submitWith(cause).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(RelayUpstreamError);
      expect((failure as Error).message).toContain(contentHash);
      expect((failure as Error).cause).toBe(cause);
    }
  });

  it("reports a failed status read as an upstream failure before anything is sent", async () => {
    const admitting = { ...node(), status: async () => { throw new Error("connection refused"); } } as unknown as PcashNodeClient;
    const adapter = createMempoolSubmissionAdapter(admitting);
    const prepared = await adapter.preflight({ transactionBytes: entry, status: status(), retry: false });

    const failure = await adapter.submit({ transactionBytes: entry, status: status(), retry: false, prepared }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(DurablePreBroadcastError);
    expect((failure as Error).cause).toBeInstanceOf(RelayUpstreamError);
    expect(admitting.submitRawTransaction).not.toHaveBeenCalled();
  });

  it("rejects a direct account creation before it reaches the mempool", async () => {
    const admitting = { submitRawTransaction: vi.fn() } as unknown as PcashNodeClient;
    const adapter = createMempoolSubmissionAdapter(admitting);
    const raw = encodeUserAccountCreation(1, concatBytes(Uint8Array.of(0), beBytes(1n, 32), beBytes(2n, 32), Uint8Array.of(0), beBytes(3n, 32), beBytes(100n, 8)));
    await expect(adapter.preflight({ transactionBytes: raw, status: status(), retry: false })).rejects.toThrow(/dedicated owner L1/);
    expect(admitting.submitRawTransaction).not.toHaveBeenCalled();
  });
});

describe("awaiting acceptance", () => {
  const submitThrough = async (adapter: DurableSubmissionAdapter<undefined, SubmissionOutput>) =>
    adapter.submit({ transactionBytes: entry, status: status(), retry: false, prepared: undefined });

  it("waits for the PCASH receipt after the transport submits", async () => {
    const relayNode = node();
    const adapter = awaitingAcceptance(postedToL1(), { node: relayNode, pollIntervalMs: 1, pollMaxAttempts: 1 });

    const result = await submitThrough(adapter);

    expect(relayNode.getReceipt).toHaveBeenCalledWith({ contentHash });
    expect(result).toMatchObject({
       accepted: true, queued: false, l1Hash: word("77"),
      output: { path: "l1", contentHash, accepted: true, pcashReceipt: { outcome: "succeeded" } },
    });
  });

  it("keeps the transport's own failure and does not look for a receipt", async () => {
    const relayNode = node();
    const rejection = new Error("quote rejected before broadcast");
    const adapter = awaitingAcceptance(postedToL1(async () => { throw rejection; }), { node: relayNode });

    await expect(submitThrough(adapter)).rejects.toBe(rejection);
    expect(relayNode.getReceipt).not.toHaveBeenCalled();
  });

  it("bounds a never-resolving acceptance request", async () => {
    const relayNode = node();
    vi.mocked(relayNode.getReceipt).mockImplementation(() => new Promise<never>(() => {}));
    const adapter = awaitingAcceptance(postedToL1(), { node: relayNode, timeoutMs: 20 });

    await expect(submitThrough(adapter)).rejects.toBeInstanceOf(RelayDeadlineError);
  });

  it("never reports a failure of the wait as a rejection of bytes already submitted", async () => {
    const relayNode = node();
    vi.mocked(relayNode.getReceipt).mockRejectedValue(
      new PcashNodeRpcError({ code: -32_000, message: "index unavailable" }, { method: "pcash_getReceipt", url: "http://node" }),
    );
    const adapter = awaitingAcceptance(createMempoolSubmissionAdapter(relayNode), { node: relayNode, pollIntervalMs: 1, pollMaxAttempts: 1 });
    const prepared = await adapter.preflight({ transactionBytes: entry, status: status(), retry: false });

    const failure = await adapter.submit({ transactionBytes: entry, status: status(), retry: false, prepared }).catch((error: unknown) => error);

    expect(relayNode.submitRawTransaction).toHaveBeenCalledTimes(1);
    expect(failure).toBeInstanceOf(RelayUpstreamError);
    expect(failure).not.toBeInstanceOf(DurablePreBroadcastError);
    expect(adapter.isDefinitePreBroadcastError?.(failure) ?? false).toBe(false);
  });
});
