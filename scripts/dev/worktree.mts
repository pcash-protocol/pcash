import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "../..");

/** Install missing dependencies in this checkout so workspace imports stay local. */
export function prepareWorktree(repoRoot: string = REPO_ROOT): void {
  if (existsSync(join(repoRoot, "node_modules"))) return;
  const result = spawnSync("npm", ["ci"], {
    cwd: repoRoot,
    // Bundle commands reserve stdout for paths and input filenames.
    stdio: ["inherit", 2, "inherit"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`npm ci failed with status ${result.status}`);
}
