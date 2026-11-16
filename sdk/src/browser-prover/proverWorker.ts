/// <reference lib="webworker" />
// In-browser PCASH prover. Runs off the UI thread in a cross-origin-isolated
// context (COOP/COEP) so @aztec-foundation/bb.js can use its
// SharedArrayBuffer-backed WASM worker threads. A request executes an ordered
// CHONK stack of two applications, a protocol kernel and a hiding kernel, and
// returns one compressed proof whose leading application public inputs are
// checked against the independently built transaction.

import {
  Barretenberg,
  BackendType,
} from "@aztec-foundation/bb.js";
import initACVM from "@noir-lang/acvm_js";
import acvmWasmUrl from "@noir-lang/acvm_js/web/acvm_js_bg.wasm?url";
import initNoirC from "@noir-lang/noirc_abi";
import noircAbiWasmUrl from "@noir-lang/noirc_abi/web/noirc_abi_wasm_bg.wasm?url";

import type { ProvePhase, ProveScope, ProveStatus, ProveStep } from "./requests.ts";
import type { ProverProfile } from "../prover/profile.ts";
import type { WitnessMap } from "../protocol/witness.ts";
import type { ChonkCircuitKind } from "../protocol/account.ts";
import { BROWSER_CRS_DATABASE, loadPinnedCrs } from "./crsCache.ts";
import { barretenbergWasmMemoryBytes } from "./wasmMemory.ts";
import {
  assertBrowserCircuit,
  fetchPinnedArtifact,
  proverCircuitId,
  readCappedBody,
  type BrowserProverAssetSource,
} from "./artifacts.ts";
import { idbRequest, idbTransactionDone } from "../utils/idb.ts";
import {
  loadChonkCrs,
  proveChonkStack,
  wasmChonkBackend,
  type ChonkCrs,
  type NativeChonkStep,
} from "../prover/index.ts";

// --- worker wire protocol --------------------------------------------------

export interface WorkerChonkStep {
  circuitUrl: string;
  vkUrl: string;
  kind: ChonkCircuitKind;
  witnessMap: WitnessMap;
  label: string;
}

export type WorkerOperationRequest =
  | { kind: "setup" }
  | {
      kind: "chonk";
      steps: WorkerChonkStep[];
      expectedPublicInputs: string[];
    };

export type WorkerRequest = WorkerOperationRequest & {
  profile: ProverProfile;
  /** Pinned sha256 per URL: protocol constants plus session-registered applications. */
  artifactDigests: Readonly<Record<string, string>>;
  /** Immutable versioned download base resolved by the main-thread connection. */
  assetSource: BrowserProverAssetSource;
};

export type WorkerResponse =
  | ({ type: "status" } & ProveStatus)
  | { type: "setup-result" }
  | { type: "chonk-result"; proof: Uint8Array }
  | { type: "error"; error: string };

// --- module state (survives across warm-session proof requests) --------------

let api: Barretenberg | null = null;
let noirRuntimeReady: Promise<void> | undefined;
let requestStart = 0;
let activeProfile: ProverProfile | undefined;

function post(msg: WorkerResponse): void {
  self.postMessage(msg);
}

function status(
  phase: ProvePhase,
  message: string,
  detail?: {
    step: ProveStep;
    scope?: ProveScope;
    circuit?: string;
    operation?: string;
    circuitIndex?: number;
    circuitCount?: number;
    durationMs?: number;
    wasmMemoryBytes?: number;
  },
): void {
  post({
    type: "status",
    phase,
    message,
    elapsedMs: Math.round(performance.now() - requestStart),
    ...(detail === undefined ? {} : detail),
  });
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    const parts = [
      `${error.name || "Error"}: ${error.message || "(no message)"}`,
      error.stack,
      error.cause === undefined ? undefined : `cause: ${String(error.cause)}`,
    ].filter((part): part is string => typeof part === "string" && part.length > 0);
    return [...new Set(parts)].join("\n");
  }
  if (typeof error === "object" && error !== null) {
    try {
      const properties = Object.fromEntries(
        Reflect.ownKeys(error).map((key) => [String(key), String(Reflect.get(error, key))]),
      );
      return `${Object.prototype.toString.call(error)} ${JSON.stringify(properties)}`;
    } catch {
      return Object.prototype.toString.call(error);
    }
  }
  return String(error);
}

