import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import {
  circuitCacheRoot,
  circuitInputFiles,
  circuitInputFingerprint,
  createCircuitSourceSnapshot,
  linkSnapshotDependencies,
  reclaimStaleCircuitBundleLock,
  validateCircuitBundle,
  validateCircuitBundleForInputs,
  writeCircuitBundleManifest,
} from "./bundle.mjs";
import { circuitByReleaseId, circuitCatalog } from "./catalog.mjs";
import { deriveStackPins, STACK_PINS_PATH } from "./stack_pins.mjs";
import { applicationPinPaths, RULE_PINS_PATH } from "./application_pins.mjs";

const staticRequiredArtifacts = [
  ...["real_event", "shared_claim_s", "shared_claim_l", "large_sponsored_transfer", "large_asset_creation"].flatMap(name =>
    ["proof", "proof.rejected", "public_inputs"].map(file => `known-answers/${name}/${file}`)),
  "known-answers/shared_claim_s/tx_bytes",
  "known-answers/shared_claim_l/tx_bytes",
  "known-answers/private_value/proof",
  "known-answers/private_value/proof.rejected",
  "known-answers/private_value/public_inputs",
  "known-answers/private_value_large/proof",
  "known-answers/private_value_large/proof.rejected",
  "known-answers/private_value_large/public_inputs",
  "known-answers/user_account_update/proof",
  "known-answers/user_account_update/proof.rejected",
  "known-answers/user_account_update/public_inputs",
  "marketplace-manifest.json",
  "protocol-manifest.json",
  "tokens-manifest.json",
  "lineage-manifest.json",
];
const requiredArtifacts = [
  ...staticRequiredArtifacts,
  ...circuitCatalog().flatMap((circuit) => [
    circuit.proverArtifactPath,
    circuit.verificationKeyPath,
  ]),
];

test("circuit cache selection honors configured and local paths before a shared primary cache", async () => {
  const root = await mkdtemp(join(tmpdir(), "pcash-worktree-circuit-cache-"));
  const primary = join(root, "primary");
  const worktree = join(root, "worktree");
  const gitDir = join(primary, ".git", "worktrees", "branch");
  await mkdir(gitDir, { recursive: true });
  await mkdir(worktree);
  await writeFile(join(gitDir, "commondir"), "../..\n");
  await writeFile(join(worktree, ".git"), `gitdir: ${gitDir}\n`);
  const primaryCache = join(primary, ".cache", "pcash", "circuit-bundles");
  const localCache = join(worktree, ".cache", "pcash", "circuit-bundles");

  assert.equal(circuitCacheRoot(primary, null), primaryCache);
  assert.equal(circuitCacheRoot(worktree, null), localCache);

  await mkdir(primaryCache, { recursive: true });
  assert.equal(circuitCacheRoot(worktree, null), primaryCache);
  assert.equal(existsSync(localCache), false);

  await mkdir(localCache, { recursive: true });
  assert.equal(circuitCacheRoot(worktree, null), localCache);

  const configured = join(root, "configured");
  assert.equal(circuitCacheRoot(worktree, configured), configured);
  assert.equal(existsSync(configured), false);
});

async function writeCatalogManifests(root, { protocol = [], marketplace = [], tokens = [], lineage = [] }) {
  for (const [path, owner, circuits] of [
    ["circuits/manifest.json", "protocol", protocol],
    ["marketplace/circuits.json", "marketplace", marketplace],
    ["web/tokens/circuits.json", "tokens", tokens],
    ["lineage/circuits.json", "lineage", lineage],
  ]) {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, `${JSON.stringify({ owner, circuits: circuits.map((c) => ({ role: "application", provingRuntimes: ["native", "browser"], srsPoints: 262144, ...c })) })}\n`);
  }
}

test("circuit catalog uses owner-qualified release identities", () => {
  const byReleaseId = circuitByReleaseId();
  assert.equal(byReleaseId["protocol/private_value_transfer_kernel"].packageName, "private_value_transfer_kernel");
  assert.equal(byReleaseId["marketplace/claim"].artifactId, "contracts/escrow/claim");
  assert.equal(byReleaseId["tokens/drop_claim"].artifactId, "contracts/drop/claim");
});

