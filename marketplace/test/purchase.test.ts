// The one-transaction purchase through the headless controller: prove, dry-run,
// `buy`, read whether a claim spent the escrow, and `retry` when none did.
// Proving, the Ethereum signer, and L1 reads are stubbed at the controller's
// seams; the stub node reports the escrow spender as the first carried claim
// that succeeded, once its index has reached that claim's block.

import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { bytesToHex, decodeFunctionData, hexToBytes, keccak256, numberToHex, type Hex } from "viem";
import {
  addressHex,
  DEFAULT_NETWORK_CONFIG,
  fieldToHex,
  generateMlKemKeyPair,
  receiveKeyHash,
  type PcashNodeClient,
  type ReceiptResult,
  type WitnessSnapshotResult,
} from "@pcash/sdk/browser";
import { CARRIER_KIND_EVENT, carrierContextHash, decodeBatch } from "@pcash/sdk/protocol";
import { derivePcashProfileFromPrivateKey, type WalletExecutionContext } from "@pcash/sdk/wallet";
import { CLAIM_APPLICATION_VK_HASH, RECLAIM_APPLICATION_VK_HASH, paymentCarrierContext } from "../src/commitments.mts";
import { createOffer } from "../src/offer.mts";
import { offerKey, publicationFromOffer, publicationTerms, type OfferPublication } from "../src/client/publication.ts";
import {
  buildBuyCall,
  InsufficientPaymentBalanceError,
  PaymentTransactionCancelledError,
  PaymentTransactionRevertedError,
  purchaseCommitment,
  type PayResult,
  type PaymentBroadcastCallbacks,
  type RouterCall,
} from "../src/client/buy.ts";
import { claimBatch, ClaimCheckError, claimNotAfter, type ClaimSnapshot } from "../src/client/claimFlow.ts";
import { escrowCommitments } from "../src/client/offerAvailability.ts";
import { PAYMENT_ROUTER_ABI, quotePaymentRouterFee } from "../src/client/paymentRouter.ts";
import { marketplaceBuyerKey, type BuyRecord, type MarketplaceStore, type StoredOffer } from "../src/client/offerPersistence.ts";
import { MarketplaceController } from "../src/client/session.ts";
import type { OfferVerification } from "../src/client/verification.ts";
import { testToken } from "./tokenFixtures.ts";
import { escrowSpenderResult } from "./anchoredTransaction.ts";

const NETWORK = DEFAULT_NETWORK_CONFIG;
const seller = derivePcashProfileFromPrivateKey(new Uint8Array(32).fill(7), NETWORK);
const buyer = derivePcashProfileFromPrivateKey(new Uint8Array(32).fill(8), NETWORK);
const buyerKey = marketplaceBuyerKey(buyer.address);
const receiveKey = generateMlKemKeyPair(new Uint8Array(64).fill(26));
const ROUTER = 0x5fbdb2315678afecb367f032d93f642f64180aa3n;
const PRICE = 10n ** 15n;
const DEADLINE = 4_000_000_000n;
const GENESIS_L1_BLOCK = 100n;
const ROUTER_CONFIG = { feeRecipient: addressHex(0xfeen), feeBps: 500 };

function listing(index: bigint, token = false, deadlineT = DEADLINE): OfferPublication {
  const asset = testToken();
  const offer = createOffer({
    network: NETWORK,
    sellerWallet: seller,
    l2ContractNkRoot: 0x51n + index,
    terms: { router: ROUTER, seller: 0xd0d0n, assetId: token ? asset.assetId : 0n, amount: 500n, ethPriceWei: PRICE, deadlineT },
    claimApplicationVkHash: CLAIM_APPLICATION_VK_HASH,
    reclaimApplicationVkHash: RECLAIM_APPLICATION_VK_HASH,
  });
  const publication = {
    ...publicationFromOffer(offer, token ? asset.bytes : undefined),
    escrow: { leafIndex: Number(index), noteSecret: fieldToHex(0x123n + index), amount: fieldToHex(500n) },
  };
  escrowOffers.set(escrowCommitments(publication, publication.escrow).nullifier, numberToHex(BigInt(publication.terms.id), { size: 32 }));
  return publication;
}

/** The offer id behind each listing's escrow nullifier, so the stub node can report the claim that spent it. */
const escrowOffers = new Map<string, Hex>();

function snapshotAt(l1Block: bigint, timestamp: bigint): ClaimSnapshot {
  return {
    anchor: { blockNumber: l1Block, blockHash: numberToHex(l1Block, { size: 32 }) },
    timestamp,
    account: { accountStateRoot: 0x40n } as ClaimSnapshot["account"],
    escrowSiblings: [],
  };
}

function verified(snapshot: ClaimSnapshot): OfferVerification {
  return {
    l2ContractVerification: "verified", functionsBound: true, chainMatches: true, routerPinned: true,
    routerConfigVerified: true, feeQuote: quotePaymentRouterFee(PRICE, ROUTER_CONFIG), routerPaid: false, liveOnNode: true,
    escrow: "escrowed", claimSnapshot: snapshot, safeToPay: true, checks: ["verification stub"],
  };
}

class MapStore implements MarketplaceStore {
  readonly records = new Map<string, StoredOffer>();
  async list() { return [...this.records.values()].map((value) => structuredClone(value)); }
  async get(key: string) { const value = this.records.get(key); return value === undefined ? null : structuredClone(value); }
  async put(value: StoredOffer) { this.records.set(value.key, structuredClone(value)); }
  async remove(key: string) { this.records.delete(key); }
  async clear() { this.records.clear(); }
  async update(key: string, operation: (current: StoredOffer | null) => StoredOffer | null) {
    const next = operation(structuredClone(this.records.get(key) ?? null));
    if (next === null) this.records.delete(key); else this.records.set(key, structuredClone(next));
    return structuredClone(next);
  }
  buy(publication: OfferPublication): BuyRecord | undefined { return this.records.get(offerKey(publication))?.buys?.[buyerKey]; }
}

