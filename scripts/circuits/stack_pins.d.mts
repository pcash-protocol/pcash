import type { CircuitCatalogEntry } from "./catalog.d.mts";

export const STACK_PINS_PATH: string;
export function stackPinsSource(catalog: readonly CircuitCatalogEntry[], hashes: ReadonlyMap<string, string>): string;
export function deriveStackPins(
  catalog: readonly CircuitCatalogEntry[],
  file: string,
  vkHash: (circuit: CircuitCatalogEntry) => string,
): Map<string, string>;
