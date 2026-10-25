// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { browserNetwork, type NetworkProfile } from "../lib/networks.ts";

const node = vi.hoisted(() => ({ status: vi.fn() }));
vi.mock("@pcash/sdk/clients", () => ({ PcashNodeClient: class { status = node.status; } }));
import { checkRpcEndpoints, WalletSettings } from "./WalletSettings.tsx";
import { RPC_ENDPOINTS_KEY, WebsiteSettingsProvider } from "../lib/WebsiteSettings.tsx";

const GENESIS = `0x${"12".repeat(32)}`;
const network: NetworkProfile = { name: "Sepolia", pcashChainId: 7, genesisHash: GENESIS, pcashRpcUrl: "https://pcash.example", l1ChainId: 11155111, l1RpcUrls: ["https://eth.example"] };
const matching = { pcashChainId: 7, l1ChainId: 11155111n, genesisHash: GENESIS, proverAssets: { assetSetId: "assets", baseUrl: "https://pcash.example/prover/" } };
const l1ChainId = (hex: string) => vi.fn(async (_url: string) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: hex })));
let root: Root;
let element: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  node.status.mockReset().mockResolvedValue(matching);
  element = document.createElement("div"); document.body.append(element); root = createRoot(element);
});
afterEach(async () => { await act(async () => root.unmount()); element.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

const render = () => act(async () => root.render(<WebsiteSettingsProvider><WalletSettings onBack={() => undefined} /></WebsiteSettingsProvider>));
const form = () => element.querySelector<HTMLFormElement>('form[aria-label="RPC endpoints"]')!;
const addField = () => form().querySelector<HTMLInputElement>('input[aria-label="Ethereum RPC URL to add"]')!;
const type = (input: HTMLInputElement, value: string) => act(async () => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
});
/** A button by its accessible name. */
const button = (name: string) => [...form().querySelectorAll<HTMLButtonElement>("button")].find((candidate) => (candidate.getAttribute("aria-label") ?? candidate.textContent) === name);
const press = (name: string) => act(async () => button(name)!.click());
/** Each listed Ethereum RPC and whether it is on. */
const listed = () => [...form().querySelectorAll("li")].map((item) => [item.querySelector("span")!.textContent, item.querySelector('[role="switch"]')!.getAttribute("aria-checked") === "true"]);
const stored = () => JSON.parse(localStorage.getItem(RPC_ENDPOINTS_KEY) ?? "null") as unknown;
/** A deployment with two Ethereum RPCs, on a page whose reload is observable. */
function deployment() {
  vi.stubEnv("VITE_L1_RPC_URLS", "https://first.example,https://second.example");
  const defaults = browserNetwork();
  node.status.mockResolvedValue({ pcashChainId: defaults.pcashChainId, l1ChainId: BigInt(defaults.l1ChainId), genesisHash: defaults.genesisHash ?? GENESIS, proverAssets: matching.proverAssets });
  const reload = vi.fn();
  vi.stubGlobal("location", { ...window.location, reload });
  const fetch = l1ChainId(`0x${defaults.l1ChainId.toString(16)}`);
  vi.stubGlobal("fetch", fetch);
  return { reload, fetch };
}

it("accepts endpoints that serve this deployment's network", async () => {
  vi.stubGlobal("fetch", l1ChainId("0xaa36a7"));
  await expect(checkRpcEndpoints(network, { pcashRpcUrl: "https://mine.example", l1Rpcs: { added: [{ url: "https://mine.example/eth", enabled: true }], paused: [], removed: [] } })).resolves.toBeUndefined();
});

it.each([
  ["PCASH chain", { ...matching, pcashChainId: 8 }],
  ["Ethereum chain of the PCASH node", { ...matching, l1ChainId: 1n }],
  ["PCASH genesis", { ...matching, genesisHash: `0x${"13".repeat(32)}` }],
])("rejects a PCASH node with a different %s", async (_, status) => {
  node.status.mockResolvedValue(status);
  await expect(checkRpcEndpoints(network, { pcashRpcUrl: "https://other.example" })).rejects.toThrow(/different network/);
});

it("rejects a PCASH node that serves no prover assets", async () => {
  node.status.mockResolvedValue({ ...matching, proverAssets: null });
  await expect(checkRpcEndpoints(network, { pcashRpcUrl: "https://no-prover.example" })).rejects.toThrow(/does not serve prover assets/);
});

it("rejects an Ethereum RPC on a different chain and an unreachable endpoint", async () => {
  vi.stubGlobal("fetch", l1ChainId("0x1"));
  await expect(checkRpcEndpoints(network, { l1Rpcs: { added: [{ url: "https://mainnet.example", enabled: true }], paused: [], removed: [] } })).rejects.toThrow(/https:\/\/mainnet\.example serves a different chain/);
  node.status.mockRejectedValue(new TypeError("Failed to fetch"));
  await expect(checkRpcEndpoints(network, { pcashRpcUrl: "https://down.example" })).rejects.toThrow(/Could not reach the PCASH node/);
});

it("checks only the Ethereum RPCs this browser added and left on", async () => {
  const fetch = l1ChainId("0x1");
  vi.stubGlobal("fetch", fetch);
  await expect(checkRpcEndpoints(network, { l1Rpcs: { added: [{ url: "https://mainnet.example", enabled: false }], paused: [], removed: [] } })).resolves.toBeUndefined();
  expect(fetch).not.toHaveBeenCalled();
});

it("keeps the form in place and saves nothing when a check fails", async () => {
  node.status.mockResolvedValue({ ...matching, pcashChainId: 8 });
  await act(async () => root.render(<WebsiteSettingsProvider><WalletSettings onBack={() => undefined} /></WebsiteSettingsProvider>));
  const input = element.querySelector<HTMLInputElement>('form[aria-label="RPC endpoints"] input')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "https://other.example");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => element.querySelector<HTMLFormElement>('form[aria-label="RPC endpoints"]')!.requestSubmit());
  await vi.waitFor(() => expect(element.querySelector('[role="alert"]')?.textContent).toMatch(/different network/));
  expect(input.value).toBe("https://other.example");
  expect(input.disabled).toBe(false);
  expect(localStorage.getItem(RPC_ENDPOINTS_KEY)).toBeNull();
});

