import { createInterface } from "node:readline";
import { Writable } from "node:stream";

export function hasInteractiveTerminal(): boolean {
  return process.stdin.isTTY === true && process.stderr.isTTY === true;
}

/** Read secrets without terminal echo or readline history. */
export function promptSecret(question: string): Promise<string> {
  if (!hasInteractiveTerminal()) throw new Error("secret input requires an interactive terminal");
  const muted = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const readline = createInterface({ input: process.stdin, output: muted, terminal: true, historySize: 0 });
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (value?: string) => {
      if (settled) return;
      settled = true;
      readline.close();
      muted.end();
      process.stderr.write("\n");
      if (value === undefined) reject(new Error("secret input canceled"));
      else resolve(value);
    };
    readline.once("SIGINT", () => finish());
    readline.once("close", () => finish());
    readline.question("", (answer) => finish(answer));
    process.stderr.write(question);
  });
}
