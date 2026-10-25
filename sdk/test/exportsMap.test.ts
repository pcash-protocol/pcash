// The package export map is hand-maintained, so it drifts: a new folder gets an
// index.ts and no `exports` entry, or an entry outlives the file it points at.
// Both failures only show up when a consumer imports the subpath, which is far
// from where the mistake was made. Assert the correspondence directly.
//
// The dist assertions run against whatever `npm run build` last produced;
// `pretest` builds, and this is the test that catches a build that silently
// stopped emitting an entry point.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PKG_DIR = fileURLToPath(new URL("..", import.meta.url));
const SRC_DIR = resolve(PKG_DIR, "src");
const pkg = JSON.parse(readFileSync(resolve(PKG_DIR, "package.json"), "utf8")) as {
  exports: Record<string, { types: string; default: string } | string>;
  bin?: Record<string, string>;
  main: string;
  types: string;
};

const folderEntries = Object.entries(pkg.exports).filter(
  ([key]) => key !== "." && key !== "./browser" && key !== "./package.json",
);

describe("package export map", () => {
  it("exposes one base subpath per src/ folder", () => {
    const folders = readdirSync(SRC_DIR)
      .filter((entry) => !entry.startsWith(".") && statSync(resolve(SRC_DIR, entry)).isDirectory())
      .sort();
    const baseSubpaths = folderEntries
      .map(([key]) => key.slice(2))
      .filter((subpath) => !subpath.includes("/"))
      .sort();
    expect(baseSubpaths).toEqual(folders);
  });

  it("points every entry at a file the build actually emits", () => {
    const missing: string[] = [];
    for (const [key, value] of Object.entries(pkg.exports)) {
      if (key === "./package.json") continue;
      const entry = value as { types: string; default: string };
      for (const target of [entry.types, entry.default]) {
        if (!existsSync(resolve(PKG_DIR, target))) missing.push(`${key} -> ${target}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("keeps the wallet engine off the root barrel and the CLI out of the SDK", () => {
    const index = readFileSync(resolve(SRC_DIR, "index.ts"), "utf8");
    const reexports = [...index.matchAll(/(?:from|import)\s*["']([^"']+)["']/g)].map((m) => m[1]!);
    expect(reexports).not.toContain("./cli/index.ts");
    expect(reexports).not.toContain("./wallet/index.ts");
    expect(pkg.exports["./cli"]).toBeUndefined();
    expect(pkg.exports["./wallet"]).toBeDefined();
    expect(pkg.bin).toBeUndefined();
  });

  it("keeps main/types agreeing with the '.' export", () => {
    const root = pkg.exports["."] as { types: string; default: string };
    expect(pkg.main).toBe(root.default);
    expect(pkg.types).toBe(root.types);
  });
});
