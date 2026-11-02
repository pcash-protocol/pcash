import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function importSpecifiers(source: string): string[] {
  return [...source.matchAll(/(?:from\s*|import\s*\(|import\s+)["']([^"']+)["']/g)]
    .map((match) => match[1]!);
}

function relativeModule(fromFile: string, specifier: string): string | undefined {
  const path = resolve(dirname(fromFile), specifier);
  return [path, `${path}.ts`, resolve(path, "index.ts")].find(existsSync);
}

describe("client architecture boundaries", () => {
  it("keeps the command-line client isolated from wallet and node capabilities", () => {
    const cliRoot = resolve(fileURLToPath(new URL("../src/cli", import.meta.url)));
    const connectionModule = resolve(cliRoot, "../connection.ts");
    const visited = new Set<string>();
    const pending = [resolve(cliRoot, "bin.ts")];
    const externalImports = new Set<string>();

    while (pending.length > 0) {
      const path = pending.pop()!;
      if (visited.has(path)) continue;
      visited.add(path);
      expect(path.startsWith(`${cliRoot}/`) || path === connectionModule).toBe(true);
      for (const specifier of importSpecifiers(readFileSync(path, "utf8"))) {
        if (!specifier.startsWith(".")) {
          externalImports.add(specifier);
          continue;
        }
        const target = relativeModule(path, specifier);
        expect(target, `${path} imports unresolved module ${specifier}`).toBeDefined();
        pending.push(target!);
      }
    }

    // Onboarding generates and confirms recovery words locally. Wallet storage,
    // profile derivation, transaction signing, proving and node access stay in the service.
    expect(externalImports).toEqual(new Set([
      "@pcash/sdk/bcfg",
      "@pcash/sdk/delivery",
      "@pcash/sdk/utils",
      "node:fs/promises",
      "node:fs",
      "node:os",
      "node:path",
      "@pcash/sdk/wallet",
      "@pcash/sdk/wallet/node",
      "node:crypto",
    ]));
    expect(readFileSync(resolve(cliRoot, "client.ts"), "utf8"))
      .toContain('import { readFile } from "node:fs/promises"');
    expect([...visited].filter((path) => path.startsWith(`${cliRoot}/`)).map((path) => path.slice(cliRoot.length + 1)).sort()).toEqual([
      "bin.ts", "cli.ts", "client.ts", "onboarding.ts", "output.ts", "run.ts",
    ]);
  });
});
