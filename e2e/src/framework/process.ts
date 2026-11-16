import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, promises as fs } from "node:fs";
import type { WriteStream } from "node:fs";
import { dirname } from "node:path";
import { redactText } from "./redact.ts";

export interface StartProcessOptions {
  name: string;
  command: string;
  args?: readonly string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  logPath: string;
}

export class ManagedProcess {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly logPath: string;
  readonly child: ChildProcess;
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  #log: WriteStream;
  #expectedStop = false;

  private constructor(options: StartProcessOptions, child: ChildProcess, log: WriteStream) {
    this.name = options.name;
    this.command = options.command;
    this.args = options.args ?? [];
    this.logPath = options.logPath;
    this.child = child;
    this.#log = log;
    this.exited = new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve({ code: child.exitCode, signal: child.signalCode });
      } else {
        child.once("exit", (code, signal) => resolve({ code, signal }));
      }
    });
  }

  static async start(options: StartProcessOptions): Promise<ManagedProcess> {
    await fs.mkdir(dirname(options.logPath), { recursive: true, mode: 0o700 });
    const log = createWriteStream(options.logPath, { flags: "a", mode: 0o600 });
    const child = spawn(options.command, [...(options.args ?? [])], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.pipe(log, { end: false });
    child.stderr?.pipe(log, { end: false });
    await new Promise<void>((resolve, reject) => {
      const onSpawn = () => {
        child.off("error", onError);
        resolve();
      };
      const onError = (error: Error) => {
        child.off("spawn", onSpawn);
        log.end();
        reject(new Error(`failed to start ${options.name}: ${error.message}`, { cause: error }));
      };
      child.once("spawn", onSpawn);
      child.once("error", onError);
    });
    return new ManagedProcess(options, child, log);
  }

  get running(): boolean {
    return this.child.exitCode === null && this.child.signalCode === null;
  }

  cancellationReason(): string | null {
    if (this.running || this.#expectedStop) return null;
    return `${this.name} exited prematurely (${this.exitDescription()}); log: ${this.logPath}`;
  }

  assertRunning(): void {
    const reason = this.cancellationReason();
    if (reason !== null) throw new Error(reason);
  }

  async tail(lines = 40): Promise<string> {
    try {
      const text = await fs.readFile(this.logPath, "utf8");
      return redactText(text.split(/\r?\n/).slice(-lines).join("\n"));
    } catch {
      return "<log unavailable>";
    }
  }

  async stop(graceMs = 10_000): Promise<void> {
    this.#expectedStop = true;
    if (this.running) {
      this.signal("SIGTERM");
      const exited = await Promise.race([
        this.exited.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), graceMs)),
      ]);
      if (!exited && this.running) {
        this.signal("SIGKILL");
        await this.exited;
      }
    }
    await new Promise<void>((resolve) => this.#log.end(resolve));
  }

  private signal(signal: NodeJS.Signals): void {
    if (this.child.pid === undefined) return;
    try {
      if (process.platform === "win32") this.child.kill(signal);
      else process.kill(-this.child.pid, signal);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ESRCH") throw error;
    }
  }

  private exitDescription(): string {
    if (this.child.exitCode !== null) return `exit ${this.child.exitCode}`;
    if (this.child.signalCode !== null) return `signal ${this.child.signalCode}`;
    return "unknown status";
  }
}

export class ProcessRegistry {
  #processes: ManagedProcess[] = [];

  async start(options: StartProcessOptions): Promise<ManagedProcess> {
    const processHandle = await ManagedProcess.start(options);
    this.#processes.push(processHandle);
    return processHandle;
  }

  forget(processHandle: ManagedProcess): void {
    this.#processes = this.#processes.filter((item) => item !== processHandle);
  }

  async stop(processHandle: ManagedProcess): Promise<void> {
    await processHandle.stop();
    this.forget(processHandle);
  }

  async stopAll(): Promise<void> {
    const processes = this.#processes.splice(0).reverse();
    const failures: unknown[] = [];
    for (const processHandle of processes) {
      try {
        await processHandle.stop();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, "one or more E2E processes failed to stop");
  }
}
