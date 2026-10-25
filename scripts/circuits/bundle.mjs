import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { isBuiltin } from "node:module";
import ts from "typescript";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { withoutGitIgnoredFiles } from "../repository_files.mjs";
import { circuitCatalog } from "./catalog.mjs";
import { KNOWN_ANSWERS, knownAnswerFiles } from "./known_answers.mjs";
import { STACK_PINS_PATH } from "./stack_pins.mjs";
import { applicationPinPaths } from "./application_pins.mjs";
import { Config } from "../../sdk/src/bcfg/index.ts";
import { toolRoot } from "../../sdk/src/node/toolchain.ts";
import { Logger } from "../../sdk/src/blgr/index.ts";

const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const logger = new Logger("info");
await logger.open();
const MANIFEST_NAME = "bundle-manifest.json";
const SCHEMA_VERSION = 2;
const LOCK_OWNER_NAME = "owner.json";
const EMPTY_LOCK_GRACE_MS = 5_000;
const REMOTE_LOCK_LEASE_MS = 2 * 60 * 60 * 1000;
const WAIT_ARRAY = new Int32Array(new SharedArrayBuffer(4));
// Known-answer proofs are randomized, so they sit beside the deterministic
// artifacts with their own hashes and stay out of the bundle digest.
const KNOWN_ANSWERS_DIR = "known-answers/";
const RUNTIME_KNOWN_ANSWERS = KNOWN_ANSWERS.filter((answer) => answer.runtime).flatMap(knownAnswerFiles);
const INTEGRATION_KNOWN_ANSWERS = KNOWN_ANSWERS.filter((answer) => !answer.runtime).flatMap(knownAnswerFiles);
const CATALOG = circuitCatalog(REPO_ROOT);
const REQUIRED_ARTIFACTS = [
  ...new Set(CATALOG.map((circuit) => `${circuit.owner}-manifest.json`)),
  ...CATALOG.flatMap((circuit) => [
    circuit.proverArtifactPath,
    circuit.verificationKeyPath,
  ]),
];

function settings() {
  const config = new Config("pcash");
  config.load({ env: true });
  return config;
}

function katSet() {
  const value = settings().str("circuit-kat-set", "full");
  if (value !== "full" && value !== "runtime") throw new Error(`invalid PCASH_CIRCUIT_KAT_SET: ${value}`);
  return value;
}

// Entrypoints run in subprocesses and non-module files read by those programs.
// Relative module imports are discovered transitively; application directories
// and unrelated source generators are not circuit-bundle inputs.
const INPUT_FILES = [
  "scripts/circuits/bundle.mjs",
  "scripts/circuits/check_release.mts",
  "scripts/circuits/generate_chonk_kats.mts",
  "scripts/circuits/refresh_prover_assets.mjs",
  "scripts/gen_network_profile.mjs",
  "assets/private_value_profiles.json",
  "assets/domain_tags.json",
  "assets/network_profile.json",
  "assets/poseidon2_bn254_t4_rf8_rp56.json",
  "assets/reference_rule_profile.json",
  "assets/prover-toolchain.json",
  "package.json",
  "package-lock.json",
  "sdk/package.json",
  "test-support/package.json",
  "marketplace/circuits.json",
  "web/tokens/circuits.json",
  "lineage/circuits.json",
  "node/crates/node/src/networks.rs",
];
const INPUT_TREES = ["circuits", "marketplace/l2-contracts/escrow", "web/tokens/l2-contracts", "lineage/l2-contracts"];
// The verification-key pins `just pins` writes. Generation derives every pin
// in its own build tree, so the committed copies are outputs, never inputs,
// even where an input imports one.
const GENERATED_OUTPUTS = new Set([STACK_PINS_PATH, ...applicationPinPaths(CATALOG)]);
/** The SDK's package exports with each built entry point mapped back to its source file. */
function sdkSourceExports(repoRoot) {
  const { exports } = JSON.parse(readFileSync(join(repoRoot, "sdk", "package.json"), "utf8"));
  return Object.fromEntries(Object.entries(exports).map(([name, entry]) => {
    const target = typeof entry === "string" ? entry : entry.default;
    return [name, target.replace(/^\.\/dist\//, "./src/").replace(/\.js$/, ".ts")];
  }));
}
const IGNORED_PARTS = new Set([".cache", "dist", "node_modules", "target"]);

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sha256File(path) {
  return sha256Bytes(new Uint8Array(readFileSync(path)));
}

// localeCompare depends on the host locale; the fingerprint and digest must not.
function codePointOrder(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => codePointOrder(a, b))
        .map(([key, child]) => [key, canonicalJson(child)]),
    );
  }
  return value;
}

