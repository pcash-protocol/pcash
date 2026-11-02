#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  assertContractFunctionPresentationAbi,
  assertContractPresentationProfile,
  assertSourceVerificationManifest,
  canonicalAbiSha256,
  canonicalJson,
  configurationProfileCommitment,
  applicationVkHash,
  CHONK_VERIFIER_TARGET,
  PCASH_APPLICATION_RETURN_FIELDS,
  sha256Hex,
  SOURCE_VERIFICATION_BUNDLE_FORMAT,
  SOURCE_VERIFICATION_PROOF_PROFILE,
  SOURCE_VERIFICATION_SCHEMA_VERSION,
  sourceBundleDigest,
  type ContractSourceVerificationManifest,
  type ContractConfigurationBinding,
  type ConfigurationOpening,
  type ContractFunctionPresentation,
  type ContractPresentationProfile,
  type ContractPresentationDisplayFormat,
  type SourceFileAttachment,
  type SourceVerifiedImplementation,
  type ToolchainIdentity,
  validatePcashNoirAbi,
  verificationKeyFields,
} from "../../sdk/src/source-verification/sourceVerification.ts";
import { BN254_SCALAR_MODULUS, fieldToHex } from "../../sdk/src/crypto/field.ts";
import { createPscanClient } from "../../sdk/src/clients/index.ts";
import { createAdminClient } from "../../sdk/src/clients/adminClient.ts";
import { assertToolchain, platformKey, TOOLCHAIN_PLATFORMS, type ToolchainPlatform, type ToolPaths } from "../../sdk/src/node/index.ts";
import { Config } from "../../sdk/src/bcfg/index.ts";
import { Logger } from "../../sdk/src/blgr/index.ts";

export const SOURCE_VERIFICATION_MANIFEST = "pcash-contract-source.json";
export const SOURCE_VERIFICATION_REPRODUCER = fileURLToPath(import.meta.url);

export interface SourceVerificationPublication {
  manifest: ContractSourceVerificationManifest;
  attachments: Record<string, string>;
}

const SCRIPT_DIR = dirname(SOURCE_VERIFICATION_REPRODUCER);
const REPO_ROOT = dirname(dirname(SCRIPT_DIR));
const PROVER_TOOLCHAIN_MANIFEST = join(REPO_ROOT, "assets", "prover-toolchain.json");
const REPRODUCER_RUNTIME_FILES = [
  SOURCE_VERIFICATION_REPRODUCER,
  PROVER_TOOLCHAIN_MANIFEST,
  join(REPO_ROOT, "sdk", "src", "source-verification", "sourceVerification.ts"),
  join(REPO_ROOT, "sdk", "src", "crypto", "field.ts"),
  join(REPO_ROOT, "sdk", "src", "clients", "index.ts"),
  join(REPO_ROOT, "sdk", "src", "node", "index.ts"),
] as const;

export const PRODUCER_PLATFORMS = TOOLCHAIN_PLATFORMS;
export type ProducerPlatform = ToolchainPlatform;

interface ReleaseArchive {
  url: string;
  sha256: string;
}

interface ProverToolchainReleaseManifest {
  schemaVersion: 1;
  nargo: {
    version: string;
    noircCommit: string;
    archives: Record<ProducerPlatform, ReleaseArchive>;
  };
  barretenberg: {
    version: string;
    archives: Record<ProducerPlatform, ReleaseArchive>;
  };
  crs: {
    bn254G2: ReleaseArchive;
  };
}

interface ParsedReleaseManifest {
  manifest: ProverToolchainReleaseManifest;
  sha256: string;
}

interface CurrentToolchain {
  release: ToolPaths;
  rawReleaseManifest: Uint8Array;
  verifierPlatform: ProducerPlatform;
}

export interface SourceVerificationPackageDefinition {
  id: string;
  implementationLabel: string;
  packageRoot: string;
  packageName: string;
  expectedApplicationVkHash: bigint;
}

export interface SourceVerificationDefinition {
  presentation: ContractPresentationProfile;
  implementations: readonly SourceVerificationPackageDefinition[];
  configurationBindings: readonly ContractConfigurationBinding[];
}

function required(config: Config, name: string): string {
  const value = config.str(name);
  if (value === null) throw new Error(`--${name} is required`);
  return value;
}

function rejectUnknownFlags(config: Config, names: readonly string[]): void {
  const allowed = new Set(names.map((name) => name.replace(/-/g, "")));
  for (const key of Object.keys(config.args)) if (!allowed.has(key)) throw new Error(`unknown flag --${key}`);
}

function normalizeRepoPath(path: string): string {
  return path.split(sep).join("/");
}

function assertInside(root: string, candidate: string, label: string): void {
  const rel = relative(root, candidate);
  if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))) return;
  throw new Error(`${label} escapes ${root}`);
}

function assertPortableRelativePath(path: string, label: string): void {
  if (
    !path
    || path.length > 1024
    || isAbsolute(path)
    || path.includes("\\")
    || path.split("/").some((part) => part === "" || part === "." || part === "..")
    || [...path].some((character) => character !== "/" && !/[A-Za-z0-9._-]/.test(character))
  ) {
    throw new Error(`${label} must be a portable relative path`);
  }
}

function resolveAttachment(bundleRoot: string, attachment: string): string {
  assertPortableRelativePath(attachment, "attachment path");
  const target = resolve(bundleRoot, attachment);
  assertInside(bundleRoot, target, "attachment");
  return target;
}

function sha256File(path: string): string {
  return sha256Hex(new Uint8Array(readFileSync(path)));
}

function packageName(manifest: string): string {
  const packageBlock = /\[package\]([\s\S]*?)(?:\n\s*\[|$)/.exec(manifest)?.[1] ?? "";
  const name = /^\s*name\s*=\s*"([^"]+)"\s*$/m.exec(packageBlock)?.[1];
  if (!name) throw new Error("Nargo.toml has no package name");
  return nargoPackageName(name, "Nargo package name");
}

function pathDependencies(manifest: string): string[] {
  const dependencies: string[] = [];
  const regex = /\bpath\s*=\s*"([^"]+)"/g;
  for (let match = regex.exec(manifest); match; match = regex.exec(manifest)) dependencies.push(match[1]!);
  return dependencies;
}

function listFilesRecursively(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`source package contains symlink ${path}`);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(path);
      else throw new Error(`source package contains unsupported entry ${path}`);
    }
  };
  visit(root);
  return files;
}

/** Resolve the complete local-path Nargo dependency closure without rewriting manifests. */
export function collectNargoSourceClosure(repoRoot: string, initialPackageRoot: string): string[] {
  const repo = resolve(repoRoot);
  const queue = [resolve(repo, initialPackageRoot)];
  const packages = new Set<string>();
  const files = new Set<string>();
  while (queue.length > 0) {
    const packageDir = queue.shift()!;
    assertInside(repo, packageDir, "Nargo package");
    const packageRel = normalizeRepoPath(relative(repo, packageDir));
    if (packages.has(packageRel)) continue;
    packages.add(packageRel);
    const nargoToml = join(packageDir, "Nargo.toml");
    if (!existsSync(nargoToml)) throw new Error(`missing ${nargoToml}`);
    const manifest = readFileSync(nargoToml, "utf8");
    files.add(normalizeRepoPath(relative(repo, nargoToml)));
    const src = join(packageDir, "src");
    if (!existsSync(src) || !lstatSync(src).isDirectory()) throw new Error(`missing source directory ${src}`);
    for (const path of listFilesRecursively(src)) files.add(normalizeRepoPath(relative(repo, path)));
    for (const dependency of pathDependencies(manifest)) {
      const dependencyRoot = resolve(packageDir, dependency);
      assertInside(repo, dependencyRoot, `path dependency ${dependency}`);
      queue.push(dependencyRoot);
    }
  }
  return [...files].sort();
}

function ensureNewDirectory(path: string): void {
  if (existsSync(path)) throw new Error(`refusing to overwrite existing output ${path}`);
  mkdirSync(path, { recursive: true });
}

