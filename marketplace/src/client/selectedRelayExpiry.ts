import type { SelectedRelayQuoteProvider } from "@pcash/sdk/browser";

const REFERENCE_QUOTE_WINDOW_SECONDS = 3600n;

/** Bound the proved transaction by both its application deadline and the relayer's quoted lifetime. */
export function selectedRelayTransactionExpiry(
  currentTimestamp: bigint,
  applicationDeadline: bigint,
  provider: SelectedRelayQuoteProvider,
  action: "claim" | "reclaim",
): bigint {
  const advertisedWindow = provider.maxQuoteLifetimeSeconds ?? REFERENCE_QUOTE_WINDOW_SECONDS;
  const quoteWindow = advertisedWindow < REFERENCE_QUOTE_WINDOW_SECONDS
    ? advertisedWindow : REFERENCE_QUOTE_WINDOW_SECONDS;
  const validUntilTimestamp = applicationDeadline < currentTimestamp + quoteWindow
    ? applicationDeadline : currentTimestamp + quoteWindow;
  if (validUntilTimestamp <= currentTimestamp) {
    throw new Error(`selected ${action} transaction expires at or before the current block timestamp`);
  }
  return validUntilTimestamp;
}
