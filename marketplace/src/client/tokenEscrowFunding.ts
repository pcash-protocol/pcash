// Seller funding of a token escrow. The escrow note's secret derives from the
// seller's seed and the offer, so its opening is known before funding and is
// found at the funding receipt's first output leaf, independent of any
// delivery envelope.

import { encodeAbiParameters, keccak256, stringToHex, bytesToHex, type Hex } from "viem";
import {
  fieldToHex,
  fullOutputCommitment,
  OutputOpeningMismatchError,
  scalarFromBytes,
  type ReceiptResult,
  type PcashNodeClient,
} from "@pcash/sdk/browser";
import type { SelectedRelayQuoteProvider } from "@pcash/sdk/eip712";
import type { TransactionData, AccountCreationAttachment } from "@pcash/sdk/protocol";
import type { ProvePhase } from "@pcash/sdk/browser-prover";
import type { DurableSubmissionAdapter, PcashProfile, Wallet } from "@pcash/sdk/wallet";
import { noteFundedTransferValidUntil } from "@pcash/sdk/wallet/actions";
import type { EscrowOpening } from "./publication.ts";
import { marketplaceMempoolSubmission, submitBuiltTransaction } from "./submitBuiltTransaction.ts";

export interface TokenEscrowFundingParams {
  submission?: DurableSubmissionAdapter;
  wallet: Wallet;
  accountCreation?: AccountCreationAttachment;
  node: PcashNodeClient;
  assetId: bigint;
  /** The escrow contract's extended code: its address and receive key. */
  to: string;
  amount: bigint;
  /** The escrow note is opened to the contract under this secret. */
  noteSecret: bigint;
  /** Written to the seller's sender region of the funding transaction. */
  data: TransactionData;
  openFeeAmount: bigint;
  privateRelayFeeAmount?: bigint;
  selectedRelayQuote?: SelectedRelayQuoteProvider;
  validUntilTimestamp: bigint;
  /** Run after preflight and before the wallet journal is written. */
  beforeSubmit?: (contentHash: string, transactionHex: Hex) => void | Promise<void>;
  /** Called after the exact content hash is durably journaled, before network submission. */
  onPreparedContentHash?: (contentHash: string, transactionHex: Hex) => void | Promise<void>;
  onProgress?: (phase: ProvePhase, message: string) => void;
}

export interface TokenEscrowFundingResult {
  contentHash: string;
  /** True when only the configured node has acknowledged this exact transaction. */
  queued: boolean;
}

export interface TokenEscrowFundingPreflightParams {
  wallet: Wallet;
  accountCreation?: AccountCreationAttachment;
  assetId: bigint;
  amount: bigint;
  /** Every PCASH fee the listing's funding pays. */
  openFeeAmount: bigint;
  privateRelayFeeAmount?: bigint;
  selectedRelayQuote?: SelectedRelayQuoteProvider;
  validUntilTimestamp: bigint;
}

export interface TokenEscrowFundingFlowRuntime {
  submitBuiltTransaction: typeof submitBuiltTransaction;
}

const DEFAULT_TOKEN_ESCROW_FUNDING_RUNTIME: TokenEscrowFundingFlowRuntime = { submitBuiltTransaction };

/**
 * Send exactly `amount` of the token to the escrow contract under
 * `noteSecret`. The escrow note is output slot 0 of the wallet's asset send.
 */
export async function runTokenEscrowFundingFlow(
  params: TokenEscrowFundingParams,
  runtime: TokenEscrowFundingFlowRuntime = DEFAULT_TOKEN_ESCROW_FUNDING_RUNTIME,
): Promise<TokenEscrowFundingResult> {
  // The asset send takes an exact deadline, so the offer's funding deadline is
  // applied as a ceiling on the wallet's normal window here.
  const validUntilTimestamp = noteFundedTransferValidUntil(await params.node.status(), {
    validUntilMode: "ceiling",
    validUntilTimestamp: params.validUntilTimestamp,
    ...(params.selectedRelayQuote === undefined ? {} : { selectedRelayQuote: params.selectedRelayQuote }),
  });
  const result = await params.wallet.sendAsset({
    settlePollMaxAttempts: 1,
    ...(params.submission ? { submission: params.submission } : params.openFeeAmount === 0n ? {} : {
      submission: marketplaceMempoolSubmission(params.node, runtime.submitBuiltTransaction, params.onProgress),
    }),
    assetId: params.assetId,
    ...(params.accountCreation === undefined ? {} : { accountCreation: params.accountCreation }),
    outputs: [{ to: params.to, amount: params.amount, noteSecret: params.noteSecret }],
    data: params.data,
    openFeeAmount: params.openFeeAmount,
    ...(params.privateRelayFeeAmount === undefined ? {} : { privateRelayFeeAmount: params.privateRelayFeeAmount }),
    ...(params.selectedRelayQuote === undefined ? {} : { selectedRelayQuote: params.selectedRelayQuote }),
    validUntilTimestamp,
    ...(params.beforeSubmit === undefined ? {} : { beforeJournal: (contentHash: string, transactionHex: string) => params.beforeSubmit!(contentHash, transactionHex as Hex) }),
    ...(params.onPreparedContentHash === undefined
      ? {}
      : { onPrepared: (contentHash: string, transactionHex: string) => params.onPreparedContentHash!(contentHash, transactionHex as Hex) }),
    onProgress: (phase, message) => params.onProgress?.(phase, message),
  });
  return { contentHash: result.contentHash, queued: result.queued && result.submission?.l1Hash === undefined };
}

