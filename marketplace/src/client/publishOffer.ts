import { sellerRecord } from "./sellerRecovery.ts";
// Seller publication retains one transaction that creates and funds its escrow.
// Its canonical receipt gates catalog publication.

import {
  fieldToHex,
  type PcashNodeClient,
  type WalletProfileWithReceiveKeys,
  addressHex,
  bytesEqual,
} from "@pcash/sdk/browser";
import {
  deterministicMlKemKeysFromApplicationSeed,
  walletAction,
  DurablePreBroadcastError,
  createMempoolSubmissionAdapter,
  type DurableSubmissionAdapter,
  type PcashProfile,
  type Wallet,
  type WalletExecutionContext,
} from "@pcash/sdk/wallet";
import { scanWallet } from "@pcash/sdk/wallet/scanning";
import type { Hex } from "viem";
import { awaitAcceptedReceipt, isFinalized, pollReceipt, type ReceiptResult } from "@pcash/sdk/browser";
import { preflightNoteFundedTransfer, runNoteFundedTransferFlow } from "./noteFundedTransfer.ts";
import {
  deriveTokenEscrowNoteSecret,
  preflightTokenEscrowFunding,
  recoverTokenEscrow,
  runTokenEscrowFundingFlow,
} from "./tokenEscrowFunding.ts";
import type { ProvePhase } from "@pcash/sdk/browser-prover";
import { MIN_CLAIM_WINDOW_SECONDS } from "../commitments.mts";
import { buildExtendedCode } from "@pcash/sdk/delivery";
import { transactionIdentity } from "@pcash/sdk/protocol";
import type { SelectedRelayQuoteProvider } from "@pcash/sdk/eip712";

/** Browser flow input; the marketplace Offer is structurally assignable to this. */
export interface PublishableOffer {
  terms: {
    router: bigint;
    seller: bigint;
    id: bigint;
    assetId: bigint;
    amount: bigint;
    ethPriceWei: bigint;
    deadlineT: bigint;
  };
  chainId: bigint;
  l2ContractNkRoot: bigint;
  l2ContractAddress: bigint;
  l2ContractBody: Uint8Array;
  reclaimAuthority: bigint;
  l2ContractWallet: WalletProfileWithReceiveKeys;
}
export interface EscrowOpening {
  leafIndex: number;
  noteSecret: string;
  amount: string;
}

export interface PublishOfferResume {
  fundingContentHash?: string;
  fundingTransactionHex?: Hex;
}

export interface PublishOfferCheckpoint {
  fundingContentHash: string;
  fundingTransactionHex?: Hex;
  fundingAcceptedBlock?: string;
  fundingAcceptedBlockHash?: string;
}

export type OfferPublicationFinality =
  | { phase: "missing" | "skipped" }
  | { phase: "accepted" | "finalized"; receipt: ReceiptResult };

export interface PublishOfferParams {
  /** Publication adapter for the one escrow transaction. */
  submission?: DurableSubmissionAdapter;
  assertActive?: () => void;
  wallet: Wallet;
  offer: PublishableOffer;
  /** Open PCASH fee paid to whichever relayer includes the escrow funding. */
  fundingOpenFeeAmount: bigint;
  privateRelayFeeAmount?: bigint;
  selectedRelayQuote?: SelectedRelayQuoteProvider;
  /** Latest timestamp from the selected L1 RPC, used to fail closed around T. */
  readL1Timestamp: (node: PcashNodeClient) => Promise<bigint>;
  resume?: PublishOfferResume;
  /** Persist this before allowing the flow to advance to its next network wait. */
  onCheckpoint?: (checkpoint: PublishOfferCheckpoint) => void | Promise<void>;
  /** Clear only the same saved attempt after the wallet permits rebuilding it. */
  onFundingRebuild?: (contentHash: string) => void | Promise<void>;
  onProgress?: (phase: ProvePhase, message: string) => void;
  /** Relay the prepared transaction before waiting for its canonical receipt. */
  relay?: (contentHash: string) => Promise<void>;
  pollIntervalMs?: number;
  pollMaxAttempts?: number;
}

