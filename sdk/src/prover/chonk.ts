import {
  BackendType,
  Barretenberg,
  CircuitKind,
  flattenChonkProofFields,
} from "@aztec-foundation/bb.js";
import { Noir } from "@noir-lang/noir_js";

import type { WitnessMap } from "../protocol/witness.ts";
import type { ChonkCircuitKind, ChonkVkArtifacts } from "../protocol/account.ts";
import { bytesToBigInt } from "../utils/bytes.ts";
import { toHex } from "../utils/hex.ts";
import { chonkVkArtifacts } from "../protocol/account.ts";

export type ChonkBackendKind = "wasm" | "wasm-worker" | "native";

export function wasmChonkBackend(options: {
  crs?: ChonkCrs;
  threads?: number;
  memoryMaximumPages?: number;
} = {}): ChonkBackend {
  const backend: ChonkBackend = { kind: "wasm", threads: options.threads ?? 1 };
  if (options.crs !== undefined) backend.crs = options.crs;
  if (options.memoryMaximumPages !== undefined) backend.memoryMaximumPages = options.memoryMaximumPages;
  return backend;
}

/** Release-pinned CRS bytes a Wasm backend loads into Barretenberg. */
export interface ChonkCrs {
  /** BN254 G1 prefix, 64 bytes per point; its length sets the SRS size. */
  bn254G1: Uint8Array;
  bn254G2: Uint8Array;
  /** Grumpkin G1 points, 64 bytes per point. */
  grumpkinG1: Uint8Array;
}

/** How to construct the Barretenberg instance for one CHONK prove. */
export interface ChonkBackend {
  kind: ChonkBackendKind;
  /** Wasm defaults to one thread; native defaults to bb.js's choice, one per core up to 16. */
  threads?: number;
  /** Required when `kind` is `native`. */
  bbPath?: string;
  /** Required when `kind` is `native`. Overrides any inherited `CRS_PATH` for the spawned bb. */
  crsPath?: string;
  /** Required when a Wasm backend creates its own Barretenberg instance. */
  crs?: ChonkCrs;
  memoryMaximumPages?: number;
}

export interface NativeChonkStep {
  name: string;
  kind: ChonkCircuitKind;
  artifact: { bytecode: string; abi: unknown };
  witnessMap: WitnessMap;
  verificationKey: Uint8Array;
}

export interface NativeChonkResult {
  proof: Uint8Array;
  hidingVerificationKey: Uint8Array;
}

export interface ComputedChonkVk extends ChonkVkArtifacts {
  bytes: Uint8Array;
}

export type ChonkProgressStep = "execute" | "prove" | "compress";

type ChonkProgressTarget =
  | { scope: "circuit"; circuit: string; circuitIndex: number; circuitCount: number }
  | { scope: "stack"; operation: string; circuitCount: number };

export interface ChonkProgress {
  step: ChonkProgressStep;
  scope: "circuit" | "stack";
  circuit?: string;
  /** The circuit's zero-based position in the stack, on circuit-scope updates. */
  circuitIndex?: number;
  /** How many circuits the stack folds, so a caller can place every update in the run. */
  circuitCount: number;
  operation?: string;
  /** Present only on the completion update for this operation. */
  durationMs?: number;
  /**
   * Barretenberg's Wasm memory size in bytes after this operation. Present only
   * on completion updates of Barretenberg operations, and only when the caller
   * supplied a `WasmMemorySampler` that returned a value.
   */
  wasmMemoryBytes?: number;
}

/** Reads Barretenberg's current Wasm memory size in bytes; undefined when unavailable. */
export type WasmMemorySampler = () => Promise<number | undefined>;

export interface ChonkStackOptions {
  onProgress?: ((progress: ChonkProgress) => void) | undefined;
  /** Prove on this caller-owned instance instead of creating and destroying one. */
  api?: Barretenberg | undefined;
  /**
   * Awaited before each Barretenberg operation's completion update; its value
   * is reported as `wasmMemoryBytes`.
   */
  sampleMemory?: WasmMemorySampler | undefined;
  /**
   * Aborting rejects with the signal's reason. A native bb process, including
   * that of a caller-owned `api`, is killed mid-command; a Wasm instance stops
   * after its current operation.
   */
  signal?: AbortSignal | undefined;
}

