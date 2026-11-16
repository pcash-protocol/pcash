// Range and arity guards shared by the protocol, witness-building, and typed-data
// layers. These guards keep all callers on the same bounds and error semantics.

import { type FieldNumberish, toNonnegativeBigInt } from "../crypto/field.ts";

/** Exclusive upper bounds of the unsigned wire widths. */
export const U32_LIMIT = 1n << 32n;
export const U40_LIMIT = 1n << 40n;
export const U64_LIMIT = 1n << 64n;
export const U128_LIMIT = 1n << 128n;
export const U160_LIMIT = 1n << 160n;

/**
 * Coerce to a nonnegative integer that must be strictly below `limit`.
 * `limit` is always a wire width (u8/u32/u128/u160) far below the BN254
 * modulus, so the bound itself is the field check.
 */
export function uintBelow(value: FieldNumberish, limit: bigint, label: string): bigint {
  const out = toNonnegativeBigInt(value, label);
  if (out >= limit) throw new Error(`${label} is out of range`);
  return out;
}

/** Require an exact array arity, for the fixed-width slots circuits expect. */
export function requireLength(values: readonly unknown[], expected: number, label: string): void {
  if (values.length !== expected) throw new Error(`${label} must contain ${expected} values`);
}
