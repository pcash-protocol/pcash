#!/usr/bin/env node
import { runWalletCli } from "./run.ts";

const argv = process.argv.slice(2);
runWalletCli(argv).then(
  code => { process.exitCode = code; },
  error => {
    const message = `fatal: ${error instanceof Error ? error.message : String(error)}`;
    process.stderr.write((argv.includes("--json") || argv.includes("--json=true")
      ? JSON.stringify({ error: message }) : `pcash-wallet-cli: ${message}`) + "\n");
    process.exitCode = 1;
  },
);
