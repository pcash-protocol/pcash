import type { ProveStatus } from "@pcash/sdk/browser-prover";
import type { PerformanceScenarioId } from "../scenarios/index.ts";

export type ProverLifetime = "one-shot" | "warm";

/** One circuit's share of a proof, in proving order. */
export interface CircuitTiming {
  circuit: string;
  gates?: number;
  /** Fetching and pin-checking the compiled circuit and its VK. */
  loadMs: number;
  /** Assembling this circuit's witness on the main thread from preceding steps. */
  assembleMs: number;
  executeMs: number;
  proveMs: number;
  /** Preparing the recursion artifacts a parent consumes. */
  artifactsMs: number;
  /** Prover Wasm memory once this circuit was folded in. */
  wasmMemoryBytes?: number;
}

export interface RunTiming {
  /** Witness execution, folding, the final proof, and recursion artifacts. */
  requiredMs: number;
  /** Proving parameters: validated from cache, or downloaded on a browser's first run. */
  crsMs: number;
  crsDownloaded: boolean;
  /** Prover startup, reported by part: noir, barretenberg, barretenberg-srs. */
  runtimeMs: number;
  runtime: Record<string, number>;
  loadMs: number;
  /** Worker round trips and scheduling: measured by nothing, so shown as the remainder. */
  otherMs: number;
  wallMs: number;
  /** Wasm memory never shrinks, so the last reading is the run's peak. */
  peakWasmMemoryBytes?: number;
  circuits: CircuitTiming[];
  /** CHONK work that belongs to the whole stack: start plus the final proof. */
  stack: { proveMs: number; artifactsMs: number };
}

export interface RunResult {
  ok: boolean;
  /** Present for failed runs too, covering the steps that completed. */
  timing: RunTiming;
  proofBytes?: number;
  proofSha256?: string;
  error?: string;
  likelyOutOfMemory?: boolean;
}

export interface ScenarioReport {
  id: PerformanceScenarioId;
  label: string;
  circuits: readonly string[];
  srsPoints: number;
  gates: Record<string, number>;
  /** Building witnesses on the main thread, once per page. Not proof time. */
  prepareMs?: number;
  privateValueCommitment?: string;
  assetId?: string;
  runs: RunResult[];
  summary?: {
    succeeded: number;
    failed: number;
    requiredMs: { median: number; min: number; max: number };
    wallMs: number;
    peakWasmMemoryBytes?: number;
  };
  /** Set when the scenario could not be prepared at all. */
  error?: string;
}

export interface LabReport {
  kind: "pcash-proof-lab";
  runId: string;
  startedAt: string;
  finishedAt?: string;
  device: {
    name?: string;
    userAgent: string;
    model?: string;
    platform?: string;
    hardwareConcurrency: number;
    deviceMemoryGiB?: number;
    crossOriginIsolated: boolean;
  };
  settings: {
    proverLifetime: ProverLifetime;
    threads: number;
    memoryMaximumMiB?: number;
    runs: number;
  };
  source: {
    kind: "local" | "node";
    label: string;
    assetSetId: string;
    bundleDigest?: string;
    rpcUrl?: string;
  };
  scenarios: ScenarioReport[];
}

type Mark = Pick<ProveStatus, "step" | "scope" | "circuit" | "durationMs" | "wasmMemoryBytes">;

/**
 * Turn measurement updates into a breakdown. Only updates carrying a duration
 * count, so work nothing measured stays in the remainder instead of inflating
 * a neighbouring step.
 */
