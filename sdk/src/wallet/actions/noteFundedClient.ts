import { sameTransactionData, storeTransactionData, restoreTransactionData, resolveTransactionData, transactionDataHash, type TransactionData, type StoredTransactionData } from "@pcash/sdk/delivery";
import type { AccountCreationAttachment, RawPrivateValueTransaction } from "@pcash/sdk/protocol";
import { sameAccountCreation } from "./accountCreation.ts";
import type { SelectedRelayQuoteProvider } from "@pcash/sdk/eip712";
import { randomFieldEntropy } from "@pcash/sdk/utils";
import { type DesignatedIssuanceOpening } from "@pcash/sdk/protocol";
import { fromHex } from "@pcash/sdk/utils";
// Browser-safe default-rule note transfer state machine.
//
// Platform adapters supply transactional persistence, proof production, and a
// two-phase submission transport. This module owns the wallet decisions that
// must be identical in a CLI and browser: input selection, exact-byte
// journaling, retry, rollback before a definite non-broadcast, ambiguous
// retention, and canonical final reconciliation.

import { assertWalletStoreMatches, sameRecipient } from "./walletSession.ts";
import { acceptedReceiptOfKind } from "./walletSession.ts";
import { addressHex, bytes32Hex } from "@pcash/sdk/utils";
import { authorizeNativeTransferBuild, buildMineAction, buildNativeTransfer, type NativeTransferBuild } from "@pcash/sdk/builders";
import { openBlockHeaderKey, openStateKey } from "@pcash/sdk/protocol";
import { assertTransactionTypeAccepted } from "@pcash/sdk/protocol";
import { decodeTransaction } from "@pcash/sdk/protocol";
import { assertPcashProfileMatchesAccount, type PcashProfile } from "../externalIdentity.ts";
import { localAccount, localWitnessSnapshot, locallySpent } from "./localChain.ts";
import { assertReceiveKeyOwned, registeredSelfReceiveKey } from "./selfDelivery.ts";
import {
  submitDurableAction,
  type DurableSubmissionAdapter,
  type DurableSubmissionCallbacks,
  type DurableSubmissionOutcome,
  type DurableSubmissionResult,
  settlePollOptions,
  type SettlePollOptions,
} from "./durableSubmission.ts";
import { transactionIdentity } from "@pcash/sdk/protocol";
import { networkConfigFromStatus } from "@pcash/sdk/protocol";
import type {
  PcashNodeClient,
  AccountProofResult,
  AccountResult,
  StatusResult,
} from "@pcash/sdk/clients";
import {
  addPendingNote,
  addPendingNoteFundedTransfer,
  addMempoolOutboxEntry,
  InsufficientNotesError,
  removePendingNoteFundedTransfer,
  selectInputNotes,
  type PendingNoteFundedTransfer,
  type WalletFileData,
  type WalletNote,
} from "../noteStore.ts";
import { reconcilePendingWalletActions, removePendingChangeNote } from "./clientReconciliation.ts";
import { directSendsToRecord } from "../directSends.ts";
import { WalletConflictError, type WalletStateStore } from "../store.ts";
import { parseExtendedCode, resolveRecipientAddress, resolveRecipientDelivery } from "@pcash/sdk/delivery";
import { TX_KIND_PRIVATE_VALUE, RECENT_PCASH_BLOCK_WINDOW_SECONDS } from "@pcash/sdk/protocol";
import { ACCOUNT_KIND_CONTRACT, PRIVATE_VALUE_PROFILES, privateValueProfile, type PrivateValueShape, STATE_KEY_OUTPUT_ROOT, STATE_KEY_ACCOUNT_STATE_ROOT, BLOCK_HEADER_KEY_STATE_ROOT, MERKLE_DEPTH } from "@pcash/sdk/constants";
import type { PcashActionSigner } from "@pcash/sdk/eip712";
import { receiveKeyHash } from "@pcash/sdk/protocol";
import {
  noteResource,
  withWalletReservation,
  type WalletReservation,
} from "../reservations.ts";
import {
  assertWalletTransferReview,
  WalletReviewStaleError,
  type WalletTransferPreflight,
} from "./transferReview.ts";
import {
  issuanceBeneficiary,
  fixPublication,
  noteNullifier,
  transactionNullifiers,
  pendingIssuanceBeneficiary,
  publicationOf,
  publicationValidUntil,
  paddedPrivateValueByteSize,
  type IssuanceBeneficiary,
  type PublicationMode,
} from "./publication.ts";
import {
  abortableWalletAction,
  throwIfWalletActionCanceled,
} from "./cancellation.ts";

export const DEFAULT_NOTE_FUNDED_VALIDITY_WINDOW = 1_800n;


export type NoteFundedValidityMode = "exact" | "ceiling";

export interface NoteFundedTransferIntent {
  /** Finality polling attempts after submission; applications may observe settlement separately. */
  settlePollMaxAttempts?: number;
  accountCreation?: AccountCreationAttachment;
  kind?: "payment" | "mine";
  /** Omit to select the smallest profile that funds the payment. */
  shape?: PrivateValueShape;
  to: string;
  amount: bigint;
  /**
   * Pay an address that publishes no receive key by a direct send: a note under
   * a secret derived from this wallet's keys, with no envelope, whose opening
   * the sender delivers by link. Without it such an address is refused.
   */
  directSend?: boolean;
  /** Transaction-scoped recipient and self records. */
  data?: TransactionData;
  /** The approved explicit fee. The wallet runtime resolves an absent one before funding. */
  openFeeAmount?: bigint;
  privateRelayFeeAmount?: bigint;
  /** Expected destination: nonzero must equal the designated commitment the wallet fixes; a retry matches it exactly, zero being the open route. */
  issuanceOwnerCommitment?: bigint;
  /** Authenticates a private fee recipient and a separate issuance commitment. */
  selectedRelayQuote?: SelectedRelayQuoteProvider;
  noteSelector?: string;
  /**
   * Lower execution bound, default `0` (unconstrained-below). Set this to
   * satisfy an account rule that requires a minimum execution time; the value is
   * public and becomes part of the authorized action.
   *
   * The mempool is not a scheduler: a value above the node's head timestamp is
   * rejected here rather than proved and refused at admission.
   */
  notBeforeTimestamp?: bigint;
  validUntilTimestamp?: bigint;
  /** CLI explicit deadlines are exact; marketplace deadlines are ceilings. */
  validUntilMode?: NoteFundedValidityMode;
  /** Select one exact durable payment for retry instead of matching by semantics. */
  retryContentHash?: string;
  /**
   * Build a new payment instead of matching an unresolved one with the same
   * semantics. A deliberate repeat — earning again on the same terms — is a new
   * action, not a retry of the one still journaled for reorg safety; that one
   * stays retryable by its `retryContentHash`.
   */
  newAction?: boolean;
  /** Cancels preparation before any durable payment state is committed. */
  signal?: AbortSignal;
}

