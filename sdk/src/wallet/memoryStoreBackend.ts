// In-memory wallet slot. The engine's contract tests and any non-persistent host
// bind to this; it is the reference implementation of the backend contract.

import { serialQueue } from "@pcash/sdk/utils";
import type { WalletStateStore } from "./store.ts";
import type { WalletFileData } from "./noteStore.ts";
import { walletStore } from "./store.ts";
import type { WalletStoreBackend, WalletStoreBackendRecord } from "./store.ts";

interface MemoryWalletStoreBackend extends WalletStoreBackend {
  /** The exact document currently held, for assertions. */
  snapshot(): unknown;
  /** The chain-store records currently held, for restarts and assertions. */
  chainSnapshot(): Map<string, unknown>;
}

export function memoryWalletStoreBackend(
  initial: unknown = null,
  initialChain: ReadonlyMap<string, unknown> = new Map(),
): MemoryWalletStoreBackend {
  // A durable backend round-trips through storage, so a caller can never reach
  // what it holds. This one keeps the value in the same realm, so it clones on
  // the way in and on the way out to reproduce that isolation exactly.
  let current: WalletStoreBackendRecord | null = initial === null
    ? null
    : { revision: 0, data: structuredClone(initial) };
  const chain = new Map<string, unknown>(structuredClone([...initialChain]));
  // Serializes the short synchronous read/modify/write callbacks of this slot.
  const serialize = serialQueue();
  const held = (): WalletStoreBackendRecord | null =>
    current === null ? null : { revision: current.revision, data: structuredClone(current.data) };
  return {
    read: () => Promise.resolve(held()),
    transaction: (operation, chainCommit) => serialize(async () => {
      const committed = operation(held());
      current = {
        revision: (current?.revision ?? -1) + 1,
        data: structuredClone(committed.data),
      };
      if (chainCommit !== undefined) {
        if (chainCommit.replace) chain.clear();
        for (const [key, value] of chainCommit.writes) {
          if (value === null) chain.delete(key);
          else chain.set(key, structuredClone(value));
        }
      }
      return committed.value;
    }),
    readChain: (keys) => Promise.resolve(new Map(
      (keys === undefined ? [...chain.keys()] : keys.filter((key) => chain.has(key)))
        .map((key) => [key, structuredClone(chain.get(key))]),
    )),
    snapshot: () => current === null ? null : structuredClone(current.data),
    chainSnapshot: () => new Map(structuredClone([...chain])),
  };
}

/**
 * A complete in-memory wallet store, bound to the identity of the document it is
 * seeded with. Engine contract tests use this to exercise wallet semantics
 * without a platform; a seed is required so the identity binding is never
 * ambiguous.
 */
export function memoryWalletStateStore(
  initial: WalletFileData,
  initialChain?: ReadonlyMap<string, unknown>,
): WalletStateStore & { snapshot(): WalletFileData | null; chainSnapshot(): Map<string, unknown> } {
  const backend = memoryWalletStoreBackend(initial, initialChain);
  const store = walletStore(backend, {
    address: BigInt(initial.address),
    network: initial.network,
  });
  return {
    ...store,
    snapshot: () => backend.snapshot() as WalletFileData | null,
    chainSnapshot: () => backend.chainSnapshot(),
  };
}
