import { describe, expect, it } from "vitest";
import { defaultOpenFee, paymentIssuanceFromInputs } from "../../src/wallet/actions/paymentIssuance.ts";
import type { BlockEconomicsPageResult, IssuanceQuoteResult } from "@pcash/sdk/clients";

const PCASH = 10n ** 18n;
describe("payment issuance estimate", () => {
  it("shares block allowance with expected activity including this payment", () => {
    const quote = { internalOffer: PCASH, blockAllowance: 2n * PCASH, supplyCap: 100n * PCASH, issuedSoFar: 0n, exhausted: false } as unknown as IssuanceQuoteResult;
    const economics = { atBlockNumber: 1n, records: [{ blocks: 1n, qualifyingActions: 4n }] } as unknown as BlockEconomicsPageResult;
    expect(paymentIssuanceFromInputs(quote, economics)).toBe(4n * PCASH / 10n);
  });
});

describe("default open fee", () => {
  it("is 1 PCASH without an issuance estimate or below 30 PCASH of issuance", () => {
    expect(defaultOpenFee(undefined)).toBe(PCASH);
    expect(defaultOpenFee(0n)).toBe(PCASH);
    expect(defaultOpenFee(29n * PCASH)).toBe(PCASH);
  });

  it("is 5% of issuance rounded to whole PCASH", () => {
    expect(defaultOpenFee(30n * PCASH - 1n)).toBe(PCASH);
    expect(defaultOpenFee(30n * PCASH)).toBe(2n * PCASH);
    expect(defaultOpenFee(41n * PCASH)).toBe(2n * PCASH);
    expect(defaultOpenFee(50n * PCASH - 1n)).toBe(2n * PCASH);
    expect(defaultOpenFee(50n * PCASH)).toBe(3n * PCASH);
    expect(defaultOpenFee(1_000n * PCASH)).toBe(50n * PCASH);
  });
});
