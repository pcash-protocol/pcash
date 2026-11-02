import { describe, expect, it, vi } from "vitest";
import { assertPollingRelayerStopped } from "../src/seed/relayerPreflight.ts";

describe("rich seed relayer preflight", () => {
  it("accepts an explicit connection refusal", async () => {
    const refusal = Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" });
    const fetchImpl = vi.fn(async () => { throw new TypeError("fetch failed", { cause: refusal }); });
    await expect(assertPollingRelayerStopped("http://127.0.0.1:9464", fetchImpl)).resolves.toBeUndefined();
  });

  it("accepts the relayer's known stopped health state", async () => {
    const fetchImpl = vi.fn(async () => new Response("stopped\n", { status: 503 }));
    await expect(assertPollingRelayerStopped("http://127.0.0.1:9464/", fetchImpl)).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledWith("http://127.0.0.1:9464/health", expect.any(Object));
  });

  it("rejects running and indeterminate relayer states", async () => {
    await expect(assertPollingRelayerStopped(
      "http://127.0.0.1:9464",
      vi.fn(async () => new Response("ok\n", { status: 200 })),
    )).rejects.toThrow(/requires the continuous relayer service to be stopped/);
    await expect(assertPollingRelayerStopped(
      "http://127.0.0.1:9464",
      vi.fn(async () => new Response("unauthorized\n", { status: 401 })),
    )).rejects.toThrow(/could not establish.*HTTP 401/);
    await expect(assertPollingRelayerStopped(
      "http://127.0.0.1:9464",
      vi.fn(async () => { throw new Error("certificate expired"); }),
    )).rejects.toThrow(/could not establish.*certificate expired/);
  });
});
