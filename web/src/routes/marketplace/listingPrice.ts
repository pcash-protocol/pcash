import { parseEther } from "viem";
import type { OfferPublication } from "@pcash/marketplace/app";

export function compareValue(a: OfferPublication, b: OfferPublication): number {
  const difference = BigInt(a.terms.ethPriceWei) * BigInt(b.terms.amount)
    - BigInt(b.terms.ethPriceWei) * BigInt(a.terms.amount);
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}

export function compareTotal(a: OfferPublication, b: OfferPublication): number {
  const difference = BigInt(a.terms.ethPriceWei) - BigInt(b.terms.ethPriceWei);
  return difference < 0n ? -1 : difference > 0n ? 1 : compareValue(a, b);
}

/**
 * Wei per whole unit of the listed asset, for an asset with `decimals` decimals
 * (PCASH has 18). Rounded up to whole wei so a sub-wei price never reads as
 * free, and marked approximate when rounded. compareValue keeps the full price
 * ratio for sorting.
 */
export function unitPriceWei(offer: OfferPublication, decimals = 18): { wei: bigint; approximate: boolean } {
  const amount = BigInt(offer.terms.amount);
  const numerator = BigInt(offer.terms.ethPriceWei) * 10n ** BigInt(decimals);
  return { wei: (numerator + amount - 1n) / amount, approximate: numerator % amount !== 0n };
}

/** Seller-entered total, without rounding fractional wei. */
export function parseListingPrice(value: string): bigint {
  if (!/^\d+(?:\.\d{1,18})?$/.test(value.trim())) throw new Error("Enter an ETH price with up to 18 decimal places");
  const total = parseEther(value.trim());
  if (total <= 0n) throw new Error("Price must be greater than zero ETH");
  return total;
}