test("circuit catalog rejects duplicate Noir package names", async () => {
  const root = await mkdtemp(join(tmpdir(), "pcash-circuit-package-collision-"));
  await writeCatalogManifests(root, {
    marketplace: [{ package: "claim", path: "claim", artifact: "marketplace/claim" }],
    protocol: [{ package: "claim", path: "claim", artifact: "protocol/claim" }],
  });
  assert.throws(() => circuitCatalog(root), /Noir package name collision claim/);
});

test("circuit catalog rejects duplicate artifact IDs", async () => {
  const root = await mkdtemp(join(tmpdir(), "pcash-circuit-artifact-collision-"));
  await writeCatalogManifests(root, {
    marketplace: [{ package: "claim", path: "claim", artifact: "shared/claim" }],
    protocol: [{ package: "protocol_claim", path: "claim", artifact: "shared/claim" }],
  });
  assert.throws(() => circuitCatalog(root), /artifact ID collision shared\/claim/);
});

async function populateBundle(bundle, suffix = "") {
  for (const path of requiredArtifacts) {
    const file = join(bundle, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, `${path}${suffix}`);
  }
}

async function writeSources(root, files) {
  for (const [name, source] of Object.entries(files)) {
    const path = join(root, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, source);
  }
}

test("generator imports, re-exports, and dynamic imports determine source dependencies", async () => {
  const repo = await mkdtemp(join(tmpdir(), "pcash-circuit-dependencies-"));
  await writeSources(repo, {
    "scripts/circuits/generate_chonk_kats.mts": 'import "../../sdk/test/fixture.ts";\n',
    "sdk/test/fixture.ts": 'export { build } from "../src/build.ts";\n',
    "sdk/src/build.ts": 'export const build = () => import("./witness.ts");\n',
    "sdk/src/witness.ts": 'export const value = 1;\n',
  });
  const before = circuitInputFingerprint(repo);
  const snapshot = createCircuitSourceSnapshot(repo);
  assert.equal(circuitInputFingerprint(snapshot.root), before);
  await writeFile(join(repo, "sdk/src/witness.ts"), 'export const value = 2;\n');
  assert.notEqual(circuitInputFingerprint(repo), before);
  assert.equal(await readFile(join(snapshot.root, "sdk/src/witness.ts"), "utf8"), 'export const value = 1;\n');
});

test("captured shared fixtures import the captured SDK after live sources change", async () => {
  const repo = await mkdtemp(join(tmpdir(), "pcash-circuit-fixture-source-"));
  const snapshots = await mkdtemp(join(tmpdir(), "pcash-circuit-fixture-snapshots-"));
  await writeSources(repo, {
    "package.json": '{"type":"module","workspaces":["sdk","test-support"]}\n',
    "sdk/package.json": '{"name":"@pcash/sdk","type":"module","exports":{"./protocol":"./dist/protocol/index.js"}}\n',
    "test-support/package.json": '{"name":"@pcash/test-support","type":"module","exports":{"./protocol-fixtures":"./src/protocolFixtures.ts"}}\n',
    "scripts/circuits/generate_chonk_kats.mts": 'import "../../sdk/test/captured.ts";\n',
    "sdk/test/captured.ts": 'import { capturedFixtureValue } from "@pcash/test-support/protocol-fixtures"; export { capturedFixtureValue };\n',
    "test-support/src/protocolFixtures.ts": 'import { fixtureValue } from "@pcash/sdk/protocol"; export const capturedFixtureValue = fixtureValue;\n',
    "sdk/src/protocol/index.ts": 'export const fixtureValue = "captured";\n',
    "sdk/dist/protocol/index.js": 'export const fixtureValue = "live-dist";\n',
  });
  const before = circuitInputFingerprint(repo);
  const snapshot = createCircuitSourceSnapshot(repo, snapshots);
  assert.equal(snapshot.fingerprint, before);
  assert.equal(existsSync(join(snapshot.root, "test-support", "package.json")), true);
  linkSnapshotDependencies(snapshot.root);

  await writeFile(join(repo, "sdk", "src", "protocol", "index.ts"), 'export const fixtureValue = "live-source";\n');
  await writeFile(join(repo, "sdk", "dist", "protocol", "index.js"), 'export const fixtureValue = "changed-live-dist";\n');
  await writeFile(join(repo, "test-support", "src", "protocolFixtures.ts"), 'export const capturedFixtureValue = "live-fixture";\n');
  assert.notEqual(circuitInputFingerprint(repo), before);

  const capturedFixture = join(snapshot.root, "sdk", "test", "captured.ts");
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval",
    `import { capturedFixtureValue } from ${JSON.stringify(pathToFileURL(capturedFixture).href)}; console.log(capturedFixtureValue);`],
  { cwd: snapshot.root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "captured\n");
});