function copySourceFiles(
  repoRoot: string,
  bundleRoot: string,
  paths: readonly string[],
): SourceFileAttachment[] {
  return paths.map((path) => {
    const source = resolve(repoRoot, path);
    assertInside(repoRoot, source, "source file");
    const attachment = `source/${path}`;
    const destination = resolveAttachment(bundleRoot, attachment);
    mkdirSync(dirname(destination), { recursive: true });
    if (existsSync(destination)) {
      if (sha256File(destination) !== sha256File(source)) throw new Error(`source collision at ${path}`);
    } else {
      copyFileSync(source, destination);
    }
    const bytes = new Uint8Array(readFileSync(source));
    return { path, attachment, length: bytes.length, sha256: sha256Hex(bytes) };
  });
}

function copySourceTree(repoRoot: string, scratchRoot: string, paths: readonly string[]): void {
  for (const path of paths) {
    const source = resolve(repoRoot, path);
    assertInside(repoRoot, source, "source file");
    const destination = resolveAttachment(scratchRoot, path);
    mkdirSync(dirname(destination), { recursive: true });
    if (existsSync(destination)) {
      if (sha256File(destination) !== sha256File(source)) throw new Error(`source collision at ${path}`);
    } else {
      copyFileSync(source, destination);
    }
  }
}

interface NoirArtifact {
  noir_version?: unknown;
  abi?: unknown;
  bytecode?: unknown;
}

function readCompiledArtifact(path: string): { artifact: NoirArtifact; acir: Uint8Array; abi: unknown } {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as NoirArtifact;
  if (typeof parsed.bytecode !== "string" || parsed.bytecode.length === 0) {
    throw new Error(`compiled artifact ${path} has no bytecode`);
  }
  validatePcashNoirAbi(parsed.abi);
  return { artifact: parsed, acir: Uint8Array.from(Buffer.from(parsed.bytecode, "base64")), abi: parsed.abi };
}

function canonicalCompilerArtifact(artifact: NoirArtifact): string {
  return canonicalJson({ noir_version: artifact.noir_version, abi: artifact.abi, bytecode: artifact.bytecode });
}

function run(bin: string, args: string[], cwd: string): void {
  try {
    execFileSync(bin, args, { cwd, stdio: "inherit", maxBuffer: 256 * 1024 * 1024 });
  } catch (error) {
    throw new Error(`${bin} ${args.join(" ")} failed in ${cwd}`, { cause: error });
  }
}

function releaseArchive(value: unknown, label: string): ReleaseArchive {
  const archive = objectValue(value, label);
  return {
    url: stringValue(archive.url, `${label}.url`),
    sha256: normalizedSha256(archive.sha256, `${label}.sha256`),
  };
}

function releaseArchives(value: unknown, label: string): Record<ProducerPlatform, ReleaseArchive> {
  const account = objectValue(value, label);
  const archives = {} as Record<ProducerPlatform, ReleaseArchive>;
  for (const platform of PRODUCER_PLATFORMS) archives[platform] = releaseArchive(account[platform], `${label}.${platform}`);
  return archives;
}

export function parseProverToolchainReleaseManifest(raw: Uint8Array | string): ParsedReleaseManifest {
  const bytes = typeof raw === "string" ? new Uint8Array(Buffer.from(raw, "utf8")) : raw;
  const parsed = objectValue(JSON.parse(Buffer.from(bytes).toString("utf8")), "prover toolchain release manifest");
  compare("prover toolchain release manifest schema version", quantity(parsed.schemaVersion, "schemaVersion"), 1);
  const nargo = objectValue(parsed.nargo, "prover toolchain release manifest.nargo");
  const barretenberg = objectValue(parsed.barretenberg, "prover toolchain release manifest.barretenberg");
  const crs = objectValue(parsed.crs, "prover toolchain release manifest.crs");
  return {
    sha256: sha256Hex(bytes),
    manifest: {
      schemaVersion: 1,
      nargo: {
        version: stringValue(nargo.version, "release nargo.version"),
        noircCommit: stringValue(nargo.noircCommit, "release nargo.noircCommit"),
        archives: releaseArchives(nargo.archives, "release nargo.archives"),
      },
      barretenberg: {
        version: stringValue(barretenberg.version, "release barretenberg.version"),
        archives: releaseArchives(barretenberg.archives, "release barretenberg.archives"),
      },
      crs: { bn254G2: releaseArchive(crs.bn254G2, "release crs.bn254G2") },
    },
  };
}

function producerPlatformValue(value: unknown, label: string): ProducerPlatform {
  const platform = stringValue(value, label);
  if (!(PRODUCER_PLATFORMS as readonly string[]).includes(platform)) {
    throw new Error(`${label} is not a supported producer platform`);
  }
  return platform as ProducerPlatform;
}

/** Construct the producer identity from the release archive metadata, never the extracted host binaries. */
export function buildPortableToolchainIdentity(
  rawReleaseManifest: Uint8Array | string,
  producerPlatform: ProducerPlatform,
  crs: ToolchainIdentity["crs"],
): ToolchainIdentity {
  const release = parseProverToolchainReleaseManifest(rawReleaseManifest);
  const platform = producerPlatformValue(producerPlatform, "producerPlatform");
  const g1 = normalizedSha256(crs.bn254G1Sha256, "crs.bn254G1Sha256");
  const g2 = normalizedSha256(crs.bn254G2Sha256, "crs.bn254G2Sha256");
  compare("BN254 G2 CRS", release.manifest.crs.bn254G2.sha256, g2);
  return {
    releaseManifestSha256: release.sha256,
    producerPlatform: platform,
    nargo: {
      version: release.manifest.nargo.version,
      noircCommit: release.manifest.nargo.noircCommit,
      archiveSha256: release.manifest.nargo.archives[platform].sha256,
    },
    barretenberg: {
      version: release.manifest.barretenberg.version,
      verifierTarget: CHONK_VERIFIER_TARGET,
      archiveSha256: release.manifest.barretenberg.archives[platform].sha256,
    },
    crs: { bn254G1Sha256: g1, bn254G2Sha256: g2 },
  };
}

function normalizedPortableToolchainIdentity(value: unknown, label: string): ToolchainIdentity {
  const published = objectValue(value, label);
  const producerPlatform = producerPlatformValue(published.producerPlatform, `${label}.producerPlatform`);
  const nargo = objectValue(published.nargo, `${label}.nargo`);
  const barretenberg = objectValue(published.barretenberg, `${label}.barretenberg`);
  const crs = objectValue(published.crs, `${label}.crs`);
  const releaseManifestSha256 = normalizedSha256(published.releaseManifestSha256, `${label}.releaseManifestSha256`);
  const nargoVersion = stringValue(nargo.version, `${label}.nargo.version`);
  const noircCommit = stringValue(nargo.noircCommit, `${label}.nargo.noircCommit`);
  const nargoArchiveSha256 = normalizedSha256(nargo.archiveSha256, `${label}.nargo.archiveSha256`);
  const barretenbergVersion = stringValue(barretenberg.version, `${label}.barretenberg.version`);
  compare(
    `${label}.barretenberg.verifierTarget`,
    CHONK_VERIFIER_TARGET,
    stringValue(barretenberg.verifierTarget, `${label}.barretenberg.verifierTarget`),
  );
  const bbArchiveSha256 = normalizedSha256(barretenberg.archiveSha256, `${label}.barretenberg.archiveSha256`);
  const bn254G1Sha256 = normalizedSha256(crs.bn254G1Sha256, `${label}.crs.bn254G1Sha256`);
  const bn254G2Sha256 = normalizedSha256(crs.bn254G2Sha256, `${label}.crs.bn254G2Sha256`);
  return {
    releaseManifestSha256,
    producerPlatform,
    nargo: {
      version: nargoVersion,
      noircCommit,
      archiveSha256: nargoArchiveSha256,
    },
    barretenberg: {
      version: barretenbergVersion,
      verifierTarget: CHONK_VERIFIER_TARGET,
      archiveSha256: bbArchiveSha256,
    },
    crs: { bn254G1Sha256, bn254G2Sha256 },
  };
}

