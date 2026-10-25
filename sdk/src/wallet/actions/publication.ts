// Public publication bounty, private selected-relay payment, and issuance
// destination are fixed before note selection and proving.

import { verifySelectedRelayQuote, type SelectedRelayQuote, type SelectedRelayQuoteProvider } from "@pcash/sdk/eip712";
import { samePcashIdentity, statusPcashIdentity, type SystemPayoutResult, type IssuanceRoute, type FeeEstimateResult, type PcashNodeClient, type StatusResult } from "@pcash/sdk/clients";
import {
  issuancePayoutOpening,
  dummyNullifier,
  networkConfigFromStatus,
  noteNk,
  nullifier,
  payoutSeed,
  payoutTransactionContext,
  privateValueTransactionSize,
  recoverPayoutOpening,
  type DesignatedIssuanceOpening,
} from "@pcash/sdk/protocol";
import { BATCH_HEADER_BYTES, ITEM_LENGTH_PREFIX_BYTES, MAX_BROWSER_RELAY_BATCH_BYTES, MAX_RELAY_CONTENT_HASHES, RelayValidationError } from "@pcash/sdk/relay";
import { addressHex, randomFieldEntropy } from "@pcash/sdk/utils";
import type { FieldNumberish } from "@pcash/sdk/crypto";
import { AMOUNT_BITS, PRIVATE_VALUE_PROFILES, type PrivateValueShape } from "@pcash/sdk/constants";
import type { DurableSubmissionAdapter } from "./durableSubmission.ts";

/** Default public open fee when the node cannot estimate one: 0.01 PCASH. */
export const FALLBACK_TRANSACTION_FEE_AMOUNT = 10_000_000_000_000_000n;

export function paddedPrivateValueByteSize(shape: PrivateValueShape): bigint {
  return BigInt(privateValueTransactionSize(shape));
}
export const PADDED_PRIVATE_VALUE_BYTE_SIZE = paddedPrivateValueByteSize(PRIVATE_VALUE_PROFILES.S.shapeId);
export const MAX_MINE_ACTIONS = Math.min(MAX_RELAY_CONTENT_HASHES, Number((MAX_BROWSER_RELAY_BATCH_BYTES - BATCH_HEADER_BYTES) / (PADDED_PRIVATE_VALUE_BYTE_SIZE + ITEM_LENGTH_PREFIX_BYTES)));

/** Open mempool, direct self publication, or a privately paid relayer in the public pool. */
export type PublicationMode = "open" | "self" | "selected";

/** Who receives the action's issuance. */
export type IssuanceBeneficiary =
  | { kind: "none" }
  /** Open route: the poster of the batch whose inclusion succeeds. */
  | { kind: "publisher" }
  /**
   * Eligible self-published actions designate the wallet's one-time issuance
   * commitment even if another poster copies the exact batch.
   */
  | { kind: "self" }
  /** Designated through the recipient's authenticated quote. */
  | { kind: "recipient"; address: string };

export interface PublicationPlan {
  openFeeAmount: bigint;
  privateRelayFeeAmount: bigint;
  publication: PublicationMode;
  beneficiary: IssuanceBeneficiary;
  privateRelayRecipient: string | null;
}

/** Fee and issuance terms recovered from a submitted action's journal. */
export interface ActionPublication {
  issuanceRoute: IssuanceRoute;
  beneficiary: IssuanceBeneficiary;
  openFeeAmount: bigint;
  privateRelayFeeAmount: bigint;
  privateRelayRecipient: string | null;
}

/** Route and fee come from the action's journal, so a replayed action reports what its bytes carry. */
export function actionPublication(
  journal: { openFeeAmount: string | bigint; issuanceOwnerCommitment: string | bigint; privateRelayFeeAmount?: string | bigint; privateRelayRecipient?: string | null },
  beneficiary: IssuanceBeneficiary,
  issuanceEligible = true,
): ActionPublication {
  return {
    issuanceRoute: !issuanceEligible ? "none"
      : BigInt(journal.issuanceOwnerCommitment) === 0n ? "open" : "designated",
    beneficiary: issuanceEligible ? beneficiary : { kind: "none" },
    openFeeAmount: BigInt(journal.openFeeAmount),
    privateRelayFeeAmount: BigInt(journal.privateRelayFeeAmount ?? 0n),
    privateRelayRecipient: journal.privateRelayRecipient ?? null,
  };
}

