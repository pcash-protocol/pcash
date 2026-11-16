#!/usr/bin/env node
// Install the prover toolchain that assets/prover-toolchain.json pins under the
// tool root. With --check, verify the installation without touching the network.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, createWriteStream, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Logger } from "../sdk/src/blgr/index.ts";
import {
  TOOLCHAIN,
  assertToolchain,
  pinnedComponents,
  platformKey,
  readToolchainReceipt,
  staleToolchainComponents,
  toolPaths,
  toolRoot,
} from "../sdk/src/node/toolchain.ts";

const logger = new Logger("info");
await logger.open();

// No pinned download is near this size; it bounds what an unranged response can write.
const MAX_DOWNLOAD_BYTES = 1024 ** 3;

/**
 * Download `pin.url` to `destination`, replacing it only once the bytes match
 * `pin.sha256`. With `pin.bytes`, request exactly that prefix.
 */
export async function fetchVerified(pin, destination, fetcher = fetch) {
  const response = await fetcher(pin.url, pin.bytes === undefined ? {} : { headers: { Range: `bytes=0-${pin.bytes - 1}` } });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error(`download failed (${response.status}) for ${pin.url}`);
  }
  const limit = pin.bytes ?? MAX_DOWNLOAD_BYTES;
  const temporary = `${destination}.${process.pid}.tmp`;
  const hash = createHash("sha256");
  let length = 0;
  try {
    await pipeline(
      Readable.fromWeb(response.body),
      new Transform({
        transform(chunk, _encoding, callback) {
          length += chunk.length;
          if (length > limit) {
            callback(new Error(`${pin.url} sent more than the ${limit} bytes expected`));
            return;
          }
          hash.update(chunk);
          callback(null, chunk);
        },
      }),
      createWriteStream(temporary),
    );
    const digest = hash.digest("hex");
    if (digest !== pin.sha256) throw new Error(`digest mismatch for ${pin.url}: expected ${pin.sha256}, got ${digest}`);
    renameSync(temporary, destination);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/** Whether `--version` output names the release the manifest gives for an archive's binary. */
const reportsRelease = {
  nargo: (report) => report.includes(`nargo version = ${TOOLCHAIN.nargo.version}`)
    && report.includes(`noirc version = ${TOOLCHAIN.nargo.version}+${TOOLCHAIN.nargo.noircCommit}`),
  barretenberg: (report) => report.trim() === TOOLCHAIN.barretenberg.version,
};

/**
 * Replace the directory holding `binary` with the contents of `component`'s
 * pinned archive, once the binary in it has the pinned digest and reports the
 * release the manifest names. Every later use identifies the binary by that
 * digest.
 */
async function installArchive(component, pin, binary, fetcher) {
  const directory = dirname(binary);
  const staging = `${directory}.${process.pid}.tmp`;
  const archive = `${staging}.tar.gz`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  try {
    await fetchVerified(pin, archive, fetcher);
    execFileSync("tar", ["-xzf", archive, "-C", staging], { stdio: "inherit" });
    const extracted = join(staging, basename(binary));
    chmodSync(extracted, 0o755);
    const digest = createHash("sha256").update(readFileSync(extracted)).digest("hex");
    if (digest !== pin.binarySha256) {
      throw new Error(`binary digest mismatch for ${basename(binary)} in ${pin.url}: expected ${pin.binarySha256}, got ${digest}`);
    }
    const report = execFileSync(extracted, ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
    if (!reportsRelease[component](report)) {
      throw new Error(`${basename(binary)} in ${pin.url} does not report the version assets/prover-toolchain.json gives for it`);
    }
    rmSync(directory, { recursive: true, force: true });
    renameSync(staging, directory);
  } finally {
    rmSync(archive, { force: true });
    rmSync(staging, { recursive: true, force: true });
  }
}

function writeReceipt(root, receipt) {
  const { receipt: path } = toolPaths(root);
  writeFileSync(`${path}.tmp`, `${JSON.stringify(receipt, null, 2)}\n`);
  renameSync(`${path}.tmp`, path);
}

/** Install every component at `root` that is not the pinned one; a current installation needs no network. */
export async function installToolchain(root = toolRoot(), fetcher = fetch) {
  const stale = staleToolchainComponents(root);
  if (stale.length === 0) return;
  const paths = toolPaths(root);
  const pins = pinnedComponents();
  const receipt = readToolchainReceipt(root) ?? {};
  mkdirSync(paths.crs, { recursive: true });
  for (const component of stale) {
    logger.info(`Installing ${component} for ${platformKey()} in ${root}`);
    // Drop the entry first: the receipt never names bytes other than the ones in place.
    delete receipt[component];
    writeReceipt(root, receipt);
    if (component === "nargo") await installArchive(component, pins.nargo, paths.nargo, fetcher);
    else if (component === "barretenberg") await installArchive(component, pins.barretenberg, paths.bb, fetcher);
    else await fetchVerified(pins[component], paths[component], fetcher);
    receipt[component] = pins[component].sha256;
    writeReceipt(root, receipt);
  }
}

async function main(args) {
  if (args.some((arg) => arg !== "--check")) {
    throw new Error("usage: node scripts/bootstrap_prover_toolchain.mjs [--check]");
  }
  const root = toolRoot();
  if (args.length === 0) await installToolchain(root);
  const paths = assertToolchain(root);
  logger.info(`PCASH prover toolchain ready (${platformKey()})\n`
    + `  root:  ${root}\n`
    + `  nargo: ${paths.nargo}\n`
    + `  bb:    ${paths.bb}\n`
    + `  CRS:   ${paths.crs}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    logger.error(error.message);
    process.exitCode = 1;
  });
}
