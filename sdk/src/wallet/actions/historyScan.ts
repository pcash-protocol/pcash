// History behind the block a wallet opened at, scanned newest first while the
// wallet stays usable. A wallet opened at the current block scans back to
// genesis; one that moved there from an older store scans back to where that
// store ended. While the scan is pending the live wallet keeps every spend it
// sees, and the scan records every spend it reads, so each chunk's notes are
// committed with their final spend status.

import type { OutputResult, PcashNodeClient } from "@pcash/sdk/clients";
import { extendOutputWitness, frontierBeforeLeaf, OutputWitnessTree } from "@pcash/sdk/crypto";
import { directSendOutputKey, noteNk, ownerCommitment, type WalletProfileWithReceiveKeys } from "@pcash/sdk/protocol";
import type { ChainBlock } from "../chainState.ts";
import { directSendOpenings } from "../directSends.ts";
import { mergeRecoveredWalletNotes, type StoredSentOutput, type WalletNote } from "../noteStore.ts";
import { receiveKeyPairs } from "../receiveKeyring.ts";
import { WALLET_SYNC_RESOURCE, withWalletReservation } from "../reservations.ts";
import type { WalletStateStore } from "../store.ts";
import {
  addSentOutputs,
  eventLoopSlicer,
  foldRecoveredNotes,
  HISTORY_CHUNK_OUTPUTS,
  noteNullifier,
  outputConsumption,
  outputFeed,
  recordSentRegions,
  scanFeed,
  scanOutputPages,
  type KnownPayoutOpening,
  type OutputScanReport,
  type TrialDecrypt,
} from "./scan.ts";
import { retryWhileSyncConflict } from "./syncConflictRetry.ts";

/**
 * Scan the outputs a head-first wallet skipped, newest chunk first, committing
 * each chunk to the live wallet. Returns once nothing is left to scan. A failed
 * attempt keeps every committed chunk, and the next one continues below them.
 */
