import { DEFAULT_EVENT_ENTRY } from "@pcash/sdk/protocol";
// Browser-safe witness assembly for the marketplace claim.

import {
  ownerCommitment,
  type PrivateValue,
  type WitnessMap,
} from "@pcash/sdk/browser";
import { fm, privateValueMap } from "@pcash/sdk/builders";

export interface OfferWitness {
  router: bigint;
  seller: bigint;
  id: bigint;
  assetId: bigint;
  amount: bigint;
  ethPriceWei: bigint;
  deadlineT: bigint;
}

/** The escrow note's secret and leaf; the escrow contract's address owns it and the offer fixes its asset and amount. */
export interface ClaimEscrowNoteWitness {
  noteSecret: bigint;
  outputIndex: bigint;
}

export interface ClaimWitnessParams {
  recentPcashBlockHash: bigint;
  eventEntry?: bigint;
  /** The escrow Contract Account's address, which owns the escrow note. */
  address: bigint;
  pcashChainId: bigint;
  /** The buyer's account pays the network fee through the sponsored-transfer kernel. */
  feePaid: boolean;
  configurationSalt: bigint;
  offer: OfferWitness;
  claimKey: bigint;
  transaction: PrivateValue;
  escrowNote: ClaimEscrowNoteWitness;
  /** The payout recipient's address. */
  payoutOwner: bigint;
  payoutNoteSecret: bigint;
  relayFeeAmount: bigint;
  relayFeeOwnerCommitment: bigint;
}

/** Build the exact InputMap consumed by `new Noir(circuit).execute(map)`. */
export function buildClaimWitnessMap(p: ClaimWitnessParams): WitnessMap {
  const offer = p.offer;
  return {
    recent_pcash_block_hash: fm(p.recentPcashBlockHash),
    event_entry: fm(p.eventEntry ?? DEFAULT_EVENT_ENTRY),
    address: fm(p.address),
    pcash_chain_id: fm(p.pcashChainId),
    fee_paid: p.feePaid,
    configuration: {
      configuration_salt: fm(p.configurationSalt),
      router: fm(offer.router),
      seller: fm(offer.seller),
      offer_id: fm(offer.id),
      asset_id: fm(offer.assetId),
      amount: fm(offer.amount),
      eth_price_wei: fm(offer.ethPriceWei),
      deadline_t: fm(offer.deadlineT),
    },
    claim_key: fm(p.claimKey),
    private_value: privateValueMap(p.transaction),
    escrow_note: {
      note_secret: fm(p.escrowNote.noteSecret),
    },
    escrow_output_index: fm(p.escrowNote.outputIndex),
    payout_owner_commitment: fm(ownerCommitment(p.payoutOwner, p.payoutNoteSecret)),
    relay_fee_amount: fm(p.relayFeeAmount),
    relay_fee_owner_commitment: fm(p.relayFeeOwnerCommitment),
  };
}
