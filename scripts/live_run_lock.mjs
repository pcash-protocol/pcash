// Live runs resolve imports throughout their lifetime. `npm install` can
// replace node_modules while a run is active, so the root preinstall script
// checks this lock before changing the dependency tree.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Config } from "../sdk/src/bcfg/index.ts";
import { Logger } from "../sdk/src/blgr/index.ts";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const logger = new Logger("info");
await logger.open();
// Tests set PCASH_LIVE_RUN_LOCK to isolate their lock from live runs.
const config = new Config("pcash");
config.load({ argv: true, env: true });
const LOCK_PATH = config.str("live-run-lock", join(REPO_ROOT, ".cache", "pcash", "live-run.lock"));

function readLock() {
  let lock;
  try {
    lock = JSON.parse(readFileSync(LOCK_PATH, "utf8"));
  } catch {
    return null;
  }
  return Number.isSafeInteger(lock?.pid) ? lock : null;
}

/** EPERM means the pid is alive and owned by somebody else. */
function holderIsRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function describe(lock) {
  return `${lock.label ?? "a live run"} (pid ${lock.pid}, started ${lock.startedAt})`;
}

/** A lock whose holder is gone is stale: the run was killed before its trap ran. */
function clearStaleLock() {
  const lock = readLock();
  if (lock !== null && holderIsRunning(lock.pid)) return lock;
  rmSync(LOCK_PATH, { force: true });
  return null;
}

function check() {
  const lock = clearStaleLock();
  if (lock === null) return;
  logger.error(
    `refusing to touch node_modules while ${describe(lock)} is running.\n`
    + "That run resolves modules out of this tree until it finishes; reifying now breaks it.\n"
    + `Wait for it to finish, or stop it and delete ${LOCK_PATH}.`,
  );
  process.exitCode = 1;
}

function take(pid, label) {
  if (!Number.isSafeInteger(Number(pid))) throw new Error("live_run_lock take needs a pid");
  const held = clearStaleLock();
  if (held !== null) {
    logger.error(`another live run holds the lock: ${describe(held)}`);
    process.exitCode = 1;
    return;
  }
  mkdirSync(dirname(LOCK_PATH), { recursive: true });
  const lock = { pid: Number(pid), label, startedAt: new Date().toISOString() };
  try {
    writeFileSync(LOCK_PATH, `${JSON.stringify(lock, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    logger.error(`another live run took the lock first: ${describe(readLock() ?? lock)}`);
    process.exitCode = 1;
  }
}

/** Only the holder releases, so a late trap cannot unlock the next run. */
function release(pid) {
  const lock = readLock();
  if (lock === null || lock.pid !== Number(pid)) return;
  rmSync(LOCK_PATH, { force: true });
}

const [command, ...rest] = config.argv;
switch (command ?? "check") {
  case "check":
    check();
    break;
  case "take":
    take(rest[0], rest[1] ?? "a live run");
    break;
  case "release":
    release(rest[0]);
    break;
  default:
    logger.error(`unknown live_run_lock command: ${command}`);
    process.exitCode = 2;
}