/**
 * Run one operation and report what it actually took.
 *
 * Every measured step is timed around the work itself. Anything not wrapped
 * here is deliberately unattributed and shows up as the remainder, rather than
 * being folded into whichever step happened to be marked last.
 *
 * `memoryApi` names the Barretenberg instance whose Wasm memory the completion
 * status reports. It receives the operation's result, undefined on failure.
 */
async function measure<T>(
  step: ProveStep,
  circuit: string,
  run: () => Promise<T>,
  memoryApi?: (result: T | undefined) => Barretenberg | undefined,
  position?: { circuitIndex: number; circuitCount: number },
): Promise<T> {
  status("preparing", `${step} ${circuit}`, { step, circuit, ...position });
  const started = performance.now();
  let result: T | undefined;
  try {
    result = await run();
    return result;
  } catch (error) {
    throw new Error(`${step} ${circuit} failed\n${describeError(error)}`);
  } finally {
    const durationMs = Math.round(performance.now() - started);
    const wasmMemoryBytes = memoryApi === undefined
      ? undefined
      : await barretenbergWasmMemoryBytes(memoryApi(result));
    status("proving", `${step} ${circuit}`, {
      step,
      circuit,
      ...position,
      durationMs,
      ...(wasmMemoryBytes === undefined ? {} : { wasmMemoryBytes }),
    });
  }
}

/** Init the noir_js runtime WASM once (acvm + noirc_abi), via ?url wasm imports. */
function initNoirRuntime(): Promise<void> {
  noirRuntimeReady ??= Promise.all([
    initACVM({ module_or_path: fetch(acvmWasmUrl) }),
    initNoirC({ module_or_path: fetch(noircAbiWasmUrl) }),
  ]).then(() => undefined);
  return noirRuntimeReady;
}

// --- release-pinned CRS ----------------------------------------------------
//
// Barretenberg starts with bb.js's own SRS loader skipped: that loader reads
// bb.js's IndexedDB cache and downloads missing points from Aztec's CDN. The
// worker loads the pinned CRS files itself and passes their bytes to
// Barretenberg's SRS init calls. Verified files are cached here under their
// release-pin keys.

const IDB_STORE = "crs";
function idbOpen(): Promise<IDBDatabase> {
  const req = indexedDB.open(BROWSER_CRS_DATABASE, 1);
  req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
  return idbRequest(req);
}

function idbGet(db: IDBDatabase, key: string): Promise<unknown> {
  return idbRequest(db.transaction(IDB_STORE, "readonly").objectStore(IDB_STORE).get(key));
}

function idbSet(db: IDBDatabase, key: string, value: Uint8Array): Promise<void> {
  const tx = db.transaction(IDB_STORE, "readwrite");
  tx.objectStore(IDB_STORE).put(value, key);
  return idbTransactionDone(tx);
}

function idbDelete(db: IDBDatabase, key: string): Promise<void> {
  const tx = db.transaction(IDB_STORE, "readwrite");
  tx.objectStore(IDB_STORE).delete(key);
  return idbTransactionDone(tx);
}

async function fetchBytes(url: string, maxBytes: number): Promise<Uint8Array> {
  const res = await fetch(url, { credentials: "omit" });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return readCappedBody(res, maxBytes, "CRS download");
}
/**
 * Load the profile's CRS from the cache or the discovered node asset source.
 * Every file is verified against its pinned digest and any failure throws: a
 * deployment that wants browser proving must host the pinned parameters.
 */
