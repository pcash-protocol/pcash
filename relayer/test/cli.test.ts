import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { parseRelayerHttpArgs } from "../src/cli/args.ts";
import { RelayerHttpClient, RelayerHttpError } from "../src/cli/client.ts";
import { runRelayerHttpCli } from "../src/cli/run.ts";

afterEach(() => vi.restoreAllMocks());

describe("relayer HTTP CLI", () => {
  it("bounds a response that sends a partial body and never finishes", async () => {
    let sentBody = false;
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"state":');
      sentBody = true;
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("missing listener");
    const url = `http://127.0.0.1:${address.port}`;
    try {
      await expect(new RelayerHttpClient(url, 200).request("status"))
        .rejects.toThrow(`${url}/status failed: timed out after 200 ms`);
      expect(sentBody).toBe(true);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("parses commands and the canonical server URL", () => {
    expect(parseRelayerHttpArgs(["status"], {})).toEqual({
      command: "status",
      relayerUrl: "http://127.0.0.1:9464",
      json: false,
    });
    expect(parseRelayerHttpArgs(["status", "--json"], {
      PCASH_RELAYER_URL: "https://relayer.example/operator/",
    })).toEqual({
      command: "status",
      relayerUrl: "https://relayer.example/operator",
      json: true,
    });
    expect(() => parseRelayerHttpArgs(["metrics", "--json"], {})).toThrow(/only for status/);
    expect(() => parseRelayerHttpArgs(["relay"], {})).toThrow(/unknown command/);
  });

  it("calls the operator HTTP endpoints and preserves their formats", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ state: "idle" })))
      .mockResolvedValueOnce(new Response("ok\n"))
      .mockResolvedValueOnce(new Response("pcash_relayer_up 1\n"));
    const client = new RelayerHttpClient("http://127.0.0.1:9464/");
    await expect(client.request("status")).resolves.toEqual({ state: "idle" });
    await expect(client.request("health")).resolves.toBe("ok\n");
    await expect(client.request("metrics")).resolves.toBe("pcash_relayer_up 1\n");
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "http://127.0.0.1:9464/status",
      "http://127.0.0.1:9464/health",
      "http://127.0.0.1:9464/metrics",
    ]);
  });

  it("reports unhealthy and unreachable services", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("stopped\n", { status: 503 }));
    await expect(new RelayerHttpClient("http://relayer.test").request("health"))
      .rejects.toEqual(expect.objectContaining<Partial<RelayerHttpError>>({
        name: "RelayerHttpError",
        status: 503,
        message: "stopped",
      }));

    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(new RelayerHttpClient("http://relayer.test").request("status"))
      .rejects.toThrow(/http:\/\/relayer\.test\/status failed: fetch failed/);
  });

  it("formats status through the executable runner", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ state: "idle" })));
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await expect(runRelayerHttpCli(["status", "--json"], {})).resolves.toBe(0);
    expect(stdout).toHaveBeenCalledWith('{"state":"idle"}\n');
  });
});
