import { describe, expect, it } from "vitest";
import { FAILURE_TTL, MISS_TTL, NAME_TTL, NameCache } from "./nameCache.ts";
import type { EthereumName } from "@pcash/sdk/names";

const identity: EthereumName = { address: "0x1234567890123456789012345678901234567890", name: "alice.eth", system: "ens" };
function fixture() {
  let time = 100;
  let stored: string | null = null;
  const storage = () => ({ removeItem: () => { stored = null; }, getItem: () => stored, setItem: (_key: string, value: string) => { stored = value; } });
  const now = () => time;
  return { cache: new NameCache(storage, now), reload: () => new NameCache(storage, now), advance: (delta: number) => { time += delta; } };
}

describe("persistent name cache", () => {
  it.each([null, [], "text", 42, true, { broken: null }, { broken: { identity: null } }])("ignores a malformed restored value: %j", (value) => {
    const storage = { getItem: () => JSON.stringify(value), setItem: () => undefined, removeItem: () => undefined };
    const cache = new NameCache(() => storage);
    expect(cache.read("broken")).toBeUndefined();
    expect(cache.write("fresh", { identity, complete: true }).identity).toEqual(identity);
  });

  it("retains valid restored entries while discarding malformed identities and expiry values", () => {
    const valid = { identity, expiresAt: Date.now() + NAME_TTL, failed: false };
    const storage = { getItem: () => JSON.stringify({ valid,
      address: { ...valid, identity: { ...identity, address: "no address" } },
      name: { ...valid, identity: { ...identity, name: [] } },
      system: { ...valid, identity: { ...identity, system: "unknown" } },
      expires: { ...valid, expiresAt: "tomorrow" },
      finite: { ...valid, expiresAt: Infinity },
      flag: { ...valid, failed: "false" },
    }), setItem: () => undefined, removeItem: () => undefined };
    const cache = new NameCache(() => storage);
    expect(cache.read("valid")?.identity).toEqual(identity);
    for (const key of ["address", "name", "system", "expires", "finite", "flag"]) expect(cache.read(key)).toBeUndefined();
  });

  it("explicitly clears loaded and persisted entries, including misses, so later writes cannot restore them", () => {
    const { cache, reload } = fixture();
    cache.write("hit", { identity, complete: true });
    cache.write("miss", { identity: null, complete: true });
    cache.clear();
    for (const key of ["hit", "miss"]) {
      expect(cache.read(key)).toBeUndefined();
      expect(reload().read(key)).toBeUndefined();
    }
    cache.write("new", { identity, complete: true });
    expect(reload().read("hit")).toBeUndefined();
    expect(reload().read("miss")).toBeUndefined();
  });
  it("reuses successful lookups across reloads until their original expiry", () => {
    const { cache, reload, advance } = fixture();
    cache.write("1:reverse:address", { identity, complete: true });
    advance(NAME_TTL - 1);
    const restored = reload();
    expect(restored.read("1:reverse:address")?.identity).toEqual(identity);
    expect(restored.read("1:forward:address")).toBeUndefined();
    advance(1);
    expect(restored.read("1:reverse:address")).toBeUndefined();
  });

  it("expires confirmed misses sooner and never persists incomplete results", () => {
    const { cache, reload, advance } = fixture();
    cache.write("miss", { identity: null, complete: true });
    const partial = cache.write("partial", { identity, complete: false });
    expect(partial.expiresAt).toBe(100 + FAILURE_TTL);
    expect(reload().read("partial")).toBeUndefined();
    expect(reload().read("miss")?.identity).toBeNull();
    advance(MISS_TTL);
    expect(cache.read("miss")).toBeUndefined();
  });

  it("bounds storage to the latest 1,000 complete entries", () => {
    const { cache, reload } = fixture();
    for (let i = 0; i < 1_001; i++) cache.write(String(i), { identity, complete: true });
    expect(reload().read("0")).toBeUndefined();
    expect(reload().read("1")).toBeDefined();
    expect(reload().read("1000")).toBeDefined();
  });

  it("continues in memory when the browser denies storage", () => {
    const cache = new NameCache(() => { throw new Error("Storage disabled"); });
    expect(cache.read("a")).toBeUndefined();
    expect(cache.write("a", { identity, complete: true }).identity).toEqual(identity);
    expect(cache.read("a")?.identity).toEqual(identity);
  });
});
