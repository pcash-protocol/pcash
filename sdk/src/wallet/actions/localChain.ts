// Spend-time reads of the wallet's local chain state.
//
// Every witness an action needs comes from one anchored local snapshot: the
// anchor header, output openings for this wallet's own notes, account openings
// from the synced account set, and recipients' receive keys from that same
// account set. The shapes match the node's witness reads so builders consume
// them unchanged; nothing here makes a request.

import type {
  AccountProofResult,
  AccountResult,
  BlockHeaderResult,
  OutputPathsResult,
} from "@pcash/sdk/clients";
import { MISMATCHED_RECEIVE_KEY, WalletSyncRequiredError, type WalletChainState } from "../chainState.ts";
import type { WalletStateStore } from "../store.ts";
import { retryWhileSyncConflict } from "./syncConflictRetry.ts";

interface LocalWitnessQuery {
  accounts?: readonly string[];
  outputs?: readonly { outputIndex: bigint | number }[];
}

type ReceiveKeyLookup = (address: string) => Promise<Uint8Array | null>;

interface LocalWitnessSnapshot {
  blockHeader: BlockHeaderResult;
  accounts: AccountProofResult[];
  outputs: OutputPathsResult | null;
  /** Receive keys from the account set the account openings belong to. */
  receiveKeyOf: ReceiveKeyLookup;
}

function requireChain(chain: WalletChainState | null): WalletChainState {
  if (chain === null) throw new WalletSyncRequiredError("wallet has no local chain state; sync before spending");
  return chain;
}

/** Account and output openings at the local anchor. */
export function localWitnessSnapshot(store: WalletStateStore, query: LocalWitnessQuery): Promise<LocalWitnessSnapshot> {
  return store.readChain((loaded) => {
    const chain = requireChain(loaded);
    const anchor = chain.requireAnchor();
    return {
      blockHeader: { recentPcashBlockHash: anchor.blockHash, boundary: anchor },
      accounts: (query.accounts ?? []).map((address) => chain.accountProof(address)),
      outputs: (query.outputs?.length ?? 0) === 0 ? null : chain.outputPaths(query.outputs!),
      receiveKeyOf: receiveKeyLookupAt(store, anchor.state.accountStateRoot),
    };
  });
}

/** Whether the synced chain consumed each nullifier. */
export function locallySpent(store: WalletStateStore, nullifiers: readonly string[]): Promise<boolean[]> {
  return store.readChain((chain) => requireChain(chain).consumption(nullifiers).map((consumption) => consumption !== null));
}

/** An account row from the synced account set, or null when the address has none. */
export function localAccount(store: WalletStateStore, address: string): Promise<AccountResult | null> {
  return store.readChain((chain) => requireChain(chain).accountResult(address));
}

/**
 * A recipient's published receive key from the synced directory. A synced key
 * that does not hash to the account's digest is refused with its own error.
 */
function receiveKeyFrom(chain: WalletChainState, address: string): Uint8Array | null {
  const key = chain.receiveKey(address);
  const material = key === null ? chain.accountResult(address)?.material : undefined;
  if (material?.status === "unavailable" && material.lifecycle === MISMATCHED_RECEIVE_KEY) {
    throw new Error(`the receive key synced for ${address} does not match its committed digest; resynchronize this wallet from another node before sending to it`);
  }
  return key;
}

/** A recipient's published receive key from the synced directory, at whatever block it is synced to. */
export function localReceiveKeyLookup(store: WalletStateStore): ReceiveKeyLookup {
  return (address) => store.readChain((loaded) => receiveKeyFrom(requireChain(loaded), address));
}

/**
 * A recipient's receive key from the account set whose root is
 * `accountStateRoot`, or null when the account there commits no key. Every
 * committed local state reproduces its anchor's roots, so a local state at
 * another root is another account set: with `synchronize` it advances once,
 * and otherwise, or when it still differs, the lookup is refused. A committed
 * key whose bytes the feed did not deliver is refused the same way.
 */
export async function loadReceiveKeyAtSnapshot(
  store: WalletStateStore,
  address: string,
  accountStateRoot: bigint,
  synchronize?: () => Promise<unknown>,
): Promise<Uint8Array | null> {
  const read = () => store.readChain((loaded) => {
    const chain = requireChain(loaded);
    if (chain.requireAnchor().state.accountStateRoot !== accountStateRoot) return undefined;
    const key = receiveKeyFrom(chain, address);
    if (key === null && chain.accountResult(address)?.material.status === "unavailable") {
      throw new WalletSyncRequiredError(`the receive key ${address} commits was not synced; resynchronize this wallet before sending to it`);
    }
    return { key };
  });
  let found = await read();
  if (found === undefined && synchronize !== undefined) {
    await retryWhileSyncConflict(synchronize);
    found = await read();
  }
  if (found === undefined) {
    throw new WalletSyncRequiredError("wallet account state differs from the transaction snapshot; retry this action");
  }
  return found.key;
}

function receiveKeyLookupAt(store: WalletStateStore, accountStateRoot: bigint): ReceiveKeyLookup {
  return (address) => loadReceiveKeyAtSnapshot(store, address, accountStateRoot);
}
