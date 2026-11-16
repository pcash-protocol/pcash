import { execFile } from "node:child_process";
import { redactText } from "./redact.ts";

export interface CommandResult {
  command: string;
  args: readonly string[];
  exitCode: number;
  stdout: string;
  stderr: string;
}

export class CommandFailure extends Error {
  readonly result: CommandResult;

  constructor(result: CommandResult) {
    super(`${result.command} exited ${result.exitCode}: ${redactText(result.stderr.trim())}`);
    this.name = "CommandFailure";
    this.result = result;
  }
}

export interface RunCommandOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export function runCommand(
  command: string,
  args: readonly string[],
  options: RunCommandOptions,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(command, [...args], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      timeout: options.timeoutMs ?? 120_000,
      signal: options.signal,
      maxBuffer: 128 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      const code = error === null
        ? 0
        : typeof error.code === "number"
          ? error.code
          : 1;
      resolve({
        command,
        args,
        exitCode: code,
        stdout: stdout.toString(),
        stderr: stderr.toString(),
      });
    });
  });
}

export async function runSuccessfulCommand(
  command: string,
  args: readonly string[],
  options: RunCommandOptions,
): Promise<CommandResult> {
  const result = await runCommand(command, args, options);
  if (options.signal?.aborted === true) {
    throw options.signal.reason ?? new Error(`${command} aborted`);
  }
  if (result.exitCode !== 0) throw new CommandFailure(result);
  return result;
}

export function parseJsonOutput<T>(result: Pick<CommandResult, "command" | "stdout" | "stderr" | "exitCode" | "args">): T {
  const text = result.stdout.trim();
  if (text === "") throw new Error(`${result.command} produced no JSON output`);
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new Error(`${result.command} produced malformed JSON: ${redactText(text.slice(0, 500))}`, { cause: error });
  }
}

export async function expectCommandFailure(
  command: string,
  args: readonly string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; stderr?: RegExp },
): Promise<CommandResult> {
  const result = await runCommand(command, args, options);
  if (result.exitCode === 0) throw new Error(`${command} unexpectedly succeeded`);
  if (options.stderr !== undefined && !options.stderr.test(result.stderr)) {
    throw new Error(
      `${command} failed, but stderr did not match ${String(options.stderr)}: ${redactText(result.stderr)}`,
    );
  }
  return result;
}
