// Generate the checked-in pins that come from this checkout's circuit bundle
// and the installed prover toolchain: the protocol stack pins, the rule and
// contract application pins, every circuit and CHONK VK the browser prover
// fetches, the pinned CRS elements, and the G1 profile slices served under /crs.
//
// None of these files is a circuit-bundle input, so regenerating them never
// changes the bundle's input fingerprint: the pins are written in one pass
// after the bundle. Bundle generation derives the stack, rule and contract
// pins in its own build tree, and no module it imports may import
// proverArtifacts.ts.
//
// Run:                node scripts/circuits/gen_release_pins.mjs     (just pins)
// Verify (no write):  node scripts/circuits/gen_release_pins.mjs --check
//
// The bundle is PCASH_CIRCUIT_BUNDLE when set, else the cached or freshly
// generated one. Its digests come from bundle-manifest.json, the VK hash pins
// from its owner manifests, the G2/Grumpkin digests from
// assets/prover-toolchain.json, and the G1 profile slices are hashed from the
// BN254 G1 CRS in the pinned tool root.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureCircuitBundle } from "./bundle.mjs";
import { createBrowserProverManifest, resolveBrowserProverAssets } from "./browser_assets.mjs";
import { circuitCatalog } from "./catalog.mjs";
import { STACK_PINS_PATH, stackPinsSource } from "./stack_pins.mjs";
import { applicationPinOutputs } from "./application_pins.mjs";
import { generatedHeader, runGenerator } from "../generated_files.mjs";
import { assertToolchain, TOOLCHAIN } from "../../sdk/src/node/toolchain.ts";
import { BN254_G2_CRS_KEY, bn254G1CrsKey, GRUMPKIN_G1_CRS_KEY } from "../../sdk/src/prover/crs.ts";
import { SUPPORTED_SRS_POINTS } from "../../sdk/src/prover/profile.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const GENERATED_HEADER = generatedHeader("scripts/circuits/gen_release_pins.mjs", [
  "the circuit bundle", "assets/prover-toolchain.json", "the BN254 G1 CRS in the pinned tool root",
]);

const tools = assertToolchain();
const bundleDir = ensureCircuitBundle();
const manifest = JSON.parse(readFileSync(join(bundleDir, "bundle-manifest.json"), "utf8"));

const catalog = circuitCatalog(ROOT);
const releaseCircuits = new Map([...new Set(catalog.map((circuit) => circuit.owner))].map((owner) => [owner,
  JSON.parse(readFileSync(join(bundleDir, `${owner}-manifest.json`), "utf8")).circuits]));
const vkHashes = new Map(catalog.map((circuit) => {
  const entry = releaseCircuits.get(circuit.owner)[circuit.packageName];
  return [circuit.packageName, entry.megaVkHash ?? entry.applicationVkHash];
}));

const entries = new Map();
const applicationEntries = new Map();
const lineageIds = new Set(catalog.filter(c => c.owner === "lineage").map(c => c.artifactId));
for (const [artifact, digest] of Object.entries(manifest.artifacts)) {
  if (artifact.startsWith("prover-assets/")) {
    const id = artifact.slice("prover-assets/".length).replace(/\.json$/, "");
    (lineageIds.has(id) ? applicationEntries : entries).set(`/prover/${id}.json`, digest);
  } else if (artifact.startsWith("vks/") && artifact.endsWith(".chonk.vk")) {
    const id = artifact.slice("vks/".length).replace(/\.chonk\.vk$/, "");
    (lineageIds.has(id) ? applicationEntries : entries).set(`/chonk-vks/${id}.vk`, digest);
  }
}

// Every runtime SRS profile has a pinned /crs digest so the worker fails closed
// on any of them, even the ones a deployment does not host yet.
const g1 = readFileSync(tools.bn254G1);
for (const points of SUPPORTED_SRS_POINTS) {
  entries.set(bn254G1CrsKey(points), createHash("sha256").update(g1.subarray(0, points * 64)).digest("hex"));
}
entries.set(BN254_G2_CRS_KEY, TOOLCHAIN.crs.bn254G2.sha256);
entries.set(GRUMPKIN_G1_CRS_KEY, TOOLCHAIN.crs.grumpkinG1.sha256);

const browserManifest = createBrowserProverManifest(
  resolveBrowserProverAssets({ bundle: bundleDir, toolRoot: tools.root, required: true }),
);
for (const artifact of browserManifest.artifacts) {
  if (entries.get(artifact.path) !== artifact.sha256) {
    throw new Error(`browser asset ${artifact.path} does not match its release pin`);
  }
}

let ts = GENERATED_HEADER;
ts += "\n";
ts += "/** Identity of the exact public browser proving asset set. */\n";
ts += `export const BROWSER_PROVER_ASSET_SET_ID = "${browserManifest.assetSetId}";\n`;
ts += "\n";
ts += "/**\n";
ts += " * SHA-256 pins for every URL the provers fetch: circuits, CHONK VKs and CRS\n";
ts += " * files. Every fetch is verified against its pin and fails closed on absence\n";
ts += " * or mismatch.\n";
ts += " */\n";
ts += "export const PROVER_ARTIFACT_SHA256: Readonly<Record<string, string>> = {\n";
for (const [url, digest] of [...entries].sort(([a], [b]) => a.localeCompare(b))) ts += `  "${url}": "${digest}",\n`;
ts += "};\n";

const applicationProfiles = Object.fromEntries(catalog.filter(c => c.owner === "lineage").map(c => [`/prover/${c.artifactId}.json`, { srsPoints: c.srsPoints, circuitSha256: applicationEntries.get(`/prover/${c.artifactId}.json`), vkUrl: `/chonk-vks/${c.artifactId}.vk`, vkSha256: applicationEntries.get(`/chonk-vks/${c.artifactId}.vk`) }]));

export const outputs = new Map([
  ["lineage/src/proverArtifacts.ts", GENERATED_HEADER + `export const LINEAGE_CIRCUIT_PROFILES = ${JSON.stringify(applicationProfiles, null, 2)} as const;\n`],
  [STACK_PINS_PATH, stackPinsSource(catalog, vkHashes)],
  ...applicationPinOutputs(catalog, vkHashes, ROOT),
  ["sdk/src/constants/proverArtifacts.ts", ts],
  ["assets/browser-prover-release.json", `${JSON.stringify(browserManifest, null, 2)}\n`],
]);
await runGenerator(import.meta, outputs);
