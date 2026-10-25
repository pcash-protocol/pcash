import { afterEach, describe, expect, it, vi } from "vitest";
import { createPublicClient } from "viem";
import { l1RpcTransport } from "../src/l1/rpcTransport.ts";

type Reply = { result: unknown } | { error: { code: number; message: string } } | { status: number } | "hang";

// The transport remembers unresponsive endpoints by URL, so each test names its own.
let scenario = 0;
function endpoints(): [string, string, string] {
  scenario += 1;
  return [`https://a${scenario}.invalid/`, `https://b${scenario}.invalid/`, `https://c${scenario}.invalid/`];
}

/** Serves each endpoint's reply and records which endpoints were asked. */
function serve(replies: Record<string, Reply>): string[] {
  const asked: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : undefined;
    const url = request?.url ?? String(input);
    asked.push(url);
    const reply = replies[url]!;
    if (reply === "hang") {
      const signal = (request?.signal ?? init?.signal)!;
      return new Promise<Response>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
    }
    if ("status" in reply) return new Response("unavailable", { status: reply.status });
    const { id } = JSON.parse(String(init?.body ?? await request!.text())) as { id: number };
    return Response.json({ jsonrpc: "2.0", id, ...reply });
  });
  return asked;
}

const read = (urls: string[], method = "eth_getTransactionReceipt") =>
  createPublicClient({ transport: l1RpcTransport(urls) }).request({ method, params: [`0x${"11".repeat(32)}`] } as never);

const pruned = { error: { code: 4444, message: "pruned history unavailable" } };

describe("l1RpcTransport", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

  it("answers from the first endpoint without asking the others", async () => {
    const [a, b] = endpoints();
    const asked = serve({ [a]: { result: "0x1" }, [b]: { result: "0x2" } });
    expect(await read([a, b])).toBe("0x1");
    expect(asked).toEqual([a]);
  });

  it("moves past an endpoint that returns an RPC error, and still prefers it", async () => {
    const [a, b] = endpoints();
    const asked = serve({ [a]: pruned, [b]: { result: "0x2" } });
    expect(await read([a, b], "eth_getLogs")).toBe("0x2");
    expect(await read([a, b], "eth_getLogs")).toBe("0x2");
    expect(asked).toEqual([a, b, a, b]);
  });

  it("moves past an endpoint that answers null, and still prefers it", async () => {
    const [a, b] = endpoints();
    const asked = serve({ [a]: { result: null }, [b]: { result: { status: "0x1" } } });
    expect(await read([a, b])).toEqual({ status: "0x1" });
    expect(await read([a, b])).toEqual({ status: "0x1" });
    expect(asked).toEqual([a, b, a, b]);
  });

  it("answers null when no endpoint has the object", async () => {
    const [a, b, c] = endpoints();
    const asked = serve({ [a]: { result: null }, [b]: { result: null }, [c]: { result: null } });
    expect(await read([a, b, c])).toBeNull();
    expect(asked).toEqual([a, b, c]);
  });

  it("answers null when one endpoint says so and the rest fail", async () => {
    const [a, b, c] = endpoints();
    serve({ [a]: pruned, [b]: { result: null }, [c]: pruned });
    expect(await read([a, b, c])).toBeNull();
  });

  it("fails with the last error when no endpoint answers", async () => {
    const [a, b] = endpoints();
    serve({ [a]: pruned, [b]: { error: { code: 4444, message: "also pruned" } } });
    await expect(read([a, b])).rejects.toThrow(/also pruned/);
  });

  it("does not ask another endpoint about a revert", async () => {
    const [a, b] = endpoints();
    const asked = serve({ [a]: { error: { code: 3, message: "execution reverted" } }, [b]: { result: "0x2" } });
    await expect(read([a, b], "eth_call")).rejects.toThrow(/execution reverted/);
    expect(asked).toEqual([a]);
  });

  it("asks an unavailable endpoint last until it has had time to recover", async () => {
    vi.useFakeTimers();
    const [a, b] = endpoints();
    const asked = serve({ [a]: { status: 503 }, [b]: { result: "0x2" } });
    expect(await read([a, b])).toBe("0x2");
    expect(await read([a, b])).toBe("0x2");
    expect(asked).toEqual([a, b, b]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await read([a, b])).toBe("0x2");
    expect(asked).toEqual([a, b, b, a, b]);
  });

  it("gives up on an endpoint that does not respond", async () => {
    vi.useFakeTimers();
    const [a, b] = endpoints();
    const asked = serve({ [a]: "hang", [b]: { result: "0x2" } });
    const first = read([a, b]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await first).toBe("0x2");
    // A new transport over the same endpoints does not wait for it again.
    expect(await read([a, b])).toBe("0x2");
    expect(asked).toEqual([a, b, b]);
  });

  it("keeps waiting for the only endpoint", async () => {
    vi.useFakeTimers();
    const [a] = endpoints();
    serve({ [a]: "hang" });
    let settled = false;
    const only = read([a]).finally(() => { settled = true; });
    only.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(only).rejects.toThrow(/took too long/);
  });
});
