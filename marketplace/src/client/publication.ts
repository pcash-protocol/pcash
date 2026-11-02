// Portable marketplace publication encoding and local reconstruction.
//
// A marketplace offer has no on-chain registry: the catalog and opaque listing
// links carry a portable publication. Verification recomputes the contract
// address from its body, checks the pinned claim and reclaim functions and
// terms, and confirms escrow-note membership.

import type { NetworkConfigLike } from "@pcash/sdk/browser";
import type { PcashProfile } from "@pcash/sdk/wallet";
import { bytesToHex, hexToBytes, keccak256, stringToHex, type Hex } from "viem";
import {
  assertPaymentDeadlineT,
  type OfferTerms
} from "../commitments.mts";
import {
  createOffer,
  type Offer,
} from "../offer.mts";
import { addressHex, fieldToHex } from "@pcash/sdk/browser";
import { assetDefinitionAssetId, decodeAssetDefinition, type AssetDefinition } from "@pcash/sdk/protocol";
import { deriveVerifiedL2ContractMaterial, type VerifiedL2ContractMaterial } from "./verifiedContractMaterial.ts";

export const PUBLICATION_VERSION = 1 as const;

/** A funded escrow note's opening — the seller must publish it so the buyer can spend. */
export interface EscrowOpening {
  leafIndex: number;
  noteSecret: string; // 0x field
  amount: string; // 0x field (== advertised amount of terms.assetId)
}

/** The full, self-describing artifact carried by the catalog and listing links. */
export interface OfferPublication {
  version: typeof PUBLICATION_VERSION;
  chainId: string;
  terms: {
    router: string;
    seller: string;
    id: string;
    /** 0 is native PCASH. */
    assetId: string;
    amount: string;
    ethPriceWei: string;
    deadlineT: string;
  };
  /** Byte-aligned hex definition of a token listing's asset; absent for native PCASH. */
  assetDefinition?: string;
  l2Contract: {
    bodyHex: string;
    claimConfigurationSalt: string;
    reclaimConfigurationSalt: string;
  };
  /** Seller PCASH address authorized to call reclaim(). */
  reclaimAuthority: string;
  escrow?: EscrowOpening;
}

/** Whether a publication targets the same PCASH chain as some reference. */
export function sameChainId(
  pub: { chainId: string },
  reference: { chainId: bigint | string | number },
): boolean {
  try {
    return BigInt(pub.chainId) === BigInt(reference.chainId);
  } catch {
    // A malformed or absent chain id on either side is not a match.
    return false;
  }
}

/**
 * Reject a saved publication that does not belong to the node's chain.
 *
 * Every path that acts on a restored publication — claim and reclaim — runs this
 * against a freshly read status before it submits anything, so saved bytes cannot
 * cross the transaction replay domain identified by the public chain ID.
 */
export function assertPublicationChainId(
  status: { pcashChainId: number | bigint },
  // Structural, so the narrower claim/reclaim publication shapes work too.
  pub: { chainId: string },
): void {
  if (!sameChainId(pub, { chainId: status.pcashChainId })) {
    throw new Error(
      `saved offer belongs to pcash chain ${String(pub.chainId)} `
      + `but this node is chain ${String(status.pcashChainId)}`,
    );
  }
}

/** Decode a publication's terms back into the SDK's OfferTerms shape. */
export function publicationTerms(pub: OfferPublication): OfferTerms {
  const t = pub.terms;
  const terms = {
    router: BigInt(t.router),
    seller: BigInt(t.seller),
    id: BigInt(t.id),
    assetId: BigInt(t.assetId),
    amount: BigInt(t.amount),
    ethPriceWei: BigInt(t.ethPriceWei),
    deadlineT: BigInt(t.deadlineT),
  };
  assertPaymentDeadlineT(terms.deadlineT);
  return terms;
}

/** The contract-owned note a funded publication opens, in the listed asset. */
export function publicationEscrowNote(pub: {
  terms: { assetId: string };
  l2Contract: { bodyHex: string };
  escrow?: EscrowOpening;
}, material: VerifiedL2ContractMaterial): { owner: bigint; noteSecret: bigint; assetId: bigint; amount: bigint; leafIndex: number } {
  if (pub.escrow === undefined) throw new Error("offer has no funded escrow opening");
  return {
    owner: material.address,
    noteSecret: BigInt(pub.escrow.noteSecret),
    assetId: BigInt(pub.terms.assetId),
    amount: BigInt(pub.escrow.amount),
    leafIndex: pub.escrow.leafIndex,
  };
}

