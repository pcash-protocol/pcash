import { describe, expect, it } from "vitest";
import { floorToDisplay, formatTokenAmount, formatTokenExact, formatTokenInput, parseTokenAmount, parseUnitAmount } from "./tokenAmount.ts";

const CENTS = { decimals: 2, symbol: "HBR" };
const WHOLE = { decimals: 0, symbol: "SEAT" };
const MICRO = { decimals: 6, symbol: "USDX" };
const ETH = { decimals: 18, symbol: "ETH" };
const WHOLE_18 = { decimals: 18, symbol: "WHL", whole: true };
const UNIT = 10n ** 18n;

describe("token amount formatting", () => {
  it("formats base units by the token's decimals and symbol", () => {
    expect(formatTokenAmount(123_456n, CENTS)).toBe("1,234.56 HBR");
    expect(formatTokenAmount(100n, CENTS)).toBe("1 HBR");
    expect(formatTokenAmount(1n, CENTS)).toBe("0.01 HBR");
    expect(formatTokenAmount(1_000_000n, WHOLE)).toBe("1,000,000 SEAT");
    expect(formatTokenAmount(1_234_567_891n, MICRO)).toBe("1,234.568 USDX");
    expect(formatTokenAmount(0n, MICRO)).toBe("0 USDX");
  });

  it("shows at most three decimals, and two significant digits for smaller nonzero values", () => {
    expect(formatTokenAmount(1_234_499n, MICRO)).toBe("1.234 USDX");
    expect(formatTokenAmount(499n, MICRO)).toBe("0.0005 USDX");
    expect(formatTokenAmount(-499n, MICRO)).toBe("-0.0005 USDX");
    expect(formatTokenAmount(42n * 10n ** 12n, ETH)).toBe("0.000042 ETH");
    expect(formatTokenAmount(42_499_999n, ETH)).toBe("0.000000000042 ETH");
    expect(formatTokenAmount(1n, ETH)).toBe("0.000000000000000001 ETH");
  });

  it.each([1n, 9n, 10n, 99n, 499n, 999n, 10n ** 15n - 1n])("never shows nonzero %s base units as zero or as a floor", (value) => {
    for (const rounding of ["nearest", "down", "up"] as const) {
      const shown = formatTokenAmount(value, ETH, { rounding });
      expect(shown).not.toMatch(/^0 |</);
      expect(formatTokenAmount(-value, ETH, { rounding })).toBe(`-${shown}`);
    }
  });

  it.each([[1_000n, "0.001"], [1_499n, "0.001"], [1_500n, "0.002"], [999n, "0.001"], [994n, "0.00099"]] as const)("rounds %s micro units to nearest at the display step", (value, expected) => {
    expect(formatTokenAmount(value, MICRO)).toBe(`${expected} USDX`);
    expect(formatTokenAmount(-value, MICRO)).toBe(`-${expected} USDX`);
  });

  it("rounds down for balances and up for costs", () => {
    expect(formatTokenAmount(1_999_999n, MICRO, { rounding: "down" })).toBe("1.999 USDX");
    expect(formatTokenAmount(1_000_001n, MICRO, { rounding: "up" })).toBe("1.001 USDX");
    expect(formatTokenAmount(999n, MICRO, { rounding: "down" })).toBe("0.00099 USDX");
    expect(formatTokenAmount(991n, MICRO, { rounding: "up" })).toBe("0.001 USDX");
    expect(formatTokenAmount(4_299n * 10n ** 9n, ETH, { rounding: "down" })).toBe("0.0000042 ETH");
    expect(formatTokenAmount(4_201n * 10n ** 9n, ETH, { rounding: "up" })).toBe("0.0000043 ETH");
    expect(formatTokenAmount(1_000_000n, MICRO, { rounding: "up" })).toBe("1 USDX");
  });

  it("floors an input value to the displayed precision", () => {
    expect(floorToDisplay(1_234_999n, MICRO)).toBe(1_234_000n);
    expect(floorToDisplay(123n, CENTS)).toBe(123n);
    expect(floorToDisplay(1_025_817_898_339_018_425n, ETH)).toBe(1_025_000_000_000_000_000n);
    expect(floorToDisplay(987n, MICRO)).toBe(980n);
    expect(floorToDisplay(0n, ETH)).toBe(0n);
    expect(floorToDisplay(1_025_817_898_339_018_425n, WHOLE_18)).toBe(UNIT);
    expect(floorToDisplay(UNIT - 1n, WHOLE_18)).toBe(0n);
  });

  it("gives exact and input forms", () => {
    expect(formatTokenExact(123_450n, CENTS)).toBe("1,234.5 HBR");
    expect(formatTokenExact(1_025_817_898_339_018_425n, ETH)).toBe("1.025817898339018425 ETH");
    expect(formatTokenExact(1_025_817_898_339_018_425n, WHOLE_18)).toBe("1.025817898339018425 WHL");
    expect(formatTokenInput(123_450n, 2)).toBe("1234.5");
    expect(formatTokenInput(7n, 0)).toBe("7");
  });

  it("parses decimal input into base units for any decimals", () => {
    expect(parseTokenAmount("1,234.56", 2)).toBe(123_456n);
    expect(parseTokenAmount(".5", 2)).toBe(50n);
    expect(parseTokenAmount("12", 0)).toBe(12n);
    expect(parseTokenAmount("12.", 0)).toBe(12n);
    expect(parseTokenAmount("0", 6, { allowZero: true })).toBe(0n);
    expect(() => parseTokenAmount("1.234", 2)).toThrow("Amount can have at most 2 decimal places");
    expect(() => parseTokenAmount("1.5", 0, { label: "Seats" })).toThrow("Seats must be a whole number");
    expect(() => parseTokenAmount("abc", 0)).toThrow("Amount must be a whole number");
    expect(() => parseTokenAmount("0", 2)).toThrow(/greater than zero/);
  });
});