it.each(["response", "body"])("reenables the form without saving when the Ethereum RPC %s stalls", async (stall) => {
  vi.useFakeTimers();
  const defaults = browserNetwork();
  node.status.mockResolvedValue({ pcashChainId: defaults.pcashChainId, l1ChainId: BigInt(defaults.l1ChainId), genesisHash: defaults.genesisHash ?? GENESIS, proverAssets: matching.proverAssets });
  let signal: AbortSignal | undefined;
  vi.stubGlobal("fetch", vi.fn((_url: string, init: RequestInit) => {
    signal = init.signal!;
    if (stall === "response") {
      return new Promise<Response>((_resolve, reject) => signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }));
    }
    return Promise.resolve(new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"jsonrpc":"2.0","id":1,"result":'));
        signal!.addEventListener("abort", () => controller.error(signal!.reason), { once: true });
      },
    })));
  }));
  await act(async () => root.render(<WebsiteSettingsProvider><WalletSettings onBack={() => undefined} /></WebsiteSettingsProvider>));
  const inputs = form().querySelectorAll<HTMLInputElement>("input");
  await type(inputs[0]!, "https://mine.example");
  await type(addField(), "https://stalled.example/eth");
  const controls = () => [...form().querySelectorAll<HTMLInputElement | HTMLButtonElement>("input, button")];
  await act(async () => form().requestSubmit());
  // Saving takes the URL in the add field into the list.
  expect(listed().at(-1)).toEqual(["https://stalled.example/eth", true]);
  expect(controls().every((control) => control.disabled)).toBe(true);
  await act(async () => vi.advanceTimersByTimeAsync(59_999));
  expect(signal!.aborted).toBe(false);
  expect(form().querySelector('[role="alert"]')).toBeNull();
  await act(async () => vi.advanceTimersByTimeAsync(1));
  expect(signal!.aborted).toBe(true);
  expect(form().querySelector('[role="alert"]')?.textContent).toBe("Could not reach the Ethereum RPC at https://stalled.example/eth.");
  expect([inputs[0]!.value, addField().value]).toEqual(["https://mine.example", ""]);
  expect(listed().at(-1)).toEqual(["https://stalled.example/eth", true]);
  expect(controls().every((control) => !control.disabled)).toBe(true);
  expect(localStorage.getItem(RPC_ENDPOINTS_KEY)).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
});

it("lists the deployment's Ethereum RPCs and saves nothing when they are left as they are", async () => {
  const { reload } = deployment();
  await render();
  expect(listed()).toEqual([["https://first.example", true], ["https://second.example", true]]);
  expect(button("Remove https://first.example")).toBeUndefined();
  expect(button("Use defaults")).toBeUndefined();
  await press("Use https://first.example");
  await press("Use https://first.example");
  await act(async () => form().requestSubmit());
  await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce());
  expect(stored()).toBeNull();
});