/** One router call the stub Ethereum chain included. */
interface SentCall {
  hash: Hex;
  blockNumber: bigint;
  blockHash: Hex;
  functionName: "buy" | "retry";
  args: readonly unknown[];
  value: bigint;
}

/** The batch a router call carries: `buy`'s last argument, and `retry`'s. */
const batchOf = (call: SentCall): Hex => call.args[call.functionName === "buy" ? 7 : 3] as Hex;

/** A stub PCASH node over a stub Ethereum chain whose router behaves like PaymentRouter. */
function world(options: {
  dryRun?: () => string;
  /** The PCASH outcome of the claim each router call carries, in call order. */
  outcomes?: ReceiptResult["outcome"][];
  head?: ClaimSnapshot;
  /** The derived index has not reached any router call's block yet. */
  indexLags?: () => boolean;
  /** The node's canonical head at each status read, by default 10,000, and how far the index trails it. */
  headBlock?: (read: number) => bigint;
  indexBehind?: bigint;
  /** The node refuses status reads past this count, so a client that never settles fails instead of spinning. */
  maxStatusReads?: () => number;
} = {}) {
  const events: string[] = [];
  let statusReads = 0;
  let indexed = 10_000n;
  const pcashHash = (number: bigint): Hex => numberToHex(0xc0000000n + number, { size: 32 });
  const sent: SentCall[] = [];
  const checks: { transaction: Hex; carrier: unknown }[] = [];
  const head = options.head ?? snapshotAt(400n, 1_800_000_000n);
  const outcome = (index: number) => options.outcomes?.[index] ?? "succeeded";
  // The carrier context a router call's event names: the commitment its offer's recorded payment holds.
  const callCarrier = (call: SentCall): bigint => {
    const paid = sent.find((other) => other.functionName === "buy" && other.args[0] === call.args[0])!;
    return carrierContextHash(CARRIER_KIND_EVENT, addressHex(ROUTER), hexToBytes(paymentCarrierContext(
      { id: BigInt(call.args[0] as Hex), seller: BigInt(call.args[1] as Hex), ethPriceWei: paid.value }, BigInt(paid.args[2] as Hex))));
  };
  const carried = (call: SentCall): Uint8Array[] => {
    const batch = batchOf(call);
    return batch === "0x" ? [] : decodeBatch(hexToBytes(batch)).items;
  };
  const node = {
    status: async () => {
      statusReads += 1;
      if (options.maxStatusReads !== undefined && statusReads > options.maxStatusReads()) throw new Error("status read limit reached");
      const latest = options.headBlock?.(statusReads) ?? 10_000n;
      indexed = options.indexLags?.() ? 300n : latest - (options.indexBehind ?? 0n);
      return {
        pcashChainId: Number(NETWORK.pcashChainId), l1ChainId: NETWORK.l1ChainId, acceptedTransactionTypes: [0, 1, 2, 3], acceptedBatchVersions: [1],
        genesisL1Block: GENESIS_L1_BLOCK, latestBlock: latest, latestBlockHash: pcashHash(latest),
        index: { status: "ready", cursor: { blockNumber: indexed, blockHash: "0x00" } },
      };
    },
    getBlock: async (number: bigint) => ({ number, hash: pcashHash(number) }),
    checkRawTransaction: async (transaction: Uint8Array, carrier: unknown) => {
      events.push("check");
      checks.push({ transaction: bytesToHex(transaction), carrier });
      // Bytes a router call already carried fail again the way they failed then.
      const failed = sent.findIndex((call, index) => outcome(index) !== "succeeded"
        && carried(call).some((item) => bytesToHex(item) === bytesToHex(transaction)));
      return { outcome: failed >= 0 ? outcome(failed) : options.dryRun?.() ?? "succeeded" };
    },
    // The escrow's spender is the first carried claim for its listing that succeeded, in a block the index has reached.
    getTransactionByNullifier: async (nullifier: string) => {
      for (const [index, call] of sent.entries()) {
        const [item] = carried(call);
        if (call.args[0] !== escrowOffers.get(nullifier) || item === undefined || outcome(index) !== "succeeded") continue;
        if (call.blockNumber - GENESIS_L1_BLOCK > indexed) return null;
        return escrowSpenderResult(keccak256(item), call.blockNumber, callCarrier(call), 1_000n);
      }
      return null;
    },
    getWitnessSnapshot: async () => {
      events.push("head snapshot");
      const boundary = { header: { timestamp: head.timestamp } };
      // The escrow reads as spent once any carried claim succeeded; no test
      // reads a head snapshot for another listing after one did.
      const spent = sent.some((call, index) => carried(call).length > 0 && outcome(index) === "succeeded");
      return {
        block: { number: 1n, hash: "0x01", l1Origin: head.anchor },
        contracts: [{ status: "contract", accountProof: { ...head.account, boundary } }],
        outputs: { paths: [{ outputIndex: 0n, siblings: [] }] },
        nullifiers: { statuses: [{ nullifier: "0x01", spent }] },
      } as unknown as WitnessSnapshotResult;
    },
  } as unknown as PcashNodeClient;
  /** Include a router call on the stub chain, as a buy made from another browser would be. */
  const include = (call: { functionName: "buy" | "retry"; data: Hex; value: bigint }): SentCall => {
    const decoded = decodeFunctionData({ abi: PAYMENT_ROUTER_ABI, data: call.data });
    const index = BigInt(sent.length + 1);
    const included: SentCall = {
      hash: numberToHex(0xa000n + index, { size: 32 }), blockNumber: 500n + index, blockHash: numberToHex(0xb000n + index, { size: 32 }),
      functionName: call.functionName, args: decoded.args as readonly unknown[], value: call.value,
    };
    sent.push(included);
    return included;
  };
  return { events, sent, checks, head, node, include, statusReads: () => statusReads };
}

type World = ReturnType<typeof world>;

/** Every stub proof yields distinct bytes, as fresh proof entropy does. */
let provedClaims = 0;