async function loadCrs(
  profile: ProverProfile,
  digests: Readonly<Record<string, string>>,
  assetSource: BrowserProverAssetSource,
): Promise<ChonkCrs> {
  let db: IDBDatabase;
  try {
    db = await idbOpen();
  } catch (error) {
    throw new Error("cannot access the browser CRS cache", { cause: error });
  }
  try {
    return await loadPinnedCrs(profile, digests, assetSource, {
      read: (key) => idbGet(db, key),
      write: (key, value) => idbSet(db, key, value),
      remove: (key) => idbDelete(db, key),
    }, fetchBytes, () => {
      status("preparing", "loading proving parameters (first run only)…", { step: "crs" });
    });
  } finally {
    db.close();
  }
}

async function ensureApi(
  digests: Readonly<Record<string, string>>,
  assetSource: BrowserProverAssetSource,
): Promise<Barretenberg> {
  if (api) return api;
  const profile = activeProfile;
  if (profile === undefined) throw new Error("browser prover profile is not configured");
  const crs = await measure("crs", "srs", () => loadCrs(profile, digests, assetSource));
  status("preparing", "starting the proving runtime…");
  // Direct one-thread Wasm avoids a nested worker when the API is retained.
  const initialized = await measure("runtime", "barretenberg", () =>
    Barretenberg.new({
      threads: profile.threads,
      backend: profile.threads === 1 ? BackendType.Wasm : BackendType.WasmWorker,
      skipSrsInit: true,
      ...(profile.memoryMaximumPages === undefined
        ? {}
        : { memory: { maximum: profile.memoryMaximumPages } }),
    }), profile.reportWasmMemory ? (instance) => instance : undefined);
  try {
    await measure(
      "runtime",
      "barretenberg-srs",
      () => loadChonkCrs(initialized, crs),
      profile.reportWasmMemory ? () => initialized : undefined,
    );
  } catch (error) {
    await initialized.destroy();
    throw error;
  }
  api = initialized;
  return api;
}

async function destroyApi(): Promise<void> {
  const a = api;
  api = null;
  if (a) {
    try {
      await a.destroy();
    } catch {
      // Cleanup failure must not replace a completed result or the error being reported.
    }
  }
  activeProfile = undefined;
}

function configureProfile(profile: ProverProfile): void {
  if (![2 ** 18, 2 ** 19, 2 ** 20, 2 ** 21, 2 ** 22].includes(profile.srsPoints)) {
    throw new Error("browser prover SRS must be one of 2^18, 2^19, 2^20, 2^21, or 2^22");
  }
  if (!Number.isInteger(profile.threads) || profile.threads < 1 || profile.threads > 8) {
    throw new Error("browser prover threads must be an integer from 1 through 8");
  }
  if (
    activeProfile !== undefined
    && (activeProfile.srsPoints !== profile.srsPoints || activeProfile.threads !== profile.threads)
  ) {
    throw new Error("a warm browser prover cannot change SRS size or thread count");
  }
  if (activeProfile !== undefined && activeProfile.memoryMaximumPages !== profile.memoryMaximumPages) {
    throw new Error("a warm browser prover cannot change its Wasm memory ceiling");
  }
  activeProfile = profile;
}

async function fetchCircuit(
  logicalKey: string,
  digests: Readonly<Record<string, string>>,
  assetSource: BrowserProverAssetSource,
  allowNativeOnly: boolean,
): Promise<{ bytecode: string; abi: unknown }> {
  const bytes = await fetchPinnedArtifact(logicalKey, digests, assetSource, allowNativeOnly);
  return JSON.parse(new TextDecoder().decode(bytes)) as { bytecode: string; abi: unknown };
}