/**
 * The verified definition of a token listing's asset, or null for native PCASH.
 * The bytes come from the seller and are untrusted until they derive the
 * listing's committed assetId.
 */
export function publicationAssetDefinition(
  pub: { terms: { assetId: string }; assetDefinition?: string },
): AssetDefinition | null {
  const assetId = BigInt(pub.terms.assetId);
  if (assetId === 0n) {
    if (pub.assetDefinition !== undefined) throw new Error("native PCASH listings carry no asset definition");
    return null;
  }
  if (pub.assetDefinition === undefined) throw new Error("token listing is missing its asset definition");
  const definition = decodeAssetDefinition(hexToBytes(pub.assetDefinition as Hex));
  if (assetDefinitionAssetId(definition) !== assetId) throw new Error("asset definition does not derive the listed assetId");
  return definition;
}

/**
 * Build a publication from a freshly created offer (before the escrow is funded).
 * A token offer carries its asset definition bytes.
 */
export function publicationFromOffer(
  offer: Offer,
  assetDefinition?: Uint8Array,
): OfferPublication {
  const t = offer.terms;
  const publication: OfferPublication = {
    version: PUBLICATION_VERSION,
    chainId: fieldToHex(offer.chainId),
    terms: {
      router: fieldToHex(t.router),
      seller: fieldToHex(t.seller),
      id: fieldToHex(t.id),
      assetId: fieldToHex(t.assetId),
      amount: fieldToHex(t.amount),
      ethPriceWei: fieldToHex(t.ethPriceWei),
      deadlineT: fieldToHex(t.deadlineT),
    },
    ...(assetDefinition === undefined ? {} : { assetDefinition: bytesToHex(assetDefinition) }),
    l2Contract: {
      bodyHex: bytesToHex(offer.l2ContractBody),
      claimConfigurationSalt: fieldToHex(offer.claimConfigurationSalt),
      reclaimConfigurationSalt: fieldToHex(offer.reclaimConfigurationSalt),
    },
    reclaimAuthority: addressHex(offer.reclaimAuthority),
  };
  publicationAssetDefinition(publication);
  return publication;
}

/** Rebuild a locally created offer after refresh so browser publication can resume safely. */
export function reconstructOfferFromPublication(
  pub: OfferPublication,
  sellerWallet: PcashProfile,
  network: NetworkConfigLike,
): Offer {
  const material = deriveVerifiedL2ContractMaterial(pub);
  const offer = createOffer({
    network,
    terms: publicationTerms(pub),
    sellerWallet,
    l2ContractNkRoot: material.nkRoot,
    claimApplicationVkHash: material.function(0).applicationVkHash,
    reclaimApplicationVkHash: material.function(1).applicationVkHash,
  });
  if (offer.l2ContractAddress !== material.address) {
    throw new Error("active seller wallet reconstructs a different L2 smart contract address");
  }
  if (bytesToHex(offer.l2ContractBody).toLowerCase() !== pub.l2Contract.bodyHex.toLowerCase()) {
    throw new Error("active seller wallet reconstructs different L2 smart contract bytes");
  }
  return offer;
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalJson(child)]),
    );
  }
  return value;
}

/** Canonical semantic encoding; catalog content IDs remain hashes of received bytes. */
export function serializePublication(pub: OfferPublication): string {
  return JSON.stringify(canonicalJson(pub), null, 2);
}

/** Canonical full-publication identity, including the uncommitted escrow opening. */
export function publicationIdentity(pub: OfferPublication): Hex {
  return keccak256(stringToHex(serializePublication(pub)));
}

function exactPublicationObject(
  value: unknown,
  label: string,
  allowedKeys: readonly string[],
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const object = value as Record<string, unknown>;
  const unexpected = Object.keys(object).filter((key) => !allowedKeys.includes(key));
  if (unexpected.length > 0) throw new Error(`${label} contains unknown field "${unexpected[0]}"`);
  return object;
}

