import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, expect, test, vi } from "vitest";

vi.mock("@noir-lang/noir_js", () => ({
  Noir: class {
    async execute(): Promise<{ witness: Uint8Array }> {
      return { witness: gzipSync(Uint8Array.of(9)) };
    }
  },
}));

import { computeChonkVk, proveChonkStack, type NativeChonkStep } from "../src/prover/chonk.ts";

const inheritedCrsPath = process.env.CRS_PATH;
const directories: string[] = [];
const processes: number[] = [];

afterEach(() => {
  if (inheritedCrsPath === undefined) delete process.env.CRS_PATH;
  else process.env.CRS_PATH = inheritedCrsPath;
  for (const pid of processes.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "pcash-native-bb-"));
  directories.push(directory);
  return directory;
}

/** A bb that records one environment variable and exits before serving. */
function recordingBb(directory: string, variable: string): { bbPath: string; seen: string } {
  const bbPath = join(directory, "bb");
  const seen = join(directory, "seen");
  writeFileSync(bbPath, `#!/bin/sh\nprintf '%s' "$${variable}" > '${seen}'\nexit 1\n`);
  chmodSync(bbPath, 0o755);
  return { bbPath, seen };
}

test("native bb reads the backend's checked CRS directory, not an inherited CRS_PATH", async () => {
  const directory = temporaryDirectory();
  const { bbPath, seen } = recordingBb(directory, "CRS_PATH");
  process.env.CRS_PATH = join(directory, "unchecked");

  const crsPath = join(directory, "checked");
  await expect(computeChonkVk("probe", { bytecode: "" }, "app", { kind: "native", bbPath, crsPath }))
    .rejects.toThrow(/bb process exited/);
  expect(readFileSync(seen, "utf8")).toBe(crsPath);
});

test.each([
  // bb.js's default: one thread per core, up to 16.
  { threads: undefined, expected: String(Math.min(16, cpus().length)) },
  { threads: 3, expected: "3" },
])("native bb runs $expected threads when the backend sets $threads", async ({ threads, expected }) => {
  const directory = temporaryDirectory();
  const { bbPath, seen } = recordingBb(directory, "HARDWARE_CONCURRENCY");
  const backend = { kind: "native" as const, bbPath, crsPath: directory, ...(threads === undefined ? {} : { threads }) };
  await expect(computeChonkVk("probe", { bytecode: "" }, "app", backend)).rejects.toThrow(/bb process exited/);
  expect(readFileSync(seen, "utf8")).toBe(expected);
});

test("aborting a native proof kills bb mid-command and rejects with the abort reason", async () => {
  const directory = temporaryDirectory();
  const record = join(directory, "record.json");
  // Serves bb.js's socket and never answers. Like bb mid-command, it ignores
  // SIGTERM, so only a kill stops it.
  writeFileSync(join(directory, "bb.mjs"), `
import { writeFileSync } from "node:fs";
import { createServer } from "node:net";
process.on("SIGTERM", () => {});
setTimeout(() => process.exit(0), 30_000);
const socket = process.argv[process.argv.indexOf("--input") + 1];
writeFileSync(${JSON.stringify(record)}, JSON.stringify({ pid: process.pid, socket }));
createServer((connection) => connection.resume()).listen(socket);
`);
  const bbPath = join(directory, "bb");
  writeFileSync(bbPath, `#!/bin/sh\nexec '${process.execPath}' '${join(directory, "bb.mjs")}' "$@"\n`);
  chmodSync(bbPath, 0o755);

  const steps: NativeChonkStep[] = (["app", "kernel", "kernel", "hiding"] as const).map((kind, index) => ({
    name: `step-${index}`,
    kind,
    artifact: { bytecode: gzipSync(Uint8Array.of(1)).toString("base64"), abi: {} },
    witnessMap: {},
    verificationKey: new Uint8Array(),
  }));
  const controller = new AbortController();
  const reason = new Error("proof canceled");
  const proof = proveChonkStack(steps, [], { kind: "native", bbPath, crsPath: directory }, {
    signal: controller.signal,
    onProgress: (progress) => {
      // chonkStart is in flight at bb, which will never answer it.
      if (progress.operation === "start" && progress.durationMs === undefined) {
        setTimeout(() => controller.abort(reason), 100);
      }
    },
  });
  await expect(proof).rejects.toBe(reason);

  const { pid, socket } = JSON.parse(readFileSync(record, "utf8")) as { pid: number; socket: string };
  processes.push(pid);
  // The kill closes the socket first, so the exit may not be reaped yet.
  await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(/ESRCH/));
  expect(existsSync(socket)).toBe(false);
});
