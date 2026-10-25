// Edge cases for block commitments, catalog decoding, and standard fungible
// asset construction.

import { concat, hexToBytes, numberToHex, stringToBytes, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import {
  payoutResultLeaf,
  transactionId,
  transactionOutcomeFromCode,
  transactionResultLeaf,
  transactionResultsRoot,
  transactionStatementHash,
  TRANSACTION_OUTCOME_CODE,
  TRANSACTION_RESULTS_TREE_DEPTH,
  TypedCommitmentTree,
  type PayoutResultCommitment,
  type TransactionOutcome,
  type TransactionResultCommitment,
} from "../src/protocol/block.ts";
import { ASSET_ID_DOMAIN, TRANSACTION_RESULTS_ROOT_DOMAIN } from "../src/constants/domainTags.ts";
import { emptyLadder, rootFromIndex } from "../src/crypto/merkle.ts";
import { poseidon, poseidonBytes } from "../src/crypto/poseidon2.ts";
import { REFERENCE_FUNGIBLE_METADATA_DOMAIN } from "../src/constants/referenceRuleConstants.ts";
import {
  assertCatalogRecordIdentity,
  buildCatalogArtifact,
  decodeCatalogInfo,
  decodeCatalogPage,
  decodeCatalogRecord,
  encodeCatalogArtifact,
  encodeCatalogListQuery,
} from "../src/protocol/catalog.ts";
import {
  assetSecretCommitment,
  createStandardFungibleAsset,
  deriveStandardFungibleAssetFromEntropy,
  fungibleMetadataCommitment,
  standardFungibleAssetId,
  verifyAssetDescriptor,
  type FungibleMetadata,
} from "../src/protocol/asset.ts";
import { AMOUNT_BITS } from "../src/constants/params.ts";
import { toHex } from "../src/utils/hex.ts";

describe("transaction results root", () => {
  const poster = 0x5151n;
  const result = (index: number, outcome: TransactionOutcome = "succeeded"): TransactionResultCommitment => ({
    txType: 0,
    fundingMode: 0,
    l1TransactionIndex: BigInt(index),
    batchItemIndex: BigInt(index * 2),
    outcome,
    posterOwnerCommitment: poster,
    outputStartIndex: outcome === "succeeded" ? BigInt(index * 5) : 0n,
    statementHash: outcome === "succeeded" ? transactionStatementHash([BigInt(index)]) : 0n,
  });
  const payout: PayoutResultCommitment = {
    outputIndex: 10n,
    ownerCommitment: poster,
    openFeeAmount: 3n,
    issuanceAmount: 0n,
  };
  const ladder = emptyLadder(TRANSACTION_RESULTS_TREE_DEPTH);
  const bound = (transactions: number, payouts: number, treeRoot: bigint): bigint =>
    poseidon([TRANSACTION_RESULTS_ROOT_DOMAIN, BigInt(transactions), BigInt(payouts), treeRoot]);

  it("roots an empty block over the empty depth-64 tree", () => {
    expect(transactionResultsRoot([], [])).toBe(bound(0, 0, ladder[TRANSACTION_RESULTS_TREE_DEPTH]!));
  });

  it("places payouts directly after the transaction results", () => {
    const transactions = [result(0), result(1, "proofRejected")];
    const leaves = transactions.map((value) => transactionResultLeaf(value));
    const siblings = [ladder[0]!, poseidon([leaves[0]!, leaves[1]!]), ...ladder.slice(2, TRANSACTION_RESULTS_TREE_DEPTH)];
    expect(transactionResultsRoot(transactions, [payout]))
      .toBe(bound(2, 1, rootFromIndex(payoutResultLeaf(payout), 2n, siblings)));
  });

  it("rejects values outside their committed widths", () => {
    expect(() => transactionResultLeaf({ ...result(0), txType: 256 })).toThrow("txType is out of range");
    expect(() => transactionResultLeaf({ ...result(0), outputStartIndex: 1n << 40n }))
      .toThrow("outputStartIndex is out of range");
    expect(() => payoutResultLeaf({ ...payout, openFeeAmount: 1n << 128n })).toThrow("openFeeAmount is out of range");
  });
});

describe("transactionId", () => {
  it("rejects an L1 block hash that is not 32 bytes", () => {
    expect(() => transactionId({ l1BlockHash: new Uint8Array(31), l1TransactionIndex: 0n, batchItemIndex: 0n }))
      .toThrow("transaction ID L1 block hash must be 32 bytes");
  });
});

describe("transactionOutcomeFromCode", () => {
  it("decodes every known code and reports an unknown u16 as unsupported", () => {
    for (const [outcome, code] of Object.entries(TRANSACTION_OUTCOME_CODE)) {
      expect(transactionOutcomeFromCode(code)).toEqual({ supported: true, outcome });
    }
    expect(transactionOutcomeFromCode(37)).toEqual({ supported: false, code: 37 });
    expect(transactionOutcomeFromCode(0xffff)).toEqual({ supported: false, code: 0xffff });
  });

  it.each([-1, 0x10000, 1.5, Number.NaN])("rejects %s as outside u16", (code) => {
    expect(() => transactionOutcomeFromCode(code)).toThrow("transaction outcome code must fit in u16");
  });
});

describe("TypedCommitmentTree", () => {
  it("rejects keys outside the depth-4 tree", () => {
    const tree = new TypedCommitmentTree(1n);
    expect(() => tree.setLeaf(16, 1n)).toThrow("commitment tree key is out of range");
    expect(() => tree.proof(16)).toThrow("commitment tree key is out of range");
    tree.setLeaf(15, 9n);
    const proof = tree.proof(15);
    expect(proof.leafIndex).toBe(15);
    expect(proof.siblings).toHaveLength(4);
    expect(proof.root).toBe(tree.root);
  });
});

describe("catalog decoding", () => {
  const artifact = buildCatalogArtifact({ namespace: "market", pcashChainId: 7, payload: Uint8Array.of(1, 2, 3) });
  const wire = (): Record<string, unknown> => ({ ...encodeCatalogArtifact(artifact), createdAt: "0x5" });

  it("round-trips an encoded record", () => {
    const record = decodeCatalogRecord(wire());
    expect(record.artifact).toEqual(artifact);
    expect(record.createdAt).toBe(5n);
  });

  it("rejects a chain id wider than u32", () => {
    expect(() => decodeCatalogRecord({ ...wire(), pcashChainId: "0x100000000" }))
      .toThrow("pcashChainId must fit uint32");
  });

  it("rejects a content id that does not commit to the record", () => {
    expect(() => decodeCatalogRecord({ ...wire(), payload: "0x010204" }))
      .toThrow(`catalog record contentId does not match its artifact: ${artifact.contentId}`);
    expect(() => decodeCatalogRecord({ ...wire(), pcashChainId: "0x8" })).toThrow(/does not match its artifact/);
    expect(() => encodeCatalogArtifact({ ...artifact, payload: Uint8Array.of(9) })).toThrow(/does not match its artifact/);
  });

  it("rejects non-object records and malformed fields", () => {
    expect(() => decodeCatalogRecord([])).toThrow("catalog record must be an object");
    expect(() => decodeCatalogRecord({ ...wire(), namespace: "Bad" })).toThrow(/catalog namespace must be/);
    expect(() => decodeCatalogRecord({ ...wire(), payload: "010203" })).toThrow("payload must be a 0x-prefixed hex string");
  });

  it("requires nextCursor on a page, as null or a 32-byte id", () => {
    expect(() => decodeCatalogPage({ items: [] })).toThrow("pcash_catalogList nextCursor is required");
    expect(() => decodeCatalogPage({ items: {}, nextCursor: null })).toThrow("pcash_catalogList items must be an array");
    expect(() => decodeCatalogPage({ items: [], nextCursor: "0x12" })).toThrow(/nextCursor/);
    expect(decodeCatalogPage({ items: [wire()], nextCursor: artifact.contentId }))
      .toEqual({ items: [{ artifact, createdAt: 5n }], nextCursor: artifact.contentId });
  });

  it("rejects an info result with a chain id wider than u32 or an unknown status", () => {
    const info = {
      status: "available",
      writable: true,
      pcashChainId: "0x7",
      namespaces: ["market"],
      limits: {
        maxPayloadBytes: "0x1",
        maxRecords: "0x1",
        maxAggregatePayloadBytes: "0x1",
        defaultPageItems: "0x1",
        maxPageItems: "0x1",
        maxPagePayloadBytes: "0x1",
      },
    };
    expect(decodeCatalogInfo(info).pcashChainId).toBe(7);
    expect(() => decodeCatalogInfo({ ...info, pcashChainId: "0x100000000" })).toThrow("pcashChainId must fit uint32");
    expect(() => decodeCatalogInfo({ ...info, status: "open" })).toThrow("unknown catalog status: open");
  });

  it.each([0, -1, 1.5])("rejects list limit %s", (limit) => {
    expect(() => encodeCatalogListQuery({ namespace: "market", limit }))
      .toThrow(`catalog limit must be a positive integer: ${limit}`);
  });

  it("binds a point read to the requested content id", () => {
    const record = decodeCatalogRecord(wire());
    expect(() => assertCatalogRecordIdentity(record, artifact.contentId.toUpperCase().replace("0X", "0x"))).not.toThrow();
    const other = `0x${"ee".repeat(32)}`;
    expect(() => assertCatalogRecordIdentity(record, other))
      .toThrow(`catalog returned record ${artifact.contentId}, which is not the requested ${other}`);
  });
});

describe("standard fungible asset metadata", () => {
  const metadata: FungibleMetadata = {
    name: "Example Coin",
    symbol: "EXC",
    decimals: 6,
    contentDigest: new Uint8Array(32).fill(7),
  };

  it("commits to the documented preimage with the byte hash", () => {
    const name = stringToBytes(metadata.name);
    const preimage = concat([
      numberToHex(name.length, { size: 2 }),
      toHex(name) as Hex,
      numberToHex(3, { size: 1 }),
      toHex(stringToBytes("EXC")) as Hex,
      numberToHex(6, { size: 1 }),
      toHex(metadata.contentDigest) as Hex,
    ]);
    expect(fungibleMetadataCommitment(metadata)).toBe(poseidonBytes(REFERENCE_FUNGIBLE_METADATA_DOMAIN, hexToBytes(preimage)));
  });

  it("requires an NFC name", () => {
    expect(() => fungibleMetadataCommitment({ ...metadata, name: "Café" })).toThrow("metadata name must be UTF-8 NFC");
    expect(fungibleMetadataCommitment({ ...metadata, name: "Café" })).toBeTypeOf("bigint");
  });

  it("bounds the name to 1..64 UTF-8 bytes", () => {
    expect(() => fungibleMetadataCommitment({ ...metadata, name: "" })).toThrow("metadata name must contain 1..64 UTF-8 bytes");
    expect(fungibleMetadataCommitment({ ...metadata, name: "a".repeat(64) })).toBeTypeOf("bigint");
    expect(() => fungibleMetadataCommitment({ ...metadata, name: "é".repeat(33) })).toThrow(/1\.\.64 UTF-8 bytes/);
  });

  it.each(["", "ABCDEFGHIJKLM", "ÉX", "A\tB"])("rejects symbol %j", (symbol) => {
    expect(() => fungibleMetadataCommitment({ ...metadata, symbol }))
      .toThrow("metadata symbol must contain 1..12 printable ASCII bytes");
  });

  it.each([-1, 19, 1.5])("rejects decimals %s", (decimals) => {
    expect(() => fungibleMetadataCommitment({ ...metadata, decimals })).toThrow("metadata decimals must be in 0..18");
  });

  it("requires a 32-byte content digest", () => {
    expect(() => fungibleMetadataCommitment({ ...metadata, contentDigest: new Uint8Array(31) }))
      .toThrow("metadata contentDigest must contain 32 bytes");
  });

  const derived = () => deriveStandardFungibleAssetFromEntropy({
    metadata,
    initialSupply: 1_000n,
    assetSecret: 13n,
  });

  it("verifies a derived descriptor and rejects one that no longer matches its asset id", () => {
    const asset = derived();
    expect(verifyAssetDescriptor(asset.descriptor)).toBe(asset.descriptor.assetId);
    expect(() => verifyAssetDescriptor({ ...asset.descriptor, initialSupply: 1_001n }))
      .toThrow("asset descriptor does not match assetId");
    expect(() => verifyAssetDescriptor({ ...asset.descriptor, assetId: 1n }))
      .toThrow("asset descriptor does not match assetId");
  });

  it("creates fresh, self-consistent assets with a defensive metadata copy", () => {
    const digest = new Uint8Array(32).fill(7);
    const first = createStandardFungibleAsset({ metadata: { ...metadata, contentDigest: digest }, initialSupply: 5n });
    const second = createStandardFungibleAsset({ metadata, initialSupply: 5n });
    expect(verifyAssetDescriptor(first.descriptor)).toBe(first.descriptor.assetId);
    expect(first.descriptor.assetId).not.toBe(second.descriptor.assetId);
    expect(first.assetSecret).not.toBe(second.assetSecret);
    digest[0] = 0;
    expect(first.metadata.contentDigest[0]).toBe(7);
  });

  it("derives an asset with zero supply, zero secret, and zero metadata commitment", () => {
    const empty = deriveStandardFungibleAssetFromEntropy({ metadata, initialSupply: 0n, assetSecret: 0n });
    expect(empty.descriptor.initialSupply).toBe(0n);
    expect(empty.descriptor.assetSecretCommitment).toBe(assetSecretCommitment(0n));
    expect(verifyAssetDescriptor(empty.descriptor)).toBe(empty.descriptor.assetId);
    const bare = { metadataCommitment: 0n, initialSupply: 0n, assetSecretCommitment: assetSecretCommitment(0n) };
    expect(standardFungibleAssetId(bare))
      .toBe(poseidon([ASSET_ID_DOMAIN, 0n, 0n, assetSecretCommitment(0n)]));
  });

  it("bounds the initial supply to five maximal asset outputs", () => {
    const maximum = 5n * ((1n << BigInt(AMOUNT_BITS)) - 1n);
    const make = (initialSupply: bigint) =>
      deriveStandardFungibleAssetFromEntropy({ metadata, initialSupply, assetSecret: 13n });
    expect(make(maximum).descriptor.initialSupply).toBe(maximum);
    expect(() => make(maximum + 1n)).toThrow("initialSupply exceeds five maximal asset outputs");
    expect(() => createStandardFungibleAsset({ metadata, initialSupply: maximum + 1n }))
      .toThrow("initialSupply exceeds five maximal asset outputs");
  });
});
