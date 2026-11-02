import { describe, expect, it } from "vitest";
import { identityNameFromPath, normalizeIdentityName } from "./identityName.ts";
import { isIdentityPath } from "./paths.ts";
import { parseSearchTarget } from "./format.ts";

describe("Ethereum name routing", () => {
  it.each(["café.eth", "💩.eth", "sub.café.eth", "example.com", "0xalice.eth", "alice.wei", "alice.gwei", "sub.café.wei", "sub.café.gwei"])("routes and searches %s through viem normalization", (name) => {
    for (const path of [`/${name}`, `/${encodeURIComponent(name)}`]) {
      expect(isIdentityPath(path)).toBe(true);
      expect(identityNameFromPath(path)).toBe(name);
    }
    expect(parseSearchTarget(name)).toEqual({ kind: "name", name });
  });

  it("uses library normalization consistently for case and composed Unicode", () => {
    const input = "CAFE\u0301.eth";
    expect(normalizeIdentityName(input)).toBe("café.eth");
    expect(identityNameFromPath(`/${encodeURIComponent(input)}`)).toBe("café.eth");
    expect(parseSearchTarget(input)).toEqual({ kind: "name", name: "café.eth" });
  });

  it("keeps application routes, nested paths and malformed URLs outside the identity namespace", () => {
    for (const path of ["/blocks", "/address/alice.eth", "/alice.eth/extra", "/alice.eth%2fextra", "/%E0%A4%A", "/alice..eth"]) {
      expect(identityNameFromPath(path)).toBeUndefined();
    }
  });
});
