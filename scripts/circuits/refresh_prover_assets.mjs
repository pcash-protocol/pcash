// Copy freshly built circuit artifacts into a circuit bundle's prover-assets/ tree.
//
// A published artifact keeps only the compiled program: the compiler version,
// ABI and bytecode, the same fields source verification commits to. nargo's
// `file_map` carries every source file's path and text, and `debug_symbols`
// and `hash` change with any edit to that text, a comment included; no prover
// reads them. Without them an artifact, and every release pin over it,
// depends on the program alone, so moving or re-commenting a Noir source
// changes no pin.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { circuitCatalog } from "./catalog.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PROGRAM_FIELDS = ["noir_version", "abi", "bytecode"];

function programArtifact(text) {
  const artifact = JSON.parse(text);
  return JSON.stringify(Object.fromEntries(PROGRAM_FIELDS.map((field) => [field, artifact[field]])));
}

/** Install every catalog circuit's artifact, built under `sourceRoot`, into `outputRoot`. */
export function refreshProverAssets({ sourceRoot, outputRoot }) {
  for (const circuit of circuitCatalog(REPO)) {
    const published = programArtifact(readFileSync(path.join(sourceRoot, circuit.sourceArtifactPath), "utf8"));
    const outputPath = path.join(outputRoot, circuit.proverArtifactPath);
    mkdirSync(path.dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, published);
  }
}