function jsonText(value) {
  return `${JSON.stringify(canonicalJson(value), null, 2)}\n`;
}

function walkFiles(root) {
  if (!existsSync(root)) return [];
  const result = [];
  const visit = (path) => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      for (const name of readdirSync(path).sort()) {
        if (IGNORED_PARTS.has(name)) continue;
        visit(join(path, name));
      }
      return;
    }
    if (stat.isFile()) result.push(path);
  };
  visit(root);
  return result;
}

function circuitInputs(repoRoot) {
  const roots = INPUT_FILES.map((path) => join(repoRoot, path));
  for (const tree of INPUT_TREES) roots.push(...walkFiles(join(repoRoot, tree)));
  const generated = (path) => GENERATED_OUTPUTS.has(relative(repoRoot, path).split(sep).join("/"));
  const pending = withoutGitIgnoredFiles(repoRoot, [...new Set(roots)].filter(existsSync));
  const files = new Map();
  const packages = new Set();
  while (pending.length > 0) {
    const path = resolve(pending.pop());
    if (files.has(path) || generated(path)) continue;
    const bytes = readFileSync(path);
    files.set(path, bytes);
    if (!/\.(?:[cm]?ts|[cm]?js)$/.test(path)) continue;
    for (const { fileName: specifier } of ts.preProcessFile(bytes.toString("utf8"), true, true).importedFiles) {
      if (specifier.startsWith(".")) {
        pending.push(resolve(dirname(path), specifier));
      } else if (specifier === "@pcash/sdk" || specifier.startsWith("@pcash/sdk/")) {
        const key = specifier === "@pcash/sdk" ? "." : `.${specifier.slice("@pcash/sdk".length)}`;
        const source = sdkSourceExports(repoRoot)[key];
        if (!source) throw new Error(`no snapshot source export for ${specifier} imported by ${path}`);
        pending.push(join(repoRoot, "sdk", source));
      } else if (specifier === "@pcash/test-support" || specifier.startsWith("@pcash/test-support/")) {
        const manifestPath = join(repoRoot, "test-support", "package.json");
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
        const key = specifier === "@pcash/test-support" ? "." : `.${specifier.slice("@pcash/test-support".length)}`;
        const source = manifest.exports?.[key];
        if (typeof source !== "string") throw new Error(`no snapshot source export for ${specifier} imported by ${path}`);
        pending.push(manifestPath, join(repoRoot, "test-support", source));
      } else if (!isBuiltin(specifier)) {
        packages.add(specifier.split("/").slice(0, specifier.startsWith("@") ? 2 : 1).join("/"));
      }
    }
  }
  return {
    files: new Map([...files].sort(([a], [b]) => codePointOrder(relative(repoRoot, a), relative(repoRoot, b)))),
    packages,
  };
}

export function circuitInputFiles(repoRoot = REPO_ROOT) {
  return [...circuitInputs(repoRoot).files.keys()];
}

export function circuitInputFingerprint(repoRoot = REPO_ROOT) {
  const inputs = circuitInputs(repoRoot);
  const hash = createHash("sha256");
  for (const [path, bytes] of inputs.files) {
    const name = relative(repoRoot, path).split(sep).join("/");
    updateInputHash(hash, name, bytes, inputs.packages);
  }
  return hash.digest("hex");
}

const LOCK_INPUTS = new Set(["package-lock.json"]);

