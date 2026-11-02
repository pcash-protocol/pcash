import {
  fieldToHex,
  fullOutputCommitment,
  noteNk,
  nullifier,
  type PcashNodeClient,
} from "@pcash/sdk/browser";
import { MIN_CLAIM_WINDOW_SECONDS } from "../commitments.mts";
import { publicationEscrowNote, type OfferPublication } from "./publication.ts";
import { deriveVerifiedL2ContractMaterial } from "./verifiedContractMaterial.ts";

/**
 * Clients stop offering a listing for new purchases this long before T - W,
 * the latest time a `buy` may execute, leaving time to include the payment and
 * prove the claim.
 */
export const PURCHASE_MARGIN_SECONDS = 1_800n;

/** The time from which a client no longer offers a listing for new purchases. */
export function purchaseCutoff(deadlineT: bigint): bigint {
  return deadlineT - MIN_CLAIM_WINDOW_SECONDS - PURCHASE_MARGIN_SECONDS;
}

export function openForPurchase(publication: OfferPublication, nowSeconds: bigint): boolean {
  return nowSeconds < purchaseCutoff(BigInt(publication.terms.deadlineT));
}

export function escrowCommitments(publication: OfferPublication, opening: NonNullable<OfferPublication["escrow"]>, material = deriveVerifiedL2ContractMaterial(publication)) {
  const note = publicationEscrowNote({ ...publication, escrow: opening }, material);
  const leaf = fullOutputCommitment(note, note.leafIndex);
  return { leaf, nullifier: fieldToHex(nullifier(leaf, noteNk(material.nkRoot), note.noteSecret)) };
}

/**
 * The content hash of the seller's reclaim that spent this listing's escrow,
 * or null while the escrow is unspent or a buyer's claim spent it. A claim
 * expires by T and a reclaim starts after T, so the spender is the reclaim
 * exactly when its block is after T.
 */
export async function readEscrowReclaim(
  node: Pick<PcashNodeClient, "getTransactionByNullifier">,
  publication: OfferPublication,
): Promise<string | null> {
  const spender = await node.getTransactionByNullifier(escrowCommitments(publication, publication.escrow!).nullifier);
  return spender !== null && spender.summary.timestamp > BigInt(publication.terms.deadlineT)
    ? spender.summary.contentHash.toLowerCase() : null;
}

/** Refreshable discovery view; payment still requires full offer verification. */
export async function fetchOpenOffers(
  node: Pick<PcashNodeClient, "areNullifiersSpent">,
  publications: readonly OfferPublication[],
  nowSeconds = BigInt(Math.floor(Date.now() / 1000)),
): Promise<OfferPublication[]> {
  const candidates = publications.flatMap((publication) => publication.escrow === undefined || !openForPurchase(publication, nowSeconds)
    ? [] : [{ publication, nullifier: escrowCommitments(publication, publication.escrow).nullifier }]);
  const open: OfferPublication[] = [];
  // The node accepts at most 256 nullifiers per request.
  for (let offset = 0; offset < candidates.length; offset += 256) {
    const batch = candidates.slice(offset, offset + 256);
    const spent = await node.areNullifiersSpent(batch.map((item) => item.nullifier));
    for (const [index, item] of batch.entries()) if (!spent[index]) open.push(item.publication);
  }
  return open;
}
