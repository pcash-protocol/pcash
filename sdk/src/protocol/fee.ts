// The protocol fee: a burned base fee per state unit, computed exactly like the
// node's from a block's parent `feeExcess`, and the shared quote policy that
// prices a transaction against the fee projected over the quote window.

import { PRIVATE_VALUE_PROFILES, privateValueProfile } from "../constants/privateValueProfiles.ts";
import {
  privateValueTransactionSize,
  TX_KIND_PRIVATE_VALUE,
  TX_KIND_USER_ACCOUNT_UPDATE,
  transactionPublication,
  type RawTransaction,
} from "./codec.ts";

/** State units per block before any fee applies. */
export const TARGET_UNITS_PER_BLOCK = 1_200n;
/** Excess units that raise the base fee by a factor of e. */
export const FEE_UPDATE_FRACTION = 63_000n;
/** State units a newly allocated account counts, beside one per nullifier. */
export const ACCOUNT_WEIGHT = 2n;
/** The excess cap that keeps the fee for any transaction's units below 2^128. */
export const MAX_FEE_EXCESS = 85n * FEE_UPDATE_FRACTION;
/** The largest base fee, per state unit, at which a transaction with a private-value section owes no protocol fee. */
export const MAX_WAIVED_BASE_FEE = 10n ** 9n;
/** Excess the quote projects ahead: a minute at twice the target, five blocks of 1,200 units above it. */
export const QUOTE_WINDOW_UNITS = 6_000n;

/** EIP-4844's integer approximation of `factor × e^(numerator / denominator)`. */
export function fakeExponential(factor: bigint, numerator: bigint, denominator: bigint): bigint {
  let i = 1n;
  let output = 0n;
  let accumulator = factor * denominator;
  while (accumulator > 0n) {
    output += accumulator;
    accumulator = (accumulator * numerator) / (denominator * i);
    i += 1n;
  }
  return output / denominator;
}

/** The base fee per state unit of a block whose parent has this `feeExcess`. */
export function baseFee(feeExcess: bigint): bigint {
  return fakeExponential(1n, feeExcess, FEE_UPDATE_FRACTION) - 1n;
}

/** A block's `feeExcess` after it used `usedUnits`. */
export function nextFeeExcess(feeExcess: bigint, usedUnits: bigint): bigint {
  const next = feeExcess + usedUnits - TARGET_UNITS_PER_BLOCK;
  if (next < 0n) return 0n;
  return next > MAX_FEE_EXCESS ? MAX_FEE_EXCESS : next;
}

/** State units of a private-value transaction: its nullifiers, plus one account if its attachment allocates one. */
export function privateValueUnits(inputs: number, allocatesAccount: boolean): bigint {
  return BigInt(inputs) + (allocatesAccount ? ACCOUNT_WEIGHT : 0n);
}

/** State units of a user-account update: its profile S fee section's nullifiers. */
export const ACCOUNT_UPDATE_UNITS = BigInt(PRIVATE_VALUE_PROFILES.S.inputs);

/**
 * State units a decoded transaction pays for. A private-value transaction's
 * attached creation counts only when it inserts an account, which depends on
 * state; `allocatesAccount` says whether to count it. Standalone creations
 * always allocate.
 */
export function transactionUnits(transaction: RawTransaction, allocatesAccount: boolean): bigint {
  switch (transaction.kind) {
    case TX_KIND_PRIVATE_VALUE:
      return privateValueUnits(privateValueProfile(transaction.shape).inputs,
        allocatesAccount && transaction.accountCreation !== undefined);
    case TX_KIND_USER_ACCOUNT_UPDATE:
      return ACCOUNT_UPDATE_UNITS;
    default:
      return ACCOUNT_WEIGHT;
  }
}

/** The native burn a transaction declares; zero for a standalone creation. */
export function transactionNativeBurn(transaction: RawTransaction): bigint {
  return transactionPublication(transaction)?.nativeBurnAmount ?? 0n;
}

/**
 * What a transaction with a private-value section of `units` state units must
 * burn in a block charging `baseFee`: nothing while the fee is waived, the
 * whole fee above `MAX_WAIVED_BASE_FEE`.
 */
export function requiredProtocolFee(baseFee: bigint, units: bigint): bigint {
  return baseFee <= MAX_WAIVED_BASE_FEE ? 0n : baseFee * units;
}

/**
 * What a decoded transaction must burn at `baseFee`. A standalone creation
 * cannot pay and is not waived: it needs a zero base fee, so it owes the
 * whole fee whenever the base fee is positive.
 */
export function transactionRequiredFee(transaction: RawTransaction, baseFee: bigint, allocatesAccount: boolean): bigint {
  const units = transactionUnits(transaction, allocatesAccount);
  return transaction.kind === TX_KIND_PRIVATE_VALUE || transaction.kind === TX_KIND_USER_ACCOUNT_UPDATE
    ? requiredProtocolFee(baseFee, units) : baseFee * units;
}