// npm rewrites lockfile key order and metadata fields across versions without
// changing a single resolved dependency. Hash the dependency set the lockfile
// pins instead of its bytes so that churn cannot invalidate a bundle.
function lockDigestBytes(bytes, importedPackages) {
  const { packages } = JSON.parse(bytes.toString("utf8"));
  if (!packages || typeof packages !== "object" || Array.isArray(packages)) {
    throw new Error("package-lock.json has no package table");
  }
  const names = new Set(importedPackages);
  const pinned = {};
  // Keep every installed version of a relevant dependency, including optional
  // and peer dependencies. Unrelated workspace dependencies do not affect proving.
  let added = true;
  while (added) {
    added = false;
    for (const [path, meta] of Object.entries(packages)) {
      const name = path.match(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)$/)?.[1];
      if (!names.has(name) || Object.hasOwn(pinned, path)) continue;
      pinned[path] = {
        integrity: meta.integrity ?? null,
        link: meta.link ?? false,
        resolved: meta.resolved ?? null,
        version: meta.version ?? null,
      };
      for (const dependency of Object.keys({ ...meta.dependencies, ...meta.optionalDependencies, ...meta.peerDependencies })) {
        names.add(dependency);
      }
      added = true;
    }
  }
  return Buffer.from(jsonText(pinned), "utf8");
}

function updateInputHash(hash, name, bytes, packages) {
  const digest = LOCK_INPUTS.has(name) ? lockDigestBytes(bytes, packages) : bytes;
  hash.update(`${name.length}:${name}:${digest.length}:`);
  hash.update(digest);
}

export function createCircuitSourceSnapshot(
  repoRoot = REPO_ROOT,
  snapshotParent = tmpdir(),
) {
  const snapshotRoot = mkdtempSync(join(snapshotParent, "pcash-circuit-source-"));
  const hash = createHash("sha256");
  const inputs = circuitInputs(repoRoot);
  for (const [path, bytes] of inputs.files) {
    const name = relative(repoRoot, path).split(sep).join("/");
    const destination = join(snapshotRoot, ...name.split("/"));
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, bytes, { flag: "wx" });
    updateInputHash(hash, name, bytes, inputs.packages);
  }
  return { fingerprint: hash.digest("hex"), root: realpathSync(snapshotRoot) };
}

export function linkSnapshotDependencies(snapshotRoot) {
  const rootNodeModules = join(REPO_ROOT, "node_modules");
  if (!existsSync(rootNodeModules)) {
    throw new Error("node_modules is missing; run npm install from the repository root");
  }
  symlinkSync(rootNodeModules, join(snapshotRoot, "node_modules"), "dir");

  // SDK fixtures use the shared test package. Keep that package and its SDK
  // imports in the captured source tree; third-party packages resolve through
  // the snapshot root's node_modules link.
  const fixturePackage = join(snapshotRoot, "sdk", "node_modules", "@pcash", "test-support");
  mkdirSync(dirname(fixturePackage), { recursive: true });
  symlinkSync(join(snapshotRoot, "test-support"), fixturePackage, "dir");

  // Other captured source imports SDK package exports. Point every such
  // import at this immutable snapshot rather than the live workspace package.
  const exports = sdkSourceExports(snapshotRoot);
  for (const applicationRoot of ["marketplace", "web/tokens", "lineage", "test-support"]) {
    const sdkOverlay = join(snapshotRoot, applicationRoot, "node_modules", "@pcash", "sdk");
    mkdirSync(sdkOverlay, { recursive: true });
    writeFileSync(
      join(sdkOverlay, "package.json"),
      jsonText({
        exports,
        name: "@pcash/sdk",
        type: "module",
      }),
      { flag: "wx" },
    );
    symlinkSync(join(snapshotRoot, "sdk", "src"), join(sdkOverlay, "src"), "dir");
  }
}

function bundleFiles(bundleDir) {
  return walkFiles(bundleDir)
    .filter((path) => relative(bundleDir, path) !== MANIFEST_NAME)
    .map((path) => relative(bundleDir, path).split(sep).join("/"))
    .sort();
}

