import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCatalogArtifact,
  type CatalogArtifact,
  type CatalogInfo,
  type CatalogListQuery,
  type CatalogPage,
  type CatalogRecord,
} from "@pcash/sdk/protocol";
import {
  DROP_CATALOG_NAMESPACE,
  dropPublication,
  dropTermsForCreator,
  eligibilityDrop,
  fetchDropPublications,
  parseDropPublication,
  publishDropPublication,
  serializeDropPublication,
  verifyDropPublication,
  type DropPublication,
} from "../src/index.ts";
import { testToken } from "./wallets.ts";

const CHAIN = 1346589512;
const token = testToken(3n);
const drop = eligibilityDrop(dropTermsForCreator({
  dropSeed: 0xd509n,
  assetId: token.assetId,
  claimAmount: 250n,
  cutoffBlockNumber: 7n,
  claimEndTimestamp: 5_000n,
  creator: { address: 0xc0ffeen, nkRoot: 0xabcn },
}));
const TX_A = `0x${"a1".repeat(32)}`;
const TX_B = `0x${"b2".repeat(32)}`;
const publication = dropPublication(drop, { chainId: CHAIN, definition: token.definition, funding: [
  { contentHash: TX_A, firstIndex: 0, count: 3 }, { contentHash: TX_B, firstIndex: 6, count: 2 },
] });

test("drop publications serialize canonically and parse strictly", () => {
  const text = serializeDropPublication(publication);
  assert.deepEqual(parseDropPublication(text), publication);
  assert.equal(serializeDropPublication(parseDropPublication(text)), text);
  const wire = JSON.parse(text) as Record<string, unknown>;
  assert.deepEqual(Object.keys(wire), [...Object.keys(wire)].sort());
  const reject = (change: Record<string, unknown>, message: RegExp) =>
    assert.throws(() => parseDropPublication(JSON.stringify({ ...wire, ...change })), message);
  reject({ extra: 1 }, /field set/);
  reject({ version: 2 }, /version/);
  reject({ chainId: 0 }, /chainId/);
  reject({ assetId: `0x${"0".repeat(63)}7` }, /field set/);
  reject({ claimAmount: `0x${"f".repeat(64)}` }, /claimAmount/);
  reject({ definition: "0x" }, /definition/);
  reject({ definition: "0xABCD" }, /definition/);
  assert.throws(() => parseDropPublication(JSON.stringify({ ...wire, definition: `${wire.definition as string}00` })));
  reject({ funding: [] }, /funding/);
  reject({ funding: [{ count: 1, contentHash: TX_A, firstIndex: 0 }, { count: 1, contentHash: TX_A, firstIndex: 1 }] }, /repeats/);
  reject({ funding: [{ count: 0, contentHash: TX_A, firstIndex: 0 }] }, /count/);
  reject({ funding: [{ count: 33, contentHash: TX_A, firstIndex: 0 }] }, /count/);
  reject({ funding: [{ count: 1, contentHash: TX_A.toUpperCase().replace("0X", "0x"), firstIndex: 0 }] }, /contentHash/);
  reject({ funding: [{ count: 1, contentHash: TX_A, firstIndex: 0, extra: 1 }] }, /contentHash, count and firstIndex/);
  reject({ funding: [{ count: 2, contentHash: TX_A, firstIndex: 0 }, { count: 1, contentHash: TX_B, firstIndex: 1 }] }, /indexes/);
  reject({ funding: [{ count: 1, contentHash: TX_A, firstIndex: 65_535 }, { count: 1, contentHash: TX_B, firstIndex: 65_536 }] }, /indexes/);
  assert.throws(() => parseDropPublication("{"), /JSON/);
});

test("verification rebuilds the drop from its terms and pinned implementations", () => {
  const verified = verifyDropPublication(publication, { chainId: CHAIN });
  assert.equal(verified.drop.address, drop.address);
  assert.deepEqual(verified.drop.body, drop.body);
  assert.equal(verified.drop.configuration.assetId, token.assetId);
  const other = testToken(4n).definition;
  assert.notEqual(verifyDropPublication({ ...publication, definition: other }, { chainId: CHAIN }).drop.address, drop.address);
  assert.deepEqual(verified.funding, publication.funding);
  assert.equal(verified.count, 5);
  assert.throws(() => verifyDropPublication(publication, { chainId: CHAIN + 1 }), /chain/);
  assert.throws(() => verifyDropPublication({ ...publication, claimAmount: 0n }, { chainId: CHAIN }), /claim amount/);
});

function catalogNode(records: CatalogRecord[], namespaces = [DROP_CATALOG_NAMESPACE]) {
  const info: CatalogInfo = {
    status: "available",
    writable: true,
    pcashChainId: CHAIN,
    namespaces,
    limits: {
      maxPayloadBytes: 262_144n,
      maxRecords: 5_000n,
      maxAggregatePayloadBytes: 1n << 30n,
      defaultPageItems: 2n,
      maxPageItems: 100n,
      maxPagePayloadBytes: 1n << 20n,
    },
  };
  const published: CatalogArtifact[] = [];
  return {
    published,
    async catalogInfo() {
      return info;
    },
    async catalogList(query: CatalogListQuery): Promise<CatalogPage> {
      assert.equal(query.namespace, DROP_CATALOG_NAMESPACE);
      const start = query.cursor === undefined ? 0 : records.findIndex((record) => record.artifact.contentId === query.cursor) + 1;
      const items = records.slice(start, start + (query.limit ?? 100));
      const more = start + items.length < records.length;
      return { items, nextCursor: more ? items.at(-1)!.artifact.contentId : null };
    },
    async catalogPublish(artifact: CatalogArtifact): Promise<CatalogRecord> {
      published.push(artifact);
      return { artifact, createdAt: 1n };
    },
  };
}

function record(payload: string, createdAt: bigint, pcashChainId = CHAIN): CatalogRecord {
  return {
    artifact: buildCatalogArtifact({ namespace: DROP_CATALOG_NAMESPACE, pcashChainId, payload: new TextEncoder().encode(payload) }),
    createdAt,
  };
}

test("listing skips malformed and other-chain records and orders by recency", async () => {
  const older: DropPublication = { ...publication, funding: [{ contentHash: TX_B, firstIndex: 3, count: 1 }] };
  const other: DropPublication = { ...publication, chainId: CHAIN + 1 };
  const node = catalogNode([
    record(serializeDropPublication(older), 10n),
    record("not a drop", 11n),
    record(serializeDropPublication(other), 12n),
    record(serializeDropPublication(publication), 13n),
    record(serializeDropPublication(publication), 13n),
  ]);
  assert.deepEqual(await fetchDropPublications(node), [publication, older]);
  await assert.rejects(fetchDropPublications(catalogNode([], ["pcash.marketplace.offer.v1"])), /does not accept/);
});

test("publishing sends the canonical bytes under the drop namespace", async () => {
  const node = catalogNode([]);
  await publishDropPublication(node, publication);
  assert.equal(node.published.length, 1);
  assert.equal(node.published[0]!.namespace, DROP_CATALOG_NAMESPACE);
  assert.equal(new TextDecoder().decode(node.published[0]!.payload), serializeDropPublication(publication));
  await assert.rejects(publishDropPublication(node, { ...publication, chainId: CHAIN + 1 }), /chain/);
});
