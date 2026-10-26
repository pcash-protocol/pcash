import assert from "node:assert/strict";
import { test } from "node:test";
import { bytesToHex, keccak256, numberToHex, type Address, type Hex } from "viem";
import { type PcashNodeClient, type ReceiptResult } from "@pcash/sdk/browser";
import type { WalletExecutionContext } from "@pcash/sdk/wallet";
import { CLAIM_FUNCTION_SELECTOR, RECLAIM_FUNCTION_SELECTOR, paymentCarrierContextHash } from "../src/commitments.mts";
import { buildContractBody, receiveKeyHash, WIRE_PROOF_BYTES } from "@pcash/sdk/protocol";
import { generateMlKemKeyPair } from "@pcash/sdk/browser";
import {
  PaymentTransactionCancelledError,
  PaymentTransactionRevertedError,
  isPaymentConfirmationPending,
  submitRouterCallWithCallbacks,
} from "../src/client/buy.ts";
import {
  MarketplaceController,
  applyPublishCheckpoint,
  assertRecoverablePublicationVerified,
  persistFundedPublication,
  resolveCheckpointedPayment,
  resolveSubmittedPayment,
} from "../src/client/session.ts";
import { offerKey, publicationTerms, type OfferPublication } from "../src/client/publication.ts";
import {
  InMemoryMarketplaceOperationLock,
  marketplaceBuyerOperationKey,
  marketplaceSellerPublicationOperationKey,
  marketplaceSellerReclaimOperationKey,
} from "../src/client/operationLock.ts";
import {
  checkpointPaymentBroadcastRequested,
  checkpointPendingPayment,
  type BuyRecord,
  type MarketplaceStore,
  type PublishRecord,
  type StoredOffer,
} from "../src/client/offerPersistence.ts";
import { anchoredPrivateValueTransaction, BUY_COMMITMENT, escrowSpenderResult } from "./anchoredTransaction.ts";

const FIELD = `0x${"00".repeat(31)}01`;
const ADDRESS = `0x${"01".repeat(20)}`;
// A deadline far enough ahead that new purchases are still open.
const OPEN_DEADLINE = `0x${(4_000_000_000).toString(16).padStart(64, "0")}`;
const BUYER_A = `0x${"02".repeat(20)}`;
const BUYER_B = `0x${"03".repeat(20)}`;
const tx = (byte: string): Hex => `0x${byte.repeat(32)}`;
const BLOCK = tx("b0");
const CONTRACT_TX = tx("10");
const FUNDING_TX = tx("11");
const CLAIM_A_TX = tx("12");
const CLAIM_B_TX = tx("13");
const RECLAIM_TX = tx("14");
const BLOCK_HASH = tx("20");
const GENESIS_HASH = tx("30");
function receiptResult(contentHash: string, kind: ReceiptResult["kind"]): ReceiptResult {
  return {
    transactionId: `0x${"e1".repeat(32)}`,
    contentHash,
    outcome: "succeeded",
    failureDetail: null,
    l1Sender: "0x0000000000000000000000000000000000000000",
    issuanceOwnerCommitment: null,
    settledOpenFeeAmount: 0n,
    settledIssuanceAmount: 0n,
    kind,
    accountCreation: kind === "contractAccount" ? 1 : 0,
    inclusion: { l1BlockNumber: 100n, l1BlockHash: BLOCK_HASH, l1TransactionIndex: 0n, l1TransactionHash: BLOCK_HASH, batchItemIndex: 0n },
    outputLeafStart: kind === "privateValue" ? 1n : null,
    outputsAdded: kind === "privateValue" ? 1n : 0n,
    nullifiers: null,
    account: null,
  };
}
const testIdentity = (address = 2n, chainId = 1n) => ({
  wallet: {
    address: `0x${address.toString(16).padStart(40, "0")}`,
    network: { chainId, genesisHash: GENESIS_HASH },
  },
  l1Signer: {},
}) as never;

function executableIdentity(
  node: PcashNodeClient,
  onExecute: () => void,
) {
  const address = 2n;
  const pair = generateMlKemKeyPair(new Uint8Array(64).fill(26));
  const receiveHash = numberToHex(receiveKeyHash(pair.publicKey), { size: 32 });
  return {
    wallet: {
      address: `0x${address.toString(16).padStart(40, "0")}`,
      network: { chainId: 1n, genesisHash: GENESIS_HASH },
      execute: async (operation: (context: WalletExecutionContext) => unknown) => {
        onExecute();
        return operation({
          node,
          profile: { address, applicationSeed: new Uint8Array(32), nkRoot: 1n },
          signer: { address },
          network: { chainId: 1n, genesisHash: GENESIS_HASH },
          status: { pcashChainId: 1, genesisHash: GENESIS_HASH, l1ChainId: 1n, inboxAddress: 1n },
          store: {
            load: async () => ({ sentOutputs: [], receiveKeys: [{ receiveKeyHash: receiveHash,
              mlKemPublicKey: bytesToHex(pair.publicKey), mlKemSecretKey: bytesToHex(pair.secretKey) }] }),
            readChain: async (read: (chain: unknown) => unknown) => read({ accountResult: () => ({ receiveKeyHash: receiveHash,
              material: { status: "available", mlKem768PublicKey: bytesToHex(pair.publicKey) } }) }),
          },
          spendable: () => true,
        } as never);
      },
    },
    l1Signer: { address: `0x${address.toString(16).padStart(40, "0")}` },
  } as never;
}

const publication: OfferPublication = {
  version: 1,
  chainId: FIELD,
  terms: {
    router: FIELD,
    seller: FIELD,
    id: FIELD,
    assetId: `0x${"00".repeat(32)}`,
    amount: FIELD,
    ethPriceWei: FIELD,
    deadlineT: FIELD,
  },
  l2Contract: {
    bodyHex: bytesToHex(buildContractBody({
      nullifierKey: { publishesNkRoot: true, nkRoot: 1n },
      mlKemPublicKey: generateMlKemKeyPair().publicKey,
      functions: [
        { selector: CLAIM_FUNCTION_SELECTOR, applicationVkHash: 1n, configurationCommitment: 1n },
        { selector: RECLAIM_FUNCTION_SELECTOR, applicationVkHash: 1n, configurationCommitment: 1n },
      ],
    }).body),
    claimConfigurationSalt: FIELD,
    reclaimConfigurationSalt: FIELD,
  },
  reclaimAuthority: ADDRESS,
};
const paidPublication: OfferPublication = { ...publication, escrow: { amount: FIELD, leafIndex: 7, noteSecret: FIELD } };
/** The escrow spender's summary: a claim at T, in Ethereum block 99. */
/** The escrow spend by `contentHash`, a claim for the payment that `BUY_COMMITMENT` names. */
const claimSpend = (contentHash: string) => escrowSpenderResult(contentHash, 99n,
  paymentCarrierContextHash(publicationTerms(paidPublication), BigInt(BUY_COMMITMENT)));
