/** How an amount of base units reads: its decimal places and the symbol after it. */
export interface AmountUnit {
  decimals: number;
  symbol: string;
  /** Shown and entered in whole units only; a nonzero amount below one unit shows as "<1". */
  whole?: boolean;
}

/** Balances, available amounts and limits round down; costs round up; other amounts round to nearest. */
export type AmountRounding = "nearest" | "down" | "up";

export interface FormatAmountOptions {
  useGrouping?: boolean;
  rounding?: AmountRounding | undefined;
}

/** Displayed amounts of a unit that is not whole show at most this many decimal places; exact values go in hover text. */
export const DISPLAY_FRACTION_DIGITS = 3;
/** Nonzero amounts too small for those decimal places show this many significant digits instead. */
const SMALL_SIGNIFICANT_DIGITS = 2;

export interface ParseAmountOptions {
  allowZero?: boolean;
  label?: string;
}

function assertDecimals(decimals: number): void {
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 18) throw new Error("decimals must be an integer from 0 to 18");
}

function grouped(value: string, enabled: boolean): string {
  return enabled ? value.replace(/\B(?=(\d{3})+(?!\d))/g, ",") : value;
}

function exactValue(value: bigint, decimals: number, useGrouping: boolean): string {
  assertDecimals(decimals);
  const scale = 10n ** BigInt(decimals);
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = absolute / scale;
  const fraction = decimals === 0 ? "" : (absolute % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${grouped(whole.toString(), useGrouping)}${fraction === "" ? "" : `.${fraction}`}`;
}

/** The base-unit step an amount displays at: one whole unit, 3 decimal places, or 2 significant digits below 0.001. */
function displayStep(absolute: bigint, unit: AmountUnit): bigint {
  if (unit.whole === true) return 10n ** BigInt(unit.decimals);
  const step = 10n ** BigInt(Math.max(0, unit.decimals - DISPLAY_FRACTION_DIGITS));
  return absolute >= step ? step : 10n ** BigInt(Math.max(0, absolute.toString().length - SMALL_SIGNIFICANT_DIGITS));
}

function roundToDisplay(absolute: bigint, unit: AmountUnit, rounding: AmountRounding): bigint {
  const step = displayStep(absolute, unit);
  const remainder = absolute % step;
  const floor = absolute - remainder;
  if (remainder === 0n || rounding === "down") return floor;
  return rounding === "up" || remainder * 2n >= step ? floor + step : floor;
}

/** Format base units with exact bigint rounding and no Number conversion. A nonzero amount never displays as zero. */
export function formatTokenAmount(value: bigint, unit: AmountUnit, options: FormatAmountOptions = {}): string {
  assertDecimals(unit.decimals);
  const sign = value < 0n ? "-" : "";
  const absolute = value < 0n ? -value : value;
  if (unit.whole === true && absolute !== 0n && absolute < 10n ** BigInt(unit.decimals)) return `${sign}<1 ${unit.symbol}`;
  const rounded = roundToDisplay(absolute, unit, options.rounding ?? "nearest");
  return `${sign}${exactValue(rounded, unit.decimals, options.useGrouping ?? true)} ${unit.symbol}`;
}

/** Every decimal place, for hover text and audit-oriented surfaces. */
export function formatTokenExact(value: bigint, unit: AmountUnit, useGrouping = true): string {
  return `${exactValue(value, unit.decimals, useGrouping)} ${unit.symbol}`;
}

/** The largest value at or below `value` that displays exactly, for amounts the site writes into an input. */
export function floorToDisplay(value: bigint, unit: AmountUnit): bigint {
  assertDecimals(unit.decimals);
  return roundToDisplay(value, unit, "down");
}

/** Exact ungrouped decimal suitable for an amount input value. */
export function formatTokenInput(value: bigint, decimals: number): string {
  return exactValue(value, decimals, false);
}

/** Parse a nonnegative amount in `unit` into exact base units: a whole number for a whole unit, otherwise up to its decimals. */
export function parseUnitAmount(value: string, unit: AmountUnit, options: ParseAmountOptions = {}): bigint {
  return unit.whole === true
    ? parseTokenAmount(value, 0, options) * 10n ** BigInt(unit.decimals)
    : parseTokenAmount(value, unit.decimals, options);
}

/** Parse a nonnegative human decimal into exact base units. */
export function parseTokenAmount(value: string, decimals: number, options: ParseAmountOptions = {}): bigint {
  assertDecimals(decimals);
  const label = options.label ?? "Amount";
  const input = value.trim().replace(/^\.(?=\d)/, "0.");
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d*)?$/.test(input)) {
    throw new Error(decimals === 0
      ? `${label} must be a whole number`
      : `${label} must be a number, like 12 or 0.5`);
  }
  const normalized = input.replace(/,/g, "");
  const [whole, fraction = ""] = normalized.split(".");
  if (fraction.length > decimals) {
    throw new Error(decimals === 0 ? `${label} must be a whole number` : `${label} can have at most ${decimals} decimal places`);
  }
  const parsed = BigInt(whole!) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
  if (options.allowZero === true ? parsed < 0n : parsed <= 0n) {
    throw new Error(`${label} must be greater than zero`);
  }
  return parsed;
}