/** Injectable only so the orchestration can be tested without a node or Wallet transfer. */
export interface PublishOfferRuntime {
  resumeValueTransaction: (wallet: Wallet, intent: Parameters<Wallet["resumeValueTransaction"]>[0]) => ReturnType<Wallet["resumeValueTransaction"]>;
  awaitAcceptedReceipt: typeof awaitAcceptedReceipt;
  preflightNoteFundedTransfer: typeof preflightNoteFundedTransfer;
  runNoteFundedTransferFlow: typeof runNoteFundedTransferFlow;
  preflightTokenEscrowFunding: typeof preflightTokenEscrowFunding;
  runTokenEscrowFundingFlow: typeof runTokenEscrowFundingFlow;
  scanWallet: typeof scanWallet;
  recoverTokenEscrow: typeof recoverTokenEscrow;
}

const DEFAULT_RUNTIME: PublishOfferRuntime = {
  resumeValueTransaction: (wallet, intent) => wallet.resumeValueTransaction(intent),
  awaitAcceptedReceipt,
  preflightNoteFundedTransfer,
  runNoteFundedTransferFlow,
  preflightTokenEscrowFunding,
  runTokenEscrowFundingFlow,
  scanWallet,
  recoverTokenEscrow,
};

const CONTENT_HASH = /^0x[0-9a-fA-F]{64}$/;

function requireContentHash(value: string | undefined, label: string): void {
  if (value !== undefined && !CONTENT_HASH.test(value)) throw new Error(`${label} must be a 32-byte content hash`);
}

/** Rebuild the synthetic L2 smart contract wallet from the seller secret, never stored smart contract secrets. */
export function reconstructL2ContractWallet(
  offer: PublishableOffer,
  sellerWallet: PcashProfile,
): WalletProfileWithReceiveKeys {
  if (offer.reclaimAuthority !== sellerWallet.address) {
    throw new Error("the selected seller wallet is not this offer's reclaim authority");
  }

  const receive = deterministicMlKemKeysFromApplicationSeed(
    sellerWallet.applicationSeed,
    offer.l2ContractNkRoot,
  );
  if (!(offer.l2ContractWallet.mlKemPublicKey !== undefined && bytesEqual(offer.l2ContractWallet.mlKemPublicKey, receive.publicKey))) {
    throw new Error("the selected seller wallet does not derive the smart contract receive key");
  }

  return {
    pubX: new Uint8Array(32),
    pubY: new Uint8Array(32),
    address: offer.l2ContractAddress,
    nkRoot: offer.l2ContractNkRoot,
    mlKemPublicKey: receive.publicKey,
    mlKemSecretKey: receive.secretKey,
  };
}

function requireReceiptKind(receipt: ReceiptResult, expected: string, contentHash: string): void {
  if (receipt.kind !== expected) {
    throw new Error(`pcash transaction ${contentHash} was accepted as ${receipt.kind}, expected ${expected}`);
  }
}

/** Re-read a publication receipt without treating accepted inclusion as final. */
export async function readOfferPublicationFinality(
  node: PcashNodeClient,
  contentHash: string,
): Promise<OfferPublicationFinality> {
  const receipt = await pollReceipt(node, contentHash);
  if (receipt === null) return { phase: "missing" };
  if (receipt.outcome !== "succeeded") return { phase: "skipped" };
  requireReceiptKind(receipt, "privateValue", contentHash);
  const status = await node.status();
  return {
    phase: isFinalized(receipt.inclusion.l1BlockNumber, status) ? "finalized" : "accepted",
    receipt,
  };
}

export function assertOfferPublicationWindow(
  deadlineT: bigint,
  l1Timestamp: bigint,
  minimumWindow = MIN_CLAIM_WINDOW_SECONDS,
): void {
  if (deadlineT <= l1Timestamp + minimumWindow) {
    throw new Error(
      `offer deadline is too close: T=${deadlineT}, selected L1 timestamp=${l1Timestamp}, required remaining window>${minimumWindow}s`,
    );
  }
}

