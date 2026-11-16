import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, relative, sep } from "node:path";

function repositoryRelativePath(repoRoot, path) {
  return relative(repoRoot, path).split(sep).join("/");
}

export function withoutGitIgnoredFiles(repoRoot, paths) {
  if (paths.length === 0 || !existsSync(join(repoRoot, ".git"))) return paths;
  const relativePaths = paths.map((path) => repositoryRelativePath(repoRoot, path));
  const result = spawnSync("git", [
    "-C",
    repoRoot,
    "--literal-pathspecs",
    "ls-files",
    "--others",
    "--ignored",
    "--exclude-standard",
    "-z",
    "--",
    ...relativePaths,
  ], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    const detail = result.stderr.trim() || `git exited ${String(result.status)}`;
    throw new Error(`could not inspect ignored files under ${repoRoot}: ${detail}`);
  }
  const ignored = new Set(result.stdout.split("\0").filter(Boolean));
  return paths.filter((path) => !ignored.has(repositoryRelativePath(repoRoot, path)));
}