function controllerFor(t: TestContext, chain: World, options: {
  store?: MapStore;
  verifiedSnapshot?: ClaimSnapshot;
  recovered?: (publication: OfferPublication) => { hash: Hex; blockNumber: bigint; blockHash: Hex; paidAt: number } | null;
  beforeSend?: (call: RouterCall) => void;
  reject?: (call: RouterCall) => boolean;
  /** The wallet sends this call and returns its hash, then cancels it while the client watches. */
  cancel?: (call: RouterCall) => boolean;
  /** The wallet sends this call and returns its hash, then the page closes; the call is never mined. */
  dropAfterSent?: (call: RouterCall) => boolean;
  /** The router reverts this call, as it does a second payment for a listing. */
  revert?: (call: RouterCall) => boolean;
  withinCallLimits?: boolean;
  /** The selected Ethereum head's timestamp, by default long before any saved attempt's time limit. */
  l1HeadTimestamp?: () => bigint;
  nowSeconds?: bigint;
  /** The wallet's account directory has moved past the first snapshot it is asked to prove against. */
  syncedPast?: boolean;
  paymentBalanceError?: Error;
  /** The wallet broadcasts this call, and lands it when `lands` is set, but the page closes before its hash is saved. */
  lostAfterBroadcast?: (call: RouterCall) => { lands: boolean } | undefined;
} = {}) {
  const store = options.store ?? new MapStore();
  const proofs: ClaimSnapshot[] = [];
  const pair = receiveKey;
  const receiveHash = numberToHex(receiveKeyHash(pair.publicKey), { size: 32 });
  const context = {
    node: chain.node,
    profile: buyer,
    signer: { address: buyer.address },
    network: { chainId: NETWORK.pcashChainId },
    status: { pcashChainId: Number(NETWORK.pcashChainId), l1ChainId: NETWORK.l1ChainId, acceptedBatchVersions: [1],
      inboxAddress: addressHex(NETWORK.inboxAddress), genesisHash: `0x${"30".repeat(32)}` },
    store: {
      load: async () => ({ sentOutputs: [], receiveKeys: [{ receiveKeyHash: receiveHash,
        mlKemPublicKey: bytesToHex(pair.publicKey), mlKemSecretKey: bytesToHex(pair.secretKey) }] }),
      readChain: async (read: (chain: unknown) => unknown) => read({ accountResult: () => ({ receiveKeyHash: receiveHash,
        material: { status: "available", mlKem768PublicKey: bytesToHex(pair.publicKey) } }) }),
    },
    spendable: () => true,
  } as unknown as WalletExecutionContext;
  const controller = new MarketplaceController({
    node: chain.node,
    store,
    l1RpcUrls: ["http://unused"],
    configuredRouter: { address: addressHex(ROUTER) },
    identity: {
      wallet: {
        address: buyerKey,
        network: { chainId: NETWORK.pcashChainId, genesisHash: `0x${"30".repeat(32)}` },
        execute: async (operation: (context: WalletExecutionContext) => unknown) => operation(context),
      },
      l1Signer: { address: addressHex(0xb0b0n), chainId: async () => NETWORK.l1ChainId, sendTransaction: async () => { throw new Error("stubbed send"); } },
    } as never,
    ...(options.nowSeconds === undefined ? {} : { now: () => Number(options.nowSeconds) * 1_000 }),
  });
  const mock = t.mock as unknown as { method: (object: object, name: string, implementation: (...args: never[]) => unknown) => void };
  mock.method(controller, "verifyWith", async () => { chain.events.push("verify"); return verified(options.verifiedSnapshot ?? snapshotAt(300n, 1_700_000_000n)); });
  mock.method(controller, "requirePaymentBalance", async () => {
    if (options.paymentBalanceError !== undefined) {
      chain.events.push("balance");
      throw options.paymentBalanceError;
    }
  });
  mock.method(controller, "recoverPayment", async (publication: OfferPublication) => options.recovered?.(publication) ?? null);
  mock.method(controller, "withinCallLimits", async () => options.withinCallLimits ?? true);
  mock.method(controller, "l1Head", async () => ({ number: 1_000n, timestamp: options.l1HeadTimestamp?.() ?? 1_000n }));
  (controller as unknown as { claimPollIntervalMs: number }).claimPollIntervalMs = 0;
  let syncedPast = options.syncedPast ?? false;
  mock.method(controller, "proveClaim", async (_publication: OfferPublication, _wallet: unknown, snapshot: ClaimSnapshot) => {
    if (syncedPast) {
      syncedPast = false;
      chain.events.push("receive key moved");
      throw Object.assign(new Error("wallet account state differs from the transaction snapshot; retry this action"), { name: "WalletSyncRequiredError" });
    }
    chain.events.push("prove");
    proofs.push(snapshot);
    provedClaims += 1;
    const transactionHex = bytesToHex(new Uint8Array(48).fill(provedClaims));
    return { contentHash: keccak256(transactionHex), transactionHex };
  });
  mock.method(controller, "awaitRouterCall", async (hash: Hex) => {
    const call = chain.sent.find((candidate) => candidate.hash === hash)!;
    return { hash, blockNumber: call.blockNumber, blockHash: call.blockHash };
  });
  let unmined = 0;
  mock.method(controller, "sendRouterCall", async (_node: unknown, _signer: unknown, call: RouterCall, callbacks: PaymentBroadcastCallbacks = {}): Promise<PayResult> => {
    chain.events.push(`send ${call.functionName}`);
    options.beforeSend?.(call);
    await callbacks.onBroadcastRequested?.();
    if (options.reject?.(call)) {
      const rejection = Object.assign(new Error("User rejected the request"), { code: 4001 });
      await callbacks.onDefinitelyRejected?.(rejection);
      throw rejection;
    }
    const lost = options.lostAfterBroadcast?.(call);
    if (lost !== undefined) {
      if (lost.lands) chain.include(call);
      throw new Error("page closed before the wallet returned a hash");
    }
    if (options.cancel?.(call) || options.dropAfterSent?.(call)) {
      const hash = numberToHex(0xe000n + BigInt(++unmined), { size: 32 });
      await callbacks.onSent?.(hash);
      if (options.cancel?.(call)) throw new PaymentTransactionCancelledError(call.functionName, hash, numberToHex(0xf000n + BigInt(unmined), { size: 32 }), 0n);
      throw new Error("page closed after the wallet returned a hash");
    }
    if (options.revert?.(call)) {
      const hash = numberToHex(0xe000n + BigInt(++unmined), { size: 32 });
      await callbacks.onSent?.(hash);
      throw new PaymentTransactionRevertedError(call.functionName, hash, 600n);
    }
    const included = chain.include(call);
    await callbacks.onSent?.(included.hash);
    return { hash: included.hash, blockNumber: included.blockNumber, blockHash: included.blockHash };
  });
  return { controller, store, proofs };
}

