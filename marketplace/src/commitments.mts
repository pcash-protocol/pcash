// Marketplace function configuration commitments (app layer). Ports the two
// function-internal Poseidon schemes from the escrow claim and reclaim circuits to
// TypeScript, reusing the SDK's poseidon so on-chain / in-circuit / SDK values all
// agree. These are NOT protocol domain tags, so they live here, not in the SDK.

import { encodeAbiParameters, hexToBytes, keccak256, numberToHex, toBytes } from "viem";
import { poseidon } from "@pcash/sdk/crypto";
import { CARRIER_KIND_EVENT, carrierContextHash, functionSelector } from "@pcash/sdk/protocol";
import type { NetworkConfigLike } from "@pcash/sdk/browser";
import { configurationProfileCommitment } from "@pcash/sdk/source-verification";
import {
  MARKETPLACE_CLAIM_SOURCE_PROFILE,
  MARKETPLACE_RECLAIM_SOURCE_PROFILE,
  claimConfigurationInput,
  reclaimConfigurationInput,
} from "./configurationProfiles.mts";

export type FieldNumberish = bigint | number | string;

// The escrow smart contract's two functions: the buyer's claim and the
// seller's reclaim.
export const CLAIM_FUNCTION_SELECTOR = functionSelector(0);
export const RECLAIM_FUNCTION_SELECTOR = functionSelector(1);

/** The domain tag of context "escrow_claim_key_commitment", as in the claim circuit. */
export const CLAIM_KEY_COMMITMENT_DOMAIN =
  0x19da12774714919e93812df8ba5c02a9830fe550055e12910e97421d3cbd0191n;

// configurationCommitment = poseidon(REFERENCE_CONFIGURATION_DOMAIN, salt,
//   seller, offerId, deadlineT, domainSeparatorHigh128, domainSeparatorLow128):
// the seller, the offer, its deadline T (reclaim is valid only after it), and
// the EIP-712 domain separator the seller signs under.
export function reclaimConfigurationCommitment(
  configurationSalt: FieldNumberish,
  network: NetworkConfigLike,
  seller: FieldNumberish,
  offerId: FieldNumberish,
  deadlineT: FieldNumberish,
): bigint {
  return configurationProfileCommitment(
    MARKETPLACE_RECLAIM_SOURCE_PROFILE,
    reclaimConfigurationInput(configurationSalt, network, seller, offerId, deadlineT),
  );
}

export const PAYMENT_EVENT_SIGNATURE = "Payment(bytes32,address,address,uint256,bytes32,bytes)";
export const PAYMENT_EVENT_SIG = keccak256(toBytes(PAYMENT_EVENT_SIGNATURE));
/**
 * The client's minimum time between a payment and T: a `buy`'s `notAfter` is no
 * later than T minus this. It leaves room for nodes to resume after a
 * network-wide derivation halt, a fresh claim proof, and L1 inclusion of a
 * `retry`.
 */
export const MIN_CLAIM_WINDOW_SECONDS = 86_400n;
export const MAX_PAYMENT_DEADLINE_T = (1n << 64n) - 1n;

/** The earliest notBeforeTimestamp reclaim() accepts: strictly after T. */
export function reclaimNotBefore(deadlineT: bigint): bigint {
  return deadlineT + 1n;
}

export function assertPaymentDeadlineT(deadlineT: bigint): void {
  if (deadlineT < 0n || deadlineT > MAX_PAYMENT_DEADLINE_T) {
    throw new Error(`deadlineT ${deadlineT} does not fit uint64`);
  }
}

export { CLAIM_APPLICATION_VK_HASH, RECLAIM_APPLICATION_VK_HASH } from "./applicationPins.ts";

export interface OfferTerms {
  router: bigint; // uint160 router address
  seller: bigint; // uint160 seller address
  id: bigint; // per-offer instance id
  assetId: bigint; // escrowed standard asset; 0 is native PCASH
  amount: bigint; // exact base units delivered by the escrow spend
  ethPriceWei: bigint; // exact ETH wei paid through the router
  deadlineT: bigint; // claim deadline T
}

// configurationCommitment = poseidon(REFERENCE_CONFIGURATION_DOMAIN, salt,
//   router, seller, offerId, assetId, amount, ethPriceWei, deadlineT)
export function claimConfigurationCommitment(
  configurationSalt: FieldNumberish,
  o: OfferTerms,
): bigint {
  return configurationProfileCommitment(MARKETPLACE_CLAIM_SOURCE_PROFILE, claimConfigurationInput(configurationSalt, o));
}

// The payment authorizes the exact escrow note for the claim-key holder.
export function claimKeyCommitment(
  claimKey: FieldNumberish,
  escrowOutputCommitment: FieldNumberish,
): bigint {
  return poseidon([CLAIM_KEY_COMMITMENT_DOMAIN, claimKey, escrowOutputCommitment]);
}

/**
 * The router's `PcashBatch` context for a payment:
 * `abi.encode(bytes32 offerId, address seller, uint256 ethPriceWei, bytes32 claimKeyCommitment)`.
 */
export function paymentCarrierContext(
  terms: Pick<OfferTerms, "seller" | "id" | "ethPriceWei">,
  claimKeyCommitment: bigint,
): `0x${string}` {
  return encodeAbiParameters(
    [{ type: "bytes32" }, { type: "address" }, { type: "uint256" }, { type: "bytes32" }],
    [toBytes32(terms.id), numberToHex(terms.seller, { size: 20 }), terms.ethPriceWei, toBytes32(claimKeyCommitment)],
  );
}

/** The carrier context the claim requires: the router's `PcashBatch` event for the payment. */
export function paymentCarrierContextHash(
  terms: Pick<OfferTerms, "router" | "seller" | "id" | "ethPriceWei">,
  claimKeyCommitment: bigint,
): bigint {
  return carrierContextHash(
    CARRIER_KIND_EVENT,
    numberToHex(terms.router, { size: 20 }),
    hexToBytes(paymentCarrierContext(terms, claimKeyCommitment)),
  );
}

// 32-byte big-endian hex of a field element (a bytes32 router argument or context word).
export function toBytes32(x: bigint): `0x${string}` {
  return numberToHex(x, { size: 32 });
}
