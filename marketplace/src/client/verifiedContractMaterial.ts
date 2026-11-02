import { hexToBytes, type Hex } from "viem";
import {
  decodeContractBody,
  functionSelector,
  verifyContract,
  type ContractBody,
  type FunctionSelector,
  type ContractVerification,
} from "@pcash/sdk/protocol";
import {
  CLAIM_FUNCTION_SELECTOR,
  CLAIM_APPLICATION_VK_HASH,
  assertPaymentDeadlineT,
  claimConfigurationCommitment,
  type OfferTerms,
} from "../commitments.mts";

export interface L2ContractPublicationSource {
  chainId: string;
  l2Contract: {
    bodyHex: string;
  };
}

export interface OfferClaimPublicationSource extends L2ContractPublicationSource {
  terms: {
    router: string;
    seller: string;
    id: string;
    assetId: string;
    amount: string;
    ethPriceWei: string;
    deadlineT: string;
  };
  l2Contract: L2ContractPublicationSource["l2Contract"] & {
    claimConfigurationSalt: string;
  };
}

export interface VerifiedFunctionMaterial {
  selector: FunctionSelector;
  applicationVkHash: bigint;
  configurationCommitment: bigint;
  functionSiblings: bigint[];
}

export interface VerifiedL2ContractMaterial {
  chainId: bigint;
  body: ContractBody;
  verification: ContractVerification;
  address: bigint;
  functionSetCommitment: bigint;
  nkRoot: bigint;
  mlKemPublicKey: Uint8Array;
  function(selector: number): VerifiedFunctionMaterial;
}

export interface VerifiedOfferClaimMaterial {
  l2Contract: VerifiedL2ContractMaterial;
  terms: OfferTerms;
  claim: VerifiedFunctionMaterial;
  claimConfigurationSalt: bigint;
}

function publicationTerms(publication: OfferClaimPublicationSource): OfferTerms {
  const terms = {
    router: BigInt(publication.terms.router),
    seller: BigInt(publication.terms.seller),
    id: BigInt(publication.terms.id),
    assetId: BigInt(publication.terms.assetId),
    amount: BigInt(publication.terms.amount),
    ethPriceWei: BigInt(publication.terms.ethPriceWei),
    deadlineT: BigInt(publication.terms.deadlineT),
  };
  assertPaymentDeadlineT(terms.deadlineT);
  return terms;
}

/** Bodies already decoded and verified, by lowercase hex, least recently used first. */
const verifiedBodies = new Map<string, { body: ContractBody; verification: ContractVerification }>();
/** Listings, catalogs and render paths re-derive the same few bodies; each verification hashes a receive key. */
const VERIFIED_BODY_LIMIT = 256;

function verifiedBody(bodyHex: string): { body: ContractBody; verification: ContractVerification } {
  const key = bodyHex.toLowerCase();
  const cached = verifiedBodies.get(key);
  if (cached !== undefined) {
    verifiedBodies.delete(key);
    verifiedBodies.set(key, cached);
    return cached;
  }
  const body = decodeContractBody(hexToBytes(bodyHex as Hex));
  const verified = { body, verification: verifyContract(body) };
  if (verifiedBodies.size >= VERIFIED_BODY_LIMIT) verifiedBodies.delete(verifiedBodies.keys().next().value!);
  verifiedBodies.set(key, verified);
  return verified;
}

/** Derive every spend input from the verified L2 contract body. */
export function deriveVerifiedL2ContractMaterial(publication: L2ContractPublicationSource): VerifiedL2ContractMaterial {
  const chainId = BigInt(publication.chainId);
  const { body, verification } = verifiedBody(publication.l2Contract.bodyHex);
  if (!body.nullifierKey.publishesNkRoot) throw new Error("marketplace L2 smart contract body does not publish nkRoot");
  if (body.mlKemPublicKey === undefined) throw new Error("marketplace L2 smart contract body does not publish a receive key");

  return {
    chainId,
    body,
    verification,
    address: verification.address,
    functionSetCommitment: verification.functionSetCommitment,
    nkRoot: BigInt(body.nullifierKey.nkRoot),
    mlKemPublicKey: body.mlKemPublicKey,
    function(selector: number): VerifiedFunctionMaterial {
      const resolvedSelector = functionSelector(selector);
      const entry = body.functions.find((candidate) => candidate.selector === resolvedSelector);
      if (entry === undefined) throw new Error(`marketplace L2 smart contract has no function with selector ${selector}`);
      const membership = verification.functionSet.membership(resolvedSelector);
      return {
        selector: resolvedSelector,
        applicationVkHash: BigInt(entry.applicationVkHash),
        configurationCommitment: BigInt(entry.configurationCommitment),
        functionSiblings: membership.siblings,
      };
    },
  };
}

/** Derive the buyer claim witness from the L2 smart contract body and verify its claim function binds the advertised terms. */
export function deriveVerifiedOfferClaimMaterial(publication: OfferClaimPublicationSource): VerifiedOfferClaimMaterial {
  const l2Contract = deriveVerifiedL2ContractMaterial(publication);
  const terms = publicationTerms(publication);
  const claim = l2Contract.function(CLAIM_FUNCTION_SELECTOR);
  const claimConfigurationSalt = BigInt(publication.l2Contract.claimConfigurationSalt);
  if (claim.applicationVkHash !== CLAIM_APPLICATION_VK_HASH) {
    throw new Error("marketplace L2 smart contract claim function does not use the approved application");
  }
  if (claim.configurationCommitment !== claimConfigurationCommitment(claimConfigurationSalt, terms)) {
    throw new Error("marketplace L2 smart contract claim function does not bind the advertised offer terms");
  }
  return { l2Contract, terms, claim, claimConfigurationSalt };
}
