export const SUPPORTED_SRS_POINTS = [2 ** 18, 2 ** 19, 2 ** 20, 2 ** 21, 2 ** 22] as const;

export type SupportedSrsPoints = (typeof SUPPORTED_SRS_POINTS)[number];

export interface ProverProfile {
  srsPoints: SupportedSrsPoints;
  threads: number;
  /** Keep the Barretenberg instance alive after one completed proof chain. */
  reuse: boolean;
  /** Optional Wasm maximum in 64 KiB pages. */
  memoryMaximumPages?: number;
  /**
   * Report Barretenberg's Wasm memory on measurement updates. Off by default:
   * each reading is a round trip to the prover thread.
   */
  reportWasmMemory?: boolean;
  /**
   * Also prove circuits the manifest declares native-only, such as the L
   * profile's. For measurement: wallets leave it unset, so those circuits fail
   * before any artifact is fetched.
   */
  allowNativeOnlyCircuits?: boolean;
}

const WASM_PAGE_BYTES = 64 * 1024;

export function memoryMaximumPages(memoryMiB: number | "auto"): number | undefined {
  if (memoryMiB === "auto") return undefined;
  if (![256, 512, 768, 1024].includes(memoryMiB)) {
    throw new Error("browser Wasm memory must be 256, 512, 768, or 1024 MiB");
  }
  return (memoryMiB * 1024 * 1024) / WASM_PAGE_BYTES;
}

export function srsPointsForCircuitSize(circuitSize: number): SupportedSrsPoints {
  if (!Number.isInteger(circuitSize) || circuitSize < 1) {
    throw new Error("circuit size must be a positive integer");
  }
  const points = 2 ** Math.ceil(Math.log2(circuitSize));
  const supported = SUPPORTED_SRS_POINTS.find((candidate) => candidate >= points);
  if (supported === undefined) {
    throw new Error(`circuit size ${circuitSize} exceeds the supported 2^22 browser profile`);
  }
  return supported;
}

export function srsPointsForCircuits(
  circuitIds: readonly string[],
  circuitSizes: Readonly<Record<string, number>>,
): SupportedSrsPoints {
  if (circuitIds.length === 0) throw new Error("a proving scenario must name at least one circuit");
  let maximum = 0;
  for (const circuitId of circuitIds) {
    const size = circuitSizes[circuitId];
    if (size === undefined) throw new Error(`missing gate count for ${circuitId}`);
    maximum = Math.max(maximum, size);
  }
  return srsPointsForCircuitSize(maximum);
}

export function normalizeProverThreads(requested: number | "auto", hardwareConcurrency: number): number {
  const available = Number.isInteger(hardwareConcurrency) && hardwareConcurrency > 0
    ? hardwareConcurrency
    : 1;
  const threads = requested === "auto" ? Math.min(8, available) : requested;
  if (!Number.isInteger(threads) || threads < 1 || threads > 8) {
    throw new Error("browser prover threads must be an integer from 1 through 8");
  }
  return Math.min(threads, available);
}