export function publicationOf(submission: Pick<DurableSubmissionAdapter, "mode">, privateRelayFeeAmount = 0n): PublicationMode {
  return submission.mode === "l1" ? "self" : privateRelayFeeAmount > 0n ? "selected" : "open";
}

/** Fix a transaction deadline before requesting a selected relayer quote. */
export function publicationValidUntil(params: {
  chainNow: bigint;
  defaultWindow: bigint;
  selectedRelayQuote?: SelectedRelayQuoteProvider | undefined;
  requested?: bigint | undefined;
  requestedMode?: "exact" | "ceiling" | undefined;
  action: string;
}): bigint {
  const lifetime = params.selectedRelayQuote?.maxQuoteLifetimeSeconds;
  if (lifetime !== undefined && lifetime <= 0n) {
    throw new Error("selected relayer advertised an invalid maximum quote lifetime");
  }
  const window = lifetime !== undefined && lifetime < params.defaultWindow ? lifetime : params.defaultWindow;
  const normal = params.chainNow + window;
  if (params.requested === undefined) return normal;
  if (params.requested <= params.chainNow) {
    throw new Error(`${params.action} validity must be later than the latest PCASH block timestamp`);
  }
  if (params.requestedMode === "ceiling") return params.requested < normal ? params.requested : normal;
  if (lifetime !== undefined && params.requested > params.chainNow + lifetime) {
    throw new Error(`exact ${params.action} deadline exceeds the selected relayer's advertised maximum quote lifetime`);
  }
  return params.requested;
}

export function issuanceBeneficiary(params: {
  publication: PublicationMode;
  selectedRelayQuote?: SelectedRelayQuoteProvider | undefined;
}): IssuanceBeneficiary {
  if (params.selectedRelayQuote !== undefined) return { kind: "recipient", address: addressHex(params.selectedRelayQuote.recipient) };
  return params.publication === "self" ? { kind: "self" } : { kind: "publisher" };
}

/** Who a journaled action's bytes pay: its saved designated recipient, which may be this wallet, else the open route's publisher. */
export function pendingIssuanceBeneficiary(
  pending: { issuanceRecipient?: string | null },
  wallet: { address: bigint },
): IssuanceBeneficiary {
  const recipient = pending.issuanceRecipient;
  if (recipient === null || recipient === undefined) return { kind: "publisher" };
  return BigInt(recipient) === wallet.address ? { kind: "self" } : { kind: "recipient", address: recipient };
}

/**
 * Whether this wallet's seed opens a system payout note, through its designated
 * issuance commitment or its poster commitment in an open-route batch.
 */
export function controlsSystemPayout(
  wallet: { address: FieldNumberish; nkRoot: FieldNumberish },
  payout: Pick<SystemPayoutResult, "source" | "ownerCommitment" | "contexts">,
): boolean {
  return recoverPayoutOpening(
    { owner: wallet.address, seed: payoutSeed(wallet.nkRoot) },
    { sourceKind: payout.source.kind, ownerCommitment: payout.ownerCommitment, contexts: payout.contexts },
  ) !== null;
}

type FeeEstimator = Pick<PcashNodeClient, "estimateFee">;

/** The node's standard-tier public open-fee estimate for the planned encoded size, else the fallback. */
export async function estimatedTransactionFee(byteSize: bigint, node: FeeEstimator | undefined): Promise<bigint> {
  if (node === undefined) return FALLBACK_TRANSACTION_FEE_AMOUNT;
  let estimate: FeeEstimateResult;
  try {
    estimate = await node.estimateFee({ byteSize });
  } catch {
    return FALLBACK_TRANSACTION_FEE_AMOUNT;
  }
  const standard = estimate.tiers.standard;
  return standard > 0n ? standard : FALLBACK_TRANSACTION_FEE_AMOUNT;
}