const decodedBatchItem = (call: SentCall): Hex => bytesToHex(decodeBatch(hexToBytes(batchOf(call))).items[0]!);

/** The payment a restored wallet finds on Ethereum: the first `buy` the stub chain included. */
const firstBuy = (chain: World) => () => {
  const buy = chain.sent.find((call) => call.functionName === "buy");
  return buy === undefined ? null : { hash: buy.hash, blockNumber: buy.blockNumber, blockHash: buy.blockHash, paidAt: 1 };
};

for (const token of [false, true]) test(`a ${token ? "token" : "native"} purchase proves, dry-runs, and sends one buy() carrying the claim`, async (t) => {
  const chain = world();
  const publication = listing(1n, token);
  const verifiedSnapshot = snapshotAt(300n, 1_700_000_000n);
  let savedBeforeSend: BuyRecord | undefined;
  const { controller, store, proofs } = controllerFor(t, chain, {
    verifiedSnapshot,
    beforeSend: () => { savedBeforeSend = store.buy(publication); },
  });
  const result = await controller.buy(publication);

  assert.deepEqual(chain.events, ["verify", "prove", "check", "send buy"]);
  assert.deepEqual(proofs, [verifiedSnapshot]);
  const commitment = purchaseCommitment(publication, buyer);
  assert.deepEqual(chain.checks[0]!.carrier, {
    kind: "event", address: addressHex(ROUTER), context: hexToBytes(paymentCarrierContext(publicationTerms(publication), BigInt(commitment))),
  });
  const claim = chain.checks[0]!.transaction;
  // The exact bytes are saved before the signer is asked to send them.
  assert.equal(savedBeforeSend?.claimTransactionHex, claim);
  assert.equal(savedBeforeSend?.txHash, undefined);

  const [buy] = chain.sent;
  assert.equal(buy!.functionName, "buy");
  assert.equal(buy!.value, PRICE);
  const [, , claimKeyCommitment, anchorBlockNumber, anchorBlockHash, notAfter] = buy!.args;
  assert.equal(claimKeyCommitment, commitment);
  // The router names the verified snapshot the claim was proved against.
  assert.equal(anchorBlockNumber, verifiedSnapshot.anchor.blockNumber);
  assert.equal(anchorBlockHash, verifiedSnapshot.anchor.blockHash);
  assert.equal(notAfter, claimNotAfter(verifiedSnapshot.timestamp, DEADLINE));
  assert.equal(decodedBatchItem(buy!), claim);

  assert.deepEqual(result, { paymentHash: buy!.hash, claimContentHash: keccak256(claim) });
  const saved = store.buy(publication)!;
  assert.equal(saved.txHash, buy!.hash);
  assert.equal(saved.blockNumber, buy!.blockNumber.toString());
  assert.equal(saved.claimContentHash, keccak256(claim));
  assert.equal(saved.claimAcceptedBlock, buy!.blockNumber.toString());
  assert.equal(saved.claimTransactionHex, undefined);
});

test("a fresh payment shortfall stops before claim proving", async (t) => {
  const chain = world();
  const publication = listing(1n);
  const shortfall = new InsufficientPaymentBalanceError(PRICE - 1n, PRICE);
  const { controller, store, proofs } = controllerFor(t, chain, { paymentBalanceError: shortfall });
  await assert.rejects(controller.buy(publication), (error) => error === shortfall);
  assert.deepEqual(chain.events, ["verify", "balance"]);
  assert.deepEqual(proofs, []);
  assert.deepEqual(chain.checks, []);
  assert.deepEqual(chain.sent, []);
  assert.equal(store.buy(publication)?.claimTransactionHex, undefined);
});

test("a buy() executes no later than 24 hours before T", async (t) => {
  // The snapshot's recent-block window, which ends at 1_700_003_540, would otherwise run past T minus 24 hours.
  const deadline = 1_700_000_000n + 86_400n + 2_000n;
  const chain = world();
  const publication = listing(1n, false, deadline);
  const { controller } = controllerFor(t, chain, { nowSeconds: 1_700_000_000n });
  await controller.buy(publication);
  assert.equal(chain.sent[0]!.args[5], deadline - 86_400n);
});

test("a claim is proved against the current head when the wallet has synced past the verified snapshot", async (t) => {
  const chain = world();
  const publication = listing(1n);
  const { controller, proofs } = controllerFor(t, chain, { syncedPast: true });
  await controller.buy(publication);
  assert.deepEqual(chain.events, ["verify", "receive key moved", "head snapshot", "prove", "check", "send buy"]);
  assert.deepEqual(proofs[0]!.anchor, chain.head.anchor);
  // The router call names the snapshot the claim was actually proved against.
  assert.equal(chain.sent[0]!.args[3], chain.head.anchor.blockNumber);
  assert.equal(chain.sent[0]!.args[5], claimNotAfter(chain.head.timestamp, DEADLINE));
});

test("a claim the node's dry run rejects stops the purchase before payment", async (t) => {
  const chain = world({ dryRun: () => "proofRejected" });
  const publication = listing(1n);
  const { controller, store } = controllerFor(t, chain);
  await assert.rejects(controller.buy(publication), (error: unknown) => error instanceof ClaimCheckError && error.outcome === "proofRejected");
  assert.deepEqual(chain.events, ["verify", "prove", "check"]);
  assert.equal(chain.sent.length, 0);
  const saved = store.buy(publication)!;
  assert.equal(saved.paymentBroadcastRequestedAt, undefined);
  assert.equal(saved.txHash, undefined);
});