export function summarizeRun(
  marks: readonly Mark[],
  wallMs: number,
  gates: Readonly<Record<string, number>>,
  provingOrder: readonly string[],
): RunTiming {
  const byCircuit = new Map<string, CircuitTiming>();
  const stack = { proveMs: 0, artifactsMs: 0 };
  const runtime: Record<string, number> = {};
  let crsMs = 0;
  let crsDownloaded = false;
  let peakWasmMemoryBytes: number | undefined;
  for (const mark of marks) {
    if (mark.wasmMemoryBytes !== undefined) {
      peakWasmMemoryBytes = Math.max(peakWasmMemoryBytes ?? 0, mark.wasmMemoryBytes);
    }
    // The worker announces a parameter download, unlike the step's own start, without a circuit.
    if (mark.step === "crs" && mark.durationMs === undefined && mark.circuit === undefined) crsDownloaded = true;
    if (mark.step === undefined || mark.durationMs === undefined) continue;
    if (mark.step === "crs") {
      crsMs += mark.durationMs;
      continue;
    }
    if (mark.step === "runtime") {
      const part = mark.circuit ?? "other";
      runtime[part] = (runtime[part] ?? 0) + mark.durationMs;
      continue;
    }
    if (mark.scope === "stack") {
      if (mark.step === "prove") stack.proveMs += mark.durationMs;
      else if (mark.step === "artifacts") stack.artifactsMs += mark.durationMs;
      continue;
    }
    if (mark.circuit === undefined) continue;
    let entry = byCircuit.get(mark.circuit);
    if (entry === undefined) {
      entry = {
        circuit: mark.circuit,
        ...(gates[mark.circuit] === undefined ? {} : { gates: gates[mark.circuit] }),
        loadMs: 0,
        assembleMs: 0,
        executeMs: 0,
        proveMs: 0,
        artifactsMs: 0,
      };
      byCircuit.set(mark.circuit, entry);
    }
    if (mark.step === "load") entry.loadMs += mark.durationMs;
    else if (mark.step === "assemble") entry.assembleMs += mark.durationMs;
    else if (mark.step === "execute") entry.executeMs += mark.durationMs;
    else if (mark.step === "prove") {
      entry.proveMs += mark.durationMs;
      if (mark.wasmMemoryBytes !== undefined) entry.wasmMemoryBytes = mark.wasmMemoryBytes;
    } else if (mark.step === "artifacts") entry.artifactsMs += mark.durationMs;
  }
  // Kernel witness assembly is reported before the application it follows is proved.
  const position = (circuit: string) => {
    const index = provingOrder.indexOf(circuit);
    return index === -1 ? provingOrder.length : index;
  };
  const circuits = [...byCircuit.values()].sort((a, b) => position(a.circuit) - position(b.circuit));
  const sum = (pick: (entry: CircuitTiming) => number) => circuits.reduce((total, entry) => total + pick(entry), 0);
  const requiredMs = sum((entry) => entry.assembleMs + entry.executeMs + entry.proveMs + entry.artifactsMs)
    + stack.proveMs + stack.artifactsMs;
  const loadMs = sum((entry) => entry.loadMs);
  const runtimeMs = Object.values(runtime).reduce((total, value) => total + value, 0);
  return {
    requiredMs,
    crsMs,
    crsDownloaded,
    runtimeMs,
    runtime,
    loadMs,
    otherMs: Math.max(0, wallMs - crsMs - runtimeMs - loadMs - requiredMs),
    wallMs,
    ...(peakWasmMemoryBytes === undefined ? {} : { peakWasmMemoryBytes }),
    circuits,
    stack,
  };
}

/** The run a summary quotes: the successful run with the median required time. */
export function medianRun(runs: readonly RunResult[]): RunResult | undefined {
  const succeeded = runs.filter((run) => run.ok).sort((a, b) => a.timing.requiredMs - b.timing.requiredMs);
  return succeeded[Math.floor((succeeded.length - 1) / 2)];
}

export function summarizeScenario(runs: readonly RunResult[]): ScenarioReport["summary"] {
  const succeeded = runs.filter((run) => run.ok);
  const median = medianRun(runs);
  if (median === undefined) return undefined;
  const required = succeeded.map((run) => run.timing.requiredMs);
  const peaks = runs.map((run) => run.timing.peakWasmMemoryBytes).filter((value): value is number => value !== undefined);
  return {
    succeeded: succeeded.length,
    failed: runs.length - succeeded.length,
    requiredMs: { median: median.timing.requiredMs, min: Math.min(...required), max: Math.max(...required) },
    wallMs: median.timing.wallMs,
    ...(peaks.length === 0 ? {} : { peakWasmMemoryBytes: Math.max(...peaks) }),
  };
}

/** Wasm aborts on allocation failure; bb.js surfaces that as `unreachable`. */
export function looksOutOfMemory(error: string): boolean {
  return /unreachable|out of memory|memory access out of bounds|allocation failed|could not allocate|WebAssembly\.Memory/i.test(error);
}

export const seconds = (ms: number): string => `${(ms / 1_000).toFixed(1)} s`;
export const mebibytes = (bytes: number): string => `${Math.round(bytes / (1024 * 1024))} MiB`;

/** A short device label from the user agent, for tables where the full string does not fit. */
export function describeUserAgent(userAgent: string): string {
  const platform = /iPhone/.test(userAgent) ? "iPhone"
    : /iPad/.test(userAgent) ? "iPad"
    : /Android/.test(userAgent) ? "Android"
    : /Mac OS X/.test(userAgent) ? "Mac"
    : /Windows/.test(userAgent) ? "Windows"
    : /Linux/.test(userAgent) ? "Linux"
    : "Unknown";
  const browser = /Edg\//.test(userAgent) ? "Edge"
    : /CriOS|Chrome\//.test(userAgent) ? "Chrome"
    : /FxiOS|Firefox\//.test(userAgent) ? "Firefox"
    : /Safari\//.test(userAgent) ? "Safari"
    : "browser";
  return `${platform} ${browser}`;
}

export function deviceLabel(report: LabReport): string {
  return report.device.name?.trim() || report.device.model || describeUserAgent(report.device.userAgent);
}
