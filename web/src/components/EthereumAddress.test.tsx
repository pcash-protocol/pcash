// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot, hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EthereumName, ReverseNameResult } from "@pcash/sdk/names";

const rpc = vi.hoisted(() => ({ reverseAddress: vi.fn(), resolveName: vi.fn(), getAvatar: vi.fn() }));
import { EthereumAddress } from "./EthereumAddress.tsx";
import { AddressDisplay, AddressLink, Hash } from "../routes/explorer/ui.tsx";
import { NameResolutionContext, useEthereumIdentity, useNameAddress } from "../names/useEthereumName.ts";
import { NameResolutionSession } from "../names/NameResolutionSession.ts";
import { NAME_CACHE_KEY, NAME_TTL, FAILURE_TTL, MISS_TTL } from "../names/nameCache.ts";

let session: NameResolutionSession;
let sequence = 0;
let address: string;
let identity: EthereumName;
let root: Root;
let element: HTMLDivElement;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubEnv("VITE_PCASH_MODE", "live");
  localStorage.clear();
  session = new NameResolutionSession(() => rpc, () => localStorage);
  session.setEnabled(true);
  session.queryClient.mount();
  address = `0x${(++sequence).toString(16).padStart(38, "0")}ab`;
  identity = { address: address as `0x${string}`, name: `alice${sequence}.gwei`, system: "gns" };
  rpc.reverseAddress.mockReset().mockResolvedValue({ identity, complete: true });
  rpc.resolveName.mockReset().mockResolvedValue(identity);
  rpc.getAvatar.mockReset().mockResolvedValue(null);
  element = document.createElement("div"); document.body.append(element); root = createRoot(element);
});
afterEach(async () => {
  await act(async () => root.unmount()); element.remove(); session.stop(); session.queryClient.clear(); session.queryClient.unmount();
  vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals();
});
async function flush() { await act(async () => { await vi.advanceTimersByTimeAsync(10); }); }
async function render(children: React.ReactNode) { await act(async () => root.render(<NameResolutionContext.Provider value={session}>{children}</NameResolutionContext.Provider>)); await flush(); }

describe("shared Ethereum address presentation", () => {
  it("deduplicates concurrent case-insensitive lookups, then replaces the address", async () => {
    let resolve!: (value: ReverseNameResult) => void;
    rpc.reverseAddress.mockReturnValue(new Promise<ReverseNameResult>((done) => { resolve = done; }));
    await render(<StrictMode><EthereumAddress address={address} /><EthereumAddress address={`0x${address.slice(2).toUpperCase()}`} /></StrictMode>);
    expect(element.textContent).toContain(address);
    expect(rpc.reverseAddress).toHaveBeenCalledTimes(1);
    await act(async () => resolve({ identity, complete: true })); await flush();
    expect(element.textContent).toBe(identity.name.repeat(2));
    expect(element.querySelector("span")?.title).toBe(address);
    expect(localStorage.getItem(NAME_CACHE_KEY)).toContain(identity.name);
  });

  it("preserves address navigation/copying and leaves generic hashes literal", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const hash = `0x${"de".repeat(32)}`;
    await render(<MemoryRouter><AddressLink address={address} /><AddressDisplay address={address} showAddress /><Hash value={hash} /></MemoryRouter>);
    expect(element.querySelector("a")?.getAttribute("href")).toBe(`/${address}`);
    expect(element.querySelector("a")?.textContent).toBe(identity.name);
    expect(element.textContent).toContain(address);
    expect(element.textContent).toContain(hash);
    await act(async () => element.querySelector("button")!.click());
    expect(writeText).toHaveBeenCalledWith(address);
    expect(rpc.reverseAddress).toHaveBeenCalledTimes(1);
  });

  it("expires a cached name and displays the address while refreshing", async () => {
    await render(<EthereumAddress address={address} />);
    rpc.reverseAddress.mockReturnValue(new Promise(() => undefined));
    await act(async () => { await vi.advanceTimersByTimeAsync(NAME_TTL); }); await flush();
    expect(rpc.reverseAddress).toHaveBeenCalledTimes(2);
    expect(element.textContent).toBe(address);
  });

  it("caches confirmed misses briefly and retries them on expiry", async () => {
    rpc.reverseAddress.mockResolvedValue({ identity: null, complete: true });
    await render(<EthereumAddress address={address} />);
    await render(<><EthereumAddress address={address} /><EthereumAddress address={address} /></>);
    expect(rpc.reverseAddress).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(MISS_TTL); }); await flush();
    expect(rpc.reverseAddress).toHaveBeenCalledTimes(2);
    expect(element.textContent).toBe(address.repeat(2));
  });

  it("suppresses failed attempts in memory without persisting a miss", async () => {
    rpc.reverseAddress.mockRejectedValue(new Error("offline"));
    await render(<EthereumAddress address={address} />);
    await render(<><EthereumAddress address={address} /><EthereumAddress address={address} /></>);
    expect(rpc.reverseAddress).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(NAME_CACHE_KEY)).toBeNull();
    rpc.reverseAddress.mockResolvedValue({ identity, complete: true });
    await act(async () => { await vi.advanceTimersByTimeAsync(FAILURE_TTL); }); await flush();
    expect(element.textContent).toBe(identity.name.repeat(2));
  });

  it("hydrates address markup before using the cached name", async () => {
    const errors = vi.fn();
    session.queryClient.setQueryData(["ethereum-names", `1:reverse:${address}`], { identity, expiresAt: Date.now() + NAME_TTL, failed: false });
    const tree = <NameResolutionContext.Provider value={session}><EthereumAddress address={address} /></NameResolutionContext.Provider>;
    const html = renderToString(tree);
    expect(html).toContain(address); expect(html).not.toContain(identity.name);
    await act(async () => root.unmount());
    element.innerHTML = html;
    await act(async () => { root = hydrateRoot(element, tree, { onRecoverableError: errors }); }); await flush();
    expect(errors).not.toHaveBeenCalled(); expect(element.textContent).toBe(identity.name);
    expect(rpc.reverseAddress).not.toHaveBeenCalled();
  });

  it("does no live resolution for fixtures or non-address values", async () => {
    vi.stubEnv("VITE_PCASH_MODE", "fixtures");
    await render(<EthereumAddress address={address} />);
    expect(element.textContent).toBe(address); expect(rpc.reverseAddress).not.toHaveBeenCalled();
    vi.stubEnv("VITE_PCASH_MODE", "live");
    await render(<EthereumAddress address={`0x${"ab".repeat(32)}`} />);
    expect(rpc.reverseAddress).not.toHaveBeenCalled();
  });

  it("renders names without waiting for an avatar", async () => {
    identity = { ...identity, system: "ens", name: `alice${sequence}.eth` };
    rpc.reverseAddress.mockResolvedValue({ identity, complete: true });
    rpc.getAvatar.mockRejectedValue(new Error("image offline"));
    function Identity() { return <span>{useEthereumIdentity(address).name}</span>; }
    await render(<Identity />);
    expect(element.textContent).toBe(identity.name);
  });

  it.each(["alice.eth", "alice.gwei", "alice.wei"])("resolves name inputs through the shared API: %s", async (name) => {
    function Input() { const result = useNameAddress(name); return <span>{result.state === "resolved" ? result.address : result.state}</span>; }
    await render(<Input />);
    expect(rpc.resolveName).toHaveBeenCalledWith(name);
    expect(element.textContent).toBe(address);
  });
});
