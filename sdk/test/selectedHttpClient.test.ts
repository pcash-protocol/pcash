import { afterEach, expect, it, vi } from "vitest";
import { SelectedRelayHttpClient } from "../src/relay/selectedHttpClient.ts";

afterEach(() => vi.unstubAllGlobals());

it("reads the operator's quote lifetime from selected relay discovery", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
    recipient: "123", maxQuoteLifetimeSeconds: "900",
  }), { status: 200 })));
  const client = await SelectedRelayHttpClient.connect("http://127.0.0.1:9464/");
  expect(client.recipient).toBe(123n);
  expect(client.maxQuoteLifetimeSeconds).toBe(900n);
  expect(client.url).toBe("http://127.0.0.1:9464");
});

it("rejects missing or invalid quote lifetime in discovery", async () => {
  for (const maxQuoteLifetimeSeconds of [undefined, "0", "-1", "invalid"]) {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      recipient: "123", maxQuoteLifetimeSeconds,
    }), { status: 200 })));
    await expect(SelectedRelayHttpClient.connect("http://127.0.0.1:9464"))
      .rejects.toThrow("invalid selected relay info response");
  }
});