async function measureProgress<T>(
  step: ChonkProgressStep,
  target: ChonkProgressTarget,
  { onProgress, sampleMemory, signal }: ChonkStackOptions,
  run: () => Promise<T>,
): Promise<T> {
  signal?.throwIfAborted();
  onProgress?.({ step, ...target });
  const started = performance.now();
  let succeeded = false;
  try {
    const result = await run();
    succeeded = true;
    return result;
  } finally {
    if (onProgress !== undefined) {
      const durationMs = Math.round(performance.now() - started);
      // Only after success: a failed operation may have left the prover thread
      // unable to answer, and the last successful reading already bounds it.
      const wasmMemoryBytes = succeeded && sampleMemory !== undefined ? await sampleMemory() : undefined;
      onProgress({
        step,
        ...target,
        durationMs,
        ...(wasmMemoryBytes === undefined ? {} : { wasmMemoryBytes }),
      });
    }
  }
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

async function decodeGzip(compressed: Uint8Array): Promise<Uint8Array> {
  const owned = new Uint8Array(compressed.byteLength);
  owned.set(compressed);
  const stream = new Blob([owned]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function barretenbergOptions(backend: ChonkBackend): {
  threads?: number;
  backend: BackendType;
  bbPath?: string;
  skipSrsInit?: boolean;
  memory?: { maximum: number };
} {
  if (backend.kind === "native") {
    if (backend.bbPath === undefined) throw new Error("native CHONK backend requires bbPath");
    if (backend.crsPath === undefined) throw new Error("native CHONK backend requires crsPath");
    return {
      ...(backend.threads === undefined ? {} : { threads: backend.threads }),
      backend: BackendType.NativeUnixSocket,
      bbPath: backend.bbPath,
    };
  }
  const options: {
    threads: number;
    backend: BackendType;
    skipSrsInit: boolean;
    memory?: { maximum: number };
  } = {
    threads: backend.threads ?? 1,
    backend: backend.kind === "wasm-worker" ? BackendType.WasmWorker : BackendType.Wasm,
    // bb.js's own SRS initialization reads ~/.bb-crs and downloads missing
    // points; createChonkApi loads the backend's pinned bytes instead.
    skipSrsInit: true,
  };
  if (backend.memoryMaximumPages !== undefined) options.memory = { maximum: backend.memoryMaximumPages };
  return options;
}

const CIRCUIT_KINDS: Record<ChonkCircuitKind, CircuitKind> = {
  app: CircuitKind.App,
  kernel: CircuitKind.Kernel,
  hiding: CircuitKind.HidingKernel,
};

const CRS_POINT_BYTES = 64;

/** Load release-pinned CRS bytes into a Wasm Barretenberg started with `skipSrsInit`. */
export async function loadChonkCrs(api: Barretenberg, crs: ChonkCrs): Promise<void> {
  await api.srsInitSrs({
    pointsBuf: crs.bn254G1,
    numPoints: crs.bn254G1.length / CRS_POINT_BYTES,
    g2Point: crs.bn254G2,
  });
  await api.srsInitGrumpkinSrs({
    pointsBuf: crs.grumpkinG1,
    numPoints: crs.grumpkinG1.length / CRS_POINT_BYTES,
  });
}

async function createChonkApi(backend: ChonkBackend): Promise<Barretenberg> {
  if (backend.kind === "native") {
    if (backend.crsPath === undefined) throw new Error("native CHONK backend requires crsPath");
    // The spawned bb inherits this environment and reads its CRS only from CRS_PATH.
    process.env.CRS_PATH = backend.crsPath;
    return Barretenberg.new(barretenbergOptions(backend));
  }
  const crs = backend.crs;
  if (crs === undefined) throw new Error("Wasm CHONK backend requires the release-pinned CRS");
  const api = await Barretenberg.new(barretenbergOptions(backend));
  try {
    await loadChonkCrs(api, crs);
  } catch (error) {
    await api.destroy();
    throw error;
  }
  return api;
}

/** Derive the canonical Mega VK used both by folding and installed-rule identity. */
export async function computeChonkVk(
  name: string,
  artifact: { bytecode: string },
  kind: ChonkCircuitKind,
  backend: ChonkBackend,
): Promise<ComputedChonkVk> {
  const api = await createChonkApi(backend);
  try {
    const result = await api.chonkComputeVk({
      circuit: {
        name,
        bytecode: await decodeGzip(decodeBase64(artifact.bytecode)),
      },
      kind: CIRCUIT_KINDS[kind],
    });
    const vk = chonkVkArtifacts(result.fields.map((field) => toHex(field)), kind);
    return {
      bytes: result.bytes,
      ...vk,
    };
  } finally {
    await api.destroy();
  }
}

/**
 * Kill a native backend's bb process now. bb.js's destroy() sends SIGTERM,
 * which bb honors only after finishing its current command, such as the whole
 * of chonkProve. On the exit, bb.js fails the pending call and removes the
 * socket. This reads bb.js private state; the native abort test checks it
 * against the pinned release.
 */
function killNativeBb(api: Barretenberg): void {
  (api as unknown as { backend: { proc: { kill(signal: "SIGKILL"): boolean } | null } }).backend.proc?.kill("SIGKILL");
}

/** Prove one complete CHONK client transaction and bind its returned statement. */
export async function proveChonkStack(
  steps: readonly NativeChonkStep[],
  expectedPublicInputs: readonly bigint[],
  backend: ChonkBackend,
  options: ChonkStackOptions = {},
): Promise<NativeChonkResult> {
  // bb's Chonk rejects a stack of fewer than four circuits (Chonk::Chonk in
  // chonk/chonk.cpp). A single-rule PCASH stack has four; a sponsored transfer
  // has five because it folds two rules before the event application.
  if (steps.length < 4) throw new Error("a CHONK transaction stack requires at least four circuits");
  const { onProgress, signal } = options;
  const circuitCount = steps.length;
  const circuits = [];
  for (const [circuitIndex, step] of steps.entries()) {
    circuits.push(await measureProgress("execute", { scope: "circuit", circuit: step.name, circuitIndex, circuitCount }, { onProgress, signal }, async () => {
      const { witness } = await new Noir(step.artifact as never).execute(step.witnessMap as never);
      return {
        name: step.name,
        kind: CIRCUIT_KINDS[step.kind],
        bytecode: await decodeGzip(decodeBase64(step.artifact.bytecode)),
        witness: await decodeGzip(witness),
        verificationKey: step.verificationKey,
      };
    }));
  }

  const kinds = circuits.map((circuit) => circuit.kind);
  signal?.throwIfAborted();
  const api = options.api ?? await createChonkApi(backend);
  const stop = (): void => {
    if (backend.kind === "native") killNativeBb(api);
  };
  signal?.addEventListener("abort", stop, { once: true });
  try {
    await measureProgress("prove", { scope: "stack", operation: "start", circuitCount }, options, async () => {
      await api.chonkStart({ kinds });
    });
    for (const [circuitIndex, circuit] of circuits.entries()) {
      await measureProgress("prove", { scope: "circuit", circuit: circuit.name, circuitIndex, circuitCount }, options, async () => {
        await api.chonkLoad({
          circuit: {
            name: circuit.name,
            bytecode: circuit.bytecode,
            verificationKey: circuit.verificationKey,
          },
          kind: circuit.kind,
        });
        await api.chonkAccumulate({ witness: circuit.witness });
      });
    }
    const generated = await measureProgress("prove", { scope: "stack", operation: "finalize", circuitCount }, options, async () =>
      await api.chonkProve({}));
    const hidingVerificationKey = circuits.at(-1)!.verificationKey;
    const flattened = flattenChonkProofFields(generated.proof);
    const publicInputs = flattened.slice(0, expectedPublicInputs.length).map((field) => bytesToBigInt(field));
    if (flattened.length < expectedPublicInputs.length
      || publicInputs.some((value, index) => value !== expectedPublicInputs[index])) {
      throw new Error("CHONK proof public inputs do not match the expected transaction");
    }
    const proof = await measureProgress("compress", { scope: "stack", operation: "compress", circuitCount }, options, async () =>
      (await api.chonkCompressProof({ proof: generated.proof })).compressedProof);
    signal?.throwIfAborted();
    return { proof: proof.slice(expectedPublicInputs.length * 32), hidingVerificationKey };
  } catch (error) {
    signal?.throwIfAborted();
    throw error;
  } finally {
    signal?.removeEventListener("abort", stop);
    if (options.api === undefined) await api.destroy();
  }
}
