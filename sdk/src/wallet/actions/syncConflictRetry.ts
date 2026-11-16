// Bounded retry for the wallet-state conflict that guards synchronization.
// Cross-tab contention on the scan lease is transient by construction: the
// holder either finishes and releases or its reservation expires, so waiting
// out the conflict beats surfacing it to the user.

import { sleep } from "@pcash/sdk/utils";
import { WalletConflictError } from "../store.ts";

const DEFAULT_RETRY_INTERVAL_MS = 250;
const DEFAULT_RETRY_TIMEOUT_MS = 35_000;

/** True when the failure is the persistence conflict guarding wallet:sync. */
export function isWalletSyncConflict(cause: unknown): boolean {
  return cause instanceof WalletConflictError
    && Array.isArray(cause.resources)
    && cause.resources.includes("wallet:sync");
}

/**
 * Run an operation, retrying only while it fails with the wallet:sync
 * persistence conflict. Any other error, or a conflict still failing at the
 * deadline, propagates immediately.
 */
export async function retryWhileSyncConflict<T>(
  operation: () => Promise<T>,
  options: {
    intervalMs?: number;
    timeoutMs?: number;
    now?: () => number;
    wait?: (milliseconds: number) => Promise<void>;
  } = {},
): Promise<T> {
  const intervalMs = options.intervalMs ?? DEFAULT_RETRY_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_RETRY_TIMEOUT_MS;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) throw new Error("wallet sync retry interval must be positive");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("wallet sync retry timeout must be positive");
  const now = options.now ?? Date.now;
  const wait = options.wait ?? sleep;
  const deadline = now() + timeoutMs;
  while (true) {
    try {
      return await operation();
    } catch (cause) {
      if (!isWalletSyncConflict(cause) || now() >= deadline) throw cause;
      await wait(Math.min(intervalMs, Math.max(1, deadline - now())));
    }
  }
}