/**
 * Resolve the public lower execution bound and refuse one the node cannot
 * admit yet.
 *
 * Admission re-runs the same `notBeforeTimestamp <= currentTimestamp` check
 * against the head, so a future-dated bound would be rejected there — after an
 * expensive proof had already been built and journaled. Retaining a
 * future-dated authorization, reproving it against a fresh snapshot, and
 * reauthorizing it when the selected state expires is a scheduler's
 * job, and PCASH has no scheduler.
 */
function assertSubmittableLowerBound(
  notBeforeTimestamp: bigint | undefined,
  status: StatusResult,
  validUntilTimestamp: bigint,
): bigint {
  const notBefore = notBeforeTimestamp ?? 0n;
  if (notBefore === 0n) return 0n;
  if (notBefore < 0n || notBefore >= 1n << 64n) {
    throw new Error("notBeforeTimestamp must be a 64-bit timestamp");
  }
  if (notBefore > validUntilTimestamp) {
    throw new Error(
      `notBeforeTimestamp ${notBefore} exceeds validUntilTimestamp ${validUntilTimestamp}; `
        + "the authorized execution interval would be empty",
    );
  }
  if (notBefore > status.latestBlockTimestamp) {
    throw new Error(
      `notBeforeTimestamp ${notBefore} is later than the latest PCASH block timestamp `
        + `${status.latestBlockTimestamp}; the mempool is not a scheduler, so this transaction `
        + "cannot be admitted yet. Submit it once the chain reaches that timestamp.",
    );
  }
  return notBefore;
}

export function noteFundedTransferValidUntil(
  status: StatusResult,
  intent: Pick<NoteFundedTransferIntent, "validUntilTimestamp" | "validUntilMode" | "selectedRelayQuote"> = {},
  nowUnixSeconds: () => bigint = () => BigInt(Math.floor(Date.now() / 1_000)),
): bigint {
  let chainNow = status.latestBlockTimestamp;
  if (chainNow === 0n) chainNow = nowUnixSeconds();
  return publicationValidUntil({
    chainNow, defaultWindow: DEFAULT_NOTE_FUNDED_VALIDITY_WINDOW,
    ...(intent.selectedRelayQuote === undefined ? {} : { selectedRelayQuote: intent.selectedRelayQuote }),
    ...(intent.validUntilTimestamp === undefined ? {} : { requested: intent.validUntilTimestamp }),
    requestedMode: intent.validUntilMode, action: "transfer",
  });
}


function pendingNoteFundedTransferMatchesIntent(
  pending: PendingNoteFundedTransfer,
  intent: NoteFundedTransferIntent,
): boolean {
  const deadlineMatches = intent.validUntilTimestamp === undefined
    || (intent.validUntilMode === "ceiling"
      ? BigInt(pending.validUntilTimestamp) <= intent.validUntilTimestamp
      : BigInt(pending.validUntilTimestamp) === intent.validUntilTimestamp);
  // Both timing bounds are part of the authorized action, so both belong to
  // the retry identity.
  const lowerBoundMatches =
    BigInt(pending.notBeforeTimestamp) === (intent.notBeforeTimestamp ?? 0n);
  const sameTerms = pending.kind === (intent.kind ?? "payment")
    && lowerBoundMatches
    && BigInt(pending.transferAmount) === intent.amount
    && (intent.openFeeAmount === undefined || BigInt(pending.openFeeAmount) === intent.openFeeAmount)
    && (intent.privateRelayFeeAmount === undefined || BigInt(pending.privateRelayFeeAmount) === intent.privateRelayFeeAmount)
    && (intent.issuanceOwnerCommitment === undefined || BigInt(pending.issuanceOwnerCommitment) === intent.issuanceOwnerCommitment)
    // A named recipient must be the one the saved bytes pay; an omitted one retries the saved destination.
    && (intent.selectedRelayQuote === undefined
      || (pending.privateRelayRecipient !== null
        && pending.privateRelayRecipient.toLowerCase() === addressHex(intent.selectedRelayQuote.recipient).toLowerCase()))
    && sameRecipient(pending.recipient, intent.to)
    && sameTransactionData(pending.data, intent.data)
    && deadlineMatches;
  if (!sameTerms) return false;
  const transaction = decodeTransaction(fromHex(pending.transactionHex)) as RawPrivateValueTransaction;
  return (intent.shape === undefined || transaction.shape === intent.shape)
    && sameAccountCreation(transaction.accountCreation, intent.accountCreation);
}

interface CollectedNoteTransferOpenings {
  accountPath: AccountProofResult;
  boundary: Extract<AccountProofResult, { status: "present" }>["boundary"];
  /** One opening per selected input; empty for an action that spends no notes. */
  inputPaths: NonNullable<Awaited<ReturnType<PcashNodeClient["getOutputPaths"]>>>["paths"];
  /** Recipients' receive keys from the account set `accountPath` opens against. */
  receiveKeyOf: (address: string) => Promise<Uint8Array | null>;
  status: StatusResult;
}

/** Collect the transfer witnesses from the wallet's local chain state at its anchor. */
export async function collectCurrentNoteTransferOpenings(
  node: PcashNodeClient,
  store: WalletStateStore,
  address: string,
  inputs: readonly { leafIndex: bigint }[],
): Promise<CollectedNoteTransferOpenings> {
  const status = await node.status();
  const snapshot = await localWitnessSnapshot(store, {
    accounts: [address],
    outputs: inputs.map((note) => ({ outputIndex: note.leafIndex })),
  });
  const accountPath = snapshot.accounts[0]!;
  if (accountPath.status !== "present" && inputs.length !== 0) throw new Error(`sender ${address} has no address account`);
  return {
    accountPath,
    boundary: snapshot.blockHeader.boundary,
    inputPaths: snapshot.outputs?.paths ?? [],
    receiveKeyOf: snapshot.receiveKeyOf,
    status,
  };
}

export interface NoteFundedProver {
  /** Produce the exact private-value transaction bytes for an authorized build. */
  proveAndEncode(build: NativeTransferBuild, signal?: AbortSignal): Promise<Uint8Array>;
}

