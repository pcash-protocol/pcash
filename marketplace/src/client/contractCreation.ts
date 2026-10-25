// Marketplace adapter for a seller-sponsored contract-account creation: the
// Wallet pays the creation fee from its own notes, so the offer's escrow
// contract is relayable by fee density rather than waiting for sponsorship.

import type { Hex } from "viem";
import type { PcashNodeClient } from "@pcash/sdk/browser";
import type { SelectedRelayQuoteProvider } from "@pcash/sdk/eip712";
import type { Wallet, DurableSubmissionAdapter } from "@pcash/sdk/wallet";
import type { ProvePhase } from "@pcash/sdk/browser-prover";
import { marketplaceMempoolSubmission, submitBuiltTransaction } from "./submitBuiltTransaction.ts";

export interface SponsoredContractCreationFlowParams {
  submission?: DurableSubmissionAdapter;
  wallet: Wallet;
  /** Wallet-bound node selected by the enclosing Marketplace action. */
  node: PcashNodeClient;
  contract: { body: Uint8Array; address: bigint };
  openFeeAmount: bigint;
  privateRelayFeeAmount?: bigint;
  selectedRelayQuote?: SelectedRelayQuoteProvider;
  issuanceOwnerCommitment?: bigint;
  validUntilTimestamp?: bigint;
  validUntilMode?: "exact" | "ceiling";
  /** Called after the exact content hash is durably journaled, before network submission. */
  onPreparedContentHash?: (contentHash: string, transactionHex: Hex) => void | Promise<void>;
  onProgress?: (phase: ProvePhase, message: string) => void;
}

export interface SponsoredContractCreationFlowResult {
  contentHash: string;
  transactionHex: Hex;
  /** True when only the configured node has acknowledged this exact transaction. */
  queued: boolean;
  settled: boolean;
  changeAmount: bigint;
}

export interface SponsoredContractCreationFlowRuntime {
  submitBuiltTransaction: typeof submitBuiltTransaction;
}

const DEFAULT_RUNTIME: SponsoredContractCreationFlowRuntime = { submitBuiltTransaction };

export async function runSponsoredContractCreationFlow(
  params: SponsoredContractCreationFlowParams,
  runtime: SponsoredContractCreationFlowRuntime = DEFAULT_RUNTIME,
): Promise<SponsoredContractCreationFlowResult> {
  const result = await params.wallet.sponsorContractCreation({
    ...(params.submission ? { submission: params.submission } : params.openFeeAmount === 0n ? {} : {
      submission: marketplaceMempoolSubmission(params.node, runtime.submitBuiltTransaction, params.onProgress),
    }),
    contract: params.contract,
    openFeeAmount: params.openFeeAmount,
    ...(params.privateRelayFeeAmount === undefined ? {} : { privateRelayFeeAmount: params.privateRelayFeeAmount }),
    ...(params.selectedRelayQuote === undefined ? {} : { selectedRelayQuote: params.selectedRelayQuote }),
    ...(params.issuanceOwnerCommitment !== undefined ? { issuanceOwnerCommitment: params.issuanceOwnerCommitment } : {}),
    ...(params.validUntilTimestamp !== undefined ? { validUntilTimestamp: params.validUntilTimestamp } : {}),
    ...(params.validUntilMode !== undefined ? { validUntilMode: params.validUntilMode } : {}),
    ...(params.onPreparedContentHash !== undefined
      ? { onPrepared: (contentHash: string, transactionHex: string) => params.onPreparedContentHash!(contentHash, transactionHex as Hex) }
      : {}),
    onProgress: (phase, message) => params.onProgress?.(phase, message),
  });
  return {
    contentHash: result.contentHash,
    transactionHex: result.transactionHex as Hex,
    queued: result.queued && result.submission?.l1Hash === undefined,
    settled: result.settled,
    changeAmount: result.changeAmount,
  };
}