export interface PublicationPlanParams {
  /** A type 0x00 private-value action, which earns issuance for its selected destination. */
  qualifying: boolean;
  /** Encoded size used to size the default fee; null when the action has no fee inputs and so carries no fee. */
  byteSize: bigint | null;
  /** The caller's fee, used as given, including zero. Absent selects the default. */
  openFeeAmount?: bigint | undefined;
  privateRelayFeeAmount?: bigint | undefined;
  publication: PublicationMode;
  selectedRelayQuote?: SelectedRelayQuoteProvider | undefined;
  node: Pick<PcashNodeClient, "estimateFee">;
}

/** Resolve the ordinary fee before funding; explicit caller fees are authoritative. */
export async function planPublication(params: PublicationPlanParams): Promise<PublicationPlan> {
  const beneficiary = params.qualifying ? issuanceBeneficiary(params) : { kind: "none" } as const;
  const privateRelayRecipient = params.selectedRelayQuote === undefined ? null : addressHex(params.selectedRelayQuote.recipient);
  if ((params.publication === "selected") !== (params.selectedRelayQuote !== undefined)) {
    throw new RelayValidationError("selected publication requires exactly one authenticated relayer quote provider");
  }
  if (params.publication !== "selected" && params.privateRelayFeeAmount !== undefined) {
    throw new RelayValidationError("private relay fee requires selected publication");
  }
  if (params.openFeeAmount !== undefined && (params.openFeeAmount < 0n || params.openFeeAmount >= 1n << BigInt(AMOUNT_BITS))) {
    throw new Error(`transaction fee must fit in the nonnegative ${AMOUNT_BITS}-bit amount range`);
  }
  if (params.privateRelayFeeAmount !== undefined
    && (params.privateRelayFeeAmount < 0n || params.privateRelayFeeAmount >= 1n << BigInt(AMOUNT_BITS))) {
    throw new Error(`private relay fee must fit in the nonnegative ${AMOUNT_BITS}-bit amount range`);
  }
  if (params.selectedRelayQuote !== undefined && params.openFeeAmount !== undefined && params.openFeeAmount !== 0n) {
    throw new RelayValidationError("selected relay has no public open fee");
  }
  if (params.selectedRelayQuote !== undefined && (params.privateRelayFeeAmount === undefined || params.privateRelayFeeAmount <= 0n)) {
    throw new RelayValidationError("selected relay requires a positive private relay fee");
  }
  if (params.publication === "self" && (params.openFeeAmount !== undefined && params.openFeeAmount !== 0n || params.privateRelayFeeAmount !== undefined)) {
    throw new RelayValidationError("self-publication has no PCASH network fee");
  }
  if (params.openFeeAmount === 0n && !params.qualifying && params.publication === "open") {
    throw new RelayValidationError("a relayed account operation with a zero fee pays no publisher; pass a positive fee or publish it yourself");
  }
  const openFeeAmount = params.selectedRelayQuote !== undefined || params.publication === "self" ? 0n
    : params.openFeeAmount ?? (params.byteSize === null ? 0n : await estimatedTransactionFee(params.byteSize, params.node));
  return { openFeeAmount, privateRelayFeeAmount: params.privateRelayFeeAmount ?? 0n,
    publication: params.publication, beneficiary, privateRelayRecipient };
}

/**
 * Fix a designated destination once the input tuple is known: request the
 * recipient's quote for the transaction context and authenticate it.
 */
