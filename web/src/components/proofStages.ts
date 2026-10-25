import type { ProveStatus } from "@pcash/sdk/browser-prover/requests";

/**
 * Operations that take about the same time on one device. A CHONK stack of N
 * circuits runs them in a fixed order: load each circuit, run each, start
 * folding, fold each, finalize, compress, so 3N + 3 operations.
 */
export type ProofStageKind = "load" | "execute" | "start" | "fold" | "finalize" | "compress";

export interface ProofStage {
  kind: ProofStageKind;
  /** Zero-based position among the run's operations. */
  index: number;
  count: number;
  circuitCount: number;
  circuitIndex?: number;
  /** The update reports this operation finished, not started. */
  completed: boolean;
}

/** Where a prover update sits in its stack; undefined for updates that belong to no stack. */
export function proofStage(status: ProveStatus | undefined): ProofStage | undefined {
  const circuitCount = status?.circuitCount;
  if (status === undefined || circuitCount === undefined) return undefined;
  const at = (kind: ProofStageKind, index: number, circuitIndex?: number): ProofStage => ({
    kind,
    index,
    count: 3 * circuitCount + 3,
    circuitCount,
    ...(circuitIndex === undefined ? {} : { circuitIndex }),
    completed: status.durationMs !== undefined,
  });
  if (status.scope === "stack") {
    if (status.operation === "start") return at("start", 2 * circuitCount);
    if (status.operation === "finalize") return at("finalize", 3 * circuitCount + 1);
    if (status.operation === "compress") return at("compress", 3 * circuitCount + 2);
    return undefined;
  }
  const circuit = status.circuitIndex;
  if (circuit === undefined) return undefined;
  if (status.step === "load") return at("load", circuit, circuit);
  if (status.step === "execute") return at("execute", circuitCount + circuit, circuit);
  if (status.step === "prove") return at("fold", 2 * circuitCount + 1 + circuit, circuit);
  return undefined;
}

/** First-run guesses, replaced by this device's own measurements after one proof. */
const DEFAULT_DURATION_MS: Record<ProofStageKind, number> = {
  load: 150,
  execute: 600,
  start: 300,
  fold: 1_500,
  finalize: 9_000,
  compress: 1_200,
};

const TIMINGS_KEY = "pcash:proof-timings";

export type ProofTimings = Readonly<Record<string, number>>;

/** Stack-wide work depends on the stack's size; per-circuit work is averaged across circuits. */
function timingKey(kind: ProofStageKind, circuitCount: number): string {
  return kind === "start" || kind === "finalize" || kind === "compress" ? `${kind}:${circuitCount}` : kind;
}

function browserStorage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

/** This device's measured operation durations; empty when storage is unavailable. */
export function readProofTimings(storage: Storage | undefined = browserStorage()): ProofTimings {
  try {
    const saved: unknown = JSON.parse(storage?.getItem(TIMINGS_KEY) ?? "{}");
    if (saved === null || typeof saved !== "object") return {};
    return Object.fromEntries(Object.entries(saved).filter((entry): entry is [string, number] =>
      typeof entry[1] === "number" && Number.isFinite(entry[1]) && entry[1] >= 0));
  } catch {
    return {};
  }
}

/**
 * Folds a completed operation's measured duration into this device's timings.
 * Call it where a prover's updates arrive, before any state update: React may
 * render only the last of several updates that arrive together.
 */
export function recordProofTiming(status: ProveStatus, storage: Storage | undefined = browserStorage()): void {
  const stage = proofStage(status);
  if (stage === undefined || status.durationMs === undefined) return;
  const key = timingKey(stage.kind, stage.circuitCount);
  const timings = readProofTimings(storage);
  const previous = timings[key];
  const next = previous === undefined ? status.durationMs : Math.round((previous + status.durationMs) / 2);
  try {
    storage?.setItem(TIMINGS_KEY, JSON.stringify({ ...timings, [key]: next }));
  } catch {
    // A full or blocked store only costs the estimate.
  }
}

function plan(circuitCount: number): ProofStageKind[] {
  const each = (kind: ProofStageKind) => Array.from({ length: circuitCount }, () => kind);
  return [...each("load"), ...each("execute"), "start", ...each("fold"), "finalize", "compress"];
}

export interface ProofCompletion {
  /** Share of the expected work done, below 1 until the proof completes. */
  fraction: number;
  /** Present when every operation's duration comes from this device and the current one is within it. */
  remainingMs?: number;
}

/** Work done so far, given the latest update and how long ago it arrived. */
export function proofCompletion(stage: ProofStage, sinceUpdateMs: number, timings: ProofTimings): ProofCompletion {
  const kinds = plan(stage.circuitCount);
  const expected = (kind: ProofStageKind) => timings[timingKey(kind, stage.circuitCount)] ?? DEFAULT_DURATION_MS[kind];
  const sum = (part: readonly ProofStageKind[]) => part.reduce((total, kind) => total + expected(kind), 0);
  const total = sum(kinds);
  const current = expected(kinds[stage.index]!);
  const overrun = !stage.completed && sinceUpdateMs > current;
  const done = sum(kinds.slice(0, stage.index)) + (stage.completed ? current : Math.min(sinceUpdateMs, current * 0.95));
  const fraction = Math.min(done / total, 0.97);
  const measured = kinds.every((kind) => timings[timingKey(kind, stage.circuitCount)] !== undefined);
  return measured && !overrun ? { fraction, remainingMs: Math.max(total - done, 0) } : { fraction };
}
