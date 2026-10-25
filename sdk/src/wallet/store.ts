// Shared wallet persistence: keep reads and writes bound to the store identity.
// Platform backends provide atomic storage.

import { addressHex, fixedHex, serialQueue } from "@pcash/sdk/utils";
import { WalletChainState, type ChainCommit } from "./chainState.ts";
import {
  WALLET_SECTION_KEYS,
  type WalletArrayField,
  type WalletFileData,
  type WalletNetworkIdentity,
  type WalletNetworkIdentityLike,
} from "./noteStore.ts";

/** Internal/advanced binding kept out of the high-level wallet subpath. */
export const WALLET_DATABASE_STATE_STORE: unique symbol = Symbol("pcash.walletDatabase.stateStore");

/** Platform-neutral database capability consumed by the shared Wallet engine. */
export interface WalletDatabase {
  [WALLET_DATABASE_STATE_STORE](identity: WalletStoreIdentity, label?: string): WalletStateStore;
  subscribe(identity: WalletStoreIdentity, listener: () => void): Promise<() => Promise<void>>;
  close(): Promise<void>;
}

export interface WalletStoreBackend {
  /** Read the slot without excluding readers. Null means it has never existed. */
  read(): Promise<WalletStoreBackendRecord | null>;
  /**
   * Run one synchronous read/modify/write transaction. The callback is
   * deliberately unable to return a Promise: database transactions must never
   * span RPC, proving, submission, polling, or other event-loop work.
   */
  transaction<T>(
    operation: (current: WalletStoreBackendRecord | null) => WalletStoreBackendCommit<T>,
    chain?: ChainCommit,
  ): Promise<T>;
  /**
   * Read this slot's local chain-store records: all of them, or only `keys`.
   * A transaction given a `chain` commit applies its record writes atomically
   * with the document.
   */
  readChain(keys?: readonly string[]): Promise<Map<string, unknown>>;
}

/**
 * A backend stores and returns the document value itself and never sees its
 * schema. A backend that hands out a value it also retains must clone at that
 * boundary, so a caller mutating a loaded document cannot reach stored state.
 */
export interface WalletStoreBackendRecord {
  revision: number;
  data: unknown;
}

export interface WalletStoreBackendCommit<T> {
  data: unknown;
  value: T;
}

export interface WalletStoreIdentity {
  /** The wallet account's address. */
  address: bigint;
  network: WalletNetworkIdentityLike;
}

/** A store's binding in its exact durable form. */
interface BoundWalletIdentity {
  address: bigint;
  network: WalletNetworkIdentity;
}

interface WalletReservationRequirement {
  reservationId: string;
  resources: readonly string[];
  nowUnixMs: number;
}

export interface WalletSaveOptions {
  /** Fail atomically unless this unexpired reservation still owns its resources. */
  requiredReservation?: WalletReservationRequirement;
  /** Local chain-store changes committed in the same transaction as the document. */
  chain?: { state: WalletChainState; commit: ChainCommit };
}

export interface WalletStateStore {
  /** `load`/`save` check the stored document's binding, not the caller's intended wallet.
   * Call `assertWalletStoreMatches` before use, including for an empty store. */
  readonly identity: BoundWalletIdentity;
  /** Read the currently persisted state. Null means the wallet has not synced. */
  load(): Promise<WalletFileData | null>;
  /** Durably replace the complete state in one short transaction. */
  save(data: WalletFileData, options?: WalletSaveOptions): Promise<void>;
  /**
   * Atomically update the latest state. This callback must be synchronous; do
   * all network and CPU-heavy work before entering it.
   */
  transaction<T>(operation: (current: WalletFileData | null) => WalletStateCommit<T>): Promise<T>;
  /**
   * Read the local chain state, or null before the first synchronization.
   * Waits for any synchronization step in this process, so a reader never
   * sees a step half applied.
   */
  readChain<T>(read: (chain: WalletChainState | null) => T | Promise<T>): Promise<T>;
  /**
   * Run one synchronization step with exclusive use of the local chain state.
   * The step commits its changes through `save(data, { chain })`; if it
   * throws, the in-memory state is discarded and reloaded from storage.
   */
  chainStep<T>(step: (chain: WalletChainState | null) => Promise<T>): Promise<T>;
}

