// Generic, node-local publication catalog. Payload semantics belong to callers.
// Catalog data is not consensus state, and record presence does not establish
// that the referenced application object is still live.

import { keccak256 } from "../utils/keccak.ts";
import { numberToHex } from "viem";
import { fixedHex, fromHex, parseHexQuantity, toHex } from "../utils/hex.ts";
import { concatBytes, utf8 } from "../utils/bytes.ts";

/** Domain separator for the content-ID preimage. */
const CATALOG_ARTIFACT_DOMAIN = "PCASH_CATALOG_ARTIFACT";

/** Longest legal namespace, in UTF-8 bytes. */
export const MAX_NAMESPACE_BYTES = 64;

const NAMESPACE_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export interface CatalogArtifact {
  namespace: string;
  pcashChainId: number;
  contentId: string;
  /** Exact opaque bytes. Never parsed or canonicalized by the node. */
  payload: Uint8Array;
}

export interface CatalogRecord {
  artifact: CatalogArtifact;
  /** First stored time in Unix seconds; excluded from the content ID and unchanged by republication. */
  createdAt: bigint;
}

export interface CatalogLimits {
  maxPayloadBytes: bigint;
  maxRecords: bigint;
  maxAggregatePayloadBytes: bigint;
  defaultPageItems: bigint;
  maxPageItems: bigint;
  maxPagePayloadBytes: bigint;
}

export type CatalogStatus = "disabled" | "available" | "unavailable";

export interface CatalogInfo {
  status: CatalogStatus;
  writable: boolean;
  /**
   * The PCASH chain id. Full chain identity lives on `pcash_status`; the catalog
   * does not duplicate it.
   */
  pcashChainId: number;
  /** When disabled, the policy that would apply once enabled. */
  namespaces: string[];
  limits: CatalogLimits;
}

/** Flat publish request; the node assigns `createdAt`. */
export interface CatalogArtifactRequest {
  namespace: string;
  pcashChainId: string;
  contentId: string;
  payload: string;
}

export interface CatalogGetRequest {
  namespace: string;
  contentId: string;
}

export interface CatalogListQuery {
  namespace: string;
  /** Exclusive lower bound; it need not exist. */
  cursor?: string;
  limit?: number;
}

export interface CatalogPage {
  items: CatalogRecord[];
  /** The last returned content ID when another record remains. */
  nextCursor: string | null;
}

export function isValidCatalogNamespace(namespace: string): boolean {
  return NAMESPACE_RE.test(namespace) && utf8(namespace).length <= MAX_NAMESPACE_BYTES;
}

export function assertCatalogNamespace(namespace: string): void {
  if (!isValidCatalogNamespace(namespace)) {
    throw new Error(
      `catalog namespace must be 1..=${MAX_NAMESPACE_BYTES} bytes matching [a-z0-9][a-z0-9._-]{0,63}: ${namespace}`,
    );
  }
}

function assertUint32(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new Error(`${label} must be a uint32: ${value}`);
  }
}

function hexToBytes(value: string, label: string): Uint8Array {
  if (typeof value !== "string" || !value.startsWith("0x")) {
    throw new Error(`${label} must be a 0x-prefixed hex string`);
  }
  return fromHex(value, label);
}

const u16be = (value: number): Uint8Array => Uint8Array.of((value >>> 8) & 0xff, value & 0xff);
const u32be = (value: number): Uint8Array =>
  Uint8Array.of((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);

/**
 * The exact `CatalogArtifact` content-ID preimage:
 *
 *   ASCII(domain) || u32_be(pcashChainId)
 *   || u16_be(namespaceLen) || namespace || u32_be(payloadLen) || payload
 *
 * Every variable-length part carries its length first, so the concatenation
 * parses exactly one way. Server-assigned fields are excluded, so republishing
 * identical content is the same record rather than a duplicate. Cross-language
 * known answers live in `vectors/catalog_artifact.json`.
 */
export function catalogContentIdPreimage(input: {
  namespace: string;
  pcashChainId: number;
  payload: Uint8Array;
}): Uint8Array {
  assertCatalogNamespace(input.namespace);
  assertUint32(input.pcashChainId, "pcashChainId");
  const namespace = utf8(input.namespace);
  return concatBytes(
    utf8(CATALOG_ARTIFACT_DOMAIN),
    u32be(input.pcashChainId),
    u16be(namespace.length),
    namespace,
    u32be(input.payload.length),
    input.payload,
  );
}

/** Keccak-256 of {@link catalogContentIdPreimage}, as lowercase `0x` hex. */
export function catalogContentId(input: {
  namespace: string;
  pcashChainId: number;
  payload: Uint8Array;
}): string {
  return toHex(keccak256(catalogContentIdPreimage(input)));
}

export function buildCatalogArtifact(input: {
  namespace: string;
  pcashChainId: number;
  payload: Uint8Array;
}): CatalogArtifact {
  return {
    namespace: input.namespace,
    pcashChainId: input.pcashChainId,
    contentId: catalogContentId(input),
    payload: input.payload,
  };
}

function readString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  return value;
}

/**
 * Recompute the content ID before publishing so a mismatched artifact fails
 * locally. The node assigns `createdAt`.
 */
