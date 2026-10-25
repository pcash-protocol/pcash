import { describe, expect, it, vi } from "vitest";
import { DEFAULT_NETWORK_CONFIG } from "../src/protocol/network.ts";
import { privateKeyPcashActionSigner } from "../src/eip712/authorization.ts";
import { createSelectedRelayQuote } from "../src/eip712/selectedRelayQuote.ts";
import { generateMlKemKeyPair, encryptEnvelope, encodePayload, sizeClassFiller } from "../src/protocol/envelope.ts";
import { dummyNullifier, fullOutputCommitment, noteBodyCommitment, noteNk, nullifier, ownerCommitment } from "../src/protocol/notes.ts";
import { payoutTransactionContext } from "../src/protocol/payout.ts";
import { WIRE_PROOF_BYTES, decodeTransaction, encodeContractAccountCreation, encodePrivateValueTransaction, privateValuePublicInputs, encodeBatchForVersion } from "../src/protocol/codec.ts";
import { buildContractBody, functionSelector } from "../src/protocol/contract.ts";
import { deliveryCommitment, randomArena } from "../src/protocol/transfer.ts";
import { PRIVATE_VALUE_PROFILES } from "../src/constants/privateValueProfiles.ts";
import { inspectPrivateRelayValue } from "../src/relay/selected.ts";
import { Relayer } from "../src/relay/relayer.ts";
import { posterPayoutOpening } from "../src/protocol/payout.ts";
import { keccak256, toHex } from "../src/utils/index.ts";
import { buildNativeTransfer } from "../src/builders/nativeTransfer.ts";
import { transferFixture } from "@pcash/test-support/protocol-fixtures";
import { deriveTestWallet } from "./testWallet.ts";
import type { StatusResult } from "../src/clients/nodeClient.ts";

const key = new Uint8Array(32); key[31] = 19;
const signer = privateKeyPcashActionSigner(key);
const receive = generateMlKemKeyPair(new Uint8Array(64).fill(8));
const other = generateMlKemKeyPair(new Uint8Array(64).fill(9));
const chainId = DEFAULT_NETWORK_CONFIG.pcashChainId;
const nullifiers = [11n, 12n, 13n, 14n];
const status = {
  pcashChainId: Number(chainId), l1ChainId: DEFAULT_NETWORK_CONFIG.l1ChainId,
  inboxAddress: `0x${DEFAULT_NETWORK_CONFIG.inboxAddress.toString(16).padStart(40, "0")}`,
  latestBlockTimestamp: 500n,
} as StatusResult;

async function fixture(amount = 77n, recipientKey = receive.publicKey, bodyOverride?: bigint,
  ordinary?: { amount: bigint; assetId: bigint }, feeSlot = 4) {
  const quote = await createSelectedRelayQuote({
    network: DEFAULT_NETWORK_CONFIG, pcashChainId: chainId, recipient: signer.address,
    nkRoot: 123n, receiveKey: receive.publicKey, privateFeeAmount: 77n,
    transactionContext: payoutTransactionContext(chainId, nullifiers), quoteBinding: 88n,
    maxTransactionBytes: 65_536n,
    validUntilTimestamp: 1000n, signer,
  });
  const noteSecret = 777n;
  const owner = signer.address;
  const envelope = encryptEnvelope(recipientKey, encodePayload({
    chainId, assetId: 0n, amount, owner, noteSecret, outputIndex: feeSlot,
  }));
  const ordinarySecret = 778n;
  const ordinaryEnvelope = ordinary === undefined ? sizeClassFiller() : encryptEnvelope(receive.publicKey, encodePayload({
    chainId, assetId: ordinary.assetId, amount: ordinary.amount, owner, noteSecret: ordinarySecret, outputIndex: 0,
  }));
  const outputData = Array.from({ length: 5 }, () => sizeClassFiller());
  outputData[0] = ordinaryEnvelope;
  outputData[feeSlot] = envelope;
  const body = noteBodyCommitment(ownerCommitment(owner, noteSecret), 0n, amount);
  const ordinaryBody = ordinary === undefined ? 1n
    : noteBodyCommitment(ownerCommitment(owner, ordinarySecret), ordinary.assetId, ordinary.amount);
  const bodies = [ordinaryBody, 2n, 3n, 4n, 5n];
  bodies[feeSlot] = bodyOverride ?? body;
  const arena = randomArena(PRIVATE_VALUE_PROFILES.S.shapeId);
  const publicInputs = [
    chainId, 123n, ...nullifiers, ...bodies,
    deliveryCommitment(outputData, arena), 0n, BigInt(quote.issuanceOwnerCommitment), 0n, 1000n, 0n, 0n,
  ];
  const entry = encodePrivateValueTransaction({
    shape: PRIVATE_VALUE_PROFILES.S.shapeId, publicInputs,
    proof: new Uint8Array(WIRE_PROOF_BYTES), outputData, arena,
  });
  return { entry, quote, body };
}

