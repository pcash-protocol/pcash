// Poseidon2 BN254 t=4 R_F=8 R_P=56, x^5 s-box, length-tagged sponge.
// Implements the protocol's Poseidon2 permutation and length-tagged sponge.
import { BN254_SCALAR_MODULUS, type FieldNumberish, toField } from "./field.ts";
import {
  EXTERNAL_MATRIX,
  INTERNAL_DIAGONAL,
  ROUND_CONSTANTS,
} from "./poseidon2Constants.ts";

const WIDTH = 4;
const RATE = 3;
const FULL_ROUNDS = 8;
const HALF_FULL_ROUNDS = FULL_ROUNDS / 2;
const PARTIAL_ROUNDS = 56;

function mod(x: bigint): bigint {
  const r = x % BN254_SCALAR_MODULUS;
  return r < 0n ? r + BN254_SCALAR_MODULUS : r;
}

function pow5(x: bigint): bigint {
  const x2 = mod(x * x);
  return mod(mod(x2 * x2) * x);
}

/** extern(s) = M_E · s. */
function applyExternal(state: bigint[]): bigint[] {
  const out = new Array<bigint>(WIDTH).fill(0n);
  for (let i = 0; i < WIDTH; i++) {
    let acc = 0n;
    for (let j = 0; j < WIDTH; j++) acc = mod(acc + (EXTERNAL_MATRIX[i]![j] ?? 0n) * (state[j] ?? 0n));
    out[i] = acc;
  }
  return out;
}

/** intern(s): S = sum(s); out[i] = S + D_I[i] * s[i]. */
function applyInternal(state: bigint[]): bigint[] {
  let sum = 0n;
  for (let i = 0; i < WIDTH; i++) sum = mod(sum + (state[i] ?? 0n));
  return state.map((s, i) => mod(sum + (INTERNAL_DIAGONAL[i] ?? 0n) * s));
}

/** Apply the Poseidon2 permutation to `state`. */
function permute(input: readonly bigint[]): bigint[] {
  let state = applyExternal([...input]);
  for (let r = 0; r < HALF_FULL_ROUNDS; r++) {
    for (let i = 0; i < WIDTH; i++) state[i] = mod((state[i] ?? 0n) + (ROUND_CONSTANTS[r * WIDTH + i] ?? 0n));
    for (let i = 0; i < WIDTH; i++) state[i] = pow5(state[i] ?? 0n);
    state = applyExternal(state);
  }
  for (let r = 0; r < PARTIAL_ROUNDS; r++) {
    state[0] = mod((state[0] ?? 0n) + (ROUND_CONSTANTS[HALF_FULL_ROUNDS * WIDTH + r] ?? 0n));
    state[0] = pow5(state[0] ?? 0n);
    state = applyInternal(state);
  }
  for (let r = 0; r < HALF_FULL_ROUNDS; r++) {
    const base = HALF_FULL_ROUNDS * WIDTH + PARTIAL_ROUNDS + r * WIDTH;
    for (let i = 0; i < WIDTH; i++) state[i] = mod((state[i] ?? 0n) + (ROUND_CONSTANTS[base + i] ?? 0n));
    for (let i = 0; i < WIDTH; i++) state[i] = pow5(state[i] ?? 0n);
    state = applyExternal(state);
  }
  return state;
}

/**
 * Length-tagged sponge. state = [0,0,0, N<<64];
 * rate-3 absorb with `state[j] += chunk[j] mod p`; return state[0].
 */
export function poseidon(inputs: readonly FieldNumberish[]): bigint {
  const values = inputs.map((x) => toField(x, "poseidon input"));
  let state: bigint[] = [0n, 0n, 0n, BigInt(values.length) << 64n];
  if (values.length === 0) {
    return permute(state)[0]!;
  }
  for (let chunk = 0; chunk * RATE < values.length; chunk += 1) {
    for (let slot = 0; slot < RATE; slot += 1) {
      const input = values[chunk * RATE + slot];
      if (input !== undefined) state[slot] = mod((state[slot] ?? 0n) + input);
    }
    state = permute(state);
  }
  return state[0]!;
}

/**
 * A byte string as sponge inputs: the byte length, then the bytes as 16-byte
 * big-endian chunks, the last chunk short when the length is not a multiple
 * of 16.
 */
function byteStringInputs(bytes: Uint8Array): bigint[] {
  const inputs = [BigInt(bytes.length)];
  for (let offset = 0; offset < bytes.length; offset += 16) {
    let chunk = 0n;
    for (const byte of bytes.subarray(offset, offset + 16)) chunk = (chunk << 8n) | BigInt(byte);
    inputs.push(chunk);
  }
  return inputs;
}

/** Byte-string hash: the sponge over the domain and the byte string's inputs. */
export function poseidonBytes(domain: FieldNumberish, bytes: Uint8Array): bigint {
  return poseidon([toField(domain, "domain"), ...byteStringInputs(bytes)]);
}

/**
 * The domain tag of a context string: the sponge over the byte-string inputs
 * of `"pcash." ‖ context`, with no leading domain.
 */
export function domainTag(context: string): bigint {
  return poseidon(byteStringInputs(new TextEncoder().encode(`pcash.${context}`)));
}

/** Two-input hash: internal Merkle node and pairwise commitments. */
export function poseidon2(left: FieldNumberish, right: FieldNumberish): bigint {
  return poseidon([left, right]);
}