export interface PreparedNoteFundedTransfer {
  transactionBytes: Uint8Array;
  pending: PendingNoteFundedTransfer;
  changeNote: null | {
    outputIndex: number;
    assetId: 0n;
    amount: bigint;
    owner: bigint;
    noteSecret: bigint;
  };
}

export interface NoteFundedClientResult<Output = unknown> {
  contentHash: string;
  transactionHex: string;
  recipient: string;
  amount: bigint;
  changeAmount: bigint;
  openFeeAmount: bigint;
  privateRelayFeeAmount: bigint;
  issuanceOwnerCommitment: bigint;
  validUntilTimestamp: bigint;
  accepted: boolean;
  queued: boolean;
  settled: boolean;
  retried: boolean;
  recovered: boolean;
  submission: DurableSubmissionResult<Output> | null;
}

function pendingInputResources(pending: PendingNoteFundedTransfer): string[] {
  return pending.inputs.map((input) => noteResource(input.nullifier));
}

/** Note-spending input positions; the rest of the tuple is dummy padding. */
function spentNoteCount(pending: PendingNoteFundedTransfer): number {
  return pending.inputs.filter((input) => input.spentCommitment !== null).length;
}

/**
 * Exact builder randomness for adapter-parity tests and resumable preparation.
 * Production callers omit this so the builder uses its CSPRNG paths.
 */
interface NoteFundedDeterministicTransactionInput {
  eventSalt?: bigint;
  dummyInputEntropy: bigint;
  outputEntropies: readonly bigint[];
  outputData: readonly [
    Uint8Array,
    Uint8Array,
    Uint8Array?,
    Uint8Array?,
    Uint8Array?,
  ];
  arena?: Uint8Array;
}

interface NoteFundedClientParams<Prepared = unknown, Output = unknown>
  extends NoteFundedTransferIntent, DurableSubmissionCallbacks, SettlePollOptions {
  createAccount?: (context: { recentPcashBlockHash: bigint; validUntilTimestamp: bigint }) => Promise<AccountCreationAttachment>;
  node: PcashNodeClient;
  store: WalletStateStore;
  wallet: PcashProfile;
  signer: PcashActionSigner;
  chainId: bigint;
  prover: NoteFundedProver;
  submission: DurableSubmissionAdapter<Prepared, Output>;
  status?: StatusResult;
  nowUnixSeconds?: () => bigint;
  deterministicTransactionInput?: NoteFundedDeterministicTransactionInput;
  expectedReview?: WalletTransferPreflight;
}

interface NoteFundedPreflightParams extends Omit<NoteFundedTransferIntent, "to"> {
  /** Enables exact-byte retry recognition; omitted for a balance-only funding check. */
  to?: string;
  node: PcashNodeClient;
  store: WalletStateStore;
  wallet: PcashProfile;
  chainId: bigint;
  status?: StatusResult;
}

interface NoteFundedPreflightResult {
  inputCount: number;
  inputTotal: bigint;
  retry: boolean;
}

export function matchingPendingNoteFundedTransfer(
  data: WalletFileData,
  intent: NoteFundedTransferIntent,
): PendingNoteFundedTransfer | null {
  const matches = (data.pendingNoteFundedTransfers ?? []).filter((pending) =>
    pendingNoteFundedTransferMatchesIntent(pending, intent)
  );
  if (matches.length > 1) {
    throw new Error("wallet has multiple unresolved copies of this note-funded transfer");
  }
  return matches[0] ?? null;
}

export function selectedPendingNoteFundedTransfer(
  data: WalletFileData,
  intent: NoteFundedTransferIntent,
): PendingNoteFundedTransfer | null {
  if (intent.retryContentHash === undefined) {
    return intent.newAction === true ? null : matchingPendingNoteFundedTransfer(data, intent);
  }
  const contentHash = intent.retryContentHash.toLowerCase();
  const pending = (data.pendingNoteFundedTransfers ?? [])
    .find((candidate) => candidate.contentHash.toLowerCase() === contentHash);
  if (pending === undefined) throw new Error(`pending payment ${intent.retryContentHash} is no longer available`);
  if (!pendingNoteFundedTransferMatchesIntent(pending, intent)) {
    throw new Error(`pending payment ${intent.retryContentHash} does not match the reviewed payment`);
  }
  return pending;
}

function validateDefaultAccount(
  wallet: PcashProfile,
  status: StatusResult,
  account: AccountResult,
): bigint {
  const network = networkConfigFromStatus(status);
  assertPcashProfileMatchesAccount(wallet, account, network);
  return BigInt(account.accountRuleSetCommitment);
}

export async function loadAndReconcileNoteWallet(
  store: WalletStateStore,
  status: StatusResult,
  chainId: bigint,
  wallet: { address: bigint },
): Promise<WalletFileData> {
  assertWalletStoreMatches(store, wallet, chainId, status);
  const data = await store.load();
  if (data === null) throw new Error("no note inventory for this wallet yet; scan for notes before transferring");
  if (await store.readChain((chain) => reconcilePendingWalletActions(data, chain, status))) await store.save(data);
  return data;
}

export async function preflightNoteFundedTransferClient(
  params: NoteFundedPreflightParams,
): Promise<NoteFundedPreflightResult> {
  const storedData = storeTransactionData(params.data);
  params = { ...params, ...(storedData === undefined ? {} : { data: restoreTransactionData(storedData)! }) };
  const status = params.status ?? await params.node.status();
  const data = await loadAndReconcileNoteWallet(params.store, status, params.chainId, params.wallet);
  const pending = params.to === undefined ? null : selectedPendingNoteFundedTransfer(data, {
    ...params,
    to: params.to,
  });
  if (pending !== null) {
    return {
      inputCount: spentNoteCount(pending),
      inputTotal: BigInt(pending.transferAmount) + BigInt(pending.openFeeAmount)
        + BigInt(pending.privateRelayFeeAmount) + BigInt(pending.change?.amount ?? "0"),
      retry: true,
    };
  }
  const { notes } = selectNoteTransferFunding(data, params);
  const address = addressHex(params.wallet.address);
  const account = await localAccount(params.store, address);
  if (account !== null) {
    if (params.kind !== "mine") validateDefaultAccount(params.wallet, status, account);
  } else if (notes.length !== 0) throw new Error(`sender ${address} has no address account`);
  return {
    inputCount: notes.length,
    inputTotal: notes.reduce((sum, note) => sum + BigInt(note.amount), 0n),
    retry: false,
  };
}