/** Last PCASH block timestamp at which escrow funding still leaves the strict claim window before T. */
export function offerFundingValidUntil(deadlineT: bigint): bigint {
  return deadlineT - MIN_CLAIM_WINDOW_SECONDS - 1n;
}

async function requirePublicationWindow(params: PublishOfferParams, node: PcashNodeClient): Promise<void> {
  assertOfferPublicationWindow(params.offer.terms.deadlineT, await params.readL1Timestamp(node));
}

/**
 * Publish a type-3 offer smart contract account, fund it with exactly
 * `terms.amount` of `terms.assetId`, and recover the escrow note's opening at
 * the funding receipt's exact leaf.
 */
export async function publishOffer(
  params: PublishOfferParams,
  runtime: PublishOfferRuntime = DEFAULT_RUNTIME,
): Promise<EscrowOpening> {
  return params.wallet.execute(walletAction("marketplace:publish-offer", (wallet) =>
    publishOfferWithWallet(params, runtime, wallet)));
}

async function publishOfferWithWallet(
  params: PublishOfferParams,
  runtime: PublishOfferRuntime,
  wallet: WalletExecutionContext,
): Promise<EscrowOpening> {
  if (params.submission !== undefined) wallet = { ...wallet, submission: params.submission };
  if (!wallet.spendable()) throw new Error("offer publication requires a spendable wallet");
  const node = wallet.node;
  const { offer } = params;
  if (wallet.network.chainId !== offer.chainId) throw new Error(`offer chain ${offer.chainId} does not match wallet chain ${wallet.network.chainId}`);
  if (offer.terms.amount <= 0n) throw new Error("offer amount must be positive");
  if (params.fundingOpenFeeAmount < 0n) throw new Error("marketplace relayer fee must be nonnegative");
  const transport = wallet.submission ?? createMempoolSubmissionAdapter(node);
  const beforeSubmit = async () => {
    params.assertActive?.();
    await requirePublicationWindow(params, node);
    params.assertActive?.();
  };
  const submission: DurableSubmissionAdapter = {
    ...transport,
    submit: async (context: Parameters<DurableSubmissionAdapter["submit"]>[0]) => {
      try { await beforeSubmit(); } catch (cause) { throw new DurablePreBroadcastError(cause); }
      return transport.submit(context);
    },
  };
  const direct = submission.mode === "l1";
  if (!direct && params.privateRelayFeeAmount !== undefined && params.selectedRelayQuote === undefined
    && params.resume?.fundingContentHash === undefined) throw new Error("selected listing requires its authenticated relayer session");
  let fundingContentHash = params.resume?.fundingContentHash;
  let fundingTransactionHex = params.resume?.fundingTransactionHex;
  requireContentHash(fundingContentHash, "resume.fundingContentHash");
  const contractWallet = reconstructL2ContractWallet(offer, wallet.profile);
  const target: EscrowTarget = { contractWallet, ...(offer.terms.assetId === 0n ? {} : {
    tokenNoteSecret: deriveTokenEscrowNoteSecret({ seller: wallet.profile, chainId: offer.chainId,
      offerId: offer.terms.id, contractAddress: offer.l2ContractAddress }),
  }) };
  let queued = false;
  if (fundingContentHash !== undefined && fundingTransactionHex !== undefined) {
    const resumed = await runtime.resumeValueTransaction(params.wallet, {
      transactionHex: fundingTransactionHex,
      submission,
      ...(params.onProgress === undefined ? {} : { onProgress: params.onProgress }),
    });
    if (resumed.state === "blocked") throw new Error(resumed.message);
    if (resumed.state === "rebuildable") {
      if (params.onFundingRebuild === undefined) throw new Error("The saved listing transaction can be rebuilt. Resume it through the listing's saved checkpoint.");
      await params.onFundingRebuild(fundingContentHash);
      fundingContentHash = undefined;
      fundingTransactionHex = undefined;
    } else {
      fundingContentHash = resumed.contentHash;
      queued = resumed.queued === true;
    }
  }
  if (fundingContentHash === undefined) {
    await beforeSubmit();
    const validUntilTimestamp = offerFundingValidUntil(offer.terms.deadlineT);
    const to = contractExtendedCode(offer, contractWallet);
    await preflightFunding(params, runtime, { to, openFeeAmount: params.fundingOpenFeeAmount, validUntilTimestamp,
      ...(params.privateRelayFeeAmount === undefined ? {} : { privateRelayFeeAmount: params.privateRelayFeeAmount }) });
    params.assertActive?.();
    params.onProgress?.("preparing", "Preparing your listing. Approve the payment when your wallet asks.");
    const checkpointFunding = async (contentHash: string, transactionHex: Hex) => {
      if (fundingContentHash !== undefined) return;
      fundingContentHash = contentHash; fundingTransactionHex = transactionHex;
      await params.onCheckpoint?.({ fundingContentHash: contentHash, fundingTransactionHex: transactionHex });
    };
    const funding = await fundEscrow(params, runtime, target, {
      node, to, openFeeAmount: params.fundingOpenFeeAmount, validUntilTimestamp,
      ...(params.privateRelayFeeAmount === undefined ? {} : { privateRelayFeeAmount: params.privateRelayFeeAmount }),
      ...(params.selectedRelayQuote === undefined ? {} : { selectedRelayQuote: params.selectedRelayQuote }),
      submission: {
        ...submission,
        preflight: async context => {
          await beforeSubmit();
          const identity = transactionIdentity(context.transactionBytes);
          await checkpointFunding(identity.contentHash, identity.transactionHex as Hex);
          return submission.preflight(context);
        },
      },
      beforeSubmit,
      // A wallet may recognize an existing journal without running preflight.
      onPreparedContentHash: checkpointFunding,
    });
    fundingContentHash = funding.contentHash;
    queued = funding.queued;
  }
  if (!direct && queued) await params.relay?.(fundingContentHash);
  params.onProgress?.("confirming", "Waiting for your listing to be confirmed…");
  const receipt = await runtime.awaitAcceptedReceipt(node, fundingContentHash, {
    onWait: () => params.onProgress?.("confirming", "Waiting for escrow funding. Your listing will publish automatically next."),
    ...(params.pollIntervalMs === undefined ? {} : { pollIntervalMs: params.pollIntervalMs }),
    ...(params.pollMaxAttempts === undefined ? {} : { pollMaxAttempts: params.pollMaxAttempts }),
  });
  requireReceiptKind(receipt, "privateValue", fundingContentHash);
  await params.onCheckpoint?.({ fundingContentHash,
    ...(fundingTransactionHex === undefined ? {} : { fundingTransactionHex }),
    fundingAcceptedBlock: receipt.inclusion.l1BlockNumber.toString(), fundingAcceptedBlockHash: receipt.inclusion.l1BlockHash });
  return recoverEscrow(params, runtime, node, target, receipt);
}