test("test-support package exports are bundle inputs", async () => {
  const repo = await mkdtemp(join(tmpdir(), "pcash-circuit-test-support-package-"));
  await writeSources(repo, {
    "scripts/circuits/generate_chonk_kats.mts": 'import "../../test-support/src/protocolFixtures.ts";\n',
    "test-support/src/protocolFixtures.ts": 'export const value = 1;\n',
    "test-support/package.json": '{"name":"@pcash/test-support","exports":{"./protocol-fixtures":"./src/protocolFixtures.ts"}}\n',
  });
  const before = circuitInputFingerprint(repo);
  await writeFile(join(repo, "test-support", "package.json"), '{"name":"@pcash/test-support","exports":{"./protocol-fixtures":"./src/other.ts"}}\n');
  assert.notEqual(circuitInputFingerprint(repo), before);
});

test("unrelated application edits preserve the bundle fingerprint", async () => {
  const repo = await mkdtemp(join(tmpdir(), "pcash-circuit-unrelated-"));
  await writeSources(repo, { "scripts/circuits/generate_chonk_kats.mts": "export const fixture = 1;\n" });
  const before = circuitInputFingerprint(repo);
  const unrelated = [
    "wallet/src/actions/scan.ts",
    "marketplace/src/client/session.ts",
    "sdk/src/clients/nodeClient.ts",
    "sdk/src/relay/relayer.ts",
    "web/src/App.tsx",
  ];
  for (const value of [1, 2]) {
    await writeSources(repo, Object.fromEntries(unrelated.map((path) => [path, `export const version = ${value};\n`])));
    assert.equal(circuitInputFingerprint(repo), before);
  }
  const snapshot = createCircuitSourceSnapshot(repo);
  for (const path of unrelated) assert.equal(existsSync(join(snapshot.root, path)), false);
});

test("the real generator excludes application clients and includes proof builders", () => {
  const repo = fileURLToPath(new URL("../..", import.meta.url));
  const inputs = circuitInputFiles(repo).map((path) => relative(repo, path));
  assert.ok(inputs.includes("sdk/src/builders/nativeTransfer.ts"));
  assert.ok(inputs.includes("sdk/test/sharedAssetClaimFixtures.ts"));
  for (const prefix of ["wallet/", "marketplace/src/client/", "sdk/src/clients/", "sdk/src/relay/"]) {
    assert.equal(inputs.some((path) => path.startsWith(prefix)), false, prefix);
  }
});

test("input fingerprint follows content rather than modification time", async () => {
  const repo = await mkdtemp(join(tmpdir(), "pcash-circuit-inputs-"));
  const source = join(repo, "circuits", "example", "src", "main.nr");
  await mkdir(dirname(source), { recursive: true });
  await writeFile(source, "fn main() {}\n");
  const first = circuitInputFingerprint(repo);
  await utimes(source, new Date(1_000), new Date(1_000));
  assert.equal(circuitInputFingerprint(repo), first);
  await writeFile(source, "fn main() { assert(true); }\n");
  assert.notEqual(circuitInputFingerprint(repo), first);
});