async function proveChonk(
  steps: WorkerChonkStep[],
  expectedPublicInputs: string[],
  digests: Readonly<Record<string, string>>,
  assetSource: BrowserProverAssetSource,
): Promise<{ proof: Uint8Array }> {
  // bb's Chonk rejects a stack of fewer than four circuits (Chonk::Chonk in
  // chonk/chonk.cpp). A single-rule PCASH stack has four; a sponsored transfer
  // has five because it folds two rules before the event application.
  if (steps.length < 4) throw new Error(`a CHONK stack needs at least four circuits, got ${steps.length}`);
  const profile = activeProfile;
  if (profile === undefined) throw new Error("browser prover profile is not configured");
  const allowNativeOnly = profile.allowNativeOnlyCircuits === true;
  const nativeSteps: NativeChonkStep[] = [];
  for (const step of steps) assertBrowserCircuit(step.circuitUrl, allowNativeOnly);
  for (const [circuitIndex, step] of steps.entries()) {
    const name = proverCircuitId(step.circuitUrl);
    const loaded = await measure("load", name, async () => {
      const [circuit, vk] = await Promise.all([
        fetchCircuit(step.circuitUrl, digests, assetSource, allowNativeOnly),
        fetchPinnedArtifact(step.vkUrl, digests, assetSource, allowNativeOnly),
      ]);
      return { circuit, vk };
    }, undefined, { circuitIndex, circuitCount: steps.length });
    nativeSteps.push({
      name,
      kind: step.kind,
      artifact: loaded.circuit,
      witnessMap: step.witnessMap,
      verificationKey: loaded.vk,
    });
  }
  const backend = wasmChonkBackend({
    threads: profile.threads,
    ...(profile.memoryMaximumPages === undefined ? {} : { memoryMaximumPages: profile.memoryMaximumPages }),
  });
  if (profile.threads > 1) backend.kind = "wasm-worker";
  const api = await ensureApi(digests, assetSource);
  const result = await proveChonkStack(
    nativeSteps,
    expectedPublicInputs.map(BigInt),
    backend,
    {
      onProgress: (progress) => {
        const stepName: ProveStep = progress.step === "compress" ? "artifacts" : progress.step;
        const target = progress.scope === "circuit"
          ? progress.circuit!
          : `chonk-${progress.operation!}`;
        status("proving", `${progress.step} ${target}`, {
          step: stepName,
          scope: progress.scope,
          ...(progress.circuit === undefined ? {} : { circuit: progress.circuit }),
          ...(progress.operation === undefined ? {} : { operation: progress.operation }),
          ...(progress.circuitIndex === undefined ? {} : { circuitIndex: progress.circuitIndex }),
          circuitCount: progress.circuitCount,
          ...(progress.durationMs === undefined ? {} : { durationMs: progress.durationMs }),
          ...(progress.wasmMemoryBytes === undefined ? {} : { wasmMemoryBytes: progress.wasmMemoryBytes }),
        });
      },
      api,
      sampleMemory: profile.reportWasmMemory ? () => barretenbergWasmMemoryBytes(api) : undefined,
    },
  );
  return { proof: result.proof };
}

// --- message loop ----------------------------------------------------------

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const req = event.data;
  requestStart = performance.now();
  void handle(req);
};

async function handle(req: WorkerRequest): Promise<void> {
  try {
    configureProfile(req.profile);
    if (!self.crossOriginIsolated) {
      throw new Error(
        "this browser context is not cross-origin isolated; the WASM prover needs COOP/COEP headers",
      );
    }
    await measure("runtime", "noir", () => initNoirRuntime());

    if (req.kind === "setup") {
      await ensureApi(req.artifactDigests, req.assetSource);
      post({ type: "setup-result" });
      if (!req.profile.reuse) await destroyApi();
      return;
    }

    if (req.kind === "chonk") {
      const r = await proveChonk(req.steps, req.expectedPublicInputs, req.artifactDigests, req.assetSource);
      post({ type: "chonk-result", proof: r.proof });
      if (!req.profile.reuse) await destroyApi();
      return;
    }

  } catch (error) {
    await destroyApi();
    post({ type: "error", error: describeError(error) });
  }
}
