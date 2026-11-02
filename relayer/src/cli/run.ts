import { Logger } from "@pcash/sdk/blgr";
import { CLI_USAGE, parseRelayerHttpArgs } from "./args.ts";
import { RelayerHttpClient } from "./client.ts";

export async function runRelayerHttpCli(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const logger = new Logger("info");
  await logger.open();
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h") || argv[0] === "help") {
    logger.raw(CLI_USAGE);
    return 0;
  }
  let options: ReturnType<typeof parseRelayerHttpArgs>;
  try {
    options = parseRelayerHttpArgs(argv, env);
  } catch (error) {
    logger.error(`pcash-relayer-cli: ${(error as Error).message}`);
    return 2;
  }
  try {
    const output = await new RelayerHttpClient(options.relayerUrl).request(options.command);
    if (options.command === "status") {
      logger.raw(JSON.stringify(output, null, options.json ? 0 : 2));
    } else {
      logger.raw(String(output).replace(/\n$/, ""));
    }
    return 0;
  } catch (error) {
    logger.error(`pcash-relayer-cli: ${(error as Error).message}`);
    return 1;
  }
}