/** Fail before contract publication when this wallet cannot fund the token escrow and its fee. */
export async function preflightTokenEscrowFunding(params: TokenEscrowFundingPreflightParams): Promise<void> {
  const holding = (await params.wallet.assets()).find((asset) => asset.assetId === params.assetId);
  const spendable = holding?.spendable ?? 0n;
  if (spendable < params.amount) {
    throw new Error(`the listing needs ${params.amount} of this token, but this wallet can spend ${spendable}`);
  }
  if (holding === undefined || holding.definition === null) throw new Error("import the token definition before funding a recoverable escrow");
  // The fees are paid from PCASH notes, as a zero-amount transfer would pay them.
  await params.wallet.preflightSend({
    amount: 0n,
    ...(params.accountCreation === undefined ? {} : { accountCreation: params.accountCreation }),
    openFeeAmount: params.openFeeAmount,
    ...(params.privateRelayFeeAmount === undefined ? {} : { privateRelayFeeAmount: params.privateRelayFeeAmount }),
    ...(params.selectedRelayQuote === undefined ? {} : { selectedRelayQuote: params.selectedRelayQuote }),
    validUntilMode: "ceiling",
    validUntilTimestamp: params.validUntilTimestamp,
  });
}

const TOKEN_ESCROW_NOTE_SECRET_DOMAIN = keccak256(stringToHex("pcash marketplace deterministic token escrow note secret"));

/** The escrow note secret for one offer, recomputed from the seller's restored wallet. */
export function deriveTokenEscrowNoteSecret(input: {
  seller: Pick<PcashProfile, "applicationSeed" | "nkRoot">;
  chainId: bigint;
  offerId: bigint;
  contractAddress: bigint;
}): bigint {
  if (input.seller.applicationSeed.length !== 32) throw new Error("seller application seed must be 32 bytes");
  return scalarFromBytes(keccak256(encodeAbiParameters(
    [
      { type: "bytes32" },
      { type: "bytes32" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "uint256" },
    ],
    [
      TOKEN_ESCROW_NOTE_SECRET_DOMAIN,
      bytesToHex(input.seller.applicationSeed),
      input.seller.nkRoot,
      input.chainId,
      input.offerId,
      input.contractAddress,
    ],
  ), "bytes"));
}

/** Open the funded escrow note at the funding receipt's first output leaf. */
export async function recoverTokenEscrow(
  node: Pick<PcashNodeClient, "getOutputPath">,
  receipt: ReceiptResult,
  note: { owner: bigint; assetId: bigint; amount: bigint; noteSecret: bigint },
): Promise<EscrowOpening> {
  if (receipt.outputLeafStart === null) throw new Error(`accepted funding transaction ${receipt.transactionId} has no outputLeafStart`);
  const leafIndex = receipt.outputLeafStart;
  let path: Awaited<ReturnType<PcashNodeClient["getOutputPath"]>>;
  try {
    path = await node.getOutputPath(leafIndex, fullOutputCommitment(note, leafIndex));
  } catch (error) {
    if (!(error instanceof OutputOpeningMismatchError)) throw error;
    path = null;
  }
  if (path === null) throw new Error(`the funding transaction ${receipt.transactionId} did not create the ${note.amount} token escrow`);
  if (leafIndex > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("escrow leaf index exceeds the browser's safe integer range");
  return { leafIndex: Number(leafIndex), noteSecret: fieldToHex(note.noteSecret), amount: fieldToHex(note.amount) };
}
