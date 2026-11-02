import { afterEach, describe, expect, it, vi } from "vitest";
import { AnvilBackend, withAnvilMiningPaused } from "../src/backends/anvil.ts";
import { e2eSettings } from "../src/settings.ts";
import { LiveL1Backend } from "../src/backends/live.ts";
import type { L1Backend } from "../src/backends/types.ts";

describe("pausing Anvil mining for recording", () => {
  afterEach(() => vi.unstubAllGlobals());

  for (const initial of ["automatic", "manual", 7] as const) {
    it.each([false, true])(`restores ${initial} mining (recording throws: %s)`, async (fails) => {
      let mode: "automatic" | "manual" | number = initial;
      const calls: { method: string; params: unknown[] }[] = [];
      vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
        const { method, params } = JSON.parse(String(init.body)) as { method: string; params: unknown[] };
        calls.push({ method, params });
        let result: unknown = null;
        switch (method) {
          case "anvil_getAutomine": result = mode === "automatic"; break;
          case "anvil_getIntervalMining": result = typeof mode === "number" ? mode : null; break;
          case "evm_setAutomine":
            if (params[0]) mode = "automatic";
            else if (mode === "automatic") mode = "manual";
            break;
          case "evm_setIntervalMining":
            if (typeof params[0] !== "number") {
              return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "interval must be a number" } }));
            }
            // Anvil's setter replaces the mining mode, including automining.
            mode = params[0] === 0 ? "manual" : params[0];
            break;
          default: throw new Error(`Unexpected RPC method ${method}`);
        }
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
      }));
      const originalError = new Error("recording failed");
      const recorded = { complete: true };
      const record = vi.fn(async () => {
        expect(mode).toBe("manual");
        if (fails) throw originalError;
        return recorded;
      });

      const recording = withAnvilMiningPaused("http://anvil.test", record);
      if (fails) await expect(recording).rejects.toBe(originalError);
      else await expect(recording).resolves.toBe(recorded);

      expect(record).toHaveBeenCalledOnce();
      expect(mode).toBe(initial);
      expect(calls.slice(-2)).toEqual([
        { method: "evm_setIntervalMining", params: [typeof initial === "number" ? initial : 0] },
        { method: "evm_setAutomine", params: [initial === "automatic"] },
      ]);
    });
  }
});

describe("L1 backends", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("configures the local Anvil chain", () => {
    const anvil = new AnvilBackend(e2eSettings({}));
    expect(anvil.chainId).toBe(31_337n);
    expect(anvil.anvil).toBe(true);
    expect(new AnvilBackend(e2eSettings({ PCASH_E2E_ANVIL_SLOTS_IN_EPOCH: "1000000" })).slotsInEpoch).toBe("1000000");
    expect(new AnvilBackend(e2eSettings({ PCASH_E2E_ANVIL_CHAIN_ID: "31338" })).chainId).toBe(31_338n);
    expect(() => new AnvilBackend(e2eSettings({ PCASH_E2E_ANVIL_CHAIN_ID: "0" }))).toThrow(/positive/);
    expect(() => new AnvilBackend(e2eSettings({ PCASH_E2E_ANVIL_CHAIN_ID: "18446744073709551616" }))).toThrow(/u64/);
    expect(() => new AnvilBackend(e2eSettings({ PCASH_E2E_ANVIL_SLOTS_IN_EPOCH: "0" }))).toThrow(/positive/);
  });

  it.each([
    ["anvil/v1.7.1", 31_337n, true],
    ["Geth/v1.16.0-stable/linux-amd64/go1.24", 11_155_111n, false],
  ] as const)("recognizes a live L1 from its client (%s)", async (clientVersion, chainId, anvil) => {
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const { method } = JSON.parse(String(init.body)) as { method: string };
      const result = method === "eth_chainId" ? `0x${chainId.toString(16)}` : clientVersion;
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
    }));
    const backend: L1Backend = await LiveL1Backend.connect("https://l1.example");
    expect(backend).toMatchObject({ rpcUrl: "https://l1.example", chainId, anvil });
    // A live L1 is observed, never steered.
    expect(backend.mine).toBeUndefined();
  });
});