function isKnownAnswer(path) {
  return path.startsWith(KNOWN_ANSWERS_DIR);
}

// The digest names the circuits, keys and their manifests: the same source
// produces the same digest, whichever known-answer set was generated with it.
function bundleDigest({ artifacts, generatedBy, schemaVersion }) {
  return sha256Bytes(Buffer.from(jsonText({ artifacts, generatedBy, schemaVersion }), "utf8"));
}

function createCircuitBundleManifest(bundleDir, inputFingerprint, selectedKatSet = katSet()) {
  const files = bundleFiles(bundleDir);
  const digests = (paths) => Object.fromEntries(paths.map((path) => [path, sha256File(join(bundleDir, path))]));
  const manifest = {
    artifacts: digests(files.filter((path) => !isKnownAnswer(path))),
    generatedBy: "scripts/circuits/bundle.mjs",
    inputFingerprint,
    katSet: selectedKatSet,
    knownAnswers: digests(files.filter(isKnownAnswer)),
    schemaVersion: SCHEMA_VERSION,
  };
  return { ...manifest, bundleDigest: bundleDigest(manifest) };
}

export function writeCircuitBundleManifest(bundleDir, inputFingerprint, selectedKatSet = katSet()) {
  const manifest = createCircuitBundleManifest(bundleDir, inputFingerprint, selectedKatSet);
  writeFileSync(join(bundleDir, MANIFEST_NAME), jsonText(manifest), { flag: "wx" });
  return manifest;
}

export function validateCircuitBundle(bundleDir) {
  const manifestPath = join(bundleDir, MANIFEST_NAME);
  if (!existsSync(manifestPath)) throw new Error(`circuit bundle has no ${MANIFEST_NAME}: ${bundleDir}`);
  // The inventory walk skips symlinks inside a bundle. A configured bundle
  // path may itself be a symlink, so walk the directory it names.
  bundleDir = realpathSync(bundleDir);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`unsupported circuit bundle schema ${String(manifest.schemaVersion)}`);
  }
  const manifestKeys = Object.keys(manifest).sort();
  const requiredManifestKeys = [
    "artifacts",
    "bundleDigest",
    "generatedBy",
    "inputFingerprint",
    "katSet",
    "knownAnswers",
    "schemaVersion",
  ];
  if (JSON.stringify(manifestKeys) !== JSON.stringify(requiredManifestKeys)) {
    throw new Error("circuit bundle manifest has an invalid field set");
  }
  if (!/^[0-9a-f]{64}$/.test(manifest.inputFingerprint ?? "")) {
    throw new Error("circuit bundle has no valid input fingerprint");
  }
  if (!/^[0-9a-f]{64}$/.test(manifest.bundleDigest ?? "")) {
    throw new Error("circuit bundle has no valid output digest");
  }
  if (manifest.katSet !== "full" && manifest.katSet !== "runtime") {
    throw new Error("circuit bundle has an invalid known-answer set");
  }
  for (const [table, knownAnswers] of [["artifacts", false], ["knownAnswers", true]]) {
    const entries = manifest[table];
    if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
      throw new Error(`circuit bundle has no ${table} digest table`);
    }
    // Only artifacts feed the digest, so a knownAnswers entry must never
    // supply the hash a circuit or key is checked against.
    if (Object.keys(entries).some((path) => isKnownAnswer(path) !== knownAnswers)) {
      throw new Error(`circuit bundle ${table} table lists ${knownAnswers ? "a non-" : "a "}known-answer path`);
    }
  }
  const expected = { ...manifest.artifacts, ...manifest.knownAnswers };
  const actualFiles = bundleFiles(bundleDir);
  const expectedFiles = Object.keys(expected).sort();
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    throw new Error("circuit bundle artifact inventory differs from its manifest");
  }
  if (manifest.katSet === "runtime" && INTEGRATION_KNOWN_ANSWERS.some(path => actualFiles.includes(path))) {
    throw new Error("runtime circuit bundle includes integration-only known answers");
  }
  const requiredArtifacts = manifest.katSet === "full"
    ? [...REQUIRED_ARTIFACTS, ...RUNTIME_KNOWN_ANSWERS, ...INTEGRATION_KNOWN_ANSWERS]
    : [...REQUIRED_ARTIFACTS, ...RUNTIME_KNOWN_ANSWERS];
  for (const path of requiredArtifacts) {
    if (!actualFiles.includes(path)) throw new Error(`circuit bundle is missing required artifact: ${path}`);
  }
  for (const path of actualFiles) {
    if (!/^[0-9a-f]{64}$/.test(expected[path]) || sha256File(join(bundleDir, path)) !== expected[path]) {
      throw new Error(`circuit bundle artifact digest mismatch: ${path}`);
    }
  }
  if (bundleDigest(manifest) !== manifest.bundleDigest) {
    throw new Error("circuit bundle output digest mismatch");
  }
  return manifest;
}

