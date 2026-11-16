import assert from "node:assert/strict";
import { test } from "node:test";
import { CLAIM_FUNCTION_SELECTOR, RECLAIM_FUNCTION_SELECTOR } from "../src/commitments.mts";
import { buildContractBody } from "@pcash/sdk/protocol";
import { generateMlKemKeyPair } from "@pcash/sdk/browser";
import { bytesToHex } from "viem";
import { offerKey, publicationIdentity, type OfferPublication } from "../src/client/publication.ts";
import {
  checkpointCanonicalPayment,
  checkpointBuyerPublication,
  checkpointClaimFinality,
  checkpointPublishFinality,
  checkpointReclaimFinality,
  checkpointFailedPayment,
  checkpointPaymentBroadcastRequested,
  checkpointPaymentPreBroadcastRejection,
  checkpointPendingPayment,
  checkpointPreparedClaim,
  checkpointStaleReclaim,
  durableOfferPublications,
  hasCanonicalFunding,
  isDurableOffer,
  isSellerActivityOffer,
  mergeDiscoveredOffer,
  type BuyRecord,
  type PublishRecord,
  type StoredOffer,
} from "../src/client/offerPersistence.ts";
import { BUY_COMMITMENT } from "./anchoredTransaction.ts";

const FIELD = `0x${"00".repeat(31)}01`;
const ADDRESS = `0x${"01".repeat(20)}`;
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

const offer = {
  key: offerKey(publication),
  pub: publication,
  source: "created",
  savedAt: 1,
} satisfies StoredOffer;
const PUBLICATION_ID = publicationIdentity(publication);

test("only created offers or offers with local transaction state are durable", () => {
  assert.equal(isDurableOffer(offer), true);
  const browsed = { ...offer, source: "catalog" } as StoredOffer;
  assert.equal(isDurableOffer(browsed), false);
  assert.equal(isDurableOffer({
    ...browsed,
    buys: { [ADDRESS]: { buyerAddress: ADDRESS, commitment: BUY_COMMITMENT, publication } },
  }), true);
  assert.equal(isDurableOffer({ ...browsed, publish: { phase: "draft", updatedAt: 1 } }), true);
  assert.equal(isDurableOffer({ ...browsed, reclaim: { phase: "prepared", publication, updatedAt: 1 } }), true);
});

test("the escrow spender's claim replaces saved bytes, a reorg clears its acceptance, and finality ends the record", () => {
  const buy: BuyRecord = {
    buyerAddress: ADDRESS, commitment: BUY_COMMITMENT, publication, txHash: "0xpayment", blockNumber: "99",
    claimContentHash: "0xnewer", claimTransactionHex: "0x1234", claimAnchorBlockNumber: "90", claimAnchorBlockHash: "0xa", claimNotAfter: "10",
  };
  // An older claim of the purchase spent the escrow, so the newer saved bytes can never land.
  const accepted = checkpointClaimFinality(buy, { phase: "accepted", contentHash: "0xolder", acceptedBlock: 100n }, 1);
  assert.deepEqual(accepted, { buyerAddress: ADDRESS, commitment: BUY_COMMITMENT, publication, txHash: "0xpayment", blockNumber: "99", claimContentHash: "0xolder", claimAcceptedBlock: "100" });
  assert.equal(checkpointClaimFinality(accepted, { phase: "accepted", contentHash: "0xolder", acceptedBlock: 100n }, 2), accepted);

  const missing = checkpointClaimFinality(accepted, { phase: "missing" }, 2);
  assert.equal(missing.claimAcceptedBlock, undefined);
  assert.equal(missing.claimContentHash, "0xolder");
  assert.equal(checkpointClaimFinality(missing, { phase: "missing" }, 3), missing);

  const finalized = checkpointClaimFinality(missing, { phase: "finalized", contentHash: "0xolder", acceptedBlock: 102n }, 5);
  assert.equal(finalized.claimAcceptedBlock, "102");
  assert.equal(finalized.claimedAt, 5);
  assert.equal(checkpointClaimFinality(finalized, { phase: "missing" }, 6), finalized);
});

