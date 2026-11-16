// BN254 scalar field helpers. Ported from
// erc/sdk/src/field.ts, trimmed to what the PCASH primitives need.

export const BN254_SCALAR_MODULUS =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const ADDRESS_LIMIT = 1n << 160n;

export type FieldNumberish = bigint | number | string;

export function toNonnegativeBigInt(value: FieldNumberish, name = "value"): bigint {
  let out: bigint;
  if (typeof value === "bigint") out = value;
  else if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error(`${name} must be a safe integer`);
    out = BigInt(value);
  } else out = BigInt(value);
  if (out < 0n) throw new Error(`${name} must be nonnegative`);
  return out;
}

/** Coerce to a reduced BN254 field element; reject inputs >= p. */
export function toField(value: FieldNumberish, name = "field"): bigint {
  const field = toNonnegativeBigInt(value, name);
  if (field >= BN254_SCALAR_MODULUS) throw new Error(`${name} must be a BN254 scalar field element`);
  return field;
}

/** Coerce a semantic account or Ethereum address to its canonical uint160 field encoding. */
export function toAddressField(value: FieldNumberish, name = "address"): bigint {
  const address = toField(value, name);
  if (address >= ADDRESS_LIMIT) throw new Error(`${name} must fit in 160 bits`);
  return address;
}

export function fieldToHex(value: FieldNumberish): `0x${string}` {
  return `0x${toField(value).toString(16).padStart(64, "0")}`;
}