test("gitignored local files do not affect the fingerprint or source snapshot", async () => {
  const repo = await mkdtemp(join(tmpdir(), "pcash-circuit-ignored-inputs-"));
  const snapshots = await mkdtemp(join(tmpdir(), "pcash-circuit-ignored-snapshots-"));
  const source = join(repo, "circuits", "example", "src", "main.nr");
  const ignored = join(repo, "circuits", "example", "Prover.toml");
  await mkdir(dirname(source), { recursive: true });
  await writeFile(join(repo, ".gitignore"), "**/Prover.toml\n");
  await writeFile(source, "fn main() {}\n");
  await writeFile(ignored, "local = 0\n");
  assert.equal(spawnSync("git", ["init", "-q", repo]).status, 0);

  const fingerprint = circuitInputFingerprint(repo);
  const snapshot = createCircuitSourceSnapshot(repo, snapshots);
  assert.equal(snapshot.fingerprint, fingerprint);
  assert.equal(circuitInputFingerprint(snapshot.root), fingerprint);
  assert.equal(existsSync(join(snapshot.root, "circuits", "example", "Prover.toml")), false);

  await writeFile(ignored, "local = 1\n");
  assert.equal(circuitInputFingerprint(repo), fingerprint);
});

test("input fingerprint covers executed network-profile validation", async () => {
  const repo = await mkdtemp(join(tmpdir(), "pcash-circuit-generator-input-"));
  const generator = join(repo, "scripts", "gen_network_profile.mjs");
  await mkdir(dirname(generator), { recursive: true });
  await writeFile(generator, "export const version = 1;\n");
  const first = circuitInputFingerprint(repo);
  await writeFile(generator, "export const version = 2;\n");
  assert.notEqual(circuitInputFingerprint(repo), first);
});

test("input fingerprint covers fixture-only reference-rule profile", async () => {
  const repo = await mkdtemp(join(tmpdir(), "pcash-circuit-reference-profile-"));
  const profile = join(repo, "assets", "reference_rule_profile.json");
  await mkdir(dirname(profile), { recursive: true });
  await writeFile(profile, '{"profile":"one"}\n');
  const first = circuitInputFingerprint(repo);
  await writeFile(profile, '{"profile":"two"}\n');
  assert.notEqual(circuitInputFingerprint(repo), first);
});

test("input fingerprint follows pinned dependencies rather than lockfile serialization", async () => {
  const repo = await mkdtemp(join(tmpdir(), "pcash-circuit-lockfile-"));
  await writeSources(repo, { "scripts/circuits/generate_chonk_kats.mts": 'import "x";\n' });
  const lock = join(repo, "package-lock.json");
  const pinned = {
    integrity: "sha512-AAAA",
    resolved: "https://registry.npmjs.org/x/-/x-1.0.0.tgz",
    version: "1.0.0",
  };
  await writeFile(lock, JSON.stringify({ lockfileVersion: 3, packages: { "node_modules/x": { engines: { node: ">=24" }, license: "MIT", ...pinned } } }, null, 2));
  const first = circuitInputFingerprint(repo);

  // Reordered keys, dropped metadata fields, and different whitespace pin the same dependency.
  await writeFile(lock, JSON.stringify({ packages: { "node_modules/x": { version: pinned.version, funding: "https://example.test", resolved: pinned.resolved, integrity: pinned.integrity } }, lockfileVersion: 3 }));
  assert.equal(circuitInputFingerprint(repo), first);

  await writeFile(lock, JSON.stringify({ lockfileVersion: 3, packages: { "node_modules/x": { ...pinned, integrity: "sha512-BBBB" } } }, null, 2));
  assert.notEqual(circuitInputFingerprint(repo), first);
});

