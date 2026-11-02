import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";

import { fieldToHex } from "../src/crypto/field.ts";
import { createChonkCircuitResolver } from "../src/node/chonkMaterial.ts";
import {
  CHONK_VK_LEN,
  computeChonkVkHash,
  computeCircuitVkHash,
  VK_LEN,
} from "../src/protocol/account.ts";

const bb = vi.hoisted(() => ({
  chonkComputeVk: vi.fn(),
  chonkStart: vi.fn(async () => ({})),
  chonkLoad: vi.fn(async () => ({})),
  chonkAccumulate: vi.fn(async () => ({})),
  chonkProve: vi.fn(async (): Promise<{ proof: never }> => { throw new Error("backend failed"); }),
  srsInitSrs: vi.fn(async () => ({ pointsBuf: new Uint8Array() })),
  srsInitGrumpkinSrs: vi.fn(async () => ({ dummy: 0 })),
  initSRSChonk: vi.fn(async () => { throw new Error("bb.js SRS loader is forbidden"); }),
  destroy: vi.fn(async () => undefined),
}));
const temporaryDirectories: string[] = [];

vi.mock("@aztec-foundation/bb.js", () => ({
  BackendType: { Wasm: "wasm", WasmWorker: "wasm-worker", NativeUnixSocket: "native" },
  Barretenberg: { new: vi.fn(async () => bb) },
  CircuitKind: { App: 0, Kernel: 1, HidingKernel: 2 },
  flattenChonkProofFields: vi.fn(),
}));

vi.mock("@noir-lang/noir_js", () => ({
  Noir: class {
    async execute(): Promise<{ witness: Uint8Array }> {
      return { witness: gzipSync(Uint8Array.of(9)) };
    }
  },
}));

import { Barretenberg as BarretenbergClass, CircuitKind, flattenChonkProofFields, type Barretenberg } from "@aztec-foundation/bb.js";
import {
  computeChonkVk,
  proveChonkStack,
  wasmChonkBackend,
  type ChonkCrs,
  type ChonkProgress,
  type NativeChonkStep,
} from "../src/prover/chonk.ts";

const CRS: ChonkCrs = {
  bn254G1: new Uint8Array(4 * 64).fill(1),
  bn254G2: new Uint8Array(128).fill(2),
  grumpkinG1: new Uint8Array(2 * 64).fill(3),
};

function vkFields(length: number): Uint8Array[] {
  return Array.from({ length }, (_, index) => {
    const field = new Uint8Array(32);
    field[30] = (index >> 8) & 0xff;
    field[31] = index & 0xff;
    return field;
  });
}

function artifact(): { bytecode: string } {
  return { bytecode: gzipSync(Uint8Array.of(1, 2, 3)).toString("base64") };
}

const STACK_KINDS = ["app", "kernel", "kernel", "hiding"] as const;

function stackSteps(): NativeChonkStep[] {
  return STACK_KINDS.map((kind, index) => ({
    name: `step-${index}`,
    kind,
    artifact: { ...artifact(), abi: { parameters: [], return_type: null } },
    witnessMap: {},
    verificationKey: new Uint8Array(),
  }));
}

