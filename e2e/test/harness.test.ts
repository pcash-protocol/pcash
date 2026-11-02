import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import type { RelayerResult } from "@pcash/sdk/relay";
import { HARNESS_MAX_IN_FLIGHT, HarnessL1 } from "../src/fixture/harness.ts";
import type { PcashNodeClient } from "../src/deps.ts";

const HASH_A = `0x${"aa".repeat(32)}`;
const HASH_B = `0x${"bb".repeat(32)}`;

function harness(): HarnessL1 {
  return new HarnessL1({
    privateKey: `0x${"05".repeat(32)}`,
    l1: { anvil: true, chainId: 31_337n, rpcUrl: "http://127.0.0.1:1", blockNumber: async () => 0n },
    node: {} as PcashNodeClient,
    relayNode: {} as PcashNodeClient,
    journalDirectory: join(tmpdir(), "pcash-harness-test-journal"),
    waitForRelayCopy: async () => undefined,
    record: () => undefined,
  });
}

function relayed(result: Partial<RelayerResult>): RelayerResult {
  return { submitted: true, selectedContentHashes: [], rejected: [], ...result } as RelayerResult;
}

describe("harness L1 key", () => {
  it("keeps at most the journal's in-flight limit of relays running, past a failure", async () => {
    const key = harness();
    let running = 0;
    let peak = 0;
    const finish: Array<() => void> = [];
    vi.spyOn(key.relayer, "relay").mockImplementation(async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise<void>((resolve) => finish.push(resolve));
      running -= 1;
      if (finish.length === 0 && running === 0) throw new Error("last relay failed");
      return relayed({});
    });
    const relays = Array.from({ length: HARNESS_MAX_IN_FLIGHT + 2 }, () => key.relay());
    const settled = Promise.allSettled(relays);
    while (finish.length > 0 || running > 0) {
      await new Promise((resolve) => setTimeout(resolve, 1));
      finish.shift()?.();
    }
    const results = await settled;
    expect(peak).toBe(HARNESS_MAX_IN_FLIGHT);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(HARNESS_MAX_IN_FLIGHT + 1);
    expect(results.at(-1)).toMatchObject({ status: "rejected" });
  });

  it("relays exactly the requested entries in one carrier on Anvil's calldata", async () => {
    const key = harness();
    const relay = vi.spyOn(key.relayer, "relay").mockResolvedValue(relayed({ selectedContentHashes: [HASH_B, HASH_A.toUpperCase()] }));
    await expect(key.relayExact([HASH_A, HASH_B])).resolves.toMatchObject({ submitted: true });
    expect(relay).toHaveBeenCalledWith({ daMode: "calldata", contentHashes: [HASH_A, HASH_B] });
  });

  it("returns once the node shows the outcome, while idle waits for the relay's own L1 settlement", async () => {
    const key = harness();
    let finishRelay!: (result: RelayerResult) => void;
    vi.spyOn(key.relayer, "relay").mockReturnValue(new Promise((resolve) => { finishRelay = resolve; }));
    await expect(key.relayUntil([HASH_A], async () => "accepted")).resolves.toBe("accepted");
    let idle = false;
    const draining = key.idle().then(() => { idle = true; });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(idle).toBe(false);
    finishRelay(relayed({ selectedContentHashes: [HASH_A] }));
    await draining;

    vi.spyOn(key.relayer, "relay").mockResolvedValue(relayed({ submitted: false }));
    await expect(key.relayUntil([HASH_B], () => new Promise(() => undefined))).rejects.toThrow(/did not publish/);
  });

  it("names what the relay refused instead of waiting on an entry it left behind", async () => {
    const key = harness();
    vi.spyOn(key.relayer, "relay").mockResolvedValue(relayed({
      selectedContentHashes: [HASH_A],
      rejected: [{ contentHash: HASH_B, reason: "expired" }] as RelayerResult["rejected"],
    }));
    await expect(key.relayExact([HASH_A, HASH_B])).rejects.toThrow(`${HASH_B}: expired`);
    vi.spyOn(key.relayer, "relay").mockResolvedValue(relayed({ submitted: false, selectedContentHashes: [HASH_A] }));
    await expect(key.relayExact([HASH_A])).rejects.toThrow(/did not publish/);
  });
});
