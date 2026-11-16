// Browser-safe account readiness checks shared by wallet hosts.
//
// A user profile becomes "ready" when the synced account set holds a user
// account whose commitment matches the derived profile. Derivation on PCASH
// trails the Ethereum activation transaction, so readiness is polled; each
// poll synchronizes and checks locally.

import { sleep } from "@pcash/sdk/utils";
import type { Wallet } from "./walletClient.ts";

export interface WaitForDefaultAccountOptions {
  attempts?: number;
  intervalMs?: number;
  delay?: (milliseconds: number) => Promise<void>;
  signal?: AbortSignal;
}

/**
 * Poll for the derived account to appear, resolving false when the attempts
 * budget is exhausted or the signal aborts. Defaults: 25 attempts at 2 s.
 */
export async function waitForDefaultAccount(
  wallet: Pick<Wallet<unknown, unknown>, "defaultAccountReady">,
  options: WaitForDefaultAccountOptions = {},
): Promise<boolean> {
  const attempts = options.attempts ?? 25;
  const intervalMs = options.intervalMs ?? 2_000;
  const delay = options.delay ?? sleep;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (options.signal?.aborted) return false;
    if (await wallet.defaultAccountReady()) return true;
    if (attempt + 1 < attempts) await delay(intervalMs);
  }
  return false;
}
