// Node CHONK proving against the pinned prover toolchain.

import { existsSync } from "node:fs";

import type { ChonkBackend } from "../prover/chonk.ts";
import { assertToolchain, TOOLCHAIN, toolPaths } from "./toolchain.ts";

export const PINNED_NARGO_VERSION = TOOLCHAIN.nargo.version;
export const PINNED_NOIRC_COMMIT = TOOLCHAIN.nargo.noircCommit;
/** Re-pin checklist: `node/crates/node/src/pins.rs`. */
export const PINNED_BARRETENBERG_VERSION = TOOLCHAIN.barretenberg.version;

/**
 * Whether the pinned toolchain is installed. False only when nothing was ever
 * installed in the tool root; an installation that is not the pinned release
 * throws, so a re-pin cannot turn proving tests into skipped tests.
 */
export function isProverAvailable(): boolean {
  if (!existsSync(toolPaths().receipt)) return false;
  assertToolchain();
  return true;
}

/** The pinned tool-root binaries and no other location: bb receives spending secrets when it proves. */
export function proverReleaseConfig(): { nargo: string; bb: string; crs: string } {
  const { nargo, bb, crs } = assertToolchain();
  return { nargo, bb, crs };
}

/**
 * Native Unix-socket CHONK backend pinned to this checkout's bb and CRS.
 * Without `threads`, bb.js gives bb one thread per core, up to 16.
 */
export function nativeChonkBackend(threads?: number): ChonkBackend {
  const release = proverReleaseConfig();
  return { kind: "native", bbPath: release.bb, crsPath: release.crs, ...(threads === undefined ? {} : { threads }) };
}
