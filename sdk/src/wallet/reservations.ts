import { WalletConflictError, type WalletSaveOptions, type WalletStateStore } from "./store.ts";
import type {
  PendingAssetAction,
  WalletFileData,
  WalletResourceReservation,
} from "./noteStore.ts";
import { emptyWalletState } from "./store.ts";

const DEFAULT_WALLET_RESERVATION_TTL_MS = 30_000;
export const FULL_RESCAN_RESOURCE = "wallet:full-rescan";
export const WALLET_SYNC_RESOURCE = "wallet:sync";

let reservationSequence = 0;

function reservationId(): string {
  reservationSequence += 1;
  return `${Date.now().toString(36)}-${processId()}-${reservationSequence.toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function processId(): string {
  const processValue = (globalThis as { process?: { pid?: number } }).process;
  return String(processValue?.pid ?? "realm");
}

function freshData(data: WalletFileData | null, store: WalletStateStore): WalletFileData {
  return data ?? emptyWalletState(store.identity);
}

function overlaps(left: readonly string[], right: readonly string[]): boolean {
  if (left.includes(FULL_RESCAN_RESOURCE) || right.includes(FULL_RESCAN_RESOURCE)) return true;
  const rightSet = new Set(right);
  return left.some((resource) => rightSet.has(resource));
}

function pruneExpiredWalletReservations(data: WalletFileData, nowUnixMs = Date.now()): number {
  const current = data.resourceReservations ?? [];
  const retained = current.filter((reservation) => BigInt(reservation.expiresAtUnixMs) > BigInt(nowUnixMs));
  if (retained.length === 0) delete data.resourceReservations;
  else data.resourceReservations = retained;
  return current.length - retained.length;
}

interface WalletReservationOptions {
  ttlMs?: number;
  nowUnixMilliseconds?: () => number;
  reservationId?: string;
  /** Permit an exact retry to claim resources already journaled by this tx. */
  allowPendingContentHash?: string;
  /**
   * Apply the first durable action state in the same transaction that acquires
   * the resource fence. A thrown initializer commits neither the lease nor its
   * journal rows.
   */
  initialize?: (data: WalletFileData) => void;
}

export interface WalletReservation {
  readonly reservationId: string;
  readonly resources: readonly string[];
  assertActive(): Promise<void>;
  save(data: WalletFileData, options?: Pick<WalletSaveOptions, "chain">): Promise<void>;
  heartbeat(): Promise<void>;
  release(): Promise<void>;
}

export async function acquireWalletReservation(
  store: WalletStateStore,
  requestedResources: readonly string[],
  options: WalletReservationOptions = {},
): Promise<WalletReservation> {
  const resources = [...new Set(requestedResources)];
  if (resources.length === 0 || resources.some((resource) => resource.length === 0)) {
    throw new Error("a wallet reservation requires at least one nonempty resource");
  }
  const ttlMs = options.ttlMs ?? DEFAULT_WALLET_RESERVATION_TTL_MS;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 2) {
    throw new Error("wallet reservation ttlMs must be an integer of at least 2 milliseconds");
  }
  const now = options.nowUnixMilliseconds ?? Date.now;
  const id = options.reservationId ?? reservationId();
  await store.transaction((current) => {
    const data = freshData(current, store);
    const timestamp = now();
    pruneExpiredWalletReservations(data, timestamp);
    const reclaimingExactPending = options.allowPendingContentHash?.toLowerCase() === id.toLowerCase();
    const conflict = data.resourceReservations?.find((reservation) =>
      overlaps(resources, reservation.resources)
      && !(
        reclaimingExactPending
        && reservation.reservationId.toLowerCase() === id.toLowerCase()
        && reservation.resources.length === resources.length
        && reservation.resources.every((resource, index) => resource === resources[index])
      )
    );
    if (conflict !== undefined) {
      const conflicting = resources.filter((resource) =>
        conflict.resources.includes(resource)
          || conflict.resources.includes(FULL_RESCAN_RESOURCE)
          || resource === FULL_RESCAN_RESOURCE
      );
      throw new WalletConflictError(
        `wallet resources are reserved by another operation: ${conflicting.join(", ")}`,
        conflicting,
      );
    }
    if (!resources.includes(FULL_RESCAN_RESOURCE)) {
      const journaled = new Map<string, string>();
      for (const pending of data.pendingNoteFundedTransfers ?? []) {
        for (const input of pending.inputs) journaled.set(
          noteResource(input.nullifier),
          pending.contentHash,
        );
      }
      for (const pending of data.pendingAssetActions ?? []) {
        for (const resource of assetActionInputResources(pending)) journaled.set(resource, pending.contentHash);
      }
      for (const pending of data.pendingUserAccountUpdates ?? []) {
        journaled.set(accountResource(pending.address, pending.currentAccountRevision), pending.contentHash);
        for (const input of pending.inputs) {
          journaled.set(noteResource(input.nullifier), pending.contentHash);
        }
      }
      const occupied = resources.find((resource) => {
        const contentHash = journaled.get(resource);
        return contentHash !== undefined && contentHash.toLowerCase() !== options.allowPendingContentHash?.toLowerCase();
      });
      if (occupied !== undefined) {
        throw new WalletConflictError(
          `wallet resource is already journaled by another action: ${occupied}`,
          [occupied],
        );
      }
    }
    const reservation: WalletResourceReservation = {
      reservationId: id,
      resources,
      createdAtUnixMs: String(timestamp),
      heartbeatAtUnixMs: String(timestamp),
      expiresAtUnixMs: String(timestamp + ttlMs),
    };
    const existing = data.resourceReservations?.findIndex((item) => item.reservationId === id) ?? -1;
    if (existing < 0) (data.resourceReservations ??= []).push(reservation);
    else data.resourceReservations![existing] = reservation;
    options.initialize?.(data);
    return { data, value: undefined };
  });

  let released = false;
  return {
    reservationId: id,
    resources,
    async assertActive(): Promise<void> {
      if (released) throw new WalletConflictError("wallet resource reservation was released", resources);
      await store.transaction((current) => {
        const data = freshData(current, store);
        const timestamp = now();
        pruneExpiredWalletReservations(data, timestamp);
        const reservation = data.resourceReservations?.find((item) =>
          item.reservationId === id
          && item.resources.length === resources.length
          && item.resources.every((resource, index) => resource === resources[index])
        );
        if (reservation === undefined) {
          throw new WalletConflictError("wallet resource reservation is no longer active", resources);
        }
        return { data, value: undefined };
      });
    },
    async save(data: WalletFileData, options: Pick<WalletSaveOptions, "chain"> = {}): Promise<void> {
      if (released) throw new WalletConflictError("wallet resource reservation was released", resources);
      await store.save(data, {
        ...options,
        requiredReservation: {
          reservationId: id,
          resources,
          nowUnixMs: now(),
        },
      });
    },
    async heartbeat(): Promise<void> {
      if (released) return;
      await store.transaction((current) => {
        const data = freshData(current, store);
        const timestamp = now();
        pruneExpiredWalletReservations(data, timestamp);
        const reservation = data.resourceReservations?.find((item) => item.reservationId === id);
        if (reservation === undefined) {
          throw new WalletConflictError("wallet resource reservation expired", resources);
        }
        reservation.heartbeatAtUnixMs = String(timestamp);
        reservation.expiresAtUnixMs = String(timestamp + ttlMs);
        return { data, value: undefined };
      });
    },
    async release(): Promise<void> {
      if (released) return;
      released = true;
      await store.transaction((current) => {
        const data = freshData(current, store);
        const retained = data.resourceReservations?.filter((item) => item.reservationId !== id) ?? [];
        if (retained.length === 0) delete data.resourceReservations;
        else data.resourceReservations = retained;
        return { data, value: undefined };
      });
    },
  };
}

export async function withWalletReservation<T>(
  store: WalletStateStore,
  resources: readonly string[],
  operation: (reservation: WalletReservation) => Promise<T>,
  options: WalletReservationOptions = {},
): Promise<T> {
  const reservation = await acquireWalletReservation(store, resources, options);
  const ttlMs = options.ttlMs ?? DEFAULT_WALLET_RESERVATION_TTL_MS;
  let heartbeatPending = false;
  const timer = setInterval(() => {
    if (heartbeatPending) return;
    heartbeatPending = true;
    // A transient writer collision does not stop future heartbeats. Every
    // durable/irreversible boundary still asserts ownership and fails closed.
    void reservation.heartbeat().catch(() => undefined).finally(() => {
      heartbeatPending = false;
    });
  }, Math.max(1, Math.floor(ttlMs / 3)));
  timer.unref?.();
  try {
    const value = await operation(reservation);
    await reservation.assertActive();
    return value;
  } finally {
    clearInterval(timer);
    await reservation.release();
  }
}

export const noteResource = (nullifier: string): string => `note:${BigInt(nullifier).toString(16)}`;
export function assetActionInputResources(pending: PendingAssetAction): string[] {
  return pending.inputs.map((input) => noteResource(input.nullifier));
}
export const accountResource = (address: string, revision: bigint | string): string =>
  `account:${address.toLowerCase()}:${BigInt(revision).toString()}`;
