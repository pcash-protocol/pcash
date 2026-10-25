import { defineRecordSchema, packed, readRecord, type DataRecord } from "@pcash/sdk/protocol";
import { hexToBytes, bytesToHex, type Hex } from "viem";
import { fieldToHex, decodeTransaction, type NetworkConfigLike } from "@pcash/sdk/browser";
import type { PcashProfile, WalletExecutionContext } from "@pcash/sdk/wallet";
import { createOffer } from "../offer.mts";
import { CLAIM_APPLICATION_VK_HASH, RECLAIM_APPLICATION_VK_HASH } from "../commitments.mts";
import { publicationFromOffer, type OfferPublication } from "./publication.ts";

/**
 * The offer terms the seller's profile cannot derive, written to the seller's
 * sender region of the funding transaction. The escrow note's asset and amount
 * are the sent output's own.
 */
export const sellerRecordSchema = defineRecordSchema("org.pcash.marketplace-seller", packed.struct({
  nkRoot: packed.field,
  ethPriceWei: packed.bigUint(128),
  deadlineT: packed.bigUint(64),
  router: packed.address,
  seller: packed.address,
}));

export function sellerRecord(offer: { l2ContractNkRoot: bigint; terms: { ethPriceWei: bigint; deadlineT: bigint; router: bigint; seller: bigint } }): DataRecord {
  const { ethPriceWei, deadlineT, router, seller } = offer.terms;
  return sellerRecordSchema.encode({ nkRoot: offer.l2ContractNkRoot, ethPriceWei, deadlineT, router, seller });
}

export interface RestoredSellerOffer { publication: OfferPublication; missingContract: boolean }

/** Sync reopens sent outputs from this wallet's sender regions and checks each against its chain commitment. */
export async function recoverSellerOffers(
  context: Pick<WalletExecutionContext, "store" | "node">,
  seller: PcashProfile,
  network: NetworkConfigLike,
): Promise<{ offers: RestoredSellerOffer[]; errors: string[] }> {
  const offers: RestoredSellerOffer[] = [];
  const errors: string[] = [];
  const sentOutputs = (await context.store.load())?.sentOutputs ?? [];
  const byTransaction = new Map<string, typeof sentOutputs>();
  for (const sent of sentOutputs) byTransaction.set(sent.transactionId, [...byTransaction.get(sent.transactionId) ?? [], sent]);
  for (const [transactionId, outputs] of byTransaction) {
    // Every output of a transaction carries that transaction's sender records.
    const record = readRecord(outputs[0]!.senderRecords?.map(({ schema, data }) => ({ schema, data: hexToBytes(data as Hex) })), sellerRecordSchema);
    if (record === undefined) continue;
    try {
      // The escrow is the sent output whose asset and amount complete the terms of the funded contract.
      const escrow = outputs.map((sent) => ({ sent, offer: createOffer({ network, sellerWallet: seller, l2ContractNkRoot: record.nkRoot,
        terms: { seller: record.seller, router: record.router, assetId: BigInt(sent.assetId), amount: BigInt(sent.amount), ethPriceWei: record.ethPriceWei, deadlineT: record.deadlineT },
        claimApplicationVkHash: CLAIM_APPLICATION_VK_HASH,
        reclaimApplicationVkHash: RECLAIM_APPLICATION_VK_HASH,
      }) })).find(({ sent, offer }) => offer.l2ContractAddress === BigInt(sent.recipientAddress));
      if (escrow === undefined) throw new Error("recovery terms do not reconstruct the funded contract");
      const { sent, offer } = escrow;
      const contract = await context.node.getContract(sent.recipientAddress);
      if (contract.status !== "notFound") {
        if (contract.status !== "contract") throw new Error("funded contract is unavailable");
        const creation = decodeTransaction(hexToBytes(contract.transaction as Hex));
        if (!("body" in creation) || bytesToHex(creation.body) !== bytesToHex(offer.l2ContractBody)) throw new Error("recovered contract differs from its registered body");
      }
      const publication = publicationFromOffer(offer, sent.assetDefinition === undefined ? undefined : hexToBytes(sent.assetDefinition as Hex));
      const leafIndex = Number(sent.leafIndex);
      if (!Number.isSafeInteger(leafIndex)) throw new Error("escrow output index exceeds the supported range");
      publication.escrow = { leafIndex, noteSecret: fieldToHex(BigInt(sent.noteSecret)), amount: fieldToHex(BigInt(sent.amount)) };
      offers.push({ publication, missingContract: contract.status === "notFound" });
    } catch (cause) { errors.push(`Seller recovery ${transactionId}: ${cause instanceof Error ? cause.message : String(cause)}`); }
  }
  return { offers, errors };
}
