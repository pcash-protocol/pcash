// Marketplace catalog adapter: namespace, lease selection, pagination,
// duplicate suppression, network matching, and share links. The generic
// transport is exercised in the SDK; here the question is whether the
// marketplace workflow is correct on top of it.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildCatalogArtifact,
  fieldToHex,
  type CatalogArtifact,
  type CatalogInfo,
  type CatalogListQuery,
  type CatalogPage,
  type CatalogRecord,
  type PcashNodeClient,
} from "@pcash/sdk";
import { DEFAULT_NETWORK_CONFIG } from "@pcash/sdk";
import { createOffer } from "../src/offer.mts";
import {
  CLAIM_APPLICATION_VK_HASH,
  RECLAIM_APPLICATION_VK_HASH,
} from "../src/commitments.mts";
import { derivePcashProfileFromPrivateKey } from "@pcash/sdk/wallet";
import {
  CatalogUnavailableError,
  MARKETPLACE_CATALOG_NAMESPACE,
  fetchCatalogOffers,
  listingShareUrl,
  publishCatalogOffer,
  sharedOfferFromUrl,
} from "../src/client/catalog.ts";
import {
  offerKey,
  parsePublication,
  publicationIdentity,
  publicationFromOffer,
  serializePublication,
  type OfferPublication,
} from "../src/client/publication.ts";

const CHAIN_ID = Number(DEFAULT_NETWORK_CONFIG.pcashChainId);
const NOW_SECONDS = 1_700_000_000;
const DEADLINE_T = BigInt(NOW_SECONDS) + 1_800n;

function limits(): CatalogInfo["limits"] {
  return {
    maxPayloadBytes: 262_144n,
    maxRecords: 5_000n,
    maxAggregatePayloadBytes: 10_485_760n,
    defaultPageItems: 200n,
    maxPageItems: 500n,
    maxPagePayloadBytes: 1_048_576n,
  };
}

function info(overrides: Partial<CatalogInfo> = {}): CatalogInfo {
  return {
    status: "available",
    writable: true,
    pcashChainId: CHAIN_ID,
    namespaces: [MARKETPLACE_CATALOG_NAMESPACE],
    limits: limits(),
    ...overrides,
  };
}

let offerSeed = 0;

function publication(
  overrides: { chainId?: bigint; deadlineT?: bigint; funded?: boolean } = {},
): OfferPublication {
  offerSeed += 1;
  const wallet = derivePcashProfileFromPrivateKey(
    new Uint8Array(32).fill(offerSeed),
    DEFAULT_NETWORK_CONFIG,
  );
  const offer = createOffer({
    network: DEFAULT_NETWORK_CONFIG,
    terms: {
      router: 0x1234n,
      seller: 0x5678n,
      assetId: 0n,
      amount: 1_000_000n,
      ethPriceWei: 1_000_000_000_000_000n,
      deadlineT: overrides.deadlineT ?? DEADLINE_T,
    },
    sellerWallet: wallet,
    l2ContractNkRoot: BigInt(0x900 + offerSeed),
    claimApplicationVkHash: CLAIM_APPLICATION_VK_HASH,
    reclaimApplicationVkHash: RECLAIM_APPLICATION_VK_HASH,
  });
  const pub = publicationFromOffer(offer);
  if (overrides.chainId !== undefined) pub.chainId = fieldToHex(overrides.chainId);
  if (overrides.funded !== false) {
    pub.escrow = { leafIndex: offerSeed, noteSecret: fieldToHex(7n), amount: pub.terms.amount };
  }
  return pub;
}

let createdSeq = 0n;

function recordFor(pub: OfferPublication, createdAt?: bigint): CatalogRecord {
  createdSeq += 1n;
  return {
    artifact: buildCatalogArtifact({
      namespace: MARKETPLACE_CATALOG_NAMESPACE,
      pcashChainId: CHAIN_ID,
      payload: new TextEncoder().encode(serializePublication(pub)),
    }),
    createdAt: createdAt ?? BigInt(NOW_SECONDS) + createdSeq,
  };
}

/** A record whose payload is arbitrary bytes rather than a publication. */
function garbageRecord(payload: Uint8Array): CatalogRecord {
  return {
    artifact: buildCatalogArtifact({
      namespace: MARKETPLACE_CATALOG_NAMESPACE,
      pcashChainId: CHAIN_ID,
      payload,
    }),
    createdAt: BigInt(NOW_SECONDS),
  };
}

