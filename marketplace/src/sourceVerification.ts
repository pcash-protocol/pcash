import { fieldToHex, toNonnegativeBigInt, type FieldNumberish } from "@pcash/sdk/crypto";
import { addressHex } from "@pcash/sdk/utils";
import {
  configurationProfileCommitment,
  configurationProfileValues,
  type ConfigurationOpening,
  type ContractConfigurationProfile,
  type ContractPresentationProfile,
} from "@pcash/sdk/source-verification";
import {
  CLAIM_APPLICATION_VK_HASH,
  RECLAIM_APPLICATION_VK_HASH,
  type OfferTerms,
} from "./commitments.mts";
import type { NetworkConfigLike } from "@pcash/sdk/protocol";
import type { OfferPublication } from "./client/publication.ts";
import { deriveVerifiedL2ContractMaterial } from "./client/verifiedContractMaterial.ts";

import {
  MARKETPLACE_CLAIM_SOURCE_PROFILE,
  MARKETPLACE_RECLAIM_SOURCE_PROFILE,
  claimConfigurationInput,
  reclaimConfigurationInput,
} from "./configurationProfiles.mts";
export { MARKETPLACE_CLAIM_SOURCE_PROFILE, MARKETPLACE_RECLAIM_SOURCE_PROFILE };