export function validateCircuitBundleForInputs(bundleDir, repoRoot = REPO_ROOT, requestedKatSet = katSet()) {
  const manifest = validateCircuitBundle(bundleDir);
  if (manifest.katSet !== requestedKatSet) {
    throw new Error(`circuit bundle known-answer set differs from requested ${requestedKatSet} set: ${bundleDir}`);
  }
  const fingerprint = circuitInputFingerprint(repoRoot);
  if (manifest.inputFingerprint !== fingerprint) {
    throw new Error(
      `circuit bundle was generated from different inputs: ${bundleDir}\n` +
        `expected ${fingerprint}, got ${manifest.inputFingerprint}`,
    );
  }
  return manifest;
}

function cacheRoot() {
  const configured = settings().str("circuit-cache");
  return configured ? resolve(configured) : join(REPO_ROOT, ".cache", "pcash", "circuit-bundles");
}

function explicitBundle() {
  const configured = settings().str("circuit-bundle");
  return configured ? resolve(configured) : undefined;
}

export function spawnWithProgressOnStderr(bin, args, options = {}) {
  return spawnSync(bin, args, {
    ...options,
    stdio: ["inherit", 2, "inherit"],
  });
}

function runGenerator(sourceRoot, outputDir, fingerprint) {
  const result = spawnWithProgressOnStderr(
    process.execPath,
    [join(sourceRoot, "scripts", "circuits", "check_release.mts"), "--out", outputDir,
      ...(katSet() === "runtime" ? ["--runtime-kats-only"] : [])],
    // The snapshot's own default tool root would be inside the snapshot.
    { cwd: sourceRoot, env: { ...process.env, PCASH_TOOL_ROOT: toolRoot() } },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`circuit bundle generator exited ${String(result.status)}`);
  writeCircuitBundleManifest(outputDir, fingerprint);
  validateCircuitBundle(outputDir);
}

function cachedBundle(sourceDir, inputFingerprint) {
  if (!existsSync(sourceDir)) return undefined;
  for (const digest of readdirSync(sourceDir).sort()) {
    if (!/^[0-9a-f]{64}$/.test(digest)) continue;
    const bundleDir = join(sourceDir, digest);
    if (!statSync(bundleDir).isDirectory()) continue;
    const manifest = validateCircuitBundle(bundleDir);
    if (manifest.katSet !== katSet()) {
      throw new Error(`circuit bundle cache known-answer set mismatch: ${bundleDir}`);
    }
    if (manifest.inputFingerprint !== inputFingerprint) {
      throw new Error(`circuit bundle cache input mismatch: ${bundleDir}`);
    }
    if (manifest.bundleDigest !== digest) {
      throw new Error(`circuit bundle cache output mismatch: ${bundleDir}`);
    }
    return bundleDir;
  }
  return undefined;
}

