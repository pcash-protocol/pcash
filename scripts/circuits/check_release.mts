import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WIRE_PROOF_BYTES } from "../../sdk/src/protocol/codec.ts";
import { circuitCatalog } from "./catalog.mjs";
import { KNOWN_ANSWERS } from "./known_answers.mjs";
import { refreshProverAssets } from "./refresh_prover_assets.mjs";
import { deriveStackPins, STACK_PINS_PATH } from "./stack_pins.mjs";
import { RULE_PINS_PATH, rulePinsSource } from "./application_pins.mjs";
import {
  PINNED_BARRETENBERG_VERSION,
  PINNED_NARGO_VERSION,
  PINNED_NOIRC_COMMIT,
  proverReleaseConfig,
} from "../../sdk/src/node/nativeProver.ts";
import { TOOLCHAIN } from "../../sdk/src/node/toolchain.ts";
import { type ChonkCircuitKind, vkFieldsFromBytes, vkFieldsHash } from "../../sdk/src/protocol/account.ts";
import { fieldToHex } from "../../sdk/src/crypto/field.ts";
import { Config } from "../../sdk/src/bcfg/index.ts";
import { Logger } from "../../sdk/src/blgr/index.ts";

const logger = new Logger("info");
await logger.open();

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
interface Args { out: string; runtimeKatsOnly: boolean }
type Role = "application" | "kernel" | "hiding";
interface CircuitSpec {
  releaseId: string;
  packageName: string;
  packagePath: string;
  ownerRoot: string;
  artifactId: string;
  targetPath: string;
  sourceArtifactPath: string;
  proverArtifactPath: string;
  verificationKeyPath: string;
  owner: string;
  publicInputs: number;
  role: Role;
  kind: ChonkCircuitKind;
  provingRuntimes: Array<"native" | "browser">;
  srsPoints: number;
}

// This file builds the checkout it sits in. A bundle build runs the copy in
// the disposable source snapshot, so compiling here never touches a working tree.
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const CIRCUITS_DIR = join(REPO_ROOT, "circuits");

const CATALOG = circuitCatalog(REPO_ROOT) as readonly CircuitSpec[];
const CIRCUITS = CATALOG.filter((circuit) => circuit.owner === "protocol");
const EXTERNAL_CIRCUITS = CATALOG.filter((circuit) => circuit.owner !== "protocol");
// Application libraries with tests of their own; no circuit package runs them.
const EXTERNAL_TEST_LIBRARIES = ["marketplace/l2-contracts/escrow/common"];

function usage(exitCode = 2): never {
  const text = "usage: node scripts/circuits/check_release.mts --out DIR [--runtime-kats-only]";
  if (exitCode === 0) logger.raw(text);
  else logger.error(text);
  process.exit(exitCode);
}

export function parseCircuitReleaseArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): Args {
  const config = new Config("pcash");
  config.load({ argv: ["node", "check_release.mts", ...argv], env });
  if (config.bool("help", false) || config.bool("h", false)) usage(0);
  const flags = ["runtimekatsonly", "out"];
  if (config.argv.length > 0 || Object.keys(config.args).some((key) => !flags.includes(key))) usage();
  const out = config.str("out");
  if (out === null || out === "true") usage();
  return { out, runtimeKatsOnly: config.bool("runtime-kats-only", false) };
}

function portable(value: Json, key = "manifest"): void {
  if (typeof value === "string") {
    if (isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value)) {
      throw new Error(`${key} contains an absolute path: ${value}`);
    }
  } else if (Array.isArray(value)) {
    value.forEach((entry, index) => portable(entry, `${key}[${index}]`));
  } else if (value !== null && typeof value === "object") {
    Object.entries(value).forEach(([child, entry]) => portable(entry, `${key}.${child}`));
  }
}

function canonical(value: Json): Json {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => [key, canonical(entry)]));
  }
  return value;
}

export function canonicalReleaseJson(value: Json): string {
  portable(value);
  return `${JSON.stringify(canonical(value), null, 2)}\n`;
}

function sha256(path: string): string {
  return createHash("sha256").update(new Uint8Array(readFileSync(path))).digest("hex");
}
function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
function acirSha256(path: string): string {
  const artifact = JSON.parse(readFileSync(path, "utf8")) as { bytecode?: unknown };
  if (typeof artifact.bytecode !== "string") throw new Error(`${path} has no bytecode`);
  return createHash("sha256").update(Buffer.from(artifact.bytecode, "base64")).digest("hex");
}
function run(bin: string, args: readonly string[], cwd: string, env = process.env): void {
  logger.info(`+ ${basename(bin)} ${args.join(" ")}`);
  execFileSync(bin, [...args], { cwd, env, stdio: "inherit", maxBuffer: 256 * 1024 * 1024 });
}
interface GeneratedCircuit { acir: string; circuitSize: number; kind: ChonkCircuitKind; vk: string }

