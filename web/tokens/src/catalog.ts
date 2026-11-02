// Eligibility-drop publications in the node catalog.
//
// A publication carries the drop's public terms, the asset's definition, and
// the transactions that funded the inventory. It carries no contract body and no asset
// ID: the client derives the asset from the definition and the body from the
// terms and the pinned implementations, so a record cannot name another asset,
// contract, or implementation. Catalog records are untrusted discovery data; an
// inventory note that does not open under the derived secret is simply unusable.

import {
  assetDefinitionAssetId,
  buildCatalogArtifact,
  decodeAssetDefinition,
  encodeAssetDefinition,
  type AssetDefinition,
  type CatalogInfo,
  type CatalogRecord,
} from "@pcash/sdk/protocol";
import type { PcashNodeClient } from "@pcash/sdk/clients";
import { PRIVATE_VALUE_MAX_OUTPUTS } from "@pcash/sdk/constants";
import { BN254_SCALAR_MODULUS, fieldToHex } from "@pcash/sdk/crypto";
import { fromHex, toHex, utf8 } from "@pcash/sdk/utils";
import { eligibilityDrop, type EligibilityDrop } from "./drop.ts";
import type { FundingChunk } from "./witness.ts";

/** The one namespace drop publications use. */
export const DROP_CATALOG_NAMESPACE = "pcash.tokens.drop.v1";
export const DROP_PUBLICATION_VERSION = 1;

/** Hard client-side bounds so a hostile node cannot make a page loop or grow without limit. */
const MAX_CATALOG_PAGES = 64;
const MAX_CATALOG_TOTAL_BYTES = 16 * 1024 * 1024;

export interface DropPublication {
  chainId: number;
  dropSeed: bigint;
  claimAmount: bigint;
  cutoffBlockNumber: bigint;
  claimEndTimestamp: bigint;
  creator: bigint;
  creatorNullifierKeyCommitment: bigint;
  /** The asset, by its definition. */
  definition: AssetDefinition;
  /** The inventory's funding transactions, in note order. */
  funding: FundingChunk[];
}

/** `definition` is the definition of the drop's asset. */
export function dropPublication(drop: EligibilityDrop, params: {
  chainId: number;
  definition: AssetDefinition;
  funding: readonly FundingChunk[];
}): DropPublication {
  const c = drop.configuration;
  return {
    chainId: params.chainId,
    dropSeed: drop.dropSeed,
    claimAmount: c.claimAmount,
    cutoffBlockNumber: c.cutoffBlockNumber,
    claimEndTimestamp: c.claimEndTimestamp,
    creator: c.creator,
    creatorNullifierKeyCommitment: c.creatorNullifierKeyCommitment,
    definition: params.definition,
    funding: params.funding.map((chunk) => ({ contentHash: chunk.contentHash.toLowerCase(), firstIndex: chunk.firstIndex, count: chunk.count })),
  };
}

const FIELD_KEYS = [
  "dropSeed",
  "claimAmount",
  "cutoffBlockNumber",
  "claimEndTimestamp",
  "creator",
  "creatorNullifierKeyCommitment",
] as const;
const KEYS = ["version", "chainId", ...FIELD_KEYS, "definition", "funding"].sort();

/** Canonical JSON: sorted keys, fixed-width field hex, lowercase byte hex. */
export function serializeDropPublication(publication: DropPublication): string {
  const wire: Record<string, unknown> = {
    version: DROP_PUBLICATION_VERSION,
    chainId: publication.chainId,
    definition: toHex(encodeAssetDefinition(publication.definition)),
    funding: publication.funding.map((chunk) => ({ count: chunk.count, contentHash: chunk.contentHash, firstIndex: chunk.firstIndex })),
  };
  for (const key of FIELD_KEYS) wire[key] = fieldToHex(publication[key]);
  return JSON.stringify(Object.fromEntries(KEYS.map((key) => [key, wire[key]])));
}

/** Strict parse of an untrusted publication. */
export function parseDropPublication(text: string): DropPublication {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("drop publication is not JSON");
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("drop publication must be an object");
  const record = raw as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== KEYS.length || keys.some((key, i) => key !== KEYS[i])) {
    throw new Error("drop publication has the wrong field set");
  }
  if (record.version !== DROP_PUBLICATION_VERSION) throw new Error("unsupported drop publication version");
  const chainId = record.chainId;
  if (typeof chainId !== "number" || !Number.isInteger(chainId) || chainId <= 0 || chainId >= 2 ** 32) {
    throw new Error("drop publication chainId must be a PCASH chain id");
  }
  const fields = Object.fromEntries(FIELD_KEYS.map((key) => {
    const value = record[key];
    if (typeof value !== "string" || !/^0x[0-9a-f]{64}$/.test(value)) {
      throw new Error(`drop publication ${key} must be one canonical 32-byte field`);
    }
    const parsed = BigInt(value);
    if (parsed >= BN254_SCALAR_MODULUS) throw new Error(`drop publication ${key} is not a field element`);
    return [key, parsed];
  })) as Record<(typeof FIELD_KEYS)[number], bigint>;
  const definitionHex = record.definition;
  if (typeof definitionHex !== "string" || !/^0x(?:[0-9a-f]{2})+$/.test(definitionHex)) {
    throw new Error("drop publication definition must be nonempty lowercase hex bytes");
  }
  const definition = decodeAssetDefinition(fromHex(definitionHex, "definition"));
  const funding = record.funding;
  if (!Array.isArray(funding) || funding.length === 0) throw new Error("drop publication funding must be nonempty");
  const seen = new Set<string>();
  let nextMinimumIndex = 0;
  const chunks = funding.map((chunk: unknown): FundingChunk => {
    if (chunk === null || typeof chunk !== "object" || Array.isArray(chunk)
      || Object.keys(chunk).sort().join() !== "contentHash,count,firstIndex") throw new Error("drop publication funding entries hold contentHash, count and firstIndex");
    const { count, contentHash, firstIndex } = chunk as Record<string, unknown>;
    if (typeof contentHash !== "string" || !/^0x[0-9a-f]{64}$/.test(contentHash)) throw new Error("drop publication funding contentHash must be 32 lowercase hex bytes");
    if (typeof count !== "number" || !Number.isInteger(count) || count < 1 || count > PRIVATE_VALUE_MAX_OUTPUTS) {
      throw new Error("drop publication funding count must fit one transaction's outputs");
    }
    if (typeof firstIndex !== "number" || !Number.isSafeInteger(firstIndex) || firstIndex < nextMinimumIndex
      || firstIndex + count > 2 ** 16) throw new Error("drop publication funding indexes must be ordered, disjoint uint16 values");
    if (seen.has(contentHash)) throw new Error("drop publication funding repeats a transaction");
    seen.add(contentHash);
    nextMinimumIndex = firstIndex + count;
    return { contentHash, firstIndex, count };
  });
  return {
    chainId,
    ...fields,
    definition,
    funding: chunks,
  };
}