function readLockOwner(lockDir) {
  try {
    const owner = JSON.parse(readFileSync(join(lockDir, LOCK_OWNER_NAME), "utf8"));
    if (
      typeof owner.hostname !== "string" ||
      !Number.isSafeInteger(owner.pid) ||
      owner.pid <= 0 ||
      typeof owner.processBirthIdentity !== "string" ||
      owner.processBirthIdentity.length === 0 ||
      owner.processBirthIdentity.length > 256 ||
      !Number.isSafeInteger(owner.startedAt) ||
      !/^[0-9a-f]{32}$/.test(owner.token ?? "")
    ) {
      return undefined;
    }
    return owner;
  } catch {
    return undefined;
  }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function processBirthIdentity(pid) {
  try {
    const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const commandEnd = stat.lastIndexOf(")");
    const fieldsAfterCommand = commandEnd === -1 ? [] : stat.slice(commandEnd + 2).trim().split(/\s+/);
    const startTicks = fieldsAfterCommand[19];
    if (bootId && /^\d+$/.test(startTicks ?? "")) return `linux:${bootId}:${startTicks}`;
  } catch {
    // macOS and other systems without procfs use ps below.
  }
  const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
    encoding: "utf8",
    env: { ...process.env, LANG: "C", LC_ALL: "C" },
    maxBuffer: 4_096,
    timeout: 5_000,
  });
  if (result.error || result.status !== 0) return undefined;
  const identity = result.stdout.trim();
  return identity || undefined;
}

export function reclaimStaleCircuitBundleLock(
  lockDir,
  {
    now = Date.now(),
    currentHostname = hostname(),
    isProcessAlive = processIsAlive,
    getProcessBirthIdentity = processBirthIdentity,
  } = {},
) {
  if (!existsSync(lockDir)) return false;
  const owner = readLockOwner(lockDir);
  const age = now - statSync(lockDir).mtimeMs;
  let stale;
  if (!owner) {
    stale = age > EMPTY_LOCK_GRACE_MS;
  } else if (owner.hostname !== currentHostname) {
    stale = now - owner.startedAt > REMOTE_LOCK_LEASE_MS;
  } else if (!isProcessAlive(owner.pid)) {
    stale = true;
  } else {
    const currentBirthIdentity = getProcessBirthIdentity(owner.pid);
    stale = currentBirthIdentity !== undefined && currentBirthIdentity !== owner.processBirthIdentity;
  }
  if (!stale) return false;

  const ownerPath = join(lockDir, LOCK_OWNER_NAME);
  if (owner) {
    const current = readLockOwner(lockDir);
    if (current?.token !== owner.token) return false;
  }
  try {
    if (existsSync(ownerPath)) unlinkSync(ownerPath);
    rmdirSync(lockDir);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    if (error?.code === "ENOTEMPTY") return false;
    throw error;
  }
}

function acquireBundleLock(lockDir) {
  mkdirSync(lockDir);
  const currentBirthIdentity = processBirthIdentity(process.pid);
  if (!currentBirthIdentity) {
    rmdirSync(lockDir);
    throw new Error("could not determine circuit bundle lock process identity");
  }
  const owner = {
    hostname: hostname(),
    pid: process.pid,
    processBirthIdentity: currentBirthIdentity,
    startedAt: Date.now(),
    token: randomBytes(16).toString("hex"),
  };
  try {
    writeFileSync(join(lockDir, LOCK_OWNER_NAME), jsonText(owner), { flag: "wx" });
  } catch (error) {
    rmdirSync(lockDir);
    throw error;
  }
  return owner.token;
}