/** Parse and shape-check a catalog or shared-link publication. */
export function parsePublication(text: string): OfferPublication {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("not valid JSON");
  }
  const publication = exactPublicationObject(raw, "publication", [
    "version",
    "chainId",
    "terms",
    "assetDefinition",
    "l2Contract",
    "reclaimAuthority",
    "escrow",
  ]);
  const version = publication.version;
  if (version !== PUBLICATION_VERSION) throw new Error(`unsupported publication version (expected ${PUBLICATION_VERSION})`);
  exactPublicationObject(publication.terms, "publication terms", [
    "router",
    "seller",
    "id",
    "assetId",
    "amount",
    "ethPriceWei",
    "deadlineT",
  ]);
  exactPublicationObject(publication.l2Contract, "publication l2Contract", [
    "bodyHex", "claimConfigurationSalt", "reclaimConfigurationSalt",
  ]);
  if (publication.escrow !== undefined) {
    exactPublicationObject(publication.escrow, "publication escrow", ["leafIndex", "noteSecret", "amount"]);
  }

  const p = raw as OfferPublication;
  for (const path of [
    "chainId",
    "terms.router",
    "terms.seller",
    "terms.id",
    "terms.assetId",
    "terms.amount",
    "terms.ethPriceWei",
    "terms.deadlineT",
    "l2Contract.claimConfigurationSalt",
    "l2Contract.reclaimConfigurationSalt",
  ]) {
    const value = path.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], p);
    if (typeof value !== "string") throw new Error(`publication is missing "${path}"`);
    try {
      if (fieldToHex(BigInt(value)) !== value) throw new Error();
    } catch {
      throw new Error(`publication field "${path}" must be one canonical 32-byte field`);
    }
  }
  if (typeof p.reclaimAuthority !== "string") throw new Error('publication is missing "reclaimAuthority"');
  try {
    if (addressHex(BigInt(p.reclaimAuthority)) !== p.reclaimAuthority) throw new Error();
  } catch {
    throw new Error('publication field "reclaimAuthority" must be one canonical 20-byte address');
  }
  if (typeof p.l2Contract.bodyHex !== "string") throw new Error('publication is missing "l2Contract.bodyHex"');
  if (!/^0x(?:[0-9a-f]{2})*$/.test(p.l2Contract.bodyHex)) {
    throw new Error('publication field "l2Contract.bodyHex" must be canonical byte-aligned hex');
  }
  const maxAddress = (1n << 160n) - 1n;
  for (const path of ["terms.router", "terms.seller"]) {
    const value = path.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], p);
    if (BigInt(value as string) > maxAddress) throw new Error(`publication field "${path}" must fit an address`);
  }
  if (p.escrow !== undefined) {
    if (!p.escrow || typeof p.escrow !== "object" || !Number.isSafeInteger(p.escrow.leafIndex) || p.escrow.leafIndex < 0) {
      throw new Error("publication escrow leafIndex must be a safe nonnegative integer");
    }
    for (const field of ["noteSecret", "amount"] as const) {
      try {
        if (typeof p.escrow[field] !== "string" || fieldToHex(BigInt(p.escrow[field])) !== p.escrow[field]) {
          throw new Error();
        }
      } catch {
        throw new Error(`publication escrow ${field} must be one canonical 32-byte field`);
      }
    }
  }
  try {
    publicationTerms(p);
  } catch (error) {
    throw new Error(`publication terms are invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (p.assetDefinition !== undefined && (typeof p.assetDefinition !== "string" || !/^0x(?:[0-9a-f]{2})+$/.test(p.assetDefinition))) {
    throw new Error("publication assetDefinition must be canonical byte-aligned hex");
  }
  try {
    publicationAssetDefinition(p);
  } catch (error) {
    throw new Error(`publication asset is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  return p;
}

/** A stable per-offer key for the local registry: chain-scoped offerId + L2 smart contract. */
export function offerKey(pub: OfferPublication): string {
  return `${BigInt(pub.chainId)}:${BigInt(pub.terms.id)}:${BigInt(publicationContractAddress(pub))}`;
}

/** Address derived from the one published contract body. */
export function publicationContractAddress(pub: Pick<OfferPublication, "chainId" | "l2Contract">): string {
  return addressHex(deriveVerifiedL2ContractMaterial(pub).address);
}
