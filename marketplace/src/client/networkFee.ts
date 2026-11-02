/** The escrow must fund the chosen open or private network fee and a positive payout. */
export function assertMarketplaceNetworkFee(transferAmount: bigint, networkFeeAmount: bigint): void {
  if (networkFeeAmount < 0n) throw new Error("marketplace network fee must be nonnegative");
  if (networkFeeAmount >= transferAmount) {
    throw new Error(`marketplace network fee ${networkFeeAmount} must be less than transfer amount ${transferAmount}`);
  }
}

export function marketplaceNetAmount(transferAmount: bigint, networkFeeAmount: bigint): bigint {
  assertMarketplaceNetworkFee(transferAmount, networkFeeAmount);
  return transferAmount - networkFeeAmount;
}

/**
 * The escrow payout for a network fee and native burn. A native escrow pays
 * both from its own value; a token escrow always pays out in full and its
 * claimant or seller pays any fee and burn from their own PCASH.
 */
export function escrowPayoutAmount(assetId: bigint, escrowAmount: bigint, networkFeeAmount: bigint, burnAmount = 0n): bigint {
  if (networkFeeAmount < 0n) throw new Error("marketplace network fee must be nonnegative");
  if (burnAmount < 0n) throw new Error("marketplace native burn must be nonnegative");
  if (assetId !== 0n) return escrowAmount;
  if (networkFeeAmount + burnAmount >= escrowAmount) {
    throw new Error(`marketplace network fee ${networkFeeAmount} and native burn ${burnAmount} must be less than escrow amount ${escrowAmount}`);
  }
  return escrowAmount - networkFeeAmount - burnAmount;
}
