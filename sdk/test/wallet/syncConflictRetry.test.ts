import { describe, expect, it, vi } from "vitest";
import { WalletConflictError } from "../../src/wallet/store.ts";
import { isWalletSyncConflict, retryWhileSyncConflict } from "../../src/wallet/actions/syncConflictRetry.ts";

function conflict(resources: string[]): WalletConflictError {
  return new WalletConflictError("reserved", resources);
}

describe("isWalletSyncConflict", () => {
  it("recognizes the wallet:sync resource conflict", () => {
    expect(isWalletSyncConflict(conflict(["wallet:sync"]))).toBe(true);
    expect(isWalletSyncConflict(conflict(["note:1"]))).toBe(false);
    expect(isWalletSyncConflict(new Error("other"))).toBe(false);
  });
});

describe("retryWhileSyncConflict", () => {
  it("returns without waiting when synchronization starts immediately", async () => {
    const wait = vi.fn();
    await expect(retryWhileSyncConflict(async () => "done", { wait })).resolves.toBe("done");
    expect(wait).not.toHaveBeenCalled();
  });

  it("waits for an abandoned synchronization lease to expire", async () => {
    let attempts = 0;
    let now = 0;
    const result = await retryWhileSyncConflict(async () => {
      attempts += 1;
      if (attempts < 3) throw conflict(["wallet:sync"]);
      return "resumed";
    }, {
      intervalMs: 250,
      timeoutMs: 1_000,
      now: () => now,
      wait: async (milliseconds) => { now += milliseconds; },
    });
    expect(result).toBe("resumed");
    expect(attempts).toBe(3);
    expect(now).toBe(500);
  });

  it("does not retry another wallet conflict", async () => {
    const error = conflict(["note:1"]);
    const wait = vi.fn();
    await expect(retryWhileSyncConflict(async () => { throw error; }, { wait })).rejects.toBe(error);
    expect(wait).not.toHaveBeenCalled();
  });

  it("does not retry unrelated errors", async () => {
    const error = new Error("node unreachable");
    const wait = vi.fn();
    await expect(retryWhileSyncConflict(async () => { throw error; }, { wait })).rejects.toBe(error);
    expect(wait).not.toHaveBeenCalled();
  });

  it("rethrows a synchronization conflict after the bounded wait", async () => {
    const error = conflict(["wallet:sync"]);
    let now = 0;
    let attempts = 0;
    await expect(retryWhileSyncConflict(async () => {
      attempts += 1;
      throw error;
    }, {
      intervalMs: 6,
      timeoutMs: 10,
      now: () => now,
      wait: async (milliseconds) => { now += milliseconds; },
    })).rejects.toBe(error);
    expect(attempts).toBe(3);
    expect(now).toBe(10);
  });
});
