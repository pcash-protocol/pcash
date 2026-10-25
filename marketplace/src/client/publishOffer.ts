import { sellerRecord } from "./sellerRecovery.ts";
// Seller publication keeps exact creation and funding bytes durable. Fast posts
// them together; Slow waits for relayers. Canonical receipts gate publication.

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
  deferSubmission,
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
import { submitBuiltTransaction, createMarketplaceTransactionSubmitter } from "./submitBuiltTransaction.ts";
import { runSponsoredContractCreationFlow } from "./contractCreation.ts";
import type { ProvePhase } from "@pcash/sdk/browser-prover";
import { MIN_CLAIM_WINDOW_SECONDS } from "../commitments.mts";
import { restoreMarketplaceTransactionToMempool } from "./mempoolSubmission.ts";
import { buildExtendedCode } from "@pcash/sdk/delivery";
import { batchEntryCarrying } from "@pcash/sdk/relay";
import { fromHex } from "@pcash/sdk/utils";
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
  l2ContractContentHash?: string;
  l2ContractTransactionHex?: Hex;
  fundingContentHash?: string;
  fundingTransactionHex?: Hex;
}

export interface PublishOfferCheckpoint {
  l2ContractContentHash: string;
  l2ContractTransactionHex?: Hex;
  l2ContractAcceptedBlock?: string;
  l2ContractAcceptedBlockHash?: string;
  fundingContentHash?: string;
  fundingTransactionHex?: Hex;
  fundingAcceptedBlock?: string;
  fundingAcceptedBlockHash?: string;
}

export type OfferPublicationFinality =
  | { phase: "missing" | "skipped" | "conflicted" }
  | { phase: "accepted" | "finalized"; receipt: ReceiptResult };

export interface PublishOfferParams {
  /** Direct publication prepares creation and funding for one Ethereum batch. */
  submission?: DurableSubmissionAdapter;
  assertActive?: () => void;
  wallet: Wallet;
  offer: PublishableOffer;
  /** Open PCASH fee paid to whichever relayer includes the contract creation. */
  creationOpenFeeAmount: bigint;
  /** Open PCASH fee paid to whichever relayer includes the escrow funding. */
  fundingOpenFeeAmount: bigint;
  privateRelayFeeAmount?: bigint;
  selectedRelayQuote?: SelectedRelayQuoteProvider;
  /** Latest timestamp from the selected L1 RPC, used to fail closed around T. */
  readL1Timestamp: (node: PcashNodeClient) => Promise<bigint>;
  resume?: PublishOfferResume;
  /** Persist this before allowing the flow to advance to its next network wait. */
  onCheckpoint?: (checkpoint: PublishOfferCheckpoint) => void | Promise<void>;
  onProgress?: (phase: ProvePhase, message: string) => void;
  /** Relay each dependent transaction before waiting for its canonical receipt. */
  relay?: (contentHash: string) => Promise<void>;
  pollIntervalMs?: number;
  pollMaxAttempts?: number;
}

/** Injectable only so the orchestration can be tested without a node or Wallet transfer. */
export interface PublishOfferRuntime {
  submitBuiltTransaction: typeof submitBuiltTransaction;
  awaitAcceptedReceipt: typeof awaitAcceptedReceipt;
  preflightNoteFundedTransfer: typeof preflightNoteFundedTransfer;
  runNoteFundedTransferFlow: typeof runNoteFundedTransferFlow;
  runSponsoredContractCreationFlow: typeof runSponsoredContractCreationFlow;
  preflightTokenEscrowFunding: typeof preflightTokenEscrowFunding;
  runTokenEscrowFundingFlow: typeof runTokenEscrowFundingFlow;
  scanWallet: typeof scanWallet;
  recoverTokenEscrow: typeof recoverTokenEscrow;
}

