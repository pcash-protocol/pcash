// Funding the protocol fee from the wallet's native notes.

import { InsufficientNotesError } from "../noteStore.ts";

/** The protocol fee needs native PCASH the wallet does not hold. */
export class ProtocolFeeFundingError extends InsufficientNotesError {
  readonly nativeBurnAmount: bigint;

  constructor(params: ConstructorParameters<typeof InsufficientNotesError>[0] & { nativeBurnAmount: bigint }) {
    super(params);
    this.message = `this action must burn ${params.nativeBurnAmount} native PCASH for the protocol fee, and the wallet `
      + `holds ${params.totalBalance} of the ${params.need} it needs. Native PCASH is required right now; `
      + "the alternative is to wait for the protocol fee to return to zero.";
    this.name = "ProtocolFeeFundingError";
    this.nativeBurnAmount = params.nativeBurnAmount;
  }

  /** An action with no native input to burn from while the protocol fee is positive. */
  static unfunded(networkFeeAmount: bigint): ProtocolFeeFundingError {
    return new ProtocolFeeFundingError({
      need: networkFeeAmount, maximumTransfer: 0n, totalBalance: 0n, maxInputs: 0, outputCount: 0,
      nativeBurnAmount: networkFeeAmount,
    });
  }
}

/**
 * Name the protocol fee when it is what the wallet cannot fund: the action
 * would be fundable without the burn. Funds split across too many notes are
 * an ordinary shortfall that merging resolves.
 */
export function protocolFeeFundingFailure(error: unknown, nativeBurnAmount: bigint): unknown {
  if (!(error instanceof InsufficientNotesError) || error instanceof ProtocolFeeFundingError) return error;
  if (nativeBurnAmount === 0n || error.totalBalance >= error.need || error.totalBalance + nativeBurnAmount < error.need) {
    return error;
  }
  return new ProtocolFeeFundingError({
    need: error.need, maximumTransfer: error.maximumTransfer, totalBalance: error.totalBalance,
    maxInputs: error.maxInputs, outputCount: error.outputCount, nativeBurnAmount,
  });
}
