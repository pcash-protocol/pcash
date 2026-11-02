import { describe, expect, it } from "vitest";
import { addressPath, explorerPaths, isAddressPath, isNamePath, isExplorerPath, isIdentityPath } from "./paths.ts";

const HASH = `0x${"ab".repeat(32)}`;
const ADDRESS = `0x${"cd".repeat(20)}`;

describe("isExplorerPath", () => {
  it("recognises every chain-object route", () => {
    for (const path of [
      "/explorer",
      "/blocks",
      "/block/12",
      "/transactions",
      `/tx/${HASH}`,
      `/batch/${HASH}`,
      "/contracts",
      "/search",
    ]) {
      expect(isExplorerPath(path), path).toBe(true);
    }
  });

  it("rejects paths that belong to another route or to nothing", () => {
    for (const path of ["/", "/nope", "/marketplace", "/blocks/extra", "/explorer/blocks"]) {
      expect(isExplorerPath(path), path).toBe(false);
    }
  });

  it("leaves identity to its own route", () => {
    expect(isExplorerPath(`/${ADDRESS}`)).toBe(false);
    expect(isExplorerPath("/alice.eth")).toBe(false);
  });

  it("no longer serves the routes that were dropped", () => {
    // A mempool page implies a list keyed by inclusion identity, which a
    // pending transaction does not have. An implementation is a value
    // committed inside N contracts, not an entity with a page.
    for (const path of ["/mempool", "/economics", `/implementation/${HASH}`, `/search/${HASH}`]) {
      expect(isExplorerPath(path), path).toBe(false);
    }
  });

  it("keeps search a query string rather than a namespace", () => {
    expect(explorerPaths.search).toBe("search");
    expect(Object.values(explorerPaths).some((path) => path.includes("search/:"))).toBe(false);
  });
});

describe("isAddressPath", () => {
  it("accepts a 20-byte hex address in either case", () => {
    expect(isAddressPath(`/0x${"AB".repeat(20)}`)).toBe(true);
    expect(isAddressPath(`/${ADDRESS}`)).toBe(true);
  });

  it("rejects anything that is not exactly 20 bytes at the root", () => {
    expect(isAddressPath("/0x1234")).toBe(false);
    expect(isAddressPath(`/${HASH}`)).toBe(false);
    expect(isAddressPath("/alice.eth")).toBe(false);
    expect(isAddressPath(`/address/${ADDRESS}`)).toBe(false);
  });
});

describe("isNamePath", () => {
  it("accepts a dotted name", () => {
    expect(isNamePath("/alice.eth")).toBe(true);
    expect(isNamePath("/sub.alice.eth")).toBe(true);
    expect(isNamePath("/vitalik-1.eth")).toBe(true);
  });

  it("rejects a bare handle, a namespaced name, hex and nested paths", () => {
    expect(isNamePath("/bob")).toBe(false);
    expect(isNamePath("/address/alice.eth")).toBe(false);
    expect(isNamePath(`/${ADDRESS}`)).toBe(false);
    expect(isNamePath("/alice.eth/extra")).toBe(false);
  });
});

describe("isIdentityPath", () => {
  it("covers both identity forms and nothing else", () => {
    expect(isIdentityPath(`/${ADDRESS}`)).toBe(true);
    expect(isIdentityPath("/alice.eth")).toBe(true);
    expect(isIdentityPath("/blocks")).toBe(false);
    expect(isIdentityPath(`/address/${ADDRESS}`)).toBe(false);
  });

  it("covers no subpath", () => {
    expect(isIdentityPath(`/${ADDRESS}/marketplace`)).toBe(false);
    expect(isIdentityPath("/alice.eth/history")).toBe(false);
    expect(isIdentityPath("/alice.eth/payments")).toBe(false);
    expect(isIdentityPath("/alice.eth/extra")).toBe(false);
    expect(isIdentityPath("/marketplace")).toBe(false);
    expect(isIdentityPath("/block/history")).toBe(false);
  });
});

describe("addressPath", () => {
  it("uses short root-level identity paths", () => {
    expect(addressPath(ADDRESS)).toBe(`/${ADDRESS}`);
    expect(addressPath("alice.eth")).toBe("/alice.eth");
  });
});
