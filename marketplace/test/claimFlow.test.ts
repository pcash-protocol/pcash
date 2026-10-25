import assert from "node:assert/strict";
import { test } from "node:test";
import { bytesToHex, hexToBytes, numberToHex, type Hex } from "viem";
import {
  DEFAULT_NETWORK_CONFIG,
  posterPayoutOpening,
  type PcashNodeClient,
  type WitnessSnapshotResult,
} from "@pcash/sdk/browser";
import { decodeBatch } from "@pcash/sdk/protocol";
import { derivePcashProfileFromPrivateKey } from "@pcash/sdk/wallet";
import {
  CLAIM_APPLICATION_VK_HASH,
  RECLAIM_APPLICATION_VK_HASH,
  paymentCarrierContext,
  paymentCarrierContextHash,
  type OfferTerms,
} from "../src/commitments.mts";
import { anchoredPrivateValueTransaction } from "./anchoredTransaction.ts";
import { createOffer } from "../src/offer.mts";
import { publicationFromOffer, publicationTerms, type OfferPublication } from "../src/client/publication.ts";
import { purchaseCommitment } from "../src/client/buy.ts";
import {
  awaitRecordOrAbsence,
  checkCarriedClaim,
  claimBatch,
  ClaimCheckError,
  claimNotAfter,
  claimSnapshotFrom,
  readClaimSnapshot,
  readEscrowSpend,
  readPurchaseClaimFinality,
  RecordUnsettledError,
} from "../src/client/claimFlow.ts";
import { escrowCommitments } from "../src/client/offerAvailability.ts";

const offerTerms: OfferTerms = {
  router: 0x1234n,
  seller: 0x5678n,
  id: 0x9abcn,
  assetId: 0n,
  amount: 0x64n,
  ethPriceWei: 0x2n,
  deadlineT: 4_000_000_000n,
};
const builtOffer = createOffer({
  network: DEFAULT_NETWORK_CONFIG,
  terms: offerTerms,
  sellerWallet: derivePcashProfileFromPrivateKey(new Uint8Array(32).fill(7), DEFAULT_NETWORK_CONFIG),
  l2ContractNkRoot: 0x51n,
  claimApplicationVkHash: CLAIM_APPLICATION_VK_HASH,
  reclaimApplicationVkHash: RECLAIM_APPLICATION_VK_HASH,
});
const offer: OfferPublication = {
  ...publicationFromOffer(builtOffer),
  escrow: { leafIndex: 3, noteSecret: "0x123", amount: numberToHex(offerTerms.amount) },
};
const buyer = derivePcashProfileFromPrivateKey(new Uint8Array(32).fill(8), DEFAULT_NETWORK_CONFIG);
const commitment = purchaseCommitment(offer, buyer);
// The offer derives its own ID, so the context names the published terms.
const routerContext = paymentCarrierContext(publicationTerms(offer), BigInt(commitment));
const L1_BLOCK_HASH = `0x${"cd".repeat(32)}` as Hex;
const CLAIM = `0x${"ce".repeat(32)}`;

function snapshot(overrides: Partial<WitnessSnapshotResult> = {}): WitnessSnapshotResult {
  const boundary = { header: { number: 40n, timestamp: 1_700_000_000n }, blockHash: 0x77n };
  return {
    status: {} as WitnessSnapshotResult["status"],
    blockHeader: null,
    block: { number: 40n, hash: "0x77", l1Origin: { blockNumber: 140n, blockHash: L1_BLOCK_HASH } },
    accounts: [],
    contracts: [{
      status: "contract",
      accountProof: { status: "present", account: { index: 5n }, accountStateRoot: 0x40n, accountSiblings: [], boundary },
    }] as unknown as WitnessSnapshotResult["contracts"],
    outputs: { root: "0x30", count: 4n, boundary, paths: [{ outputIndex: 3n, siblings: [9n, 8n] }] } as unknown as WitnessSnapshotResult["outputs"],
    nullifiers: { statuses: [{ nullifier: "0x01", spent: false }] } as unknown as WitnessSnapshotResult["nullifiers"],
    l1Logs: [],
    ...overrides,
  };
}

test("a claim may be carried until shortly before its snapshot leaves the recent-block window, and never after T", () => {
  assert.equal(claimNotAfter(1_000n, 1_000_000n), 1_000n + 3_600n - 60n);
  assert.equal(claimNotAfter(1_000n, 2_000n), 2_000n);
});

test("the claim snapshot names the Ethereum block its PCASH block was derived from, and that block's state", () => {
  const claim = claimSnapshotFrom(snapshot());
  assert.deepEqual(claim?.anchor, { blockNumber: 140n, blockHash: L1_BLOCK_HASH });
  assert.equal(claim?.timestamp, 1_700_000_000n);
  assert.equal(claim?.account.accountStateRoot, 0x40n);
  assert.deepEqual(claim?.escrowSiblings, [9n, 8n]);
  assert.equal(claimSnapshotFrom(snapshot({ contracts: [{ status: "notFound", address: "0x1", authenticated: false }] })), null);
  assert.equal(claimSnapshotFrom(snapshot({ outputs: null })), null);
  assert.equal(claimSnapshotFrom(snapshot({ block: null })), null);
});

