import { inspect } from "node:util";
import { sleep } from "@pcash/sdk/utils";

export interface EventuallyOptions<T> {
  timeoutMs?: number;
  intervalMs?: number;
  signal?: AbortSignal;
  cancellation?: () => string | null;
  describe?: (value: T) => string;
}

export class EventuallyTimeoutError extends Error {
  readonly lastObservation: unknown;

  constructor(message: string, lastObservation: unknown, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "EventuallyTimeoutError";
    this.lastObservation = lastObservation;
  }
}

export async function eventually<T>(
  description: string,
  observe: () => T | Promise<T>,
  satisfied: (observation: T) => boolean,
  options: EventuallyOptions<T> = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const intervalMs = options.intervalMs ?? 250;
  if (timeoutMs < 1 || intervalMs < 1) throw new Error("polling deadlines and intervals must be positive");
  const deadline = Date.now() + timeoutMs;
  let lastObservation: T | undefined;
  let lastError: unknown;
  do {
    const cancelled = options.cancellation?.();
    if (cancelled !== undefined && cancelled !== null) {
      throw new Error(`${description} cancelled: ${cancelled}`);
    }
    if (options.signal?.aborted === true) {
      throw options.signal.reason ?? new Error(`${description} aborted`);
    }
    try {
      lastObservation = await observe();
      lastError = undefined;
      if (satisfied(lastObservation)) return lastObservation;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() < deadline) await sleep(Math.min(intervalMs, deadline - Date.now()), options.signal);
  } while (Date.now() <= deadline);

  const rendered = lastObservation === undefined
    ? "<no successful observation>"
    : options.describe?.(lastObservation) ?? inspect(lastObservation, { depth: 5, breakLength: 120 });
  const lastFailure = lastError instanceof Error ? `; last error: ${lastError.message}` : "";
  throw new EventuallyTimeoutError(
    `timed out after ${timeoutMs}ms waiting for ${description}; last observation: ${rendered}${lastFailure}`,
    lastObservation,
    lastError,
  );
}
