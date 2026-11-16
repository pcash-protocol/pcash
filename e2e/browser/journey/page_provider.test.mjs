import assert from "node:assert/strict";
import { describe, it } from "node:test";
import vm from "node:vm";
import {
  createInjectedProviderSource,
  PAGE_PROVIDER_CONTROL,
} from "./page_provider.mjs";

class StubCustomEvent {
  constructor(type, init) {
    this.type = type;
    this.detail = init?.detail;
  }
}

function install({ fetch: pageFetch } = {}) {
  // Enough of `window` for the EIP-6963 announcement the provider makes on
  // install, alongside the request proxy itself.
  const announced = [];
  const eventListeners = new Map();
  const window = {
    addEventListener(type, listener) {
      const existing = eventListeners.get(type) ?? [];
      existing.push(listener);
      eventListeners.set(type, existing);
    },
    dispatchEvent(event) {
      if (event.type === "eip6963:announceProvider") announced.push(event.detail);
      for (const listener of eventListeners.get(event.type) ?? []) listener(event);
      return true;
    },
  };
  vm.runInNewContext(
    createInjectedProviderSource({ bridgeUrl: "http://127.0.0.1:4173/request" }),
    {
      window,
      fetch: pageFetch ?? (() => { throw new Error("unexpected fetch"); }),
      CustomEvent: StubCustomEvent,
      Set, Map, Error, TypeError, Object, Array, JSON,
    },
  );
  return Object.assign(window.ethereum, { [Symbol.for("announced")]: announced, [Symbol.for("window")]: window });
}

describe("page injected provider source", () => {
  it("installs a MetaMask-shaped request proxy", async () => {
    const calls = [];
    const provider = install({
      fetch: async (url, init) => {
        calls.push({ url, init });
        return {
          ok: true,
          async json() { return { result: ["0x1111111111111111111111111111111111111111"] }; },
        };
      },
    });

    assert.equal(provider.isMetaMask, true);
    assert.deepEqual(
      await provider.request({ method: "eth_requestAccounts" }),
      ["0x1111111111111111111111111111111111111111"],
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "http://127.0.0.1:4173/request");
    assert.deepEqual(JSON.parse(calls[0].init.body), { method: "eth_requestAccounts" });
  });

  it("recreates provider RPC errors returned by the bridge", async () => {
    const provider = install({
      fetch: async () => ({
        ok: true,
        async json() {
          return { error: { code: 4001, message: "User rejected", data: { step: "derive" } } };
        },
      }),
    });

    await assert.rejects(
      provider.request({ method: "eth_signTypedData_v4", params: [] }),
      (error) => error.name === "ProviderRpcError"
        && error.code === 4001
        && error.message === "User rejected"
        && error.data.step === "derive",
    );
  });

  it("dispatches test-controlled events and removes listeners", () => {
    const provider = install();
    const accounts = [];
    const chains = [];
    const onAccounts = (value) => accounts.push(value);
    const onChain = (value) => chains.push(value);
    provider.on("accountsChanged", onAccounts);
    provider.on("chainChanged", onChain);

    assert.equal(provider[PAGE_PROVIDER_CONTROL].emit("accountsChanged", ["0x01"]), 1);
    assert.equal(provider[PAGE_PROVIDER_CONTROL].emit("chainChanged", "0x1"), 1);
    provider.removeListener("accountsChanged", onAccounts);
    assert.equal(provider[PAGE_PROVIDER_CONTROL].emit("accountsChanged", []), 0);

    assert.deepEqual(accounts, [["0x01"]]);
    assert.deepEqual(chains, ["0x1"]);
  });

  it("rejects invalid factory URLs, request shapes, and events", async () => {
    assert.throws(
      () => createInjectedProviderSource({ bridgeUrl: "javascript:alert(1)" }),
      /absolute HTTP/,
    );
    const provider = install();
    await assert.rejects(provider.request({}), (error) => error.code === -32600);
    assert.throws(() => provider.on("unsupported", () => undefined), /unsupported provider event/);
    assert.throws(
      () => provider[PAGE_PROVIDER_CONTROL].emit("unsupported", {}),
      /unsupported provider event/,
    );
  });
});

describe("EIP-6963 announcement", () => {
  it("announces itself on install and on request, with a data: icon", () => {
    const provider = install();
    const announced = provider[Symbol.for("announced")];
    const window = provider[Symbol.for("window")];

    assert.equal(announced.length, 1, "should announce once on install");
    assert.equal(announced[0].provider, provider);
    assert.match(announced[0].info.icon, /^data:image\//);
    assert.ok(announced[0].info.uuid && announced[0].info.name && announced[0].info.rdns);

    // A late-mounting discovery listener asks again; wallets must re-announce.
    window.dispatchEvent(new StubCustomEvent("eip6963:requestProvider", {}));
    assert.equal(announced.length, 2, "should re-announce on request");
  });
});
