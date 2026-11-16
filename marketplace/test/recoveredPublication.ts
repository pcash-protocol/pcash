// Chain fixtures retained across simulated loss of the marketplace store.
import assert from "node:assert/strict";
import { bytesToHex, type Hex } from "viem";
import { addressHex, type PcashNodeClient, type StatusResult } from "@pcash/sdk/browser";
import { buildUnfundedContractCreation } from "@pcash/sdk/builders";
import { decodeContractBody } from "@pcash/sdk/protocol";
import type { PcashProfile, WalletExecutionContext } from "@pcash/sdk/wallet";
import type { Offer } from "../src/offer.mts";
import { publicationIdentity, type OfferPublication } from "../src/client/publication.ts";
import { sellerRecord, recoverSellerOffers } from "../src/client/sellerRecovery.ts";
import { purchaseCommitment } from "../src/client/buy.ts";
import { encodePaymentRecovery, recoverPaymentPublication } from "../src/client/paymentRecovery.ts";
import { toBytes32 } from "../src/commitments.mts";

function contract(offer: Offer) {
  return { status: "contract", transaction: bytesToHex(buildUnfundedContractCreation({ pcashChainId: offer.chainId,
    contract: decodeContractBody(offer.l2ContractBody), recentPcashBlockHash: 1n, validUntilTimestamp: 1n }).transactionBytes) };
}

export async function restoredSellerPublication(offer: Offer, publication: OfferPublication, seller: PcashProfile): Promise<OfferPublication> {
  const escrow = publication.escrow!;
  // As the wallet stores the escrow output: its funding transaction's sender records repeat on each sent output.
  const record = sellerRecord(offer);
  const context = { node: { getContract: async () => contract(offer) }, store: { load: async () => ({ sentOutputs: [{
    transactionId: `0x${"22".repeat(32)}`, recipientAddress: addressHex(offer.l2ContractAddress), assetId: publication.terms.assetId, amount: publication.terms.amount,
    leafIndex: String(escrow.leafIndex), noteSecret: escrow.noteSecret, assetDefinition: publication.assetDefinition,
    senderRecords: [{ schema: record.schema, data: bytesToHex(record.data) }],
  }] }) } } as unknown as WalletExecutionContext;
  const result = await recoverSellerOffers(context, seller, offer.network);
  assert.deepEqual(result.errors, []);
  const restored = result.offers[0]!.publication;
  assert.equal(publicationIdentity(restored), publicationIdentity(publication));
  return restored;
}

export async function restoredBuyerPublication(offer: Offer, publication: OfferPublication, buyer: PcashProfile): Promise<OfferPublication> {
  const blockHash = `0x${"11".repeat(32)}` as Hex;
  const log = { transactionHash: blockHash, blockNumber: 2n, blockHash, args: {
    offerId: toBytes32(offer.terms.id), seller: addressHex(offer.terms.seller), amount: offer.terms.ethPriceWei,
    deadlineT: offer.terms.deadlineT, claimKeyCommitment: purchaseCommitment(publication, buyer), recoveryData: encodePaymentRecovery(publication),
  } };
  const result = await recoverPaymentPublication({
    node: { getContract: async () => contract(offer), getOutputPath: async () => ({}) } as unknown as PcashNodeClient,
    status: { pcashChainId: Number(offer.chainId), l1ChainId: offer.network.l1ChainId, inboxAddress: addressHex(offer.network.inboxAddress) } as StatusResult,
    profile: buyer, router: addressHex(offer.terms.router), log,
    client: { getBlock: async () => ({ hash: blockHash, timestamp: 1n }) } as unknown as Parameters<typeof recoverPaymentPublication>[0]["client"],
  });
  assert.equal(publicationIdentity(result.publication), publicationIdentity(publication));
  return result.publication;
}
