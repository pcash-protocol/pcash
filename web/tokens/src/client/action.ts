// One template action through the wallet: choose the role the publication
// mode implies, prove the template function, journal the exact bytes as a
// wallet asset action, and submit them with the wallet's adapter.
//
// The journal is the wallet's own pending asset action. Its inputs are the
// contract's notes and markers, which reserve them against a second local
// attempt; its owned outputs are the notes this wallet receives, which show as
// pending until the action settles; and its exact bytes are what a resumed
// action resubmits.

import type { PcashProfile, DurableSubmissionAdapter, DurableSubmissionPhase, WalletExecutionContext } from "@pcash/sdk/wallet";
import type { SponsoredContractAssetActionIntent } from "@pcash/sdk/wallet/actions";
import {
  InsufficientNotesError,
  loadSelfReceiveKey,
  loadSelfReceiveKeyAtSnapshot,
  prepareAssetAction,
  selectInputNotes,
  submitPendingAssetAction,
  submitPreparedAssetAction,
  type AssetActionSubmissionResult,
} from "@pcash/sdk/wallet/actions";
import { awaitAcceptedReceipt } from "@pcash/sdk/clients";
import { type AssetActionProofRequest, type AssetProver, type ProveStatus } from "@pcash/sdk/browser-prover/requests";
import { requestPcashAuthorization, type PcashActionSigner } from "@pcash/sdk/eip712";
import type { ArenaSender } from "@pcash/sdk/protocol";
import { addressHex, bytes32Hex, sameHex } from "@pcash/sdk/utils";
import { templateProofRequest, type TemplateAction, type TransferRole } from "../template.ts";
import { TokensError } from "./errors.ts";
import type { TokensRuntime } from "./runtime.ts";

export type TokensPhase =
  | "preparing"
  | "creating-contract"
  | "funding"
  | "publishing"
  | "signing"
  | "proving"
  | "submitting"
  | "confirming";

export interface TokensProgress {
  phase: TokensPhase;
  message: string;
  /** The prover's own update while a template action is proved. */
  proof?: ProveStatus;
}

export type TokensProgressCallback = (progress: TokensProgress) => void;

/** Observers of one token action: its progress, and each transaction once its exact bytes are journaled. */
export interface TokensActionCallbacks {
  onProgress?: TokensProgressCallback;
  onPrepared?: (contentHash: string, transactionHex: string) => void | Promise<void>;
}

/** Everything one wallet-bound template action needs. */
export interface TemplateRun<Prepared = unknown, Output = unknown> extends TokensActionCallbacks {
  ctx: WalletExecutionContext<Prepared, Output>;
  prover: AssetProver;
  submission: DurableSubmissionAdapter<Prepared, Output>;
  pollIntervalMs: number;
  pollMaxAttempts: number;
}

export interface TemplateSubmission {
  contentHash: string;
  /** Included on the canonical chain. */
  accepted: boolean;
  /** Held by the configured node's mempool until a relayer includes it. */
  queued: boolean;
  role: "transfer" | "sponsored";
}

interface FeeNote {
  leafIndex: number;
  commitment: bigint;
  noteSecret: bigint;
  amount: bigint;
}

/**
 * How a template action is published and paid. Self-publication and a
 * zero-fee relay use the transfer role; a positive relay fee is paid through
 * the wallet's sponsorship action, and `feeNotes` sizes the input slots the
 * action leaves it.
 */
export interface RolePlan {
  publication: "self" | "open";
  openFeeAmount: bigint;
  feeNotes: readonly FeeNote[];
}

export function progress(run: { onProgress?: TokensProgressCallback }, phase: TokensPhase, message: string): void {
  run.onProgress?.({ phase, message });
}

export function notify(onProgress: TokensProgressCallback | undefined, phase: TokensPhase, message: string): void {
  onProgress?.({ phase, message });
}

/** Forward the wallet's durable-submission progress in token phases. */
export function walletProgress(
  onProgress: TokensProgressCallback | undefined,
  preparing: TokensPhase = "preparing",
): { onProgress?: (phase: DurableSubmissionPhase, message: string) => void } {
  if (onProgress === undefined) return {};
  return { onProgress: (phase, message) => onProgress({ phase: phase === "preparing" ? preparing : phase, message }) };
}

async function walletData<Prepared, Output>(ctx: WalletExecutionContext<Prepared, Output>) {
  const data = await ctx.store.load();
  if (data === null) throw new TokensError("wallet-not-ready", "Sync the wallet before this action.");
  return data;
}

function spendable<Prepared, Output>(ctx: WalletExecutionContext<Prepared, Output>): { profile: PcashProfile; signer: PcashActionSigner } {
  if (!ctx.spendable()) throw new TokensError("wallet-not-ready", "Paying a relay fee needs a wallet that can sign.");
  return { profile: ctx.profile, signer: ctx.signer };
}

