// Per-action issuance for a candidate block, computed exactly like the node's
// issuance transition from the next-block issuance quote.

export interface IssuanceTerms {
  internalOffer: bigint;
  blockAllowance: bigint;
  /** Supply left under the cap; zero once issuance is exhausted. */
  remaining: bigint;
}

/** Terms from an issuance quote (IssuanceQuoteResult satisfies the input); a missing quote issues nothing. */
export function issuanceTerms(quote: {
  internalOffer: bigint;
  blockAllowance: bigint;
  supplyCap: bigint;
  issuedSoFar: bigint;
  exhausted: boolean;
} | null): IssuanceTerms {
  if (quote === null) return { internalOffer: 0n, blockAllowance: 0n, remaining: 0n };
  return {
    internalOffer: quote.internalOffer,
    blockAllowance: quote.blockAllowance,
    remaining: quote.exhausted ? 0n : quote.supplyCap - quote.issuedSoFar,
  };
}

/**
 * Issuance each successful type 0x00 action receives in a block with
 * `qualifyingActions` of them: min(offer, ⌊allowance/n⌋, ⌊remaining/n⌋), or zero
 * when n is zero. ⌊⌊allowanceQ/Q⌋/n⌋ = ⌊allowanceQ/(nQ)⌋, so the integer
 * allowance gives the node's result.
 */
export function rewardEach(terms: IssuanceTerms, qualifyingActions: bigint): bigint {
  if (qualifyingActions <= 0n) return 0n;
  const allowanceEach = terms.blockAllowance / qualifyingActions;
  const remainingEach = terms.remaining / qualifyingActions;
  let reward = terms.internalOffer;
  if (allowanceEach < reward) reward = allowanceEach;
  if (remainingEach < reward) reward = remainingEach;
  return reward;
}