interface StubOptions {
  info?: CatalogInfo;
  pages?: CatalogPage[];
  onPublish?: (artifact: CatalogArtifact) => CatalogRecord;
}

function stubNode(options: StubOptions): { node: PcashNodeClient; queries: CatalogListQuery[] } {
  const queries: CatalogListQuery[] = [];
  let page = 0;
  const node = {
    catalogInfo: async () => options.info ?? info(),
    catalogList: async (query: CatalogListQuery) => {
      queries.push(query);
      const result = options.pages?.[page] ?? { items: [], nextCursor: null };
      page += 1;
      return result;
    },
    catalogPublish: async (artifact: CatalogArtifact) =>
      options.onPublish
        ? options.onPublish(artifact)
        : { artifact, createdAt: BigInt(NOW_SECONDS) },
  } as unknown as PcashNodeClient;
  return { node, queries };
}

const cursor = (byte: string) => `0x${byte.repeat(32)}`;

describe("fetchCatalogOffers", () => {
  it("returns offers published under the marketplace namespace", async () => {
    const pub = publication();
    const { node, queries } = stubNode({
      pages: [{ items: [recordFor(pub)], nextCursor: null }],
    });

    const offers = await fetchCatalogOffers(node);
    assert.equal(offers.length, 1);
    assert.equal(offerKey(offers[0]!), offerKey(pub));
    // Callers never supply catalog mechanics; the adapter owns them.
    assert.deepEqual(queries, [
      { namespace: MARKETPLACE_CATALOG_NAMESPACE, limit: 200 },
    ]);
  });

  it("follows cursors across more than one page", async () => {
    const first = publication();
    const second = publication();
    const third = publication();
    const { node, queries } = stubNode({
      pages: [
        { items: [recordFor(first)], nextCursor: cursor("11") },
        { items: [recordFor(second)], nextCursor: cursor("22") },
        { items: [recordFor(third)], nextCursor: null },
      ],
    });

    const offers = await fetchCatalogOffers(node);
    assert.equal(offers.length, 3);
    assert.equal(queries.length, 3);
    assert.equal(queries[1]!.cursor, cursor("11"));
    assert.equal(queries[2]!.cursor, cursor("22"));
  });

  it("stops on a cursor cycle instead of paging forever", async () => {
    const pub = publication();
    const { node, queries } = stubNode({
      pages: Array.from({ length: 40 }, () => ({
        items: [recordFor(pub)],
        nextCursor: cursor("11"),
      })),
    });

    const offers = await fetchCatalogOffers(node);
    assert.equal(offers.length, 1);
    // Second page repeats the cursor, so paging stops there.
    assert.equal(queries.length, 2);
  });

  it("stops at the page ceiling when every cursor advances", async () => {
    const { node, queries } = stubNode({
      pages: Array.from({ length: 200 }, (_unused, index) => ({
        items: [recordFor(publication())],
        nextCursor: cursor(index.toString(16).padStart(2, "0")),
      })),
    });

    await fetchCatalogOffers(node);
    assert.ok(queries.length <= 64, `paged ${queries.length} times`);
  });

  it("returns offers newest first", async () => {
    const oldest = publication();
    const middle = publication();
    const newest = publication();
    const { node } = stubNode({
      pages: [{
        items: [
          recordFor(middle, 2_000n),
          recordFor(oldest, 1_000n),
          recordFor(newest, 3_000n),
        ],
        nextCursor: null,
      }],
    });

    // Content IDs are keccak output, so the node's own order is arbitrary.
    // createdAt is the only recency signal, and a storefront wants it applied.
    const offers = await fetchCatalogOffers(node);
    assert.deepEqual(
      offers.map((entry) => offerKey(entry)),
      [newest, middle, oldest].map((entry) => offerKey(entry)),
    );
  });

  it("still returns offers whose payment deadline has passed", async () => {
    // Nothing expires in the catalog, so a stale listing is present and it is
    // the client's job to judge liveness — never the catalog's absence.
    const expired = publication({ deadlineT: BigInt(NOW_SECONDS) - 10_000n });
    const { node } = stubNode({ pages: [{ items: [recordFor(expired)], nextCursor: null }] });
    assert.equal((await fetchCatalogOffers(node)).length, 1);
  });

  it("suppresses exact duplicates repeated across pages", async () => {
    const pub = publication();
    const record = recordFor(pub);
    const { node } = stubNode({
      pages: [
        { items: [record], nextCursor: cursor("11") },
        { items: [record], nextCursor: null },
      ],
    });

    assert.equal((await fetchCatalogOffers(node)).length, 1);
  });

  it("collapses the funded and unfunded forms of one offer, keeping the funded one", async () => {
    const funded = publication();
    const unfunded: OfferPublication = { ...funded };
    delete unfunded.escrow;

    // Different bytes, so different content IDs — content-ID dedup alone would
    // show this offer twice, one of which can never be paid.
    for (const order of [
      [recordFor(unfunded), recordFor(funded)],
      [recordFor(funded), recordFor(unfunded)],
    ]) {
      const { node } = stubNode({ pages: [{ items: order, nextCursor: null }] });
      const offers = await fetchCatalogOffers(node);
      assert.equal(offers.length, 1);
      assert.ok(offers[0]!.escrow !== undefined, "kept the unfunded form");
    }
  });

  it("cannot be made to hide a real listing by republishing a bogus escrow", async () => {
    // The escrow opening is not committed by anything in offerKey, so anyone can
    // publish a same-key copy with a fake opening. Collapsing to one record per
    // offer would let that one cheap publish censor the seller's listing, so
    // both funded variants survive and verification sorts them out.
    const genuine = publication();
    const impostor: OfferPublication = {
      ...genuine,
      escrow: { ...genuine.escrow!, noteSecret: fieldToHex(0xdeadn) },
    };

    const { node } = stubNode({
      pages: [{ items: [recordFor(impostor), recordFor(genuine)], nextCursor: null }],
    });
    const offers = await fetchCatalogOffers(node);
    assert.equal(offers.length, 2);
    assert.ok(
      offers.some((entry) => entry.escrow!.noteSecret === genuine.escrow!.noteSecret),
      "the seller's own record survived",
    );
    assert.equal(new Set(offers.map(publicationIdentity)).size, offers.length);
  });

  it("skips malformed and wrong-chain records without hiding good ones", async () => {
    const good = publication();
    const wrongChain = publication({ chainId: BigInt(CHAIN_ID) + 1n });
    const malformedContract = publication();
    malformedContract.l2Contract.bodyHex = "0x00";
    const { node } = stubNode({
      pages: [
        {
          items: [
            garbageRecord(Uint8Array.of(0x00, 0xff, 0x80)),
            garbageRecord(new TextEncoder().encode("{\"version\":1}")),
            garbageRecord(new TextEncoder().encode("not json at all")),
            recordFor(malformedContract),
            recordFor(wrongChain),
            recordFor(good),
          ],
          nextCursor: null,
        },
      ],
    });

    const offers = await fetchCatalogOffers(node);
    assert.equal(offers.length, 1);
    assert.equal(offerKey(offers[0]!), offerKey(good));
  });

  it("refuses a node whose catalog cannot serve marketplace offers", async () => {
    for (const unusable of [
      info({ status: "disabled", writable: false }),
      info({ status: "unavailable", writable: false }),
      info({ namespaces: ["other.things.v1"] }),
    ]) {
      const { node } = stubNode({ info: unusable });
      await assert.rejects(fetchCatalogOffers(node), CatalogUnavailableError);
    }
  });
});