class MemoryStore implements MarketplaceStore {
  private offer: StoredOffer | null;
  constructor(offer: StoredOffer) { this.offer = offer; }
  async list() { return this.offer === null ? [] : [structuredClone(this.offer)]; }
  async get(key: string) { return key === this.offer?.key ? structuredClone(this.offer) : null; }
  async put(offer: StoredOffer) { this.offer = structuredClone(offer); }
  async remove() { throw new Error("unused"); }
  async clear() { throw new Error("unused"); }
  async update(_key: string, operation: (current: StoredOffer | null) => StoredOffer | null) {
    this.offer = structuredClone(operation(structuredClone(this.offer)));
    return structuredClone(this.offer);
  }
}

test("headless Marketplace refresh reconciles publication, every buyer, and reclaim finality", async () => {
  const stored: StoredOffer = {
    key: offerKey(publication),
    pub: publication,
    source: "created",
    savedAt: 1,
    publish: {
      phase: "finalizing",
      fundingOpenFeeBaseUnits: "0",
      fundingContentHash: FUNDING_TX,
      fundingTransactionHex: "0x02",
      updatedAt: 1,
    },
    buys: {
      [BUYER_A]: {
        buyerAddress: BUYER_A, commitment: BUY_COMMITMENT,
        publication: paidPublication,
        txHash: tx("30"),
        blockNumber: "90",
        claimContentHash: CLAIM_A_TX,
        claimTransactionHex: "0x03",
      },
      // An unpaid buyer's record names no claim of the escrow spender's.
      [BUYER_B]: {
        buyerAddress: BUYER_B, commitment: BUY_COMMITMENT,
        publication: paidPublication,
        claimContentHash: CLAIM_B_TX,
        claimTransactionHex: "0x04",
      },
    },
    reclaim: {
      phase: "accepted",
      publication,
      contentHash: RECLAIM_TX,
      transactionHex: "0x05",
      acceptedBlock: "99",
      acceptedBlockHash: tx("99"),
      updatedAt: 1,
    },
  };
  const receipts = new Map<string, ReceiptResult["kind"]>([
    [CONTRACT_TX, "contractAccount"],
    [FUNDING_TX, "privateValue"],
    [RECLAIM_TX, "privateValue"],
  ]);
  const node = {
    getReceipt: async (query: { contentHash: string }) => {
      const contentHash = query.contentHash;
      const kind = receipts.get(contentHash);
      return kind === undefined ? [] : [receiptResult(contentHash, kind)];
    },
    getTransactionByNullifier: async () => claimSpend(CLAIM_A_TX),
    status: async () => ({ finalizedL1BlockNumber: 100n }),
  } as unknown as PcashNodeClient;
  const store = new MemoryStore(stored);
  const result = await new MarketplaceController({ node, store, l1RpcUrls: ["http://l1.invalid"], now: () => 7 }).refresh();
  const reconciled = result.localOffers[0]!;
  assert.equal(result.catalogError?.startsWith("Catalog unavailable"), true);
  assert.equal(reconciled.publish?.phase, "funded");
  assert.equal(reconciled.publish?.fundingTransactionHex, undefined);
  assert.equal(reconciled.buys?.[BUYER_A]?.claimedAt, 7);
  assert.equal(reconciled.buys?.[BUYER_A]?.claimTransactionHex, undefined);
  assert.deepEqual(reconciled.buys?.[BUYER_B], stored.buys![BUYER_B]);
  assert.equal(reconciled.reclaim?.phase, "finalized");
  assert.equal(reconciled.reclaim?.transactionHex, undefined);
  assert.equal(reconciled.reclaim?.finalizedAt, 7);
});

test("headless Marketplace refresh does not re-read a listing's finalized transactions", async () => {
  const stored: StoredOffer = {
    key: offerKey(publication),
    pub: publication,
    source: "created",
    savedAt: 1,
    publish: {
      phase: "funded",
      fundingOpenFeeBaseUnits: "0",
      fundingContentHash: FUNDING_TX,
      fundingAcceptedBlock: "99",
      fundingAcceptedBlockHash: tx("99"),
      fundingFinalizedAt: 5,
      updatedAt: 5,
    },
  };
  const read: string[] = [];
  const node = {
    getReceipt: async (query: { contentHash: string }) => { read.push(query.contentHash); return []; },
    status: async () => ({ finalizedL1BlockNumber: 100n }),
  } as unknown as PcashNodeClient;
  const result = await new MarketplaceController({ node, store: new MemoryStore(stored), l1RpcUrls: ["http://l1.invalid"], now: () => 7 }).refresh();
  assert.deepEqual(read, []);
  assert.deepEqual(result.localOffers[0]?.publish, stored.publish);
});

test("reconciliation preserves checkpoints written while finality RPC reads are in flight", async () => {
  let releaseSpender!: () => void;
  let markSpenderStarted!: () => void;
  const spenderStarted = new Promise<void>((resolve) => { markSpenderStarted = resolve; });
  const spenderGate = new Promise<void>((resolve) => { releaseSpender = resolve; });
  const stored: StoredOffer = {
    key: offerKey(publication),
    pub: publication,
    source: "catalog",
    savedAt: 1,
    buys: {
      [BUYER_A]: {
        buyerAddress: BUYER_A, commitment: BUY_COMMITMENT,
        publication: paidPublication,
        txHash: tx("30"),
        blockNumber: "90",
        claimContentHash: CLAIM_A_TX,
        claimTransactionHex: "0x01",
      },
    },
  };
  const store = new MemoryStore(stored);
  const node = {
    getTransactionByNullifier: async () => {
      markSpenderStarted();
      await spenderGate;
      return claimSpend(CLAIM_A_TX);
    },
    status: async () => ({ finalizedL1BlockNumber: 100n }),
  } as unknown as PcashNodeClient;
  const refresh = new MarketplaceController({ node, store, l1RpcUrls: ["http://l1.invalid"], now: () => 7 }).refresh();
  await spenderStarted;
  await store.update(stored.key, (latest) => ({
    ...latest!,
    buys: {
      ...latest!.buys,
      [BUYER_B]: {
        buyerAddress: BUYER_B, commitment: BUY_COMMITMENT,
        publication: paidPublication,
        claimContentHash: CLAIM_B_TX,
        claimTransactionHex: "0x02",
      },
    },
  }));
  releaseSpender();
  const result = await refresh;
  assert.equal(result.localOffers[0]?.buys?.[BUYER_A]?.claimedAt, 7);
  assert.equal(result.localOffers[0]?.buys?.[BUYER_B]?.claimContentHash, CLAIM_B_TX);
  assert.equal(result.localOffers[0]?.buys?.[BUYER_B]?.claimTransactionHex, "0x02");
});

