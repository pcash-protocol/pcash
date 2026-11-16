// The folder layout is the SDK's module boundary, and this test is what makes it
// real. `src/` is organized into layers; a module may import from a layer strictly
// above its own, or from a sibling in its own folder, and nothing else.
//
// Without an enforced order the layout is a convention that decays, and the decay
// is invisible: one import hop from `clients/` into `builders/` is enough to put
// the entire ~2,900-line witness-builder layer behind every chain-state read.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC_DIR = fileURLToPath(new URL("../src", import.meta.url));

/**
 * Import direction, most fundamental first. A folder may import from any folder
 * ABOVE it in this list, never from one at or below it.
 */
const LAYERS = [
  "bcfg",
  "blgr",
  "constants",
  "crypto",
  "utils",
  "protocol",
  "eip712",
  "rules",
  "clients",
  "names",
  "delivery",
  "builders",
  "fixtures",
  "l1",
  "relay",
  "source-verification",
  "prover",
  "browser-prover",
  "node",
  "wallet",
] as const;

const RANK = new Map(LAYERS.map((name, index) => [name as string, index]));

/** Folders whose transitive closure must stay free of `node:` builtins. */
const BROWSER_SAFE = LAYERS.filter((l) => l !== "node");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith(".")) continue;
    const path = resolve(dir, entry);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (entry.endsWith(".ts")) out.push(path);
  }
  return out;
}

/** All `from "<specifier>"` / `import("<specifier>")` targets. */
function importSpecifiers(source: string): string[] {
  const out: string[] = [];
  const re = /(?:from|import)\s*(?:\(\s*)?["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) out.push(m[1]!);
  return out;
}

/** The layer a file belongs to, or null for the two root barrels. */
function layerOf(file: string): string | null {
  const rel = relative(SRC_DIR, file);
  const [head, ...rest] = rel.split("/");
  return rest.length === 0 ? null : head!;
}

function resolveRelative(fromFile: string, spec: string): string {
  const base = resolve(dirname(fromFile), spec);
  return base.endsWith(".ts") ? base : `${base}.ts`;
}

const FILES = sourceFiles(SRC_DIR);

describe("src/ layering", () => {
  it("covers every folder in src/ with a declared layer", () => {
    const onDisk = readdirSync(SRC_DIR)
      .filter((entry) => !entry.startsWith(".") && statSync(resolve(SRC_DIR, entry)).isDirectory())
      .sort();
    expect(onDisk).toEqual([...LAYERS].sort());
  });

  it("gives every layer an index.ts entry point", () => {
    for (const layer of LAYERS) {
      const index = resolve(SRC_DIR, layer, "index.ts");
      expect(statSync(index).isFile(), `${layer}/index.ts is missing`).toBe(true);
    }
  });

  it("never imports downward or sideways across layers", () => {
    const violations: string[] = [];
    for (const file of FILES) {
      const from = layerOf(file);
      if (from === null) continue; // root barrels compose every layer by design
      const fromRank = RANK.get(from)!;
      for (const spec of importSpecifiers(readFileSync(file, "utf8"))) {
        if (!spec.startsWith(".")) continue;
        const target = resolveRelative(file, spec);
        const to = layerOf(target);
        if (to === null || to === from) continue;
        const toRank = RANK.get(to);
        if (toRank === undefined) {
          violations.push(`${relative(SRC_DIR, file)} imports unknown layer ${to}`);
        } else if (toRank >= fromRank) {
          violations.push(
            `${relative(SRC_DIR, file)} (${from}) imports ${to}/ — ` +
              `${to} is not above ${from} in the declared order`,
          );
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("keeps the RPC client free of the witness builders", () => {
    // The specific regression this layout exists to prevent, asserted directly on
    // the transitive closure rather than inferred from the layer order.
    const visited = new Set<string>();
    const stack = [resolve(SRC_DIR, "clients", "index.ts")];
    while (stack.length > 0) {
      const file = stack.pop()!;
      if (visited.has(file)) continue;
      visited.add(file);
      for (const spec of importSpecifiers(readFileSync(file, "utf8"))) {
        if (spec.startsWith(".")) stack.push(resolveRelative(file, spec));
      }
    }
    const reached = [...visited]
      .map((f) => layerOf(f))
      .filter((l): l is string => l !== null);
    expect([...new Set(reached)].sort()).toEqual(
      ["clients", "constants", "crypto", "eip712", "protocol", "utils"],
    );
  });

  it("keeps every browser-safe layer free of node: builtins (transitively)", () => {
    const offenders: string[] = [];
    for (const layer of BROWSER_SAFE) {
      const visited = new Set<string>();
      const stack = [resolve(SRC_DIR, layer, "index.ts")];
      while (stack.length > 0) {
        const file = stack.pop()!;
        if (visited.has(file)) continue;
        visited.add(file);
        for (const spec of importSpecifiers(readFileSync(file, "utf8"))) {
          if (spec.startsWith("node:")) {
            offenders.push(`${layer}: ${relative(SRC_DIR, file)} imports ${spec}`);
          } else if (spec.startsWith(".")) {
            stack.push(resolveRelative(file, spec));
          }
          // Bare specifiers are the bundler's problem; none of ours shim node:.
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
