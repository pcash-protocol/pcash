import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { parseDuration } from "./config.ts";
import { preparePrivateRunDirectory } from "./framework/artifacts.ts";
import { buildRequiredBinaries } from "./framework/build.ts";
import { selectCatalogScenarios } from "./scenarios/catalog.ts";
import type { NetworkMode } from "./fixture/scenarioFixture.ts";

// The launcher builds the workspace packages, so it must not statically import anything
// that resolves through their dist output. Scenario code loads only after that build.
const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));

export interface RunOptions {
  mode: NetworkMode;
  scenarios: string[];
  durationMs?: number;
  /** Trade on the marketplace during traffic; always on locally. */
  marketplace?: boolean;
  outputDir?: string;
  keepArtifacts: boolean;
  /** Serve a local stack for live mode instead of running scenarios. */
  up: boolean;
}

const USAGE = "usage: e2e [--network local|live] [scenario ...] [--duration 30m] [--marketplace] [--keep-artifacts] [--out dir] | --up";

export function parseRunOptions(argv: readonly string[]): RunOptions {
  const options: RunOptions = { mode: "local", scenarios: [], keepArtifacts: false, up: false };
  const value = (arg: string, index: number): string => {
    const found = argv[index];
    if (found === undefined || found.startsWith("--") || found.trim() === "") throw new Error(`${arg} requires a value`);
    return found.trim();
  };
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index]!;
    const [arg, inline] = raw.startsWith("--") && raw.includes("=") ? [raw.slice(0, raw.indexOf("=")), raw.slice(raw.indexOf("=") + 1)] : [raw, undefined];
    const next = () => inline ?? value(arg, ++index);
    if (arg === "--network") {
      const mode = next();
      if (mode !== "local" && mode !== "live") throw new Error("--network expects local or live");
      options.mode = mode;
    } else if (arg === "--duration") options.durationMs = parseDuration(next());
    else if (arg === "--out") options.outputDir = resolve(next());
    else if (arg === "--marketplace") options.marketplace = true;
    else if (arg === "--keep-artifacts") options.keepArtifacts = true;
    else if (arg === "--up") options.up = true;
    else if (arg === "--help") throw new Error(USAGE);
    else if (!arg.startsWith("--")) options.scenarios.push(...arg.split(",").filter(Boolean));
    else throw new Error(`unknown E2E option ${arg}\n${USAGE}`);
  }
  if (options.up) {
    if (options.mode !== "local" || options.scenarios.length > 0) throw new Error("--up serves a local stack and runs no scenarios");
    return options;
  }
  selectCatalogScenarios(options.scenarios, options.mode);
  return options;
}

async function main(): Promise<number> {
  const options = parseRunOptions(process.argv.slice(2));
  if (options.outputDir !== undefined) await preparePrivateRunDirectory(options.outputDir);
  await buildRequiredBinaries(REPO_ROOT);
  const { runStack, runSuite } = await import("./suite.ts");
  return options.up ? runStack(options) : runSuite(options);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => { process.exitCode = code; },
    (error) => {
      process.stderr.write(`E2E runner failed: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