describe("publishCatalogOffer", () => {
  it("publishes the exact stable payload under the fixed namespace", async () => {
    const pub = publication();
    let published: CatalogArtifact | null = null;
    const { node } = stubNode({
      onPublish: (artifact) => {
        published = artifact;
        return { artifact, createdAt: BigInt(NOW_SECONDS) };
      },
    });

    const stored = await publishCatalogOffer(node, pub);
    assert.ok(published !== null);
    const artifact = published as CatalogArtifact;
    assert.equal(artifact.namespace, MARKETPLACE_CATALOG_NAMESPACE);
    assert.equal(artifact.pcashChainId, CHAIN_ID);
    // Byte-exact: the content ID commits to these bytes, so nothing may
    // re-encode the payload on the way to storage.
    assert.equal(new TextDecoder().decode(artifact.payload), serializePublication(pub));
    // createdAt comes back from the node; the caller never supplies it.
    assert.equal(stored.createdAt, BigInt(NOW_SECONDS));
  });

  it("refuses to publish an offer from another chain", async () => {
    const { node } = stubNode({});
    await assert.rejects(
      publishCatalogOffer(node, publication({ chainId: BigInt(CHAIN_ID) + 1n })),
      /but this node's catalog is chain/,
    );
  });

  it("refuses when the catalog is not available", async () => {
    const { node } = stubNode({ info: info({ status: "disabled", writable: false }) });
    await assert.rejects(publishCatalogOffer(node, publication()), CatalogUnavailableError);
  });
});