const DEFAULT_RUNTIME: PublishOfferRuntime = {
  submitBuiltTransaction,
  awaitAcceptedReceipt,
  preflightNoteFundedTransfer,
  runNoteFundedTransferFlow,
  runSponsoredContractCreationFlow,
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
  expectedKind: "contractAccount" | "privateValue",
): Promise<OfferPublicationFinality> {
  const receipt = await pollReceipt(node, contentHash);
  if (receipt === null) return { phase: "missing" };
  if (receipt.outcome !== "succeeded") return { phase: await inputSpentAtFinality(node, receipt) ? "conflicted" : "skipped" };
  requireReceiptKind(receipt, expectedKind, contentHash);
  const status = await node.status();
  return {
    phase: isFinalized(receipt.inclusion.l1BlockNumber, status) ? "finalized" : "accepted",
    receipt,
  };
}

/**
 * Whether another transaction's spend of a skipped transaction's input is
 * finalized, so these exact bytes can never be accepted.
 */
async function inputSpentAtFinality(node: PcashNodeClient, skipped: ReceiptResult): Promise<boolean> {
  if (skipped.failureDetail?.type !== "nullifierAlreadySpent") return false;
  // Status first: a spend at or below a finalized height already observed cannot be reorged out.
  const status = await node.status();
  const spender = await node.getReceipt(skipped.failureDetail.spendingTransactionId);
  return spender.some((receipt) => receipt.outcome === "succeeded"
    && receipt.contentHash.toLowerCase() !== skipped.contentHash.toLowerCase()
    && isFinalized(receipt.inclusion.l1BlockNumber, status));
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
  if (!wallet.spendable()) {
    throw new Error("offer publication requires a spendable wallet");
  }
  const node = wallet.node;
  const sellerProfile = wallet.profile;
  const { offer } = params;
  if (wallet.network.chainId !== offer.chainId) {
    throw new Error(`offer chain ${offer.chainId} does not match wallet chain ${wallet.network.chainId}`);
  }
  if (offer.terms.amount <= 0n) throw new Error("offer amount must be positive");
  // The caller supplies these fees on top of the escrow amount, from seller funds.
  if (params.creationOpenFeeAmount < 0n || params.fundingOpenFeeAmount < 0n) {
    throw new Error("marketplace relayer fee must be nonnegative");
  }
  const selectedRelayQuote = params.selectedRelayQuote;
  if (wallet.submission?.mode !== "l1" && params.privateRelayFeeAmount !== undefined && selectedRelayQuote === undefined
    && (params.resume?.l2ContractContentHash === undefined || params.resume?.fundingContentHash === undefined)) {
    throw new Error("selected listing requires its authenticated relayer session");
  }
  const fundingValidUntil = offerFundingValidUntil(offer.terms.deadlineT);

  const priorL2ContractContentHash = params.resume?.l2ContractContentHash;
  const priorFundingContentHash = params.resume?.fundingContentHash;
  requireContentHash(priorL2ContractContentHash, "resume.l2ContractContentHash");
  requireContentHash(priorFundingContentHash, "resume.fundingContentHash");
  if (priorFundingContentHash !== undefined && priorL2ContractContentHash === undefined) {
    throw new Error("resuming a funding transaction requires its smart contract content hash");
  }

  // Do this before either submission: a wrong seller key can never recover the
  // escrow opening and must not create an orphan smart contract account or funded note.
  const l2ContractWallet = reconstructL2ContractWallet(offer, sellerProfile);
  const target: EscrowTarget = {
    contractWallet: l2ContractWallet,
    ...(offer.terms.assetId === 0n ? {} : {
      tokenNoteSecret: deriveTokenEscrowNoteSecret({
        seller: sellerProfile,
        chainId: offer.chainId,
        offerId: offer.terms.id,
        contractAddress: offer.l2ContractAddress,
      }),
    }),
  };

  if (params.submission?.mode === "l1") {
    return publishFastOffer(params, runtime, node, target);
  }

  if (priorFundingContentHash === undefined) await requirePublicationWindow(params, node);
  // Budget both fees before creating anything. On resume, the registration may
  // still reserve the seller's only note: relay it first, then sync its change
  // before the funding flow selects inputs.
  if (priorL2ContractContentHash === undefined) {
    await preflightFunding(params, runtime, {
      openFeeAmount: params.creationOpenFeeAmount + params.fundingOpenFeeAmount,
      ...(params.privateRelayFeeAmount === undefined ? {} : { privateRelayFeeAmount: 2n * params.privateRelayFeeAmount }),
      to: addressHex(offer.l2ContractAddress),
      validUntilTimestamp: fundingValidUntil,
    });
  }

  let l2ContractContentHash = priorL2ContractContentHash;
  let l2ContractTransactionHex = params.resume?.l2ContractTransactionHex;
  let contractQueued = priorL2ContractContentHash !== undefined;
  if (l2ContractContentHash === undefined) {
    params.assertActive?.();
    // Every creation carries a fee section, so the seller sponsors it from its
    // own notes. A creation takes the wallet's configured publication path; on
    // the mempool path a zero fee is refused, since no publisher is paid.
    params.onProgress?.("preparing", "Preparing your listing. Approve the signature when your wallet asks.");
    const sponsored = await runtime.runSponsoredContractCreationFlow({
      wallet: params.wallet,
      node,
      contract: { body: offer.l2ContractBody, address: offer.l2ContractAddress },
      openFeeAmount: params.creationOpenFeeAmount,
      ...(params.privateRelayFeeAmount === undefined ? {} : { privateRelayFeeAmount: params.privateRelayFeeAmount }),
      ...(selectedRelayQuote === undefined ? {} : { selectedRelayQuote }),
      ...(params.submission === undefined ? {} : { submission: params.submission }),
      validUntilTimestamp: fundingValidUntil,
      ...(selectedRelayQuote === undefined ? {} : { validUntilMode: "ceiling" as const }),
      onPreparedContentHash: (contentHash, transactionHex) => params.onCheckpoint?.({ l2ContractContentHash: contentHash, l2ContractTransactionHex: transactionHex }),
      ...(params.onProgress !== undefined ? { onProgress: params.onProgress } : {}),
    });
    l2ContractContentHash = sponsored.contentHash;
    l2ContractTransactionHex = sponsored.transactionHex;
    contractQueued = sponsored.queued;
  } else if (l2ContractTransactionHex !== undefined) {
    const submit = createMarketplaceTransactionSubmitter(wallet, runtime.submitBuiltTransaction);
    const restored = await restoreMarketplaceTransactionToMempool({
      node,
      contentHash: l2ContractContentHash,
      transactionHex: l2ContractTransactionHex,
      beforeSubmit: () => requirePublicationWindow(params, node),
      onProgress: params.onProgress,
      submit,
    });
    contractQueued = restored !== "receipt" && submit.publication !== "l1";
  }

  if (contractQueued) await params.relay?.(l2ContractContentHash);
  params.onProgress?.("confirming", "Waiting for your listing creation to be confirmed.");
  const l2ContractReceipt = await runtime.awaitAcceptedReceipt(node, l2ContractContentHash, {
    onWait: () => params.onProgress?.("confirming", "Waiting for your listing creation to be confirmed. Escrow funding starts automatically next."),
    ...(params.pollIntervalMs !== undefined ? { pollIntervalMs: params.pollIntervalMs } : {}),
    ...(params.pollMaxAttempts !== undefined ? { pollMaxAttempts: params.pollMaxAttempts } : {}),
  });
  requireReceiptKind(l2ContractReceipt, "contractAccount", l2ContractContentHash);
  await params.onCheckpoint?.({
    l2ContractContentHash,
    ...(l2ContractTransactionHex !== undefined ? { l2ContractTransactionHex } : {}),
    l2ContractAcceptedBlock: l2ContractReceipt.inclusion.l1BlockNumber.toString(),
    l2ContractAcceptedBlockHash: l2ContractReceipt.inclusion.l1BlockHash,
  });

  let fundingContentHash = priorFundingContentHash;
  let fundingTransactionHex = params.resume?.fundingTransactionHex;
  let fundingQueued = priorFundingContentHash !== undefined;
  if (fundingContentHash === undefined) {
    params.assertActive?.();
    // The creation fee can consume the seller's only note. Scan its accepted
    // change before selecting the notes that will fund this listing.
    params.onProgress?.("preparing", "Updating your wallet balance before funding escrow…");
    await params.wallet.sync();
    await requirePublicationWindow(params, node);
    params.assertActive?.();
    const prepared: { transactionHex?: Hex } = {};
    params.onProgress?.("preparing", "Preparing the transfer to escrow. Approve the signature when your wallet asks.");
    const funding = await fundEscrow(params, runtime, target, {
      node,
      to: offer.terms.assetId === 0n ? addressHex(offer.l2ContractAddress) : contractExtendedCode(offer, l2ContractWallet),
      openFeeAmount: params.fundingOpenFeeAmount,
      ...(params.privateRelayFeeAmount === undefined ? {} : { privateRelayFeeAmount: params.privateRelayFeeAmount }),
      ...(selectedRelayQuote === undefined ? {} : { selectedRelayQuote }),
      ...(params.submission === undefined ? {} : { submission: params.submission }),
      validUntilTimestamp: fundingValidUntil,
      beforeSubmit: () => requirePublicationWindow(params, node),
      onPreparedContentHash: async (contentHash, transactionHex) => {
        prepared.transactionHex = transactionHex;
        await params.onCheckpoint?.({
          l2ContractContentHash,
          ...(l2ContractTransactionHex !== undefined ? { l2ContractTransactionHex } : {}),
          l2ContractAcceptedBlock: l2ContractReceipt.inclusion.l1BlockNumber.toString(),
          l2ContractAcceptedBlockHash: l2ContractReceipt.inclusion.l1BlockHash,
          fundingContentHash: contentHash,
          fundingTransactionHex: transactionHex,
        });
      },
      ...(params.onProgress !== undefined ? { onProgress: params.onProgress } : {}),
    });
    fundingContentHash = funding.contentHash;
    fundingTransactionHex = prepared.transactionHex;
    fundingQueued = funding.queued;
  } else if (fundingTransactionHex !== undefined) {
    const submit = createMarketplaceTransactionSubmitter(wallet, runtime.submitBuiltTransaction);
    const restored = await restoreMarketplaceTransactionToMempool({
      node,
      contentHash: fundingContentHash,
      transactionHex: fundingTransactionHex,
      beforeSubmit: () => requirePublicationWindow(params, node),
      onProgress: params.onProgress,
      submit,
    });
    fundingQueued = restored !== "receipt" && submit.publication !== "l1";
  }

  if (fundingQueued) await params.relay?.(fundingContentHash);
  params.onProgress?.("confirming", "Waiting for your escrow funding to be confirmed.");
  const fundingReceipt = await runtime.awaitAcceptedReceipt(node, fundingContentHash, {
    onWait: () => params.onProgress?.("confirming", "Waiting for your escrow funding to be confirmed. Your listing will publish automatically next."),
    ...(params.pollIntervalMs !== undefined ? { pollIntervalMs: params.pollIntervalMs } : {}),
    ...(params.pollMaxAttempts !== undefined ? { pollMaxAttempts: params.pollMaxAttempts } : {}),
  });
  requireReceiptKind(fundingReceipt, "privateValue", fundingContentHash);
  await params.onCheckpoint?.({
    l2ContractContentHash,
    ...(l2ContractTransactionHex !== undefined ? { l2ContractTransactionHex } : {}),
    l2ContractAcceptedBlock: l2ContractReceipt.inclusion.l1BlockNumber.toString(),
    l2ContractAcceptedBlockHash: l2ContractReceipt.inclusion.l1BlockHash,
    fundingContentHash,
    ...(fundingTransactionHex !== undefined ? { fundingTransactionHex } : {}),
    fundingAcceptedBlock: fundingReceipt.inclusion.l1BlockNumber.toString(),
    fundingAcceptedBlockHash: fundingReceipt.inclusion.l1BlockHash,
  });

  return recoverEscrow(params, runtime, node, target, fundingReceipt);
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
      assetId: offer.terms.assetId,
      amount: offer.terms.amount,
      ...request,
      ...(selectedRelayQuote === undefined ? {} : { selectedRelayQuote }),
    });
    return;
  }
  await runtime.preflightNoteFundedTransfer({
    wallet: params.wallet,
    amount: offer.terms.amount,
    ...request,
    ...(selectedRelayQuote === undefined ? {} : { selectedRelayQuote }),
    issuanceOwnerCommitment: 0n,
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
    beforeSubmit: () => Promise<void>;
    onPreparedContentHash: (contentHash: string, transactionHex: Hex) => Promise<void>;
  },
): Promise<{ contentHash: string; queued: boolean }> {
  const { offer } = params;
  if (target.tokenNoteSecret !== undefined) {
    return runtime.runTokenEscrowFundingFlow({
      wallet: params.wallet,
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
    amount: offer.terms.amount,
    issuanceOwnerCommitment: 0n,
    data: { self: [sellerRecord(offer)] },
    ...request,
    ...(params.onProgress === undefined ? {} : { onProgress: params.onProgress }),
  });
}

/** Both transactions use existing notes: creation spends no value and funding uses
 * the contract's committed receive key without waiting for registration. */
async function publishFastOffer(
  params: PublishOfferParams,
  runtime: PublishOfferRuntime,
  node: PcashNodeClient,
  target: EscrowTarget,
): Promise<EscrowOpening> {
  const submission = params.submission!;
  const prepared = { ...params.resume };
  const checkpoint = () => params.onCheckpoint?.({
    l2ContractContentHash: prepared.l2ContractContentHash!,
    ...(prepared.l2ContractTransactionHex ? { l2ContractTransactionHex: prepared.l2ContractTransactionHex } : {}),
    ...(prepared.fundingContentHash ? { fundingContentHash: prepared.fundingContentHash } : {}),
    ...(prepared.fundingTransactionHex ? { fundingTransactionHex: prepared.fundingTransactionHex } : {}),
  });
  const to = contractExtendedCode(params.offer, target.contractWallet);
  const validUntilTimestamp = offerFundingValidUntil(params.offer.terms.deadlineT);
  if (!prepared.fundingContentHash) {
    params.assertActive?.();
    await requirePublicationWindow(params, node);
    await preflightFunding(params, runtime, { to, openFeeAmount: params.fundingOpenFeeAmount, validUntilTimestamp });
  }
  if (!prepared.l2ContractContentHash) {
    params.assertActive?.();
    params.onProgress?.("preparing", "Preparing your listing. Approve the listing authorization in your wallet.");
    await runtime.runSponsoredContractCreationFlow({ wallet: params.wallet, node,
      submission: deferSubmission(submission),
      contract: { body: params.offer.l2ContractBody, address: params.offer.l2ContractAddress },
      openFeeAmount: 0n, validUntilTimestamp,
      onPreparedContentHash: async (contentHash, transactionHex) => {
        prepared.l2ContractContentHash = contentHash; prepared.l2ContractTransactionHex = transactionHex;
        await checkpoint();
      },
      ...(params.onProgress ? { onProgress: params.onProgress } : {}),
    });
  }
  if (!prepared.fundingContentHash) {
    params.assertActive?.();
    await fundEscrow(params, runtime, target, { node, to,
      submission: deferSubmission(submission),
      openFeeAmount: params.fundingOpenFeeAmount, validUntilTimestamp,
      beforeSubmit: () => requirePublicationWindow(params, node),
      onPreparedContentHash: async (contentHash, transactionHex) => {
        prepared.fundingContentHash = contentHash; prepared.fundingTransactionHex = transactionHex;
        await checkpoint();
      },
    });
  }
  // Ethereum batches are not atomic. Reconcile each item independently and
  // retain both identities before asking for the single Ethereum approval.
  const entries = [
    { contentHash: prepared.l2ContractContentHash!, transactionHex: prepared.l2ContractTransactionHex, kind: "contractAccount" },
    { contentHash: prepared.fundingContentHash!, transactionHex: prepared.fundingTransactionHex, kind: "privateValue" },
  ] as const;
  const missing = [];
  for (const entry of entries) {
    const receipt = await pollReceipt(node, entry.contentHash);
    if (receipt?.outcome !== "succeeded") missing.push({ ...entry, entry: fromHex(entry.transactionHex!) });
  }
  if (missing.length) {
    params.assertActive?.();
    await requirePublicationWindow(params, node);
    const recovery = await submission.l1Recovery?.();
    const reconciliation = await recovery?.reconcile();
    if (reconciliation?.latched) {
      const inFlight = (await recovery!.show()).entries;
      const carrying = batchEntryCarrying(inFlight, missing[0]!.contentHash);
      if (!carrying?.transactionHash || !missing.every((entry) => batchEntryCarrying(inFlight, entry.contentHash) === carrying)) {
        throw new Error("An earlier Ethereum submission needs attention. Check its outcome before continuing this listing.");
      }
      params.onProgress?.("confirming", "Your listing is on its way. Waiting for Ethereum confirmation…");
    } else {
      const first = missing[0]!;
      const status = await node.status();
      const batch = await submission.preflight({ transactionBytes: first.entry, status,
        additionalTransactions: missing.slice(1).map((entry) => entry.entry), retry: params.resume !== undefined });
      params.assertActive?.();
      params.onProgress?.("submitting", "Approve one Ethereum transaction to publish your listing. Gas is paid in ETH.");
      await submission.submit({ transactionBytes: first.entry, status,
        prepared: batch, retry: params.resume !== undefined });
    }
  }
  params.onProgress?.("confirming", "Waiting for your listing to be confirmed…");
  const receipts = [];
  for (const entry of entries) {
    const receipt = await runtime.awaitAcceptedReceipt(node, entry.contentHash, {
      ...(params.pollIntervalMs === undefined ? {} : { pollIntervalMs: params.pollIntervalMs }),
      ...(params.pollMaxAttempts === undefined ? {} : { pollMaxAttempts: params.pollMaxAttempts }),
    });
    requireReceiptKind(receipt, entry.kind, entry.contentHash);
    receipts.push(receipt);
  }
  const [contractReceipt, fundingReceipt] = receipts as [ReceiptResult, ReceiptResult];
  await params.onCheckpoint?.({ l2ContractContentHash: prepared.l2ContractContentHash!,
    ...(prepared.l2ContractTransactionHex ? { l2ContractTransactionHex: prepared.l2ContractTransactionHex } : {}),
    fundingContentHash: prepared.fundingContentHash!,
    ...(prepared.fundingTransactionHex ? { fundingTransactionHex: prepared.fundingTransactionHex } : {}),
    l2ContractAcceptedBlock: contractReceipt.inclusion.l1BlockNumber.toString(), l2ContractAcceptedBlockHash: contractReceipt.inclusion.l1BlockHash,
    fundingAcceptedBlock: fundingReceipt.inclusion.l1BlockNumber.toString(), fundingAcceptedBlockHash: fundingReceipt.inclusion.l1BlockHash });
  return recoverEscrow(params, runtime, node, target, fundingReceipt);
}
