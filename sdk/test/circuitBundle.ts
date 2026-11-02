import { join } from "node:path";

export function circuitBundleDir(): string {
  const bundle = process.env.PCASH_CIRCUIT_BUNDLE?.trim();
  if (!bundle) throw new Error("PCASH_CIRCUIT_BUNDLE is required for compiled-circuit tests");
  return bundle;
}

export function proverAssetsDir(): string {
  return join(circuitBundleDir(), "prover-assets");
}