/** Validate producer metadata against this checkout's exact raw release manifest. */
export function validatePortableToolchainIdentity(
  value: unknown,
  rawReleaseManifest: Uint8Array | string,
  label = "toolchain",
): ToolchainIdentity {
  const release = parseProverToolchainReleaseManifest(rawReleaseManifest);
  const identity = normalizedPortableToolchainIdentity(value, label);
  compare(`${label}.releaseManifestSha256`, release.sha256, identity.releaseManifestSha256);
  compare(`${label}.nargo.version`, release.manifest.nargo.version, identity.nargo.version);
  compare(`${label}.nargo.noircCommit`, release.manifest.nargo.noircCommit, identity.nargo.noircCommit);
  compare(
    `${label}.nargo.archiveSha256`,
    release.manifest.nargo.archives[identity.producerPlatform].sha256,
    identity.nargo.archiveSha256,
  );
  compare(`${label}.barretenberg.version`, release.manifest.barretenberg.version, identity.barretenberg.version);
  compare(
    `${label}.barretenberg.archiveSha256`,
    release.manifest.barretenberg.archives[identity.producerPlatform].sha256,
    identity.barretenberg.archiveSha256,
  );
  compare(`${label}.crs.bn254G2Sha256`, release.manifest.crs.bn254G2.sha256, identity.crs.bn254G2Sha256);
  return identity;
}

function currentToolchain(): CurrentToolchain {
  const rawReleaseManifest = new Uint8Array(readFileSync(PROVER_TOOLCHAIN_MANIFEST));
  const parsed = parseProverToolchainReleaseManifest(rawReleaseManifest);
  const release = assertToolchain();
  compare("local BN254 G2 CRS", parsed.manifest.crs.bn254G2.sha256, sha256File(release.bn254G2));
  return {
    release,
    rawReleaseManifest,
    verifierPlatform: platformKey(),
  };
}

/** Fail unless this script's portable runtime tree and pinned prover are ready. */
export function checkSourceVerificationReproducer(): void {
  for (const path of REPRODUCER_RUNTIME_FILES) {
    if (!existsSync(path) || !statSync(path).isFile()) {
      throw new Error(`source-verification reproducer runtime file is missing at ${path}`);
    }
  }
  materializedCrs(currentToolchain());
}

function materializedCrs(toolchain: CurrentToolchain): ToolchainIdentity["crs"] {
  const { bn254G1: g1, bn254G2: g2 } = toolchain.release;
  if (!existsSync(g1) || !lstatSync(g1).isFile()) throw new Error(`BN254 G1 CRS was not materialized at ${g1}`);
  if (!existsSync(g2) || !lstatSync(g2).isFile()) throw new Error(`BN254 G2 CRS is missing at ${g2}`);
  return { bn254G1Sha256: sha256File(g1), bn254G2Sha256: sha256File(g2) };
}

/** Source-verified contract functions are application circuits. */
function writeApplicationVk(toolchain: CurrentToolchain, artifactPath: string, outputDirectory: string, cwd: string): void {
  run(
    toolchain.release.bb,
    ["write_vk", "-s", CHONK_VERIFIER_TARGET, "--circuit_kind", "app", "-b", artifactPath, "-o", outputDirectory, "-c", toolchain.release.crs],
    cwd,
  );
}

function materializedToolchainIdentity(toolchain: CurrentToolchain): ToolchainIdentity {
  return buildPortableToolchainIdentity(toolchain.rawReleaseManifest, toolchain.verifierPlatform, materializedCrs(toolchain));
}

export function assertMatchingCrsDigests(
  expected: ToolchainIdentity["crs"],
  computed: ToolchainIdentity["crs"],
  label = "CRS",
): void {
  compare(`${label} BN254 G1 CRS`, expected.bn254G1Sha256, computed.bn254G1Sha256);
  compare(`${label} BN254 G2 CRS`, expected.bn254G2Sha256, computed.bn254G2Sha256);
}

function verifyMaterializedCrs(label: string, expected: ToolchainIdentity, toolchain: CurrentToolchain): void {
  assertMatchingCrsDigests(expected.crs, materializedCrs(toolchain), label);
}

function writeCanonicalArtifacts(
  bundleRoot: string,
  definition: SourceVerificationPackageDefinition,
  artifact: NoirArtifact,
  rawVkPath: string,
): Pick<SourceVerifiedImplementation, "compilerArtifact" | "noirProvingAbi" | "verificationKey" | "applicationVkHash"> {
  const artifactAttachment = `artifacts/${definition.id}/artifact.json`;
  const abiAttachment = `artifacts/${definition.id}/abi.json`;
  const vkAttachment = `artifacts/${definition.id}/vk`;
  const artifactBytes = Buffer.from(canonicalCompilerArtifact(artifact));
  const abiBytes = Buffer.from(canonicalJson(artifact.abi));
  const vkBytes = new Uint8Array(readFileSync(rawVkPath));
  verificationKeyFields(vkBytes);
  for (const [attachment, bytes] of [
    [artifactAttachment, artifactBytes],
    [abiAttachment, abiBytes],
    [vkAttachment, vkBytes],
  ] as const) {
    const destination = resolveAttachment(bundleRoot, attachment);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, bytes, { flag: "wx" });
  }
  const decodedAcir = Uint8Array.from(Buffer.from(artifact.bytecode as string, "base64"));
  return {
    applicationVkHash: fieldToHex(applicationVkHash(vkBytes)),
    compilerArtifact: {
      attachment: artifactAttachment,
      sha256: sha256Hex(artifactBytes),
      decodedAcirSha256: sha256Hex(decodedAcir),
    },
    noirProvingAbi: {
      attachment: abiAttachment,
      sha256: sha256Hex(abiBytes),
    },
    verificationKey: {
      attachment: vkAttachment,
      sha256: sha256Hex(vkBytes),
      fieldCount: verificationKeyFields(vkBytes).length,
    },
  };
}

function buildImplementation(
  repoRoot: string,
  bundleRoot: string,
  scratchRoot: string,
  definition: SourceVerificationPackageDefinition,
  presentations: readonly ContractFunctionPresentation[],
  toolchain: ReturnType<typeof currentToolchain>,
): SourceVerifiedImplementation {
  const sourcePaths = collectNargoSourceClosure(repoRoot, definition.packageRoot);
  const sourceFiles = copySourceFiles(repoRoot, bundleRoot, sourcePaths);
  copySourceTree(repoRoot, scratchRoot, sourcePaths);
  const copiedPackageRoot = resolveAttachment(scratchRoot, definition.packageRoot);
  const copiedManifest = readFileSync(join(copiedPackageRoot, "Nargo.toml"), "utf8");
  const actualPackageName = packageName(copiedManifest);
  if (actualPackageName !== definition.packageName) {
    throw new Error(`${definition.packageRoot} package name is ${actualPackageName}, expected ${definition.packageName}`);
  }
  run(toolchain.release.nargo, ["compile", "--package", definition.packageName], copiedPackageRoot);
  const rawArtifactPath = join(copiedPackageRoot, "target", `${definition.packageName}.json`);
  const { artifact } = readCompiledArtifact(rawArtifactPath);
  for (const presentation of presentations) assertContractFunctionPresentationAbi(presentation, artifact.abi);
  const vkWork = join(scratchRoot, ".vk", definition.id);
  mkdirSync(vkWork, { recursive: true });
  writeApplicationVk(toolchain, rawArtifactPath, vkWork, copiedPackageRoot);
  const outputs = writeCanonicalArtifacts(bundleRoot, definition, artifact, join(vkWork, "vk"));
  if (outputs.applicationVkHash !== fieldToHex(definition.expectedApplicationVkHash)) {
    throw new Error(
      `${definition.id} application VK hash mismatch: expected ${fieldToHex(definition.expectedApplicationVkHash)}, got ${outputs.applicationVkHash}`,
    );
  }
  return {
    id: definition.id,
    implementationLabel: definition.implementationLabel,
    packageRoot: definition.packageRoot,
    packageName: definition.packageName,
    sourceBundleDigest: sourceBundleDigest(sourceFiles),
    sourceFiles,
    ...outputs,
    toolchain: materializedToolchainIdentity(toolchain),
  };
}

