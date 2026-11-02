import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const script = join(dirname(fileURLToPath(import.meta.url)), "live_run_lock.mjs");
// Above the maximum pid on every platform this runs on, so it names no process.
const DEAD_PID = 2_147_483_647;

function lockFile() {
  return join(mkdtempSync(join(tmpdir(), "pcash-live-run-lock-")), "live-run.lock");
}

function run(path, args) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    env: { ...process.env, PCASH_LIVE_RUN_LOCK: path },
  });
}

test("check passes when no run holds the lock", () => {
  assert.equal(run(lockFile(), ["check"]).status, 0);
});

test("a held lock refuses the next install and the next run", () => {
  const path = lockFile();
  assert.equal(run(path, ["take", String(process.pid), "a live run"]).status, 0);
  assert.ok(existsSync(path));

  const checked = run(path, ["check"]);
  assert.equal(checked.status, 1);
  assert.match(checked.stderr, /refusing to touch node_modules/);
  assert.match(checked.stderr, new RegExp(`pid ${process.pid}`));

  assert.equal(run(path, ["take", String(process.pid), "a second run"]).status, 1);
});

test("only the holder releases the lock", () => {
  const path = lockFile();
  run(path, ["take", String(process.pid), "a live run"]);

  assert.equal(run(path, ["release", String(DEAD_PID)]).status, 0);
  assert.ok(existsSync(path), "a non-holder must not release the lock");

  assert.equal(run(path, ["release", String(process.pid)]).status, 0);
  assert.ok(!existsSync(path));
  assert.equal(run(path, ["check"]).status, 0);
});

test("a lock whose run is gone is stale, not a block", () => {
  const path = lockFile();
  writeFileSync(path, JSON.stringify({ pid: DEAD_PID, label: "a killed run", startedAt: "2026-01-01T00:00:00.000Z" }));

  assert.equal(run(path, ["check"]).status, 0);
  assert.ok(!existsSync(path));
});

test("an unreadable lock does not wedge installs", () => {
  const path = lockFile();
  writeFileSync(path, "{ not json");

  assert.equal(run(path, ["check"]).status, 0);
  assert.ok(!existsSync(path));
});
