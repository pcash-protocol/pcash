import { type PcashNodeClient, type StatusResult } from "@pcash/sdk/clients";
import { privateValueProfile } from "@pcash/sdk/constants";
import {
  decodeTransactionForChain, RECENT_PCASH_BLOCK_WINDOW_SECONDS, sectionPublicInput,
  transactionIdentity, transactionPublication, type WalletProfile, type RawUserAccountCreation,
} from "@pcash/sdk/protocol";
import { bytes32Hex, fromHex, toHex } from "@pcash/sdk/utils";
import {
  addPendingAssetAction, type PendingAssetAction, type WalletFileData, type WalletNote,
} from "../noteStore.ts";
import { noteResource, withWalletReservation } from "../reservations.ts";
import type { WalletStateStore } from "../store.ts";
import { noteNullifier } from "./publication.ts";
import { resolveValueTransaction } from "./clientReconciliation.ts";
import { reconcileL1Publication, submitDurableAction, type DurableSubmissionAdapter, type DurableSubmissionCallbacks } from "./durableSubmission.ts";
import { acceptedReceiptOfKind, assertWalletStoreMatches } from "./walletSession.ts";

export interface ResumeValueTransactionIntent<Prepared = unknown, Output = unknown> {
  transactionHex: string;
  submission?: DurableSubmissionAdapter<Prepared, Output>;
  beforeSubmit?: () => void | Promise<void>;
  onProgress?: NonNullable<DurableSubmissionCallbacks["onProgress"]>;
}

export interface ResumeValueTransactionResult {
  state: "accepted" | "pending" | "blocked" | "rebuildable";
  contentHash: string;
  /** Exact bytes acknowledged by the mempool; relay eligibility may change before publication. */
  queued?: boolean;
  message?: string;
}

function journalKind(data: WalletFileData, contentHash: string): "noteFundedTransfer" | "assetAction" | undefined {
  if (data.pendingNoteFundedTransfers?.some(item => item.contentHash.toLowerCase() === contentHash)) return "noteFundedTransfer";
  if (data.pendingAssetActions?.some(item => item.contentHash.toLowerCase() === contentHash)) return "assetAction";
  return undefined;
}