async function designatedIssuance(params: {
  provider: SelectedRelayQuoteProvider;
  node: Pick<PcashNodeClient, "status">;
  status: StatusResult;
  nullifiers: readonly bigint[];
  shape: PrivateValueShape;
  privateRelayFeeAmount: bigint;
  maxTransactionBytes: bigint;
  issuanceEligible: boolean;
  validUntilTimestamp: bigint;
  /** Called with the fresh status read after the quote, before trusting it. */
  assertStatus?: (current: StatusResult) => void;
}): Promise<{ issuanceOwnerCommitment: bigint; designatedIssuanceOpening?: DesignatedIssuanceOpening; privateRelayPayment: { recipientAddress: bigint; receiveKey: Uint8Array; amount: bigint }; selectedQuote: SelectedRelayQuote }> {
  const pcashChainId = BigInt(params.status.pcashChainId);
  const transactionContext = payoutTransactionContext(pcashChainId, params.nullifiers, params.shape);
  const quoteBinding = randomFieldEntropy();
  const quote = await params.provider.requestQuote({
    pcashChainId, recipient: params.provider.recipient, privateFeeAmount: params.privateRelayFeeAmount,
    transactionContext, quoteBinding, issuanceEligible: params.issuanceEligible,
    maxTransactionBytes: params.maxTransactionBytes,
    validUntilTimestamp: params.validUntilTimestamp,
  });
  const current = await params.node.status();
  if (!samePcashIdentity(statusPcashIdentity(current), statusPcashIdentity(params.status))) {
    throw new Error("node identity changed during selected relay quotation");
  }
  params.assertStatus?.(current);
  const verified = verifySelectedRelayQuote(networkConfigFromStatus(current), quote, {
    pcashChainId, recipient: params.provider.recipient, privateFeeAmount: params.privateRelayFeeAmount,
    transactionContext, quoteBinding, maxTransactionBytes: params.maxTransactionBytes,
    nowTimestamp: current.latestBlockTimestamp,
  });
  if (!params.issuanceEligible && verified.issuanceOwnerCommitment !== 0n) {
    throw new Error("selected relay quote has the wrong issuance route for this action");
  }
  if (BigInt(quote.validUntilTimestamp) < params.validUntilTimestamp) {
    throw new Error("selected relay quote expires before the transaction deadline");
  }
  return { ...verified, selectedQuote: quote, privateRelayPayment: {
    recipientAddress: params.provider.recipient, receiveKey: verified.receiveKey, amount: verified.privateFeeAmount,
  } };
}

export function noteNullifier(
  nkRoot: FieldNumberish,
  note: { commitment: string | null; noteSecret: string },
): bigint {
  return nullifier(BigInt(note.commitment!), noteNk(nkRoot), BigInt(note.noteSecret));
}

/** The transaction's input nullifiers: each selected note's, then dummies from the entropy its builder uses. */
export function transactionNullifiers(
  nkRoot: FieldNumberish,
  notes: readonly { commitment: string | null; noteSecret: string }[],
  dummyInputEntropy: bigint,
  inputs: number,
): bigint[] {
  return Array.from({ length: inputs }, (_, index) => {
    const note = notes[index];
    return note === undefined ? dummyNullifier(dummyInputEntropy, index)
      : noteNullifier(nkRoot, note);
  });
}

/**
 * The designated destination a self-published action names: this wallet's own
 * issuance commitment for the action's nullifier context, derived from its
 * payout seed exactly as a quoting recipient derives one.
 */
export function ownIssuance(
  owner: { address: bigint; nkRoot: FieldNumberish },
  chainId: FieldNumberish,
  nullifiers: readonly bigint[],
  shape: PrivateValueShape,
): { issuanceOwnerCommitment: bigint; designatedIssuanceOpening: DesignatedIssuanceOpening } {
  const opening = issuancePayoutOpening(owner.address, owner.nkRoot, chainId, nullifiers, shape);
  return {
    issuanceOwnerCommitment: opening.ownerCommitment,
    designatedIssuanceOpening: { recipientAddress: owner.address, noteSecret: opening.noteSecret, transactionContext: opening.context },
  };
}

/**
 * Fix the destination once the nullifiers are known: a named recipient's
 * authenticated quote, else this wallet's own commitment when it publishes the
 * action itself, else the open route. A requested nonzero commitment must be
 * the one fixed.
 */