it("keeps an RPC that is turned off in the list, and removes it only once it is off", async () => {
  const { reload, fetch } = deployment();
  await render();
  await press("Use https://first.example");
  expect(listed()).toEqual([["https://first.example", false], ["https://second.example", true]]);
  expect(button("Remove https://first.example")).toBeDefined();
  expect(button("Remove https://second.example")).toBeUndefined();
  await act(async () => form().requestSubmit());
  await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce());
  expect(stored()).toEqual({ l1Rpcs: { added: [], paused: ["https://first.example"], removed: [] } });
  // The deployment's own endpoints are not checked again.
  expect(fetch).not.toHaveBeenCalled();

  // The next visit shows the saved list, where the paused RPC can be removed or turned back on.
  await act(async () => root.unmount());
  root = createRoot(element);
  await render();
  expect(listed()).toEqual([["https://first.example", false], ["https://second.example", true]]);
  expect(button("Use defaults")).toBeDefined();
  await press("Remove https://first.example");
  expect(listed()).toEqual([["https://second.example", true]]);
  await act(async () => form().requestSubmit());
  await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(2));
  expect(stored()).toEqual({ l1Rpcs: { added: [], paused: [], removed: ["https://first.example"] } });
});

it("adds an Ethereum RPC to the end of the list after checking its chain", async () => {
  const { reload, fetch } = deployment();
  await render();
  await type(addField(), "not a url");
  await press("Add");
  expect(form().querySelector('[role="alert"]')?.textContent).toMatch(/HTTP\(S\) URL/);
  await type(addField(), "https://second.example");
  await press("Add");
  expect(form().querySelector('[role="alert"]')?.textContent).toBe("That Ethereum RPC is already in the list.");
  await type(addField(), " https://mine.example/eth ");
  await press("Add");
  expect(form().querySelector('[role="alert"]')).toBeNull();
  expect(addField().value).toBe("");
  expect(listed()).toEqual([["https://first.example", true], ["https://second.example", true], ["https://mine.example/eth", true]]);
  await act(async () => form().requestSubmit());
  await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce());
  expect(fetch.mock.calls.map(([url]) => url)).toEqual(["https://mine.example/eth"]);
  expect(stored()).toEqual({ l1Rpcs: { added: [{ url: "https://mine.example/eth", enabled: true }], paused: [], removed: [] } });
});

it("does not save a list with every Ethereum RPC off", async () => {
  const { reload } = deployment();
  await render();
  await press("Use https://first.example");
  await press("Use https://second.example");
  await act(async () => form().requestSubmit());
  expect(form().querySelector('[role="alert"]')?.textContent).toBe("Keep at least one Ethereum RPC on.");
  expect(reload).not.toHaveBeenCalled();
  expect(stored()).toBeNull();
});

it("returns to the deployment's endpoints", async () => {
  const { reload } = deployment();
  localStorage.setItem(RPC_ENDPOINTS_KEY, JSON.stringify({ l1Rpcs: { added: [{ url: "https://mine.example/eth", enabled: true }], paused: [], removed: ["https://first.example", "https://second.example"] } }));
  await render();
  expect(listed()).toEqual([["https://mine.example/eth", true]]);
  await press("Use defaults");
  await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce());
  expect(stored()).toBeNull();
});

it("keeps following the deployment's list around this browser's changes", async () => {
  deployment();
  localStorage.setItem(RPC_ENDPOINTS_KEY, JSON.stringify({ l1Rpcs: { added: [{ url: "https://mine.example/eth", enabled: false }], paused: ["https://second.example"], removed: ["https://first.example"] } }));
  // The deployment has since dropped one endpoint and gained another.
  vi.stubEnv("VITE_L1_RPC_URLS", "https://second.example,https://third.example");
  await render();
  expect(listed()).toEqual([["https://second.example", false], ["https://third.example", true], ["https://mine.example/eth", false]]);
});

it("returns a removed deployment RPC to its place when it is added back", async () => {
  const { reload, fetch } = deployment();
  localStorage.setItem(RPC_ENDPOINTS_KEY, JSON.stringify({ l1Rpcs: { added: [], paused: [], removed: ["https://first.example"] } }));
  await render();
  expect(listed()).toEqual([["https://second.example", true]]);
  await type(addField(), "https://first.example");
  await press("Add");
  expect(listed()).toEqual([["https://first.example", true], ["https://second.example", true]]);
  await act(async () => form().requestSubmit());
  await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce());
  expect(fetch).not.toHaveBeenCalled();
  expect(stored()).toBeNull();
});
