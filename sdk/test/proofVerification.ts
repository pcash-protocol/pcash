// Verify a compressed CHONK proof with the release-pinned backend, the way a
// node does: prepend the public inputs, decompress, and check the proof against
// the hiding kernel's verification key.
import { Barretenberg, BackendType, flattenChonkProofFields } from "@aztec-foundation/bb.js";
import { expect } from "vitest";
import { proverReleaseConfig } from "../src/node/nativeProver.ts";
import { field32 } from "../src/utils/bytes.ts";

export async function verifyGeneratedProof(result: { proof: Uint8Array; hidingVerificationKey: Uint8Array }, publicInputs: readonly bigint[]): Promise<void> {
  const release = proverReleaseConfig();
  process.env.CRS_PATH ??= release.crs;
  const api = await Barretenberg.new({ backend: BackendType.NativeUnixSocket, bbPath: release.bb, threads: 1 });
  try {
    const decompressed = await api.chonkDecompressProof({ compressedProof: Uint8Array.from([...publicInputs.flatMap(value => [...field32(value)]), ...result.proof]) });
    const fields = flattenChonkProofFields(decompressed.proof);
    expect(fields.slice(0, publicInputs.length).map((field) => BigInt(`0x${Buffer.from(field).toString("hex")}`))).toEqual(publicInputs);
    expect((await api.chonkVerify({ proof: decompressed.proof, vk: result.hidingVerificationKey })).valid).toBe(true);
  } finally {
    await api.destroy();
  }
}
