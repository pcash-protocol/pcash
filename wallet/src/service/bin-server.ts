#!/usr/bin/env node
import { Logger } from "@pcash/sdk/blgr";
import { main, SERVE_USAGE } from "./serve.ts";

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h") || argv[0] === "help") {
  new Logger().raw(SERVE_USAGE);
  process.exit(0);
}

main(argv).then(
  (code) => {
    if (code !== 0) process.exit(code);
  },
  async (err) => {
    const logger = new Logger("info");
    await logger.open();
    logger.error(`fatal: ${(err as Error).message}`);
    process.exit(1);
  },
);
