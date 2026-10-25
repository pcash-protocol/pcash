import { Config } from "@pcash/sdk/bcfg";

export const DEFAULT_RELAYER_URL = "http://127.0.0.1:9464";

export type RelayerHttpCommand = "health" | "status" | "metrics";

export interface RelayerHttpCliOptions {
  command: RelayerHttpCommand;
  relayerUrl: string;
  json: boolean;
}

export const CLI_USAGE = `Usage: pcash-relayer-cli <health|status|metrics> [options]

Commands:
  health                       Check whether the relayer can keep cycling
  status                       Print the relayer's current state and last cycle
  metrics                      Print the relayer's OpenMetrics document

Options:
  --relayer-url <url>          Relayer operator HTTP server (default ${DEFAULT_RELAYER_URL})
  --json                        Print status as compact JSON
  -h, --help                    Show this help

Environment:
  PCASH_RELAYER_URL`;

export function parseRelayerHttpArgs(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): RelayerHttpCliOptions {
  const args = new Config("pcash");
  args.load({ argv: ["node", "pcash-relayer-cli", ...argv] });
  for (const key of Object.keys(args.args)) {
    if (key !== "relayerurl" && key !== "json") throw new Error(`unknown option --${key}`);
  }
  if (args.argv.length !== 1) {
    throw new Error("expected exactly one command: health, status, or metrics");
  }
  const command = args.argv[0];
  if (command !== "health" && command !== "status" && command !== "metrics") {
    throw new Error(`unknown command "${command}"; expected health, status, or metrics`);
  }
  const json = args.bool("json", false);
  if (json && command !== "status") {
    throw new Error("--json is valid only for status");
  }
  const settings = new Config("pcash");
  settings.load({ argv: ["node", "pcash-relayer-cli", ...argv], env });
  const relayerUrl = settings.str("relayer-url", DEFAULT_RELAYER_URL);
  let url: URL;
  try {
    url = new URL(relayerUrl);
  } catch {
    throw new Error(`--relayer-url is not a valid URL: ${relayerUrl}`);
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username !== "" || url.password !== "") {
    throw new Error("--relayer-url must be an http(s) URL without embedded credentials");
  }
  return { command, relayerUrl: url.toString().replace(/\/$/, ""), json };
}
