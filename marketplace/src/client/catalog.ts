// Marketplace view of the node's optional publication catalog.
//
// The generic transport lives in `@pcash/sdk` (namespaces, content IDs, cursors,
// opaque bytes). Everything marketplace-specific lives here: the namespace,
// stable serialization, lease selection, pagination, duplicate suppression, and
// full PCASH network matching. Application code passes a node and a publication
// and gets offers back; it never sees a namespace, content ID, or cursor.
//
// Catalog records are untrusted discovery data. Nothing returned by
// `fetchCatalogOffers` is safe to pay: the buyer still runs the complete
// `verifyOfferForPayment` path immediately before broadcasting payment bytes.

import {
  buildCatalogArtifact,
  fromBase64Url,
  toBase64Url,
  type CatalogInfo,
  type CatalogRecord,
  type PcashNodeClient,
} from "@pcash/sdk/browser";
import {
  offerKey,
  parsePublication,
  publicationIdentity,
  sameChainId,
  serializePublication,
  type OfferPublication,
} from "./publication.ts";

/** The one namespace this application publishes and reads. */
export const MARKETPLACE_CATALOG_NAMESPACE = "pcash.marketplace.offer.v1";

/**
 * Hard client-side ceilings. The node has its own bounds, but a broken or
 * hostile node must not be able to make a browser page forever, so the client
 * bounds its own work independently. Both sit above a completely full store so
 * an honest node is never truncated.
 */
const MAX_CATALOG_PAGES = 64;
const MAX_CATALOG_TOTAL_BYTES = 16 * 1024 * 1024;

/** Fragment key used by shared listing links. */
const SHARE_FRAGMENT_KEY = "offer";

export class CatalogUnavailableError extends Error {
  readonly status: CatalogInfo["status"] | "namespace-missing";

  constructor(status: CatalogInfo["status"] | "namespace-missing", message: string) {
    super(message);
    this.name = "CatalogUnavailableError";
    this.status = status;
  }
}

/** `catalogInfo` names the chain id field differently from `status`. */
const catalogChain = (info: CatalogInfo): { chainId: number } => ({ chainId: info.pcashChainId });

const utf8Encode = (value: string): Uint8Array => new TextEncoder().encode(value);
const utf8Decode = (value: Uint8Array): string => new TextDecoder("utf-8", { fatal: true }).decode(value);

/** Read catalog capability and require it to be usable for marketplace offers. */
async function requireMarketplaceCatalog(node: PcashNodeClient): Promise<CatalogInfo> {
  const info = await node.catalogInfo();
  if (info.status !== "available") {
    throw new CatalogUnavailableError(
      info.status,
      info.status === "disabled"
        ? "this node does not run a publication catalog"
        : "this node's publication catalog is unavailable",
    );
  }
  if (!info.namespaces.includes(MARKETPLACE_CATALOG_NAMESPACE)) {
    throw new CatalogUnavailableError(
      "namespace-missing",
      `this node's catalog does not accept ${MARKETPLACE_CATALOG_NAMESPACE}`,
    );
  }
  return info;
}

/**
 * Every marketplace offer this node currently lists, newest first.
 *
 * Results are untrusted candidates, and the catalog never expires anything, so
 * this includes offers whose payment deadline has long passed. Liveness comes
 * from an offer's own terms and on-chain escrow state, never from its presence
 * here. One malformed or wrong-chain record is skipped on its own so it cannot
 * hide the good listings alongside it.
 */
export async function fetchCatalogOffers(node: PcashNodeClient): Promise<OfferPublication[]> {
  const info = await requireMarketplaceCatalog(node);
  const pageItems = Number(
    info.limits.defaultPageItems > 0n ? info.limits.defaultPageItems : info.limits.maxPageItems,
  );

  const seenContentIds = new Set<string>();
  const seenCursors = new Set<string>();
  const byOffer = new Map<string, Candidate[]>();
  let cursor: string | undefined;
  let totalBytes = 0;

  for (let page = 0; page < MAX_CATALOG_PAGES; page += 1) {
    const result = await node.catalogList({
      namespace: MARKETPLACE_CATALOG_NAMESPACE,
      ...(cursor !== undefined ? { cursor } : {}),
      ...(pageItems > 0 ? { limit: pageItems } : {}),
    });

    for (const record of result.items) {
      // Exact byte duplicates across pages: pagination is not a snapshot, so a
      // concurrent publish can shift a record into a page already read.
      if (seenContentIds.has(record.artifact.contentId)) continue;
      seenContentIds.add(record.artifact.contentId);

      totalBytes += record.artifact.payload.length;
      if (totalBytes > MAX_CATALOG_TOTAL_BYTES) {
        return collapse(byOffer);
      }

      const parsed = tryParseOffer(record, info);
      if (parsed === null) continue;
      keepBetter(byOffer, { ...parsed, createdAt: record.createdAt });
    }

    if (result.nextCursor === null) break;
    // A node that never advances, or cycles, would page forever.
    if (seenCursors.has(result.nextCursor)) break;
    seenCursors.add(result.nextCursor);
    cursor = result.nextCursor;
  }

  return collapse(byOffer);
}

/** A parsed candidate plus the node-assigned time its record first appeared. */
interface Candidate {
  publication: OfferPublication;
  key: string;
  createdAt: bigint;
}

/**
 * Decode one record, or `null` if it is not a usable marketplace offer for this
 * node's chain. Deliberately silent: discovery is best-effort.
 */