test("lock fingerprint includes transitive, optional, and peer dependencies but ignores unrelated packages", async () => {
  const repo = await mkdtemp(join(tmpdir(), "pcash-circuit-lock-dependencies-"));
  await writeSources(repo, { "scripts/circuits/generate_chonk_kats.mts": 'import "@prover/backend/native";\n' });
  const packages = {
    "node_modules/@prover/backend": {
      version: "1",
      dependencies: { worker: "1" },
      optionalDependencies: { native: "1" },
      peerDependencies: { runtime: "1" },
    },
    "node_modules/@prover/backend/node_modules/worker": { version: "1", dependencies: { crypto: "1" } },
    "node_modules/native": { version: "1" },
    "node_modules/runtime": { version: "1" },
    "node_modules/crypto": { version: "1" },
    "node_modules/frontend": { version: "1" },
  };
  const lock = join(repo, "package-lock.json");
  await writeFile(lock, JSON.stringify({ packages }));
  const before = circuitInputFingerprint(repo);
  packages["node_modules/frontend"].version = "2";
  await writeFile(lock, JSON.stringify({ packages }));
  assert.equal(circuitInputFingerprint(repo), before);
  for (const [path, entry] of Object.entries(packages)) {
    if (path.endsWith("/frontend")) continue;
    entry.version = "2";
    await writeFile(lock, JSON.stringify({ packages }));
    assert.notEqual(circuitInputFingerprint(repo), before, path);
    entry.version = "1";
  }
});

test("source fingerprint is computed from the immutable bytes that are built", async () => {
  const repo = await mkdtemp(join(tmpdir(), "pcash-circuit-snapshot-source-"));
  const snapshots = await mkdtemp(join(tmpdir(), "pcash-circuit-snapshots-"));
  const source = join(repo, "circuits", "example", "src", "main.nr");
  await mkdir(dirname(source), { recursive: true });
  await writeFile(source, "fn main() { assert(true); }\n");

  const snapshot = createCircuitSourceSnapshot(repo, snapshots);
  assert.equal(circuitInputFingerprint(snapshot.root), snapshot.fingerprint);
  await writeFile(source, "fn main() { assert(false); }\n");
  assert.equal(await readFile(join(snapshot.root, "circuits", "example", "src", "main.nr"), "utf8"), "fn main() { assert(true); }\n");
  assert.notEqual(circuitInputFingerprint(repo), snapshot.fingerprint);
});

test("progress is written to stderr so command stdout can contain only the path", () => {
  const moduleUrl = new URL("./bundle.mjs", import.meta.url).href;
  const driver = [
    `import { spawnWithProgressOnStderr } from ${JSON.stringify(moduleUrl)};`,
    `const result = spawnWithProgressOnStderr(process.execPath, ["-e", "console.log('generator progress')"]);`,
    `if (result.status !== 0) process.exit(result.status ?? 1);`,
    `console.log("/cache/source/output");`,
  ].join("\n");
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", driver], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "/cache/source/output\n");
  assert.match(result.stderr, /generator progress/);
});

test("bundle validation rejects artifact tampering", async () => {
  const bundle = await mkdtemp(join(tmpdir(), "pcash-circuit-bundle-"));
  await populateBundle(bundle);
  writeCircuitBundleManifest(bundle, "a".repeat(64));
  assert.equal(validateCircuitBundle(bundle).inputFingerprint, "a".repeat(64));
  assert.throws(() => validateCircuitBundleForInputs(bundle, bundle), /different inputs/);
  await writeFile(join(bundle, requiredArtifacts[0]), "tampered");
  assert.throws(() => validateCircuitBundle(bundle), /digest mismatch/);
  assert.equal((await readFile(join(bundle, "bundle-manifest.json"), "utf8")).includes("tampered"), false);
});

test("a symlinked bundle path validates, but a symlinked artifact inside it does not", async () => {
  const bundle = await mkdtemp(join(tmpdir(), "pcash-circuit-bundle-"));
  await populateBundle(bundle);
  writeCircuitBundleManifest(bundle, "a".repeat(64));
  const link = join(await mkdtemp(join(tmpdir(), "pcash-circuit-bundle-link-")), "bundle");
  await symlink(bundle, link, "dir");
  assert.equal(validateCircuitBundle(link).inputFingerprint, "a".repeat(64));

  const outside = join(await mkdtemp(join(tmpdir(), "pcash-circuit-bundle-outside-")), "artifact");
  await rename(join(bundle, requiredArtifacts[0]), outside);
  await symlink(outside, join(bundle, requiredArtifacts[0]));
  assert.throws(() => validateCircuitBundle(link), /inventory differs/);
});

