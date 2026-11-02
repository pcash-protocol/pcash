// The browser barrel must stay free of `node:` imports so it bundles for
// browser applications, and it must not eagerly include the browser prover.
//
// ./layering.test.ts checks the `node:`-free property per folder index; this file
// adds the barrel itself and owns the deliberately narrow surface.
//
// Note where the narrowing assertions point. browser.ts re-exports folder
// indexes, so it names neither the narrowed modules nor the internal symbols —
// grepping it would pass without checking anything. The checks run against the
// folder indexes, which are where the narrowing actually lives, and against the
// built runtime surface, which is what an application receives.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC_DIR = fileURLToPath(new URL("../src", import.meta.url));
const BARREL = resolve(SRC_DIR, "browser.ts");

/** All `from "<specifier>"` targets (static and dynamic imports, re-exports). */
function importSpecifiers(source: string): string[] {
  const out: string[] = [];
  const re = /(?:from|import)\s*(?:\(\s*)?["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) out.push(m[1]!);
  return out;
}

function resolveRelative(fromFile: string, spec: string): string {
  const base = resolve(dirname(fromFile), spec);
  return base.endsWith(".ts") ? base : `${base}.ts`;
}

/** Drop line and block comments so prose about a symbol is not read as an export. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

/** Modules whose full surface must never be blanket re-exported. */
const NARROWED = [
  { folder: "crypto", module: "poseidon2Constants" },
  { folder: "clients", module: "adminClient" },
];

/** Names that must not reach an application through the browser entry. */
const INTERNAL = [
  "browserProver",
  "createBrowserProver",
  "createBrowserProverSession",
  "Wallet",
  "openBrowserWallet",
  "buildPrivateMultisigContract",
  "buildAssetCovenantRuleWitness",
  "createAdminClient",
];

describe("browser barrel is node:-free (transitively)", () => {
  it("imports no node: specifier anywhere in its import graph", () => {
    const visited = new Set<string>();
    const offenders: string[] = [];
    const stack = [BARREL];
    while (stack.length > 0) {
      const file = stack.pop()!;
      if (visited.has(file)) continue;
      visited.add(file);
      for (const spec of importSpecifiers(readFileSync(file, "utf8"))) {
        if (spec.startsWith("node:")) {
          offenders.push(`${file.replace(`${SRC_DIR}/`, "")} imports ${spec}`);
        } else if (spec.startsWith(".")) {
          stack.push(resolveRelative(file, spec));
        }
        // Bare specifiers (npm deps) are not followed: the browser bundler
        // resolves them, and none of the barrel's deps are node: shims.
      }
    }
    expect(offenders).toEqual([]);
    // Sanity: the walk actually reached the module set, not just the barrel.
    expect(visited.size).toBeGreaterThan(50);
  });
});

describe("browser barrel keeps heavy and internal implementation details out", () => {
  it("keeps the narrowed modules out of every folder index", () => {
    // Asserted where the narrowing lives now, not on the barrel that composes it.
    const offenders: string[] = [];
    for (const { folder, module } of NARROWED) {
      const index = readFileSync(resolve(SRC_DIR, folder, "index.ts"), "utf8");
      if (index.includes(`export * from "./${module}.ts"`)) {
        offenders.push(`${folder}/index.ts blanket-exports ./${module}.ts`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("does not name any derivation internal in the reachable index files", () => {
    // Walk browser.ts to the folder indexes it composes and check their text: an
    // internal can only escape by being listed in one of them.
    const indexes = importSpecifiers(readFileSync(BARREL, "utf8"))
      .filter((spec) => spec.startsWith("."))
      .map((spec) => resolveRelative(BARREL, spec));
    expect(indexes.length).toBeGreaterThan(10);

    const offenders: string[] = [];
    for (const index of indexes) {
      // Strip comments first: these files explain what they deliberately do not
      // export, and prose about a symbol is not an export of it.
      const source = stripComments(readFileSync(index, "utf8"));
      for (const internal of INTERNAL) {
        if (new RegExp(`\\b${internal}\\b`).test(source)) {
          offenders.push(`${index.replace(`${SRC_DIR}/`, "")} exports ${internal}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("does not expose them at runtime through the built browser entry", async () => {
    // The end-to-end check: whatever the source says, this is what an application
    // actually receives. Value exports only — types erase.
    const browser = (await import("../dist/browser.js")) as Record<string, unknown>;
    const exposed = INTERNAL.filter((name) => name in browser);
    expect(exposed).toEqual([]);
    // And the narrowed surface is still genuinely there.
    expect(typeof browser.PcashNodeClient).toBe("function");
    expect(typeof browser.poseidon2).toBe("function");
  });
});
