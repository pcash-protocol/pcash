// A store proves a document matches the identity the store was BUILT with. It
// cannot prove that identity is the one an action means to operate on.
//
// Without this check, `syncWallet` handed a populated store for owner A and a
// wallet for owner B loads A's document (the store is satisfied), folds B's
// recovered notes and receive keys into it, and saves — because the document's
// owner field is still A. The same hole let a wrong-network store be reconciled
// before `synchronizeWalletInventory` reached its own network check.

import { describe, expect, it } from "vitest";
import type { PcashNodeClient, StatusResult } from "@pcash/sdk/clients";
import { syncWallet } from "../../src/wallet/actions/syncWallet.ts";
import { assertWalletStoreMatches } from "../../src/wallet/actions/walletSession.ts";
import { memoryWalletStateStore } from "../../src/wallet/memoryStoreBackend.ts";
import { emptyWalletState } from "../../src/wallet/store.ts";

const CHAIN_ID = 8191n;
const GENESIS = `0x${"11".repeat(32)}`;
const OTHER_GENESIS = `0x${"22".repeat(32)}`;
const OWNER_A = 0xaaan;
const OWNER_B = 0xbbbn;

const NETWORK = { chainId: CHAIN_ID, genesisHash: GENESIS };

const status = (overrides: Partial<StatusResult> = {}): StatusResult =>
  ({ pcashChainId: Number(CHAIN_ID), genesisHash: GENESIS, ...overrides }) as StatusResult;

const storeFor = (address: bigint, genesisHash = GENESIS) =>
  memoryWalletStateStore(emptyWalletState({ address, network: { chainId: CHAIN_ID, genesisHash } }));

describe("wallet store identity vs the operation", () => {
  it("accepts a store built for this wallet, chain, and genesis", () => {
    expect(() => assertWalletStoreMatches(storeFor(OWNER_A), { address: OWNER_A }, CHAIN_ID, status()))
      .not.toThrow();
  });

  it("rejects a same-network store belonging to a different owner", () => {
    expect(() => assertWalletStoreMatches(storeFor(OWNER_A), { address: OWNER_B }, CHAIN_ID, status()))
      .toThrow(/different owner/);
  });

  it("rejects a store bound to a different genesis than the node", () => {
    expect(() =>
      assertWalletStoreMatches(storeFor(OWNER_A, OTHER_GENESIS), { address: OWNER_A }, CHAIN_ID, status())
    ).toThrow(/different network genesis/);
  });

  it("rejects a node on a different chain than the operation", () => {
    expect(() =>
      assertWalletStoreMatches(storeFor(OWNER_A), { address: OWNER_A }, CHAIN_ID, status({ pcashChainId: 4242 }))
    ).toThrow(/chain ids must match/);
  });

  // The store is empty, so there is no document to disagree with. Checking the
  // store's declared binding is what makes this case fail at all.
  it("rejects a wrong-owner store even when it has never been written", () => {
    const empty = memoryWalletStateStore(emptyWalletState({ address: OWNER_A, network: NETWORK }));
    expect(() => assertWalletStoreMatches(empty, { address: OWNER_B }, CHAIN_ID, status()))
      .toThrow(/different owner/);
  });
});

describe("syncWallet refuses a store that is not this wallet's", () => {
  /** Fails the test if the synchronizer reads anything before the identity check. */
  const node = (): PcashNodeClient => ({
    status: async () => status(),
    getAccountProof: () => {
      throw new Error("syncWallet read chain state before checking the store identity");
    },
    getOutputs: () => {
      throw new Error("syncWallet scanned before checking the store identity");
    },
  } as unknown as PcashNodeClient);

  const wallet = (address: bigint) => ({ address }) as never;

  it("rejects a populated same-network store for a different owner", async () => {
    await expect(syncWallet({
      node: node(),
      wallet: wallet(OWNER_B),
      chainId: CHAIN_ID,
      store: storeFor(OWNER_A),
    })).rejects.toThrow(/different owner/);
  });

  it("rejects a store bound to a different genesis before reconciling", async () => {
    await expect(syncWallet({
      node: node(),
      wallet: wallet(OWNER_A),
      chainId: CHAIN_ID,
      store: storeFor(OWNER_A, OTHER_GENESIS),
    })).rejects.toThrow(/different network genesis/);
  });
});
