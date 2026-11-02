/**
 * The open fee a form pre-fills, so the prefill never makes the action invalid.
 * `limit` is the most the fee can be: the payer's spendable PCASH, shared among
 * the proofs that each pay it, or one base unit below the escrow a fee is paid
 * out of; undefined while unknown. A default above the limit pre-fills 0 where
 * a zero fee is allowed.
 */
export function prefilledOpenFee(defaultFee: bigint, limit: bigint | undefined, zeroFeeAllowed = true): bigint {
  return zeroFeeAllowed && limit !== undefined && defaultFee > limit ? 0n : defaultFee;
}
