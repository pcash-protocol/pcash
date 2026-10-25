#!/usr/bin/env node
import { Logger } from "@pcash/sdk/blgr";
import { runRelayerHttpCli } from "./run.ts";

runRelayerHttpCli(process.argv.slice(2)).then(
  (code) => { process.exitCode = code; },
  async (error: unknown) => {
    const logger = new Logger("info");
    await logger.open();
    logger.error(`pcash-relayer-cli: fatal: ${(error as Error).message}`);
    process.exitCode = 1;
  },
);
