// Marketplace adapter for the Wallet's unified private-value transfer. The
// Wallet selects notes; this layer supplies the offer deadline,
// exact-byte checkpoint hooks, and Marketplace mempool admission checks.

import type { Hex } from "viem";
import type { StatusResult } from "@pcash/sdk/browser";
import type { PcashNodeClient } from "@pcash/sdk/browser";
import type { SelectedRelayQuoteProvider } from "@pcash/sdk/eip712";
import type { TransactionData, AccountCreationAttachment } from "@pcash/sdk/protocol";
import type { Wallet, DurableSubmissionAdapter } from "@pcash/sdk/wallet";
import { noteFundedTransferValidUntil as sharedNoteFundedTransferValidUntil } from "@pcash/sdk/wallet/actions";
import { marketplaceMempoolSubmission, submitBuiltTransaction } from "./submitBuiltTransaction.ts";
import type { ProvePhase } from "@pcash/sdk/browser-prover";

export { looksLikeExtendedCode, resolveRecipientDelivery } from "@pcash/sdk/delivery";
export type { RecipientDelivery } from "@pcash/sdk/delivery";

export interface NoteFundedTransferFlowParams {
  submission?: DurableSubmissionAdapter;
  wallet: Wallet;
  accountCreation?: AccountCreationAttachment;
  /** Wallet-bound node selected by the enclosing Marketplace action. */
  node: PcashNodeClient;
  to: string;
  amount: bigint;
  /** Written to the payer's own sender region of the transaction. */
  data?: TransactionData;
  openFeeAmount?: bigint;
  privateRelayFeeAmount?: bigint;
  selectedRelayQuote?: SelectedRelayQuoteProvider;
  issuanceOwnerCommitment?: bigint;
  /** Optional earlier validity ceiling; the normal wallet-policy window remains the maximum. */
  validUntilTimestamp?: bigint;
  /** Called after the exact content hash is durably journaled, before network submission. */
  onPreparedContentHash?: (contentHash: string, transactionHex: Hex) => void | Promise<void>;
  /** Run after preflight and before the wallet journal is written. */
  beforeSubmit?: (contentHash: string, transactionHex: Hex) => void | Promise<void>;
  onProgress?: (phase: ProvePhase, message: string) => void;
}

export interface NoteFundedTransferFlowResult {
  contentHash: string;
  /** True when only the configured node has acknowledged this exact transaction. */
  queued: boolean;
  recipient: string;
  amount: bigint;
  changeAmount: bigint;
  settled: boolean;
}

export interface NoteFundedTransferPreflightParams {
  wallet: Wallet;
  accountCreation?: AccountCreationAttachment;
  amount: bigint;
  openFeeAmount?: bigint;
  privateRelayFeeAmount?: bigint;
  selectedRelayQuote?: SelectedRelayQuoteProvider;
  issuanceOwnerCommitment?: bigint;
  /** When supplied, a matching unresolved exact-byte journal satisfies preflight. */
  to?: string;
  validUntilTimestamp?: bigint;
}

export interface NoteFundedTransferPreflightResult {
  inputCount: number;
  inputTotal: bigint;
}

/** Fail before contract publication when this Wallet cannot fund the escrow. */
export async function preflightNoteFundedTransfer(
  params: NoteFundedTransferPreflightParams,
): Promise<NoteFundedTransferPreflightResult> {
  const result = await params.wallet.preflightSend({
    amount: params.amount,
    ...(params.accountCreation === undefined ? {} : { accountCreation: params.accountCreation }),
    validUntilMode: "ceiling",
    ...(params.openFeeAmount !== undefined ? { openFeeAmount: params.openFeeAmount } : {}),
    ...(params.privateRelayFeeAmount !== undefined ? { privateRelayFeeAmount: params.privateRelayFeeAmount } : {}),
    ...(params.selectedRelayQuote !== undefined ? { selectedRelayQuote: params.selectedRelayQuote } : {}),
    ...(params.issuanceOwnerCommitment !== undefined ? { issuanceOwnerCommitment: params.issuanceOwnerCommitment } : {}),
    ...(params.to !== undefined ? { to: params.to } : {}),
    ...(params.validUntilTimestamp !== undefined ? { validUntilTimestamp: params.validUntilTimestamp } : {}),
  });
  return {
    inputCount: result.inputCount,
    inputTotal: result.inputTotal,
  };
}

export interface NoteFundedTransferFlowRuntime {
  submitBuiltTransaction: typeof submitBuiltTransaction;
}

const DEFAULT_NOTE_FUNDED_TRANSFER_RUNTIME: NoteFundedTransferFlowRuntime = {
  submitBuiltTransaction,
};

export function noteFundedTransferValidUntil(status: StatusResult, ceiling?: bigint): bigint {
  return sharedNoteFundedTransferValidUntil(status, {
    validUntilMode: "ceiling",
    ...(ceiling !== undefined ? { validUntilTimestamp: ceiling } : {}),
  });
}

export async function runNoteFundedTransferFlow(
  params: NoteFundedTransferFlowParams,
  runtime: NoteFundedTransferFlowRuntime = DEFAULT_NOTE_FUNDED_TRANSFER_RUNTIME,
): Promise<NoteFundedTransferFlowResult> {
  const result = await params.wallet.send({
    settlePollMaxAttempts: 1,
    ...(params.submission ? { submission: params.submission } : params.openFeeAmount === undefined || params.openFeeAmount === 0n ? {} : {
      submission: marketplaceMempoolSubmission(params.node, runtime.submitBuiltTransaction, params.onProgress),
    }),
    to: params.to,
    ...(params.data === undefined ? {} : { data: params.data }),
    amount: params.amount,
    ...(params.accountCreation === undefined ? {} : { accountCreation: params.accountCreation }),
    validUntilMode: "ceiling",
    ...(params.beforeSubmit !== undefined ? { beforeJournal: (contentHash: string, transactionHex: string) => params.beforeSubmit!(contentHash, transactionHex as Hex) } : {}),
    ...(params.onPreparedContentHash !== undefined
      ? { onPrepared: (contentHash: string, transactionHex: string) => params.onPreparedContentHash!(contentHash, transactionHex as Hex) }
      : {}),
    onProgress: (phase, message) => params.onProgress?.(phase, message),
    ...(params.openFeeAmount !== undefined ? { openFeeAmount: params.openFeeAmount } : {}),
    ...(params.privateRelayFeeAmount !== undefined ? { privateRelayFeeAmount: params.privateRelayFeeAmount } : {}),
    ...(params.selectedRelayQuote !== undefined ? { selectedRelayQuote: params.selectedRelayQuote } : {}),
    ...(params.issuanceOwnerCommitment !== undefined ? { issuanceOwnerCommitment: params.issuanceOwnerCommitment } : {}),
    ...(params.validUntilTimestamp !== undefined ? { validUntilTimestamp: params.validUntilTimestamp } : {}),
  });

  return {
    contentHash: result.contentHash,
    queued: result.queued && result.submission?.l1Hash === undefined,
    recipient: result.recipient,
    amount: result.amount,
    changeAmount: result.changeAmount,
    settled: result.settled,
  };
}
