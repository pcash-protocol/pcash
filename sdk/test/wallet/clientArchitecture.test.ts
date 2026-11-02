// Platform persistence adapters store wallet state supplied by the shared client
// engine. They must not create identity or default-rule recovery material, or a
// cleared browser store and a fresh CLI wallet database would silently produce
// different user-account commitments for the same Ethereum account.

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as publicActions from "../../src/wallet/actions/index.ts";
import * as root from "../../src/wallet/index.ts";

function importSpecifiers(source: string): string[] {
  return [...source.matchAll(/(?:from\s*|import\s*\(|import\s+)["']([^"']+)["']/g)]
    .map((match) => match[1]!);
}

function relativeModule(fromFile: string, specifier: string): string | undefined {
  const path = resolve(dirname(fromFile), specifier);
  return [path, `${path}.ts`, resolve(path, "index.ts")].find(existsSync);
}

function localImportGraph(entry: string): { visited: Set<string>; external: Set<string> } {
  const visited = new Set<string>();
  const external = new Set<string>();
  const pending = [entry];
  while (pending.length > 0) {
    const path = pending.pop()!;
    if (visited.has(path)) continue;
    visited.add(path);
    for (const specifier of importSpecifiers(readFileSync(path, "utf8"))) {
      if (!specifier.startsWith(".")) {
        external.add(specifier);
        continue;
      }
      const target = relativeModule(path, specifier);
      if (target !== undefined) pending.push(target);
    }
  }
  return { visited, external };
}

describe("client architecture boundaries", () => {
  it("keeps browser adapters behind the web subpath", () => {
    const src = fileURLToPath(new URL("../../src/wallet", import.meta.url));
    const { visited } = localImportGraph(resolve(src, "index.ts"));
    expect([...visited].filter((path) => path.startsWith(resolve(src, "web")))).toEqual([]);
  });

  it("keeps PGlite out of the browser wallet graph", () => {
    const src = fileURLToPath(new URL("../../src/wallet", import.meta.url));
    const { visited, external } = localImportGraph(resolve(src, "web", "index.ts"));
    expect([...visited].filter((path) => /pglite/i.test(path))).toEqual([]);
    expect([...external].filter((specifier) => specifier.startsWith("@electric-sql/pglite"))).toEqual([]);
  });

  it("keeps raw persistence out of public wallet entrypoints", () => {
    const manifest = JSON.parse(readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8")) as {
      exports: Record<string, unknown>;
    };
    expect(manifest.exports["./wallet/actions"]).toBeDefined();
    expect(manifest.exports["./wallet/scanning"]).toBeDefined();
    expect(manifest.exports["./wallet/database"]).toBeDefined();
    expect(manifest.exports["./wallet/testing"]).toBeDefined();
    expect(manifest.exports["./wallet/storage"]).toBeUndefined();
    expect(Object.hasOwn(publicActions, "OPEN_WALLET_INTERNAL")).toBe(false);
    expect(Object.hasOwn(publicActions, "scanWallet")).toBe(false);
    expect(Object.hasOwn(publicActions, "syncWallet")).toBe(false);
    expect(Object.hasOwn(publicActions, "reconcilePendingWalletActions")).toBe(false);
    expect(Object.hasOwn(publicActions, "createWalletRuntime")).toBe(false);
    expect(Object.hasOwn(publicActions, "runNoteFundedTransferClient")).toBe(false);
    expect(Object.hasOwn(publicActions, "submitDurableAction")).toBe(false);
    expect(publicActions.noteFundedTransfer).toBeTypeOf("function");
    expect(root.OPEN_WALLET_INTERNAL).toBeTypeOf("symbol");
  });
});