export async function scanHistory(params: {
  node: PcashNodeClient;
  wallet: WalletProfileWithReceiveKeys & { outgoingKey?: Uint8Array };
  chainId: bigint;
  store: WalletStateStore;
  signal?: AbortSignal;
  trialDecrypt?: TrialDecrypt;
  /** Outputs scanned, of all this scan covers. */
  onOutputs?: (scanned: bigint, total: bigint) => void;
  /** Outputs per chunk; every wallet uses `HISTORY_CHUNK_OUTPUTS`. */
  chunkOutputs?: bigint;
}): Promise<void> {
  const { node, store, wallet, chainId } = params;
  const chunkOutputs = params.chunkOutputs ?? HISTORY_CHUNK_OUTPUTS;
  const nk = noteNk(wallet.nkRoot);
  let span: { top: bigint; end: bigint } | undefined;
  for (;;) {
    params.signal?.throwIfAborted();
    const target = await store.readChain((chain) => chain?.synced ?? null);
    const data = await store.load();
    if (data?.historyReplayRequired !== true || target === null || data.historyStartOutputIndex === undefined) return;
    const top = BigInt(data.historyStartOutputIndex);
    const end = BigInt(data.historyScanEndOutputIndex ?? "0");
    // A reorganization deeper than the wallet's checkpoints restarts the scan.
    if (span === undefined || top > span.top) span = { top, end };
    const from = top <= end ? top : maxBigInt(end, ((top - 1n) / chunkOutputs) * chunkOutputs);

    // Payouts match the owner openings the wallet holds, and those the chunk's own notes and sender regions reveal.
    const directOpenings = new Map(directSendOpenings(data)
      .filter((opening) => opening.owner === wallet.address && opening.chainId === chainId)
      .map((opening) => [directSendOutputKey(opening), opening]));
    const openings = new Map<bigint, KnownPayoutOpening>([
      ...data.notes.filter((note) => !note.pending).map((note) => ({ owner: BigInt(note.owner), noteSecret: BigInt(note.noteSecret) })),
      ...directOpenings.values(),
    ].map(({ owner, noteSecret }) => [ownerCommitment(owner, noteSecret), { owner, noteSecret }]));
    const pages: { report: OutputScanReport; outputs: readonly OutputResult[] }[] = [];
    if (from < top) {
      await scanOutputPages({
        node,
        fromOutputIndex: from,
        endOutputIndex: top,
        target,
        chainId,
        mlKemSecretKeys: [wallet.mlKemSecretKey, ...receiveKeyPairs(data).map((pair) => pair.secretKey)],
        owners: [wallet.address],
        recoveryWallet: wallet,
        ...(wallet.outgoingKey === undefined ? {} : { outgoingKey: wallet.outgoingKey }),
        knownPayoutOpenings: openings,
        directSendOpenings: directOpenings,
        ...(params.signal === undefined ? {} : { signal: params.signal }),
        ...(params.trialDecrypt === undefined ? {} : { trialDecrypt: params.trialDecrypt }),
        onPage: (report, outputs) => { pages.push({ report, outputs }); },
      });
    }
    const rows = pages.flatMap((page) => page.outputs);
    // The node's word on the target's output count is not checked, so a short
    // answer must not let the scan skip the end of the chunk.
    if (from < top && rows.at(-1)?.outputIndex !== top - 1n) throw new Error("the node's history chunk stops short of its end");
    // Pages are read oldest first, so a sender region can reveal a direct send
    // whose funding output an earlier page of the chunk already passed.
    const scanned = new Set(pages.flatMap((page) => page.report.recovered.map((note) => note.leafIndex)));
    const funding = new Set(rows.filter((row) => row.kind === "ordinary" && !scanned.has(row.outputIndex)
      && directOpenings.has(directSendOutputKey({ contentHash: row.contentHash, slot: row.outputSlot }))).map((row) => row.outputIndex));
    if (funding.size > 0) {
      const report = await scanFeed({
        chainId, mlKemSecretKeys: [], owners: [wallet.address], recoveryWallet: wallet, directSendOpenings: directOpenings,
        feed: outputFeed(rows).filter((item) => funding.has(item.leafIndex)),
      });
      pages.push({ report: { ...report, sent: [], transactionRecords: [] }, outputs: rows });
    }
    const recoveredLeaves = new Set(pages.flatMap((page) => page.report.recovered.map((note) => note.leafIndex)));
    const start = rows[0]?.outputIndex ?? top;

    const committed = await retryWhileSyncConflict(() => withWalletReservation(store, [WALLET_SYNC_RESOURCE], (reservation) =>
      store.chainStep(async (chain) => {
        params.signal?.throwIfAborted();
        const current = await store.load();
        if (chain === null || current?.historyReplayRequired !== true || current.historyStartOutputIndex !== top.toString()) return false;
        // The rows came from `target`'s chain; a reorganization since may have replaced it.
        if (!sameBlock(chain.synced, target) && !chain.checkpoints().some((checkpoint) => sameBlock(checkpoint, target))) return false;
        const slice = eventLoopSlicer();
        const notes: WalletNote[] = [];
        if (rows.length > 0) {
          const first = rows[0]!;
          const last = rows.at(-1)!;
          // The first output's opening gives the frontier before the chunk; the
          // last one's checks every leaf read and carries the chunk's notes to
          // the live tree. Both are the same for every wallet reading this chunk.
          const opened = await node.getOutputPaths((first === last ? [first] : [first, last])
            .map((row) => ({ outputIndex: row.outputIndex, outputCommitment: BigInt(row.outputCommitment) })));
          if (opened === null) throw new Error("the node cannot open the history chunk");
          const edge = { index: last.outputIndex, commitment: BigInt(last.outputCommitment), siblings: opened.paths.at(-1)!.siblings };
          const chunk = new OutputWitnessTree(frontierBeforeLeaf(first.outputIndex, opened.paths[0]!.siblings));
          for (const row of rows) {
            await slice();
            chunk.append(BigInt(row.outputCommitment), recoveredLeaves.has(row.outputIndex) || row === last);
            if (row.kind !== "ordinary") continue;
            for (const spent of row.nullifiers) {
              if (!chain.consumed.has(spent.toLowerCase())) chain.recordConsumption(spent, outputConsumption(row));
            }
          }
          const read = chunk.witness(last.outputIndex);
          if (read.some((sibling, h) => ((last.outputIndex >> BigInt(h)) & 1n) === 1n && sibling !== edge.siblings[h])) {
            throw new Error("the history chunk does not match the node's output tree");
          }
          for (const page of pages) {
            for (const note of foldRecoveredNotes(current, page.report.recovered, page.outputs)) {
              await slice();
              const index = BigInt(note.leafIndex!);
              if (!chain.outputs.isMarked(index)
                && !chain.outputs.markPath(index, BigInt(note.commitment!), extendOutputWitness(index, chunk.witness(index), edge))) {
                throw new Error("a history note does not open the live output tree");
              }
              notes.push(note);
            }
          }
        }
        mergeRecoveredWalletNotes(current, notes);
        const sent: StoredSentOutput[] = [];
        for (const page of pages) recordSentRegions(current, page.report, page.outputs, sent, wallet.address, chainId);
        addSentOutputs(current, sent);
        const records = pages.flatMap((page) => page.report.transactionRecords);
        if (records.length > 0) current.transactionRecords = [...current.transactionRecords ?? [], ...records];
        for (const note of current.notes) {
          await slice();
          if (!note.pending && note.commitment !== null) note.spent = chain.consumed.has(noteNullifier(note, nk));
        }
        if (start <= end) {
          delete current.historyReplayRequired;
          delete current.historyScanEndOutputIndex;
          current.historyStartOutputIndex = "0";
          current.historyRevision = (BigInt(current.historyRevision ?? "0") + 1n).toString();
          // History now reaches genesis: a reorganization past every checkpoint rescans from there.
          chain.birthday = { pcashNumber: 0n, pcashHash: current.network.genesisHash.toLowerCase(), outputCount: 0n };
        } else {
          current.historyStartOutputIndex = start.toString();
        }
        await reservation.save(current, { chain: { state: chain, commit: chain.commitChanges() } });
        return true;
      })));
    if (committed) params.onOutputs?.(span.top - maxBigInt(start, span.end), span.top - span.end);
  }
}

function sameBlock(left: ChainBlock, right: ChainBlock): boolean {
  return left.pcashNumber === right.pcashNumber && left.pcashHash.toLowerCase() === right.pcashHash.toLowerCase();
}

function maxBigInt(left: bigint, right: bigint): bigint {
  return left > right ? left : right;
}