export async function fixPublication(params: {
  selectedRelayQuote: SelectedRelayQuoteProvider | undefined;
  publication: PublicationMode;
  owner: { address: bigint; nkRoot: FieldNumberish };
  requestedCommitment: bigint;
  node: Pick<PcashNodeClient, "status">;
  status: StatusResult;
  nullifiers: readonly bigint[];
  shape: PrivateValueShape;
  openFeeAmount: bigint;
  privateRelayFeeAmount?: bigint;
  maxTransactionBytes?: bigint;
  issuanceEligible?: boolean;
  validUntilTimestamp: bigint;
  assertStatus?: (current: StatusResult) => void;
}): Promise<{ issuanceOwnerCommitment: bigint; designatedIssuanceOpening?: DesignatedIssuanceOpening; privateRelayPayment?: { recipientAddress: bigint; receiveKey: Uint8Array; amount: bigint }; selectedQuote?: SelectedRelayQuote }> {
  const fixed = params.selectedRelayQuote !== undefined
    ? await designatedIssuance({
      provider: params.selectedRelayQuote, node: params.node, status: params.status, nullifiers: params.nullifiers,
      shape: params.shape, privateRelayFeeAmount: params.privateRelayFeeAmount ?? 0n, validUntilTimestamp: params.validUntilTimestamp,
      maxTransactionBytes: params.maxTransactionBytes ?? paddedPrivateValueByteSize(params.shape),
      issuanceEligible: params.issuanceEligible ?? true,
      ...(params.assertStatus === undefined ? {} : { assertStatus: params.assertStatus }),
    })
    : params.publication === "self" && params.issuanceEligible !== false
      ? ownIssuance(params.owner, params.status.pcashChainId, params.nullifiers, params.shape)
      : { issuanceOwnerCommitment: 0n };
  if (params.requestedCommitment !== 0n && params.requestedCommitment !== fixed.issuanceOwnerCommitment) {
    throw new Error(fixed.issuanceOwnerCommitment === 0n
      ? "a designated issuance destination requires an authenticated recipient quote"
      : "issuance destination differs from the requested commitment");
  }
  return fixed;
}

/** Fix an account operation's four-input tuple, padding with dummy nullifiers, then its destination. */
export async function prepareAccountPublication(params: {
  node: Pick<PcashNodeClient, "status">;
  status: StatusResult;
  owner: { address: bigint; nkRoot: FieldNumberish };
  publication: PublicationMode;
  inputs: readonly { commitment: string | null; noteSecret: string }[];
  openFeeAmount: bigint;
  privateRelayFeeAmount?: bigint;
  maxTransactionBytes?: bigint;
  issuanceOwnerCommitment: bigint;
  validUntilTimestamp: bigint;
  selectedRelayQuote?: SelectedRelayQuoteProvider;
}): Promise<{ issuanceOwnerCommitment: bigint; dummyInputEntropy: bigint; designatedIssuanceOpening?: DesignatedIssuanceOpening; privateRelayPayment?: { recipientAddress: bigint; receiveKey: Uint8Array; amount: bigint }; selectedQuote?: SelectedRelayQuote }> {
  const dummyInputEntropy = randomFieldEntropy();
  const fixed = await fixPublication({
    selectedRelayQuote: params.selectedRelayQuote, publication: params.publication, owner: params.owner,
    requestedCommitment: params.issuanceOwnerCommitment, node: params.node, status: params.status,
    nullifiers: transactionNullifiers(params.owner.nkRoot, params.inputs, dummyInputEntropy, PRIVATE_VALUE_PROFILES.S.inputs),
    shape: PRIVATE_VALUE_PROFILES.S.shapeId, openFeeAmount: params.openFeeAmount,
    privateRelayFeeAmount: params.privateRelayFeeAmount ?? 0n, issuanceEligible: false,
    maxTransactionBytes: params.maxTransactionBytes ?? PADDED_PRIVATE_VALUE_BYTE_SIZE,
    validUntilTimestamp: params.validUntilTimestamp,
  });
  return { ...fixed, dummyInputEntropy };
}

/** Select notes for the complete public or private network fee. */
export function resolvePublicationFunding<T>(
  plan: PublicationPlan,
  select: (fee: bigint) => T,
): { plan: PublicationPlan; funding: T } {
  return { plan, funding: select(plan.openFeeAmount + plan.privateRelayFeeAmount) };
}