describe("shared listing links", () => {
  it("round-trips a publication without any catalog access", () => {
    const pub = publication();
    const url = listingShareUrl(pub, "https://example.test/market");
    const decoded = sharedOfferFromUrl(url);
    assert.ok(decoded !== null);
    // The whole offer survives the link, which is the point: no catalog needed.
    assert.equal(offerKey(decoded!), offerKey(pub));
    assert.equal(serializePublication(decoded!), serializePublication(pub));
  });

  it("carries the offer in the fragment so it never reaches a server", () => {
    const url = listingShareUrl(publication(), "https://example.test/market");
    assert.ok(url.includes("#offer="));
    assert.equal(url.indexOf("?"), -1);
  });

  it("replaces an existing listing fragment instead of nesting fragments", () => {
    const pub = publication();
    const url = listingShareUrl(pub, "https://market.example/marketplace#offer=old");
    assert.equal(url.includes("offer=old"), false);
    assert.equal(serializePublication(sharedOfferFromUrl(url)!), serializePublication(pub));
  });

  it("returns null rather than throwing for a URL with no usable offer", () => {
    for (const url of [
      "https://example.test/market",
      "https://example.test/market#",
      "https://example.test/market#offer=",
      "https://example.test/market#offer=not-base64url-json",
      "https://example.test/market#other=1",
    ]) {
      assert.equal(sharedOfferFromUrl(url), null, url);
    }
  });

  it("rejects a shared offer whose publication is malformed", () => {
    const pub = publication();
    const broken = JSON.parse(serializePublication(pub));
    delete broken.chainId;
    const encoded = Buffer.from(JSON.stringify(broken), "utf8").toString("base64url");
    assert.equal(sharedOfferFromUrl(`https://example.test/market#offer=${encoded}`), null);

    const malformedContract = { ...pub, l2Contract: { ...pub.l2Contract, bodyHex: "0x00" } };
    const encodedContract = Buffer.from(serializePublication(malformedContract), "utf8").toString("base64url");
    assert.equal(sharedOfferFromUrl(`https://example.test/market#offer=${encodedContract}`), null);
  });
});

describe("publication identity", () => {
  it("is semantic rather than dependent on JSON object key order", () => {
    const canonical = publication();
    const reordered = JSON.stringify({
      escrow: canonical.escrow,
      reclaimAuthority: canonical.reclaimAuthority,
      l2Contract: canonical.l2Contract,
      terms: canonical.terms,
      chainId: canonical.chainId,
      version: canonical.version,
    });
    const parsed = parsePublication(reordered);
    assert.equal(publicationIdentity(parsed), publicationIdentity(canonical));
    assert.equal(serializePublication(parsed), serializePublication(canonical));
  });

  it("deduplicates semantically identical catalog records with reordered JSON", async () => {
    const canonical = publication();
    const reorderedPayload = new TextEncoder().encode(JSON.stringify({
      escrow: canonical.escrow,
      reclaimAuthority: canonical.reclaimAuthority,
      l2Contract: canonical.l2Contract,
      terms: canonical.terms,
      chainId: canonical.chainId,
      version: canonical.version,
    }));
    const reorderedRecord = recordFor(canonical);
    reorderedRecord.artifact = buildCatalogArtifact({
      namespace: MARKETPLACE_CATALOG_NAMESPACE,
      pcashChainId: CHAIN_ID,
      payload: reorderedPayload,
    });
    const { node } = stubNode({
      pages: [{ items: [recordFor(canonical), reorderedRecord], nextCursor: null }],
    });
    assert.equal((await fetchCatalogOffers(node)).length, 1);
  });
});
