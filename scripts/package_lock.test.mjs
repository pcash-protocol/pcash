import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const { packages } = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package-lock.json"), "utf8"));

// npm ci checks a tarball against the lockfile's integrity when it has one and
// otherwise accepts whatever the registry serves.
test("every registry package in package-lock.json pins its tarball and integrity", () => {
  const unpinned = Object.entries(packages)
    .filter(([path, entry]) => path.includes("node_modules/") && !entry.link && !(entry.resolved && entry.integrity))
    .map(([path]) => path);
  assert.deepEqual(unpinned, []);
});