/** The wallet as a template recipient: its address and receive key. */
export async function walletRecipient<Prepared, Output>(ctx: WalletExecutionContext<Prepared, Output>, accountStateRoot?: bigint): Promise<{ address: bigint; receiveKey: Uint8Array; self: true }> {
  const receiveKey = accountStateRoot === undefined
    ? await loadSelfReceiveKey(ctx.store, ctx.profile.address)
    : await loadSelfReceiveKeyAtSnapshot(ctx.store, ctx.profile.address, accountStateRoot, () => ctx.synchronize());
  return { address: ctx.profile.address, receiveKey, self: true };
}

/** The sender region of an action this wallet builds; a profile without an outgoing key writes none. */
export function walletSender<Prepared, Output>(ctx: WalletExecutionContext<Prepared, Output>): { sender?: ArenaSender } {
  return "outgoingKey" in ctx.profile ? { sender: { outgoingKey: ctx.profile.outgoingKey } } : {};
}

/** A positive open fee in relay mode uses the wallet's sponsorship action. */
export function usesSponsorship(run: TemplateRun, openFeeAmount: bigint | undefined): boolean {
  if (openFeeAmount === undefined || openFeeAmount === 0n) return false;
  if (openFeeAmount < 0n) throw new Error("open fee must be nonnegative");
  if (run.submission.mode === "l1") throw new Error("a self-published action pays no open fee");
  return true;
}

export async function planRole<Prepared, Output>(run: TemplateRun<Prepared, Output>, params: {
  openFeeAmount?: bigint;
  /** Input slots the action leaves for fee notes. */
  freeInputs: number;
}): Promise<RolePlan> {
  const publication = run.submission.mode === "l1" ? "self" : "open";
  const openFeeAmount = params.openFeeAmount ?? 0n;
  if (openFeeAmount < 0n) throw new Error("open fee must be nonnegative");
  if (publication === "self") {
    if (openFeeAmount !== 0n) throw new Error("a self-published action pays no open fee");
    return { publication, openFeeAmount, feeNotes: [] };
  }
  if (openFeeAmount === 0n) return { publication, openFeeAmount, feeNotes: [] };
  spendable(run.ctx);
  let notes;
  try {
    notes = selectInputNotes(await walletData(run.ctx), undefined, openFeeAmount, params.freeInputs);
  } catch (cause) {
    if (!(cause instanceof InsufficientNotesError)) throw cause;
    throw new TokensError("insufficient-fee-notes", "The wallet has no spendable PCASH notes that cover this fee.", { cause });
  }
  return {
    publication,
    openFeeAmount,
    feeNotes: notes.map((note) => ({
      leafIndex: Number(note.leafIndex!),
      commitment: BigInt(note.commitment!),
      noteSecret: BigInt(note.noteSecret),
      amount: BigInt(note.amount),
    })),
  };
}

/**
 * The role for a plan this wallet builds itself. A positive relay fee goes
 * through the wallet's sponsorship action instead (`usesSponsorship`).
 */
export function templateRole<Prepared, Output>(run: TemplateRun<Prepared, Output>, plan: RolePlan): TransferRole {
  const profile = run.ctx.profile;
  if (plan.publication === "self") {
    return { kind: "transfer", issuance: { kind: "self", recipient: { address: profile.address, nkRoot: profile.nkRoot } } };
  }
  return { kind: "transfer" };
}

function durableCallbacks<Prepared, Output>(run: TemplateRun<Prepared, Output>) {
  return { ...walletProgress(run.onProgress), ...(run.onPrepared === undefined ? {} : { onPrepared: run.onPrepared }) };
}

function submitted(result: AssetActionSubmissionResult<unknown>, role: TemplateSubmission["role"]): TemplateSubmission {
  return { contentHash: result.contentHash, accepted: result.accepted, queued: result.queued, role };
}

/**
 * Prove a built action, journal it with the outputs at `ownedSlots` as this
 * wallet's pending notes, and submit it.
 */