test("checkpointed payment confirmation is resolved before replacement payment becomes possible", async () => {
  const pendingHash = tx("40");
  const events: string[] = [];
  const pending = checkpointPendingPayment({
    buyerAddress: BUYER_A, commitment: BUY_COMMITMENT,
    publication,
    txHash: tx("39"),
    blockNumber: "79",
    paidAt: 1,
    claimContentHash: tx("38"),
    claimTransactionHex: "0x1234",
  }, pendingHash);
  assert.equal(isPaymentConfirmationPending(pending), true);
  assert.equal(pending.blockNumber, undefined);
  assert.equal(pending.paidAt, undefined);
  const notPast = async () => { events.push("head"); return undefined; };
  const resolved = await resolveCheckpointedPayment({
    buy: pending,
    awaitPending: async (hash) => {
      events.push(`await:${hash}`);
      return { hash, blockNumber: 80n, blockHash: BLOCK };
    },
    recoverCanonical: async (minimumObservedBlock, hash) => {
      assert.equal(hash, pendingHash);
      events.push(`recover:${minimumObservedBlock}`);
      return { hash: pendingHash, blockNumber: 80n, blockHash: BLOCK, paidAt: 1 };
    },
    headPastAttempt: notPast,
  });
  // An attempt whose time limit has not passed on Ethereum is waited on.
  assert.deepEqual(events, ["head", `await:${pendingHash}`, "recover:80"]);
  assert.equal(resolved.payment?.hash, pendingHash);

  const confirmed = {
    buyerAddress: BUYER_A, commitment: BUY_COMMITMENT,
    publication,
    txHash: pendingHash,
    blockNumber: "80",
    paidAt: 1,
  };
  const orphaned = await resolveCheckpointedPayment({
    buy: confirmed,
    awaitPending: async () => { throw new Error("confirmed payment must not be awaited"); },
    recoverCanonical: async (minimumObservedBlock, hash) => {
      assert.equal(hash, pendingHash);
      assert.equal(minimumObservedBlock, 80n);
      return null;
    },
    headPastAttempt: async () => { throw new Error("a confirmed payment is not an open attempt"); },
  });
  assert.equal(orphaned.payment, null);
  assert.deepEqual(orphaned.failedHashes, [pendingHash]);

  // A reverted or cancelled `buy` paid nothing; the router's record decides whether an earlier attempt did.
  const recovered: unknown[] = [];
  const reverted = await resolveCheckpointedPayment({
    buy: { buyerAddress: BUYER_A, commitment: BUY_COMMITMENT, publication, txHash: pendingHash },
    awaitPending: async () => { throw new PaymentTransactionRevertedError("buy", pendingHash, 81n); },
    recoverCanonical: async (minimumObservedBlock, hash) => { recovered.push([minimumObservedBlock, hash]); return null; },
    headPastAttempt: notPast,
  });
  assert.equal(reverted.payment, null);
  assert.deepEqual(reverted.failedHashes, [pendingHash]);
  assert.deepEqual(recovered, [[81n, undefined]]);
  const earlier = await resolveCheckpointedPayment({
    buy: { buyerAddress: BUYER_A, commitment: BUY_COMMITMENT, publication, txHash: pendingHash },
    awaitPending: async () => { throw new PaymentTransactionRevertedError("buy", pendingHash, 81n); },
    recoverCanonical: async () => ({ hash: tx("39"), blockNumber: 79n, blockHash: BLOCK, paidAt: 1 }),
    headPastAttempt: notPast,
  });
  assert.equal(earlier.payment?.hash, tx("39"));

  const replacementHash = tx("41");
  const cancelled = await resolveCheckpointedPayment({
    buy: { buyerAddress: BUYER_A, commitment: BUY_COMMITMENT, publication, txHash: pendingHash },
    awaitPending: async () => {
      throw new PaymentTransactionCancelledError("buy", pendingHash, replacementHash, 81n);
    },
    recoverCanonical: async (_minimumObservedBlock, hash) => { assert.equal(hash, undefined); return null; },
    headPastAttempt: notPast,
  });
  assert.deepEqual(cancelled.failedHashes, [pendingHash, replacementHash]);

  await assert.rejects(resolveCheckpointedPayment({
    buy: { buyerAddress: BUYER_A, commitment: BUY_COMMITMENT, publication, txHash: pendingHash },
    awaitPending: async (hash) => ({ hash, blockNumber: 80n, blockHash: BLOCK }),
    recoverCanonical: async () => null,
    headPastAttempt: notPast,
  }), /not the canonical router payment/);

  await assert.rejects(resolveCheckpointedPayment({
    buy: { buyerAddress: BUYER_A, commitment: BUY_COMMITMENT, publication, txHash: pendingHash },
    awaitPending: async () => { throw new Error("receipt timeout"); },
    recoverCanonical: async () => null,
    headPastAttempt: notPast,
  }), /has not landed yet\. Another payment is not sent until this attempt's time limit has passed on Ethereum/);

  // Once the Ethereum head is past the attempt's time limit, the router's record at that head decides, without waiting.
  let lapsedMinimum: bigint | undefined;
  const lapsed = await resolveCheckpointedPayment({
    buy: { buyerAddress: BUYER_A, commitment: BUY_COMMITMENT, publication, txHash: pendingHash },
    awaitPending: async () => { throw new Error("a lapsed attempt is not waited on"); },
    recoverCanonical: async (minimumObservedBlock) => { lapsedMinimum = minimumObservedBlock; return null; },
    headPastAttempt: async () => 90n,
  });
  assert.equal(lapsed.payment, null);
  assert.deepEqual(lapsed.failedHashes, [pendingHash]);
  assert.equal(lapsedMinimum, 90n);

  const unrelatedReplacement = tx("42");
  let replacementMinimum: bigint | undefined;
  const replaced = await resolveCheckpointedPayment({
    buy: pending,
    awaitPending: async () => ({
      hash: unrelatedReplacement,
      originalHash: pendingHash,
      blockNumber: 82n,
      blockHash: BLOCK,
      replacementReason: "replaced",
    }),
    recoverCanonical: async (minimumObservedBlock, hash) => {
      assert.equal(hash, unrelatedReplacement);
      replacementMinimum = minimumObservedBlock;
      return null;
    },
    headPastAttempt: notPast,
  });
  assert.equal(replaced.payment, null);
  assert.deepEqual(replaced.failedHashes, [pendingHash, unrelatedReplacement]);
  assert.equal(replacementMinimum, 82n);

  const canonicalHash = tx("43");
  const recoveredReplacement = await resolveCheckpointedPayment({
    buy: pending,
    awaitPending: async () => ({
      hash: unrelatedReplacement,
      originalHash: pendingHash,
      blockNumber: 82n,
      blockHash: BLOCK,
      replacementReason: "replaced",
    }),
    recoverCanonical: async () => ({ hash: canonicalHash, blockNumber: 83n, blockHash: BLOCK, paidAt: 2 }),
    headPastAttempt: notPast,
  });
  assert.equal(recoveredReplacement.payment?.hash, canonicalHash);

  const ambiguous = {
    buyerAddress: BUYER_A, commitment: BUY_COMMITMENT,
    publication,
    paymentBroadcastRequestedAt: 1,
  };
  await assert.rejects(resolveCheckpointedPayment({
    buy: ambiguous,
    awaitPending: async () => { throw new Error("an ambiguous broadcast has no checkpointed hash"); },
    recoverCanonical: async () => { throw new Error("an attempt within its time limit is not recovered"); },
    headPastAttempt: notPast,
  }), /no payment is visible yet\. Another payment is not sent until this attempt's time limit has passed on Ethereum/);
  const recoveredAmbiguous = await resolveCheckpointedPayment({
    buy: ambiguous,
    awaitPending: async () => { throw new Error("an ambiguous broadcast has no checkpointed hash"); },
    recoverCanonical: async () => ({ hash: canonicalHash, blockNumber: 83n, blockHash: BLOCK, paidAt: 2 }),
    headPastAttempt: async () => 90n,
  });
  assert.equal(recoveredAmbiguous.payment?.hash, canonicalHash);
  // An attempt with no hash that can no longer pay leaves nothing to fail but the attempt itself.
  const lapsedAmbiguous = await resolveCheckpointedPayment({
    buy: ambiguous,
    awaitPending: async () => { throw new Error("an ambiguous broadcast has no checkpointed hash"); },
    recoverCanonical: async () => null,
    headPastAttempt: async () => 90n,
  });
  assert.deepEqual(lapsedAmbiguous, { payment: null, failedHashes: [] });

  let submittedMinimum: bigint | undefined;
  const submittedReplacement = await resolveSubmittedPayment({
    submitted: {
      hash: unrelatedReplacement,
      originalHash: pendingHash,
      blockNumber: 82n,
      blockHash: BLOCK,
      replacementReason: "replaced",
    },
    recoverCanonical: async (minimumObservedBlock) => {
      submittedMinimum = minimumObservedBlock;
      return null;
    },
  });
  assert.deepEqual(submittedReplacement.failedHashes, [pendingHash, unrelatedReplacement]);
  assert.equal(submittedMinimum, 82n);
});

test("a broadcasted payment with a failed hash checkpoint stays fail-closed across restart", async () => {
  let saved: BuyRecord = {
    buyerAddress: BUYER_A, commitment: BUY_COMMITMENT,
    publication,
  };
  let signerCalls = 0;
  const paymentHash = tx("88");
  await assert.rejects(submitRouterCallWithCallbacks({
    address: BUYER_A as Address,
    chainId: async () => 1n,
    sendTransaction: async () => {
      signerCalls += 1;
      return paymentHash;
    },
  }, 1n, {
    to: ADDRESS as Address,
    data: "0x",
    value: 1n,
    gas: 1n,
  }, {
    onBroadcastRequested: () => { saved = checkpointPaymentBroadcastRequested(saved, 1); },
    onSent: () => { throw new Error("IndexedDB hash checkpoint failed"); },
  }), /IndexedDB hash checkpoint failed/);
  assert.equal(signerCalls, 1);
  assert.equal(saved.paymentBroadcastRequestedAt, 1);
  assert.equal(saved.txHash, undefined);

  let headReads = 0;
  await assert.rejects(resolveCheckpointedPayment({
    buy: structuredClone(saved),
    awaitPending: async () => { throw new Error("ambiguous payment has no checkpointed hash"); },
    recoverCanonical: async () => null,
    headPastAttempt: async () => {
      headReads += 1;
      return undefined;
    },
  }), /no payment is visible yet\. Another payment is not sent until/);
  assert.equal(headReads, 1);
  assert.equal(signerCalls, 1);

  const recovered = await resolveCheckpointedPayment({
    buy: structuredClone(saved),
    awaitPending: async () => { throw new Error("ambiguous payment has no checkpointed hash"); },
    recoverCanonical: async () => ({ hash: paymentHash, blockNumber: 83n, blockHash: BLOCK, paidAt: 2 }),
    headPastAttempt: async () => 90n,
  });
  assert.equal(recovered.payment?.hash, paymentHash);
});

test("late publication checkpoints cannot regress finalized legs", () => {
  const finalized: StoredOffer = {
    key: offerKey(publication),
    pub: publication,
    source: "created",
    savedAt: 1,
    publish: {
      phase: "finalizing",
      fundingContentHash: FUNDING_TX,
      fundingTransactionHex: "0xfunding",
      updatedAt: 2,
    },
  };
  const merged = applyPublishCheckpoint(finalized, {
    fundingContentHash: FUNDING_TX,
    fundingTransactionHex: "0xfunding",
  }, 3);
  assert.equal(merged.publish?.fundingTransactionHex, "0xfunding");
  assert.equal(merged.publish?.phase, "funding-submitted");
});

test("buyer and seller operation keys scope every resumable value-moving workflow", () => {
  assert.match(marketplaceBuyerOperationKey(1, "offer", BUYER_A), /^buy:1:offer:/);
  assert.match(marketplaceSellerPublicationOperationKey(1, "offer", 2n), /^publish:1:offer:/);
  assert.match(marketplaceSellerReclaimOperationKey(1, offerKey(publication), 2n), /^reclaim:1:/);
});

test("controller scopes seller work only from the connected Wallet identity", async () => {
  const keys: string[] = [];
  const controller = new MarketplaceController({
    node: {} as PcashNodeClient,
    store: new MemoryStore({ key: offerKey(publication), pub: publication, source: "created", savedAt: 1 }),
    l1RpcUrls: ["http://unused"],
    identity: testIdentity(2n, 7n),
    operationLock: {
      async run<T>(key: string): Promise<T> {
        keys.push(key);
        return "locked" as T;
      },
    },
  });

  assert.equal(await controller.reclaim(publication, 0n), "locked");
  assert.deepEqual(keys, [marketplaceSellerReclaimOperationKey(7, offerKey(publication), 2n)]);
});

test("controller rejects a zero-price offer before creating or funding seller state", async () => {
  const controller = new MarketplaceController({
    node: {} as PcashNodeClient,
    store: new MemoryStore({ key: offerKey(publication), pub: publication, source: "created", savedAt: 1 }),
    l1RpcUrls: ["http://unused"],
  });
  await assert.rejects(controller.createAndPublish({
    assetId: 0n,
    amount: 1n,
    ethPriceWei: 0n,
    purchaseMinutes: 1n,
    fundingOpenFeeAmount: 0n,
  }), /ETH price must be greater than zero/);
});

test("controller refuses another payment while a checkpointed one has no canonical outcome", async () => {
  const buyerAddress = `0x${2n.toString(16).padStart(40, "0")}`;
  const amount = `0x${"00".repeat(31)}0a`;
  const fundedPublication: OfferPublication = {
    ...publication,
    terms: { ...publication.terms, amount },
    escrow: { amount, leafIndex: 7, noteSecret: FIELD },
  };
  const node = {} as PcashNodeClient;
  const store = new MemoryStore({
    key: offerKey(fundedPublication),
    pub: fundedPublication,
    source: "catalog",
    savedAt: 1,
    buys: {
      [buyerAddress]: {
        buyerAddress,
        publication: fundedPublication,
        commitment: BUY_COMMITMENT,
        txHash: tx("77"),
        claimContentHash: tx("78"),
        claimTransactionHex: "0x01",
        claimNotAfter: "1000",
      },
    },
  });
  const controller = new MarketplaceController({
    node,
    store,
    l1RpcUrls: ["http://unused"],
    configuredRouter: {
      address: `0x${"00".repeat(19)}01`,
    },
    identity: executableIdentity(node, () => undefined),
  });
  // The Ethereum head is not past the attempt's time limit, and its receipt does not come.
  const internals = controller as unknown as { recoverPayment: () => Promise<null>; headPastBuyAttempt: () => Promise<undefined>; awaitRouterCall: () => Promise<never> };
  internals.recoverPayment = async () => null;
  internals.headPastBuyAttempt = async () => undefined;
  internals.awaitRouterCall = async () => { throw new Error("receipt timeout"); };

  await assert.rejects(
    controller.buy(fundedPublication),
    /has not landed yet\. Another payment is not sent until this attempt's time limit has passed on Ethereum/,
  );
  assert.equal((await store.get(offerKey(fundedPublication)))?.buys?.[buyerAddress]?.txHash, tx("77"));
});

test("controller stops when the Wallet rejects a live network change", async () => {
  const identity = testIdentity() as {
    wallet: { execute: () => Promise<never> };
  };
  identity.wallet.execute = async () => {
    throw new Error("wallet node no longer matches the bound network");
  };
  const controller = new MarketplaceController({
    node: {} as PcashNodeClient,
    store: new MemoryStore({ key: offerKey(publication), pub: publication, source: "created", savedAt: 1 }),
    l1RpcUrls: ["http://unused"],
    identity: identity as never,
  });

  await assert.rejects(
    controller.reclaim(publication, 0n),
    /wallet node no longer matches the bound network/,
  );
});

test("connected reconciliation uses the Wallet-bound node", async () => {
  let executeCalls = 0;
  const walletNode = {
    getReceipt: async () => { throw new Error("wallet node used"); },
  } as unknown as PcashNodeClient;
  const controllerNode = {
    getReceipt: async () => { throw new Error("controller node used"); },
  } as unknown as PcashNodeClient;
  const stored: StoredOffer = {
    key: offerKey(publication),
    pub: publication,
    source: "created",
    savedAt: 1,
    publish: {
      phase: "funding-submitted",
      fundingContentHash: FUNDING_TX,
      updatedAt: 1,
    },
  };
  const controller = new MarketplaceController({
    node: controllerNode,
    store: new MemoryStore(stored),
    l1RpcUrls: ["http://unused"],
    identity: executableIdentity(walletNode, () => { executeCalls += 1; }),
  });

  await assert.rejects(controller.refresh(), /wallet node used/);
  assert.equal(executeCalls, 1);
});

test("fresh reclaim uses the Wallet-bound node", async () => {
  let executeCalls = 0;
  const walletNode = {
    status: async () => { throw new Error("wallet node used"); },
  } as unknown as PcashNodeClient;
  const controllerNode = {
    status: async () => { throw new Error("controller node used"); },
  } as unknown as PcashNodeClient;
  const controller = new MarketplaceController({
    node: controllerNode,
    store: new MemoryStore({ key: offerKey(publication), pub: publication, source: "created", savedAt: 1 }),
    l1RpcUrls: ["http://unused"],
    identity: executableIdentity(walletNode, () => { executeCalls += 1; }),
    prover: async () => ({} as never),
  });

  await assert.rejects(controller.reclaim(publication, 0n), /wallet node used/);
  assert.equal(executeCalls, 1);
});

test("prepared reclaim resumes through the Wallet-bound node", async () => {
  let executeCalls = 0;
  const walletNode = {
    getReceipt: async () => { throw new Error("wallet node used"); },
  } as unknown as PcashNodeClient;
  const controllerNode = {
    getReceipt: async () => { throw new Error("controller node used"); },
  } as unknown as PcashNodeClient;
  const transactionHex = "0x05" as Hex;
  const contentHash = keccak256(transactionHex);
  const stored: StoredOffer = {
    key: offerKey(publication),
    pub: publication,
    source: "created",
    savedAt: 1,
    reclaim: {
      phase: "prepared",
      publication,
      contentHash,
      transactionHex,
      updatedAt: 1,
    },
  };
  const controller = new MarketplaceController({
    node: controllerNode,
    store: new MemoryStore(stored),
    l1RpcUrls: ["http://unused"],
    identity: executableIdentity(walletNode, () => { executeCalls += 1; }),
  });

  await assert.rejects(controller.reclaim(publication, 0n), /wallet node used/);
  assert.equal(executeCalls, 1);
});

const RECLAIM_ANCHOR = 0x5151n;
const RECLAIM_ANCHOR_HEX = numberToHex(RECLAIM_ANCHOR, { size: 32 });
const LATEST_TIMESTAMP = 10_000n;
const RECLAIM_STATUS = {
  pcashChainId: 1,
  genesisHash: GENESIS_HASH,
  acceptedTransactionTypes: [0, 1, 2, 3],
  acceptedBatchVersions: [1],
  latestBlockTimestamp: LATEST_TIMESTAMP,
};

function preparedReclaimStore(transactionHex: Hex): MemoryStore {
  return new MemoryStore({
    key: offerKey(publication),
    pub: publication,
    source: "created",
    savedAt: 1,
    reclaim: {
      phase: "prepared",
      publication,
      contentHash: keccak256(transactionHex),
      transactionHex,
      openFeeBaseUnits: "9",
      updatedAt: 1,
    },
  });
}

test("a prepared reclaim whose anchor was orphaned is discarded and the reclaim is proved again", async () => {
  const transactionHex = bytesToHex(anchoredPrivateValueTransaction(RECLAIM_ANCHOR));
  const events: string[] = [];
  const walletNode = {
    // A fresh reclaim's first read is the node status, after the saved anchor was judged.
    status: async () => {
      if (!events.includes("anchor:saved")) return RECLAIM_STATUS;
      events.push("prove");
      throw new Error("fresh reclaim proof requested");
    },
    getReceipt: async () => {
      events.push("receipt");
      return [];
    },
    getBlockByHash: async (hash: string) => {
      events.push(`anchor:${hash === RECLAIM_ANCHOR_HEX ? "saved" : "other"}`);
      return null;
    },
    getMempoolTransaction: async () => { throw new Error("stale bytes must not be probed"); },
    submitRawTransaction: async () => { throw new Error("stale bytes must not be admitted"); },
  } as unknown as PcashNodeClient;
  const store = preparedReclaimStore(transactionHex);
  const controller = new MarketplaceController({
    node: {} as PcashNodeClient,
    store,
    l1RpcUrls: ["http://unused"],
    identity: executableIdentity(walletNode, () => undefined),
    prover: async () => ({} as never),
    now: () => 7,
  });

  await assert.rejects(controller.reclaim(publication, 0n), /fresh reclaim proof requested/);
  assert.deepEqual(events, ["receipt", "anchor:saved", "prove"]);
  assert.deepEqual((await store.get(offerKey(publication)))?.reclaim, {
    phase: "idle",
    publication,
    openFeeBaseUnits: "9",
    updatedAt: 7,
  });
});

test("a prepared reclaim whose anchor is still canonical resumes its exact bytes without proving", async () => {
  const transactionHex = bytesToHex(anchoredPrivateValueTransaction(RECLAIM_ANCHOR));
  const walletNode = {
    status: async () => RECLAIM_STATUS,
    getReceipt: async () => [],
    getBlockByHash: async () => ({ hash: RECLAIM_ANCHOR_HEX, timestamp: LATEST_TIMESTAMP - 1n }),
    getMempoolTransaction: async () => { throw new Error("resume continued to the mempool"); },
    getAccountProof: async () => { throw new Error("a live reclaim must not be proved again"); },
  } as unknown as PcashNodeClient;
  const store = preparedReclaimStore(transactionHex);
  const controller = new MarketplaceController({
    node: {} as PcashNodeClient,
    store,
    l1RpcUrls: ["http://unused"],
    identity: executableIdentity(walletNode, () => undefined),
    prover: async () => ({} as never),
  });

  await assert.rejects(controller.reclaim(publication, 0n), /resume continued to the mempool/);
  const retained = (await store.get(offerKey(publication)))?.reclaim;
  assert.equal(retained?.phase, "prepared");
  assert.equal(retained?.transactionHex, transactionHex);
});

test("an RPC failure while judging a saved reclaim anchor leaves the prepared bytes in place", async () => {
  const transactionHex = bytesToHex(anchoredPrivateValueTransaction(RECLAIM_ANCHOR));
  const walletNode = {
    status: async () => RECLAIM_STATUS,
    getReceipt: async () => [],
    getBlockByHash: async () => { throw new Error("node unreachable"); },
    getAccountProof: async () => { throw new Error("an undecided reclaim must not be proved again"); },
  } as unknown as PcashNodeClient;
  const store = preparedReclaimStore(transactionHex);
  const controller = new MarketplaceController({
    node: {} as PcashNodeClient,
    store,
    l1RpcUrls: ["http://unused"],
    identity: executableIdentity(walletNode, () => undefined),
    prover: async () => ({} as never),
  });

  await assert.rejects(controller.reclaim(publication, 0n), /node unreachable/);
  const retained = (await store.get(offerKey(publication)))?.reclaim;
  assert.equal(retained?.phase, "prepared");
  assert.equal(retained?.transactionHex, transactionHex);
});

test("controller enters the seller lock before reclaim or publication resume work", async () => {
  const keys: string[] = [];
  const operationLock = {
    async run<T>(key: string): Promise<T> {
      keys.push(key);
      return "locked" as T;
    },
  };
  const controller = new MarketplaceController({
    node: {} as PcashNodeClient,
    store: new MemoryStore({ key: offerKey(publication), pub: publication, source: "created", savedAt: 1 }),
    l1RpcUrls: ["http://unused"],
    identity: testIdentity(),
    operationLock,
  });
  assert.equal(await controller.reclaim(publication, 0n), "locked");
  assert.equal(await controller.resumePublication(publication), "locked");
  assert.deepEqual(keys, [
    marketplaceSellerReclaimOperationKey(1, offerKey(publication), 2n),
    marketplaceSellerPublicationOperationKey(1, offerKey(publication), 2n),
  ]);
});

for (const missing of ["fundingOpenFeeBaseUnits"] as const) {
  test(`publication resume requires the saved ${missing}`, async () => {
    const publish: PublishRecord = { phase: "draft", fundingOpenFeeBaseUnits: "1", updatedAt: 1 };
    delete publish[missing];
    const node = {} as PcashNodeClient;
    const controller = new MarketplaceController({
      node,
      store: new MemoryStore({ key: offerKey(publication), pub: publication, source: "created", savedAt: 1, publish }),
      l1RpcUrls: ["http://unused"],
      identity: executableIdentity(node, () => {}),
    });
    await assert.rejects(controller.resumePublication(publication), /no relayer fees/);
  });
}

/** A listing whose funding was skipped because transaction `spender`, included at `spenderBlock`, had spent its input. */
function conflictedFunding(spenderBlock: bigint) {
  const key = offerKey(publication);
  const spenderId = tx("40");
  const store = new MemoryStore({ key, pub: publication, source: "created", savedAt: 1, publish: {
    phase: "funding-submitted", fundingOpenFeeBaseUnits: "0",
    fundingContentHash: FUNDING_TX, fundingTransactionHex: "0x02", updatedAt: 1,
  } });
  const node = {
    getReceipt: async (query: string | { contentHash: string }) => {
      if (query === spenderId) return [{ ...receiptResult(tx("41"), "privateValue"), transactionId: spenderId,
        inclusion: { ...receiptResult(tx("41"), "privateValue").inclusion, l1BlockNumber: spenderBlock } }];
      if (typeof query !== "string" && query.contentHash === CONTRACT_TX) return [receiptResult(CONTRACT_TX, "contractAccount")];
      if (typeof query !== "string" && query.contentHash === FUNDING_TX) return [{ ...receiptResult(FUNDING_TX, "privateValue"),
        outcome: "nullifierAlreadySpent", outputLeafStart: null, outputsAdded: 0n,
        failureDetail: { type: "nullifierAlreadySpent", inputSlot: 0n, nullifier: tx("42"), spendingTransactionId: spenderId } }];
      return [];
    },
    status: async () => ({ finalizedL1BlockNumber: 100n }),
  } as unknown as PcashNodeClient;
  return { key, store, node };
}

test("background reconciliation retains failed funding for the wallet's explicit resume decision", async () => {
  const { key, store, node } = conflictedFunding(100n);
  const publish = (await new MarketplaceController({ node, store, l1RpcUrls: ["http://l1.invalid"], now: () => 7 }).refresh()).localOffers[0]!.publish!;
  assert.equal(publish.phase, "funding-submitted");
  assert.equal(publish.fundingContentHash, FUNDING_TX);
  assert.equal(publish.fundingTransactionHex, "0x02");
  await assert.rejects(new MarketplaceController({ node, store, l1RpcUrls: ["http://l1.invalid"], identity: testIdentity() }).discardUnfundedPublication(publication), /funding has started/);
  assert.notEqual(await store.get(key), null);
});

test("a listing keeps funding whose input was spent by a transaction that is not yet final", async () => {
  const { key, store, node } = conflictedFunding(101n);
  const publish = (await new MarketplaceController({ node, store, l1RpcUrls: ["http://l1.invalid"], now: () => 7 }).refresh()).localOffers[0]!.publish!;
  assert.equal(publish.phase, "funding-submitted");
  assert.equal(publish.fundingContentHash, FUNDING_TX);
  assert.equal(publish.fundingTransactionHex, "0x02");
  assert.equal((await store.get(key))?.publish?.fundingContentHash, FUNDING_TX);
});

test("resuming retains saved funding until the wallet permits replacement", async () => {
  const { key, store, node } = conflictedFunding(100n);
  const controller = new MarketplaceController({ node, store, l1RpcUrls: ["http://l1.invalid"], identity: executableIdentity(node, () => {}) });
  // The fixture publication cannot be reconstructed; resumption fails only after reconciling.
  await assert.rejects(controller.resumePublication(publication));
  assert.equal((await store.get(key))?.publish?.fundingContentHash, FUNDING_TX);
});

test("discarding an unfunded listing re-reads it under the seller publication lock", async () => {
  const key = offerKey(publication);
  const unfunded: StoredOffer = { key, pub: publication, source: "created", savedAt: 1,
    publish: { phase: "draft", updatedAt: 1 } };
  let stored: StoredOffer | null = { ...unfunded, publish: { ...unfunded.publish!, phase: "funding-submitted", fundingContentHash: FUNDING_TX } };
  const store = {
    update: async (_key: string, operation: (current: StoredOffer | null) => StoredOffer | null) => (stored = operation(structuredClone(stored))),
  } as unknown as MarketplaceStore;
  const keys: string[] = [];
  const controller = new MarketplaceController({
    node: {} as PcashNodeClient,
    store,
    l1RpcUrls: ["http://unused"],
    identity: testIdentity(),
    operationLock: { run: async <T>(lockKey: string, operation: () => Promise<T>) => { keys.push(lockKey); return operation(); } },
  });
  // Another tab started funding after this one showed the listing as unfunded.
  await assert.rejects(controller.discardUnfundedPublication(publication), /escrow funding has started/);
  assert.equal(stored?.publish?.fundingContentHash, FUNDING_TX);
  stored = unfunded;
  await controller.discardUnfundedPublication(publication);
  assert.equal(stored, null);
  assert.deepEqual(keys, Array(2).fill(marketplaceSellerPublicationOperationKey(1, key, 2n)));
});

test("a reclaim for another publication cannot replace an active journal", async () => {
  const stored: StoredOffer = {
    key: offerKey(publication),
    pub: publication,
    source: "created",
    savedAt: 1,
    reclaim: {
      phase: "prepared",
      publication,
      contentHash: RECLAIM_TX,
      transactionHex: "0x05",
      updatedAt: 1,
    },
  };
  const replacement: OfferPublication = {
    ...publication,
    escrow: { amount: FIELD, leafIndex: 7, noteSecret: `0x${"00".repeat(31)}02` },
  };
  const store = new MemoryStore(stored);
  const controller = new MarketplaceController({
    node: {} as PcashNodeClient,
    store,
    l1RpcUrls: ["http://unused"],
    identity: testIdentity(),
  });
  await assert.rejects(
    controller.reclaim(replacement, 0n),
    /active reclaim already belongs to another escrow publication/,
  );
  assert.equal((await store.get(stored.key))?.reclaim?.contentHash, RECLAIM_TX);
});

test("a finalized reclaim returns its durable transaction without proving again", async () => {
  const stored: StoredOffer = {
    key: offerKey(publication),
    pub: publication,
    source: "created",
    savedAt: 1,
    reclaim: {
      phase: "finalized",
      publication,
      contentHash: RECLAIM_TX,
      finalizedAt: 2,
      updatedAt: 2,
    },
  };
  const store = new MemoryStore(stored);
  const controller = new MarketplaceController({
    node: {} as PcashNodeClient,
    store,
    l1RpcUrls: ["http://unused"],
    identity: testIdentity(),
    prover: async () => { throw new Error("finalized reclaim must not prove again"); },
  });
  assert.equal(await controller.reclaim(publication, 0n), RECLAIM_TX);
  assert.deepEqual(await store.get(stored.key), stored);
});

test("value-moving operations with the same key are single-flight", async () => {
  const lock = new InMemoryMarketplaceOperationLock();
  let releaseFirst!: () => void;
  let markFirstStarted!: () => void;
  const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const events: string[] = [];
  const key = marketplaceSellerReclaimOperationKey(1, offerKey(publication), 2n);
  const first = lock.run(key, async () => {
    events.push("first:start");
    markFirstStarted();
    await firstGate;
    events.push("first:end");
  });
  await firstStarted;
  const second = lock.run(key, async () => { events.push("second"); });
  await Promise.resolve();
  assert.deepEqual(events, ["first:start"]);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(events, ["first:start", "first:end", "second"]);
});

test("a recovered payment cannot bind an unverified publication variant", () => {
  const verified = {
    l2ContractVerification: "verified" as const,
    functionsBound: true,
    chainMatches: true,
    routerPinned: true,
    routerConfigVerified: true,
    liveOnNode: true,
    escrow: "escrowed" as const,
    claimSnapshot: null,
    feeQuote: null,
    routerPaid: null,
    safeToPay: false,
    checks: ["exact funded variant"],
  };
  assert.doesNotThrow(() => assertRecoverablePublicationVerified(verified));
  assert.throws(
    () => assertRecoverablePublicationVerified({ ...verified, escrow: "unknown", checks: ["poisoned opening"] }),
    /not a live funded offer: poisoned opening/,
  );
});

test("funded publication survives catalog failure and catalog publication remains retryable", async () => {
  const draft: StoredOffer = {
    key: offerKey(publication),
    pub: publication,
    source: "created",
    savedAt: 1,
    publish: { phase: "funding-submitted", fundingOpenFeeBaseUnits: "0", updatedAt: 1 },
  };
  const fundedPublication: OfferPublication = {
    ...publication,
    escrow: { amount: FIELD, leafIndex: 7, noteSecret: FIELD },
  };
  const store = new MemoryStore(draft);
  const failed = await persistFundedPublication({
    store,
    key: draft.key,
    draft,
    publication: fundedPublication,
    now: () => 2,
    publishCatalog: async () => { throw new Error("catalog disabled"); },
  });
  assert.equal(failed.catalogPublished, false);
  assert.equal((await store.get(draft.key))?.pub.escrow?.leafIndex, 7);
  assert.equal((await store.get(draft.key))?.publish?.catalogError, "catalog disabled");

  let releaseCatalog!: () => void;
  let markCatalogStarted!: () => void;
  const catalogStarted = new Promise<void>((resolve) => { markCatalogStarted = resolve; });
  const catalogGate = new Promise<void>((resolve) => { releaseCatalog = resolve; });
  const retry = persistFundedPublication({
    store,
    key: draft.key,
    draft,
    publication: fundedPublication,
    now: () => 3,
    publishCatalog: async () => {
      markCatalogStarted();
      await catalogGate;
    },
  });
  await catalogStarted;
  await store.update(draft.key, (latest) => ({
    ...latest!,
    buys: {
      ...(latest!.buys ?? {}),
      [BUYER_B]: { buyerAddress: BUYER_B, commitment: BUY_COMMITMENT, publication: fundedPublication },
    },
  }));
  releaseCatalog();
  const retried = await retry;
  assert.equal(retried.catalogPublished, true);
  assert.equal((await store.get(draft.key))?.publish?.catalogPublishedAt, 3);
  assert.equal((await store.get(draft.key))?.publish?.catalogError, undefined);
  assert.deepEqual((await store.get(draft.key))?.buys?.[BUYER_B], { buyerAddress: BUYER_B, commitment: BUY_COMMITMENT, publication: fundedPublication });

  const replacementPublication: OfferPublication = {
    ...fundedPublication,
    escrow: { ...fundedPublication.escrow!, noteSecret: `0x${"00".repeat(31)}02` },
  };
  await store.update(draft.key, (latest) => ({
    ...latest!,
    reclaim: {
      phase: "prepared",
      publication: fundedPublication,
      contentHash: RECLAIM_TX,
      transactionHex: "0x99",
      openFeeBaseUnits: "4",
      updatedAt: 3,
    },
  }));
  await persistFundedPublication({
    store,
    key: draft.key,
    draft,
    publication: replacementPublication,
    now: () => 4,
    publishCatalog: async () => { throw new Error("catalog unavailable"); },
  });
  const replaced = await store.get(draft.key);
  assert.equal(replaced?.publish?.catalogPublishedAt, undefined);
  assert.equal(replaced?.publish?.catalogPublicationId, undefined);
  assert.equal(replaced?.publish?.catalogError, "catalog unavailable");
  const retained = replaced?.reclaim;
  assert.equal(retained?.phase, "prepared");
  assert.equal(retained?.contentHash, RECLAIM_TX);
  assert.equal(retained?.transactionHex, "0x99");
  assert.equal(retained?.openFeeBaseUnits, "4");
});

const PCASH_100 = `0x${100n.toString(16).padStart(64, "0")}`;

function purchaseHarness(registeredKey = true) {
  const node = {} as PcashNodeClient;
  const funded: OfferPublication = { ...publication, terms: { ...publication.terms, amount: PCASH_100, deadlineT: OPEN_DEADLINE }, escrow: { amount: PCASH_100, leafIndex: 7, noteSecret: FIELD } };
  const buyerAddress = `0x${2n.toString(16).padStart(40, "0")}`;
  let sends = 0;
  const identity = executableIdentity(node, () => undefined) as unknown as {
    wallet: { execute: (action: (context: WalletExecutionContext) => unknown) => Promise<unknown> };
    l1Signer: { address: string; sendTransaction: () => Promise<Hex> };
  };
  const execute = identity.wallet.execute;
  identity.wallet.execute = (action) => execute((context) => action({
    ...context,
    ...(registeredKey ? {} : { store: {
      load: async () => ({ receiveKeys: [] }),
      readChain: async (read: (chain: unknown) => unknown) => read({ accountResult: () => ({ receiveKeyHash: "0x0" }) }),
    } }),
  } as WalletExecutionContext));
  identity.l1Signer.sendTransaction = async () => { sends += 1; return tx("ff"); };
  const store = new MemoryStore({
    key: offerKey(funded), pub: funded, source: "catalog", savedAt: 1,
    buys: { [buyerAddress]: { buyerAddress, publication: funded, commitment: BUY_COMMITMENT } },
  });
  const controller = new MarketplaceController({ node, identity: identity as never, store, l1RpcUrls: ["http://unused"] });
  return { funded, controller, sends: () => sends };
}

test("a buyer without a registered receive key is refused before proving or paying ETH", async (t) => {
  const harness = purchaseHarness(false);
  const mock = t.mock as unknown as { method: (object: object, name: string, implementation: () => Promise<unknown>) => void };
  mock.method(harness.controller, "resolvePayment", async () => ({ payment: null }));
  mock.method(harness.controller, "verifyWith", async () => { throw new Error("verification must not start"); });
  mock.method(harness.controller, "proveClaim", async () => { throw new Error("proving must not start"); });
  await assert.rejects(harness.controller.buy(harness.funded), /no registered receive key/);
  assert.equal(harness.sends(), 0);
});
