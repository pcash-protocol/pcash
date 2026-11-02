import { REFERENCE_CONFIGURATION_DOMAIN } from "@pcash/sdk/constants";
import { fieldToHex } from "@pcash/sdk/crypto";
import type { ContractConfigurationProfile } from "@pcash/sdk/source-verification";
import { referenceDomainSeparatorHalves, type NetworkConfigLike } from "@pcash/sdk/browser";
import type { FieldNumberish, OfferTerms } from "./commitments.mts";

export const MARKETPLACE_CLAIM_SOURCE_PROFILE: ContractConfigurationProfile = {
  id: "pcash-marketplace-fixed-price-escrow-claim-v1",
  implementationLabel: "FixedPriceEscrow.claim",
  selector: 0,
  scheme: "poseidon-explicit-domain-positional-v1",
  domain: fieldToHex(REFERENCE_CONFIGURATION_DOMAIN),
  fields: [
    { name: "configurationSalt", type: "field" },
    { name: "router", type: "uint160", bits: 160 },
    { name: "seller", type: "uint160", bits: 160 },
    { name: "offerId", type: "field" },
    { name: "assetId", type: "field" },
    { name: "amount", type: "uint128", bits: 128 },
    { name: "ethPriceWei", type: "uint128", bits: 128 },
    { name: "deadlineT", type: "uint64", bits: 64 },
  ],
};

export const MARKETPLACE_RECLAIM_SOURCE_PROFILE: ContractConfigurationProfile = {
  id: "pcash-marketplace-fixed-price-escrow-reclaim-v1",
  implementationLabel: "FixedPriceEscrow.reclaim",
  selector: 1,
  scheme: "poseidon-explicit-domain-positional-v1",
  domain: fieldToHex(REFERENCE_CONFIGURATION_DOMAIN),
  fields: [
    { name: "configurationSalt", type: "field" },
    { name: "seller", type: "uint160", bits: 160 },
    { name: "offerId", type: "field" },
    { name: "deadlineT", type: "uint64", bits: 64 },
    { name: "domainSeparatorHigh", type: "uint128", bits: 128 },
    { name: "domainSeparatorLow", type: "uint128", bits: 128 },
  ],
};

export function claimConfigurationInput(configurationSalt: FieldNumberish, terms: OfferTerms) {
  return {
    configurationSalt,
    router: terms.router,
    seller: terms.seller,
    offerId: terms.id,
    assetId: terms.assetId,
    amount: terms.amount,
    ethPriceWei: terms.ethPriceWei,
    deadlineT: terms.deadlineT,
  };
}

/** The seller signs reclaims under the network's PCASH EIP-712 domain; the configuration commits its separator. */
export function reclaimConfigurationInput(
  configurationSalt: FieldNumberish,
  network: NetworkConfigLike,
  seller: FieldNumberish,
  offerId: FieldNumberish,
  deadlineT: FieldNumberish,
) {
  const separator = referenceDomainSeparatorHalves(network);
  return {
    configurationSalt,
    seller,
    offerId,
    deadlineT,
    domainSeparatorHigh: separator.high,
    domainSeparatorLow: separator.low,
  };
}
