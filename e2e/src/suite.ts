import { join } from "node:path";
import { sourceVerificationDefinition } from "@pcash/marketplace/tooling/sourceVerification";
import { ScenarioFixture, STACK_PORTS } from "./fixture/scenarioFixture.ts";
import { logger } from "./framework/logger.ts";
import { selectScenarios } from "./scenarios/registry.ts";
import type { RunOptions } from "./run.ts";

/**
 * Run the selected scenarios one after another, each on its own fixture. The
 * first interrupt lets a long-running scenario finish its round and starts no
 * other; a second tears the fixture down at once.
 */
export async function runSuite(options: RunOptions): Promise<number> {
  const scenarios = selectScenarios(options.scenarios, options.mode);
  const results: Array<{ name: string; passed: boolean; seconds: number }> = [];
  let active: ScenarioFixture | undefined;
  let interrupted = false;
  const abort = () => {
    logger.warning("aborting");
    setTimeout(() => process.exit(130), 10_000).unref();
    void (active?.abort() ?? Promise.resolve()).finally(() => process.exit(130));
  };
  process.once("SIGINT", () => {
    interrupted = true;
    active?.requestStop();
    logger.warning("stopping after the current round; interrupt again to abort");
    process.once("SIGINT", abort);
  });
  for (const scenario of scenarios) {
    if (interrupted) break;
    const started = Date.now();
    logger.info(`==> ${scenario.name} (${options.mode})`);
    let failure: unknown;
    try {
      active = await ScenarioFixture.create({
        name: scenario.name,
        disableCatalog: scenario.name === "board",
        mode: options.mode,
        ...(scenario.nodeCount === undefined ? {} : { nodeCount: scenario.nodeCount }),
        ...(scenario.sourceVerificationDefinition === undefined
          ? {}
          : { sourceVerificationDefinition: scenario.sourceVerificationDefinition }),
        enableNodeASourceSubmissions: scenario.name === "seed",
        ...(options.outputDir === undefined
          ? {}
          : { artifactsRoot: scenarios.length === 1 ? options.outputDir : join(options.outputDir, scenario.name) }),
        keepArtifacts: options.keepArtifacts,
        ...(options.durationMs === undefined ? {} : { durationMs: options.durationMs }),
        ...(options.marketplace === undefined ? {} : { marketplace: options.marketplace }),
      });
      if (interrupted) active.requestStop();
      await scenario.run(active);
    } catch (error) {
      failure = error;
    }
    try {
      await active?.finish(failure);
    } catch (error) {
      failure ??= error;
    }
    active = undefined;
    const seconds = Math.round((Date.now() - started) / 1_000);
    results.push({ name: scenario.name, passed: failure === undefined, seconds });
    if (failure === undefined) logger.info(`PASS ${scenario.name} (${seconds}s)`);
    else logger.error(`FAIL ${scenario.name} (${seconds}s): ${failure instanceof Error ? failure.stack ?? failure.message : String(failure)}`);
  }
  const failed = results.filter((result) => !result.passed);
  logger.info(`==> ${results.length - failed.length}/${results.length} scenarios passed${
    failed.length === 0 ? "" : `; failed: ${failed.map((result) => result.name).join(", ")}`}`);
  return failed.length > 0 ? 1 : interrupted ? 130 : 0;
}

/** Serve Anvil and one node on the stack ports until interrupted, for live mode to run against. */
export async function runStack(options: RunOptions): Promise<number> {
  const fixture = await ScenarioFixture.create({
    name: "stack",
    mode: "local",
    nodeCount: 1,
    stack: true,
    sourceVerificationDefinition,
    keepArtifacts: options.keepArtifacts,
    ...(options.outputDir === undefined ? {} : { artifactsRoot: options.outputDir }),
  });
  const node = fixture.local("A");
  logger.raw([
    `Local stack ready: PCASH chain ${fixture.network.pcashChainId} on Anvil chain ${fixture.network.l1ChainId}.`,
    `  PCASH_E2E_RPC_URL=${node.rpcUrl}`,
    `  PCASH_E2E_L1_RPC=${fixture.backend.rpcUrl}`,
    `  PCASH_E2E_PSCAN_URL=${node.pscanUrl}`,
    `  PCASH_E2E_ADMIN_URL=${node.adminUrl}`,
    `These are live mode's defaults (Anvil ${STACK_PORTS.l1}, RPC ${STACK_PORTS.rpc}), so in another terminal run:`,
    "  just e2e-live core",
    "  just e2e-live traffic --duration 10m",
    `Logs: ${fixture.artifacts.logs}. Interrupt to stop.`,
  ].join("\n"));
  await new Promise<void>((resolve) => process.once("SIGINT", () => resolve()));
  await fixture.finish();
  return 0;
}