test("a retry reads the escrow contract and note at the current head and stops once the note is spent", async () => {
  const queries: unknown[] = [];
  let spent = false;
  const node = {
    getWitnessSnapshot: async (query: unknown) => {
      queries.push(query);
      return snapshot({ nullifiers: { statuses: [{ nullifier: "0x01", spent }] } as unknown as WitnessSnapshotResult["nullifiers"] });
    },
  } as unknown as PcashNodeClient;
  assert.equal((await readClaimSnapshot(node, offer)).anchor.blockNumber, 140n);
  const query = queries[0] as { contracts: string[]; outputs: { outputIndex: number }[]; nullifiers: string[] };
  assert.equal(BigInt(query.contracts[0]!), builtOffer.l2ContractAddress);
  assert.equal(query.outputs[0]!.outputIndex, 3);
  assert.equal(query.nullifiers.length, 1);
  spent = true;
  await assert.rejects(readClaimSnapshot(node, offer), /escrow note is already spent/);
});

test("the router batch carries one claim under the self-publication header naming the buyer", () => {
  const transaction = bytesToHex(Uint8Array.of(1, 2, 3, 4));
  const batch = decodeBatch(hexToBytes(claimBatch({ acceptedBatchVersions: [1] }, buyer, transaction)));
  assert.deepEqual(batch.items.map((item) => bytesToHex(item)), [transaction]);
  assert.equal(batch.posterOwnerCommitment, posterPayoutOpening(buyer.address, buyer.nkRoot, batch.posterContext).ownerCommitment);
  assert.throws(() => claimBatch({ acceptedBatchVersions: [] }, buyer, transaction), /batch version/);
});

test("the dry run uses the router's carrier context for this payment and refuses anything but success", async () => {
  const requests: { transaction: Uint8Array; carrier: unknown }[] = [];
  let result = { outcome: "succeeded" };
  const node = {
    checkRawTransaction: async (transaction: Uint8Array, carrier: unknown) => {
      requests.push({ transaction, carrier });
      return result;
    },
  } as unknown as PcashNodeClient;
  await checkCarriedClaim(node, "0x0102", offer, commitment);
  assert.deepEqual(requests[0]!.transaction, Uint8Array.of(1, 2));
  assert.deepEqual(requests[0]!.carrier, {
    kind: "event",
    address: numberToHex(offerTerms.router, { size: 20 }),
    context: hexToBytes(routerContext),
  });
  result = { outcome: "proofRejected" };
  await assert.rejects(checkCarriedClaim(node, "0x0102", offer, commitment),
    (error: unknown) => error instanceof ClaimCheckError && error.outcome === "proofRejected");
});

/** The carrier context the router's event names for a payment with this claim-key commitment. */
const routerCarrier = (claimKeyCommitment: Hex) => paymentCarrierContextHash(publicationTerms(offer), BigInt(claimKeyCommitment));
const OTHER_COMMITMENT = numberToHex(0x0dd, { size: 32 });

/** A node whose escrow nullifier was spent at `timestamp` in Ethereum block 200 by a transaction requiring `carrier`, or is unspent. */
function spendNode(carrier: bigint | null, finalizedL1BlockNumber = 0n, timestamp = offerTerms.deadlineT) {
  const queries: string[] = [];
  const node = {
    getTransactionByNullifier: async (nullifier: string) => {
      queries.push(nullifier);
      return carrier === null ? null : {
        summary: { contentHash: CLAIM.toUpperCase().replace("0X", "0x"), timestamp, inclusion: { l1BlockNumber: 200n } },
        rawTransaction: bytesToHex(anchoredPrivateValueTransaction(1n, 1n, 1n, 0n, carrier)),
      };
    },
    status: async () => ({ finalizedL1BlockNumber }),
  } as unknown as PcashNodeClient;
  return { node, queries };
}

test("the escrow spender is this purchase's claim only when it executed by T and required the router's context for this payment", async () => {
  const unspent = spendNode(null);
  assert.equal(await readEscrowSpend(unspent.node, offer, commitment), null);
  assert.deepEqual(unspent.queries, [escrowCommitments(offer, offer.escrow!).nullifier]);
  assert.deepEqual(await readEscrowSpend(spendNode(routerCarrier(commitment)).node, offer, commitment), { contentHash: CLAIM, l1BlockNumber: 200n, ours: true });
  // Another buyer's claim, after a reorg replaced this buyer's payment.
  assert.deepEqual(await readEscrowSpend(spendNode(routerCarrier(OTHER_COMMITMENT)).node, offer, commitment), { contentHash: CLAIM, l1BlockNumber: 200n, ours: false });
  // The seller's reclaim executes after T, whatever carrier context it requires: none,
  // or this payment's, when the seller has it carried by `retry`.
  for (const carrier of [0n, routerCarrier(commitment)]) {
    assert.deepEqual(await readEscrowSpend(spendNode(carrier, 0n, offerTerms.deadlineT + 1n).node, offer, commitment), { contentHash: CLAIM, l1BlockNumber: 200n, ours: false });
  }
});