describe("selected relay private fee inspection", () => {
  const recipient = { address: signer.address, nkRoot: 123n, mlKemSecretKey: receive.secretKey };

  it("values only exact native notes to this relayer and recognizes its issuance commitment", async () => {
    const { entry, quote } = await fixture(77n, receive.publicKey, undefined, { amount: 12n, assetId: 9n });
    expect(inspectPrivateRelayValue({ transactionBytes: entry, status, recipient })).toEqual({
      nativeAmount: 77n, issuanceOwnerCommitment: BigInt(quote.issuanceOwnerCommitment),
      nativeOutputSlots: [4],
    });
    const wrongBody = await fixture(77n, receive.publicKey, 42n);
    expect(inspectPrivateRelayValue({ transactionBytes: wrongBody.entry, status, recipient }).nativeAmount).toBe(0n);
    const wrongRecipient = await fixture(77n, other.publicKey);
    expect(inspectPrivateRelayValue({ transactionBytes: wrongRecipient.entry, status, recipient }).nativeAmount).toBe(0n);
  });

  it("finds a private fee on page 33 of the bounded public mempool", async () => {
    const { entry, quote } = await fixture();
    const contentHash = toHex(keccak256(entry));
    const headHash = `0x${"22".repeat(32)}`;
    const fullStatus = { ...status, latestBlock: 2n, latestBlockHash: headHash,
      acceptedBatchVersions: [1], acceptedTransactionTypes: [0, 1, 2, 3] } as StatusResult;
    const poster = posterPayoutOpening(recipient.address, recipient.nkRoot, 2n);
    const issuanceWord = `0x${BigInt(quote.issuanceOwnerCommitment).toString(16).padStart(64, "0")}`;
    const item = { contentHash, statementId: contentHash, stableId: contentHash, conflictKeys: [],
      kind: "privateValue", fundingMode: null as "unfunded" | null, byteSize: BigInt(entry.length), openFeeAmount: 0n,
      issuanceOwnerCommitment: issuanceWord, issuanceRoute: "designated",
      validUntil: null, status: "ready", conflictCount: 0n, receivedAtUnixMs: 1n,
      headCheckedBlock: 2n, headCheckedBlockHash: headHash, rawTransaction: null };
    const prepareRelay = vi.fn(async (request: { contentHashes: string[]; controlledIssuanceOwnerCommitments: string[] }) => ({
      selectedTransactions: request.contentHashes.map(() => toHex(entry)), selectedContentHashes: request.contentHashes,
      rejected: [], collectibleOpenFee: 0n,
      collectibleQualifyingActions: BigInt(request.contentHashes.length),
      selectedQualifyingActions: BigInt(request.contentHashes.length),
      batchBytes: BigInt(encodeBatchForVersion(request.contentHashes.map(() => entry), 1,
        poster.ownerCommitment, poster.context).length),
      headCheckedBlock: 2n, headCheckedBlockHash: headHash,
    }));
    const irrelevant = Array.from({ length: 3_200 }, (_, index) => ({ ...item,
      contentHash: `0x${(BigInt(index) + 1n).toString(16).padStart(64, "0")}`,
      kind: index % 2 === 0 ? "userAccountCreation" : "contractAccount",
      fundingMode: index % 2 === 0 ? null : "unfunded" as const, issuanceOwnerCommitment: `0x${"00".repeat(32)}`,
      issuanceRoute: "none", receivedAtUnixMs: BigInt(index) + 2n,
    }));
    const pages = Array.from({ length: 32 }, (_, index) => irrelevant.slice(index * 100, (index + 1) * 100));
    pages.push([item] as typeof irrelevant);
    const node = {
      status: vi.fn(async () => fullStatus),
      getMempool: vi.fn(async (query: { cursor?: string } = {}) => {
        const index = query.cursor === undefined ? 0 : Number(query.cursor);
        return { items: pages[index] ?? [], nextCursor: index + 1 < pages.length ? String(index + 1) : null };
      }),
      getMempoolTransaction: vi.fn(async () => ({ ...item, rawTransaction: toHex(entry) })),
      prepareRelay, getReceipt: vi.fn(async () => null),
      getIssuanceQuote: vi.fn(), getBlockEconomics: vi.fn(),
    };
    const submitter = { address: `0x${"aa".repeat(20)}`, supportedCarriers: ["calldata"],
      assertAvailable: vi.fn(async () => undefined),
      inFlight: vi.fn(async () => []),
      quote: vi.fn(async () => ({ selected: { carrier: "calldata", gasLimit: 1n,
        maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, maxFeePerBlobGas: null,
        blobCount: 0, blobVersionedHashes: [], estimatedCostWei: 1n, maximumCostWei: 1n, balanceWei: 2n } })),
      send: vi.fn(),
    };
    const relayer = new Relayer({ payoutRecipient: recipient, node: node as never,
      submitterFor: () => submitter as never });
    const result = await relayer.relay({ noSubmit: true });
    expect(result.requested).toEqual([contentHash]);
    expect(node.getMempool).toHaveBeenCalledTimes(33);
    expect(node.getMempoolTransaction).toHaveBeenCalledTimes(1);
    expect(result.collectiblePrivateFee).toBe(77n);
    expect(prepareRelay).toHaveBeenCalledWith(expect.objectContaining({
      contentHashes: [contentHash],
      controlledIssuanceOwnerCommitments: [],
      controlledIssuanceContentHashes: [contentHash],
    }));
    const belowFloor = new Relayer({ payoutRecipient: recipient, node: node as never,
      submitterFor: () => submitter as never, minPrivateFee: 78n, issuanceHaircutBps: 10_000 });
    expect((await belowFloor.relay({ noSubmit: true })).requested).toEqual([]);
    const bounded = new Relayer({ payoutRecipient: recipient, node: node as never,
      submitterFor: () => submitter as never, maxPages: 32, issuanceHaircutBps: 10_000 });
    expect((await bounded.relay({ noSubmit: true })).requested).toEqual([]);
  });

  it("values a zero-open-fee sponsored contract creation's private relay payment and nothing in an unfunded one", async () => {
    const { entry } = await fixture();
    const decoded = decodeTransaction(entry);
    if (decoded.kind !== 0) throw new Error("type");
    const publicInputs = privateValuePublicInputs(decoded);
    expect(publicInputs[PRIVATE_VALUE_PROFILES.S.offsets.openFeeAmount]).toBe(0n);
    const { body } = buildContractBody({
      nullifierKey: { publishesNkRoot: false, nullifierKeyCommitment: 1n },
      functions: [{ selector: functionSelector(0), applicationVkHash: 2n, configurationCommitment: 3n }],
    });
    publicInputs[PRIVATE_VALUE_PROFILES.S.offsets.issuanceOwner] = 0n;
    const sponsored = encodeContractAccountCreation(chainId, body, {
      mode: "sponsored",
      section: { publicInputs, proof: new Uint8Array(WIRE_PROOF_BYTES), outputData: decoded.outputData, arena: decoded.arena },
    });
    expect(inspectPrivateRelayValue({ transactionBytes: sponsored, status, recipient })).toEqual({
      nativeAmount: 77n, nativeOutputSlots: [4], issuanceOwnerCommitment: null,
    });
    const unfunded = encodeContractAccountCreation(chainId, body, { mode: "unfunded", recentPcashBlockHash: 123n, validUntilTimestamp: 1000n });
    expect(inspectPrivateRelayValue({ transactionBytes: unfunded, status, recipient })).toEqual({
      nativeAmount: 0n, nativeOutputSlots: [], issuanceOwnerCommitment: null,
    });
  });

  it("opens one exact native note independently from the public issuance commitment", async () => {
    const { entry, quote } = await fixture();
    expect(inspectPrivateRelayValue({ transactionBytes: entry, status, recipient })).toEqual({
      nativeAmount: 77n, nativeOutputSlots: [4],
      issuanceOwnerCommitment: BigInt(quote.issuanceOwnerCommitment),
    });
    expect(ownerCommitment(recipient.address, 777n)).not.toBe(BigInt(quote.issuanceOwnerCommitment));
  });

  it("values the actual amount and ignores wrong recipient or proof-bound body", async () => {
    expect(inspectPrivateRelayValue({ transactionBytes: (await fixture(76n)).entry, status, recipient }).nativeAmount).toBe(76n);
    for (const entry of [(await fixture(77n, other.publicKey)).entry,
      (await fixture(77n, receive.publicKey, 42n)).entry]) {
      expect(inspectPrivateRelayValue({ transactionBytes: entry, status, recipient }).nativeAmount).toBe(0n);
    }
  });

  it.each([
    { amount: 77n, assetId: 0n },
    { amount: 12n, assetId: 0n },
    { amount: 77n, assetId: 9n },
  ])("accepts a separate relayer-owned ordinary output (%o)", async (ordinary) => {
    const { entry } = await fixture(77n, receive.publicKey, undefined, ordinary);
    expect(inspectPrivateRelayValue({ transactionBytes: entry, status, recipient })).toMatchObject({
      nativeAmount: 77n + (ordinary.assetId === 0n ? ordinary.amount : 0n),
      nativeOutputSlots: ordinary.assetId === 0n ? [0, 4] : [4],
    });
  });

  it("finds a selected Marketplace-style fee in slot 1 with a dummy tail", async () => {
    const { entry } = await fixture(77n, receive.publicKey, undefined, undefined, 1);
    expect(inspectPrivateRelayValue({ transactionBytes: entry, status, recipient })).toMatchObject({
      nativeAmount: 77n, nativeOutputSlots: [1],
    });
  });

  it("adds exact native notes without requiring a quote-sized individual output", async () => {
    const { entry } = await fixture(40n, receive.publicKey, undefined, { amount: 37n, assetId: 0n });
    expect(inspectPrivateRelayValue({ transactionBytes: entry, status, recipient })).toMatchObject({
      nativeAmount: 77n, nativeOutputSlots: [0, 4],
    });
  });

  it("cannot construct an underfunded selected fee before proving", () => {
    const wallet = deriveTestWallet({ mlKem: "deterministic" });
    const noteSecret = 1234n;
    const dummyInputEntropy = 42n;
    const params = transferFixture({
      chainId, wallet, recipientAddress: signer.address,
      inputAmount: 100n, paymentAmount: 100n, openFeeAmount: 0n, issuanceOwnerCommitment: 0n,
      noteSecret, dummyInputEntropy,
      privateRelayPayment: {
        address: signer.address, amount: 1n, receiveKey: receive.publicKey,
      },
      validUntilTimestamp: 1000n,
    });
    const realCommitment = fullOutputCommitment({ owner: wallet.address, noteSecret, assetId: 0n, amount: 100n }, 0);
    const nullifiers = [nullifier(realCommitment, noteNk(wallet.nkRoot), noteSecret),
      ...[1, 2, 3].map((slot) => dummyNullifier(dummyInputEntropy, slot))];
    const issuanceSecret = 888n;
    expect(() => buildNativeTransfer({
      ...params,
      issuanceOwnerCommitment: ownerCommitment(signer.address, issuanceSecret),
      designatedIssuanceOpening: {
        recipientAddress: signer.address, noteSecret: issuanceSecret,
        transactionContext: payoutTransactionContext(chainId, nullifiers),
      },
    })).toThrow(/sum\(inputs\)/);
  });
});
