import { DEFAULT_EVENT_ENTRY } from "@pcash/sdk/protocol";
// Browser-safe witness assembly for the marketplace reclaim circuit.
// Signing uses the SDK's EIP-712 implementation so this stays byte-for-byte
// aligned with the circuit and the Node reference flow.

import {
  arenaHash,
  createPcashAuthorizationRequest,
  authorizationIssuanceOpening,
  type DesignatedIssuanceOpening,
  ownerCommitment,
  outputDataHash,
  pcashTypedData,
  poseidon,
  requestPcashAuthorization,
  requirePcashAuthorization,
  resolveNetworkConfig,
  toField,
  type FieldNumberish,
  type NetworkConfigLike,
  type PcashActionSigner,
  type PcashAuthorizationRequest,
  type PcashTypedData,
  type PrivateValue,
  type VerifiedPcashAuthorization,
  type WitnessMap,
} from "@pcash/sdk/browser";
import { fieldArrayMap, fm, privateValueMap } from "@pcash/sdk/builders";
import type { PcashProfile } from "@pcash/sdk/wallet";
import { reclaimConfigurationInput } from "../configurationProfiles.mts";

/** The escrow note's secret, asset, and amount; the escrow contract owns it. */
export interface ReclaimEscrowNoteWitness {
  noteSecret: bigint;
  assetId: bigint;
  amount: bigint;
  outputIndex: bigint;
}

export interface ReclaimWitnessParams {
  recentPcashBlockHash: bigint;
  eventEntry?: bigint;
  /** The seller's account pays the network fee through the sponsored-transfer kernel. */
  feePaid: boolean;
  network: NetworkConfigLike;
  configurationSalt: bigint;
  offerId: bigint;
  deadlineT: bigint;
  escrowContract: bigint;
  recipient: bigint;
  /** The reclaim authority; its signing key's address is the configured seller. */
  sellerProfile: Pick<PcashProfile, "address">;
  authorization: VerifiedPcashAuthorization;
  transaction: PrivateValue;
  /** The posted output data and arena whose delivery commitment the transaction carries. */
  outputData: readonly Uint8Array[];
  arena: Uint8Array;
  designatedIssuanceOpening?: DesignatedIssuanceOpening;
  escrowNote: ReclaimEscrowNoteWitness;
  payoutNoteSecret: bigint;
  payoutAmount: bigint;
  relayFeeAmount: bigint;
  relayFeeOwnerCommitment: bigint;
  payoutOpeningBlinder: bigint;
}

export const MARKETPLACE_RECLAIM_EIP712_TYPE =
  "PcashMarketplaceReclaim(uint256 pcashChainId,address escrowContract,bytes32 offerId,uint256 assetId,address recipient,uint256 payoutAmount,uint256 openFeeAmount,address issuanceRecipient,uint256 issuanceOwnerCommitment,uint256 relayFeeAmount,uint256 relayFeeOwnerCommitment,uint256 transactionContext,uint64 notBefore,uint64 validUntil,bytes32 payoutOpeningCommitment)";
/** The domain tag of context "escrow_reclaim_payout_opening", as in the reclaim circuit. */
export const RECLAIM_PAYOUT_OPENING_DOMAIN =
  0x2881c3c5884c7b6f25f880e448cfc78e5d28f5d313d6890207b568221c727626n;

export interface MarketplaceReclaimMessage {
  pcashChainId: bigint;
  escrowContract: bigint;
  offerId: bigint;
  assetId: bigint;
  recipient: bigint;
  payoutAmount: bigint;
  openFeeAmount: bigint;
  issuanceRecipient: bigint;
  issuanceOwnerCommitment: bigint;
  relayFeeAmount: bigint;
  relayFeeOwnerCommitment: bigint;
  transactionContext: bigint;
  notBefore: bigint;
  validUntil: bigint;
  payoutOpeningCommitment: bigint;
}

/**
 * The signed payout opening binds the payout owner, the payout slot's data
 * hash, and the arena hash, each opened from the transaction's delivery
 * commitment.
 */
export function marketplaceReclaimPayoutOpeningCommitment(params: {
  blinder: FieldNumberish;
  recipient: FieldNumberish;
  payoutNoteSecret: FieldNumberish;
  outputDataHash: FieldNumberish;
  arenaHash: FieldNumberish;
}): bigint {
  const blinder = toField(params.blinder, "payoutOpeningBlinder");
  const recipientOwnerCommitment = ownerCommitment(
    toField(params.recipient, "recipient"),
    toField(params.payoutNoteSecret, "payoutNoteSecret"),
  );
  return poseidon([
    RECLAIM_PAYOUT_OPENING_DOMAIN,
    blinder,
    recipientOwnerCommitment,
    toField(params.outputDataHash, "payoutOutputDataHash"),
    toField(params.arenaHash, "arenaHash"),
  ]);
}

/** The output-data hashes and arena hash the reclaim circuit opens from the delivery commitment. */
function reclaimDelivery(params: Pick<ReclaimWitnessParams, "outputData" | "arena">) {
  return { outputDataHashes: params.outputData.map(outputDataHash), arenaHash: arenaHash(params.arena) };
}

export function marketplaceReclaimTypedData(
  network: NetworkConfigLike,
  message: MarketplaceReclaimMessage,
): PcashTypedData<"PcashMarketplaceReclaim"> {
  return pcashTypedData(network, MARKETPLACE_RECLAIM_EIP712_TYPE, { ...message });
}

export type UnsignedReclaimWitnessParams = Omit<ReclaimWitnessParams, "authorization">;

