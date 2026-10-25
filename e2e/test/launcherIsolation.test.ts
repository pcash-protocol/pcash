import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const E2E_ROOT = fileURLToPath(new URL("..", import.meta.url));
const HOOKS = "./test/support/rejectWorkspaceImports.mjs";

async function runLauncher(entry: string, args: readonly string[]): Promise<string> {
  try {
    const { stderr } = await execFileAsync(
      process.execPath,
      ["--import", HOOKS, entry, ...args],
      { cwd: E2E_ROOT, timeout: 60_000 },
    );
    return stderr;
  } catch (error) {
    return String((error as { stderr?: string }).stderr ?? error);
  }
}

// The launcher builds the workspace packages before anything runs, so it must reach option
// validation without resolving a single one of them. Loading any @pcash/* package here means
// the launcher depends on dist output that does not exist yet on a fresh checkout.
describe("E2E launcher isolation", () => {
  it("run.ts validates a scenario without loading a workspace package", async () => {
    const stderr = await runLauncher("src/run.ts", ["definitely-not-a-scenario"]);
    expect(stderr).toContain("unknown E2E scenario definitely-not-a-scenario");
    expect(stderr).not.toContain("launcher resolved workspace package");
  });

  it("run.ts refuses a local-only scenario in live mode without loading a workspace package", async () => {
    const stderr = await runLauncher("src/run.ts", ["--network", "live", "p2p"]);
    expect(stderr).toContain("scenario p2p needs a local network");
    expect(stderr).not.toContain("launcher resolved workspace package");
  });
});