export interface WalletStateCommit<T> {
  data: WalletFileData;
  value: T;
}

/** A typed, retryable conflict at the wallet persistence boundary. */
export class WalletConflictError extends Error {
  readonly resources: readonly string[];

  constructor(message: string, resources: readonly string[] = []) {
    super(message);
    this.name = "WalletConflictError";
    this.resources = resources;
  }
}

/** Normalize a chain/genesis pair to its exact durable form. */
export function walletNetworkIdentity(network: WalletNetworkIdentityLike): WalletNetworkIdentity {
  const chainId = BigInt(network.chainId);
  if (chainId <= 0n || chainId >= 1n << 32n) {
    throw new Error("chainId must be a positive uint32");
  }
  return {
    chainId: chainId.toString(),
    genesisHash: fixedHex(network.genesisHash, 32, "genesisHash"),
  };
}

/** A fresh, network-bound, empty inventory. */
export function emptyWalletState(identity: WalletStoreIdentity): WalletFileData {
  return {
    address: addressHex(identity.address),
    network: walletNetworkIdentity(identity.network),
    receiveKeys: [],
    notes: [],
  };
}

function assertWalletIdentity(
  data: WalletFileData,
  identity: WalletStoreIdentity,
  label: string,
): void {
  if (BigInt(data.address) !== identity.address) {
    throw new Error(`${label} belongs to a different owner`);
  }
  const expected = walletNetworkIdentity(identity.network);
  if (data.network.chainId !== expected.chainId) {
    throw new Error(
      `${label} network mismatch at chainId: expected ${expected.chainId}, got ${data.network.chainId}`,
    );
  }
  if (data.network.genesisHash !== expected.genesisHash) {
    throw new Error(
      `${label} network mismatch at genesisHash: expected ${expected.genesisHash}, got ${data.network.genesisHash}`,
    );
  }
}

function cloneData(data: WalletFileData): WalletFileData {
  return JSON.parse(JSON.stringify(data)) as WalletFileData;
}

function equal(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => equal(value, right[index]));
  }
  const leftObject = left as Record<string, unknown>;
  const rightObject = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftObject).filter((key) => leftObject[key] !== undefined);
  const rightKeys = Object.keys(rightObject).filter((key) => rightObject[key] !== undefined);
  return leftKeys.length === rightKeys.length && leftKeys.every(
    (key) => Object.hasOwn(rightObject, key) && equal(leftObject[key], rightObject[key]),
  );
}

function mergeCompatibleNoteSpend<T>(baseValue: T, localValue: T, freshValue: T): T | undefined {
  const base = baseValue as WalletFileData["notes"][number];
  const local = localValue as WalletFileData["notes"][number];
  const fresh = freshValue as WalletFileData["notes"][number];
  if (base.spent || !local.spent || !fresh.spent) return undefined;
  const { spent: _baseSpent, ...baseRest } = base;
  const { spent: _localSpent, ...localRest } = local;
  const { spent: _freshSpent, ...freshRest } = fresh;
  if (!equal(baseRest, localRest) || !equal(baseRest, freshRest)) return undefined;
  return { ...fresh, spent: true } as T;
}

