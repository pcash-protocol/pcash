import type { CircuitCatalogEntry } from "./catalog.d.mts";

type PinnedCircuit = Pick<CircuitCatalogEntry, "owner" | "role" | "packageName">;

export const RULE_PINS_PATH: string;
export function applicationPinName(circuit: PinnedCircuit): string;
export function rulePinsSource(catalog: readonly PinnedCircuit[], hashes: ReadonlyMap<string, string>): string;
export function applicationPinPaths(catalog: readonly CircuitCatalogEntry[]): string[];
export function applicationPinOutputs(
  catalog: readonly CircuitCatalogEntry[],
  hashes: ReadonlyMap<string, string>,
  root: string,
): Map<string, string>;