/** Select funding before fixing the context or asking for a fee quote. */
export function selectNoteTransferFunding(data: WalletFileData, intent: Pick<NoteFundedTransferIntent, "shape" | "noteSelector" | "amount" | "openFeeAmount" | "privateRelayFeeAmount">): { shape: PrivateValueShape; notes: WalletNote[] } {
  const profiles = intent.shape === undefined
    ? [PRIVATE_VALUE_PROFILES.S, PRIVATE_VALUE_PROFILES.L]
    : [privateValueProfile(intent.shape)];
  for (const profile of profiles) {
    if (intent.shape === undefined && intent.noteSelector !== undefined
      && intent.noteSelector.split(",").length > profile.inputs) continue;
    try {
      return { shape: profile.shapeId, notes: selectInputNotes(data, intent.noteSelector,
        intent.amount + (intent.openFeeAmount ?? 0n) + (intent.privateRelayFeeAmount ?? 0n), profile.inputs) };
    } catch (error) {
      if (!(error instanceof InsufficientNotesError) || profile === profiles.at(-1)) throw error;
    }
  }
  throw new Error("explicit notes exceed every supported private-value profile");
}

function rollbackPrepared(data: WalletFileData, pending: PendingNoteFundedTransfer): void {
  removePendingNoteFundedTransfer(data, pending.contentHash);
  removePendingChangeNote(data, pending);
}


function resultFromPending<Output>(params: {
  pending: PendingNoteFundedTransfer;
  outcome: DurableSubmissionOutcome<Output>;
}): NoteFundedClientResult<Output> {
  return {
    contentHash: params.pending.contentHash,
    transactionHex: params.pending.transactionHex,
    recipient: params.pending.recipient,
    amount: BigInt(params.pending.transferAmount),
    changeAmount: BigInt(params.pending.change?.amount ?? "0"),
    openFeeAmount: BigInt(params.pending.openFeeAmount),
    privateRelayFeeAmount: BigInt(params.pending.privateRelayFeeAmount),
    issuanceOwnerCommitment: BigInt(params.pending.issuanceOwnerCommitment),
    validUntilTimestamp: BigInt(params.pending.validUntilTimestamp),
    ...params.outcome,
  };
}

function pendingReview(
  pending: PendingNoteFundedTransfer,
  beneficiary: IssuanceBeneficiary,
  publication: PublicationMode,
): WalletTransferPreflight {
  return {
    openFeeAmount: BigInt(pending.openFeeAmount),
    privateRelayFeeAmount: BigInt(pending.privateRelayFeeAmount),
    privateRelayRecipient: pending.privateRelayRecipient,
    beneficiary,
    publication,
    dataHash: transactionDataHash(restoreTransactionData(pending.data)),
    inputCount: spentNoteCount(pending),
    inputTotal: BigInt(pending.transferAmount)
      + BigInt(pending.openFeeAmount)
      + BigInt(pending.privateRelayFeeAmount)
      + BigInt(pending.change?.amount ?? "0"),
    retry: true,
  };
}

function noteReview(
  params: Pick<NoteFundedTransferIntent, "openFeeAmount" | "privateRelayFeeAmount" | "data">,
  notes: readonly WalletNote[],
  beneficiary: IssuanceBeneficiary,
  publication: PublicationMode,
): WalletTransferPreflight {
  return {
    openFeeAmount: params.openFeeAmount ?? 0n,
    privateRelayFeeAmount: params.privateRelayFeeAmount ?? 0n,
    privateRelayRecipient: publication === "selected" && beneficiary.kind === "recipient" ? beneficiary.address : null,
    beneficiary,
    publication,
    dataHash: transactionDataHash(params.data),
    inputCount: notes.length,
    inputTotal: notes.reduce((sum, note) => sum + BigInt(note.amount), 0n),
    retry: false,
  };
}

function noteInputResources(wallet: PcashProfile, notes: readonly WalletNote[]): string[] {
  return notes.map((note) => noteResource(bytes32Hex(noteNullifier(wallet.nkRoot, note))));
}

function sameResources(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((resource, index) => resource === right[index]);
}

function assertPreparedInputNotesAvailable(
  data: WalletFileData,
  pending: PendingNoteFundedTransfer,
): void {
  const unavailable = pending.inputs.find((input) => {
    if (input.spentCommitment === null) return false;
    const selected = data.notes.find((note) =>
      note.commitment !== null && BigInt(note.commitment) === BigInt(input.spentCommitment!)
    );
    return selected === undefined
      || selected.spent
      || selected.pending
      || selected.leafIndex === null;
  });
  if (unavailable !== undefined) {
    throw new WalletConflictError(
      "wallet funding changed before the proved transfer was journaled",
      pendingInputResources(pending),
    );
  }
}

/** Submit an already-journaled note-funded transfer through the shared durable state machine. */
async function submitPendingNoteFundedTransferReserved<Prepared, Output>(params: SettlePollOptions & {
  node: PcashNodeClient;
  store: WalletStateStore;
  data: WalletFileData;
  status: StatusResult;
  pending: PendingNoteFundedTransfer;
  submission: DurableSubmissionAdapter<Prepared, Output>;
  selectedRelayQuote?: SelectedRelayQuoteProvider;
  reservation: WalletReservation;
  callbacks?: DurableSubmissionCallbacks;
  onCanonicalMiss?: () => void;
}): Promise<NoteFundedClientResult<Output>> {
  const outcome = await submitDurableAction({
    ...params,
    action: {
      contentHash: params.pending.contentHash,
      transactionHex: params.pending.transactionHex,
      kind: "noteFundedTransfer",
    },
    state: {
      retry: true,
      ...(params.onCanonicalMiss === undefined ? {} : { onCanonicalMiss: params.onCanonicalMiss }),
    },
    isAccepted: () => acceptedReceiptOfKind(params.node, params.pending.contentHash, "privateValue", "pending note-funded transfer"),
    isPending: (current) => (current.pendingNoteFundedTransfers ?? [])
      .some((item) => item.contentHash.toLowerCase() === params.pending.contentHash.toLowerCase()),
  });
  return resultFromPending({ pending: params.pending, outcome });
}

