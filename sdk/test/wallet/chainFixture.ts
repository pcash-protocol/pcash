// Local chain-state fixtures for wallet tests. `chainRecords` seeds a wallet
// slot's chain records through the production store code; `ChainSim`, the
// simulated chain synchronization runs against, lives in @pcash/test-support.

import { randomBytes } from "node:crypto";
import { emptyOutputFrontier, fieldToHex } from "@pcash/sdk/crypto";
import type { CurrentBoundaryEnvelope } from "@pcash/sdk/protocol";
import { toHex } from "@pcash/sdk/utils";
import {
  accountChangeOf,
  accountRowLeaf,
  denseRoot,
  type AccountRow,
} from "@pcash/test-support/chain-sim";
import { WalletChainState, type NullifierConsumption } from "../../src/wallet/chainState.ts";
import type { WalletStateStore } from "../../src/wallet/store.ts";
import { syntheticRecentBlockFixture } from "./builderTestHelpers.ts";

export * from "@pcash/test-support/chain-sim";

const ZERO_WORD = `0x${"00".repeat(32)}`;
const word = (value: bigint): string => fieldToHex(value).toLowerCase();

/** Chain records for a wallet slot holding exactly these outputs, accounts, and consumption at `anchor`. */
export function chainRecords(params: {
  outputs: readonly { leaf: bigint; mark?: boolean }[];
  accounts?: readonly AccountRow[];
  anchor: CurrentBoundaryEnvelope;
  consumed?: readonly (readonly [string, NullifierConsumption])[];
  finalizedBlock?: bigint;
}): Map<string, unknown> {
  const state = WalletChainState.create(
    { pcashNumber: 0n, pcashHash: ZERO_WORD, outputCount: 0n },
    emptyOutputFrontier(),
  );
  for (const output of params.outputs) state.outputs.append(output.leaf, output.mark === true);
  const origin = { pcashNumber: params.anchor.header.number, pcashHash: word(params.anchor.blockHash) };
  (params.accounts ?? []).forEach((row, index) => {
    state.applyAccountChange(accountChangeOf(row, BigInt(index), origin, true));
  });
  for (const [nullifier, consumption] of params.consumed ?? []) state.recordConsumption(nullifier, consumption);
  const commit = state.finishStep({
    anchor: params.anchor,
    finalizedBlock: params.finalizedBlock ?? 0n,
    watched: new Set((params.consumed ?? []).map(([nullifier]) => nullifier.toLowerCase())),
  });
  return new Map([...commit.writes].filter(([, value]) => value !== null));
}

export interface AnchoredChain {
  boundary: CurrentBoundaryEnvelope;
  records: Map<string, unknown>;
  state(): WalletChainState;
}

/**
 * Chain records for a wallet synced through one synthetic block whose output
 * and account roots are exactly those of these leaves and rows, for tests
 * that call a client directly instead of synchronizing.
 */
export function anchoredChain(params: {
  /** Every output leaf in index order; mark the wallet's own notes. */
  outputs?: readonly { leaf: bigint; mark?: boolean }[];
  accounts?: readonly AccountRow[];
  blockNumber?: bigint;
  timestamp?: bigint;
  consumed?: readonly (readonly [string, NullifierConsumption])[];
  finalizedBlock?: bigint;
  /** Accounts whose published receive key the synced feed never delivered. */
  withheldKeys?: readonly string[];
}): AnchoredChain {
  const outputs = params.outputs ?? [];
  const accounts = params.accounts ?? [];
  const { boundary } = syntheticRecentBlockFixture({
    outputRoot: denseRoot(outputs.map((output) => output.leaf)),
    outputCount: outputs.length,
    accountStateRoot: denseRoot(accounts.map(accountRowLeaf)),
    accountCount: accounts.length,
    ...(params.blockNumber === undefined ? {} : { blockNumber: params.blockNumber }),
    ...(params.timestamp === undefined ? {} : { timestamp: params.timestamp }),
  });
  const records = chainRecords({
    outputs,
    accounts,
    anchor: boundary,
    ...(params.consumed === undefined ? {} : { consumed: params.consumed }),
    ...(params.finalizedBlock === undefined ? {} : { finalizedBlock: params.finalizedBlock }),
  });
  for (const address of params.withheldKeys ?? []) records.delete(`key:${address.toLowerCase()}`);
  return { boundary, records, state: () => WalletChainState.fromRecords(records)! };
}

/** Each of `nullifiers` consumed by one transaction included in `block`. */
export function consumedIn(
  block: CurrentBoundaryEnvelope,
  contentHash: string,
  nullifiers: readonly string[],
): [string, NullifierConsumption][] {
  const consumption: NullifierConsumption = {
    pcashNumber: block.header.number,
    pcashHash: fieldToHex(block.blockHash).toLowerCase(),
    timestamp: block.header.timestamp,
    transactionId: toHex(randomBytes(32)),
    contentHash: contentHash.toLowerCase(),
    nullifiers: nullifiers.map((nullifier) => nullifier.toLowerCase()),
  };
  return nullifiers.map((nullifier) => [nullifier, consumption]);
}

/** Commit `records` as the store's whole local chain state, as a synchronization step would. */
export async function syncStoreTo(store: WalletStateStore, records: ReadonlyMap<string, unknown>): Promise<void> {
  await store.chainStep(async () => {
    const data = await store.load();
    if (data === null) throw new Error("the store has no wallet document to commit chain state with");
    await store.save(data, {
      chain: {
        state: WalletChainState.fromRecords(records)!,
        commit: { replace: true, writes: new Map(records) },
      },
    });
  });
}

/** Commit newly synced consumption of watched nullifiers at the store's current anchor. */
export async function recordConsumption(
  store: WalletStateStore,
  consumed: readonly (readonly [string, NullifierConsumption])[],
): Promise<void> {
  await store.chainStep(async (chain) => {
    for (const [nullifier, consumption] of consumed) chain!.recordConsumption(nullifier, consumption);
    const commit = chain!.finishStep({
      anchor: chain!.requireAnchor(),
      finalizedBlock: 0n,
      watched: new Set(chain!.consumed.keys()),
    });
    await store.save((await store.load())!, { chain: { state: chain!, commit } });
  });
}