export interface BuildSourceBundleResult {
  manifest: ContractSourceVerificationManifest;
  scratchRoot: string;
}

export function buildSourceBundle(
  output: string,
  definition: SourceVerificationDefinition,
  repoRoot = REPO_ROOT,
  serviceName = "PCASH Node Operator",
): BuildSourceBundleResult {
  if (serviceName.trim() === "") throw new Error("service name must not be empty");
  if (definition.implementations.length === 0) throw new Error("source verification definition must contain implementations");
  if (definition.configurationBindings.length === 0) {
    throw new Error("source verification definition must contain configurationBindings");
  }
  const applicationVkHashes = new Set(definition.implementations.map((implementation) =>
    fieldToHex(implementation.expectedApplicationVkHash)
  ));
  if (applicationVkHashes.size !== definition.implementations.length) {
    throw new Error("source verification definition contains duplicate application VK hashes");
  }
  const boundApplicationVkHashes = new Set<string>();
  for (const [index, binding] of definition.configurationBindings.entries()) {
    if (!applicationVkHashes.has(binding.applicationVkHash)) {
      throw new Error(`configurationBindings[${index}] names an implementation absent from the definition`);
    }
    boundApplicationVkHashes.add(binding.applicationVkHash);
  }
  if (boundApplicationVkHashes.size !== applicationVkHashes.size) {
    throw new Error("every source implementation must be used by a configuration binding");
  }
  assertContractPresentationProfile(definition.presentation, definition.configurationBindings);
  const bundleRoot = resolve(output);
  ensureNewDirectory(bundleRoot);
  const scratchRoot = mkdtempSync(join(tmpdir(), "pcash-contract-build-"));
  const toolchain = currentToolchain();
  const implementations = definition.implementations.map((implementation) =>
    buildImplementation(
      resolve(repoRoot),
      bundleRoot,
      scratchRoot,
      implementation,
      definition.presentation.functions.filter(
        (fn) => fn.applicationVkHash === fieldToHex(implementation.expectedApplicationVkHash),
      ),
      toolchain,
    ),
  );
  const manifest: ContractSourceVerificationManifest = {
    schemaVersion: SOURCE_VERIFICATION_SCHEMA_VERSION,
    bundleFormat: SOURCE_VERIFICATION_BUNDLE_FORMAT,
    generatedAt: new Date().toISOString(),
    serviceName,
    proofProfile: {
      id: SOURCE_VERIFICATION_PROOF_PROFILE,
      returnFields: PCASH_APPLICATION_RETURN_FIELDS,
      returnVisibility: "databus",
    },
    presentation: definition.presentation,
    implementations,
    configurationBindings: [...definition.configurationBindings],
    configurationOpenings: [],
  };
  writeFileSync(join(bundleRoot, SOURCE_VERIFICATION_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  return { manifest, scratchRoot };
}

function manifestPath(input: string): string {
  const resolved = resolve(input);
  return existsSync(resolved) && lstatSync(resolved).isDirectory()
    ? join(resolved, SOURCE_VERIFICATION_MANIFEST)
    : resolved;
}

/** Package an offline source bundle for submission to a node-owned registry. */
export function sourceVerificationPublication(input: string): SourceVerificationPublication {
  const path = manifestPath(input);
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  assertSourceVerificationManifest(parsed);
  const names = new Set<string>();
  for (const implementation of parsed.implementations) {
    for (const source of implementation.sourceFiles) names.add(source.attachment);
    names.add(implementation.compilerArtifact.attachment);
    names.add(implementation.noirProvingAbi.attachment);
    names.add(implementation.verificationKey.attachment);
  }
  const root = dirname(path);
  const attachments = Object.fromEntries([...names].sort().map((name) => [
    name,
    readFileSync(resolveAttachment(root, name)).toString("base64"),
  ]));
  return { manifest: parsed, attachments };
}

/** The wire shape `pscan_submitContractSource` accepts: an operator publication bound to a closed set of canonical contracts. */
export interface SourceSubmissionEnvelope {
  contractAddresses: string[];
  publication: SourceVerificationPublication;
}

/**
 * Read one built bundle directory and bind it to the canonical contracts it
 * verifies (comma-separated addresses): every manifest-referenced attachment
 * is collected through the bundle containment helpers, so traversal or
 * absolute paths are rejected.
 */
export function buildSubmissionEnvelope(bundlePath: string, contractAddresses: string): SourceSubmissionEnvelope {
  const addresses = contractAddresses.split(",").map((value) => normalizedAddress(value.trim(), "contract address"));
  if (addresses.length === 0) throw new Error("at least one contract address is required");
  return {
    contractAddresses: addresses,
    publication: sourceVerificationPublication(bundlePath),
  };
}

export interface VerificationFunctionSummary {
  selector: number | bigint;
  name?: string | undefined;
  applicationVkHash: string;
  inRegistry: boolean;
}

export interface VerificationSummaryLike {
  address: string;
  verified: boolean;
  functions: VerificationFunctionSummary[];
}

export interface ServiceInfoLike {
  status: string;
  sourceSubmissionStatus: string;
  configurationOpeningSubmissionStatus: string;
}

/** Render the human-readable `check` report; exits stay the caller's decision. */
export function formatContractVerificationReport(
  summary: VerificationSummaryLike,
  info: ServiceInfoLike,
): string {
  const lines = [`${summary.address}: ${summary.verified ? "VERIFIED" : "NOT VERIFIED"}`];
  for (const entry of summary.functions) {
    const selector = `0x${entry.selector.toString(16).padStart(2, "0")}`;
    lines.push(
      `${selector}${entry.name === undefined ? "" : ` ${entry.name}`} vk ${entry.applicationVkHash} ${entry.inRegistry ? "present" : "MISSING"}`,
    );
  }
  lines.push(
    `service: status=${info.status} sourceSubmissions=${info.sourceSubmissionStatus} configurationOpeningSubmissions=${info.configurationOpeningSubmissionStatus}`,
  );
  return lines.join("\n");
}

/** Map application VK hash → human id from a submitted manifest, for submit output lines. */
function submissionImplementationLabels(manifest: ContractSourceVerificationManifest): Map<string, string> {
  const labels = new Map<string, string>();
  manifest.implementations.forEach((implementation, index) => {
    labels.set(
      normalizedField(implementation.applicationVkHash, `manifest.implementations[${index}].applicationVkHash`).toLowerCase(),
      implementationId(implementation.id, `manifest.implementations[${index}].id`),
    );
  });
  return labels;
}

/** Add validated openings to an in-memory manifest without changing its bundle on disk. */
export function sourceVerificationManifestWithConfigurationOpenings(
  manifest: ContractSourceVerificationManifest,
  values: unknown,
): ContractSourceVerificationManifest {
  const openings = arrayValue(values, "configuration openings")
    .map((opening, index) => validatedOpening(manifest, opening, `configuration openings[${index}]`));
  if (openings.length === 0) throw new Error("configuration openings must not be empty");
  const openingKeys = new Set<string>();
  for (const opening of openings) {
    const key = `${opening.address}:${opening.selector}`;
    if (openingKeys.has(key)) throw new Error(`duplicate configuration opening ${key}`);
    openingKeys.add(key);
  }
  return {
    ...manifest,
    configurationOpenings: [
      ...manifest.configurationOpenings.filter(
        (opening) => !openingKeys.has(`${opening.address}:${opening.selector}`),
      ),
      ...openings,
    ],
  };
}

/** Package one source bundle with additional in-memory openings for direct publication. */
export function sourceVerificationPublicationWithConfigurationOpenings(
  input: string,
  values: unknown,
): SourceVerificationPublication {
  const publication = sourceVerificationPublication(input);
  return {
    ...publication,
    manifest: sourceVerificationManifestWithConfigurationOpenings(publication.manifest, values),
  };
}

/** Operator publication goes to the node's admin listener, not the pscan one. */
export async function publishSourceVerification(input: string, adminUrl: string): Promise<void> {
  const endpoint = new URL(adminUrl);
  if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
    throw new Error("admin RPC URL must use HTTP or HTTPS");
  }
  const info = await createAdminClient(endpoint.toString())
    .publishSourceVerification(sourceVerificationPublication(input));
  if (info.status !== "ready" || !info.writable) throw new Error("node source registry did not remain writable after publication");
}

function compare(label: string, expected: unknown, computed: unknown): void {
  if (expected !== computed) throw new Error(`${label} mismatch: expected ${String(expected)}, got ${String(computed)}`);
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function arrayValue(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  return value;
}

function implementationId(value: unknown, label: string): string {
  const id = stringValue(value, label);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) {
    throw new Error(`${label} must be a portable implementation identifier`);
  }
  return id;
}

function nargoPackageName(value: unknown, label: string): string {
  const name = stringValue(value, label);
  if (!/^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(name)) {
    throw new Error(`${label} must be a Nargo package identifier`);
  }
  return name;
}

function normalizedSha256(value: unknown, label: string): string {
  const input = stringValue(value, label).toLowerCase();
  const normalized = input.startsWith("0x") ? input.slice(2) : input;
  if (!/^[0-9a-f]{64}$/.test(normalized)) throw new Error(`${label} must be a SHA-256 digest`);
  return normalized;
}

function normalizedField(value: unknown, label: string): `0x${string}` {
  const input = stringValue(value, label).toLowerCase();
  const normalized = input.startsWith("0x") ? input.slice(2) : input;
  if (!/^[0-9a-f]{64}$/.test(normalized)) throw new Error(`${label} must be a 32-byte field`);
  if (BigInt(`0x${normalized}`) >= BN254_SCALAR_MODULUS) throw new Error(`${label} must be a canonical BN254 field`);
  return `0x${normalized}`;
}

function normalizedAddress(value: unknown, label: string): `0x${string}` {
  const input = stringValue(value, label).toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(input)) throw new Error(`${label} must be a canonical 20-byte address`);
  return input as `0x${string}`;
}