function vkHash({ vk, kind }: Pick<GeneratedCircuit, "vk" | "kind">): string {
  return fieldToHex(vkFieldsHash(vkFieldsFromBytes(readFileSync(vk), kind, vk), kind));
}

function chonkCircuitSize(bb: string, acir: string, cwd: string): number {
  const result = spawnSync(bb, ["gates", "-s", "chonk", "-b", acir], {
    cwd,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`bb gates failed for ${acir}:\n${result.stderr}`);
  const output = result.stdout;
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error(`bb gates emitted no JSON for ${acir}`);
  const parsed = JSON.parse(output.slice(start, end + 1)) as { functions?: Array<{ circuit_size?: unknown }> };
  const size = parsed.functions?.[0]?.circuit_size;
  if (!Number.isSafeInteger(size) || Number(size) < 1) throw new Error(`bb gates emitted no circuit size for ${acir}`);
  return Number(size);
}
function requiredSrsPoints(circuitSize: number): number {
  return Math.max(2 ** 18, 2 ** Math.ceil(Math.log2(circuitSize)));
}
function rejectedProofIsDifferent(path: string, rejected: string): void {
  const good = readFileSync(path);
  const bad = readFileSync(rejected);
  if (good.length !== bad.length || good.equals(bad)) throw new Error(`${rejected} is not a same-length negative KAT`);
}

function main(): void {
  const args = parseCircuitReleaseArgs(process.argv.slice(2));
  const workDir = mkdtempSync(join(tmpdir(), "pcash-chonk-release-"));
  try {
    emitRelease(args, workDir);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

function emitRelease(args: Args, workDir: string): void {
  const tools = proverReleaseConfig();
  run(process.execPath, ["scripts/gen_network_profile.mjs", "--check"], REPO_ROOT);
  const networkProfile = JSON.parse(readFileSync(join(REPO_ROOT, "assets", "network_profile.json"), "utf8")) as {
    defaultNetwork: string;
    networks: Record<string, { profile: string }>;
    eip712?: Json;
  };
  if (!networkProfile.networks[networkProfile.defaultNetwork]?.profile || networkProfile.eip712 === undefined) throw new Error("network profile is incomplete");

  const outDir = resolve(process.cwd(), args.out);
  if (existsSync(outDir)) throw new Error(`output directory already exists: ${outDir}`);
  mkdirSync(join(outDir, "vks"), { recursive: true });
  // bb refuses a circuit with gates or databus columns its kind's flavor does
  // not constrain, such as a kernel lookup or an application call_data read
  // (sdk/test/circuitKindRefusals.proving.test.ts).
  const writeVk =(circuit: Pick<CircuitSpec, "kind" | "sourceArtifactPath">, scratch: string, cwd: string): string => {
    mkdirSync(scratch, { recursive: true });
    run(tools.bb, [
      "write_vk", "-s", "chonk", "--circuit_kind", circuit.kind, "-b", join(REPO_ROOT, circuit.sourceArtifactPath),
      "-o", scratch, "-c", tools.crs,
    ], cwd);
    return join(scratch, "vk");
  };

  // Each pin is the Mega VK hash of a circuit compiled against the pins before
  // it; the workspace compile below builds every circuit against the result.
  deriveStackPins(circuitCatalog(REPO_ROOT), join(REPO_ROOT, STACK_PINS_PATH), (circuit) => {
    run(tools.nargo, ["compile", "--package", circuit.packageName, "--force"], CIRCUITS_DIR);
    const vk = writeVk(circuit, join(workDir, "stack-pins", circuit.packageName), CIRCUITS_DIR);
    return vkHash({ vk, kind: circuit.kind });
  });
  run(tools.nargo, ["compile", "--workspace", "--force"], CIRCUITS_DIR);
  run(tools.nargo, ["test", "--workspace", "--force"], CIRCUITS_DIR);
  for (const circuit of EXTERNAL_CIRCUITS) {
    const directory = join(REPO_ROOT, circuit.packagePath);
    run(tools.nargo, ["compile", "--force"], directory);
    run(tools.nargo, ["test", "--force"], directory);
  }
  for (const library of EXTERNAL_TEST_LIBRARIES) run(tools.nargo, ["test", "--force"], join(REPO_ROOT, library));
  refreshProverAssets({ sourceRoot: REPO_ROOT, outputRoot: outDir });

  const generated: Record<string, GeneratedCircuit> = {};
  for (const circuit of [...CIRCUITS, ...EXTERNAL_CIRCUITS]) {
    const directory = circuit.owner === "protocol" ? CIRCUITS_DIR : join(REPO_ROOT, circuit.packagePath);
    const acir = join(REPO_ROOT, circuit.sourceArtifactPath);
    const emitted = join(outDir, circuit.verificationKeyPath);
    mkdirSync(dirname(emitted), { recursive: true });
    copyFileSync(writeVk(circuit, join(workDir, "vks", circuit.releaseId), directory), emitted);
    const circuitSize = chonkCircuitSize(tools.bb, acir, directory);
    generated[circuit.releaseId] = { acir, circuitSize, kind: circuit.kind, vk: emitted };
  }

  for (const spec of [...CIRCUITS, ...EXTERNAL_CIRCUITS]) {
    const name = spec.releaseId;
    const circuit = generated[name]!;
    const expected = spec.srsPoints;
    const actual = requiredSrsPoints(circuit.circuitSize);
    if (actual !== expected) {
      throw new Error(`${name} ${spec.provingRuntimes.join("/")} SRS profile drift: expected ${expected}, got ${actual} for ${circuit.circuitSize} gates`);
    }
  }

  // The rule pins are derived like the stack pins: the known-answer proofs
  // below build their rule sets from this build tree's copy, never the
  // committed one.
  writeFileSync(join(REPO_ROOT, RULE_PINS_PATH), rulePinsSource(CATALOG, new Map(CIRCUITS
    .filter((circuit) => circuit.role === "application")
    .map((circuit) => [circuit.packageName, vkHash(generated[circuit.releaseId]!)]))));

  const knownAnswers = join(outDir, "known-answers");
  // The scratch directory is TMPDIR, not the build tree: bb.js binds a Unix
  // socket under it, and a socket path has a short length limit.
  run(process.execPath, [
    join(REPO_ROOT, "scripts", "circuits", "generate_chonk_kats.mts"),
    "--artifacts", join(outDir, "prover-assets"),
    "--vks", join(outDir, "vks"),
    "--out", knownAnswers,
    ...(args.runtimeKatsOnly ? ["--runtime-only"] : []),
  ], REPO_ROOT, { ...process.env, TMPDIR: workDir });
  for (const answer of KNOWN_ANSWERS.filter((answer) => answer.runtime || !args.runtimeKatsOnly)) {
    const dir = join(knownAnswers, answer.name);
    const proof = join(dir, "proof");
    const rejected = join(dir, "proof.rejected");
    const publicInputs = join(dir, "public_inputs");
    const hidingKernel = CIRCUITS.find((circuit) => circuit.packageName === answer.hidingKernel)!;
    if (readFileSync(proof).length !== WIRE_PROOF_BYTES) throw new Error(`${answer.name} proof length drift`);
    if (readFileSync(publicInputs).length !== hidingKernel.publicInputs * 32) throw new Error(`${answer.name} public input length drift`);
    rejectedProofIsDifferent(proof, rejected);
  }

  const common = {
    generatedBy: "scripts/circuits/check_release.mts",
    schemaVersion: 2,
    profile: { name: networkProfile.networks[networkProfile.defaultNetwork]!.profile, sha256: sha256Text(JSON.stringify(networkProfile.eip712)) },
    toolchain: {
      barretenberg: PINNED_BARRETENBERG_VERSION,
      bn254G2Sha256: TOOLCHAIN.crs.bn254G2.sha256,
      grumpkinG1Sha256: TOOLCHAIN.crs.grumpkinG1.sha256,
      nargo: PINNED_NARGO_VERSION,
      noircCommit: PINNED_NOIRC_COMMIT,
    },
  } satisfies Json;
  const entries = Object.fromEntries(CIRCUITS.map((circuit) => [circuit.packageName, {
    acirSha256: acirSha256(generated[circuit.releaseId]!.acir),
    circuitSize: generated[circuit.releaseId]!.circuitSize,
    megaVkHash: vkHash(generated[circuit.releaseId]!),
    publicInputs: circuit.publicInputs,
    provingRuntimes: circuit.provingRuntimes,
    srsPoints: circuit.srsPoints,
    releaseId: circuit.releaseId,
    role: circuit.role,
    vkSha256: sha256(generated[circuit.releaseId]!.vk),
  }]));
  const protocolManifest = {
    ...common,
    owner: "protocol",
    circuits: entries,
  } satisfies Json;
  writeFileSync(join(outDir, "protocol-manifest.json"), canonicalReleaseJson(protocolManifest));
  for (const owner of new Set(EXTERNAL_CIRCUITS.map((circuit) => circuit.owner))) {
    const manifest = {
      ...common,
      owner,
      circuits: Object.fromEntries(EXTERNAL_CIRCUITS.filter((circuit) => circuit.owner === owner)
        .map((circuit) => [circuit.packageName, {
          acirSha256: acirSha256(generated[circuit.releaseId]!.acir),
          circuitSize: generated[circuit.releaseId]!.circuitSize,
          applicationVkHash: vkHash(generated[circuit.releaseId]!),
          releaseId: circuit.releaseId,
          vkSha256: sha256(generated[circuit.releaseId]!.vk),
        }])),
    } satisfies Json;
    writeFileSync(join(outDir, `${owner}-manifest.json`), canonicalReleaseJson(manifest));
  }

  logger.info(`circuit bundle candidate emitted: ${outDir}`);
}

const invokedAs = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedAs === fileURLToPath(import.meta.url)) main();
