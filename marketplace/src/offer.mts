import { bytesToHex, encodeAbiParameters, keccak256, stringToHex } from "viem";
// Builds a marketplace offer backed by one smart contract. Its type-3 contract
// contract account creation carries a function set containing the
// claim function (selector 0, the buyer's claim path) and a seller-controlled
// reclaim function (selector 1) that can only authorize a reclaim transfer
// with notBeforeTimestamp > T. The escrow note is later funded to the
// smart contract's address; the buyer's claim is included by T, or the
// seller reclaims after T.

import {
  buildContractBody,
  type ContractFunction,
  type WalletProfileWithReceiveKeys,
} from "@pcash/sdk/protocol";
import {
  scalarFromBytes,
  resolveNetworkConfig,
  type NetworkConfig,
  type NetworkConfigLike,
} from "@pcash/sdk/browser";
import {
  deterministicMlKemKeysFromApplicationSeed,
  type PcashProfile,
} from "@pcash/sdk/wallet";
import {
  CLAIM_FUNCTION_SELECTOR,
  RECLAIM_FUNCTION_SELECTOR,
  assertPaymentDeadlineT,
  claimConfigurationCommitment,
  reclaimConfigurationCommitment,
  type OfferTerms,
} from "./commitments.mts";

export interface Offer {
  terms: OfferTerms;
  network: NetworkConfig;
  chainId: bigint;
  l2ContractNkRoot: bigint;
  l2ContractAddress: bigint;
  functionSetCommitment: bigint;
  l2ContractBody: Uint8Array; // type-3 contract body for submission
  claimConfigurationCommitment: bigint;
  claimConfigurationSalt: bigint;
  claimApplicationVkHash: bigint;
  reclaimConfigurationCommitment: bigint;
  reclaimConfigurationSalt: bigint;
  reclaimApplicationVkHash: bigint;
  /** The reclaim authority (seller's PCASH address) committed in the reclaim function. */
  reclaimAuthority: bigint;
  /** Synthetic wallet used to spend the escrow note (the smart contract is the note owner). */
  l2ContractWallet: WalletProfileWithReceiveKeys;
  /** Depth-8 membership witness for the claim function (selector 0). */
  claimFunctionSiblings: bigint[];
  /** Depth-8 membership witness for the reclaim function (selector 1). */
  reclaimFunctionSiblings: bigint[];
}

export interface CreateOfferParams {
  network: NetworkConfigLike;
  /** Offer terms including `seller` = the L1 address that receives the router payment. */
  terms: Omit<OfferTerms, "id">;
  /** Reclaim authority: its ECDSA key controls the reclaim function and the
   *  smart contract's receive key. May differ from the L1 payment recipient. */
  sellerWallet: PcashProfile;
  l2ContractNkRoot: bigint; // published so the escrow note can be nullified
  claimApplicationVkHash: bigint; // Poseidon hash of the claim function's application VK
  reclaimApplicationVkHash: bigint; // Poseidon hash of the reclaim function's application VK
}

/** Wallet-recoverable identity and independent configuration salts for one escrow. */
export function deriveOfferSecrets(seller: Pick<PcashProfile, "applicationSeed" | "nkRoot">, chainId: bigint, contractNkRoot: bigint) {
  const derive = (label: string) => scalarFromBytes(keccak256(encodeAbiParameters(
    [{ type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
    [keccak256(stringToHex(`pcash marketplace ${label}`)), bytesToHex(seller.applicationSeed), seller.nkRoot, chainId, contractNkRoot],
  ), "bytes"));
  return { id: derive("offer id"), claimConfigurationSalt: derive("claim configuration salt"), reclaimConfigurationSalt: derive("reclaim configuration salt") };
}

export function createOffer(params: CreateOfferParams): Offer {
  const network = resolveNetworkConfig(params.network);
  const { id, claimConfigurationSalt, reclaimConfigurationSalt } = deriveOfferSecrets(params.sellerWallet, network.pcashChainId, params.l2ContractNkRoot);
  const terms = { ...params.terms, id };
  assertPaymentDeadlineT(terms.deadlineT);
  const reclaimAuthority = params.sellerWallet.address;

  // The claim function's configuration commits all offer terms, while its
  // application VK pins the claim circuit.
  const claimConfiguration = claimConfigurationCommitment(claimConfigurationSalt, terms);
  // The reclaim function is controlled by the seller's key. Its configuration
  // binds the same T and the full network signature domain. The circuit asserts
  // the reclaim transfer's notBeforeTimestamp > T, so a reclaim cannot execute
  // while a timely claim still can.
  const reclaimConfiguration = reclaimConfigurationCommitment(
    reclaimConfigurationSalt,
    network,
    reclaimAuthority,
    terms.id,
    terms.deadlineT,
  );
  const functions: ContractFunction[] = [
    { selector: CLAIM_FUNCTION_SELECTOR, applicationVkHash: params.claimApplicationVkHash, configurationCommitment: claimConfiguration },
    { selector: RECLAIM_FUNCTION_SELECTOR, applicationVkHash: params.reclaimApplicationVkHash, configurationCommitment: reclaimConfiguration },
  ];

  // Smart-contract receive key: deterministic ML-KEM the seller controls (lets the fund
  // transfer encrypt the escrow note; the opening is also published out of band).
  const mlKem = deterministicMlKemKeysFromApplicationSeed(
    params.sellerWallet.applicationSeed,
    params.l2ContractNkRoot,
  );

  const l2Contract = buildContractBody({
    nullifierKey: { publishesNkRoot: true, nkRoot: params.l2ContractNkRoot },
    mlKemPublicKey: mlKem.publicKey,
    functions,
  });

  const l2ContractWallet: WalletProfileWithReceiveKeys = {
    pubX: new Uint8Array(32),
    pubY: new Uint8Array(32),
    address: l2Contract.address,
    nkRoot: params.l2ContractNkRoot,
    mlKemPublicKey: mlKem.publicKey,
    mlKemSecretKey: mlKem.secretKey,
  };

  return {
    terms,
    network,
    chainId: network.pcashChainId,
    l2ContractNkRoot: params.l2ContractNkRoot,
    l2ContractAddress: l2Contract.address,
    functionSetCommitment: l2Contract.functionSetCommitment,
    l2ContractBody: l2Contract.body,
    claimConfigurationCommitment: claimConfiguration,
    claimConfigurationSalt,
    claimApplicationVkHash: params.claimApplicationVkHash,
    reclaimConfigurationCommitment: reclaimConfiguration,
    reclaimConfigurationSalt,
    reclaimApplicationVkHash: params.reclaimApplicationVkHash,
    reclaimAuthority,
    l2ContractWallet,
    claimFunctionSiblings: l2Contract.functionSet.membership(CLAIM_FUNCTION_SELECTOR).siblings.map(BigInt),
    reclaimFunctionSiblings: l2Contract.functionSet.membership(RECLAIM_FUNCTION_SELECTOR).siblings.map(BigInt),
  };
}