export function encodeCatalogArtifact(artifact: CatalogArtifact): CatalogArtifactRequest {
  assertCatalogNamespace(artifact.namespace);
  assertUint32(artifact.pcashChainId, "pcashChainId");
  const contentId = fixedHex(artifact.contentId, 32, "contentId");

  const expected = catalogContentId({
    namespace: artifact.namespace,
    pcashChainId: artifact.pcashChainId,
    payload: artifact.payload,
  });
  if (expected !== contentId) {
    throw new Error(`catalog record contentId does not match its artifact: ${contentId}`);
  }

  return {
    namespace: artifact.namespace,
    pcashChainId: numberToHex(BigInt(artifact.pcashChainId)),
    contentId,
    payload: toHex(artifact.payload),
  };
}

/**
 * Recompute the content ID of untrusted wire data before returning a record.
 */
export function decodeCatalogRecord(value: unknown): CatalogRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("catalog record must be an object");
  }
  const r = value as Record<string, unknown>;

  const namespace = readString(r.namespace, "namespace");
  assertCatalogNamespace(namespace);

  const chainQty = parseHexQuantity(r.pcashChainId, "pcashChainId");
  if (chainQty > 0xffff_ffffn) throw new Error("pcashChainId must fit uint32");
  const pcashChainId = Number(chainQty);

  const contentId = fixedHex(readString(r.contentId, "contentId"), 32, "contentId");
  const payload = hexToBytes(readString(r.payload, "payload"), "payload");
  const createdAt = parseHexQuantity(r.createdAt, "createdAt");

  const expected = catalogContentId({ namespace, pcashChainId, payload });
  if (expected !== contentId) {
    throw new Error(`catalog record contentId does not match its artifact: ${contentId}`);
  }

  return {
    artifact: { namespace, pcashChainId, contentId, payload },
    createdAt,
  };
}

/**
 * Decoding checks that a record is self-consistent; a point read must also
 * bind it to the requested ID. A different valid record is still a substitution.
 * The ID also commits to the namespace and chain ID.
 */
export function assertCatalogRecordIdentity(
  record: CatalogRecord,
  expectedContentId: string,
): void {
  const expected = fixedHex(expectedContentId, 32, "contentId");
  if (record.artifact.contentId !== expected) {
    throw new Error(
      `catalog returned record ${record.artifact.contentId}, which is not the requested ${expected}`,
    );
  }
}

function decodeLimits(value: unknown): CatalogLimits {
  if (typeof value !== "object" || value === null) throw new Error("limits must be an object");
  const l = value as Record<string, unknown>;
  return {
    maxPayloadBytes: parseHexQuantity(l.maxPayloadBytes, "limits.maxPayloadBytes"),
    maxRecords: parseHexQuantity(l.maxRecords, "limits.maxRecords"),
    maxAggregatePayloadBytes: parseHexQuantity(l.maxAggregatePayloadBytes, "limits.maxAggregatePayloadBytes"),
    defaultPageItems: parseHexQuantity(l.defaultPageItems, "limits.defaultPageItems"),
    maxPageItems: parseHexQuantity(l.maxPageItems, "limits.maxPageItems"),
    maxPagePayloadBytes: parseHexQuantity(l.maxPagePayloadBytes, "limits.maxPagePayloadBytes"),
  };
}

export function decodeCatalogInfo(value: unknown): CatalogInfo {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("pcash_catalogInfo returned a malformed result");
  }
  const r = value as Record<string, unknown>;

  const status = readString(r.status, "status");
  if (status !== "disabled" && status !== "available" && status !== "unavailable") {
    throw new Error(`unknown catalog status: ${status}`);
  }
  if (typeof r.writable !== "boolean") throw new Error("writable must be a boolean");
  if (!Array.isArray(r.namespaces) || r.namespaces.some((n) => typeof n !== "string")) {
    throw new Error("namespaces must be an array of strings");
  }

  const chainQty = parseHexQuantity(r.pcashChainId, "pcashChainId");
  if (chainQty > 0xffff_ffffn) throw new Error("pcashChainId must fit uint32");

  return {
    status,
    writable: r.writable,
    pcashChainId: Number(chainQty),
    namespaces: r.namespaces as string[],
    limits: decodeLimits(r.limits),
  };
}

export function decodeCatalogPage(value: unknown): CatalogPage {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("pcash_catalogList returned a malformed result");
  }
  const r = value as Record<string, unknown>;
  if (!Array.isArray(r.items)) throw new Error("pcash_catalogList items must be an array");
  if (!Object.prototype.hasOwnProperty.call(r, "nextCursor")) {
    throw new Error("pcash_catalogList nextCursor is required");
  }

  const nextCursor =
    r.nextCursor === null
      ? null
      : fixedHex(readString(r.nextCursor, "nextCursor"), 32, "nextCursor");

  return { items: r.items.map(decodeCatalogRecord), nextCursor };
}

/** Encode a point-read query into the single positional request object. */
export function encodeCatalogGetQuery(
  namespace: string,
  contentId: string,
): CatalogGetRequest {
  assertCatalogNamespace(namespace);
  return { namespace, contentId: fixedHex(contentId, 32, "contentId") };
}

/** Encode a list query into the single positional request object. */
export function encodeCatalogListQuery(query: CatalogListQuery): Record<string, string> {
  assertCatalogNamespace(query.namespace);
  const out: Record<string, string> = { namespace: query.namespace };
  if (query.cursor !== undefined) {
    out.cursor = fixedHex(query.cursor, 32, "cursor");
  }
  if (query.limit !== undefined) {
    if (!Number.isInteger(query.limit) || query.limit < 1) {
      throw new Error(`catalog limit must be a positive integer: ${query.limit}`);
    }
    out.limit = numberToHex(BigInt(query.limit));
  }
  return out;
}