function tryParseOffer(record: CatalogRecord, info: CatalogInfo): Pick<Candidate, "publication" | "key"> | null {
  try {
    if (record.artifact.namespace !== MARKETPLACE_CATALOG_NAMESPACE) return null;
    const publication = parsePublication(utf8Decode(record.artifact.payload));
    // The wrapper is bound to this node by the node itself; the payload carries
    // its own chain id and must agree, or the record is for another chain.
    if (!sameChainId(publication, catalogChain(info))) return null;
    // offerKey throws on a malformed contract body; inside this catch a bad
    // record is skipped instead of aborting grouping.
    return { publication, key: offerKey(publication) };
  } catch {
    return null;
  }
}

/**
 * Group candidates by the offer they describe.
 *
 * Content-ID dedup only removes exact byte duplicates, and one offer legitimately
 * has two byte forms: the pre-funding publication and the funded one carrying the
 * escrow opening. Listing both would show the same offer twice, one of which can
 * never verify.
 *
 * Collapsing further than that would be a censorship vector. The escrow opening
 * is not committed by anything in `offerKey`, so anyone can publish a same-key
 * copy with a bogus opening; if that displaced the seller's record, one cheap
 * publish would hide a real listing. So funded variants are all kept — a fake
 * simply fails verification — and only the strictly redundant unfunded form is
 * dropped.
 */
function keepBetter(byOffer: Map<string, Candidate[]>, candidate: Candidate): void {
  const key = candidate.key;
  const existing = byOffer.get(key);
  if (existing === undefined) {
    byOffer.set(key, [candidate]);
    return;
  }
  const candidateId = publicationIdentity(candidate.publication);
  if (existing.some((entry) => publicationIdentity(entry.publication) === candidateId)) return;
  if (candidate.publication.escrow === undefined) {
    // Redundant the moment any funded form of this offer exists.
    if (existing.some((entry) => entry.publication.escrow !== undefined)) return;
    existing.push(candidate);
    return;
  }
  byOffer.set(key, [
    ...existing.filter((entry) => entry.publication.escrow !== undefined),
    candidate,
  ]);
}

/**
 * Flatten to newest-first.
 *
 * Content IDs are keccak output, so the node's own order is effectively random.
 * `createdAt` is the only recency signal there is, and "what appeared recently"
 * is the ordering a storefront actually wants.
 */
function collapse(byOffer: Map<string, Candidate[]>): OfferPublication[] {
  return [...byOffer.values()]
    .flat()
    .sort((left, right) => (right.createdAt > left.createdAt ? 1 : right.createdAt < left.createdAt ? -1 : 0))
    .map((entry) => entry.publication);
}

/**
 * Publish the final funded publication.
 *
 * Deliberately a separate step after `publishOffer`: that function submits the
 * PCASH contract account and escrow funding with durable exact-byte checkpoints,
 * and a catalog failure must never roll back or obscure a consensus-relevant
 * funding result. If this throws, the caller still holds the exact publication
 * and its share link.
 */
export async function publishCatalogOffer(
  node: PcashNodeClient,
  publication: OfferPublication,
): Promise<CatalogRecord> {
  const info = await requireMarketplaceCatalog(node);
  if (!sameChainId(publication, catalogChain(info))) {
    throw new Error(
      `offer belongs to pcash chain ${BigInt(publication.chainId)} `
        + `but this node's catalog is chain ${info.pcashChainId}`,
    );
  }

  // Exactly the bytes `serializePublication` produces; the content ID commits to
  // them, so nothing may re-encode the payload between here and storage.
  const payload = utf8Encode(serializePublication(publication));
  return node.catalogPublish(
    buildCatalogArtifact({
      namespace: MARKETPLACE_CATALOG_NAMESPACE,
      pcashChainId: info.pcashChainId,
      payload,
    }),
  );
}

/**
 * A shareable link carrying the whole portable publication.
 *
 * The payload rides in the URL fragment, so it is never sent to whatever server
 * hosts the page. Shared links work with no catalog because the publication
 * carries the offer data; the decoded offer still requires current-state verification.
 */
export function listingShareUrl(publication: OfferPublication, baseUrl?: string): string {
  const encoded = toBase64Url(utf8Encode(serializePublication(publication)));
  const supplied = baseUrl ?? currentUrlWithoutFragment();
  const hashIndex = supplied.indexOf("#");
  const base = hashIndex < 0 ? supplied : supplied.slice(0, hashIndex);
  return `${base}#${SHARE_FRAGMENT_KEY}=${encoded}`;
}

/**
 * Decode a shared listing link, or `null` when the URL carries no offer.
 *
 * A malformed or non-offer fragment is `null`, not an exception: a stray
 * fragment must not break page load. The result is untrusted and still needs
 * full verification against a node before payment.
 */
export function sharedOfferFromUrl(url?: string): OfferPublication | null {
  const target = url ?? currentUrl();
  if (target === null) return null;
  const hashIndex = target.indexOf("#");
  if (hashIndex < 0) return null;
  const params = new URLSearchParams(target.slice(hashIndex + 1));
  const encoded = params.get(SHARE_FRAGMENT_KEY);
  if (encoded === null || encoded === "") return null;
  try {
    const publication = parsePublication(utf8Decode(fromBase64Url(encoded)));
    // A syntactically valid body can still fail contract decoding.
    offerKey(publication);
    return publication;
  } catch {
    return null;
  }
}

function currentUrl(): string | null {
  const location = (globalThis as { location?: { href?: string } }).location;
  return typeof location?.href === "string" ? location.href : null;
}

function currentUrlWithoutFragment(): string {
  const href = currentUrl();
  if (href === null) {
    throw new Error("listingShareUrl needs a base URL outside a browser");
  }
  const hashIndex = href.indexOf("#");
  return hashIndex < 0 ? href : href.slice(0, hashIndex);
}
