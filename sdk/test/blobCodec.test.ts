// Cross-language conformance for the canonical one-value PCASH blob codec.

import { sha256 } from "@noble/hashes/sha2.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BYTES_PER_PCASH_BLOB,
  decodePcashBlobs,
  encodePcashBlobs,
  MAX_PCASH_BATCH_BYTES,
  MAX_PCASH_BATCH_BLOBS,
  requiredPcashBlobCount,
} from "../src/l1/blob.ts";

interface VectorCase {
  name: string;
  payloadLength: number;
  blobCount: number;
  blobSha256: string[];
}

interface VectorFile {
  format: string;
  payloadPattern: string;
  cases: VectorCase[];
}

const vectors: VectorFile = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../vectors/blob_codec.json", import.meta.url)), "utf8"),
);

function payload(length: number): Uint8Array {
  return Uint8Array.from({ length }, (_unused, index) => index & 0xff);
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

describe("canonical PCASH blob codec", () => {
  it("pins the shared vector format and payload generator", () => {
    expect(vectors.format).toBe("pcash-blob-codec");
    expect(vectors.payloadPattern).toBe("byte[i] = i mod 256");
  });

  it.each(vectors.cases.map((testCase) => [testCase.name, testCase] as const))(
    "matches the Rust blob digests for %s",
    (_name, testCase) => {
      const input = payload(testCase.payloadLength);
      const blobs = encodePcashBlobs(input);
      expect(blobs).toHaveLength(testCase.blobCount);
      expect(blobs.map((blob) => hex(sha256(blob)))).toEqual(testCase.blobSha256);
      expect(decodePcashBlobs(blobs)).toEqual(input);
      expect(requiredPcashBlobCount(input.length)).toBe(testCase.blobCount);
    },
  );

  it("rejects empty, oversized, nonminimal, and noncanonical encodings", () => {
    expect(() => encodePcashBlobs(new Uint8Array())).toThrow(/must not be empty/);
    expect(() => encodePcashBlobs(new Uint8Array(MAX_PCASH_BATCH_BYTES + 1))).toThrow(/limit/);

    const canonical = encodePcashBlobs(new Uint8Array([1, 2, 3]));
    expect(() =>
      decodePcashBlobs([...canonical, new Uint8Array(BYTES_PER_PCASH_BLOB)]),
    ).toThrow(/minimal/);

    const badPrefix = canonical.map((blob) => blob.slice());
    badPrefix[0]![32] = 1;
    expect(() => decodePcashBlobs(badPrefix)).toThrow(/not the canonical/);

    const badPadding = canonical.map((blob) => blob.slice());
    badPadding[0]![9] = 1;
    expect(() => decodePcashBlobs(badPadding)).toThrow(/not the canonical/);
  });

  it("uses the complete six-blob L1 transaction capacity", () => {
    expect(MAX_PCASH_BATCH_BLOBS).toBe(6);
    expect(MAX_PCASH_BATCH_BYTES).toBe(761_825);
    expect(requiredPcashBlobCount(MAX_PCASH_BATCH_BYTES)).toBe(MAX_PCASH_BATCH_BLOBS);
    expect(() => requiredPcashBlobCount(MAX_PCASH_BATCH_BYTES + 1)).toThrow(/limit/);
  });
});