function mergeArray<T>(
  field: string,
  base: readonly T[],
  local: readonly T[],
  fresh: readonly T[],
  keyOf: (value: T) => string,
): T[] {
  const baseByKey = new Map(base.map((value) => [keyOf(value), value]));
  const localByKey = new Map(local.map((value) => [keyOf(value), value]));
  const freshByKey = new Map(fresh.map((value) => [keyOf(value), value]));
  for (const [key, baseValue] of baseByKey) {
    const localValue = localByKey.get(key);
    const freshValue = freshByKey.get(key);
    if (localValue === undefined) {
      if (freshValue !== undefined && !equal(freshValue, baseValue)) {
        throw new WalletConflictError(
          `wallet ${field} entry ${key} was edited while being deleted`,
          [`${field}:${key}`],
        );
      }
      freshByKey.delete(key);
      continue;
    }
    if (equal(localValue, baseValue)) continue;
    if (freshValue === undefined) {
      throw new WalletConflictError(
        `wallet ${field} entry ${key} was deleted while being edited`,
        [`${field}:${key}`],
      );
    }
    if (!equal(freshValue, baseValue) && !equal(freshValue, localValue)) {
      const compatible = field === "notes"
        ? mergeCompatibleNoteSpend(baseValue, localValue, freshValue)
        : undefined;
      if (compatible !== undefined) {
        freshByKey.set(key, compatible);
        continue;
      }
      throw new WalletConflictError(`wallet ${field} entry ${key} changed concurrently`, [`${field}:${key}`]);
    }
    freshByKey.set(key, localValue);
  }
  for (const [key, localValue] of localByKey) {
    if (baseByKey.has(key)) continue;
    const freshValue = freshByKey.get(key);
    // Concurrent observers can retire the same payment at different local
    // times. Its first committed history entry remains the display record.
    if (field === "paymentHistory" && freshValue !== undefined) continue;
    if (freshValue !== undefined && !equal(freshValue, localValue)) {
      throw new WalletConflictError(`wallet ${field} entry ${key} was created concurrently`, [`${field}:${key}`]);
    }
    freshByKey.set(key, localValue);
  }
  return [...freshByKey.values()];
}

/** Apply only the fields changed from `base`, retaining unrelated fresh work. */
function mergeWalletState(base: WalletFileData, local: WalletFileData, fresh: WalletFileData): WalletFileData {
  const merged = cloneData(fresh);
  for (const [field, untypedKeyOf] of Object.entries(WALLET_SECTION_KEYS)) {
    const key = field as WalletArrayField;
    const baseValues = (base[key] ?? []) as unknown as readonly never[];
    const localValues = (local[key] ?? []) as unknown as readonly never[];
    if (equal(baseValues, localValues)) continue;
    const freshValues = (fresh[key] ?? []) as unknown as readonly never[];
    const values = mergeArray(field, baseValues, localValues, freshValues, untypedKeyOf!);
    if (values.length === 0 && key !== "receiveKeys" && key !== "notes") delete merged[key];
    else (merged as unknown as Record<string, unknown>)[key] = values;
  }
  for (const field of [
    "nextOutputIndex",
    "historyStartOutputIndex",
    "historyRevision",
    "syncedThrough",
    "finalizedThrough",
    "fullRescanRequired",
  ] as const) {
    if (equal(base[field], local[field])) continue;
    if (!equal(fresh[field], base[field]) && !equal(fresh[field], local[field])) {
      throw new WalletConflictError(`wallet ${field} changed concurrently`, [field]);
    }
    const target = merged as unknown as Record<string, unknown>;
    if (local[field] === undefined) delete target[field];
    else target[field] = local[field];
  }
  // Reservations are mutated only through their own short transactions. Never
  // copy a stale lease set from a long-running action snapshot.
  if (fresh.resourceReservations === undefined) delete merged.resourceReservations;
  else merged.resourceReservations = fresh.resourceReservations;
  return merged;
}

function assertRequiredReservation(
  data: WalletFileData,
  requirement: WalletReservationRequirement,
): void {
  if (!Number.isSafeInteger(requirement.nowUnixMs) || requirement.nowUnixMs < 0) {
    throw new Error("wallet reservation check requires a nonnegative safe-integer timestamp");
  }
  const reservation = data.resourceReservations?.find(
    (item) => item.reservationId === requirement.reservationId,
  );
  const resourcesMatch = reservation !== undefined
    && equal(reservation.resources, requirement.resources);
  if (
    !resourcesMatch
    || BigInt(reservation!.expiresAtUnixMs) <= BigInt(requirement.nowUnixMs)
  ) {
    throw new WalletConflictError("wallet resource reservation is no longer active", requirement.resources);
  }
}

