import {
  formatTokenAmount,
  formatTokenInput,
  parseUnitAmount,
  type AmountUnit,
  type FormatAmountOptions,
  type ParseAmountOptions,
} from "./tokenAmount.ts";

export const PCASH_DECIMALS = 18;
/** The site shows and takes PCASH in whole units; exact values go in hover text. */
export const PCASH_UNIT: AmountUnit = { decimals: PCASH_DECIMALS, symbol: "PCASH", whole: true };

export type FormatPcashOptions = FormatAmountOptions;
export type ParsePcashOptions = ParseAmountOptions;

/** Format PCASH base units as whole PCASH, or "<1 PCASH", with exact bigint rounding. */
export function formatPcashAmount(value: bigint, options: FormatPcashOptions = {}): string {
  return formatTokenAmount(value, PCASH_UNIT, options);
}

/** Exact ungrouped decimal suitable for a PCASH input value. */
export function formatPcashInput(value: bigint): string {
  return formatTokenInput(value, PCASH_DECIMALS);
}

/** Fill the leading zero a user omits when typing an amount like ".5". */
export function withLeadingZero(value: string): string {
  return value.startsWith(".") ? `0${value}` : value;
}

/** Parse a nonnegative whole number of PCASH into 18-decimal base units. */
export function parsePcashAmount(value: string, options: ParsePcashOptions = {}): bigint {
  return parseUnitAmount(value, PCASH_UNIT, { ...options, label: options.label ?? "PCASH amount" });
}