test("a known-answer entry cannot vouch for a replaced key", async () => {
  const bundle = await mkdtemp(join(tmpdir(), "pcash-circuit-bundle-override-"));
  await populateBundle(bundle);
  const manifest = writeCircuitBundleManifest(bundle, "a".repeat(64));
  const key = circuitCatalog()[0].verificationKeyPath;
  await writeFile(join(bundle, key), "replacement key");
  const replacement = createHash("sha256").update("replacement key").digest("hex");
  await writeFile(join(bundle, "bundle-manifest.json"), `${JSON.stringify({
    ...manifest, knownAnswers: { ...manifest.knownAnswers, [key]: replacement },
  }, null, 2)}\n`);
  assert.throws(() => validateCircuitBundle(bundle), /knownAnswers table lists a non-known-answer path/);
});

test("runtime bundles require the hiding-kernel KATs and exclude integration fixtures", async () => {
  const runtime = await mkdtemp(join(tmpdir(), "pcash-runtime-bundle-"));
  await populateBundle(runtime);
  const integrationArtifacts = staticRequiredArtifacts.filter(path =>
    path.startsWith("known-answers/real_event/") ||
    path.startsWith("known-answers/shared_claim_") ||
    path.startsWith("known-answers/large_sponsored_transfer/") ||
    path.startsWith("known-answers/large_asset_creation/"));
  for (const path of integrationArtifacts) await unlink(join(runtime, path));
  writeCircuitBundleManifest(runtime, "a".repeat(64), "runtime");
  assert.equal(validateCircuitBundle(runtime).katSet, "runtime");
  assert.throws(() => validateCircuitBundleForInputs(runtime, runtime, "full"), /known-answer set differs/);
  await writeFile(join(runtime, "known-answers/private_value/proof"), "tampered");
  assert.throws(() => validateCircuitBundle(runtime), /digest mismatch/);

  const incompleteFull = await mkdtemp(join(tmpdir(), "pcash-incomplete-full-bundle-"));
  await populateBundle(incompleteFull);
  for (const path of integrationArtifacts) await unlink(join(incompleteFull, path));
  writeCircuitBundleManifest(incompleteFull, "a".repeat(64), "full");
  assert.throws(() => validateCircuitBundle(incompleteFull), /missing required artifact/);
});

test("Cargo re-resolves the bundle when the known-answer set changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "pcash-cargo-bundle-mode-"));
  const crate = join(root, "node", "crates", "fixture");
  const resolver = join(root, "scripts", "circuits", "bundle.mjs");
  await mkdir(join(crate, "src"), { recursive: true });
  await mkdir(dirname(resolver), { recursive: true });
  for (const mode of ["runtime", "full"]) {
    const bundle = join(root, "bundles", mode);
    await mkdir(bundle, { recursive: true });
    await writeFile(join(bundle, "bundle-manifest.json"), mode);
  }
  await writeFile(join(root, "node", "circuit_bundle_build.rs"),
    await readFile(new URL("../../node/circuit_bundle_build.rs", import.meta.url)));
  await writeFile(resolver, [
    'import { join } from "node:path";',
    'import { fileURLToPath } from "node:url";',
    'if (process.argv.includes("--print-inputs")) process.exit(0);',
    'console.log(join(fileURLToPath(new URL("../..", import.meta.url)), "bundles", process.env.PCASH_CIRCUIT_KAT_SET));',
  ].join("\n"));
  await writeFile(join(crate, "Cargo.toml"),
    '[package]\nname = "pcash-bundle-mode-fixture"\nversion = "0.0.0"\nedition = "2021"\n');
  await writeFile(join(crate, "build.rs"), 'include!("../../circuit_bundle_build.rs");\n');
  await writeFile(join(crate, "src", "main.rs"),
    'fn main() { println!("{}", env!("PCASH_CIRCUIT_BUNDLE")); }\n');

  for (const mode of ["runtime", "full"]) {
    const env = { ...process.env, CARGO_TARGET_DIR: join(root, "target"), PCASH_CIRCUIT_KAT_SET: mode };
    delete env.PCASH_CIRCUIT_BUNDLE;
    delete env.PCASH_CIRCUIT_CACHE;
    const result = spawnSync("cargo", ["run", "--offline", "--quiet"], {
      cwd: crate, env, encoding: "utf8", timeout: 60_000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), join(realpathSync(root), "bundles", mode));
  }
});

