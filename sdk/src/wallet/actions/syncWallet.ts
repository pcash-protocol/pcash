// One durable wallet synchronization path shared by every platform. A host
// contributes only its store backend.

import type { PcashNodeClient, StatusResult } from "@pcash/sdk/clients";
import type { FieldNumberish } from "@pcash/sdk/crypto";
import { toNonnegativeBigInt } from "@pcash/sdk/crypto";
import type { WalletProfileWithReceiveKeys } from "@pcash/sdk/protocol";
import { isPcashProfile } from "../walletCapabilities.ts";
import { assertPcashProfileMatchesAccountIdentity, type PcashProfileAccountView } from "../externalIdentity.ts";
import type { WalletStateStore } from "../store.ts";
import type { WalletFileData } from "../noteStore.ts";
import { loadWalletStateOrEmpty } from "../store.ts";
import { reconcilePendingWalletActions } from "./clientReconciliation.ts";
import { assertWalletCanAnchorAtCurrentBoundary } from "./scan.ts";
import { assertWalletStoreMatches } from "./walletSession.ts";
import { synchronizeWalletInventory, type WalletInventorySyncReport } from "./scan.ts";
import {
  FULL_RESCAN_RESOURCE,
  WALLET_SYNC_RESOURCE,
  withWalletReservation,
  type WalletReservation,
} from "../reservations.ts";

interface SyncWalletParams {
  node: PcashNodeClient;
  /** With an outgoing key, synchronization also reopens what the wallet sent. */
  wallet: WalletProfileWithReceiveKeys & { outgoingKey?: Uint8Array };
  chainId: FieldNumberish;
  store: WalletStateStore;
  /** Freeze the scan here instead of at the node's current head. */
  target?: { pcashNumber: bigint; pcashHash: string };
  /** A status the caller just read, used in place of the opening status read. */
  status?: StatusResult;
  /** Replace the local chain state and every confirmed note, then replay outputs from genesis. */
  rescan?: boolean;
  /** Declare a freshly generated wallet live at the current output boundary. */
  anchorAtCurrentBoundary?: boolean;
  onProgress?: (progress: {
    phase: "preparing" | "scanning" | "reconciling";
    syncedThrough?: { pcashNumber: bigint; pcashHash: string };
  }) => void;
  onNodeTip?: (nodeTip: bigint) => void;
}

export interface SyncWalletResult extends WalletInventorySyncReport {
  /** The synchronized inventory, already durable. */
  data: WalletFileData;
}

function replaceData(target: WalletFileData, next: WalletFileData): void {
  const targetRecord = target as unknown as Record<string, unknown>;
  for (const key of Object.keys(targetRecord)) delete targetRecord[key];
  Object.assign(targetRecord, structuredClone(next));
}

/**
 * Advance the local chain state and inventory to the frozen boundary, then
 * settle pending actions against it. Resolves only once the complete result
 * is durable.
 */
export async function syncWallet(params: SyncWalletParams): Promise<SyncWalletResult> {
  const chainId = toNonnegativeBigInt(params.chainId, "chainId");
  const { node, store } = params;
  const rescan = params.rescan === true || (await store.load())?.fullRescanRequired === true;
  if (rescan && params.anchorAtCurrentBoundary === true) {
    throw new Error("current-boundary initialization cannot be combined with a historical rescan");
  }
  const synchronize = async (reservation: WalletReservation): Promise<SyncWalletResult> => {
    params.onProgress?.({ phase: "preparing" });
    const status = params.status ?? await node.status();
    params.onNodeTip?.(status.latestBlock);
    // Before anything is read, reconciled, or folded: this store must be the one
    // that belongs to this wallet on this node's chain and genesis.
    assertWalletStoreMatches(store, params.wallet, chainId, status);

    // The store binds the document to its (address, chainId, genesisHash) on
    // read, so a document surviving this load is already this network's; an
    // absent one is created under the wallet being synced, not the store's own
    // binding, so a store bound elsewhere fails rather than adopting it.
    const data = await loadWalletStateOrEmpty(store, {
      address: params.wallet.address,
      network: { chainId, genesisHash: status.genesisHash },
    });

    if (params.anchorAtCurrentBoundary === true) {
      assertWalletCanAnchorAtCurrentBoundary(data, reservation.reservationId);
    }

    const wallet = params.wallet;
    const report = await synchronizeWalletInventory(node, wallet, chainId, data, {
      store,
      status,
      ...(rescan ? { rescan: true } : {}),
      ...(params.target === undefined ? {} : { target: params.target }),
      ...(params.anchorAtCurrentBoundary === true ? { anchorAtTarget: true } : {}),
      ...(params.anchorAtCurrentBoundary === true ? { anchorReservationId: reservation.reservationId } : {}),
      // A restored profile must still agree with its current account before
      // anything is decrypted against it: a profile whose nullifier-key
      // commitment no longer matches would silently recover nothing and report
      // a clean scan. Only the reference profile can be checked this way.
      ...(isPcashProfile(wallet) ? {
        assertAccount: (account: PcashProfileAccountView | null) => {
          if (account !== null) {
            assertPcashProfileMatchesAccountIdentity(wallet, account);
          }
        },
      } : {}),
      persist: async (next, chain) => {
        const before = structuredClone(data);
        replaceData(data, next);
        try {
          await reservation.save(data, { chain });
          return structuredClone(data);
        } catch (error) {
          replaceData(data, before);
          throw error;
        }
      },
    });
    params.onProgress?.({ phase: "scanning", syncedThrough: report.syncedThrough });

    params.onProgress?.({ phase: "reconciling" });
    await store.readChain((chain) => reconcilePendingWalletActions(data, chain, status));
    if (rescan) delete data.fullRescanRequired;
    await reservation.save(data);
    return { ...report, data };
  };
  return withWalletReservation(
    store,
    rescan
      ? [WALLET_SYNC_RESOURCE, FULL_RESCAN_RESOURCE]
      : [WALLET_SYNC_RESOURCE],
    synchronize,
  );
}
