import { describe, expect, it } from "vitest";
import { prefilledOpenFee } from "./openFee.ts";

const PCASH = 10n ** 18n;

describe("prefilledOpenFee", () => {
  it("keeps the default when the payer covers it or the limit is unknown", () => {
    expect(prefilledOpenFee(2n * PCASH, 2n * PCASH)).toBe(2n * PCASH);
    expect(prefilledOpenFee(2n * PCASH, undefined)).toBe(2n * PCASH);
  });

  it("pre-fills 0 when the default is above the limit and a zero fee is allowed", () => {
    expect(prefilledOpenFee(PCASH, 0n)).toBe(0n);
    expect(prefilledOpenFee(PCASH, PCASH - 1n)).toBe(0n);
  });

  it("keeps the default where a zero fee is not allowed", () => {
    expect(prefilledOpenFee(PCASH, 0n, false)).toBe(PCASH);
  });
});
