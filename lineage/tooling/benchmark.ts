import { writeFile, mkdir, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { cpus, platform, release, arch } from "node:os";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { Barretenberg, BackendType } from "@aztec-foundation/bb.js";
import { createChonkCircuitResolver } from "@pcash/sdk/node";
import { nativeChonkBackend, proverReleaseConfig } from "@pcash/sdk/node";
import { transferTransactionStack } from "@pcash/sdk/prover";
import { proveChonkStack } from "@pcash/sdk/prover";
import { eventsCommitment } from "@pcash/sdk/protocol";
import { PRIVATE_VALUE_PROFILES } from "@pcash/sdk/constants";
import { field32 } from "@pcash/sdk/utils";
import { lineageFixture } from "../src/fixture.ts";
import { ancestryGrowth } from "../src/growth.ts";

const bundle = process.env.PCASH_CIRCUIT_BUNDLE;
if (!bundle) throw new Error("PCASH_CIRCUIT_BUNDLE must identify the source-matched prototype bundle");
const output = resolve(process.argv[2] ?? "lineage-benchmark-results");
const runs = Number(process.env.LINEAGE_BENCH_RUNS ?? 3);
const resolver = createChonkCircuitResolver({ artifactDirectory: join(bundle, "prover-assets"), verificationKeyDirectory: join(bundle, "vks"), threads: 1 });
const lineage = await resolver("event_lineage", "app");
const report = {
  kind: "pcash-lineage-native-benchmark", recordedAt: new Date().toISOString(),
  commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  patchSha256: createHash("sha256").update(execFileSync("git", ["diff"])).digest("hex"),
  bundle, manifest: JSON.parse(await readFile(join(bundle, "bundle-manifest.json"), "utf8")),
  device: { platform: platform(), os: release(), arch: arch(), cpu: cpus()[0]?.model },
  settings: { threads: 1, runs, backend: "native", phone: "unmeasured; provisional comparison to S profile only" },
  samples: [] as Array<Record<string, unknown>>,
  growth: [1, 2, 4].map(fanIn => ancestryGrowth({ population: 256, rounds: 32, fanIn, seed: 703 })),
};
const tools = proverReleaseConfig(); process.env.CRS_PATH ??= tools.crs;
for (let run = 0; run < runs; run++) for (const k of [0, 1]) {
  const assemblyStart = performance.now();
  const fixture = await lineageFixture(resolver, k === 1);
  let stack = await transferTransactionStack({ build: fixture.build, authorizationPackage: fixture.build.authorizationCircuit, authorizationWitnessMap: fixture.build.accountRuleWitnessMap!, resolve: resolver, ...(k === 1 ? { eventApplication: fixture.eventApplication } : {}) });
  const assemblyMs = performance.now() - assemblyStart;
  const start = performance.now();
  const proof = await proveChonkStack(stack.steps, stack.publicInputs, nativeChonkBackend(1));
  const proveMs = performance.now() - start;
  const api = await Barretenberg.new({ backend: BackendType.NativeUnixSocket, bbPath: tools.bb, threads: 1 });
  let verifyMs: number;
  try {
    const verifyStart = performance.now();
    const decoded = await api.chonkDecompressProof({ compressedProof: Uint8Array.from([...stack.publicInputs.flatMap(value => [...field32(value)]), ...proof.proof]) });
    if (!(await api.chonkVerify({ proof: decoded.proof, vk: proof.hidingVerificationKey })).valid) throw new Error("generated lineage proof rejected");
    verifyMs = performance.now() - verifyStart;
  } finally { await api.destroy(); }
  const sample = { run, k, assemblyMs, proveMs, verifyMs, proofBytes: proof.proof.length, transactionBytes: fixture.build.encodeTransaction(proof.proof).length, eventFixtureWitnessBytes: new TextEncoder().encode(JSON.stringify(fixture.eventApplication?.witnessMap ?? {})).length, circuits: stack.steps.map(step => step.name) };
  report.samples.push(sample);
  console.log(JSON.stringify(sample));
  await mkdir(output, { recursive: true }); await writeFile(join(output, "native.json"), JSON.stringify(report, null, 2) + "\n");
}