async function submitPendingNoteFundedTransfer<Prepared, Output>(params: {
  node: PcashNodeClient;
  store: WalletStateStore;
  wallet: Pick<PcashProfile, "address">;
  data: WalletFileData;
  status: StatusResult;
  pending: PendingNoteFundedTransfer;
  submission: DurableSubmissionAdapter<Prepared, Output>;
  selectedRelayQuote?: SelectedRelayQuoteProvider;
  callbacks?: DurableSubmissionCallbacks;
  onCanonicalMiss?: () => void;
  settlePollIntervalMs?: number;
  settlePollMaxAttempts?: number;
  expectedReview?: WalletTransferPreflight;
}): Promise<NoteFundedClientResult<Output>> {
  return withWalletReservation(
    params.store,
    pendingInputResources(params.pending),
    async (reservation) => {
      const data = params.expectedReview === undefined
        ? params.data
        : await params.store.load();
      const pending = data?.pendingNoteFundedTransfers?.find(
        (candidate) => candidate.contentHash.toLowerCase() === params.pending.contentHash.toLowerCase(),
      );
      if (data === null || pending === undefined) {
        if (params.expectedReview !== undefined) throw new WalletReviewStaleError();
        throw new Error(`pending transaction ${params.pending.contentHash} disappeared before submission`);
      }
      assertWalletTransferReview(params.expectedReview, pendingReview(
        pending,
        pendingIssuanceBeneficiary(pending, params.wallet),
        publicationOf(params.submission, BigInt(pending.privateRelayFeeAmount)),
      ));
      return submitPendingNoteFundedTransferReserved({
        ...params,
        data,
        pending,
        reservation,
      });
    },
    { allowPendingContentHash: params.pending.contentHash, reservationId: params.pending.contentHash },
  );
}

/**
 * Apply one already-prepared action under an exact durable input reservation;
 * custom-rule adapters and the default engine share this transition.
 */
async function submitPreparedNoteFundedTransferReserved<Prepared, Output>(params: SettlePollOptions & {
  node: PcashNodeClient;
  store: WalletStateStore;
  data: WalletFileData;
  status: StatusResult;
  preparedAction: PreparedNoteFundedTransfer;
  submission: DurableSubmissionAdapter<Prepared, Output>;
  selectedRelayQuote?: SelectedRelayQuoteProvider;
  reservation: WalletReservation;
  preparedSubmission: Prepared;
  callbacks?: DurableSubmissionCallbacks;
  /** Replaces the default post-beforeJournal check and must authenticate every input. */
  validateJournal?: () => void | Promise<void>;
}): Promise<NoteFundedClientResult<Output>> {
  const { pending, changeNote } = params.preparedAction;
  const existing = params.data.pendingNoteFundedTransfers?.find(
    (transfer) => transfer.contentHash.toLowerCase() === pending.contentHash.toLowerCase(),
  );
  if (existing !== undefined) {
    return submitPendingNoteFundedTransferReserved({
      node: params.node,
      store: params.store,
      data: params.data,
      status: params.status,
      pending: existing,
      submission: params.submission,
      ...(params.selectedRelayQuote === undefined ? {} : { selectedRelayQuote: params.selectedRelayQuote }),
      reservation: params.reservation,
      ...(params.callbacks === undefined ? {} : { callbacks: params.callbacks }),
      ...settlePollOptions(params),
    });
  }
  const validateJournal = params.validateJournal ?? (async () => {
    const spent = await locallySpent(params.store, pending.inputs.map((input) => input.nullifier));
    if (spent.some(Boolean)) {
      throw new Error("a selected input was spent before the transfer reservation was written");
    }
  });
  const outcome = await submitDurableAction({
    ...params,
    action: {
      contentHash: pending.contentHash,
      transactionHex: pending.transactionHex,
      kind: "noteFundedTransfer",
    },
    state: {
      retry: false,
      prepared: params.preparedSubmission,
      validateJournal,
      journal: () => {
        addPendingNoteFundedTransfer(params.data, pending);
        if (changeNote !== null) addPendingNote(params.data, pending.contentHash, changeNote);
      },
      rollback: () => rollbackPrepared(params.data, pending),
    },
    isAccepted: () => acceptedReceiptOfKind(params.node, pending.contentHash, "privateValue", "pending note-funded transfer"),
    isPending: (current) => (current.pendingNoteFundedTransfers ?? [])
      .some((item) => item.contentHash.toLowerCase() === pending.contentHash.toLowerCase()),
  });
  return resultFromPending({ pending, outcome });
}

async function submitPreparedNoteFundedTransfer<Prepared, Output>(params: {
  node: PcashNodeClient;
  store: WalletStateStore;
  data: WalletFileData;
  status: StatusResult;
  preparedAction: PreparedNoteFundedTransfer;
  submission: DurableSubmissionAdapter<Prepared, Output>;
  preparedSubmission: Prepared;
  callbacks?: DurableSubmissionCallbacks;
  settlePollIntervalMs?: number;
  settlePollMaxAttempts?: number;
  /** Replaces the default post-beforeJournal node check and must authenticate every input. */
  validateJournal?: () => void | Promise<void>;
  /** Synchronous wallet-state check applied inside the atomic journal transaction. */
  validateCurrentData?: (data: WalletFileData) => void;
}): Promise<NoteFundedClientResult<Output>> {
  const { pending, changeNote } = params.preparedAction;
  const retry = params.data.pendingNoteFundedTransfers?.some(
    (item) => item.contentHash.toLowerCase() === pending.contentHash.toLowerCase(),
  ) === true;
  if (retry) {
    return withWalletReservation(
      params.store,
      pendingInputResources(pending),
      async (reservation) => submitPreparedNoteFundedTransferReserved({ ...params, reservation }),
      { allowPendingContentHash: pending.contentHash, reservationId: pending.contentHash },
    );
  }

  await params.callbacks?.beforeJournal?.(pending.contentHash, pending.transactionHex);
  const validateJournal = params.validateJournal ?? (async () => {
    const spent = await locallySpent(params.store, pending.inputs.map((input) => input.nullifier));
    if (spent.some(Boolean)) {
      throw new Error("a selected input was spent before the transfer reservation was written");
    }
  });
  await validateJournal();

  return withWalletReservation(
    params.store,
    pendingInputResources(pending),
    async (reservation) => {
      // The initializer above committed against the latest document. Continue
      // from another fresh read so no pre-proof snapshot can overwrite it.
      const data = await params.store.load();
      if (data === null) throw new Error("wallet state disappeared after journaling a proved transfer");
      const committed = data.pendingNoteFundedTransfers?.find(
        (item) => item.contentHash.toLowerCase() === pending.contentHash.toLowerCase(),
      );
      if (committed === undefined || committed.transactionHex.toLowerCase() !== pending.transactionHex.toLowerCase()) {
        throw new Error(`proved transfer ${pending.contentHash} was not committed with its exact bytes`);
      }
      const outcome = await submitDurableAction({
        ...params,
        data,
        reservation,
        action: {
          contentHash: pending.contentHash,
          transactionHex: pending.transactionHex,
          kind: "noteFundedTransfer",
        },
        state: {
          retry: false,
          prepared: params.preparedSubmission,
          preJournaled: true,
          rollback: () => rollbackPrepared(data, committed),
        },
        isAccepted: () => acceptedReceiptOfKind(
          params.node,
          pending.contentHash,
          "privateValue",
          "pending note-funded transfer",
        ),
        isPending: (current) => (current.pendingNoteFundedTransfers ?? [])
          .some((item) => item.contentHash.toLowerCase() === pending.contentHash.toLowerCase()),
      });
      return resultFromPending({ pending: committed, outcome });
    },
    {
      ...(params.callbacks?.nowUnixMilliseconds === undefined
        ? {}
        : { nowUnixMilliseconds: params.callbacks.nowUnixMilliseconds }),
      reservationId: pending.contentHash,
      initialize: (data) => {
        assertPreparedInputNotesAvailable(data, pending);
        params.validateCurrentData?.(data);
        addPendingNoteFundedTransfer(data, pending);
        if (changeNote !== null) addPendingNote(data, pending.contentHash, changeNote);
        if (params.submission.mode === "mempool") {
          addMempoolOutboxEntry(data, {
            contentHash: pending.contentHash,
            transactionHex: pending.transactionHex,
            kind: "noteFundedTransfer",
            state: "prepared",
            createdAtUnixMs: String((params.callbacks?.nowUnixMilliseconds ?? Date.now)()),
          });
        }
      },
    },
  );
}

