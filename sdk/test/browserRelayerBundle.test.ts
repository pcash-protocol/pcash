import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build, type Plugin } from "vite";
import { describe, expect, it } from "vitest";

describe("browser Relayer bundle", () => {
  it("bundles from the SDK browser entry without Node, ethers, or KZG modules", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pcash-browser-relayer-bundle-"));
    const entry = join(directory, "entry.js");
    const browserEntry = fileURLToPath(new URL("../dist/browser.js", import.meta.url));
    writeFileSync(entry, [
      `import { createBrowserRelayer, IndexedDbRelayJournal } from ${JSON.stringify(browserEntry)};`,
      "globalThis.pcashBrowserRelay = { createBrowserRelayer, IndexedDbRelayJournal };",
    ].join("\n"));
    const modules = new Set<string>();
    const inventory: Plugin = {
      name: "relay-module-inventory",
      generateBundle(_options, bundle) {
        for (const output of Object.values(bundle)) {
          if (output.type !== "chunk") continue;
          for (const module of Object.keys(output.modules)) modules.add(module);
        }
      },
    };
    try {
      await build({
        configFile: false,
        logLevel: "silent",
        plugins: [inventory],
        build: {
          outDir: join(directory, "dist"),
          emptyOutDir: true,
          rollupOptions: { input: entry },
        },
      });
      const shown = [...modules].join("\n");
      expect(shown).not.toMatch(/(?:^|\/)sdk\/dist\/node\//);
      expect(shown).not.toMatch(/(?:^|\/)node_modules\/ethers\//);
      expect(shown).not.toMatch(/(?:^|\/)node_modules\/kzg-wasm\//);
      expect(shown).not.toMatch(/(?:^|\/)node_modules\/proper-lockfile\//);
      expect([...modules].some((module) => module.endsWith("/sdk/dist/relay/browserSubmitter.js"))).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
