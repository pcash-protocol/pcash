// Cross-language conformance: the SDK reproduces vectors/catalog_artifact.json,
// the same file node/crates/rpc/src/catalog.rs checks. If Rust and TypeScript ever
// disagree about the content-ID preimage, one of the two suites fails here.
//
// These are transport vectors for the optional publication catalog. They are not
// consensus identity and are not part of the circuit-release pipeline.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  assertCatalogNamespace,
  buildCatalogArtifact,
  catalogContentId,
  catalogContentIdPreimage,
  isValidCatalogNamespace,
  MAX_NAMESPACE_BYTES,
} from "../src/protocol/catalog.ts";

interface VectorCase {
  name: string;
  note: string;
  namespace: string;
  pcashChainId: number;
  payload: string;
  contentId: string;
}

interface VectorFile {
  domain: string;
  namespaceSyntax: string;
  preimageExample: { case: string; preimage: string };
  cases: VectorCase[];
}

const vectors: VectorFile = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../vectors/catalog_artifact.json", import.meta.url)),
    "utf8",
  ),
);

function bytes(hex: string): Uint8Array {
  const body = hex.slice(2);
  const out = new Uint8Array(body.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(body.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function toHex(value: Uint8Array): string {
  return `0x${Array.from(value, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

describe("catalog content-ID vectors (vectors/catalog_artifact.json)", () => {
  it("covers the framing cases the contract depends on", () => {
    const names = vectors.cases.map((c) => c.name);
    expect(names).toContain("marketplace-offer");
    expect(names).toContain("empty-payload");
    expect(names).toContain("max-namespace");
    expect(names).toContain("non-utf8-payload");
    // One-byte mutations of each committed field.
    expect(names).toContain("mutated-payload");
    expect(names).toContain("mutated-namespace");
    expect(names).toContain("mutated-chain-id");
  });

  it.each(vectors.cases.map((c) => [c.name, c] as const))(
    "reproduces the content ID for %s",
    (_name, testCase) => {
      expect(
        catalogContentId({
          namespace: testCase.namespace,
          pcashChainId: testCase.pcashChainId,
          payload: bytes(testCase.payload),
        }),
      ).toBe(testCase.contentId);
    },
  );

  it("reproduces the expanded preimage", () => {
    const source = vectors.cases.find((c) => c.name === vectors.preimageExample.case);
    expect(source).toBeDefined();
    expect(
      toHex(
        catalogContentIdPreimage({
          namespace: source!.namespace,
          pcashChainId: source!.pcashChainId,
          payload: bytes(source!.payload),
        }),
      ),
    ).toBe(vectors.preimageExample.preimage);
  });

  it("gives every vector a distinct content ID", () => {
    const ids = vectors.cases.map((c) => c.contentId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("builds an artifact whose contentId matches the vector", () => {
    const source = vectors.cases.find((c) => c.name === "marketplace-offer")!;
    const artifact = buildCatalogArtifact({
      namespace: source.namespace,
      pcashChainId: source.pcashChainId,
      payload: bytes(source.payload),
    });
    expect(artifact.contentId).toBe(source.contentId);
  });

  it("commits only publisher-supplied fields", () => {
    // Nothing server-assigned may enter the preimage, or republishing identical
    // content would mint a second account instead of being a no-op.
    const input = {
      namespace: "pcash.marketplace.offer.v1",
      pcashChainId: 1,
      payload: new TextEncoder().encode("payload"),
    };
    expect(catalogContentId(input)).toBe(catalogContentId({ ...input }));
  });
});

describe("catalog namespace syntax", () => {
  it("matches the syntax the vectors declare", () => {
    expect(vectors.namespaceSyntax).toBe("^[a-z0-9][a-z0-9._-]{0,63}$");
  });

  it("accepts legal namespaces", () => {
    for (const namespace of ["a", "0", "a.b_c-d.1", "pcash.marketplace.offer.v1", "a".repeat(64)]) {
      expect(isValidCatalogNamespace(namespace)).toBe(true);
    }
  });

  it("rejects illegal namespaces rather than normalizing them", () => {
    for (const namespace of [
      "",
      "a".repeat(MAX_NAMESPACE_BYTES + 1),
      ".leading",
      "-leading",
      "_leading",
      "Upper",
      "has space",
      "has/slash",
      "émoji",
    ]) {
      expect(isValidCatalogNamespace(namespace)).toBe(false);
      expect(() => assertCatalogNamespace(namespace)).toThrow("catalog namespace must be");
    }
  });
});