/** Convert a proved native transfer into the canonical durable journal shape. */
function prepareNoteFundedTransferAction(params: {
  transactionBytes: Uint8Array;
  build: NativeTransferBuild;
  wallet: PcashProfile;
  inputNotes: readonly WalletNote[];
  intent: NoteFundedTransferIntent;
  storedData: StoredTransactionData | undefined;
  recipientAddress: bigint;
  /** The authenticated opening of a designated destination; absent on the open route. */
  designatedIssuanceOpening?: DesignatedIssuanceOpening;
  privateRelayRecipient?: bigint;
  notBeforeTimestamp: bigint;
  validUntilTimestamp: bigint;
  directSend: boolean;
}): PreparedNoteFundedTransfer {
  const { contentHash, transactionHex } = transactionIdentity(params.transactionBytes);
  const openFeeAmount = params.intent.openFeeAmount ?? 0n;
  const inputTotal = params.inputNotes.reduce((sum, note) => sum + BigInt(note.amount), 0n);
  const privateRelayFeeAmount = params.intent.privateRelayFeeAmount ?? 0n;
  const changeAmount = inputTotal - params.intent.amount - openFeeAmount - privateRelayFeeAmount;
  if (changeAmount < 0n) throw new Error("proved note-funded transfer spends more than its selected inputs");
  const pending: PendingNoteFundedTransfer = {
    contentHash,
    transactionHex,
    kind: params.intent.kind ?? "payment",
    notBeforeTimestamp: params.notBeforeTimestamp.toString(),
    validUntilTimestamp: params.validUntilTimestamp.toString(),
    transferAmount: params.intent.amount.toString(),
    openFeeAmount: openFeeAmount.toString(),
    privateRelayFeeAmount: privateRelayFeeAmount.toString(),
    privateRelayRecipient: params.privateRelayRecipient === undefined ? null : addressHex(params.privateRelayRecipient),
    issuanceOwnerCommitment: BigInt(params.build.transaction.global.issuanceOwnerCommitment).toString(),
    issuanceRecipient: params.designatedIssuanceOpening === undefined
      ? null
      : addressHex(BigInt(params.designatedIssuanceOpening.recipientAddress)),
    recipient: params.intent.to,
    recipientAddress: addressHex(params.recipientAddress),
    ...(params.storedData === undefined ? {} : { data: params.storedData }),
    // Every input position, so the journal carries the transaction's exact
    // nullifier tuple; a dummy slot spends no note. An action that spends
    // nothing is resolved by its dummy nullifiers alone.
    inputs: params.build.transaction.inputs.map((input, index) => {
      const note = params.inputNotes[index];
      return {
        nullifier: bytes32Hex(BigInt(input.nullifier)),
        spentCommitment: note === undefined ? null : bytes32Hex(BigInt(note.commitment!)),
      };
    }),
    change: changeAmount > 0n
      ? {
          amount: changeAmount.toString(),
          owner: addressHex(params.wallet.address),
          noteSecret: bytes32Hex(params.build.outputNoteSecrets[1]!),
        }
      : null,
    ...(params.directSend ? { directSendNoteSecret: bytes32Hex(params.build.outputNoteSecrets[0]!) } : {}),
  };
  return {
    transactionBytes: params.transactionBytes,
    pending,
    changeNote: changeAmount > 0n
      ? {
          outputIndex: 1,
          assetId: 0n,
          amount: changeAmount,
          owner: params.wallet.address,
          noteSecret: params.build.outputNoteSecrets[1]!,
        }
      : null,
  };
}