/** Bind the shared client engine to one durable slot. */
export function walletStore(
  backend: WalletStoreBackend,
  identity: WalletStoreIdentity,
  label = "wallet store",
): WalletStateStore {
  const bound: BoundWalletIdentity = {
    address: identity.address,
    network: walletNetworkIdentity(identity.network),
  };
  const bases = new WeakMap<WalletFileData, WalletFileData>();
  const chainLock = serialQueue();
  let cachedChain: WalletChainState | null = null;
  const currentChain = async (): Promise<WalletChainState | null> => {
    const meta = (await backend.readChain(["meta"])).get("meta") as { revision: number } | undefined;
    if (meta === undefined) {
      cachedChain = null;
    } else if (cachedChain === null || cachedChain.revision !== meta.revision) {
      cachedChain = WalletChainState.fromRecords(await backend.readChain());
    }
    return cachedChain;
  };
  return {
    identity: bound,
    async load(): Promise<WalletFileData | null> {
      const current = await backend.read();
      if (current === null) return null;
      const data = current.data as WalletFileData;
      bases.set(data, cloneData(data));
      return data;
    },
    async save(data: WalletFileData, options: WalletSaveOptions = {}): Promise<void> {
      const base = bases.get(data);
      const local = cloneData(data);
      assertWalletIdentity(local, identity, label);
      const committed = await backend.transaction((current) => {
        const fresh = current === null
          ? emptyWalletState(identity)
          : current.data as WalletFileData;
        if (options.requiredReservation !== undefined) {
          assertRequiredReservation(fresh, options.requiredReservation);
        }
        const merged = mergeWalletState(base ?? emptyWalletState(identity), local, fresh);
        return {
          data: merged,
          value: merged,
        };
      }, options.chain?.commit);
      if (options.chain !== undefined) cachedChain = options.chain.state;
      Object.assign(data, committed);
      for (const key of Object.keys(data) as Array<keyof WalletFileData>) {
        if (!(key in committed)) delete data[key];
      }
      bases.set(data, cloneData(committed));
    },
    async transaction<T>(operation: (current: WalletFileData | null) => { data: WalletFileData; value: T }): Promise<T> {
      return backend.transaction((current) => {
        const committed = operation(current === null ? null : current.data as WalletFileData);
        assertWalletIdentity(committed.data, identity, label);
        return {
          data: committed.data,
          value: committed.value,
        };
      });
    },
    readChain<T>(read: (chain: WalletChainState | null) => T | Promise<T>): Promise<T> {
      return chainLock(async () => read(await currentChain()));
    },
    chainStep<T>(step: (chain: WalletChainState | null) => Promise<T>): Promise<T> {
      return chainLock(async () => {
        try {
          return await step(await currentChain());
        } catch (error) {
          cachedChain = null;
          throw error;
        }
      });
    },
  };
}

/**
 * `store.load()`, or a fresh empty inventory bound to `identity`.
 *
 * `identity` is the wallet the CALLER means to operate on, which is not
 * necessarily the one this store is bound to. The empty document therefore
 * carries the caller's address, so a store bound elsewhere rejects it on save
 * rather than silently accepting another wallet's state — and the check below
 * fails before any mutation instead of after it.
 */
export async function loadWalletStateOrEmpty(
  store: WalletStateStore,
  identity: WalletStoreIdentity,
): Promise<WalletFileData> {
  const expected = walletNetworkIdentity(identity.network);
  if (
    store.identity.address !== identity.address
    || store.identity.network.chainId !== expected.chainId
    || store.identity.network.genesisHash !== expected.genesisHash
  ) {
    throw new Error("wallet store is bound to a different owner or network");
  }
  return await store.load() ?? emptyWalletState(identity);
}
