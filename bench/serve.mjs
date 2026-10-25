#!/usr/bin/env node

import { execFile, execFileSync, spawn } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Config } from "@pcash/sdk/bcfg";
import { Logger } from "@pcash/sdk/blgr";
import { assertToolchain } from "@pcash/sdk/node/toolchain";
import { ensureCircuitBundle } from "../scripts/circuits/bundle.mjs";
import { circuitCatalog } from "../scripts/circuits/catalog.mjs";

const logger = new Logger("info");
await logger.open();
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const labRoot = join(here, "app");
const config = new Config("pcash");
config.load({ argv: true, env: true });
if (config.argv.length !== 0 || Object.keys(config.args).some((key) => key !== "tunnel")) {
  throw new Error("usage: npm run bench -- [--tunnel]");
}
const tunnel = config.bool("tunnel", false);

const bundle = ensureCircuitBundle();
const tools = assertToolchain();
const scratch = mkdtempSync(join(tmpdir(), "pcash-proof-lab-"));
const publicDir = join(scratch, "public");
const distDir = join(scratch, "dist");
const resultsDir = resolve(config.str("proof-lab-results", join(here, "results")));
mkdirSync(join(publicDir, "crs"), { recursive: true });

// Every circuit in the working-tree bundle, test fixtures included: the lab
// measures what could be built, not only what is released.
const circuits = circuitCatalog(root);
const artifacts = [];
for (const circuit of circuits) {
  for (const [source, logicalPath] of [
    [join(bundle, circuit.proverArtifactPath), `/prover/${circuit.artifactId}.json`],
    [join(bundle, circuit.verificationKeyPath), `/chonk-vks/${circuit.artifactId}.vk`],
  ]) {
    const destination = join(publicDir, logicalPath);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(source, destination);
    artifacts.push(logicalPath);
  }
}
const run = promisify(execFile);
const gates = Object.fromEntries(await Promise.all(circuits.map(async (circuit) => {
  const { stdout } = await run(tools.bb, ["gates", "-s", "chonk", "-b", join(bundle, circuit.proverArtifactPath)], { encoding: "utf8" });
  const json = JSON.parse(stdout.slice(stdout.indexOf("{"), stdout.lastIndexOf("}") + 1));
  return [circuit.artifactId, Number(json.functions[0].circuit_size)];
})));

// The browser prover refuses to start unless the page hosts every pinned CRS
// file, and it never falls back to a CDN.
const srsProfiles = [...new Set(circuits.map((circuit) => circuit.srsPoints))].sort((a, b) => a - b);
const g1Source = tools.bn254G1;
for (const points of srsProfiles) {
  const destination = join(publicDir, "crs", String(points), "bn254_g1.dat");
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(g1Source, destination);
  const required = points * 64;
  if (statSync(destination).size < required) {
    throw new Error(`${g1Source} holds fewer than the ${points} SRS points this page needs`);
  }
  truncateSync(destination, required);
  artifacts.push(`/crs/${points}/bn254_g1.dat`);
}
for (const [name, source] of [["bn254_g2.dat", tools.bn254G2], ["grumpkin_g1_v2.flat.dat", tools.grumpkinG1]]) {
  copyFileSync(source, join(publicDir, "crs", name));
  artifacts.push(`/crs/${name}`);
}

const bundleManifest = JSON.parse(readFileSync(join(bundle, "bundle-manifest.json"), "utf8"));
writeFileSync(join(publicDir, "lab-source.json"), `${JSON.stringify({
  bundleDigest: bundleManifest.bundleDigest,
  artifacts: artifacts.sort(),
  gates,
}, null, 2)}\n`);

const vite = join(root, "node_modules", ".bin", "vite");
const viteConfig = join(labRoot, "vite.config.ts");
const viteEnv = {
  ...process.env,
  PCASH_PROOF_LAB_PUBLIC: publicDir,
  PCASH_PROOF_LAB_DIST: distDir,
  PCASH_PROOF_LAB_RESULTS: resultsDir,
};
execFileSync(vite, ["build", "--config", viteConfig], { cwd: labRoot, env: viteEnv, stdio: "inherit" });

const port = Number(config.str("proof-lab-port", "4488"));
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("PCASH_PROOF_LAB_PORT must be a TCP port");
const localUrl = `http://127.0.0.1:${port}/`;
const preview = spawn(vite, [
  "preview",
  "--config", viteConfig,
  "--host", "0.0.0.0",
  "--port", String(port),
  "--strictPort",
], { cwd: labRoot, env: viteEnv, stdio: "inherit" });

const sleep = (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
for (let attempt = 0; attempt < 100; attempt += 1) {
  try {
    if ((await fetch(localUrl)).ok) break;
  } catch {}
  if (preview.exitCode !== null) throw new Error(`Vite exited before startup with code ${preview.exitCode}`);
  if (attempt === 99) throw new Error("proof lab did not start");
  await sleep(100);
}

const largest = Math.max(...Object.values(gates));
logger.info(`PCASH browser proof lab: ${localUrl}`);
logger.info(`Circuit bundle: ${bundleManifest.bundleDigest}`);
logger.info(`Circuits: ${circuits.length}; largest ${largest} gates`);
logger.info(`Scratch assets: ${scratch}`);
logger.info(`Results: ${resultsDir}`);
logger.info(`Self-hosted CRS: ${tools.crs}`);

let tunnelProcess;
if (tunnel) {
  logger.info("Starting an opt-in public HTTPS quick tunnel for a phone.");
  logger.warning("Anyone with the temporary URL can fetch the lab's compiled circuits and proving parameters, and read and post this session's results, until this process stops.");
  logger.info("Open the trycloudflare.com URL printed below, then press Ctrl-C when the test is finished.");
  tunnelProcess = spawn("cloudflared", ["tunnel", "--url", localUrl, "--no-autoupdate"], { stdio: "inherit" });
} else {
  logger.info("Open the local URL in an ordinary desktop browser. Press Ctrl-C here when finished.");
}

const children = [tunnelProcess, preview].filter(Boolean);
const stop = () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  }
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
await new Promise((resolveExit, rejectExit) => {
  preview.once("exit", resolveExit);
  preview.once("error", rejectExit);
  tunnelProcess?.once("error", rejectExit);
  tunnelProcess?.once("exit", (code, signal) => {
    if (preview.exitCode !== null || preview.signalCode !== null) return;
    stop();
    rejectExit(new Error(`HTTPS tunnel exited: code=${String(code)} signal=${String(signal)}`));
  });
});