test("claim bytes are saved before payment, and the buy that carries them is journaled before its receipt", () => {
  const selected: BuyRecord = { buyerAddress: ADDRESS, commitment: BUY_COMMITMENT, publication };
  const prepared = checkpointPreparedClaim(selected, {
    contentHash: "0xclaim", transactionHex: "0x1234", anchor: { blockNumber: 90n, blockHash: "0xanchor" }, notAfter: 1_700_003_540n,
  });
  assert.deepEqual(prepared, {
    ...selected, claimContentHash: "0xclaim", claimTransactionHex: "0x1234",
    claimAnchorBlockNumber: "90", claimAnchorBlockHash: "0xanchor", claimNotAfter: "1700003540",
  });
  const requested = checkpointPaymentBroadcastRequested(prepared, 4);
  assert.equal(requested.paymentBroadcastRequestedAt, 4);

  const pending = checkpointPendingPayment(requested, "0xpayment");
  assert.equal(pending.paymentBroadcastRequestedAt, undefined);
  assert.equal(pending.txHash, "0xpayment");
  assert.equal(pending.claimTransactionHex, "0x1234");

  const paid = checkpointCanonicalPayment(pending, { hash: "0xrepriced", blockNumber: 99n, paidAt: 1 });
  assert.deepEqual([paid.txHash, paid.blockNumber, paid.paidAt], ["0xrepriced", "99", 1]);

  const rejected = checkpointPaymentPreBroadcastRejection(checkpointPaymentBroadcastRequested(prepared, 6));
  assert.equal(rejected.paymentBroadcastRequestedAt, undefined);
  assert.equal(rejected.claimTransactionHex, "0x1234");
  assert.equal(checkpointPaymentPreBroadcastRejection(rejected), rejected);

  const recovered = checkpointCanonicalPayment(checkpointPaymentBroadcastRequested(prepared, 7),
    { hash: "0xrecovered", blockNumber: 99n, paidAt: 1 });
  assert.equal(recovered.paymentBroadcastRequestedAt, undefined);

  // An attempt that can no longer pay leaves the journal free for a new payment, with the saved bytes kept.
  const lapsed = checkpointFailedPayment(checkpointPaymentBroadcastRequested(prepared, 8));
  assert.equal(lapsed.paymentBroadcastRequestedAt, undefined);
  assert.equal(lapsed.claimTransactionHex, "0x1234");
  const dropped = checkpointFailedPayment(pending, "0xpayment");
  assert.deepEqual([dropped.txHash, dropped.claimTransactionHex], [undefined, "0x1234"]);
});

test("a retry's fresh bytes replace the saved claim bytes", () => {
  const paid: BuyRecord = {
    buyerAddress: ADDRESS, commitment: BUY_COMMITMENT, publication, txHash: "0xpayment", blockNumber: "99", paidAt: 1,
    claimContentHash: "0xfirst", claimTransactionHex: "0x01", claimAnchorBlockNumber: "90", claimAnchorBlockHash: "0xa", claimNotAfter: "10",
  };
  const fresh = checkpointPreparedClaim(paid, {
    contentHash: "0xsecond", transactionHex: "0x02", anchor: { blockNumber: 120n, blockHash: "0xb" }, notAfter: 20n,
  });
  assert.deepEqual(fresh, { ...paid, claimContentHash: "0xsecond", claimTransactionHex: "0x02", claimAnchorBlockNumber: "120", claimAnchorBlockHash: "0xb", claimNotAfter: "20" });
});

test("publication settlement retains exact bytes through accepted receipts and clears each only at finality", () => {
  const publish: PublishRecord = {
    phase: "funding-submitted",
    fundingContentHash: "funding-tx",
    fundingTransactionHex: "0xfunding",
    updatedAt: 1,
  };
  const accepted = checkpointPublishFinality(publish, {
    funding: { phase: "accepted", acceptedBlock: "11", acceptedBlockHash: "0xfunding-block" },
  }, 2);
  assert.equal(accepted.phase, "finalizing");
  assert.equal(accepted.fundingTransactionHex, "0xfunding");

  const reorged = checkpointPublishFinality(accepted, {
    funding: { phase: "missing" },
  }, 3);
  assert.equal(reorged.phase, "funding-submitted");
  assert.equal(reorged.fundingTransactionHex, "0xfunding");
  assert.equal(reorged.fundingAcceptedBlock, undefined);
  assert.equal(hasCanonicalFunding(reorged), false);

  const finalized = checkpointPublishFinality(reorged, {
    funding: { phase: "finalized", acceptedBlock: "13", acceptedBlockHash: "0xcanonical-funding" },
  }, 4);
  assert.equal(finalized.phase, "funded");
  assert.equal(finalized.fundingTransactionHex, undefined);
  assert.equal(finalized.fundingFinalizedAt, 4);
  assert.equal(hasCanonicalFunding(finalized), true);
});

test("a failed buy is forgotten, and the claim bytes it carried stay saved for the dry run to judge", () => {
  const pending: BuyRecord = {
    buyerAddress: ADDRESS, commitment: BUY_COMMITMENT, publication, txHash: "0xpending",
    claimContentHash: "0xclaim", claimTransactionHex: "0x1234", claimAnchorBlockNumber: "90", claimAnchorBlockHash: "0xa", claimNotAfter: "10",
  };
  const reverted = checkpointFailedPayment(pending, "0xpending");
  assert.equal(reverted.txHash, undefined);
  assert.equal(reverted.claimTransactionHex, "0x1234");
  assert.equal(checkpointFailedPayment(pending, "0xother").txHash, "0xpending");
  assert.equal(checkpointPaymentBroadcastRequested(reverted, 3).paymentBroadcastRequestedAt, 3);
});