/** Self-declared Explorer copy bound to the exact FixedPriceEscrow function set. */
export const MARKETPLACE_ESCROW_PRESENTATION = {
  schemaVersion: 1,
  publisherLabel: "PCASH Marketplace",
  contractName: "FixedPriceEscrow",
  contractDescription: "This contract binds the configured asset and amount, ETH price, parties, timing, and network domains for one marketplace offer.",
  functions: [
    {
      selector: 0,
      applicationVkHash: fieldToHex(CLAIM_APPLICATION_VK_HASH),
      name: "claim",
      summary: "The router's PcashBatch event for the exact payment, and the claim key, authorize release; publication and issuance routes are chosen in the claim.",
      configurationFields: [
        {
          position: 0,
          name: "configurationSalt",
          label: "Configuration salt",
          description: "Random salt that makes this offer's claim configuration commitment unique.",
          displayFormat: "hex",
          overviewOrder: null,
        },
        {
          position: 1,
          name: "router",
          label: "Payment router",
          description: "Ethereum contract whose PcashBatch event must carry the claim.",
          displayFormat: "ethereum-address",
          overviewOrder: 4,
        },
        {
          position: 2,
          name: "seller",
          label: "Payment recipient",
          description: "Ethereum address the router's payment context names as the seller.",
          displayFormat: "ethereum-address",
          overviewOrder: 2,
        },
        {
          position: 3,
          name: "offerId",
          label: "Offer ID",
          description: "Identifier that binds the payment and claim key to this offer.",
          displayFormat: "hex",
          overviewOrder: null,
        },
        {
          position: 4,
          name: "assetId",
          label: "Asset",
          description: "Standard asset held in escrow; zero is native PCASH.",
          displayFormat: "field",
          overviewOrder: 7,
        },
        {
          position: 5,
          name: "amount",
          label: "Configured amount",
          description: "Exact base-unit amount of the configured asset authorized for release.",
          displayFormat: "uint",
          overviewOrder: 0,
        },
        {
          position: 6,
          name: "ethPriceWei",
          label: "ETH price",
          description: "Exact gross ETH payment the router's payment context must name.",
          displayFormat: "eth-amount",
          overviewOrder: 1,
        },
        {
          position: 7,
          name: "deadlineT",
          label: "Claim deadline",
          description: "The authorized transaction must expire no later than this time.",
          displayFormat: "unix-timestamp",
          overviewOrder: 5,
        },
      ],
      proofGroups: [
        {
          title: "Kernel statement",
          description: "Values the function binds into the statement it returns; the kernel checks them against the spending account, the chain, and the transaction's recent block.",
          items: [
            { abiParameter: "recent_pcash_block_hash", description: "Recent PCASH block the transaction is anchored to." },
            { abiParameter: "address", description: "Address of the escrow Contract Account, which owns the escrow note." },
            { abiParameter: "event_entry", description: "Commitment to the transaction event application and its event, passed through to the kernel statement." },
            { abiParameter: "pcash_chain_id", description: "PCASH chain the authorized transaction is bound to." },
          ],
        },
        {
          title: "Payment carrier",
          description: "Requires the transaction's carrier context to be the configured router's PcashBatch event for this offer ID, seller, ETH price, and the claim-key commitment of the exact escrow note spent: the router's event for that payment.",
          items: [
            {
              abiParameter: "claim_key",
              description: "Secret whose commitment to the spent escrow note the router's payment context names.",
            },
          ],
        },
        {
          title: "Committed configuration",
          description: "Opens the function's published configuration commitment to the exact instance terms.",
          items: [
            {
              abiParameter: "configuration",
              description: "Salt, router, payment recipient, offer ID, asset, amount, ETH price and claim deadline.",
            },
          ],
        },
        {
          title: "Authorized transaction",
          description: "Proves the exact escrow input becomes the payout; a native escrow also funds an optional private relay payment and open fee.",
          items: [
            {
              abiParameter: "private_value",
              description: "Padded input and output slots, fee, validity window and commitments.",
            },
            {
              abiParameter: "escrow_note",
              description: "Opens the escrow input note's secret; the escrow contract owns it, and the configuration fixes its asset and amount.",
            },
            {
              abiParameter: "escrow_output_index",
              description: "Locates the escrow input within the output-commitment tree.",
            },
            {
              abiParameter: "fee_paid",
              description: "Selects the sponsored role, where the claimant's own account pays a token claim's network fee.",
            },
            {
              abiParameter: "payout_owner_commitment",
              description: "Commits the private payout recipient's address and note secret.",
            },
            { abiParameter: "relay_fee_amount", description: "Exact private native-PCASH relay payment funded from the escrow's value, or zero; always zero for a token escrow." },
            { abiParameter: "relay_fee_owner_commitment", description: "Owner commitment for the escrow-funded relay payment, or zero." },
          ],
        },
      ],
    },
    {
      selector: 1,
      applicationVkHash: fieldToHex(RECLAIM_APPLICATION_VK_HASH),
      name: "reclaim",
      summary: "Seller signature and timeout authorize reclaim.",
      configurationFields: [
        {
          position: 0,
          name: "configurationSalt",
          label: "Configuration salt",
          description: "Random salt that makes this offer's reclaim configuration commitment unique.",
          displayFormat: "hex",
          overviewOrder: null,
        },
        {
          position: 1,
          name: "seller",
          label: "Reclaim authority",
          description: "Ethereum address whose EIP-712 signature authorizes reclaim.",
          displayFormat: "ethereum-address",
          overviewOrder: 3,
        },
        {
          position: 2,
          name: "offerId",
          label: "Offer ID",
          description: "Marketplace offer this reclaim function belongs to.",
          displayFormat: "field",
          overviewOrder: null,
        },
        {
          position: 3,
          name: "deadlineT",
          label: "Reclaim after",
          description: "Offer deadline T; the authorized transaction may become valid only after it.",
          displayFormat: "unix-timestamp",
          overviewOrder: 6,
        },
        {
          position: 4,
          name: "domainSeparatorHigh",
          label: "Signing domain (high)",
          description: "High 128 bits of the EIP-712 domain separator the seller signs under; it fixes the Ethereum chain and Inbox.",
          displayFormat: "hex",
          overviewOrder: null,
        },
        {
          position: 5,
          name: "domainSeparatorLow",
          label: "Signing domain (low)",
          description: "Low 128 bits of the EIP-712 domain separator the seller signs under.",
          displayFormat: "hex",
          overviewOrder: null,
        },
      ],
      proofGroups: [
        {
          title: "Kernel statement",
          description: "Values the function binds into the statement it returns; the kernel checks them against the spending account, the chain, and the transaction's recent block.",
          items: [
            { abiParameter: "recent_pcash_block_hash", description: "Recent PCASH block the transaction is anchored to." },
            { abiParameter: "event_entry", description: "Commitment to the transaction event application and its event, passed through to the kernel statement." },
            { abiParameter: "pcash_chain_id", description: "PCASH chain named in the seller's signed message." },
          ],
        },
        {
          title: "Seller authorization",
          description: "Proves the configured seller signed the offer, escrow, asset, payout, open fee, private relay payment, issuance route, and validity window.",
          items: [
            {
              abiParameter: "signature",
              description: "Low-s secp256k1 signature over the semantic Marketplace reclaim message.",
            },
            {
              abiParameter: "pubkey",
              description: "Signing public key; its Ethereum address is the seller the configuration commits.",
            },
          ],
        },
        {
          title: "Committed configuration",
          description: "Opens the function's published configuration commitment to the exact reclaim terms.",
          items: [
            {
              abiParameter: "configuration",
              description: "Salt, offer, reclaim time and the signing domain separator; the seller comes from the signing key.",
            },
          ],
        },
        {
          title: "Authorized transaction",
          description: "Proves one exact escrow input becomes the payout after timeout; a native escrow also funds an optional private relay payment and open fee.",
          items: [
            {
              abiParameter: "private_value",
              description: "Padded input and output slots, fee, not-before time and validity window.",
            },
            {
              abiParameter: "output_data_hashes",
              description: "With the arena hash, opens the transaction's delivery commitment; the payout slot's hash is signed in the payout opening.",
            },
            {
              abiParameter: "arena_hash",
              description: "With the output-data hashes, opens the delivery commitment; signed in the payout opening.",
            },
            {
              abiParameter: "escrow_note",
              description: "Opens the escrow input note's secret, asset and amount; the escrow contract owns it, and the seller signs its asset.",
            },
            {
              abiParameter: "escrow_output_index",
              description: "Locates the escrow input within the output-commitment tree.",
            },
            {
              abiParameter: "fee_paid",
              description: "Selects the sponsored role, where the seller's own account pays a token reclaim's network fee.",
            },
            { abiParameter: "escrow_contract", description: "Names the authenticated escrow Contract Account." },
            { abiParameter: "recipient", description: "Names the signed payout recipient." },
            { abiParameter: "issuance_recipient", description: "Names the signed designated issuance recipient, or zero for the open route." },
            { abiParameter: "issuance_note_secret", description: "Opens the designated issuance commitment, or is zero for the open route." },
            { abiParameter: "payout_opening_blinder", description: "Blinds the signed payout-opening commitment to the payout owner and its encrypted recovery data." },
            {
              abiParameter: "payout_note_secret",
              description: "Opens the exact payout note selected before the seller signs.",
            },
            { abiParameter: "relay_fee_amount", description: "Exact private native-PCASH relay payment funded from the escrow's value, or zero; always zero for a token escrow." },
            { abiParameter: "relay_fee_owner_commitment", description: "Owner commitment for the escrow-funded relay payment, or zero." },
          ],
        },
      ],
    },
  ],
} as const satisfies ContractPresentationProfile;

