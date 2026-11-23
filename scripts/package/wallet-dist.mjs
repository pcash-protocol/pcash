import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync, cpSync, createReadStream, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { prepareWorktree } from "../dev/worktree.mts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const packages = ["sdk", "wallet"];
const defaultOutput = join(root, ".cache/pcash/wallet-dist");
const [destination = defaultOutput, ...extra] = process.argv.slice(2);
if (extra.length !== 0) throw new Error("usage: just wallet-dist [output-directory]");
if (process.platform !== "darwin" || process.arch !== "arm64") {
  throw new Error("wallet-dist requires an Apple Silicon Mac running arm64 Node");
}

function run(command, args, cwd = root) {
  execFileSync(command, args, { cwd, stdio: "inherit" });
}

function readCommand(command, args) {
  return execFileSync(command, args, { cwd: root, encoding: "utf8" }).trim();
}

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function installNode(stage, work) {
  // A locally installed Node can link to libraries absent on users' Macs.
  const distribution = `node-${process.version}-darwin-arm64`;
  const archive = join(work, `${distribution}.tar.gz`);
  const checksums = join(work, "SHASUMS256.txt");
  const url = `https://nodejs.org/dist/${process.version}`;
  for (const path of [checksums, archive]) {
    run("curl", ["--fail", "--silent", "--show-error", "--retry", "2", "--output", path, `${url}/${basename(path)}`]);
  }
  const expected = readFileSync(checksums, "utf8").split("\n")
    .map((line) => line.trim().split(/\s+/))
    .find(([, name]) => name === basename(archive))?.[0];
  if (await sha256(archive) !== expected) throw new Error("Node distribution SHA-256 mismatch");
  run("tar", ["-xzf", archive, "-C", work, `${distribution}/bin/node`, `${distribution}/LICENSE`]);
  mkdirSync(join(stage, "bin"));
  cpSync(join(work, distribution, "bin/node"), join(stage, "bin/node"));
  cpSync(join(work, distribution, "LICENSE"), join(stage, "LICENSE.node"));
}

const sourceCommit = readCommand("git", ["rev-parse", "HEAD"]);
const sourceDirty = readCommand("git", ["status", "--porcelain"]) !== "";
const { version } = JSON.parse(readFileSync(join(root, "wallet/package.json")));
const name = `pcash-wallet-${version}-${sourceCommit.slice(0, 12)}${sourceDirty ? "-dirty" : ""}-darwin-arm64`;
const output = resolve(destination);
mkdirSync(output, { recursive: true });
const work = mkdtempSync(join(tmpdir(), "pcash-wallet-dist-"));
const stage = join(work, name);
mkdirSync(stage);

try {
  prepareWorktree(root);
  run("just", ["tools"]);
  for (const workspace of packages) run("npm", ["run", "build", "--workspace", `@pcash/${workspace}`]);
  const bundle = readCommand(process.execPath, ["scripts/circuits/bundle.mjs", "--print-path"]).split("\n").at(-1);

  // Keep the workspace layout that the SDK uses to find its toolchain pins.
  const manifest = JSON.parse(readFileSync(join(root, "package.json")));
  manifest.workspaces = packages;
  writeFileSync(join(stage, "package.json"), JSON.stringify(manifest));
  cpSync(join(root, "package-lock.json"), join(stage, "package-lock.json"));
  for (const workspace of packages) {
    mkdirSync(join(stage, workspace));
    for (const entry of ["package.json", "dist"]) {
      cpSync(join(root, workspace, entry), join(stage, workspace, entry), { recursive: true });
    }
  }
  run("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], stage);

  await installNode(stage, work);
  cpSync(join(root, "LICENSE"), join(stage, "LICENSE"));
  mkdirSync(join(stage, "assets"));
  cpSync(join(root, "assets/prover-toolchain.json"), join(stage, "assets/prover-toolchain.json"));
  mkdirSync(join(stage, "circuits"));
  for (const entry of ["prover-assets", "vks"]) {
    cpSync(join(bundle, entry), join(stage, "circuits", entry), { recursive: true });
  }

  // Use the shipping prover to select and authenticate the CRS bytes.
  const { walletProverBackend } = await import("../../sdk/dist/wallet/provers.js");
  const { bn254G1, bn254G2, grumpkinG1 } = walletProverBackend("wasm").crs;
  const crs = join(stage, "prover", "crs");
  mkdirSync(crs, { recursive: true });
  writeFileSync(join(crs, "bn254_g1.dat"), bn254G1);
  writeFileSync(join(crs, "bn254_g2.dat"), bn254G2);
  writeFileSync(join(crs, "grumpkin_g1_v2.flat.dat"), grumpkinG1);

  for (const launcher of ["start-testnet", "pcash-wallet-cli"]) {
    const target = join(stage, launcher);
    cpSync(join(root, "scripts/package/wallet", launcher), target);
    chmodSync(target, 0o755);
  }
  writeFileSync(join(stage, "build.json"), JSON.stringify({
    version, sourceCommit, sourceDirty, node: process.version,
    circuitBundle: basename(bundle),
  }, null, 2) + "\n");

  run(join(stage, "start-testnet"), ["--help"], work);
  run(join(stage, "pcash-wallet-cli"), ["--help"], work);
  const archiveName = "pcash-wallet-darwin-arm64.tar.gz";
  run("tar", ["-czf", join(output, archiveName), "-C", work, name]);
  const digest = await sha256(join(output, archiveName));
  writeFileSync(join(output, `${archiveName}.sha256`), `${digest}  ${archiveName}\n`);
  console.log(join(output, archiveName));
} finally {
  rmSync(work, { recursive: true, force: true });
}
