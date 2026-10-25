// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NameResolutionSession } from "./NameResolutionSession.ts";
import { NAME_CACHE_KEY } from "./nameCache.ts";
import type { EthereumName } from "@pcash/sdk/names";

const address = "0x1234567890123456789012345678901234567890";
const identity: EthereumName = { address, name: "alice.eth", system: "ens" };
beforeEach(() => localStorage.clear());
function fixture() {
  const rpc = { reverseAddress: vi.fn(), resolveName: vi.fn(), getAvatar: vi.fn() };
  const factory = vi.fn((_signal: AbortSignal) => rpc);
  const session = new NameResolutionSession(factory, () => localStorage);
  return { session, factory, rpc };
}

describe("name resolution privacy", () => {
  it("starts with resolution disabled until explicitly enabled", () => {
    const { session, factory } = fixture();
    expect(session.getSnapshot().enabled).toBe(false);
    expect(factory).not.toHaveBeenCalled();
    session.setEnabled(true);
    expect(session.getSnapshot().resolver).toBeDefined();
    session.stop();
  });

  it.each([identity, null])("erases successful lookups and misses on privacy/session reset: %j", (result) => {
    const { session, factory } = fixture();
    session.setEnabled(true);
    session.cache.write(`1:reverse:${address}`, { identity: result, complete: true });
    session.queryClient.setQueryData(["ethereum-names", address], result);
    const signal = factory.mock.calls[0]![0];
    session.setEnabled(false);
    expect(signal.aborted).toBe(true);
    expect(session.getSnapshot().resolver).toBeUndefined();
    expect(session.cache.read(`1:reverse:${address}`)).toBeUndefined();
    expect(localStorage.getItem(NAME_CACHE_KEY)).toBeNull();
    expect(session.queryClient.getQueryCache().getAll()).toEqual([]);
    session.setEnabled(true);
    session.cache.write("another", { identity: null, complete: true });
    expect(localStorage.getItem(NAME_CACHE_KEY)).not.toContain(address);
    session.stop();
  });

  it("rejects pending and retained resolver calls after permission is revoked", async () => {
    const { session, rpc } = fixture();
    let finish!: (value: EthereumName) => void;
    rpc.resolveName.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    session.setEnabled(true);
    const resolver = session.getSnapshot().resolver!;
    const pending = resolver.resolveName("alice.eth");
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    session.setEnabled(false);
    finish(identity);
    await rejected;
    await expect(resolver.resolveName("bob.eth")).rejects.toMatchObject({ name: "AbortError" });
    await expect(resolver.reverseAddress(address)).rejects.toMatchObject({ name: "AbortError" });
    await expect(resolver.getAvatar(identity)).rejects.toMatchObject({ name: "AbortError" });
    expect(rpc.resolveName).toHaveBeenCalledTimes(1);
    expect(rpc.reverseAddress).not.toHaveBeenCalled();
    expect(rpc.getAvatar).not.toHaveBeenCalled();
  });

  it("never enables a fixture resolver or requires browser storage to work", () => {
    const { rpc } = fixture();
    const session = new NameResolutionSession(() => rpc, () => { throw new Error("Storage disabled"); });
    expect(session.getSnapshot().enabled).toBe(false);
    session.setEnabled(true);
    expect(session.getSnapshot().resolver).toBeDefined();
    session.setEnabled(false);
    const fixtures = new NameResolutionSession(undefined, () => localStorage);
    fixtures.setEnabled(true);
    expect(fixtures.getSnapshot().enabled).toBe(false);
  });
});