export async function runNoteFundedTransferClient<Prepared, Output>(
  params: NoteFundedClientParams<Prepared, Output>,
): Promise<NoteFundedClientResult<Output>> {
  throwIfWalletActionCanceled(params.signal);
  const storedData = storeTransactionData(params.data);
  params = { ...params, ...(storedData === undefined ? {} : { data: restoreTransactionData(storedData)! }) };
  const initialStatus = params.status ?? await abortableWalletAction(params.node.status(), params.signal);
  const data = await abortableWalletAction(
    loadAndReconcileNoteWallet(params.store, initialStatus, params.chainId, params.wallet),
    params.signal,
  );
  const beneficiary = issuanceBeneficiary({
    publication: publicationOf(params.submission, params.privateRelayFeeAmount),
    selectedRelayQuote: params.selectedRelayQuote,
  });
  const pending = selectedPendingNoteFundedTransfer(data, params);
  if (pending !== null) {
    return submitPendingNoteFundedTransfer({
      node: params.node,
      store: params.store,
      wallet: params.wallet,
      data,
      status: initialStatus,
      pending,
      submission: params.submission,
      ...(params.selectedRelayQuote === undefined ? {} : { selectedRelayQuote: params.selectedRelayQuote }),
      callbacks: params,
      ...(params.expectedReview === undefined ? {} : { expectedReview: params.expectedReview }),
      ...settlePollOptions(params),
    });
  }

  let inputNotes: WalletNote[];
  let shape: PrivateValueShape;
  try {
    ({ notes: inputNotes, shape } = selectNoteTransferFunding(data, params));
  } catch (cause) {
    if (params.expectedReview !== undefined && cause instanceof InsufficientNotesError) {
      throw new WalletReviewStaleError();
    }
    throw cause;
  }
  let liveData = data;
  let liveInputNotes = inputNotes;
  if (params.expectedReview !== undefined) {
    const resources = noteInputResources(params.wallet, inputNotes);
    liveData = await abortableWalletAction(loadAndReconcileNoteWallet(
      params.store,
      initialStatus,
      params.chainId,
      params.wallet,
    ), params.signal);
    const livePending = selectedPendingNoteFundedTransfer(liveData, params);
    try {
      liveInputNotes = selectInputNotes(
        liveData,
        params.noteSelector,
        params.amount + (params.openFeeAmount ?? 0n) + (params.privateRelayFeeAmount ?? 0n),
        privateValueProfile(shape).inputs,
      );
    } catch (cause) {
      if (cause instanceof InsufficientNotesError) throw new WalletReviewStaleError();
      throw cause;
    }
    if (livePending !== null || !sameResources(resources, noteInputResources(params.wallet, liveInputNotes))) {
      throw new WalletReviewStaleError();
    }
    assertWalletTransferReview(params.expectedReview, noteReview(
      params,
      liveInputNotes,
      beneficiary,
      publicationOf(params.submission, params.privateRelayFeeAmount),
    ));
  }
  const { preparedAction, status: preparedStatus } = await prepareNoteFundedTransferSnapshot(params, liveInputNotes, shape, storedData);
  const { transactionBytes: entry } = preparedAction;
  const preparedSubmission = await abortableWalletAction(params.submission.preflight({
    transactionBytes: entry,
    status: preparedStatus,
    retry: false,
  }), params.signal);
  return submitPreparedNoteFundedTransfer({
    node: params.node,
    store: params.store,
    data: liveData,
    status: preparedStatus,
    preparedAction,
    submission: params.submission,
    preparedSubmission,
    callbacks: params,
    ...settlePollOptions(params),
  });
}

/** Prepare the ordinary proof once, for either direct publication or a setup batch. */
export async function prepareNoteFundedTransfer<Prepared, Output>(
  params: NoteFundedClientParams<Prepared, Output>,
  liveInputNotes: WalletNote[],
  shape: PrivateValueShape,
): Promise<{ preparedAction: PreparedNoteFundedTransfer; status: StatusResult; anchor: { number: bigint; blockHash: bigint; timestamp: bigint } }> {
  const storedData = storeTransactionData(params.data);
  return prepareNoteFundedTransferSnapshot({
    ...params, ...(storedData === undefined ? {} : { data: restoreTransactionData(storedData)! }),
  }, liveInputNotes, shape, storedData);
}