test("a purchase's claim is accepted once it spends the escrow and finalized with its Ethereum block", async () => {
  assert.deepEqual(await readPurchaseClaimFinality(spendNode(null).node, offer, commitment), { phase: "missing" });
  assert.deepEqual(await readPurchaseClaimFinality(spendNode(routerCarrier(OTHER_COMMITMENT), 300n).node, offer, commitment), { phase: "missing" });
  assert.deepEqual(await readPurchaseClaimFinality(spendNode(routerCarrier(commitment), 300n, offerTerms.deadlineT + 1n).node, offer, commitment), { phase: "missing" });
  assert.deepEqual(await readPurchaseClaimFinality(spendNode(routerCarrier(commitment), 199n).node, offer, commitment), { phase: "accepted", contentHash: CLAIM, acceptedBlock: 200n });
  assert.deepEqual(await readPurchaseClaimFinality(spendNode(routerCarrier(commitment), 200n).node, offer, commitment), { phase: "finalized", contentHash: CLAIM, acceptedBlock: 200n });
});

/** A node whose status and canonical blocks each read can change; block `n` has hash `canonical(n)`, and derives from Ethereum block 100 + n. */
function boundaryNode(read: (reads: number) => { head: bigint; indexed: bigint },
  canonical: (number: bigint, reads: number) => string = (number) => `0x${number.toString(16)}`) {
  let reads = 0;
  const blocks: bigint[] = [];
  const node = {
    status: async () => {
      const state = read(++reads);
      return { genesisL1Block: 100n, latestBlock: state.head, latestBlockHash: canonical(state.head, reads),
        index: { status: "ready", cursor: { blockNumber: state.indexed, blockHash: "0x00" } } };
    },
    getBlock: async (number: bigint) => { blocks.push(number); return { number, hash: canonical(number, reads) }; },
  } as unknown as PcashNodeClient;
  return { node, blocks, reads: () => reads };
}

test("an index that trails a moving head settles absence once it passes the boundary fixed at the first head", async () => {
  // The head moves a block per read, and the index stays three blocks behind it.
  const { node, blocks, reads } = boundaryNode((read) => ({ head: 10n + BigInt(read), indexed: 7n + BigInt(read) }));
  assert.equal(await awaitRecordOrAbsence({ node, l1BlockNumber: 111n, pollIntervalMs: 0, maxAttempts: 10, find: async () => null }), null);
  assert.equal(reads(), 4);
  assert.deepEqual(blocks, [11n]);
});

test("the boundary is the first canonical head derived from the carrier's Ethereum block or later, and the record is found until then", async () => {
  // The head reaches Ethereum block 143 on the third read.
  const { node, blocks } = boundaryNode((read) => ({ head: 40n + BigInt(read), indexed: 60n }));
  assert.equal(await awaitRecordOrAbsence({ node, l1BlockNumber: 143n, pollIntervalMs: 0, find: async () => null }), null);
  assert.deepEqual(blocks, [43n]);

  let finds = 0;
  assert.equal(await awaitRecordOrAbsence({ node, l1BlockNumber: 1_000n, pollIntervalMs: 0, find: async () => (++finds === 2 ? "landed" : null) }), "landed");
});

test("a boundary that was reorged out is captured again", async () => {
  // Block 11 is replaced right after the first read; the head is then 12.
  let reorged = false;
  const { node, blocks } = boundaryNode((read) => ({ head: read === 1 ? 11n : 12n, indexed: 12n }),
    (number) => `0x${reorged ? "b" : "a"}${number.toString(16)}`);
  assert.equal(await awaitRecordOrAbsence({ node, l1BlockNumber: 111n, pollIntervalMs: 0, find: async () => { reorged = true; return null; } }), null);
  assert.deepEqual(blocks, [11n, 12n]);
});

test("an absence the node cannot settle within the attempt cap is unsettled", async () => {
  const underived = boundaryNode(() => ({ head: 50n, indexed: 50n })).node;
  await assert.rejects(awaitRecordOrAbsence({ node: underived, l1BlockNumber: 151n, pollIntervalMs: 0, maxAttempts: 3, find: async () => null }), RecordUnsettledError);
  const stalled = boundaryNode(() => ({ head: 50n, indexed: 40n })).node;
  await assert.rejects(awaitRecordOrAbsence({ node: stalled, l1BlockNumber: 150n, pollIntervalMs: 0, maxAttempts: 3, find: async () => null }), RecordUnsettledError);
});