test("a payment whose carried claim failed is finished by a fresh proof at the current head and retry()", async (t) => {
  const chain = world({ outcomes: ["proofRejected", "succeeded"] });
  const publication = listing(1n);
  let savedBeforeRetry: BuyRecord | undefined;
  const { controller, store, proofs } = controllerFor(t, chain, {
    beforeSend: (call) => { if (call.functionName === "retry") savedBeforeRetry = store.buy(publication); },
  });
  const result = await controller.buy(publication);

  // The saved bytes fail their dry run the way they failed on PCASH, so the claim is proved again.
  assert.deepEqual(chain.events, ["verify", "prove", "check", "send buy", "check", "head snapshot", "prove", "check", "send retry"]);
  assert.deepEqual(proofs[1]!.anchor, chain.head.anchor);
  assert.equal(proofs[1]!.timestamp, chain.head.timestamp);
  const [buy, retry] = chain.sent;
  assert.equal(retry!.functionName, "retry");
  assert.equal(retry!.value, 0n);
  const [offerId, sellerAddress, amount] = retry!.args;
  assert.deepEqual([offerId, sellerAddress], buy!.args.slice(0, 2));
  assert.equal(amount, PRICE);
  const fresh = chain.checks[2]!.transaction;
  assert.notEqual(fresh, chain.checks[0]!.transaction);
  assert.equal(decodedBatchItem(retry!), fresh);
  assert.equal(savedBeforeRetry?.claimTransactionHex, fresh);
  assert.deepEqual(result, { paymentHash: buy!.hash, claimContentHash: keccak256(fresh) });
  assert.equal(store.buy(publication)!.claimAcceptedBlock, retry!.blockNumber.toString());
});

test("a retried claim that fails again stops, and continuing proves and retries again from the saved purchase", async (t) => {
  const chain = world({ outcomes: ["proofRejected", "proofRejected", "succeeded"] });
  const publication = listing(1n);
  const store = new MapStore();
  const first = controllerFor(t, chain, { store, recovered: firstBuy(chain) });
  await assert.rejects(first.controller.buy(publication), /retried claim did not succeed/);
  assert.equal(store.buy(publication)!.txHash, chain.sent[0]!.hash);

  chain.events.length = 0;
  const result = await first.controller.buy(publication);
  // The saved payment is recovered, never paid again; the failed retry's bytes fail their dry run.
  assert.deepEqual(chain.events, ["check", "head snapshot", "prove", "check", "send retry"]);
  assert.deepEqual(chain.sent.map((call) => call.functionName), ["buy", "retry", "retry"]);
  assert.equal(result.claimContentHash, keccak256(decodedBatchItem(chain.sent[2]!)));
});

/** Buy, see the carried claim fail, and lose the retry's hash after the wallet broadcast it. */
async function lostRetry(t: TestContext, chain: World, lands: boolean) {
  const store = new MapStore();
  const recovered = firstBuy(chain);
  const first = controllerFor(t, chain, { store, recovered,
    lostAfterBroadcast: (call) => call.functionName === "retry" ? { lands } : undefined });
  await assert.rejects(first.controller.buy(listing(1n)), /page closed before the wallet returned a hash/);
  const saved = first.store.buy(listing(1n))!;
  chain.events.length = 0;
  return { store, recovered, saved };
}

test("after a reload, a retry that landed before its hash was saved is found through the escrow spender and not sent again", async (t) => {
  const chain = world({ outcomes: ["proofRejected", "succeeded"] });
  const { store, recovered, saved } = await lostRetry(t, chain, true);
  const { controller } = controllerFor(t, chain, { store, recovered });
  const result = await controller.buy(listing(1n));
  assert.deepEqual(chain.events, []);
  assert.deepEqual(chain.sent.map((call) => call.functionName), ["buy", "retry"]);
  assert.equal(result.claimContentHash, saved.claimContentHash);
  assert.equal(store.buy(listing(1n))!.claimAcceptedBlock, chain.sent[1]!.blockNumber.toString());
});

test("after a reload, a retry that has not landed is sent again with the saved bytes the node still accepts", async (t) => {
  const chain = world({ outcomes: ["proofRejected", "succeeded"] });
  const { store, recovered, saved } = await lostRetry(t, chain, false);
  const { controller } = controllerFor(t, chain, { store, recovered });
  const result = await controller.buy(listing(1n));
  // A second retry costs only gas: one claim can spend the escrow note.
  assert.deepEqual(chain.events, ["check", "send retry"]);
  assert.deepEqual(chain.sent.map((call) => call.functionName), ["buy", "retry"]);
  assert.equal(decodedBatchItem(chain.sent[1]!), saved.claimTransactionHex);
  assert.equal(result.claimContentHash, saved.claimContentHash);
});

test("after a reload, saved retry bytes past their time limit are proved again", async (t) => {
  const chain = world({ outcomes: ["proofRejected", "succeeded"] });
  const { store, recovered, saved } = await lostRetry(t, chain, false);
  const { controller } = controllerFor(t, chain, { store, recovered, withinCallLimits: false });
  const result = await controller.buy(listing(1n));
  assert.deepEqual(chain.events, ["head snapshot", "prove", "check", "send retry"]);
  assert.deepEqual(chain.sent.map((call) => call.functionName), ["buy", "retry"]);
  assert.notEqual(result.claimContentHash, saved.claimContentHash);
});

