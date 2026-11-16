import type { BlockEconomicsPageResult, IssuanceQuoteResult } from "@pcash/sdk/clients";
import { estimateOtherQualifyingActions } from "@pcash/sdk/relay";
import { issuanceTerms, rewardEach } from "@pcash/sdk/protocol";

const PCASH = 10n ** 18n;

/** Expected per-action issuance, counting this payment alongside recent activity. */
export function paymentIssuanceFromInputs(quote: IssuanceQuoteResult | null, economics: BlockEconomicsPageResult): bigint {
  return rewardEach(issuanceTerms(quote), estimateOtherQualifyingActions(economics.records) + 1n);
}

/** Default public open fee: 5% of the per-action issuance estimate rounded to whole PCASH, at least 1 PCASH; 1 PCASH without an estimate. */
export function defaultOpenFee(issuance: bigint | undefined): bigint {
  const whole = issuance === undefined ? 0n : (issuance * 5n + 50n * PCASH) / (100n * PCASH);
  return (whole > 1n ? whole : 1n) * PCASH;
}