function quantity(value: unknown, label: string): number {
  let parsed: bigint;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) parsed = BigInt(value);
  else if (typeof value === "string" && /^(?:0x[0-9a-f]+|[0-9]+)$/i.test(value)) parsed = BigInt(value);
  else throw new Error(`${label} must be a nonnegative JSON-RPC quantity`);
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${label} exceeds the safe integer range`);
  return Number(parsed);
}

function comparePublishedToolchain(label: string, value: unknown, toolchain: CurrentToolchain): ToolchainIdentity {
  return validatePortableToolchainIdentity(value, toolchain.rawReleaseManifest, `${label} toolchain`);
}

function verifyAttachment(path: string, expectedLength: number | undefined, expectedSha256: string): Uint8Array {
  if (!existsSync(path) || !lstatSync(path).isFile()) throw new Error(`missing attachment ${path}`);
  const bytes = new Uint8Array(readFileSync(path));
  if (expectedLength !== undefined) compare(`${path} length`, expectedLength, bytes.length);
  compare(`${path} SHA-256`, expectedSha256, sha256Hex(bytes));
  return bytes;
}

function copyVerifiedSources(
  bundleRoot: string,
  scratchRoot: string,
  implementations: readonly SourceVerifiedImplementation[],
): void {
  const copied = new Map<string, string>();
  for (const implementation of implementations) {
    for (const source of implementation.sourceFiles) {
      const bytes = verifyAttachment(resolveAttachment(bundleRoot, source.attachment), source.length, source.sha256);
      const prior = copied.get(source.path);
      if (prior !== undefined && prior !== source.sha256) throw new Error(`conflicting source attachment ${source.path}`);
      copied.set(source.path, source.sha256);
      const destination = resolveAttachment(scratchRoot, source.path);
      if (!existsSync(destination)) {
        mkdirSync(dirname(destination), { recursive: true });
        writeFileSync(destination, bytes, { flag: "wx" });
      }
    }
    compare(`${implementation.id} source bundle digest`, implementation.sourceBundleDigest, sourceBundleDigest(implementation.sourceFiles));
  }
}

export interface ReproduceResult {
  manifestPath: string;
  scratchRoot: string;
  implementations: Array<{ id: string; applicationVkHash: string }>;
}

function isNodeContractSourceBundle(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const account = value as Record<string, unknown>;
  return Object.hasOwn(account, "contract") && !Object.hasOwn(account, "bundleFormat");
}

function applicationVkHashSet(
  values: readonly unknown[],
  label: string,
  readHash: (value: Record<string, unknown>, label: string) => unknown,
  rejectDuplicates: boolean,
): Set<string> {
  const hashes = new Set<string>();
  for (let index = 0; index < values.length; index++) {
    const entryLabel = `${label}[${index}]`;
    const value = objectValue(values[index], entryLabel);
    const hash = normalizedField(readHash(value, entryLabel), `${entryLabel}.applicationVkHash`);
    if (rejectDuplicates && hashes.has(hash)) throw new Error(`${label} contains duplicate applicationVkHash ${hash}`);
    hashes.add(hash);
  }
  return hashes;
}

function compareApplicationVkHashSets(expected: ReadonlySet<string>, computed: ReadonlySet<string>, label: string): void {
  const missing = [...expected].filter((hash) => !computed.has(hash)).sort();
  const extra = [...computed].filter((hash) => !expected.has(hash)).sort();
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `${label} application VK hash set mismatch: missing [${missing.join(", ")}], extra [${extra.join(", ")}]`,
    );
  }
}

function normalizedImplementationEvidence(value: unknown, label: string): Record<string, unknown> {
  const summary = objectValue(value, label);
  return {
    verificationStatus: stringValue(summary.verificationStatus, `${label}.verificationStatus`),
    verificationAuthority: stringValue(summary.verificationAuthority, `${label}.verificationAuthority`),
    verificationMethod: stringValue(summary.verificationMethod, `${label}.verificationMethod`),
    applicationVkHash: normalizedField(summary.applicationVkHash, `${label}.applicationVkHash`),
    implementationLabel: stringValue(summary.implementationLabel, `${label}.implementationLabel`),
    packageRoot: stringValue(summary.packageRoot, `${label}.packageRoot`),
    packageName: stringValue(summary.packageName, `${label}.packageName`),
    sourceBundleDigest: normalizedSha256(summary.sourceBundleDigest, `${label}.sourceBundleDigest`),
    compilerArtifactSha256: normalizedSha256(summary.compilerArtifactSha256, `${label}.compilerArtifactSha256`),
    decodedAcirSha256: normalizedSha256(summary.decodedAcirSha256, `${label}.decodedAcirSha256`),
    noirProvingAbiSha256: normalizedSha256(summary.noirProvingAbiSha256, `${label}.noirProvingAbiSha256`),
    verificationKeySha256: normalizedSha256(summary.verificationKeySha256, `${label}.verificationKeySha256`),
    verificationKeyFieldCount: quantity(summary.verificationKeyFieldCount, `${label}.verificationKeyFieldCount`),
    toolchain: normalizedPortableToolchainIdentity(summary.toolchain, `${label}.toolchain`),
  };
}

export interface ValidatedNodeContractSourceBundle {
  bundle: Record<string, unknown>;
  entries: unknown[];
  applicationVkHashes: Set<string>;
  presentation: ContractPresentationProfile;
}

function normalizedNodeContractPresentation(value: unknown): ContractPresentationProfile {
  const raw = objectValue(value, "contract.presentation.profile");
  const functions = arrayValue(raw.functions, "contract.presentation.profile.functions").map((functionValue, functionIndex) => {
    const fn = objectValue(functionValue, `contract.presentation.profile.functions[${functionIndex}]`);
    const configurationFields = arrayValue(
      fn.configurationFields,
      `contract.presentation.profile.functions[${functionIndex}].configurationFields`,
    ).map((fieldValue, fieldIndex) => {
      const field = objectValue(
        fieldValue,
        `contract.presentation.profile.functions[${functionIndex}].configurationFields[${fieldIndex}]`,
      );
      return {
        position: quantity(field.position, `contract presentation configuration field ${fieldIndex} position`),
        name: stringValue(field.name, `contract presentation configuration field ${fieldIndex} name`),
        label: stringValue(field.label, `contract presentation configuration field ${fieldIndex} label`),
        description: stringValue(field.description, `contract presentation configuration field ${fieldIndex} description`),
        displayFormat: stringValue(
          field.displayFormat,
          `contract presentation configuration field ${fieldIndex} displayFormat`,
        ) as ContractPresentationDisplayFormat,
        overviewOrder: field.overviewOrder === null
          ? null
          : quantity(field.overviewOrder, `contract presentation configuration field ${fieldIndex} overviewOrder`),
      };
    });
    const proofGroups = arrayValue(
      fn.proofGroups,
      `contract.presentation.profile.functions[${functionIndex}].proofGroups`,
    ).map((groupValue, groupIndex) => {
      const group = objectValue(groupValue, `contract presentation proof group ${groupIndex}`);
      return {
        title: stringValue(group.title, `contract presentation proof group ${groupIndex} title`),
        description: stringValue(group.description, `contract presentation proof group ${groupIndex} description`),
        items: arrayValue(group.items, `contract presentation proof group ${groupIndex} items`).map((itemValue, itemIndex) => {
          const item = objectValue(itemValue, `contract presentation proof group ${groupIndex} item ${itemIndex}`);
          return {
            abiParameter: stringValue(item.abiParameter, `contract presentation proof group ${groupIndex} item ${itemIndex} abiParameter`),
            description: stringValue(item.description, `contract presentation proof group ${groupIndex} item ${itemIndex} description`),
          };
        }),
      };
    });
    return {
      selector: quantity(fn.selector, `contract presentation function ${functionIndex} selector`),
      applicationVkHash: normalizedField(
        fn.applicationVkHash,
        `contract presentation function ${functionIndex} applicationVkHash`,
      ),
      name: stringValue(fn.name, `contract presentation function ${functionIndex} name`),
      summary: stringValue(fn.summary, `contract presentation function ${functionIndex} summary`),
      configurationFields,
      proofGroups,
    };
  });
  return {
    schemaVersion: quantity(raw.schemaVersion, "contract.presentation.profile.schemaVersion") as 1,
    publisherLabel: stringValue(raw.publisherLabel, "contract.presentation.profile.publisherLabel"),
    contractName: stringValue(raw.contractName, "contract.presentation.profile.contractName"),
    contractDescription: stringValue(raw.contractDescription, "contract.presentation.profile.contractDescription"),
    functions,
  };
}

/** Validate that the self-contained node export covers the complete verified contract function set exactly once. */
export function validateNodeContractSourceBundleStructure(raw: unknown): ValidatedNodeContractSourceBundle {
  const bundle = objectValue(raw, "contract source bundle");
  const contractView = objectValue(bundle.contract, "contract source bundle.contract");
  compare(
    "contract source bundle verification status",
    "verified",
    stringValue(contractView.verificationStatus, "contract.verificationStatus"),
  );
  const contract = objectValue(contractView.contract, "contract source bundle.contract.contract");
  compare(
    "contract source bundle contract address",
    normalizedAddress(contractView.address, "contract.address"),
    normalizedAddress(contract.address, "contract.contract.address"),
  );
  const functions = arrayValue(contract.functions, "contract.contract.functions");
  if (functions.length === 0) throw new Error("contract source bundle contract function set is empty");
  const presentationView = objectValue(contractView.presentation, "contract.presentation");
  stringValue(presentationView.verificationAuthority, "contract.presentation.verificationAuthority");
  stringValue(presentationView.verificationMethod, "contract.presentation.verificationMethod");
  const presentation = normalizedNodeContractPresentation(presentationView.profile);
  const presentationBindings = functions.map((functionValue, index) => {
    const fn = objectValue(functionValue, `contract.contract.functions[${index}]`);
    const presented = presentation.functions[index];
    if (presented === undefined) throw new Error("contract presentation function count does not match the contract");
    return {
      applicationVkHash: normalizedField(
        fn.applicationVkHash,
        `contract.contract.functions[${index}].applicationVkHash`,
      ),
      configurationProfile: {
        id: `contract-export-${index}`,
        implementationLabel: `contract-export-${index}`,
        selector: quantity(fn.selector, `contract.contract.functions[${index}].selector`),
        scheme: "poseidon-explicit-domain-positional-v1" as const,
        domain: fieldToHex(0n),
        fields: presented.configurationFields.map((field) => ({ name: field.name, type: "field" as const })),
      },
    };
  });
  assertContractPresentationProfile(presentation, presentationBindings);
  const functionHashes = applicationVkHashSet(
    functions,
    "contract.contract.functions",
    (value) => value.applicationVkHash,
    false,
  );
  const summaries = arrayValue(contractView.implementations, "contract.implementations");
  const summaryHashes = applicationVkHashSet(
    summaries,
    "contract.implementations",
    (value) => value.applicationVkHash,
    true,
  );
  const entries = arrayValue(bundle.implementations, "implementations");
  const bundleHashes = applicationVkHashSet(
    entries,
    "implementations",
    (value, entryLabel) => objectValue(objectValue(value.source, `${entryLabel}.source`).implementation, `${entryLabel}.source.implementation`).applicationVkHash,
    true,
  );
  compareApplicationVkHashSets(functionHashes, summaryHashes, "contract.implementations");
  compareApplicationVkHashSets(functionHashes, bundleHashes, "implementations");
  const summariesByHash = new Map<string, unknown>();
  for (let index = 0; index < summaries.length; index++) {
    const summary = objectValue(summaries[index], `contract.implementations[${index}]`);
    summariesByHash.set(
      normalizedField(summary.applicationVkHash, `contract.implementations[${index}].applicationVkHash`),
      summary,
    );
  }
  const bundleSummariesByHash = new Map<string, unknown>();
  for (let index = 0; index < entries.length; index++) {
    const entry = objectValue(entries[index], `implementations[${index}]`);
    const source = objectValue(entry.source, `implementations[${index}].source`);
    const summary = objectValue(source.implementation, `implementations[${index}].source.implementation`);
    bundleSummariesByHash.set(
      normalizedField(summary.applicationVkHash, `implementations[${index}].source.implementation.applicationVkHash`),
      summary,
    );
  }
  for (const hash of functionHashes) {
    const contractSummary = normalizedImplementationEvidence(
      summariesByHash.get(hash),
      `contract implementation ${hash}`,
    );
    const bundleSummary = normalizedImplementationEvidence(
      bundleSummariesByHash.get(hash),
      `bundle implementation ${hash}`,
    );
    compare(
      `contract and bundle implementation summary ${hash}`,
      canonicalJson(contractSummary),
      canonicalJson(bundleSummary),
    );
  }
  return { bundle, entries, applicationVkHashes: functionHashes, presentation };
}

function reproduceNodeContractSourceBundle(path: string, raw: unknown): ReproduceResult {
  const { entries, presentation } = validateNodeContractSourceBundleStructure(raw);
  const scratchRoot = mkdtempSync(join(tmpdir(), "pcash-contract-reproduce-"));
  const toolchain = currentToolchain();
  const results: ReproduceResult["implementations"] = [];
  const materializedSources = new Map<string, string>();
  for (let index = 0; index < entries.length; index++) {
    const entry = objectValue(entries[index], `implementations[${index}]`);
    const source = objectValue(entry.source, `implementations[${index}].source`);
    const summary = objectValue(source.implementation, `implementations[${index}].source.implementation`);
    const id = `implementation-${index}-${normalizedField(summary.applicationVkHash, "applicationVkHash").slice(2, 14)}`;
    const packageRoot = stringValue(summary.packageRoot, `${id} packageRoot`);
    const packageNameValue = nargoPackageName(summary.packageName, `${id} packageName`);
    const expectedApplicationVkHash = normalizedField(summary.applicationVkHash, `${id} applicationVkHash`);
    const metadata = arrayValue(source.sourceFiles, `${id} sourceFiles`);
    const fileEntries = arrayValue(entry.files, `${id} files`);
    const filesByPath = new Map<string, Record<string, unknown>>();
    for (const fileValue of fileEntries) {
      const file = objectValue(fileValue, `${id} file`);
      const logicalPath = stringValue(file.path, `${id} file path`);
      if (filesByPath.has(logicalPath)) throw new Error(`${id} duplicate inline source ${logicalPath}`);
      compare(
        `${id} ${logicalPath} application VK hash`,
        expectedApplicationVkHash,
        normalizedField(file.applicationVkHash, `${id} ${logicalPath} applicationVkHash`),
      );
      filesByPath.set(logicalPath, file);
    }
    const digestIndex: Array<Pick<SourceFileAttachment, "path" | "length" | "sha256">> = [];
    for (const metadataValue of metadata) {
      const fileMetadata = objectValue(metadataValue, `${id} source metadata`);
      const logicalPath = stringValue(fileMetadata.path, `${id} source path`);
      const file = filesByPath.get(logicalPath);
      if (!file) throw new Error(`${id} missing inline content for ${logicalPath}`);
      const content = stringValue(file.content, `${id} ${logicalPath} content`);
      const bytes = new Uint8Array(Buffer.from(content, "utf8"));
      const length = quantity(fileMetadata.length, `${id} ${logicalPath} length`);
      const expectedDigest = normalizedSha256(fileMetadata.sha256, `${id} ${logicalPath} sha256`);
      compare(`${id} ${logicalPath} inline sha256`, expectedDigest, normalizedSha256(file.sha256, `${id} inline sha256`));
      compare(`${id} ${logicalPath} length`, length, bytes.length);
      compare(`${id} ${logicalPath} content sha256`, expectedDigest, sha256Hex(bytes));
      digestIndex.push({ path: logicalPath, length, sha256: expectedDigest });
      const destination = resolveAttachment(scratchRoot, logicalPath);
      const priorDigest = materializedSources.get(logicalPath);
      if (priorDigest !== undefined && priorDigest !== expectedDigest) {
        throw new Error(`conflicting inline source ${logicalPath}`);
      }
      if (priorDigest === undefined) {
        mkdirSync(dirname(destination), { recursive: true });
        writeFileSync(destination, bytes, { flag: "wx" });
        materializedSources.set(logicalPath, expectedDigest);
      }
      filesByPath.delete(logicalPath);
    }
    if (filesByPath.size > 0) throw new Error(`${id} contains inline source absent from sourceFiles metadata`);
    compare(
      `${id} source bundle digest`,
      normalizedSha256(summary.sourceBundleDigest, `${id} sourceBundleDigest`),
      sourceBundleDigest(digestIndex),
    );
    const abi = source.noirProvingAbi;
    validatePcashNoirAbi(abi);
    for (const functionPresentation of presentation.functions) {
      if (functionPresentation.applicationVkHash === expectedApplicationVkHash) {
        assertContractFunctionPresentationAbi(functionPresentation, abi);
      }
    }
    compare(
      `${id} ABI`,
      normalizedSha256(summary.noirProvingAbiSha256, `${id} noirProvingAbiSha256`),
      canonicalAbiSha256(abi),
    );
    const publishedToolchain = comparePublishedToolchain(id, summary.toolchain, toolchain);
    const packageDirectory = resolveAttachment(scratchRoot, packageRoot);
    run(toolchain.release.nargo, ["compile", "--package", packageNameValue], packageDirectory);
    const rawArtifactPath = join(packageDirectory, "target", `${packageNameValue}.json`);
    const { artifact, acir, abi: rebuiltAbi } = readCompiledArtifact(rawArtifactPath);
    compare(
      `${id} decoded ACIR`,
      normalizedSha256(summary.decodedAcirSha256, `${id} decodedAcirSha256`),
      sha256Hex(acir),
    );
    compare(
      `${id} rebuilt ABI`,
      normalizedSha256(summary.noirProvingAbiSha256, `${id} noirProvingAbiSha256`),
      canonicalAbiSha256(rebuiltAbi),
    );
    compare(
      `${id} compiler artifact`,
      normalizedSha256(summary.compilerArtifactSha256, `${id} compilerArtifactSha256`),
      sha256Hex(canonicalCompilerArtifact(artifact)),
    );
    const vkOut = join(scratchRoot, ".vk", id);
    mkdirSync(vkOut, { recursive: true });
    writeApplicationVk(toolchain, rawArtifactPath, vkOut, packageDirectory);
    verifyMaterializedCrs(id, publishedToolchain, toolchain);
    const vk = new Uint8Array(readFileSync(join(vkOut, "vk")));
    compare(`${id} VK field count`, quantity(summary.verificationKeyFieldCount, `${id} verificationKeyFieldCount`), verificationKeyFields(vk).length);
    compare(`${id} VK`, normalizedSha256(summary.verificationKeySha256, `${id} verificationKeySha256`), sha256Hex(vk));
    const computedHash = fieldToHex(applicationVkHash(vk));
    compare(`${id} application VK hash`, expectedApplicationVkHash, computedHash);
    results.push({ id, applicationVkHash: computedHash });
  }
  return { manifestPath: path, scratchRoot, implementations: results };
}

export function reproduceContract(input: string): ReproduceResult {
  const path = manifestPath(input);
  const bundleRoot = dirname(path);
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (isNodeContractSourceBundle(parsed)) return reproduceNodeContractSourceBundle(path, parsed);
  const manifest = parsed;
  assertSourceVerificationManifest(manifest);
  const toolchain = currentToolchain();
  const scratchRoot = mkdtempSync(join(tmpdir(), "pcash-contract-reproduce-"));
  copyVerifiedSources(bundleRoot, scratchRoot, manifest.implementations);
  const results: ReproduceResult["implementations"] = [];
  for (let index = 0; index < manifest.implementations.length; index++) {
    const implementation = manifest.implementations[index]!;
    const id = implementationId(implementation.id, "implementation id");
    const packageNameValue = nargoPackageName(implementation.packageName, `${id} packageName`);
    const publishedToolchain = comparePublishedToolchain(id, implementation.toolchain, toolchain);
    verifyAttachment(resolveAttachment(bundleRoot, implementation.compilerArtifact.attachment), undefined, implementation.compilerArtifact.sha256);
    const bundledAbiBytes = verifyAttachment(resolveAttachment(bundleRoot, implementation.noirProvingAbi.attachment), undefined, implementation.noirProvingAbi.sha256);
    const bundledAbi = JSON.parse(Buffer.from(bundledAbiBytes).toString("utf8"));
    validatePcashNoirAbi(bundledAbi);
    for (const functionPresentation of manifest.presentation.functions) {
      if (functionPresentation.applicationVkHash === implementation.applicationVkHash) {
        assertContractFunctionPresentationAbi(functionPresentation, bundledAbi);
      }
    }
    verifyAttachment(resolveAttachment(bundleRoot, implementation.verificationKey.attachment), implementation.verificationKey.fieldCount * 32, implementation.verificationKey.sha256);
    const packageRoot = resolveAttachment(scratchRoot, implementation.packageRoot);
    run(toolchain.release.nargo, ["compile", "--package", packageNameValue], packageRoot);
    const rawArtifactPath = join(packageRoot, "target", `${packageNameValue}.json`);
    const { artifact, acir, abi } = readCompiledArtifact(rawArtifactPath);
    compare(`${id} decoded ACIR`, implementation.compilerArtifact.decodedAcirSha256, sha256Hex(acir));
    compare(`${id} ABI`, implementation.noirProvingAbi.sha256, canonicalAbiSha256(abi));
    compare(`${id} compiler artifact`, implementation.compilerArtifact.sha256, sha256Hex(canonicalCompilerArtifact(artifact)));
    const vkOut = join(scratchRoot, ".vk", id);
    mkdirSync(vkOut, { recursive: true });
    writeApplicationVk(toolchain, rawArtifactPath, vkOut, packageRoot);
    verifyMaterializedCrs(id, publishedToolchain, toolchain);
    const vk = new Uint8Array(readFileSync(join(vkOut, "vk")));
    compare(`${id} VK field count`, implementation.verificationKey.fieldCount, verificationKeyFields(vk).length);
    compare(`${id} VK`, implementation.verificationKey.sha256, sha256Hex(vk));
    const computedHash = fieldToHex(applicationVkHash(vk));
    compare(`${id} application VK hash`, implementation.applicationVkHash, computedHash);
    results.push({ id, applicationVkHash: computedHash });
  }
  return { manifestPath: path, scratchRoot, implementations: results };
}

function parseManifestForUpdate(path: string): ContractSourceVerificationManifest {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  assertSourceVerificationManifest(parsed);
  return parsed;
}

function atomicWriteManifest(path: string, manifest: ContractSourceVerificationManifest): void {
  const temporary = join(dirname(path), `.${basename(path)}.tmp-${process.pid}-${Date.now()}`);
  const mode = statSync(path).mode & 0o777;
  writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  chmodSync(temporary, mode);
  renameSync(temporary, path);
}

function validatedOpening(
  manifest: ContractSourceVerificationManifest,
  value: unknown,
  label: string,
): ConfigurationOpening {
  const raw = objectValue(value, label);
  const address = normalizedAddress(raw.address, `${label}.address`);
  if (!Number.isInteger(raw.selector) || Number(raw.selector) < 0 || Number(raw.selector) > 255) {
    throw new Error(`${label}.selector must fit uint8`);
  }
  const selector = Number(raw.selector);
  const applicationVkHash = normalizedField(raw.applicationVkHash, `${label}.applicationVkHash`);
  const implementation = manifest.implementations.find(
    (candidate) => candidate.applicationVkHash === applicationVkHash,
  );
  if (implementation === undefined) throw new Error(`${label} names an implementation absent from the bundle`);
  const binding = manifest.configurationBindings.find(
    (candidate) => candidate.applicationVkHash === applicationVkHash
      && candidate.configurationProfile.selector === selector,
  );
  if (binding === undefined) throw new Error(`${label} does not match a selector/VK configuration binding`);
  const profile = binding.configurationProfile;
  const domain = normalizedField(raw.domain, `${label}.domain`);
  if (domain !== profile.domain) throw new Error(`${label}.domain does not match the implementation profile`);
  const values = arrayValue(raw.values, `${label}.values`)
    .map((entry, index) => normalizedField(entry, `${label}.values[${index}]`));
  if (values.length !== profile.fields.length) throw new Error(`${label}.values has the wrong field count`);
  const inputValues = Object.fromEntries(profile.fields.map((field, index) => [field.name, values[index]!])) as Record<string, string>;
  const computedCommitment = fieldToHex(configurationProfileCommitment(profile, inputValues));
  const configurationCommitment = normalizedField(raw.configurationCommitment, `${label}.configurationCommitment`);
  if (computedCommitment !== configurationCommitment) {
    throw new Error(`${label}.configurationCommitment does not match the supplied values`);
  }
  return { address, selector, applicationVkHash, configurationCommitment, domain, values };
}

export function attachConfigurationOpenings(
  input: string,
  values: unknown,
): ContractSourceVerificationManifest {
  const path = manifestPath(input);
  const manifest = parseManifestForUpdate(path);
  const updated = sourceVerificationManifestWithConfigurationOpenings(manifest, values);
  atomicWriteManifest(path, updated);
  return updated;
}

function usage(): never {
  throw new Error(
    [
      "usage:",
      "  source-verification check [--rpc <pscan-url> --address <0x…40>]",
      "  source-verification build --definition <application-module> --out <new-directory> [--service-name <operator-name>]",
      "  source-verification reproduce-contract --bundle <bundle-directory-or-manifest>",
      "  source-verification attach-configurations --bundle <bundle> --openings <json-file>",
      "  source-verification publish --bundle <bundle> --admin-url <admin-url>",
      "  source-verification submit --rpc <pscan-url> --bundle <bundle-directory-or-manifest> --address <0x…40>",
    ].join("\n"),
  );
}

async function loadDefinition(path: string): Promise<SourceVerificationDefinition> {
  const module = await import(pathToFileURL(resolve(path)).href) as {
    sourceVerificationDefinition?: unknown;
  };
  const definition = objectValue(module.sourceVerificationDefinition, "sourceVerificationDefinition");
  const implementations = arrayValue(definition.implementations, "sourceVerificationDefinition.implementations");
  if (implementations.length === 0) throw new Error("sourceVerificationDefinition.implementations must not be empty");
  const configurationBindings = arrayValue(
    definition.configurationBindings,
    "sourceVerificationDefinition.configurationBindings",
  );
  if (configurationBindings.length === 0) {
    throw new Error("sourceVerificationDefinition.configurationBindings must not be empty");
  }
  return {
    presentation: definition.presentation as ContractPresentationProfile,
    implementations: implementations as unknown as SourceVerificationPackageDefinition[],
    configurationBindings: configurationBindings as unknown as ContractConfigurationBinding[],
  };
}

export async function main(argv = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const logger = new Logger("info");
  await logger.open();
  const flags = new Config("pcash");
  flags.load({ argv: ["node", "source-verification", ...argv], env });
  const [command, ...positionals] = flags.argv;
  if (!command) usage();
  if (positionals.length > 0) throw new Error(`unexpected positional arguments: ${positionals.join(" ")}`);
  if (command === "check") {
    if (flags.str("rpc") !== null || flags.str("address") !== null) {
      rejectUnknownFlags(flags, ["rpc", "address"]);
      const client = createPscanClient(required(flags, "rpc"));
      logger.raw(formatContractVerificationReport(
        await client.contractVerificationSummary(required(flags, "address")),
        await client.sourceVerificationInfo(),
      ));
      return;
    }
    rejectUnknownFlags(flags, []);
    checkSourceVerificationReproducer();
    logger.info(`source-verification reproducer ready: ${SOURCE_VERIFICATION_REPRODUCER}`);
    return;
  }
  if (command === "build") {
    rejectUnknownFlags(flags, ["definition", "out", "service-name"]);
    const output = required(flags, "out");
    const definition = await loadDefinition(required(flags, "definition"));
    const { manifest, scratchRoot } = buildSourceBundle(
      output,
      definition,
      REPO_ROOT,
      flags.str("service-name", "PCASH Node Operator"),
    );
    logger.info(`wrote ${join(resolve(output), SOURCE_VERIFICATION_MANIFEST)}`);
    logger.raw(manifest.implementations.map((entry) => `${entry.id}: ${entry.applicationVkHash}`).join("\n"));
    logger.info(`build scratch retained at ${scratchRoot}`);
    return;
  }
  if (command === "reproduce-contract") {
    rejectUnknownFlags(flags, ["bundle"]);
    const result = reproduceContract(required(flags, "bundle"));
    logger.info(`reproduced ${result.implementations.length} implementation(s)`);
    logger.info(`scratch retained at ${result.scratchRoot}`);
    return;
  }
  if (command === "attach-configurations") {
    rejectUnknownFlags(flags, ["bundle", "openings"]);
    const openings = JSON.parse(readFileSync(required(flags, "openings"), "utf8")) as unknown;
    attachConfigurationOpenings(required(flags, "bundle"), openings);
    logger.info(`attached configuration openings to ${manifestPath(required(flags, "bundle"))}`);
    return;
  }
  if (command === "publish") {
    rejectUnknownFlags(flags, ["bundle", "admin-url"]);
    await publishSourceVerification(required(flags, "bundle"), required(flags, "admin-url"));
    logger.info(`published ${manifestPath(required(flags, "bundle"))}`);
    return;
  }
  if (command === "submit") {
    rejectUnknownFlags(flags, ["rpc", "bundle", "address"]);
    const envelope = buildSubmissionEnvelope(
      required(flags, "bundle"),
      required(flags, "address"),
    );
    const result = await createPscanClient(required(flags, "rpc")).submitContractSource(envelope);
    logger.raw(`contentId ${result.contentId}`);
    logger.raw(`deduplicated ${result.deduplicated}`);
    const labels = submissionImplementationLabels(envelope.publication.manifest);
    for (const [index, implementation] of result.implementations.entries()) {
      const vk = implementation.applicationVkHash.toLowerCase();
      logger.raw(`${labels.get(vk) ?? `implementation-${index}`}: ${implementation.applicationVkHash}`);
    }
    return;
  }
  usage();
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(async (error: unknown) => {
    const logger = new Logger("info");
    await logger.open();
    logger.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