test("a claim the index has not reached is waited for, not proved again", async (t) => {
  let indexLags = false;
  const chain = world({ outcomes: ["proofRejected", "succeeded"], indexLags: () => indexLags });
  const { store, recovered, saved } = await lostRetry(t, chain, true);
  indexLags = true;
  const { controller } = controllerFor(t, chain, { store, recovered });
  let polls = 0;
  const status = chain.node.status.bind(chain.node);
  chain.node.status = async () => {
    if (++polls === 4) indexLags = false;
    return status();
  };
  const result = await controller.buy(listing(1n));
  assert.deepEqual(chain.events, []);
  assert.ok(polls >= 4);
  assert.deepEqual(chain.sent.map((call) => call.functionName), ["buy", "retry"]);
  assert.equal(result.claimContentHash, saved.claimContentHash);
});

test("saved claim bytes the node accepts are sent again while they can still execute", async (t) => {
  const chain = world();
  const publication = listing(1n);
  const store = new MapStore();
  let reject = true;
  const { controller } = controllerFor(t, chain, { store, reject: () => reject });
  await assert.rejects(controller.buy(publication), /User rejected/);
  const saved = store.buy(publication)!;
  assert.equal(saved.paymentBroadcastRequestedAt, undefined);

  reject = false;
  chain.events.length = 0;
  const result = await controller.buy(publication);
  assert.deepEqual(chain.events, ["verify", "check", "send buy"]);
  assert.equal(decodedBatchItem(chain.sent[0]!), saved.claimTransactionHex);
  assert.equal(chain.sent[0]!.args[3], BigInt(saved.claimAnchorBlockNumber!));
  assert.equal(chain.sent[0]!.args[5], BigInt(saved.claimNotAfter!));
  assert.equal(result.claimContentHash, saved.claimContentHash);
});

test("saved claim bytes past their limits, or that the node no longer accepts, are proved again", async (t) => {
  // The first dry run passes the bytes that the buyer then declines to send.
  for (const [withinCallLimits, dryRuns] of [[false, ["succeeded"]], [true, ["succeeded", "proofRejected"]]] as const) {
    const results: string[] = [...dryRuns];
    const chain = world({ dryRun: () => results.shift() ?? "succeeded" });
    const publication = listing(1n);
    const store = new MapStore();
    const rejecting = controllerFor(t, chain, { store, reject: () => true });
    await assert.rejects(rejecting.controller.buy(publication), /User rejected/);
    const stale = store.buy(publication)!.claimTransactionHex;
    chain.events.length = 0;
    chain.checks.length = 0;
    const { controller } = controllerFor(t, chain, { store, withinCallLimits });
    await controller.buy(publication);
    assert.deepEqual(chain.events, withinCallLimits
      ? ["verify", "check", "prove", "check", "send buy"]
      : ["verify", "prove", "check", "send buy"]);
    assert.notEqual(decodedBatchItem(chain.sent[0]!), stale);
  }
});

test("a restored wallet with no saved purchase finds its payment and finishes it with retry(), even once buying has closed", async (t) => {
  const chain = world({ outcomes: ["proofRejected", "succeeded"] });
  const publication = listing(1n);
  // Paid from another browser; this one holds no offer, transaction hash, or catalog.
  const snapshot = snapshotAt(300n, 1_700_000_000n);
  const paid = chain.include(buildBuyCall(publication, buyer, {
    anchor: snapshot.anchor,
    notAfter: claimNotAfter(snapshot.timestamp, DEADLINE),
    batch: claimBatch({ acceptedBatchVersions: [1] }, buyer, bytesToHex(new Uint8Array(48).fill(0xee))),
  }));
  // Inside the last 24 hours before T: the client sends no buy(), but retry() and recovery still run.
  const { controller, store } = controllerFor(t, chain, {
    recovered: () => ({ hash: paid.hash, blockNumber: paid.blockNumber, blockHash: paid.blockHash, paidAt: 7 }),
    nowSeconds: DEADLINE - 3_600n,
    paymentBalanceError: new InsufficientPaymentBalanceError(0n, PRICE),
  });
  const result = await controller.buy(publication);
  assert.deepEqual(chain.events, ["verify", "head snapshot", "prove", "check", "send retry"]);
  assert.deepEqual(chain.sent.map((call) => call.functionName), ["buy", "retry"]);
  assert.equal(result.paymentHash, paid.hash);
  const saved = store.buy(publication)!;
  assert.equal(saved.txHash, paid.hash);
  assert.equal(saved.paidAt, 7);
  assert.equal(saved.claimContentHash, keccak256(decodedBatchItem(chain.sent[1]!)));
});

test("a claim that failed after T is not retried; the escrow would reject it", async (t) => {
  const chain = world({ outcomes: ["proofRejected"] });
  const publication = listing(1n);
  const snapshot = snapshotAt(300n, 1_700_000_000n);
  const paid = chain.include(buildBuyCall(publication, buyer, {
    anchor: snapshot.anchor,
    notAfter: claimNotAfter(snapshot.timestamp, DEADLINE),
    batch: claimBatch({ acceptedBatchVersions: [1] }, buyer, bytesToHex(new Uint8Array(48).fill(0xee))),
  }));
  const { controller } = controllerFor(t, chain, {
    recovered: () => ({ hash: paid.hash, blockNumber: paid.blockNumber, blockHash: paid.blockHash, paidAt: 1 }),
    nowSeconds: DEADLINE,
  });
  await assert.rejects(controller.buy(publication), /claim did not succeed, and the claim deadline has passed/);
  assert.deepEqual(chain.sent.map((call) => call.functionName), ["buy"]);
});

test("buying several listings sends one buy() per listing, each carrying its own claim", async (t) => {
  const chain = world();
  const publications = [listing(1n), listing(2n, true)];
  const { controller } = controllerFor(t, chain);
  const mock = t.mock as unknown as { method: (object: object, name: string, implementation: () => unknown) => void };
  mock.method(controller, "assertPurchaseBudget", async () => undefined);
  const results = await controller.buyMany(publications);
  assert.deepEqual(chain.sent.map((call) => call.functionName), ["buy", "buy"]);
  assert.deepEqual(chain.sent.map((call) => call.args[0]), publications.map((publication) => numberToHex(BigInt(publication.terms.id), { size: 32 })));
  assert.deepEqual(results.map((result) => result.paymentHash), chain.sent.map((call) => call.hash));
  assert.deepEqual(results.map((result) => result.claimContentHash), chain.sent.map((call) => keccak256(decodedBatchItem(call))));
  assert.deepEqual(results.map((result) => offerKey(result.publication)), publications.map(offerKey));
});