function releaseBundleLock(lockDir, token) {
  const owner = readLockOwner(lockDir);
  if (owner?.token !== token) return;
  try {
    unlinkSync(join(lockDir, LOCK_OWNER_NAME));
    rmdirSync(lockDir);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function waitForBundle(sourceDir, inputFingerprint, lockDir) {
  const deadline = Date.now() + 20 * 60 * 1000;
  while (Date.now() < deadline) {
    const bundle = cachedBundle(sourceDir, inputFingerprint);
    if (bundle) return bundle;
    if (reclaimStaleCircuitBundleLock(lockDir)) return undefined;
    if (!existsSync(lockDir)) return undefined;
    Atomics.wait(WAIT_ARRAY, 0, 0, 250);
  }
  throw new Error(`timed out waiting for circuit bundle lock: ${lockDir}`);
}

function isolatedCircuitCache() {
  const config = settings();
  if (!config.bool("circuit-cache-isolated", false)) return false;
  if (!config.str("circuit-cache")) {
    throw new Error("PCASH_CIRCUIT_CACHE_ISOLATED requires an explicit PCASH_CIRCUIT_CACHE");
  }
  return true;
}

export function ensureCircuitBundle() {
  const explicit = explicitBundle();
  if (explicit) {
    validateCircuitBundleForInputs(explicit);
    return explicit;
  }

  const fingerprint = circuitInputFingerprint();
  const root = cacheRoot();
  const sourceDir = join(root, katSet(), fingerprint);
  const cached = cachedBundle(sourceDir, fingerprint);
  if (cached) return cached;

  mkdirSync(root, { recursive: true });
  const lockDir = join(root, `${katSet()}-${fingerprint}.lock`);
  const isolated = isolatedCircuitCache();
  let lockToken;
  if (!isolated) {
    try {
      lockToken = acquireBundleLock(lockDir);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const waited = waitForBundle(sourceDir, fingerprint, lockDir);
      if (waited) return waited;
      return ensureCircuitBundle();
    }
  }

  let sourceChanged = false;
  let snapshot;
  const candidate = join(root, `.candidate-${fingerprint}-${process.pid}-${randomBytes(8).toString("hex")}`);
  try {
    const raced = cachedBundle(sourceDir, fingerprint);
    if (raced) return raced;
    snapshot = createCircuitSourceSnapshot();
    if (snapshot.fingerprint !== fingerprint) {
      sourceChanged = true;
    } else {
      linkSnapshotDependencies(snapshot.root);
      runGenerator(snapshot.root, candidate, fingerprint);
      const manifest = validateCircuitBundle(candidate);
      mkdirSync(sourceDir, { recursive: true });
      const bundleDir = join(sourceDir, manifest.bundleDigest);
      try {
        renameSync(candidate, bundleDir);
      } catch (error) {
        if (!existsSync(bundleDir)) throw error;
      }
      validateCircuitBundle(bundleDir);
      return bundleDir;
    }
  } finally {
    // The snapshot holds the whole build tree; a candidate remains only when the build failed or lost a race.
    if (snapshot) rmSync(snapshot.root, { recursive: true, force: true });
    rmSync(candidate, { recursive: true, force: true });
    if (lockToken) releaseBundleLock(lockDir, lockToken);
  }
  if (sourceChanged) return ensureCircuitBundle();
  throw new Error("circuit bundle generation ended without a bundle");
}

function usage() {
  logger.error("usage: node scripts/circuits/bundle.mjs [--print-path | --print-inputs | exec -- COMMAND ...]");
  process.exit(2);
}

function main(argv) {
  // The mode is an operand: it comes from the command line only, never from
  // the environment the bundle settings are read from.
  const config = new Config("pcash");
  config.load({ argv: ["node", "bundle.mjs", ...argv] });
  const modes = Object.keys(config.args);
  if (config.argv.length === 1 && config.argv[0] === "exec" && modes.length === 0 && config.pass.length > 0) {
    const path = ensureCircuitBundle();
    const result = spawnSync(config.pass[0], config.pass.slice(1), {
      cwd: process.cwd(),
      env: { ...process.env, PCASH_CIRCUIT_BUNDLE: path },
      stdio: "inherit",
    });
    if (result.error) throw result.error;
    process.exit(result.status ?? 1);
  }
  if (config.argv.length > 0 || config.pass.length > 0 || modes.length > 1) usage();
  const mode = modes[0] ?? "printpath";
  if (modes.length > 0 && config.args[mode] !== "true") usage();
  if (mode === "printpath") {
    logger.raw(ensureCircuitBundle());
    return;
  }
  if (mode === "printinputs") {
    for (const path of circuitInputFiles()) logger.raw(path);
    return;
  }
  usage();
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