afterEach(() => {
  vi.clearAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("CHONK verification-key material", () => {
  it("does not initialize native tooling when a precomputed VK exists", async () => {
    const root = mkdtempSync(join(tmpdir(), "pcash-chonk-material-"));
    temporaryDirectories.push(root);
    const artifacts = join(root, "artifacts");
    const keys = join(root, "vks");
    mkdirSync(artifacts);
    mkdirSync(keys);
    writeFileSync(join(artifacts, "example.json"), JSON.stringify({ bytecode: "", abi: {} }));
    writeFileSync(join(keys, "example.chonk.vk"), new Uint8Array(VK_LEN * 32));

    const resolved = await createChonkCircuitResolver({
      artifactDirectory: artifacts,
      verificationKeyDirectory: keys,
    })("example", "app");

    expect(resolved.kind).toBe("app");
    expect(resolved.verificationKey).toHaveLength(VK_LEN * 32);
  });

  it("reports sampled Wasm memory on Barretenberg completion updates only", async () => {
    const api = {
      chonkStart: vi.fn(async () => ({})),
      chonkLoad: vi.fn(async () => ({})),
      chonkAccumulate: vi.fn(async () => ({})),
      chonkProve: vi.fn(async () => ({ proof: {} })),
      chonkVerify: vi.fn(async () => { throw new Error("generated proof verification is forbidden"); }),
      chonkCompressProof: vi.fn(async () => ({ compressedProof: Uint8Array.from([...new Uint8Array(20 * 32), 1, 2, 3]) })),
      destroy: vi.fn(async () => undefined),
    } as unknown as Barretenberg;
    const publicInputs = Array.from({ length: 20 }, (_, index) => BigInt(index + 5));
    const fields = publicInputs.map((value) => {
      const field = new Uint8Array(32);
      field[31] = Number(value);
      return field;
    });
    let sampled = 0;
    const sampleMemory = vi.fn(async () => (sampled += 1) * 65_536);

    const sampledUpdates: ChonkProgress[] = [];
    vi.mocked(flattenChonkProofFields).mockReturnValue(fields);
    const { proof } = await proveChonkStack(stackSteps(), publicInputs, wasmChonkBackend(), {
      onProgress: (progress) => sampledUpdates.push(progress),
      api,
      sampleMemory,
    });
    expect(proof).toEqual(Uint8Array.of(1, 2, 3));
    const unsampledUpdates: ChonkProgress[] = [];
    await proveChonkStack(stackSteps(), publicInputs, wasmChonkBackend(), {
      onProgress: (progress) => unsampledUpdates.push(progress),
      api,
    });

    const completions = sampledUpdates.filter((progress) => progress.durationMs !== undefined);
    expect(completions.filter((progress) => progress.step === "execute")
      .every((progress) => progress.wasmMemoryBytes === undefined)).toBe(true);
    expect(completions.filter((progress) => progress.step !== "execute")
      .map((progress) => progress.wasmMemoryBytes)).toEqual([1, 2, 3, 4, 5, 6, 7].map((n) => n * 65_536));
    expect(sampledUpdates.filter((progress) => progress.durationMs === undefined)
      .every((progress) => progress.wasmMemoryBytes === undefined)).toBe(true);
    expect(unsampledUpdates.every((progress) => progress.wasmMemoryBytes === undefined)).toBe(true);
    expect(api.chonkVerify).not.toHaveBeenCalled();
  });

  it("places every progress update in the stack's fixed order", async () => {
    const api = {
      chonkStart: vi.fn(async () => ({})),
      chonkLoad: vi.fn(async () => ({})),
      chonkAccumulate: vi.fn(async () => ({})),
      chonkProve: vi.fn(async () => ({ proof: {} })),
      chonkCompressProof: vi.fn(async () => ({ compressedProof: Uint8Array.from([...new Uint8Array(20 * 32), 1, 2, 3]) })),
      destroy: vi.fn(async () => undefined),
    } as unknown as Barretenberg;
    const publicInputs = Array.from({ length: 20 }, (_, index) => BigInt(index + 5));
    vi.mocked(flattenChonkProofFields).mockReturnValue(publicInputs.map((value) => {
      const field = new Uint8Array(32);
      field[31] = Number(value);
      return field;
    }));
    const updates: ChonkProgress[] = [];
    await proveChonkStack(stackSteps(), publicInputs, wasmChonkBackend(), {
      onProgress: (progress) => updates.push(progress),
      api,
    });

    const starts = updates.filter((progress) => progress.durationMs === undefined)
      .map(({ step, circuitIndex, operation, circuitCount }) => ({ step, circuitIndex, operation, circuitCount }));
    expect(starts).toEqual([
      { step: "execute", circuitIndex: 0, operation: undefined, circuitCount: 4 },
      { step: "execute", circuitIndex: 1, operation: undefined, circuitCount: 4 },
      { step: "execute", circuitIndex: 2, operation: undefined, circuitCount: 4 },
      { step: "execute", circuitIndex: 3, operation: undefined, circuitCount: 4 },
      { step: "prove", circuitIndex: undefined, operation: "start", circuitCount: 4 },
      { step: "prove", circuitIndex: 0, operation: undefined, circuitCount: 4 },
      { step: "prove", circuitIndex: 1, operation: undefined, circuitCount: 4 },
      { step: "prove", circuitIndex: 2, operation: undefined, circuitCount: 4 },
      { step: "prove", circuitIndex: 3, operation: undefined, circuitCount: 4 },
      { step: "prove", circuitIndex: undefined, operation: "finalize", circuitCount: 4 },
      { step: "compress", circuitIndex: undefined, operation: "compress", circuitCount: 4 },
    ]);
  });

  it("starts the stack with each step's kind and loads every circuit as that kind", async () => {
    const api = {
      chonkStart: vi.fn(async () => ({})),
      chonkLoad: vi.fn(async () => ({})),
      chonkAccumulate: vi.fn(async () => ({})),
      chonkProve: vi.fn(async () => ({ proof: {} })),
      chonkCompressProof: vi.fn(async () => ({ compressedProof: Uint8Array.of(1) })),
    } as unknown as Barretenberg;
    vi.mocked(flattenChonkProofFields).mockReturnValue([]);
    await proveChonkStack(stackSteps(), [], wasmChonkBackend(), { api });

    const kinds = [CircuitKind.App, CircuitKind.Kernel, CircuitKind.Kernel, CircuitKind.HidingKernel];
    expect(api.chonkStart).toHaveBeenCalledWith({ kinds });
    expect(vi.mocked(api.chonkLoad).mock.calls.map(([request]) => request.kind)).toEqual(kinds);
  });

  it("rejects short and changed returned statements before compression", async () => {
    const api = {
      chonkStart: vi.fn(async () => ({})),
      chonkLoad: vi.fn(async () => ({})),
      chonkAccumulate: vi.fn(async () => ({})),
      chonkProve: vi.fn(async () => ({ proof: {} })),
      chonkCompressProof: vi.fn(async () => ({ compressedProof: Uint8Array.of(1) })),
    } as unknown as Barretenberg;
    const requested = Array.from({ length: 20 }, (_, index) => BigInt(index + 1));
    const fields = requested.map((value) => {
      const field = new Uint8Array(32);
      field[31] = Number(value);
      return field;
    });
    for (const returned of [fields.slice(1), fields.slice(0, -1), [fields[0]!, ...fields.slice(0, -1)]]) {
      vi.mocked(flattenChonkProofFields).mockReturnValue(returned);
      await expect(proveChonkStack(stackSteps(), requested, wasmChonkBackend(), { api })).rejects.toThrow(
        /public inputs do not match/,
      );
    }
    expect(api.chonkCompressProof).not.toHaveBeenCalled();
  });

  it("stops an aborted Wasm proof before its next operation and rejects with the abort reason", async () => {
    const controller = new AbortController();
    const reason = new Error("proof canceled");
    const api = {
      chonkStart: vi.fn(async () => {
        controller.abort(reason);
        return {};
      }),
      chonkLoad: vi.fn(async () => ({})),
      chonkAccumulate: vi.fn(async () => ({})),
    } as unknown as Barretenberg;
    await expect(proveChonkStack(stackSteps(), [], wasmChonkBackend(), { api, signal: controller.signal }))
      .rejects.toBe(reason);
    expect(api.chonkLoad).not.toHaveBeenCalled();
  });

  it("propagates a backend failure and destroys an owned backend", async () => {
    await expect(proveChonkStack(
      stackSteps(), Array.from({ length: 20 }, () => 0n), wasmChonkBackend({ crs: CRS }),
    )).rejects.toThrow("backend failed");
    expect(bb.destroy).toHaveBeenCalledOnce();
  });

  it("loads only the backend's CRS bytes into an owned Wasm instance", async () => {
    await expect(proveChonkStack(
      stackSteps(), [], { ...wasmChonkBackend({ crs: CRS, threads: 2 }), kind: "wasm-worker" },
    )).rejects.toThrow("backend failed");

    expect(BarretenbergClass.new).toHaveBeenCalledWith({ threads: 2, backend: "wasm-worker", skipSrsInit: true });
    expect(bb.srsInitSrs).toHaveBeenCalledWith({ pointsBuf: CRS.bn254G1, numPoints: 4, g2Point: CRS.bn254G2 });
    expect(bb.srsInitGrumpkinSrs).toHaveBeenCalledWith({ pointsBuf: CRS.grumpkinG1, numPoints: 2 });
    expect(bb.initSRSChonk).not.toHaveBeenCalled();
  });

  it("rejects an owned Wasm instance without the pinned CRS", async () => {
    await expect(proveChonkStack(stackSteps(), [], wasmChonkBackend()))
      .rejects.toThrow("Wasm CHONK backend requires the release-pinned CRS");
    expect(BarretenbergClass.new).not.toHaveBeenCalled();
  });

  it("destroys the instance when the pinned CRS cannot be loaded", async () => {
    bb.srsInitSrs.mockRejectedValueOnce(new Error("bad points"));
    await expect(computeChonkVk("example", artifact(), "app", wasmChonkBackend({ crs: CRS })))
      .rejects.toThrow("bad points");
    expect(bb.destroy).toHaveBeenCalledOnce();
    expect(bb.chonkComputeVk).not.toHaveBeenCalled();
  });

  it.each([
    { kind: "app", circuitKind: CircuitKind.App, length: VK_LEN, hash: computeCircuitVkHash },
    { kind: "kernel", circuitKind: CircuitKind.Kernel, length: VK_LEN, hash: computeCircuitVkHash },
    { kind: "hiding", circuitKind: CircuitKind.HidingKernel, length: CHONK_VK_LEN, hash: computeChonkVkHash },
  ] as const)("computes and hashes a $kind VK", async ({ kind, circuitKind, length, hash }) => {
    const fields = vkFields(length);
    bb.chonkComputeVk.mockResolvedValueOnce({
      fields,
      bytes: new Uint8Array(length * 32),
    });

    const result = await computeChonkVk("example", artifact(), kind, wasmChonkBackend({ crs: CRS }));

    expect(bb.chonkComputeVk).toHaveBeenCalledWith(expect.objectContaining({ kind: circuitKind }));
    expect(result.vkFields).toHaveLength(length);
    expect(result.vkHash).toBe(fieldToHex(hash(result.vkFields)));
    expect(bb.destroy).toHaveBeenCalledOnce();
  });
});
