import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { randomInt } from "node:crypto";
import { generateWalletMnemonic, normalizeWalletMnemonic, validateWalletMnemonic } from "@pcash/sdk/wallet";
import { hasInteractiveTerminal, promptSecret } from "@pcash/sdk/wallet/node";
import type { Cli } from "./cli.ts";
import type { WalletHttpClient } from "./client.ts";

export interface WalletOnboardingTerminal {
  interactive: boolean;
  write(text: string): void;
  readSecret(question: string): Promise<string>;
}

export async function readWalletSeedFile(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error("seed file must be a regular file");
    if ((stat.mode & 0o077) !== 0) throw new Error("seed file must be private; use chmod 600 on the selected file");
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      throw new Error("seed file must be owned by the current user");
    }
    if (stat.size > 4096) throw new Error("seed file is too large for a recovery phrase");
    return await file.readFile("utf8");
  } finally {
    await file.close();
  }
}

function checkedMnemonic(input: string): string {
  if (!validateWalletMnemonic(input)) throw new Error("recovery phrase must be a valid 24-word English BIP-39 mnemonic");
  return normalizeWalletMnemonic(input);
}

/** Complete backup verification before the service receives a new wallet. */
export async function onboardWallet(
  cli: Cli,
  client: Pick<WalletHttpClient, "preflightOnboarding" | "importMnemonic">,
  terminal: WalletOnboardingTerminal = {
    interactive: hasInteractiveTerminal(),
    write: (text) => { process.stderr.write(text); },
    readSecret: promptSecret,
  },
): Promise<unknown> {
  await client.preflightOnboarding();
  let mnemonic: string;
  if (cli.subcommand === "create") {
    if (!terminal.interactive) throw new Error("wallet create requires an interactive terminal to display and verify the recovery phrase");
    mnemonic = generateWalletMnemonic();
    const words = mnemonic.split(" ");
    terminal.write("Write down all 24 recovery words in order and keep them private. They recover this wallet without the vault password.\n\n");
    terminal.write(words.map((word, index) => `${index + 1}. ${word}`).join("\n") + "\n\n");
    const remaining = words.map((_, index) => index);
    for (let challenge = 0; challenge < 3; challenge++) {
      const position = remaining.splice(randomInt(remaining.length), 1)[0]!;
      while (normalizeWalletMnemonic(await terminal.readSecret(`Enter recovery word #${position + 1}: `)) !== words[position]) {
        terminal.write("That word did not match. Try the same position again, or press Ctrl+C to cancel.\n");
      }
    }
  } else if (cli.subcommand === "import") {
    if (cli.seedFile === undefined && !terminal.interactive) {
      throw new Error("wallet import requires an interactive terminal or --seed-file pointing to a private local text file");
    }
    mnemonic = checkedMnemonic(cli.seedFile === undefined
      ? await terminal.readSecret("Enter your 24-word recovery phrase: ")
      : await readWalletSeedFile(cli.seedFile));
  } else {
    throw new Error("wallet onboarding expects create or import");
  }
  return client.importMnemonic(mnemonic);
}
