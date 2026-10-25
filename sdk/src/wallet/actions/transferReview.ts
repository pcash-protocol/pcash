import type { IssuanceBeneficiary, PublicationMode } from "./publication.ts";

export interface WalletTransferPreflight {
  dataHash?: string | undefined;
  openFeeAmount: bigint;
  privateRelayFeeAmount: bigint;
  privateRelayRecipient: string | null;
  /** Who receives issuance; a selected relayer also receives the private fee output. */
  beneficiary: IssuanceBeneficiary;
  /** How the action reaches Ethereum: public mempool, self publication, or a selected relayer. */
  publication: PublicationMode;
  /** Notes this payment spends; a zero payment with a zero fee spends none. */
  inputCount: number;
  inputTotal: bigint;
  retry: boolean;
}

/** The reviewed payment state no longer matches the wallet's reserved live state. */
export class WalletReviewStaleError extends Error {
  constructor() {
    super("Wallet state changed after review. Review the payment again.");
    this.name = "WalletReviewStaleError";
  }
}

function sameBeneficiary(left: IssuanceBeneficiary, right: IssuanceBeneficiary): boolean {
  if (left.kind !== right.kind) return false;
  return left.kind !== "recipient" || left.address.toLowerCase() === (right as typeof left).address.toLowerCase();
}

export function assertWalletTransferReview(
  expected: WalletTransferPreflight | undefined,
  actual: WalletTransferPreflight,
): void {
  if (expected === undefined) return;
  if (
    expected.dataHash !== actual.dataHash
    || expected.retry !== actual.retry
    || expected.openFeeAmount !== actual.openFeeAmount
    || expected.privateRelayFeeAmount !== actual.privateRelayFeeAmount
    || expected.privateRelayRecipient?.toLowerCase() !== actual.privateRelayRecipient?.toLowerCase()
    || expected.publication !== actual.publication
    || !sameBeneficiary(expected.beneficiary, actual.beneficiary)
    || expected.inputCount !== actual.inputCount
    || expected.inputTotal !== actual.inputTotal
  ) throw new WalletReviewStaleError();
}
