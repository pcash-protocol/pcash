import { describe, expect, it } from "vitest";
import type { OfferPublication } from "@pcash/marketplace/app";
import { unitPriceWei, compareValue, compareTotal, parseListingPrice } from "./listingPrice.ts";
const offer = (amount: bigint, price: bigint) => ({ terms: { assetId: "0", amount: amount.toString(), ethPriceWei: price.toString() } }) as OfferPublication;

describe("whole-offer pricing", () => {
  it("sorts by exact unit price rather than total or floating point", () => {
    const cheaper = offer(10n ** 30n, 10n ** 30n);
    const dearer = offer(10n ** 30n, 10n ** 30n + 1n);
    expect([dearer, cheaper].sort(compareValue)).toEqual([cheaper, dearer]);
    expect(compareValue(offer(2n, 4n), offer(1n, 2n))).toBe(0);
    expect(compareValue(offer(10n, 5n), offer(1n, 1n))).toBe(-1);
  });
  it("prices per whole PCASH in wei, rounding a sub-wei price up to one wei", () => {
    expect(unitPriceWei(offer(2n * 10n ** 18n, 10n ** 15n))).toEqual({ wei: 5n * 10n ** 14n, approximate: false });
    expect(unitPriceWei(offer(3n, 1n))).toEqual({ wei: 333_333_333_333_333_334n, approximate: true });
    expect(unitPriceWei(offer(10n ** 25n, 1n))).toEqual({ wei: 1n, approximate: true });
  });
  it("prices a token per whole token by its decimals", () => {
    expect(unitPriceWei(offer(250n, 10n ** 15n), 2)).toEqual({ wei: 4n * 10n ** 14n, approximate: false });
    expect(unitPriceWei(offer(4n, 10n ** 18n), 0)).toEqual({ wei: 25n * 10n ** 16n, approximate: false });
    expect(unitPriceWei(offer(2n * 10n ** 18n, 10n ** 15n), 18)).toEqual(unitPriceWei(offer(2n * 10n ** 18n, 10n ** 15n)));
  });
  it("uses the seller's exact total ETH price", () => {
    expect(parseListingPrice("0.1")).toBe(10n ** 17n);
    expect(parseListingPrice("0.000000000000000001")).toBe(1n);
    for (const input of ["-1", "0", "NaN", "1e-3", "0.0000000000000000001"]) expect(() => parseListingPrice(input)).toThrow();
  });
  it("sorts total prices without losing precision and retains equal-value listings", () => {
    const first = offer(2n, 2n), second = offer(5n, 5n), expensive = offer(10n, 9n);
    expect([expensive, second, first].sort(compareTotal)).toEqual([first, second, expensive]);
    expect([first, second, expensive].sort(compareValue)).toEqual([expensive, first, second]);
    expect(compareTotal(offer(1n, 10n ** 30n), offer(1n, 10n ** 30n + 1n))).toBe(-1);
  });
});