function reclaimIssuance(params: Pick<ReclaimWitnessParams, "network" | "transaction" | "designatedIssuanceOpening">) {
  return authorizationIssuanceOpening(
    params.transaction.global.issuanceOwnerCommitment,
    resolveNetworkConfig(params.network).pcashChainId,
    params.transaction.inputs.map((input) => input.nullifier),
    params.designatedIssuanceOpening,
  );
}

function reclaimMessage(params: Pick<
  ReclaimWitnessParams,
  "network" | "escrowContract" | "offerId" | "escrowNote" | "recipient" | "payoutAmount" | "relayFeeAmount" | "relayFeeOwnerCommitment" | "payoutNoteSecret" | "payoutOpeningBlinder" | "transaction" | "outputData" | "arena" | "designatedIssuanceOpening"
>): MarketplaceReclaimMessage {
  const issuance = reclaimIssuance(params);
  const delivery = reclaimDelivery(params);
  return {
    pcashChainId: resolveNetworkConfig(params.network).pcashChainId,
    escrowContract: params.escrowContract,
    offerId: params.offerId,
    assetId: params.escrowNote.assetId,
    recipient: params.recipient,
    payoutAmount: params.payoutAmount,
    openFeeAmount: toField(params.transaction.global.openFeeAmount, "openFeeAmount"),
    issuanceRecipient: issuance.issuanceRecipient,
    issuanceOwnerCommitment: toField(params.transaction.global.issuanceOwnerCommitment),
    relayFeeAmount: params.relayFeeAmount,
    relayFeeOwnerCommitment: params.relayFeeOwnerCommitment,
    transactionContext: issuance.transactionContext,
    notBefore: toField(params.transaction.global.notBeforeTimestamp, "notBefore"),
    validUntil: toField(params.transaction.global.validUntilTimestamp, "validUntil"),
    payoutOpeningCommitment: marketplaceReclaimPayoutOpeningCommitment({
      blinder: params.payoutOpeningBlinder,
      recipient: params.recipient,
      payoutNoteSecret: params.payoutNoteSecret,
      outputDataHash: delivery.outputDataHashes[0]!,
      arenaHash: delivery.arenaHash,
    }),
  };
}

/** Exact semantic request verified by the reclaim circuit. */
export function reclaimAuthorizationRequest(params: Pick<
  ReclaimWitnessParams,
  "network" | "sellerProfile" | "escrowContract" | "offerId" | "escrowNote" | "recipient" | "payoutAmount" | "relayFeeAmount" | "relayFeeOwnerCommitment" | "payoutNoteSecret" | "payoutOpeningBlinder" | "transaction" | "outputData" | "arena" | "designatedIssuanceOpening"
>): PcashAuthorizationRequest {
  return createPcashAuthorizationRequest({
    kind: "marketplace-reclaim",
    authorizingAddress: params.sellerProfile.address,
    typedData: marketplaceReclaimTypedData(params.network, reclaimMessage(params)),
  });
}

/** Build the exact InputMap consumed by the reclaim-circuit Noir artifact. */
export function buildReclaimWitnessMap(p: ReclaimWitnessParams): WitnessMap {
  const signature = requirePcashAuthorization(reclaimAuthorizationRequest(p), p.authorization);
  const configuration = reclaimConfigurationInput(
    p.configurationSalt,
    p.network,
    p.sellerProfile.address,
    p.offerId,
    p.deadlineT,
  );
  const issuance = reclaimIssuance(p);
  const delivery = reclaimDelivery(p);
  return {
    recent_pcash_block_hash: fm(p.recentPcashBlockHash),
    event_entry: fm(p.eventEntry ?? DEFAULT_EVENT_ENTRY),
    pcash_chain_id: fm(resolveNetworkConfig(p.network).pcashChainId),
    fee_paid: p.feePaid,
    configuration: {
      configuration_salt: fm(configuration.configurationSalt),
      offer_id: fm(configuration.offerId),
      deadline_t: fm(configuration.deadlineT),
      domain_separator_high: fm(configuration.domainSeparatorHigh),
      domain_separator_low: fm(configuration.domainSeparatorLow),
    },
    signature: { signature: Array.from(signature.compact) },
    pubkey: {
      x: Array.from(signature.pubX),
      y: Array.from(signature.pubY),
    },
    escrow_contract: fm(p.escrowContract),
    recipient: fm(p.recipient),
    issuance_recipient: fm(issuance.issuanceRecipient),
    issuance_note_secret: fm(issuance.issuanceNoteSecret),
    payout_opening_blinder: fm(p.payoutOpeningBlinder),
    private_value: privateValueMap(p.transaction),
    output_data_hashes: fieldArrayMap(delivery.outputDataHashes),
    arena_hash: fm(delivery.arenaHash),
    escrow_note: {
      note_secret: fm(p.escrowNote.noteSecret),
      asset_id: fm(p.escrowNote.assetId),
      amount: fm(p.escrowNote.amount),
    },
    escrow_output_index: fm(p.escrowNote.outputIndex),
    payout_note_secret: fm(p.payoutNoteSecret),
    relay_fee_amount: fm(p.relayFeeAmount),
    relay_fee_owner_commitment: fm(p.relayFeeOwnerCommitment),
  };
}

/** Ask the selected signer and attach only a verified response to the witness. */
export async function authorizeReclaimWitnessMap(
  params: UnsignedReclaimWitnessParams,
  signer: PcashActionSigner,
): Promise<WitnessMap> {
  const authorization = await requestPcashAuthorization(
    signer,
    reclaimAuthorizationRequest(params),
  );
  return buildReclaimWitnessMap({ ...params, authorization });
}