/** The escrow contract's receive identity and, for a token offer, the escrow note's derived secret. */
interface EscrowTarget {
  contractWallet: WalletProfileWithReceiveKeys;
  tokenNoteSecret?: bigint;
}

async function recoverEscrow(
  params: PublishOfferParams,
  runtime: PublishOfferRuntime,
  node: PcashNodeClient,
  target: EscrowTarget,
  fundingReceipt: ReceiptResult,
): Promise<EscrowOpening> {
  const offer = params.offer;
  if (fundingReceipt.outputLeafStart === null) {
    throw new Error(`accepted funding transaction ${fundingReceipt.transactionId} has no outputLeafStart`);
  }
  params.onProgress?.("preparing", "Funding confirmed. Checking the escrow before publishing your listing…");
  if (target.tokenNoteSecret !== undefined) {
    return runtime.recoverTokenEscrow(node, fundingReceipt, {
      owner: offer.l2ContractAddress,
      assetId: offer.terms.assetId,
      amount: offer.terms.amount,
      noteSecret: target.tokenNoteSecret,
    });
  }
  const report = await runtime.scanWallet(node, target.contractWallet, offer.chainId);
  const escrow = report.recovered.find((note) =>
    note.outputIndex === 0 &&
    note.leafIndex === fundingReceipt.outputLeafStart &&
    note.owner === offer.l2ContractAddress &&
    note.assetId === 0n &&
    note.amount === offer.terms.amount
  );
  if (escrow === undefined) {
    throw new Error(
      `smart contract did not recover the ${offer.terms.amount} PCASH escrow at funding leaf ${fundingReceipt.outputLeafStart}`,
    );
  }
  if (escrow.leafIndex > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("escrow leaf index exceeds the browser's safe integer range");
  }

  return {
    leafIndex: Number(escrow.leafIndex),
    noteSecret: fieldToHex(escrow.noteSecret),
    amount: fieldToHex(escrow.amount),
  };
}