test("resuming several purchases returns one that retry() finished as done and goes on to the next", async (t) => {
  const chain = world({ outcomes: ["proofRejected", "succeeded"] });
  const [first, second] = [listing(1n), listing(2n)];
  const store = new MapStore();
  const recovered = (publication: OfferPublication) => {
    const offerId = numberToHex(BigInt(publication.terms.id), { size: 32 });
    const buy = chain.sent.find((call) => call.functionName === "buy" && call.args[0] === offerId);
    return buy === undefined ? null : { hash: buy.hash, blockNumber: buy.blockNumber, blockHash: buy.blockHash, paidAt: 1 };
  };
  const mock = t.mock as unknown as { method: (object: object, name: string, implementation: () => unknown) => void };
  // The first listing's carried claim fails and retry() finishes it; the buyer then declines the second payment.
  let buys = 0;
  const interrupted = controllerFor(t, chain, { store, recovered, reject: (call) => call.functionName === "buy" && ++buys === 2 });
  mock.method(interrupted.controller, "assertPurchaseBudget", async () => undefined);
  await assert.rejects(interrupted.controller.buyMany([first, second]), /User rejected/);
  assert.deepEqual(chain.sent.map((call) => call.functionName), ["buy", "retry"]);
  const retried = keccak256(decodedBatchItem(chain.sent[1]!));
  assert.equal(store.buy(first)!.claimContentHash, retried);

  chain.events.length = 0;
  const resumed = controllerFor(t, chain, { store, recovered });
  mock.method(resumed.controller, "assertPurchaseBudget", async () => undefined);
  const results = await resumed.controller.buyMany([first, second]);
  // The first listing is neither proved nor sent again; the second is bought with its saved claim.
  assert.deepEqual(chain.events, ["verify", "check", "send buy"]);
  assert.deepEqual(chain.sent.map((call) => call.functionName), ["buy", "retry", "buy"]);
  assert.deepEqual(results.map((result) => [offerKey(result.publication), result.paymentHash, result.claimContentHash]), [
    [offerKey(first), chain.sent[0]!.hash, retried],
    [offerKey(second), chain.sent[2]!.hash, keccak256(decodedBatchItem(chain.sent[2]!))],
  ]);
});

test("a retry cancelled in the wallet carries nothing, and continuing sends a fresh retry", async (t) => {
  const chain = world({ outcomes: ["proofRejected", "succeeded"] });
  const store = new MapStore();
  const recovered = firstBuy(chain);
  const first = controllerFor(t, chain, { store, recovered, cancel: (call) => call.functionName === "retry" });
  await assert.rejects(first.controller.buy(listing(1n)), /retry transaction .* was cancelled by/);
  assert.deepEqual(chain.sent.map((call) => call.functionName), ["buy"]);

  chain.events.length = 0;
  const { controller } = controllerFor(t, chain, { store, recovered, withinCallLimits: false });
  const result = await controller.buy(listing(1n));
  assert.deepEqual(chain.events, ["head snapshot", "prove", "check", "send retry"]);
  assert.deepEqual(chain.sent.map((call) => call.functionName), ["buy", "retry"]);
  assert.equal(result.claimContentHash, keccak256(decodedBatchItem(chain.sent[1]!)));
});

