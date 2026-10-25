import { describe, expect, it } from "vitest";
import {
  formatPcashAmount,
  formatPcashInput,
  parsePcashAmount,
} from "../components/pcashAmount.ts";

const PCASH_BASE_UNITS = 10n ** 18n;

describe("PCASH amount formatting", () => {
  it("formats base units as whole PCASH with grouping", () => {
    expect(formatPcashAmount(PCASH_BASE_UNITS)).toBe("1 PCASH");
    expect(formatPcashAmount(1_025_817_898_339_018_425n)).toBe("1 PCASH");
    expect(formatPcashAmount(1_234_567n * PCASH_BASE_UNITS)).toBe("1,234,567 PCASH");
    expect(formatPcashAmount(2_100_000_000n * PCASH_BASE_UNITS)).toBe("2,100,000,000 PCASH");
    expect(formatPcashAmount(0n)).toBe("0 PCASH");
  });

  it("rounds earned amounts to nearest, balances down and costs up, without converting bigint values to Number", () => {
    expect(formatPcashAmount(1_499_999_999_999_999_999n)).toBe("1 PCASH");
    expect(formatPcashAmount(1_500_000_000_000_000_000n)).toBe("2 PCASH");
    expect(formatPcashAmount(-1_500_000_000_000_000_000n)).toBe("-2 PCASH");
    expect(formatPcashAmount(1_999_999_999_999_999_999n, { rounding: "down" })).toBe("1 PCASH");
    expect(formatPcashAmount(PCASH_BASE_UNITS + 1n, { rounding: "up" })).toBe("2 PCASH");
    expect(formatPcashInput(1_025_817_898_339_018_425n)).toBe("1.025817898339018425");
    expect(formatPcashInput(12n * PCASH_BASE_UNITS)).toBe("12");
  });

  it("shows a nonzero amount below one PCASH as <1 PCASH", () => {
    expect(formatPcashAmount(1n)).toBe("<1 PCASH");
    expect(formatPcashAmount(999_500_000_000_000_000n)).toBe("<1 PCASH");
    expect(formatPcashAmount(123_456_789_012n, { rounding: "up" })).toBe("<1 PCASH");
    expect(formatPcashAmount(-1n)).toBe("-<1 PCASH");
  });

  it("parses whole PCASH input into exact base units and rejects decimals", () => {
    expect(parsePcashAmount("12")).toBe(12n * PCASH_BASE_UNITS);
    expect(parsePcashAmount("1,000")).toBe(1_000n * PCASH_BASE_UNITS);
    expect(parsePcashAmount("1.")).toBe(PCASH_BASE_UNITS);
    expect(parsePcashAmount("0", { allowZero: true })).toBe(0n);
    expect(() => parsePcashAmount("0")).toThrow(/greater than zero/);
    expect(() => parsePcashAmount("1.5", { label: "Amount" })).toThrow("Amount must be a whole number");
    expect(() => parsePcashAmount(".5")).toThrow("PCASH amount must be a whole number");
    expect(() => parsePcashAmount("1,2,3")).toThrow(/must be a whole number/);
  });
});