async function prepareNoteFundedTransferSnapshot<Prepared, Output>(
  params: NoteFundedClientParams<Prepared, Output>,
  liveInputNotes: WalletNote[],
  shape: PrivateValueShape,
  storedData: StoredTransactionData | undefined,
): Promise<{ preparedAction: PreparedNoteFundedTransfer; status: StatusResult; anchor: { number: bigint; blockHash: bigint; timestamp: bigint } }> {
  const openings = await abortableWalletAction(collectCurrentNoteTransferOpenings(
    params.node,
    params.store,
    addressHex(params.wallet.address),
    liveInputNotes.map((note) => ({ leafIndex: BigInt(note.leafIndex!) })),
  ), params.signal);
  // Re-verify at the same boundary the openings were read at, not just the one
  // the operation started on.
  assertWalletStoreMatches(params.store, params.wallet, params.chainId, openings.status);
  const account = noteTransferAccountWitness(params.wallet, openings, params.kind === "mine");
  assertTransactionTypeAccepted(openings.status, TX_KIND_PRIVATE_VALUE);
  let validUntil = params.nowUnixSeconds === undefined
    ? noteFundedTransferValidUntil(openings.status, params)
    : noteFundedTransferValidUntil(openings.status, params, params.nowUnixSeconds);
  if (params.createAccount !== undefined) {
    const windowEnd = openings.boundary.header.timestamp + RECENT_PCASH_BLOCK_WINDOW_SECONDS;
    if (openings.status.latestBlockTimestamp >= windowEnd) throw new Error("account activation snapshot has expired; synchronize the wallet before preparing setup");
    if (validUntil > windowEnd) {
      if (params.validUntilTimestamp !== undefined && params.validUntilMode !== "ceiling") {
        throw new Error("account activation deadline is beyond its recent PCASH block's window");
      }
      validUntil = windowEnd;
    }
  }
  const notBefore = assertSubmittableLowerBound(params.notBeforeTimestamp, openings.status, validUntil);
  if (params.createAccount !== undefined) {
    params = { ...params, accountCreation: await params.createAccount({ recentPcashBlockHash: openings.boundary.blockHash, validUntilTimestamp: validUntil }) };
  }
  params.onProgress?.("preparing", "resolving the recipient…");
  const data = await params.store.load();
  let resolvedSelfReceiveKey: Uint8Array | undefined;
  const selfReceiveKey = () => resolvedSelfReceiveKey ??= registeredSelfReceiveKey(
    openings.accountPath.status === "present" ? openings.accountPath.account : null,
    data,
  );
  const receiveKeyOf = openings.receiveKeyOf;
  // Zero-value actions create no recipient note and need no receive key.
  const { recipientAddress, ...delivery } = params.amount === 0n
    ? resolveRecipientAddress(params.to, params.chainId)
    : await abortableWalletAction(
        resolveRecipientDelivery(params.to, params.chainId, (address) => BigInt(address) === params.wallet.address
          ? selfReceiveKey() : receiveKeyOf(address), { directSend: params.directSend === true }),
        params.signal,
      );
  if (recipientAddress === params.wallet.address && delivery.recipientExtendedCode !== undefined) {
    assertReceiveKeyOwned(data, parseExtendedCode(delivery.recipientExtendedCode).mlKemPublicKey);
  }
  // A contract account's notes answer to its rules, never to a link's holder.
  if (delivery.recipientDirectSend === true && (await localAccount(params.store, addressHex(recipientAddress)))?.accountKind === Number(ACCOUNT_KIND_CONTRACT)) {
    throw new Error(`recipient ${addressHex(recipientAddress)} is a contract account, which a direct send cannot pay`);
  }
  const openFeeAmount = params.openFeeAmount ?? 0n;
  const dummyInputEntropy = params.deterministicTransactionInput?.dummyInputEntropy ?? randomFieldEntropy();
  const { issuanceOwnerCommitment, designatedIssuanceOpening, privateRelayPayment, selectedQuote } = await fixPublication({
    maxTransactionBytes: paddedPrivateValueByteSize(shape, params.accountCreation),
    selectedRelayQuote: params.selectedRelayQuote,
    publication: publicationOf(params.submission, params.privateRelayFeeAmount),
    owner: params.wallet,
    requestedCommitment: params.issuanceOwnerCommitment ?? 0n,
    node: params.node,
    status: openings.status,
    nullifiers: transactionNullifiers(params.wallet.nkRoot, liveInputNotes, dummyInputEntropy, privateValueProfile(shape).inputs),
    shape,
    openFeeAmount,
    privateRelayFeeAmount: params.privateRelayFeeAmount ?? 0n,
    validUntilTimestamp: validUntil,
    assertStatus: (current) => assertWalletStoreMatches(params.store, params.wallet, params.chainId, current),
  });
  const inputTotal = liveInputNotes.reduce((sum, note) => sum + BigInt(note.amount), 0n);
  const changeAmount = inputTotal - params.amount - openFeeAmount - (privateRelayPayment?.amount ?? 0n);
  const outputDataOverrides = params.deterministicTransactionInput?.outputData;
  const needsSelfReceiveKey = params.kind !== "mine" && changeAmount > 0n && outputDataOverrides?.[1] === undefined;
  const build = await abortableWalletAction(authorizeNativeTransferBuild((params.kind === "mine" ? buildMineAction : buildNativeTransfer)({
    ...(params.accountCreation === undefined ? {} : { accountCreation: params.accountCreation }),
    shape,
    chainId: params.chainId,
    network: networkConfigFromStatus(openings.status),
    wallet: params.wallet,
    ...(needsSelfReceiveKey ? { selfReceiveKey: selfReceiveKey() } : {}),
    sender: {
      outgoingKey: params.wallet.outgoingKey,
      directSendOpenings: directSendsToRecord(data, params.wallet.address, params.kind === "mine" ? undefined : liveInputNotes),
    },
    data: await resolveTransactionData(params.data, params.chainId, receiveKeyOf, { directSend: delivery.recipientDirectSend === true }),
    recipientAddress,
    paymentAmount: params.amount,
    inputs: liveInputNotes.map((note, index) => ({
      amount: BigInt(note.amount),
      noteSecret: BigInt(note.noteSecret),
      outputIndex: Number(note.leafIndex!),
      siblings: openings.inputPaths[index]!.siblings,
    })),
    outputRoot: openings.boundary.state.outputRoot,
    outputRootStateSiblings: openStateKey(
      openings.boundary.state,
      STATE_KEY_OUTPUT_ROOT,
    ).siblings,
    openFeeAmount,
    issuanceOwnerCommitment,
    ...(privateRelayPayment === undefined ? {} : { privateRelayPayment: {
      address: privateRelayPayment.recipientAddress,
      amount: privateRelayPayment.amount,
      receiveKey: privateRelayPayment.receiveKey,
    } }),
    ...(designatedIssuanceOpening === undefined ? {} : { designatedIssuanceOpening }),
    ...(selectedQuote === undefined ? {} : { selectedQuote }),
    notBeforeTimestamp: notBefore,
    validUntilTimestamp: validUntil,
    recentPcashBlockHash: openings.boundary.blockHash,
    stateRoot: openings.boundary.header.stateRoot,
    stateRootHeaderSiblings: openBlockHeaderKey(openings.boundary.header, BLOCK_HEADER_KEY_STATE_ROOT).siblings,
    accountStateRootStateSiblings: openStateKey(openings.boundary.state, STATE_KEY_ACCOUNT_STATE_ROOT).siblings,
    defaultRuleSecrets: params.wallet.defaultUserRuleSecrets,
    accountStateRoot: openings.boundary.state.accountStateRoot,
    ...account,
    ...delivery,
    ...(params.deterministicTransactionInput ?? {}),
    dummyInputEntropy,
  }), params.signer), params.signal);
  throwIfWalletActionCanceled(params.signal);
  params.onProgress?.("proving", params.kind === "mine" ? "generating the mining proof…" : "generating the transfer proof…");
  const entry = await abortableWalletAction(params.signal === undefined
    ? params.prover.proveAndEncode(build)
    : params.prover.proveAndEncode(build, params.signal), params.signal);
  throwIfWalletActionCanceled(params.signal);
  const preparedAction = prepareNoteFundedTransferAction({
    transactionBytes: entry,
    build,
    wallet: params.wallet,
    inputNotes: liveInputNotes,
    intent: params,
    storedData,
    recipientAddress,
    ...(designatedIssuanceOpening === undefined ? {} : { designatedIssuanceOpening }),
    ...(privateRelayPayment === undefined ? {} : { privateRelayRecipient: privateRelayPayment.recipientAddress }),
    notBeforeTimestamp: notBefore,
    validUntilTimestamp: validUntil,
    directSend: delivery.recipientDirectSend === true,
  });
  return { preparedAction, status: openings.status, anchor: { number: openings.boundary.header.number, blockHash: openings.boundary.blockHash, timestamp: openings.boundary.header.timestamp } };
}

function noteTransferAccountWitness(wallet: PcashProfile, openings: CollectedNoteTransferOpenings, mine = false) {
  const path = openings.accountPath;
  if (!mine && path.status === "present") {
    return {
      ruleSetCommitment: validateDefaultAccount(wallet, openings.status, path.account),
      accountIndex: Number(path.account.index), accountSiblings: path.accountSiblings,
      accountRevision: path.account.accountRevision,
      receiveKeyHash: BigInt(path.account.receiveKeyHash),
    };
  }
  // This is a supplied account/rule opening, not proof of an installed rule.
  // The transfer kernel derives the all-DUMMY condition from its actual inputs.
  return {
    accountIndex: 0, accountSiblings: Array<bigint>(MERKLE_DEPTH).fill(0n), accountRevision: 1n,
    receiveKeyHash: wallet.mlKemPublicKey === undefined ? 0n : receiveKeyHash(wallet.mlKemPublicKey),
  };
}