function contractExtendedCode(offer: PublishableOffer, contractWallet: WalletProfileWithReceiveKeys): string {
  return buildExtendedCode({ chainId: offer.chainId, address: offer.l2ContractAddress,
    mlKemPublicKey: contractWallet.mlKemPublicKey });
}

interface EscrowFundingRequest {
  openFeeAmount: bigint;
  privateRelayFeeAmount?: bigint;
  to: string;
  validUntilTimestamp: bigint;
}

/** Fail before creating anything when this wallet cannot fund the escrow and fees. */
async function preflightFunding(
  params: PublishOfferParams,
  runtime: PublishOfferRuntime,
  request: EscrowFundingRequest,
): Promise<void> {
  const { offer, selectedRelayQuote } = params;
  if (offer.terms.assetId !== 0n) {
    await runtime.preflightTokenEscrowFunding({
      wallet: params.wallet,
      accountCreation: { kind: "contract", body: offer.l2ContractBody },
      assetId: offer.terms.assetId,
      amount: offer.terms.amount,
      ...request,
      ...(selectedRelayQuote === undefined ? {} : { selectedRelayQuote }),
    });
    return;
  }
  await runtime.preflightNoteFundedTransfer({
    wallet: params.wallet,
    accountCreation: { kind: "contract", body: offer.l2ContractBody },
    amount: offer.terms.amount,
    ...request,
    ...(selectedRelayQuote === undefined ? {} : { selectedRelayQuote }),
  });
}

/** Fund the escrow: a native transfer to the contract, or a token note opened to it under a derived secret. */
async function fundEscrow(
  params: PublishOfferParams,
  runtime: PublishOfferRuntime,
  target: EscrowTarget,
  request: EscrowFundingRequest & {
    node: PcashNodeClient;
    selectedRelayQuote?: SelectedRelayQuoteProvider;
    submission?: DurableSubmissionAdapter;
    beforeSubmit: (contentHash: string, transactionHex: Hex) => Promise<void>;
    onPreparedContentHash: (contentHash: string, transactionHex: Hex) => Promise<void>;
  },
): Promise<{ contentHash: string; queued: boolean }> {
  const { offer } = params;
  if (target.tokenNoteSecret !== undefined) {
    return runtime.runTokenEscrowFundingFlow({
      wallet: params.wallet,
      accountCreation: { kind: "contract", body: offer.l2ContractBody },
      assetId: offer.terms.assetId,
      amount: offer.terms.amount,
      noteSecret: target.tokenNoteSecret,
      data: { self: [sellerRecord(offer)] },
      ...request,
      ...(params.onProgress === undefined ? {} : { onProgress: params.onProgress }),
    });
  }
  return runtime.runNoteFundedTransferFlow({
    wallet: params.wallet,
    accountCreation: { kind: "contract", body: offer.l2ContractBody },
    amount: offer.terms.amount,
    data: { self: [sellerRecord(offer)] },
    ...request,
    ...(params.onProgress === undefined ? {} : { onProgress: params.onProgress }),
  });
}
