// The release-pinned CRS for Wasm proving in Node.
//
// This reads the browser prover's pins, which are derived from the circuit
// bundle. No module that circuit-bundle generation imports may import them, so
// this stays apart from nativeProver.ts.

import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, readSync } from "node:fs";

import { PROVER_ARTIFACT_SHA256 } from "../constants/proverArtifacts.ts";
import type { ChonkCrs } from "../prover/chonk.ts";
import { BN254_G2_CRS_KEY, bn254G1CrsKey, GRUMPKIN_G1_CRS_KEY } from "../prover/crs.ts";
import type { SupportedSrsPoints } from "../prover/profile.ts";
import { toolPaths } from "./toolchain.ts";

/** Read `bytes` from the start of one tool-root CRS file, or all of it, and check its release pin. */
function pinnedCrsFile(path: string, pinKey: string, bytes?: number): Uint8Array {
  if (!existsSync(path)) {
    throw new Error(`pinned CRS file is missing at ${path}; run \`just tools\``);
  }
  let value: Uint8Array;
  if (bytes === undefined) {
    value = new Uint8Array(readFileSync(path));
  } else {
    value = new Uint8Array(bytes);
    const fd = openSync(path, "r");
    try {
      for (let offset = 0; offset < bytes;) {
        const read = readSync(fd, value, offset, bytes - offset, offset);
        if (read === 0) throw new Error(`pinned CRS file at ${path} is shorter than ${bytes} bytes; run \`just tools\``);
        offset += read;
      }
    } finally {
      closeSync(fd);
    }
  }
  if (createHash("sha256").update(value).digest("hex") !== PROVER_ARTIFACT_SHA256[pinKey]) {
    throw new Error(`CRS file at ${path} does not match its release pin ${pinKey}; run \`just tools\``);
  }
  return value;
}

/**
 * The release-pinned CRS for Wasm proving: the BN254 G1 prefix for
 * `srsPoints`, BN254 G2, and the Grumpkin points, read from the tool-root CRS
 * directory native proving uses and checked against the browser prover's pins.
 */
export function pinnedChonkCrs(srsPoints: SupportedSrsPoints): ChonkCrs {
  const paths = toolPaths();
  return {
    bn254G1: pinnedCrsFile(paths.bn254G1, bn254G1CrsKey(srsPoints), srsPoints * 64),
    bn254G2: pinnedCrsFile(paths.bn254G2, BN254_G2_CRS_KEY),
    grumpkinG1: pinnedCrsFile(paths.grumpkinG1, GRUMPKIN_G1_CRS_KEY),
  };
}
