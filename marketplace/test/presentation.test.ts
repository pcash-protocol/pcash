import assert from "node:assert/strict";
import test from "node:test";
import { publicationIdentity, type OfferPublication } from "../src/client/publication.ts";
import type { BuyRecord, StoredOffer } from "../src/client/offerPersistence.ts";
import {
  marketplaceActivity,
  marketplaceBuyerState,
  marketplaceSellerState,
} from "../src/client/presentation.ts";
import { BUY_COMMITMENT } from "./anchoredTransaction.ts";

const ADDRESS = 0x1234n;
const BUYER = `0x${ADDRESS.toString(16).padStart(40, "0")}`;
const publication = {
  version: 1,
  reclaimAuthority: `0x${ADDRESS.toString(16)}`,
  escrow: { amount: "0x1", leafIndex: 7, noteSecret: "0x2" },
} as unknown as OfferPublication;

function offer(overrides: Partial<StoredOffer> = {}): StoredOffer {
  return {
    key: "offer",
    pub: publication,
    source: "created",
    savedAt: 1,
    ...overrides,
  };
}

test("seller presentation prioritizes resumable reclaim over publication", () => {
  const state = marketplaceSellerState(offer({
    publish: { phase: "funded", updatedAt: 2 },
    reclaim: {
      phase: "prepared",
      publication,
      contentHash: "reclaim-tx",
      transactionHex: "0x01",
      openFeeBaseUnits: "3",
      updatedAt: 4,
    },
  }), ADDRESS);
  assert.deepEqual(state, {
    role: "seller",
    phase: "reclaim-prepared",
    status: "action-required",
    updatedAt: 4,
    contentHash: "reclaim-tx",
    openFeeBaseUnits: "3",
  });
});

test("funded catalog failure remains an actionable publication retry", () => {
  const state = marketplaceSellerState(offer({
    publish: {
      phase: "funded",
      fundingContentHash: "funding-tx",
      catalogError: "catalog disabled",
      updatedAt: 5,
    },
  }), ADDRESS);
  assert.deepEqual(state, {
    role: "seller",
    phase: "publication-failed",
    status: "action-required",
    updatedAt: 5,
    contentHash: "funding-tx",
    error: "catalog disabled",
  });
});

test("funded publication without its exact catalog identity remains actionable", () => {
  assert.deepEqual(marketplaceSellerState(offer({
    publish: { phase: "funded", updatedAt: 5 },
  }), ADDRESS), {
    role: "seller",
    phase: "publication-failed",
    status: "action-required",
    updatedAt: 5,
    error: "Funded offer has not been published to the catalog",
  });
  assert.deepEqual(marketplaceSellerState(offer({
    publish: {
      phase: "funded",
      fundingContentHash: "funding-tx",
      catalogPublicationId: publicationIdentity(publication),
      catalogPublishedAt: 4,
      updatedAt: 5,
    },
  }), ADDRESS), {
    role: "seller",
    phase: "funded",
    status: "ready",
    updatedAt: 5,
    contentHash: "funding-tx",
  });
});

test("a catalogued listing is live while its transactions finalize", () => {
  for (const phase of ["funding-submitted", "finalizing"] as const) {
    const publish = { phase, fundingContentHash: "funding-tx", updatedAt: 5 };
    assert.deepEqual(marketplaceSellerState(offer({
      publish: { ...publish, catalogPublicationId: publicationIdentity(publication), catalogPublishedAt: 4 },
    }), ADDRESS), {
      role: "seller",
      phase: "funded",
      status: "ready",
      updatedAt: 5,
      contentHash: "funding-tx",
    }, phase);
    // Without its catalog entry the listing still needs publishing.
    assert.deepEqual(marketplaceSellerState(offer({ publish }), ADDRESS), {
      role: "seller",
      phase,
      status: "pending",
      updatedAt: 5,
      contentHash: "funding-tx",
    }, phase);
  }
  // Another transaction spent the funding's input, so the funding was forgotten: the listing is funded again.
  assert.deepEqual(marketplaceSellerState(offer({
    publish: {
      phase: "draft",
      catalogPublicationId: publicationIdentity(publication),
      catalogPublishedAt: 4,
      updatedAt: 5,
    },
  }), ADDRESS), {
    role: "seller",
    phase: "draft",
    status: "action-required",
    updatedAt: 5,
  });
});

test("buyer presentation follows the purchase from saved claim bytes to an accepted claim", () => {
  const buyer = (record: Partial<BuyRecord>, savedAt = 2) => marketplaceBuyerState(offer({
    source: "catalog",
    savedAt,
    buys: { [BUYER]: { buyerAddress: BUYER, commitment: BUY_COMMITMENT, publication, ...record } },
  }), ADDRESS);
  const prepared = { claimContentHash: "claim-tx", claimTransactionHex: "0x01", claimAnchorBlockNumber: "9", claimAnchorBlockHash: "0xa", claimNotAfter: "10" };
  // Claim bytes proved before payment do not make a purchase.
  assert.deepEqual(buyer(prepared), { role: "buyer", phase: "selected", status: "action-required", updatedAt: 2 });
  assert.deepEqual(buyer({ ...prepared, paymentBroadcastRequestedAt: 3 }), {
    role: "buyer", phase: "payment-ambiguous", status: "action-required", updatedAt: 3,
  });
  assert.deepEqual(buyer({ ...prepared, txHash: "0xpayment" }), {
    role: "buyer", phase: "payment-pending", status: "pending", updatedAt: 2, paymentHash: "0xpayment",
  });
  // Paid without an accepted claim: the carried claim is pending or needs retry.
  assert.deepEqual(buyer({ ...prepared, txHash: "0xpayment", blockNumber: "10", paidAt: 3 }), {
    role: "buyer", phase: "paid", status: "action-required", updatedAt: 3, paymentHash: "0xpayment",
  });
  assert.deepEqual(buyer({ txHash: "0xpayment", blockNumber: "10", paidAt: 3, claimContentHash: "claim-tx", claimAcceptedBlock: "11" }), {
    role: "buyer", phase: "claim-accepted", status: "pending", updatedAt: 3, paymentHash: "0xpayment", contentHash: "claim-tx",
  });
  assert.deepEqual(buyer({ txHash: "0xpayment", blockNumber: "10", paidAt: 3, claimContentHash: "claim-tx", claimAcceptedBlock: "11", claimedAt: 12 }), {
    role: "buyer", phase: "claimed", status: "complete", updatedAt: 12, paymentHash: "0xpayment", contentHash: "claim-tx",
  });
});

test("Marketplace activity is stable, role-specific, and newest first", () => {
  const rows = marketplaceActivity([
    offer({ publish: {
      phase: "funded",
      fundingContentHash: "funding-tx",
      catalogPublicationId: publicationIdentity(publication),
      catalogPublishedAt: 2,
      updatedAt: 2,
    } }),
    offer({
      key: "buyer-offer",
      source: "catalog",
      savedAt: 5,
      buys: {
        [BUYER]: {
          buyerAddress: BUYER, commitment: BUY_COMMITMENT,
          publication,
          txHash: "0xpayment",
        },
      },
    }),
  ], ADDRESS);
  assert.deepEqual(rows.map(({ key, role, phase }) => ({ key, role, phase })), [
    { key: `buyer-offer:buyer:${BUYER}`, role: "buyer", phase: "payment-pending" },
    { key: "buyer-offer:seller", role: "seller", phase: "funded" },
    { key: "offer:seller", role: "seller", phase: "funded" },
  ]);
});