export interface VerifiedDropPublication {
  drop: EligibilityDrop;
  /** Resolve to inventory notes with `dropInventory`. */
  funding: FundingChunk[];
  /** Inventory notes the publication lists. */
  count: number;
  /** The definition `drop.configuration.assetId` derives from. */
  definition: AssetDefinition;
}

/**
 * Rebuild the drop a publication describes. The asset comes only from the
 * definition and the contract material only from the terms and the pinned
 * claim and reclaim implementations, so the derived address is the only
 * contract a claim can call.
 */
export function verifyDropPublication(publication: DropPublication, network: { chainId: number | bigint }): VerifiedDropPublication {
  if (BigInt(publication.chainId) !== BigInt(network.chainId)) {
    throw new Error(`drop publication belongs to PCASH chain ${publication.chainId}`);
  }
  const drop = eligibilityDrop({ ...publication, assetId: assetDefinitionAssetId(publication.definition) });
  return {
    drop,
    funding: publication.funding,
    count: publication.funding.reduce((sum, chunk) => sum + chunk.count, 0),
    definition: publication.definition,
  };
}

async function requireDropCatalog(node: Pick<PcashNodeClient, "catalogInfo">): Promise<CatalogInfo> {
  const info = await node.catalogInfo();
  if (info.status !== "available") throw new Error(`this node's publication catalog is ${info.status}`);
  if (!info.namespaces.includes(DROP_CATALOG_NAMESPACE)) {
    throw new Error(`this node's catalog does not accept ${DROP_CATALOG_NAMESPACE}`);
  }
  return info;
}

/**
 * Every well-formed drop publication for this node's chain, newest first.
 * Malformed and wrong-chain records are skipped one by one.
 */
export async function fetchDropPublications(
  node: Pick<PcashNodeClient, "catalogInfo" | "catalogList">,
): Promise<DropPublication[]> {
  const info = await requireDropCatalog(node);
  const pageItems = Number(info.limits.defaultPageItems > 0n ? info.limits.defaultPageItems : info.limits.maxPageItems);
  const seenContent = new Set<string>();
  const seenCursors = new Set<string>();
  const found: { publication: DropPublication; createdAt: bigint }[] = [];
  let cursor: string | undefined;
  let totalBytes = 0;
  pages: for (let page = 0; page < MAX_CATALOG_PAGES; page += 1) {
    const result = await node.catalogList({
      namespace: DROP_CATALOG_NAMESPACE,
      ...(cursor === undefined ? {} : { cursor }),
      ...(pageItems > 0 ? { limit: pageItems } : {}),
    });
    for (const record of result.items) {
      if (seenContent.has(record.artifact.contentId)) continue;
      seenContent.add(record.artifact.contentId);
      totalBytes += record.artifact.payload.length;
      if (totalBytes > MAX_CATALOG_TOTAL_BYTES) break pages;
      const publication = tryParse(record, info);
      if (publication !== null) found.push({ publication, createdAt: record.createdAt });
    }
    if (result.nextCursor === null || seenCursors.has(result.nextCursor)) break;
    seenCursors.add(result.nextCursor);
    cursor = result.nextCursor;
  }
  return found
    .sort((left, right) => (right.createdAt > left.createdAt ? 1 : right.createdAt < left.createdAt ? -1 : 0))
    .map((entry) => entry.publication);
}

function tryParse(record: CatalogRecord, info: CatalogInfo): DropPublication | null {
  try {
    if (record.artifact.namespace !== DROP_CATALOG_NAMESPACE) return null;
    const publication = parseDropPublication(new TextDecoder("utf-8", { fatal: true }).decode(record.artifact.payload));
    return publication.chainId === info.pcashChainId ? publication : null;
  } catch {
    return null;
  }
}

/** Publish the exact canonical bytes; the content ID commits to them. */
export async function publishDropPublication(
  node: Pick<PcashNodeClient, "catalogInfo" | "catalogPublish">,
  publication: DropPublication,
): Promise<CatalogRecord> {
  const info = await requireDropCatalog(node);
  if (publication.chainId !== info.pcashChainId) {
    throw new Error(`drop belongs to PCASH chain ${publication.chainId} but this node's catalog is chain ${info.pcashChainId}`);
  }
  return node.catalogPublish(buildCatalogArtifact({
    namespace: DROP_CATALOG_NAMESPACE,
    pcashChainId: info.pcashChainId,
    payload: utf8(serializeDropPublication(publication)),
  }));
}
