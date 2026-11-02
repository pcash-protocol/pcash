// Process I/O and exit-code handling for pcash-wallet-cli.
import { cliHelp, COMMAND_DEFINITIONS, jsonSafe, parseCli, tokenize } from "./cli.ts";
import { WalletHttpClient, WalletHttpError } from "./client.ts";
import { onboardWallet } from "./onboarding.ts";
import { resolveWalletConnection } from "../connection.ts";
import { renderResult } from "./output.ts";

function reportError(error: unknown, json: boolean): void {
  const message = error instanceof Error ? error.message : String(error);
  const contentHash = error instanceof WalletHttpError ? error.contentHash : undefined;
  const hint = contentHash === undefined ? undefined : `Transaction ${contentHash} may have been submitted; check its outcome before retrying. Do not submit a new transaction blindly.`;
  process.stderr.write(json ? JSON.stringify({ error: message,
    ...(error instanceof WalletHttpError ? { status: error.status } : {}),
    ...(contentHash === undefined ? {} : { contentHash, hint }),
  }) + "\n" : `pcash-wallet-cli: ${message}\n${hint === undefined ? "" : hint + "\n"}`);
}

export async function runWalletCli(argv: readonly string[]): Promise<number> {
  const json = argv.includes("--json") || argv.includes("--json=true");
  let cli;
  try {
    if (argv.length === 0 || argv.includes("--help") || argv.includes("-h") || argv[0] === "help") {
      const args = argv[0] === "help" ? argv.slice(1) : argv;
      const { positionals } = tokenize(args.filter(arg => arg !== "--help" && arg !== "-h"));
      const root = positionals[0];
      const path = root !== undefined && Object.hasOwn(COMMAND_DEFINITIONS, root)
        ? [root] : positionals.slice(0, 2);
      process.stdout.write(cliHelp(path) + "\n");
      return 0;
    }
    cli = parseCli(argv);
  } catch (error) {
    reportError(error, json);
    return 2;
  }
  try {
    Object.assign(cli, resolveWalletConnection(cli));
    const onRequest = !cli.json && process.stderr.isTTY && process.stdin.isTTY ? () => {
      const started = Date.now();
      const timer = setInterval(() => process.stderr.write(`Waiting for wallet service (${Math.floor((Date.now() - started) / 1000)}s elapsed)…\n`), 2000);
      timer.unref();
      return () => clearInterval(timer);
    } : undefined;
    const client = new WalletHttpClient(cli.url, cli.token, onRequest);
    const onboarding = cli.command === "wallet" && cli.subcommand !== "list" && !cli.dev;
    const out = onboarding ? await onboardWallet(cli, client) : await client.dispatch(cli);
    process.stdout.write((cli.json ? JSON.stringify(out, jsonSafe) : renderResult(cli, out)) + "\n");
    return 0;
  } catch (error) {
    reportError(error, cli.json);
    return 1;
  }
}