/** Resume exact wallet-funded value bytes; rebuilding requires irreversible canonical evidence. */
export async function resumeValueTransaction<Prepared, Output>(params: {
  transactionHex: string;
  node: PcashNodeClient;
  store: WalletStateStore;
  wallet: WalletProfile;
  chainId: bigint;
  submission: DurableSubmissionAdapter<Prepared, Output>;
  beforeSubmit?: () => void | Promise<void>;
  callbacks?: DurableSubmissionCallbacks;
  synchronize(): Promise<unknown>;
}): Promise<ResumeValueTransactionResult> {
  const bytes = fromHex(params.transactionHex);
  const decoded = decodeTransactionForChain(bytes, params.chainId);
  if (decoded.kind !== 0) throw new Error("exact value resumption requires a private-value transaction");
  const { contentHash, transactionHex } = transactionIdentity(bytes);
  const reply = (state: ResumeValueTransactionResult["state"], message?: string): ResumeValueTransactionResult =>
    ({ state, contentHash, ...(message === undefined ? {} : { message }) });
  const node = params.submission.node ?? params.node;
  const initialStatus = await node.status();
  assertWalletStoreMatches(params.store, params.wallet, params.chainId, initialStatus);
  const accepted = () => acceptedReceiptOfKind(node, contentHash, "privateValue", "saved value transaction");
  if (await accepted()) return reply("accepted");
  const publication = transactionPublication(decoded)!;
  const offsets = privateValueProfile(decoded.shape).offsets;
  const nullifiers = publication.nullifiers.map(bytes32Hex);
  const validUntil = sectionPublicInput(decoded, offsets.validUntil);
  const anchorHash = bytes32Hex(sectionPublicInput(decoded, 1));
  const creation = decoded.accountCreation?.kind === "user"
    ? decodeTransactionForChain(decoded.accountCreation.transactionBytes, params.chainId) as RawUserAccountCreation
    : undefined;
  const inspect = async (data: WalletFileData, current: StatusResult) => params.store.readChain(chain => {
    if (chain === null) return null;
    const retainedKind = journalKind(data, contentHash);
    const notes = new Map<string, WalletNote>();
    for (const note of retainedKind === undefined ? data.notes : []) {
      if (note.pending || note.commitment === null || note.leafIndex === null) continue;
      const key = bytes32Hex(noteNullifier(params.wallet.nkRoot, note));
      if (nullifiers.includes(key)) notes.set(key, note);
    }
    const resolution = resolveValueTransaction(chain, current, contentHash, nullifiers, validUntil.toString());
    const finalized = data.finalizedThrough;
    return {
      notes, retainedKind,
      resolution,
      // Confirmed notes come from chronological scanning or a direct-send historical replay.
      covered: retainedKind !== undefined || notes.size !== 0,
      aligned: data.syncedThrough !== undefined
        && BigInt(data.syncedThrough.blockNumber) === chain.synced.pcashNumber
        && data.syncedThrough.blockHash.toLowerCase() === chain.synced.pcashHash.toLowerCase(),
      finalized: chain.synced.pcashNumber >= current.finalizedBlock && finalized !== undefined
        && BigInt(finalized.blockNumber) >= current.finalizedBlock
        && (BigInt(finalized.blockNumber) !== current.finalizedBlock
          || finalized.blockHash.toLowerCase() === current.finalizedBlockHash.toLowerCase()),
    };
  });
  const readContext = async (knownStatus?: StatusResult) => {
    const status = knownStatus ?? await node.status();
    assertWalletStoreMatches(params.store, params.wallet, params.chainId, status);
    const anchor = await node.getBlockByHash(anchorHash);
    let stale = anchor === null || status.latestBlockTimestamp > validUntil
      || status.latestBlockTimestamp - anchor.timestamp > RECENT_PCASH_BLOCK_WINDOW_SECONDS;
    if (creation !== undefined) {
      const hash = toHex(creation.recentPcashBlockHash);
      const userAnchor = hash === anchorHash ? anchor : await node.getBlockByHash(hash);
      stale ||= userAnchor === null || status.latestBlockTimestamp > creation.validUntilTimestamp
        || status.latestBlockTimestamp - userAnchor.timestamp > RECENT_PCASH_BLOCK_WINDOW_SECONDS;
    }
    const { inFlight, carrying } = await reconcileL1Publication(params.submission, contentHash);
    const data = await params.store.load();
    return { status, stale, inFlight, carrying, data, inspected: data === null ? null : await inspect(data, status) };
  };
  const classify = ({ stale, inFlight, carrying, inspected }: Awaited<ReturnType<typeof readContext>>): ResumeValueTransactionResult | undefined => {
    if (inFlight && (stale || carrying?.transactionHash === null || carrying === undefined)) {
      return reply("blocked", "The earlier Ethereum submission is unresolved. Review it before preparing another transaction.");
    }
    if (inspected === null || !inspected.aligned) return reply("blocked", "Wallet synchronization changed. Synchronize and retry.");
    if (inspected.resolution.state !== "expired" && inspected.resolution.ours !== undefined) {
      return reply("pending", "The wallet has observed this transaction. Waiting for its receipt.");
    }
    if (!inspected.covered) {
      return reply("blocked", "Rescan wallet history to recover this transaction's funding notes before resuming it.");
    }
    if (inspected.finalized && (inspected.resolution.state === "expired" || inspected.resolution.state === "settled")) {
      return inFlight ? reply("blocked", "The earlier Ethereum submission is unresolved. Review it before preparing another transaction.") : reply("rebuildable");
    }
    if (inspected.resolution.state === "pending" && inspected.resolution.first !== undefined) {
      return reply("blocked", "A competing transaction is not finalized. Synchronize after finality before replacing these bytes.");
    }
    if (stale) {
      return reply("blocked", inspected.finalized
        ? "The saved proof is stale. Wait for its deadline or a competing spend to finalize, then synchronize and retry."
        : "Synchronize through the finalized chain before replacing the saved transaction.");
    }
    return undefined;
  };
  const decision = classify(await readContext(initialStatus));
  if (decision !== undefined) return decision;

  return withWalletReservation(params.store, nullifiers.map(noteResource), async reservation => {
    // Re-read under the lease: a different tab may have changed the transport or synced fork.
    const context = await readContext();
    const decision = classify(context);
    if (decision !== undefined) return decision;
    const { status, carrying } = context;
    const current = context.data!;
    const live = context.inspected!;
    if (live.retainedKind === undefined) {
      const asset = [...live.notes.values()].find(note => BigInt(note.assetId) !== 0n)?.assetId ?? bytes32Hex(0n);
      const recovered: PendingAssetAction = {
        contentHash, transactionHex, owner: null, assetId: asset,
        notBeforeTimestamp: sectionPublicInput(decoded, offsets.notBefore).toString(),
        validUntilTimestamp: validUntil.toString(), openFeeAmount: publication.openFeeAmount.toString(),
        issuanceOwnerCommitment: publication.issuanceOwnerCommitment.toString(),
        inputs: nullifiers.map(nullifier => ({ nullifier, spentCommitment: live.notes.get(nullifier)?.commitment ?? null })),
        ownedOutputs: [],
      };
      addPendingAssetAction(current, recovered);
      await reservation.save(current);
    }
    if (carrying?.transactionHash) return { ...reply("pending", "Waiting for the saved Ethereum publication."), queued: false };
    const kind = live.retainedKind ?? "assetAction";
    const submission = params.beforeSubmit === undefined ? params.submission : {
      ...params.submission,
      submit: async (context: Parameters<DurableSubmissionAdapter<Prepared, Output>["submit"]>[0]) => {
        await params.beforeSubmit!();
        return params.submission.submit(context);
      },
    };
    const result = await submitDurableAction({
      node, store: params.store, data: current, status,
      action: { contentHash, transactionHex, kind }, submission, reservation,
      state: { retry: true }, ...(params.callbacks === undefined ? {} : { callbacks: params.callbacks }),
      isAccepted: accepted, isPending: snapshot => journalKind(snapshot, contentHash) !== undefined,
      synchronize: params.synchronize, settlePollMaxAttempts: 1,
    });
    return { ...reply(result.accepted ? "accepted" : "pending"), queued: params.submission.mode === "mempool" && result.queued };
  }, { allowPendingContentHash: contentHash });
}