export interface MarketplaceSourceDeployment {
  address: FieldNumberish;
  reclaimAuthority: FieldNumberish;
  claimConfigurationSalt: FieldNumberish;
  reclaimConfigurationSalt: FieldNumberish;
  terms: OfferTerms;
  network: NetworkConfigLike;
}

function opening(
  address: `0x${string}`,
  profile: ContractConfigurationProfile,
  applicationVkHash: bigint,
  input: Readonly<Record<string, FieldNumberish>>,
): ConfigurationOpening {
  return {
    address,
    selector: profile.selector,
    applicationVkHash: fieldToHex(applicationVkHash),
    configurationCommitment: fieldToHex(configurationProfileCommitment(profile, input)),
    domain: profile.domain,
    values: configurationProfileValues(profile, input).map(fieldToHex),
  };
}

/** Application-owned deployment metadata converted into generic registry openings. */
export function marketplaceSourceConfigurationOpenings(
  deployment: MarketplaceSourceDeployment,
): ConfigurationOpening[] {
  const address = toNonnegativeBigInt(deployment.address, "address");
  if (address >= 1n << 160n) throw new Error("address must fit uint160");
  const resolvedAddress = addressHex(address) as `0x${string}`;
  const claimInput = claimConfigurationInput(deployment.claimConfigurationSalt, deployment.terms);
  const reclaimInput = reclaimConfigurationInput(
    deployment.reclaimConfigurationSalt,
    deployment.network,
    deployment.reclaimAuthority,
    deployment.terms.id,
    deployment.terms.deadlineT,
  );
  return [
    opening(resolvedAddress, MARKETPLACE_CLAIM_SOURCE_PROFILE, CLAIM_APPLICATION_VK_HASH, claimInput),
    opening(resolvedAddress, MARKETPLACE_RECLAIM_SOURCE_PROFILE, RECLAIM_APPLICATION_VK_HASH, reclaimInput),
  ];
}

/** Rebuild the exact source-opening publication from one durable browser listing. */
export function marketplacePublicationSourceConfigurationOpenings(
  publication: OfferPublication,
  network: NetworkConfigLike,
): ConfigurationOpening[] {
  const material = deriveVerifiedL2ContractMaterial(publication);
  const terms = {
    router: BigInt(publication.terms.router),
    seller: BigInt(publication.terms.seller),
    id: BigInt(publication.terms.id),
    assetId: BigInt(publication.terms.assetId),
    amount: BigInt(publication.terms.amount),
    ethPriceWei: BigInt(publication.terms.ethPriceWei),
    deadlineT: BigInt(publication.terms.deadlineT),
  };
  const openings = marketplaceSourceConfigurationOpenings({
    address: material.address,
    reclaimAuthority: BigInt(publication.reclaimAuthority),
    claimConfigurationSalt: BigInt(publication.l2Contract.claimConfigurationSalt),
    reclaimConfigurationSalt: BigInt(publication.l2Contract.reclaimConfigurationSalt),
    terms,
    network,
  });
  if (material.body.functions.length !== 2) {
    throw new Error("marketplace L2 smart contract must expose exactly claim() and reclaim()");
  }
  for (const opening of openings) {
    const deployed = material.function(opening.selector);
    if (
      deployed.applicationVkHash !== BigInt(opening.applicationVkHash)
      || deployed.configurationCommitment !== BigInt(opening.configurationCommitment)
    ) {
      throw new Error(`marketplace source opening for selector ${opening.selector} does not match the published contract body`);
    }
  }
  return openings;
}
