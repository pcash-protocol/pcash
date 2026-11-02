import type { ProveStatus } from "@pcash/sdk/browser-prover/requests";
import { logger } from "./logger.ts";

/** Only public stage metadata and measured timings belong in these logs. */
export function logProverProgress(status: ProveStatus): void {
  if (!import.meta.env.DEV) return;
  const timing = status.durationMs === undefined ? "progress" : `measured ${status.durationMs} ms`;
  logger.context("PCASH prover").debug(`${status.message} | ${timing} | request +${status.elapsedMs} ms`, {
    phase: status.phase,
    message: status.message,
    step: status.step,
    scope: status.scope,
    circuit: status.circuit,
    // Worker and main-thread requests have separate clocks. Do not infer stage
    // durations from gaps between updates; use the measured duration instead.
    requestElapsedMs: status.elapsedMs,
    durationMs: status.durationMs,
    pageElapsedMs: Math.round(performance.now()),
  });
}

/** Includes time outside the prover, such as wallet approval and RPC waiting. */
export async function traceWalletOperation<T>(name: string, operation: () => Promise<T>): Promise<T> {
  if (!import.meta.env.DEV) return operation();
  const started = performance.now();
  logger.context("PCASH wallet").debug(`${name}: started`, {
    pageElapsedMs: Math.round(started),
    hardwareConcurrency: navigator.hardwareConcurrency,
    crossOriginIsolated: globalThis.crossOriginIsolated,
  });
  let outcome = "failed";
  try {
    const result = await operation();
    outcome = "completed";
    return result;
  } finally {
    const durationMs = Math.round(performance.now() - started);
    logger.context("PCASH wallet").debug(`${name}: ${outcome} in ${durationMs} ms`, {
      durationMs,
    });
  }
}
