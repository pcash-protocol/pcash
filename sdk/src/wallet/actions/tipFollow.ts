import type { PcashNodeClient, StatusResult } from "@pcash/sdk/clients";
import { sleep } from "@pcash/sdk/utils";

const DEFAULT_TIP_POLL_INTERVAL_MS = 2000;

interface WatchNodeTipOptions {
  intervalMs?: number;
  signal?: AbortSignal;
  /** Called when the canonical tip or the derived index cursor changes, including the first observation. */
  onTip: (status: StatusResult, previous: StatusResult | null) => void | Promise<void>;
}

function sameTip(left: StatusResult, right: StatusResult): boolean {
  return left.latestBlock === right.latestBlock
    && left.latestBlockHash.toLowerCase() === right.latestBlockHash.toLowerCase()
    && left.index.cursor?.blockNumber === right.index.cursor?.blockNumber
    && left.index.cursor?.blockHash.toLowerCase() === right.index.cursor?.blockHash.toLowerCase();
}

/**
 * Poll `pcash_status` until aborted. Invokes `onTip` on the first status and
 * whenever the canonical tip or the derived index cursor changes: the index
 * trails the commit it follows, so a reader that woke only on the tip would
 * stay one block behind what it can actually read. The node has no push
 * subscription; this is the portable tip-follow.
 */
export async function watchNodeTip(
  node: PcashNodeClient,
  options: WatchNodeTipOptions,
): Promise<void> {
  const intervalMs = options.intervalMs ?? DEFAULT_TIP_POLL_INTERVAL_MS;
  if (!Number.isFinite(intervalMs) || intervalMs < 1) {
    throw new Error("tip poll interval must be a positive number of milliseconds");
  }
  const signal = options.signal;
  let previous: StatusResult | null = null;
  while (signal === undefined || !signal.aborted) {
    const status = await node.status();
    if (previous === null || !sameTip(previous, status)) {
      await options.onTip(status, previous);
      previous = status;
    }
    if (signal?.aborted) return;
    // sleep rejects only when the signal aborts, which ends the follow.
    await sleep(intervalMs, signal).catch(() => undefined);
    if (signal?.aborted) return;
  }
}
