// History before the block a wallet opened at, scanned while the wallet stays
// usable. A replay from genesis runs in its own in-memory store as the live
// wallet keeps following the head. Once the replay stands at the live wallet's
// block, its chain state and scanned inventory replace the live ones in one
// commit, leaving the wallet as if it had replayed from genesis itself.

import type { PcashNodeClient } from "@pcash/sdk/clients";
import { decodeDirectSendOpening, directSendOutputKey, type WalletProfileWithReceiveKeys } from "@pcash/sdk/protocol";
import { fromHex, sleep } from "@pcash/sdk/utils";
import { replacingChainCommit, type ChainBlock } from "../chainState.ts";
import { addDirectSendOpening, directSendOpenings, dropDirectSendRecords } from "../directSends.ts";
import { memoryWalletStateStore } from "../memoryStoreBackend.ts";
import { mergeRecoveredWalletNotes, type WalletFileData } from "../noteStore.ts";
import { WALLET_SYNC_RESOURCE, withWalletReservation } from "../reservations.ts";
import { emptyWalletState, type WalletStateStore } from "../store.ts";
import type { TrialDecrypt } from "./scan.ts";
import { retryWhileSyncConflict } from "./syncConflictRetry.ts";
import { syncWallet } from "./syncWallet.ts";

const INDEX_BEHIND_RETRY_MS = 2_000;

export type HistoryReplayStore = ReturnType<typeof memoryWalletStateStore>;

/** An empty store for one wallet's replay, kept across attempts so a retry continues it. */
export function historyReplayStore(live: WalletStateStore): HistoryReplayStore {
  return memoryWalletStateStore(emptyWalletState(live.identity));
}

function sameBlock(left: ChainBlock, right: ChainBlock): boolean {
  return left.pcashNumber === right.pcashNumber && left.pcashHash.toLowerCase() === right.pcashHash.toLowerCase();
}

/**
 * Replace what scanning derived in `data` with what a replay derived over the
 * same blocks. Pending actions, payment history, and keys stay.
 */
function adoptReplayedHistory(data: WalletFileData, replayed: WalletFileData): void {
  data.notes = data.notes.filter((note) => note.pending);
  mergeRecoveredWalletNotes(data, replayed.notes);
  if (replayed.sentOutputs === undefined) delete data.sentOutputs;
  else data.sentOutputs = replayed.sentOutputs;
  if (replayed.transactionRecords === undefined) delete data.transactionRecords;
  else data.transactionRecords = replayed.transactionRecords;
  dropDirectSendRecords(data, 0n);
  for (const stored of replayed.directSendOpenings ?? []) {
    addDirectSendOpening(data, decodeDirectSendOpening(fromHex(stored.opening)), stored.record);
  }
  for (const asset of replayed.assets ?? []) {
    const assets = data.assets ??= [];
    if (!assets.some((held) => held.assetId.toLowerCase() === asset.assetId.toLowerCase())) assets.push(asset);
  }
  data.historyStartOutputIndex = "0";
  data.historyRevision = (BigInt(data.historyRevision ?? "0") + 1n).toString();
  delete data.historyReplayRequired;
}

/**
 * Advance `replay` to the live wallet's synced block and adopt it there,
 * repeating while the live wallet moves on. Returns once the live wallet no
 * longer needs a replay: adopted here, or replaced by a full rescan.
 */
export async function replayHistory(params: {
  node: PcashNodeClient;
  wallet: WalletProfileWithReceiveKeys & { outgoingKey?: Uint8Array };
  chainId: bigint;
  store: WalletStateStore;
  replay: HistoryReplayStore;
  signal?: AbortSignal;
  trialDecrypt?: TrialDecrypt;
  /** Outputs the replay has read, of the live wallet's synced output count. */
  onOutputs?: (scanned: bigint, total: bigint) => void;
}): Promise<void> {
  const { store, replay } = params;
  for (;;) {
    params.signal?.throwIfAborted();
    // The target first: a document read after it holds every key and direct
    // send the live wallet had when it synchronized there.
    const target = await store.readChain((chain) => chain?.synced ?? null);
    const live = await store.load();
    if (live?.historyReplayRequired !== true || target === null) return;
    // What the live wallet decrypts and matches with, including keys and
    // direct sends it learned after the replay began.
    await replay.transaction((current) => {
      const data = current!;
      for (const key of live.receiveKeys) {
        if (!data.receiveKeys.some((held) => held.receiveKeyHash === key.receiveKeyHash)) data.receiveKeys.push(key);
      }
      for (const stored of live.directSendOpenings ?? []) addDirectSendOpening(data, decodeDirectSendOpening(fromHex(stored.opening)));
      return { data, value: undefined };
    });
    const from = await replay.readChain((chain) => chain?.outputs.count ?? 0n);
    const { syncedThrough } = await syncWallet({
      node: params.node,
      wallet: params.wallet,
      chainId: params.chainId,
      store: replay,
      target,
      ...(params.signal === undefined ? {} : { signal: params.signal }),
      ...(params.trialDecrypt === undefined ? {} : { trialDecrypt: params.trialDecrypt }),
      onProgress: ({ outputs }) => {
        if (outputs !== undefined) params.onOutputs?.(from + outputs.scanned, from + outputs.total);
      },
    });
    if (!sameBlock(syncedThrough, target)) {
      // The replay already stands past the target: the live wallet rewound to a
      // block the node's index has not caught up with again.
      await sleep(INDEX_BEHIND_RETRY_MS, params.signal);
      continue;
    }
    params.signal?.throwIfAborted();
    const settled = await retryWhileSyncConflict(() => withWalletReservation(store, [WALLET_SYNC_RESOURCE], (reservation) =>
      store.chainStep(async (chain) => {
        const data = await store.load();
        if (data?.historyReplayRequired !== true) return true;
        if (chain === null || !sameBlock(chain.synced, target)) return false;
        const replayed = replay.snapshot()!;
        // A direct send imported since the replay copied them can already be
        // recovered here at this block: the replay resolves it first.
        const copied = new Set(directSendOpenings(replayed).map(directSendOutputKey));
        if (directSendOpenings(data).some((opening) => !copied.has(directSendOutputKey(opening)))) return false;
        const replacement = replacingChainCommit(replay.chainSnapshot(), chain);
        adoptReplayedHistory(data, replayed);
        await reservation.save(data, { chain: replacement });
        return true;
      })));
    if (settled) return;
  }
}