test("a buy whose wallet prompt the page closed on is pending until the Ethereum head passes its time limit, then the router's record decides", async (t) => {
  let l1HeadTimestamp = 1_000n;
  const chain = world();
  const store = new MapStore();
  const first = controllerFor(t, chain, { store, lostAfterBroadcast: (call) => call.functionName === "buy" ? { lands: false } : undefined });
  await assert.rejects(first.controller.buy(listing(1n)), /page closed before the wallet returned a hash/);
  const saved = store.buy(listing(1n))!;
  assert.notEqual(saved.paymentBroadcastRequestedAt, undefined);

  await assert.rejects(controllerFor(t, chain, { store, l1HeadTimestamp: () => l1HeadTimestamp }).controller.buy(listing(1n)),
    /no payment is visible yet\. Another payment is not sent until this attempt's time limit has passed on Ethereum/);
  assert.notEqual(store.buy(listing(1n))!.paymentBroadcastRequestedAt, undefined);
  assert.equal(chain.sent.length, 0);

  l1HeadTimestamp = BigInt(saved.claimNotAfter!) + 1n;
  chain.events.length = 0;
  const { controller } = controllerFor(t, chain, { store, withinCallLimits: false, l1HeadTimestamp: () => l1HeadTimestamp });
  const result = await controller.buy(listing(1n));
  assert.deepEqual(chain.events, ["verify", "prove", "check", "send buy"]);
  assert.deepEqual(chain.sent.map((call) => call.functionName), ["buy"]);
  assert.equal(result.paymentHash, chain.sent[0]!.hash);
});

test("a buy that landed while the page was closed is found once the Ethereum head passes its time limit", async (t) => {
  const chain = world();
  const store = new MapStore();
  const recovered = firstBuy(chain);
  const first = controllerFor(t, chain, { store, recovered, lostAfterBroadcast: (call) => call.functionName === "buy" ? { lands: true } : undefined });
  await assert.rejects(first.controller.buy(listing(1n)), /page closed before the wallet returned a hash/);
  const saved = store.buy(listing(1n))!;
  chain.events.length = 0;
  const { controller } = controllerFor(t, chain, { store, recovered, l1HeadTimestamp: () => BigInt(saved.claimNotAfter!) + 1n });
  const result = await controller.buy(listing(1n));
  assert.deepEqual(chain.events, []);
  assert.equal(result.paymentHash, chain.sent[0]!.hash);
  assert.equal(result.claimContentHash, saved.claimContentHash);
});

test("a buy dropped after its hash was saved is pending until the Ethereum head passes its time limit", async (t) => {
  let l1HeadTimestamp = 1_000n;
  const chain = world();
  const store = new MapStore();
  const first = controllerFor(t, chain, { store, dropAfterSent: (call) => call.functionName === "buy" });
  await assert.rejects(first.controller.buy(listing(1n)), /page closed after the wallet returned a hash/);
  const saved = store.buy(listing(1n))!;
  assert.notEqual(saved.txHash, undefined);
  await assert.rejects(controllerFor(t, chain, { store, l1HeadTimestamp: () => l1HeadTimestamp }).controller.buy(listing(1n)),
    /has not landed yet\. Another payment is not sent until/);
  assert.equal(chain.sent.length, 0);
  assert.equal(store.buy(listing(1n))!.txHash, saved.txHash);

  l1HeadTimestamp = BigInt(saved.claimNotAfter!) + 1n;
  chain.events.length = 0;
  const { controller } = controllerFor(t, chain, { store, withinCallLimits: false, l1HeadTimestamp: () => l1HeadTimestamp });
  const result = await controller.buy(listing(1n));
  assert.deepEqual(chain.events, ["verify", "prove", "check", "send buy"]);
  assert.equal(result.paymentHash, chain.sent[0]!.hash);
  assert.equal(store.buy(listing(1n))!.txHash, chain.sent[0]!.hash);
});

test("a buy cancelled in the wallet is journaled as unpaid, and buying again sends a new payment", async (t) => {
  const chain = world();
  const store = new MapStore();
  let cancel = true;
  const { controller } = controllerFor(t, chain, { store, cancel: (call) => cancel && call.functionName === "buy" });
  await assert.rejects(controller.buy(listing(1n)), /payment was cancelled in the wallet, so nothing was paid/);
  assert.equal(store.buy(listing(1n))!.txHash, undefined);

  cancel = false;
  chain.events.length = 0;
  const result = await controller.buy(listing(1n));
  assert.deepEqual(chain.events, ["verify", "check", "send buy"]);
  assert.equal(result.paymentHash, chain.sent[0]!.hash);
});

test("a buy that reverts because an earlier attempt already paid continues with that payment", async (t) => {
  const chain = world();
  const publication = listing(1n);
  let earlier: SentCall | undefined;
  const { controller, store } = controllerFor(t, chain, {
    // An earlier attempt of this purchase lands first, so the router refuses this one with AlreadyPaid.
    revert: (call) => {
      if (call.functionName !== "buy") return false;
      earlier = chain.include(call);
      return true;
    },
    recovered: () => earlier === undefined ? null : { hash: earlier.hash, blockNumber: earlier.blockNumber, blockHash: earlier.blockHash, paidAt: 1 },
  });
  const result = await controller.buy(publication);
  assert.equal(result.paymentHash, earlier!.hash);
  assert.deepEqual(chain.sent.map((call) => call.functionName), ["buy"]);
  assert.equal(store.buy(publication)!.txHash, earlier!.hash);
});

test("a retry whose claim a copy carried first is finished by the copy's success", async (t) => {
  // Someone copies the pending retry's batch into their own retry, which lands first.
  const chain = world({ outcomes: ["proofRejected", "succeeded", "nullifierAlreadySpent"] });
  const { controller, store } = controllerFor(t, chain, {
    beforeSend: (call) => { if (call.functionName === "retry") chain.include(call); },
  });
  const result = await controller.buy(listing(1n));
  const [, copy, own] = chain.sent;
  assert.equal(decodedBatchItem(copy!), decodedBatchItem(own!));
  assert.equal(result.claimContentHash, keccak256(decodedBatchItem(own!)));
  assert.equal(store.buy(listing(1n))!.claimAcceptedBlock, copy!.blockNumber.toString());
});

test("a failed claim's absence is settled at a fixed block while the index keeps trailing a moving head", async (t) => {
  let readLimit = Number.MAX_SAFE_INTEGER;
  // The head moves a block per status read, and the index stays two blocks behind it.
  const chain = world({ outcomes: ["proofRejected", "succeeded"], headBlock: (read) => 10_000n + BigInt(read), indexBehind: 2n,
    maxStatusReads: () => readLimit });
  readLimit = 50;
  const { controller } = controllerFor(t, chain);
  const result = await controller.buy(listing(1n));
  assert.deepEqual(chain.events, ["verify", "prove", "check", "send buy", "check", "head snapshot", "prove", "check", "send retry"]);
  assert.deepEqual(chain.sent.map((call) => call.functionName), ["buy", "retry"]);
  assert.equal(result.claimContentHash, keccak256(decodedBatchItem(chain.sent[1]!)));
});

test("two claims are sent and the older one lands first: the purchase completes with it", async (t) => {
  // The buy's claim fails; the first retry's claim lands only after a second retry, with a newly proved claim, is sent.
  const chain = world({ outcomes: ["proofRejected", "succeeded", "nullifierAlreadySpent"] });
  const publication = listing(1n);
  const store = new MapStore();
  const recovered = firstBuy(chain);
  let firstRetry: RouterCall | undefined;
  const first = controllerFor(t, chain, { store, recovered,
    beforeSend: (call) => { if (call.functionName === "retry") firstRetry = call; },
    dropAfterSent: (call) => call.functionName === "retry" });
  await assert.rejects(first.controller.buy(publication), /page closed after the wallet returned a hash/);
  const older = store.buy(publication)!.claimContentHash!;

  const { controller } = controllerFor(t, chain, { store, recovered, withinCallLimits: false,
    beforeSend: (call) => { if (call.functionName === "retry") chain.include(firstRetry!); } });
  const result = await controller.buy(publication);
  const [, landed, newer] = chain.sent;
  assert.equal(keccak256(decodedBatchItem(landed!)), older);
  assert.notEqual(keccak256(decodedBatchItem(newer!)), older);
  assert.equal(result.claimContentHash, older);
  const saved = store.buy(publication)!;
  assert.equal(saved.claimContentHash, older);
  assert.equal(saved.claimAcceptedBlock, landed!.blockNumber.toString());
});