/** Round a positive amount up to two significant decimal digits; zero stays zero. */
export function feeBucket(amount: bigint): bigint {
  if (amount <= 0n) return 0n;
  let scale = 1n;
  while (amount > 99n * scale) scale *= 10n;
  return ((amount + scale - 1n) / scale) * scale;
}

/** The base fee at the excess projected `QUOTE_WINDOW_UNITS` ahead of the node's current `feeExcess`. */
export function projectedBaseFee(feeExcess: bigint): bigint {
  const projected = feeExcess + QUOTE_WINDOW_UNITS;
  return baseFee(projected > MAX_FEE_EXCESS ? MAX_FEE_EXCESS : projected);
}

/**
 * The network fee to authorize for `units` state units of a transaction with
 * a private-value section: the fee required at the projected base fee, in a
 * shared bucket. It is zero while that base fee is waived.
 */
export function quoteNetworkFee(feeExcess: bigint, units: bigint): bigint {
  return feeBucket(requiredProtocolFee(projectedBaseFee(feeExcess), units));
}

/**
 * What a transaction burns, as its signer reads it: the network fee and any
 * voluntary burn. `nativeBurnAmount` is their sum. A zero total signs the base
 * message types; a positive one signs their `WithBurn` variants.
 */
export interface NativeBurn {
  networkFeeAmount: bigint;
  voluntaryBurnAmount: bigint;
}

export const NO_BURN: NativeBurn = Object.freeze({ networkFeeAmount: 0n, voluntaryBurnAmount: 0n });

export function nativeBurnAmount(burn: NativeBurn): bigint {
  return burn.networkFeeAmount + burn.voluntaryBurnAmount;
}

/** The burn to authorize for `units` at the node's current `feeExcess`, plus any voluntary burn. */
export function quoteNativeBurn(feeExcess: bigint, units: bigint, voluntaryBurnAmount = 0n): NativeBurn {
  if (voluntaryBurnAmount < 0n) throw new Error("voluntaryBurnAmount must be nonnegative");
  return { networkFeeAmount: quoteNetworkFee(feeExcess, units), voluntaryBurnAmount };
}

/** Ethereum's maximum blobs per block since the BPO2 fork. A fork that raises it must raise this. */
export const ETHEREUM_MAX_BLOBS_PER_BLOCK = 21n;
/** A blob's 4,096 field elements carry 31 PCASH payload bytes each. */
const PCASH_BYTES_PER_BLOB = 4_096n * 31n;
/** Consecutive Ethereum blocks are at least one slot apart. */
export const ETHEREUM_SLOT_SECONDS = 12n;
/** Log data in a carrier event costs 8 gas a byte, below EIP-7623's calldata floor of 10, so it bounds PCASH bytes per gas. */
const MIN_GAS_PER_PCASH_BYTE = 8n;
/** The smallest contract body the codec decodes: the nullifier-key flag and word, no receive key, and no functions. */
const MIN_CONTRACT_BODY_BYTES = 1 + 32 + 1 + 1;

/** The densest form that counts state units while the base fee is positive: profile L, attaching the smallest contract creation. */
export const MAX_UNIT_DENSITY = {
  units: privateValueUnits(PRIVATE_VALUE_PROFILES.L.inputs, true),
  bytes: BigInt(privateValueTransactionSize(PRIVATE_VALUE_PROFILES.L.shapeId, { kind: "contract", body: new Uint8Array(MIN_CONTRACT_BODY_BYTES) })),
};

/** The most state units an Ethereum block of `gasLimit` can carry: its data at the least gas a byte, and its blobs. */
export function maxUnitsPerBlock(gasLimit: bigint): bigint {
  const bytes = gasLimit / MIN_GAS_PER_PCASH_BYTE + ETHEREUM_MAX_BLOBS_PER_BLOCK * PCASH_BYTES_PER_BLOB;
  return bytes * MAX_UNIT_DENSITY.units / MAX_UNIT_DENSITY.bytes;
}

/**
 * The network fee for `units` that covers inclusion in any of the next
 * `blocks` blocks after a tip at `feeExcess`, each carrying the most units
 * an Ethereum block of `gasLimit` can, in the shared bucket.
 */
export function boundedNetworkFee(feeExcess: bigint, units: bigint, blocks: bigint, gasLimit: bigint): bigint {
  const growth = maxUnitsPerBlock(gasLimit) - TARGET_UNITS_PER_BLOCK;
  const excess = feeExcess + blocks * (growth > 0n ? growth : 0n);
  return feeBucket(requiredProtocolFee(baseFee(excess > MAX_FEE_EXCESS ? MAX_FEE_EXCESS : excess), units));
}
