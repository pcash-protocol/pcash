import { gzipSync } from "node:zlib";
import { BBApiException, type Barretenberg } from "@aztec-foundation/bb.js";
import { describe, expect, it, vi } from "vitest";
import { type NativeChonkStep, wasmChonkBackend } from "../src/prover/chonk.ts";
import { expectRecursiveProofRejection } from "./proofRejection.ts";

vi.mock("@noir-lang/noir_js", () => ({
  Noir: class {
    async execute() { return { witness: gzipSync(Uint8Array.of(9)) }; }
  },
}));
vi.mock("@aztec-foundation/bb.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("@aztec-foundation/bb.js")>(),
  flattenChonkProofFields: () => [],
}));

const steps: NativeChonkStep[] = ([
  ["application", "app"], ["no-op event application", "app"], ["kernel", "kernel"], ["hiding kernel", "hiding"],
] as const).map(([name, kind]) => ({
  name,
  kind,
  artifact: { bytecode: gzipSync(Uint8Array.of(1)).toString("base64"), abi: {} },
  witnessMap: {}, verificationKey: new Uint8Array(),
}));
const rejection = () => new BBApiException("Failed to verify the generated proof!");
function backendApi() {
  return {
    chonkStart: vi.fn(async () => ({})),
    chonkLoad: vi.fn(async () => ({})),
    chonkAccumulate: vi.fn(async () => ({})),
    chonkProve: vi.fn(async () => ({ proof: {} })).mockRejectedValue(rejection()),
    chonkCompressProof: vi.fn(async () => ({ compressedProof: new Uint8Array() })),
  };
}
function check(api: ReturnType<typeof backendApi>) {
  return expectRecursiveProofRejection(steps, [], wasmChonkBackend(), undefined, api as unknown as Barretenberg);
}

describe("recursive proof rejection assertion", () => {
  it("accepts the pinned backend's proof verification rejection after accumulation", async () => {
    const api = backendApi();
    await check(api);
    expect(api.chonkAccumulate).toHaveBeenCalledTimes(4);
    expect(api.chonkProve).toHaveBeenCalledOnce();
  });

  it("does not count a chonkStart infrastructure error as recursive rejection", async () => {
    const api = backendApi();
    api.chonkStart.mockRejectedValueOnce(new Error("socket disconnected"));
    await expect(check(api)).rejects.toThrow("Unexpected rejection during prove/start: Error: socket disconnected");
    expect(api.chonkAccumulate).not.toHaveBeenCalled();
  });

  it("requires proof finalization even if startup reports the same diagnostic", async () => {
    const api = backendApi();
    api.chonkStart.mockRejectedValueOnce(rejection());
    await expect(check(api)).rejects.toThrow("Unexpected rejection during prove/start");
  });

  it("reports the circuit for an accumulation failure", async () => {
    const api = backendApi();
    api.chonkAccumulate.mockResolvedValueOnce({}).mockResolvedValueOnce({}).mockRejectedValueOnce(new Error("out of memory"));
    await expect(check(api)).rejects.toThrow("Unexpected rejection during prove/kernel: Error: out of memory");
    expect(api.chonkProve).not.toHaveBeenCalled();
  });

  it("rejects unrelated backend errors during finalization", async () => {
    const api = backendApi();
    api.chonkProve.mockRejectedValueOnce(new BBApiException("socket disconnected"));
    await expect(check(api)).rejects.toThrow("Unexpected rejection during prove/finalize: BBApiException: socket disconnected");
  });

  it("accepts an HN input-count mismatch only for the expected circuit and sizes", async () => {
    const diagnostic = new BBApiException("Assertion failed: (expected_io_size == vk_num_public_inputs)\n"
      + "  Actual  : 8\n  Expected: 26\n"
      + "  Reason  : process_hn_recursion_constraints: IO size mismatch with VK num_public_inputs");
    for (const expected of [
      { circuit: "kernel", actualIoSize: 8, expectedIoSize: 26 },
      { circuit: "hiding kernel", actualIoSize: 8, expectedIoSize: 26 },
      { circuit: "kernel", actualIoSize: 26, expectedIoSize: 8 },
      undefined,
    ]) {
      const api = backendApi();
      api.chonkAccumulate.mockResolvedValueOnce({}).mockResolvedValueOnce({}).mockRejectedValueOnce(diagnostic);
      const result = expectRecursiveProofRejection(steps, [], wasmChonkBackend(), expected, api as unknown as Barretenberg);
      if (expected?.circuit === "kernel" && expected.actualIoSize === 8) await result;
      else await expect(result).rejects.toThrow("Unexpected rejection during prove/kernel");
    }
  });

  it("fails if the tampered stack produces a proof", async () => {
    const api = backendApi();
    api.chonkProve.mockResolvedValueOnce({ proof: {} });
    await expect(check(api)).rejects.toThrow("Tampered recursive proof unexpectedly succeeded");
  });
});
