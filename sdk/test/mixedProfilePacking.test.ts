import { describe, expect, it } from "vitest";
import { privateValueProfile, type PrivateValueShape } from "../src/constants/privateValueProfiles.ts";
import { encodeBatch, decodeBatch, encodePrivateValueTransaction, WIRE_PROOF_BYTES } from "../src/protocol/codec.ts";
import { sizeClassFiller } from "../src/protocol/envelope.ts";
import { deliveryCommitment, randomArena } from "../src/protocol/transfer.ts";
import { decodePcashBlobs, encodePcashBlobs, requiredPcashBlobCount } from "../src/l1/blob.ts";
import { preferredRelayDaMode } from "../src/relay/relayer.ts";

function entry(shape: PrivateValueShape): Uint8Array {
  const profile = privateValueProfile(shape);
  const outputData = Array.from({ length: profile.outputs }, () => sizeClassFiller());
  const arena = randomArena(shape);
  const publicInputs = [1n, 2n, ...Array.from({ length: profile.inputs }, (_, i) => BigInt(i + 3)),
    ...Array(profile.outputs).fill(4n), deliveryCommitment(outputData, arena), 0n, 0n, 0n, 1000n, 0n, 0n, 0n];
  // Packing tests exercise exact structural sizes, not proof verification.
  return encodePrivateValueTransaction({ shape, publicInputs, outputData, arena, proof: new Uint8Array(WIRE_PROOF_BYTES) });
}

describe("mixed profile publication budgets", () => {
  const small = entry(0), large = entry(1);
  it("fits one L and one S in one blob using exact framing bytes", () => {
    expect(small.length).toBe(31648);
    expect(large.length).toBe(80199);
    const batch = encodeBatch([large, small], 1n, 0n);
    expect(batch.length).toBe(111922);
    expect(requiredPcashBlobCount(batch.length)).toBe(1);
    expect(decodeBatch(decodePcashBlobs(encodePcashBlobs(batch))).items).toEqual([large, small]);
  });
  it("packs nine L into six blobs and rejects ten; entries may cross blob boundaries", () => {
    const batch = encodeBatch(Array(9).fill(large), 1n, 0n);
    expect(requiredPcashBlobCount(batch.length)).toBe(6);
    expect(decodePcashBlobs(encodePcashBlobs(batch))).toEqual(batch);
    expect(() => encodePcashBlobs(encodeBatch(Array(10).fill(large), 1n, 0n))).toThrow("batch limit");
  });
  it("handles exact one-blob capacity and one byte beyond", () => {
    expect(requiredPcashBlobCount(126945)).toBe(1);
    expect(requiredPcashBlobCount(126946)).toBe(2);
  });
  it("prefers blobs for mixed L batches while keeping both carriers valid", () => {
    expect(preferredRelayDaMode([small], "auto", ["calldata", "blobs"])).toBe("auto");
    expect(preferredRelayDaMode([small, large], "auto", ["calldata", "blobs"])).toBe("blobs");
    expect(preferredRelayDaMode([large], "calldata", ["calldata", "blobs"])).toBe("calldata");
    expect(preferredRelayDaMode([large], "auto", ["calldata"])).toBe("auto");
  });
});
