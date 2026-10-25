import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  DeterministicInjectedProvider,
  FIXED_ACCOUNT,
} from "./injected_provider.mjs";
import { startInjectedProviderBridge } from "./provider_bridge.mjs";

const bridges = [];

afterEach(async () => {
  await Promise.all(bridges.splice(0).map((bridge) => bridge.close()));
});

async function request(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

describe("injected provider HTTP bridge", () => {
  it("forwards provider requests and returns JSON results", async () => {
    const provider = new DeterministicInjectedProvider();
    const bridge = await startInjectedProviderBridge(provider);
    bridges.push(bridge);

    assert.deepEqual(await request(bridge.url, { method: "eth_requestAccounts" }), {
      status: 200,
      body: { result: [FIXED_ACCOUNT] },
    });
    assert.deepEqual(await request(bridge.url, { method: "eth_chainId" }), {
      status: 200,
      body: { result: "0xaa36a7" },
    });
    assert.deepEqual(provider.requestLog, [
      { method: "eth_requestAccounts" },
      { method: "eth_chainId" },
    ]);
  });

  it("preserves injected provider error codes, messages, and data", async () => {
    const provider = new DeterministicInjectedProvider();
    provider.rejectNext("eth_requestAccounts", {
      code: 4001,
      message: "Journey rejected connect",
      data: { step: 2 },
    });
    const bridge = await startInjectedProviderBridge(provider);
    bridges.push(bridge);

    assert.deepEqual(await request(bridge.url, { method: "eth_requestAccounts" }), {
      status: 200,
      body: {
        error: { code: 4001, message: "Journey rejected connect", data: { step: 2 } },
      },
    });
  });

  it("keeps malformed and unknown HTTP requests outside the provider", async () => {
    const provider = new DeterministicInjectedProvider();
    const bridge = await startInjectedProviderBridge(provider);
    bridges.push(bridge);

    const malformed = await fetch(bridge.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not-json",
    });
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json()).error.code, -32700);
    const missing = await fetch(new URL("/missing", bridge.url));
    assert.equal(missing.status, 404);
    assert.deepEqual(provider.requestLog, []);
  });
});

