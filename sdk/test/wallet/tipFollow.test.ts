import { getEventListeners } from "node:events";
import { describe, expect, it } from "vitest";
import { watchNodeTip } from "../../src/wallet/actions/tipFollow.ts";
import type { StatusResult } from "@pcash/sdk/clients";
import { testStatus } from "./statusFixture.ts";

function status(block: bigint, hash: string): StatusResult {
  return testStatus({
    latestBlock: block,
    latestBlockHash: hash,
    finalizedBlockHash: hash,
    latestL1BlockHash: hash,
    finalizedL1BlockHash: hash,
    stateRoot: hash,
    l1OriginRoot: hash,
    historyRoot: hash,
    genesisHash: hash,
    genesisL1BlockHash: hash,
    acceptedTransactionTypes: [],
    acceptedBatchVersions: [],
  });
}

describe("watchNodeTip", () => {
  it("emits the first tip and later hash changes, then stops on abort", async () => {
    const hash = `0x${"11".repeat(32)}`;
    const next = `0x${"22".repeat(32)}`;
    const sequence = [status(1n, hash), status(1n, hash), status(2n, next)];
    let i = 0;
    const node = {
      status: async () => {
        const current = sequence[Math.min(i, sequence.length - 1)]!;
        i += 1;
        return current;
      },
    };
    const seen: bigint[] = [];
    const ac = new AbortController();
    const run = watchNodeTip(node as never, {
      intervalMs: 5,
      signal: ac.signal,
      onTip: (s) => {
        seen.push(s.latestBlock);
        if (seen.length >= 2) ac.abort();
      },
    });
    await run;
    expect(seen).toEqual([1n, 2n]);
  });

  it("removes each abort listener after a completed poll interval", async () => {
    const hash = `0x${"33".repeat(32)}`;
    const ac = new AbortController();
    let polls = 0;
    const node = {
      status: async () => {
        polls += 1;
        if (polls === 15) {
          expect(getEventListeners(ac.signal, "abort")).toHaveLength(0);
          ac.abort();
        }
        return status(1n, hash);
      },
    };

    await watchNodeTip(node as never, {
      intervalMs: 1,
      signal: ac.signal,
      onTip: () => undefined,
    });
    expect(polls).toBe(15);
  });
});
