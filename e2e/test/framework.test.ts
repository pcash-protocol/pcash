import { access, lstat, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { connect, createServer } from "node:net";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { preparePrivateRunDirectory, ScenarioArtifacts } from "../src/framework/artifacts.ts";
import { E2E_WORKSPACE_BUILDS } from "../src/framework/build.ts";
import { parseJsonOutput, runCommand, runSuccessfulCommand } from "../src/framework/command.ts";
import { eventually, EventuallyTimeoutError } from "../src/framework/eventually.ts";
import { leasePorts } from "../src/framework/ports.ts";
import { ManagedProcess, ProcessRegistry } from "../src/framework/process.ts";
import { redactEvidence, redactText } from "../src/framework/redact.ts";

describe("framework primitives", () => {
  it("builds the emitted JavaScript workspaces used by E2E scenarios", async () => {
    expect(E2E_WORKSPACE_BUILDS).toEqual([
      "@pcash/sdk",
      "@pcash/wallet",
      "@pcash/relayer",
      "@pcash/marketplace",
      "@pcash/tokens",
      "@pcash/lineage",
      "@pcash/board",
    ]);
    for (const workspace of E2E_WORKSPACE_BUILDS) {
      const manifest = JSON.parse(await readFile(new URL(`../../node_modules/${workspace}/package.json`, import.meta.url), "utf8"));
      expect(manifest.scripts?.build, `${workspace} must declare the invoked build script`).toBeTypeOf("string");
    }
  });

  it("leases distinct free ports until release", async () => {
    const lease = await leasePorts(4);
    expect(new Set(lease.ports).size).toBe(4);
    expect(lease.ports.every((port) => port > 0 && port <= 65_535)).toBe(true);
    await expect(new Promise<void>((resolve, reject) => {
      const contender = createServer();
      contender.once("error", reject);
      contender.listen({ host: "127.0.0.1", port: lease.ports[0]!, exclusive: true }, () => {
        contender.close(() => resolve());
      });
    })).rejects.toMatchObject({ code: "EADDRINUSE" });
    await lease.releasePort(lease.ports[0]!);
    await lease.releasePort(lease.ports[0]!);
    await expect(new Promise<void>((resolve, reject) => {
      const contender = createServer();
      contender.once("error", reject);
      contender.listen({ host: "127.0.0.1", port: lease.ports[0]!, exclusive: true }, () => {
        contender.close(() => resolve());
      });
    })).resolves.toBeUndefined();
    await expect(lease.releasePort(1)).rejects.toThrow(/does not belong/);
    await lease.release();
    await lease.release();
  });

  it("releases a leased port while a stray client is connected to it", async () => {
    const lease = await leasePorts(1);
    const port = lease.ports[0]!;
    const stray = connect({ host: "127.0.0.1", port });
    stray.on("error", () => undefined);
    await new Promise<void>((resolve) => stray.once("connect", resolve));
    stray.write("POST / HTTP/1.1\r\nhost: 127.0.0.1\r\ncontent-length: 0\r\n\r\n");
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    const released = lease.releasePort(port).then(() => "released" as const);
    const timeout = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 5_000).unref());
    await expect(Promise.race([released, timeout])).resolves.toBe("released");
    await new Promise<void>((resolve) => (stray.closed ? resolve() : stray.once("close", resolve)));
    await lease.release();
  });

  it("polls to success and retains the last timeout observation", async () => {
    let count = 0;
    await expect(eventually("three observations", () => ++count, (value) => value === 3, {
      timeoutMs: 100,
      intervalMs: 1,
    })).resolves.toBe(3);
    const failure = await eventually("impossible value", () => ({ count: ++count }), () => false, {
      timeoutMs: 5,
      intervalMs: 1,
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(EventuallyTimeoutError);
    expect((failure as EventuallyTimeoutError).lastObservation).toMatchObject({ count: expect.any(Number) });
    expect((failure as Error).message).toContain("last observation");
  });

  it("cancels readiness when a managed process exits and preserves its log", async () => {
    const root = await mkdtemp(join(tmpdir(), "pcash-process-test-"));
    const processHandle = await ManagedProcess.start({
      name: "short-lived",
      command: process.execPath,
      args: ["-e", "process.stderr.write('useful failure\\n'); process.exit(7)"],
      cwd: root,
      logPath: join(root, "short-lived.log"),
    });
    await processHandle.exited;
    expect(processHandle.cancellationReason()).toContain("exit 7");
    expect(await processHandle.tail()).toContain("useful failure");
    await processHandle.stop();
  });

  it("tears down a running process tree", async () => {
    const root = await mkdtemp(join(tmpdir(), "pcash-registry-test-"));
    const registry = new ProcessRegistry();
    const processHandle = await registry.start({
      name: "long-lived",
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: root,
      logPath: join(root, "long-lived.log"),
    });
    expect(processHandle.running).toBe(true);
    await registry.stopAll();
    expect(processHandle.running).toBe(false);
  });

  it("parses exact JSON and exposes command exit evidence", async () => {
    const result = await runCommand(process.execPath, ["-e", "process.stdout.write(JSON.stringify({ok:true}))"], {
      cwd: process.cwd(),
    });
    expect(parseJsonOutput(result)).toEqual({ ok: true });
    const failed = await runCommand(process.execPath, ["-e", "process.stderr.write('nope');process.exit(3)"], {
      cwd: process.cwd(),
    });
    expect(failed).toMatchObject({ exitCode: 3, stderr: "nope" });
  });

  it("aborts a running command and preserves the caller's shutdown reason", async () => {
    const controller = new AbortController();
    const reason = new Error("supervisor shutdown");
    const command = runSuccessfulCommand(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { cwd: process.cwd(), signal: controller.signal, timeoutMs: 10_000 },
    );
    setTimeout(() => controller.abort(reason), 20);
    await expect(command).rejects.toBe(reason);
  });

  it("redacts credentials in logs and structured evidence", () => {
    const key = `0x${"12".repeat(32)}`;
    expect(redactText(`Bearer abc privateKey=${key} https://rpc/x?api_key=secret`)).not.toContain("secret");
    expect(redactText(`transactionId=${key}`)).toContain(key);
    expect(redactEvidence({ privateKey: key, nested: { token: "abc" } })).toEqual({
      privateKey: "[REDACTED]",
      nested: { token: "[REDACTED]" },
    });
  });

  it("cleans successful artifacts and preserves failed artifacts", async () => {
    const clean = await ScenarioArtifacts.create("clean");
    const cleanPath = clean.root;
    expect((await clean.finish()).preserved).toBe(false);
    await expect(access(cleanPath)).rejects.toThrow();

    const failed = await ScenarioArtifacts.create("failed");
    failed.record("secret", { privateKey: `0x${"34".repeat(32)}` });
    const result = await failed.finish(new Error("boom"));
    expect(result.preserved).toBe(true);
    const evidence = await readFile(join(result.path, "evidence.json"), "utf8");
    expect(evidence).toContain("boom");
    expect(evidence).not.toContain("34343434");
  });

  it("accepts only new or empty private output directories", async () => {
    const parent = await mkdtemp(join(tmpdir(), "pcash-output-test-"));
    const created = await preparePrivateRunDirectory(join(parent, "new-run"));
    expect((await stat(created)).mode & 0o777).toBe(0o700);

    const empty = join(parent, "empty-run");
    await mkdir(empty, { mode: 0o755 });
    await expect(preparePrivateRunDirectory(empty)).resolves.toBe(empty);
    expect((await stat(empty)).mode & 0o777).toBe(0o700);

    const occupied = join(parent, "occupied-run");
    await mkdir(occupied);
    await writeFile(join(occupied, "existing"), "keep");
    await expect(preparePrivateRunDirectory(occupied)).rejects.toThrow(/newly created or empty/);

    const linked = join(parent, "linked-run");
    await import("node:fs/promises").then(({ symlink }) => symlink(empty, linked));
    await expect(preparePrivateRunDirectory(linked)).rejects.toThrow(/ordinary directory/);
    expect((await lstat(linked)).isSymbolicLink()).toBe(true);
  });
});
