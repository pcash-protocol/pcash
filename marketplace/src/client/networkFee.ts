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
 * The escrow payout for a network fee. A native escrow pays the fee from its
 * own value; a token escrow always pays out in full and its claimant or seller
 * pays any fee from their own PCASH.
 */
export function escrowPayoutAmount(assetId: bigint, escrowAmount: bigint, networkFeeAmount: bigint): bigint {
  if (assetId === 0n) return marketplaceNetAmount(escrowAmount, networkFeeAmount);
  if (networkFeeAmount < 0n) throw new Error("marketplace network fee must be nonnegative");
  return escrowAmount;
}