test("reclaim settlement clears reorged acceptance and releases exact bytes only at finality", () => {
  const reclaim = {
    phase: "accepted" as const,
    publication,
    contentHash: "reclaim-tx",
    transactionHex: "0x1234" as const,
    acceptedBlock: "10",
    acceptedBlockHash: "0xold",
    openFeeBaseUnits: "9",
    updatedAt: 1,
  };
  const reorged = checkpointReclaimFinality(reclaim, { phase: "missing" }, 2);
  assert.equal(reorged.phase, "prepared");
  assert.equal(reorged.acceptedBlock, undefined);
  assert.equal(reorged.transactionHex, "0x1234");
  const finalized = checkpointReclaimFinality(reorged, {
    phase: "finalized",
    acceptedBlock: "11",
    acceptedBlockHash: "0xfinal",
  }, 3);
  assert.equal(finalized.phase, "finalized");
  assert.equal(finalized.transactionHex, undefined);
  assert.equal(finalized.finalizedAt, 3);
  assert.equal(finalized.openFeeBaseUnits, "9");
  assert.equal(checkpointReclaimFinality(finalized, {
    phase: "accepted",
    acceptedBlock: "12",
    acceptedBlockHash: "0xlate",
  }, 4), finalized);
});

test("a saved reclaim whose proof can no longer execute is cleared so the same reclaim can be proved again", () => {
  const reclaim = {
    phase: "prepared" as const,
    publication,
    contentHash: "reclaim-tx",
    transactionHex: "0x1234" as const,
    openFeeBaseUnits: "9",
    updatedAt: 1,
  };
  assert.equal(checkpointStaleReclaim(reclaim, "another-tx", 2), reclaim);
  assert.deepEqual(checkpointStaleReclaim(reclaim, "reclaim-tx", 2), {
    phase: "idle",
    publication,
    openFeeBaseUnits: "9",
    updatedAt: 2,
  });
  const finalized = { ...reclaim, phase: "finalized" as const, finalizedAt: 5 };
  assert.equal(checkpointStaleReclaim(finalized, "reclaim-tx", 6), finalized);
});

test("seller activity includes restored catalog listings owned by the active wallet", () => {
  const restored = {
    ...offer,
    source: "catalog",
    pub: { version: 1, reclaimAuthority: "0x1234" },
  } as unknown as StoredOffer;
  assert.equal(isSellerActivityOffer(restored, 0x1234n), true);
  assert.equal(isSellerActivityOffer(restored, 0x9999n), false);
  assert.equal(isSellerActivityOffer(offer, undefined), true);
});

test("discovery cannot replace a publication after local transaction state exists", () => {
  const incoming = { version: 1, terms: { id: "changed" } } as unknown as StoredOffer["pub"];
  const paid = {
    ...offer,
    source: "catalog",
    buys: { [ADDRESS]: { buyerAddress: ADDRESS, commitment: BUY_COMMITMENT, publication } },
  } as StoredOffer;
  const merged = mergeDiscoveredOffer(paid.key, incoming, "catalog", paid, 2);
  assert.equal(merged.pub, paid.pub);
  assert.equal(merged.savedAt, paid.savedAt);
  assert.equal(merged.buys, paid.buys);

  const untouched = { ...offer, source: "catalog" } as StoredOffer;
  const refreshed = mergeDiscoveredOffer(untouched.key, incoming, "catalog", untouched, 2);
  assert.equal(refreshed.pub, incoming);
  assert.equal(refreshed.savedAt, 2);
});

test("durable buyer workflows retain their exact publication independently of the top-level offer", () => {
  const buyerPublication: OfferPublication = {
    ...publication,
    escrow: { amount: FIELD, leafIndex: 8, noteSecret: `0x${"00".repeat(31)}02` },
  };
  const stored: StoredOffer = {
    ...offer,
    buys: {
      [ADDRESS]: { buyerAddress: ADDRESS, commitment: BUY_COMMITMENT, publication: buyerPublication },
    },
  };
  const publications = durableOfferPublications(stored);
  assert.equal(publications.length, 2);
  assert.equal(publicationIdentity(publications[1]!), publicationIdentity(buyerPublication));

  const prepared: BuyRecord = {
    buyerAddress: ADDRESS, commitment: BUY_COMMITMENT,
    publication,
    claimContentHash: "0xclaim",
    claimTransactionHex: "0x1234",
    claimAnchorBlockNumber: "9",
    claimAnchorBlockHash: "0xa",
    claimNotAfter: "10",
  };
  assert.throws(() => checkpointBuyerPublication({ ...prepared, txHash: "0xpayment", blockNumber: "10" }, buyerPublication, BUY_COMMITMENT),
    /payment already authorizes a different escrow publication/);

  const orphaned = checkpointFailedPayment({ ...prepared, txHash: "0xpayment", blockNumber: "10", paidAt: 1 }, "0xpayment");
  assert.deepEqual(checkpointBuyerPublication(orphaned, buyerPublication, BUY_COMMITMENT), { buyerAddress: ADDRESS, commitment: BUY_COMMITMENT, publication: buyerPublication });
});