test("the bundle digest covers circuits and keys but not the randomized known answers", async () => {
  const first = await mkdtemp(join(tmpdir(), "pcash-circuit-output-a-"));
  const second = await mkdtemp(join(tmpdir(), "pcash-circuit-output-b-"));
  await populateBundle(first);
  await populateBundle(second);
  // Another known-answer set from another source fingerprint.
  for (const path of requiredArtifacts.filter((path) => path.startsWith("known-answers/"))) {
    if (/^known-answers\/(?:real_event\/|shared_claim_|large_)/.test(path)) await unlink(join(second, path));
    else await writeFile(join(second, path), `${path}:another proof`);
  }
  const firstManifest = writeCircuitBundleManifest(first, "b".repeat(64), "full");
  const secondManifest = writeCircuitBundleManifest(second, "c".repeat(64), "runtime");
  assert.notDeepEqual(firstManifest.knownAnswers, secondManifest.knownAnswers);
  assert.equal(firstManifest.bundleDigest, secondManifest.bundleDigest);
  assert.equal(validateCircuitBundle(second).bundleDigest, firstManifest.bundleDigest);

  const changedKey = await mkdtemp(join(tmpdir(), "pcash-circuit-output-c-"));
  await populateBundle(changedKey);
  await writeFile(join(changedKey, circuitCatalog()[0].verificationKeyPath), "another key");
  assert.notEqual(writeCircuitBundleManifest(changedKey, "b".repeat(64), "full").bundleDigest, firstManifest.bundleDigest);
});

test("pins derived from the bundle are not bundle inputs", () => {
  const repo = fileURLToPath(new URL("../..", import.meta.url));
  const inputs = circuitInputFiles();
  for (const path of ["sdk/src/constants/proverArtifacts.ts", STACK_PINS_PATH, ...applicationPinPaths(circuitCatalog())]) {
    assert.equal(inputs.includes(join(repo, path)), false, path);
  }
});

test("a pin file an input imports stays out of the fingerprint and the snapshot", async () => {
  const repo = await mkdtemp(join(tmpdir(), "pcash-circuit-imported-pin-"));
  await writeSources(repo, {
    "scripts/circuits/generate_chonk_kats.mts": 'import "../../sdk/src/rules/referenceRules.ts";\n',
    "sdk/src/rules/referenceRules.ts": 'export { PAYMENT_RULE_VK_HASH } from "../constants/rulePins.ts";\n',
    [RULE_PINS_PATH]: "export const PAYMENT_RULE_VK_HASH = 1n;\n",
  });
  const before = circuitInputFingerprint(repo);
  await writeFile(join(repo, RULE_PINS_PATH), "export const PAYMENT_RULE_VK_HASH = 2n;\n");
  assert.equal(circuitInputFingerprint(repo), before);
  const snapshot = createCircuitSourceSnapshot(repo);
  assert.equal(existsSync(join(snapshot.root, "sdk/src/rules/referenceRules.ts")), true);
  assert.equal(existsSync(join(snapshot.root, RULE_PINS_PATH)), false);
});

