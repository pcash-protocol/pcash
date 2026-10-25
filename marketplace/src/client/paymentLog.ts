// Select the router's Payment event in an Ethereum receipt. Recovery reads it
// to confirm a payment's canonical record and its payer.

import { hexToBigInt, size, sliceHex, type Hex } from "viem";

/** amount and claimKeyCommitment, then the offset and length of recoveryData. */
const MIN_PAYMENT_DATA_BYTES = 4 * 32;

export interface ExpectedPayment {
  router: bigint;
  offerId: bigint;
  seller: bigint;
  amount: bigint;
  claimKeyCommitment?: Hex;
}

export interface L1LogShape {
  address: Hex;
  topics: readonly Hex[];
  data: Hex;
}

export function paymentLogMatches(
  log: L1LogShape,
  paymentEventSignature: Hex,
  expected: ExpectedPayment,
): boolean {
  return log.topics.length === 4 &&
    log.topics[0]?.toLowerCase() === paymentEventSignature.toLowerCase() &&
    size(log.data) >= MIN_PAYMENT_DATA_BYTES &&
    hexToBigInt(log.address) === expected.router &&
    hexToBigInt(log.topics[1]!) === expected.offerId &&
    hexToBigInt(sliceHex(log.topics[2]!, 12)) === expected.seller &&
    hexToBigInt(sliceHex(log.data, 0, 32)) === expected.amount &&
    (expected.claimKeyCommitment === undefined ||
      sliceHex(log.data, 32, 64).toLowerCase() === expected.claimKeyCommitment.toLowerCase());
}

export function selectPaymentLog(
  logs: readonly L1LogShape[],
  paymentEventSignature: Hex,
  expected: ExpectedPayment,
): { log: L1LogShape; logIndex: number; payer: bigint } {
  const matches = logs
    .map((log, logIndex) => ({ log, logIndex }))
    .filter(({ log }) => paymentLogMatches(log, paymentEventSignature, expected));
  if (matches.length !== 1) {
    throw new Error(`expected exactly one matching Payment log, found ${matches.length}`);
  }
  const match = matches[0]!;
  return {
    ...match,
    payer: hexToBigInt(sliceHex(match.log.topics[3]!, 12)),
  };
}