export async function proveAndSubmit<Prepared, Output>(
  run: TemplateRun<Prepared, Output>,
  action: TemplateAction,
  params: { ownedSlots: readonly number[]; claimLinkRecipient?: bigint },
): Promise<TemplateSubmission> {
  const { ctx } = run;
  let request: AssetActionProofRequest;
  if (action.role === "sponsored") {
    const { signer } = spendable(ctx);
    progress(run, "signing", "Approve paying the relay fee for this claim.");
    const signed = action.sponsorship.authorize(await requestPcashAuthorization(signer, action.sponsorship.request));
    request = templateProofRequest(action, signed.witnessMap);
  } else {
    request = templateProofRequest(action);
  }
  progress(run, "proving", `Proving the ${action.application.label}…`);
  const proof = await run.prover.proveAssetAction(request, (status) => run.onProgress?.({ phase: "proving", message: status.message, proof: status }));
  const build = action.build;
  const entry = build.encodeTransaction(proof.proof);
  const ownedOutputs = params.ownedSlots.map((slot) => ({
    outputIndex: slot,
    assetId: build.assetId,
    amount: build.outputAmounts[slot]!,
    owner: ctx.profile.address,
    noteSecret: build.outputNoteSecrets[slot]!,
  }));
  if (action.role === "sponsored" && action.change !== null) {
    ownedOutputs.push({
      outputIndex: action.change.slot,
      assetId: 0n,
      amount: action.change.amount,
      owner: ctx.profile.address,
      noteSecret: action.change.noteSecret,
    });
  }
  const prepared = prepareAssetAction({
    build,
    transactionBytes: entry,
    ownedOutputs,
    ...(action.designatedIssuanceOpening === undefined ? {} : { designatedIssuanceOpening: action.designatedIssuanceOpening }),
  });
  // The contract owns the spent notes; this wallet only receives.
  prepared.pending.owner = null;
  if (params.claimLinkRecipient !== undefined) prepared.pending.claimLinkRecipient = addressHex(params.claimLinkRecipient);
  const status = await ctx.node.status();
  const preparedSubmission = await run.submission.preflight({ transactionBytes: entry, status, retry: false });
  const result = await submitPreparedAssetAction({
    node: ctx.node,
    store: ctx.store,
    data: await walletData(ctx),
    status,
    preparedAction: prepared,
    submission: run.submission,
    preparedSubmission,
    callbacks: durableCallbacks(run),
    settlePollIntervalMs: ctx.settlePollIntervalMs,
    settlePollMaxAttempts: ctx.settlePollMaxAttempts,
    synchronize: ctx.synchronize,
  });
  return submitted(result, action.role);
}

/**
 * Resubmit this wallet's journaled action that spends any of `nullifiers`,
 * byte for byte, and report every nullifier it spends.
 */
export async function resumeTemplateAction<Prepared, Output>(
  run: TemplateRun<Prepared, Output>,
  nullifiers: readonly bigint[],
  claimLinkRecipient?: bigint,
): Promise<{ submission: TemplateSubmission; nullifiers: bigint[] } | null> {
  const { ctx } = run;
  const data = await walletData(ctx);
  const wanted = new Set<string>(nullifiers.map(bytes32Hex));
  const pending = data.pendingAssetActions?.find((action) =>
    action.inputs.some((input) => wanted.has(input.nullifier.toLowerCase())));
  if (pending === undefined) return null;
  if (claimLinkRecipient !== undefined && !sameHex(pending.claimLinkRecipient, addressHex(claimLinkRecipient))) {
    throw new TokensError("claim-recipient-mismatch", "This link already has a pending claim to another recipient. Retry with the original recipient.");
  }
  progress(run, "submitting", "Resuming the saved transaction…");
  const result = await submitPendingAssetAction({
    node: ctx.node,
    store: ctx.store,
    data,
    status: await ctx.node.status(),
    pending,
    submission: run.submission,
    callbacks: durableCallbacks(run),
  });
  return {
    submission: submitted(result, BigInt(pending.openFeeAmount) === 0n ? "transfer" : "sponsored"),
    nullifiers: pending.inputs.map((input) => BigInt(input.nullifier)),
  };
}

/** Wait until a relayed action is included. */
export async function awaitIncluded<Prepared, Output>(run: TemplateRun<Prepared, Output>, submission: TemplateSubmission): Promise<TemplateSubmission> {
  if (submission.accepted) return submission;
  progress(run, "confirming", "Waiting for a relayer to include the transaction…");
  await awaitAcceptedReceipt(run.ctx.node, submission.contentHash, {
    pollIntervalMs: run.pollIntervalMs,
    pollMaxAttempts: run.pollMaxAttempts,
  });
  return { ...submission, accepted: true, queued: false };
}

/** Submit the contract side through the wallet's single fee-sponsorship path. */
export async function submitSponsoredTemplate<Prepared, Output>(
  rt: TokensRuntime<Prepared, Output>,
  intent: SponsoredContractAssetActionIntent,
  { onProgress, onPrepared }: TokensActionCallbacks = {},
): Promise<TemplateSubmission> {
  const result = await rt.wallet.sponsorContractAction({
    ...intent,
    ...(rt.submission === undefined ? {} : { submission: rt.submission }),
    ...(onProgress === undefined ? {} : { onProgress: (phase, message) => onProgress({ phase, message }) }),
    ...(onPrepared === undefined ? {} : { onPrepared }),
  });
  if (!result.accepted) {
    notify(onProgress, "confirming", "Waiting for a relayer to include the transaction…");
    await awaitAcceptedReceipt(rt.node, result.contentHash, {
      pollIntervalMs: rt.pollIntervalMs,
      pollMaxAttempts: rt.pollMaxAttempts,
    });
  }
  return { contentHash: result.contentHash, accepted: true, queued: false, role: "sponsored" };
}