describe("whole-unit amounts", () => {
  it("round to whole units: balances down, costs up, everything else to nearest", () => {
    expect(formatTokenAmount(1_499_999_999_999_999_999n, WHOLE_18)).toBe("1 WHL");
    expect(formatTokenAmount(1_500_000_000_000_000_000n, WHOLE_18)).toBe("2 WHL");
    expect(formatTokenAmount(1_999_999_999_999_999_999n, WHOLE_18, { rounding: "down" })).toBe("1 WHL");
    expect(formatTokenAmount(UNIT + 1n, WHOLE_18, { rounding: "up" })).toBe("2 WHL");
    expect(formatTokenAmount(1_234_567n * UNIT + UNIT / 3n, WHOLE_18)).toBe("1,234,567 WHL");
    expect(formatTokenAmount(0n, WHOLE_18)).toBe("0 WHL");
  });

  it.each([1n, UNIT / 2n, UNIT - 1n])("show nonzero %s base units below one unit as <1", (value) => {
    for (const rounding of ["nearest", "down", "up"] as const) {
      expect(formatTokenAmount(value, WHOLE_18, { rounding })).toBe("<1 WHL");
      expect(formatTokenAmount(-value, WHOLE_18, { rounding })).toBe("-<1 WHL");
    }
  });

  it("parse whole numbers only, and other units up to their decimals", () => {
    expect(parseUnitAmount("12", WHOLE_18)).toBe(12n * UNIT);
    expect(parseUnitAmount("1,000", WHOLE_18)).toBe(1_000n * UNIT);
    expect(parseUnitAmount("0", WHOLE_18, { allowZero: true })).toBe(0n);
    expect(() => parseUnitAmount("1.5", WHOLE_18)).toThrow("Amount must be a whole number");
    expect(() => parseUnitAmount(".5", WHOLE_18, { label: "Fee" })).toThrow("Fee must be a whole number");
    expect(() => parseUnitAmount("0", WHOLE_18)).toThrow(/greater than zero/);
    expect(parseUnitAmount("1.5", ETH)).toBe(UNIT * 3n / 2n);
    expect(parseUnitAmount("1.23", CENTS)).toBe(123n);
  });
});