test("every call_data bus and stack pin a protocol circuit reads is a declared link", async () => {
  const repo = fileURLToPath(new URL("../..", import.meta.url));
  const catalog = circuitCatalog();
  const pinOf = new Map(catalog.map((circuit) => [circuit.packageName, circuit.pin]));
  const protocol = catalog.filter((entry) => entry.owner === "protocol");
  const sources = new Map(await Promise.all(protocol.map(async (circuit) =>
    [circuit.packageName, await readFile(join(repo, circuit.packagePath, "src", "main.nr"), "utf8")])));
  const returnsData = (name) => /->\s*return_data\b/.test(sources.get(name));
  for (const circuit of protocol) {
    const source = sources.get(circuit.packageName);
    const buses = [...source.matchAll(/\bcall_data\((\d+)\)/g)].map((match) => Number(match[1]));
    const read = circuit.links.filter((link) => link.folds === "application" || link.folds.every(returnsData));
    assert.deepEqual(buses.sort(), read.map((link) => link.callData).sort(), circuit.releaseId);
    const imported = [...source.matchAll(/protocol_stack_hashes::\{?([A-Z0-9_,\s]+)\}?;/g)]
      .flatMap((match) => match[1].split(",").map((name) => name.trim()).filter(Boolean));
    const folded = circuit.links.flatMap((link) => link.folds === "application" ? [] : link.folds);
    assert.deepEqual(imported.sort(), folded.map((name) => pinOf.get(name)).sort(), circuit.releaseId);
  }
});

test("each stack pin is derived after the pins of the circuits it folds", async () => {
  const catalog = circuitCatalog();
  const file = join(await mkdtemp(join(tmpdir(), "pcash-stack-pins-")), "protocol_stack_hashes.nr");
  const pinned = (source, constant) => !new RegExp(`${constant}: Field = 0;`).test(source);
  const byName = new Map(catalog.map((circuit) => [circuit.packageName, circuit]));
  let next = 1;
  const hashes = deriveStackPins(catalog, file, (circuit) => {
    const source = readFileSync(file, "utf8");
    for (const name of circuit.links.flatMap((link) => link.folds === "application" ? [] : link.folds)) {
      assert.equal(pinned(source, byName.get(name).pin), true, `${circuit.packageName} before ${name}`);
    }
    assert.equal(pinned(source, circuit.pin), false, circuit.packageName);
    return `0x${(next++).toString(16)}`;
  });
  assert.equal(hashes.size, catalog.filter((circuit) => circuit.pin !== undefined).length);
  for (const [name, hash] of hashes) assert.match(readFileSync(file, "utf8"), new RegExp(`${byName.get(name).pin}: Field = ${hash};`));
});

test("a dead local generator lock is reclaimed without waiting for the timeout", async () => {
  const lock = await mkdtemp(join(tmpdir(), "pcash-circuit-dead.lock-"));
  await writeFile(
    join(lock, "owner.json"),
    `${JSON.stringify({ hostname: "test-host", pid: 424242, processBirthIdentity: "birth-a", startedAt: 1, token: "ab".repeat(16) })}\n`,
  );
  assert.equal(
    reclaimStaleCircuitBundleLock(lock, {
      currentHostname: "test-host",
      isProcessAlive: () => false,
      now: 2,
    }),
    true,
  );
  assert.equal(existsSync(lock), false);
});

test("a live local generator retains its lock", async () => {
  const lock = await mkdtemp(join(tmpdir(), "pcash-circuit-live.lock-"));
  await writeFile(
    join(lock, "owner.json"),
    `${JSON.stringify({ hostname: "test-host", pid: 424242, processBirthIdentity: "birth-a", startedAt: 1, token: "cd".repeat(16) })}\n`,
  );
  assert.equal(
    reclaimStaleCircuitBundleLock(lock, {
      currentHostname: "test-host",
      getProcessBirthIdentity: () => "birth-a",
      isProcessAlive: () => true,
      now: 24 * 60 * 60 * 1000,
    }),
    false,
  );
  assert.equal(existsSync(lock), true);
});

test("a reused live PID cannot retain a local lock", async () => {
  const lock = await mkdtemp(join(tmpdir(), "pcash-circuit-reused-pid.lock-"));
  await writeFile(
    join(lock, "owner.json"),
    `${JSON.stringify({ hostname: "test-host", pid: 424242, processBirthIdentity: "birth-a", startedAt: 1, token: "ef".repeat(16) })}\n`,
  );
  assert.equal(
    reclaimStaleCircuitBundleLock(lock, {
      currentHostname: "test-host",
      getProcessBirthIdentity: () => "birth-b",
      isProcessAlive: () => true,
      now: 2,
    }),
    true,
  );
  assert.equal(existsSync(lock), false);
});
