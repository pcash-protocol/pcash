import { describe, expect, it, vi } from "vitest";
import { generateMlKemKeyPair } from "@pcash/sdk/protocol";
import { addressHex } from "@pcash/sdk/utils";
import { loadSelfReceiveKeyAtSnapshot } from "../../src/wallet/actions/selfDelivery.ts";
import { memoryWalletStateStore } from "../../src/wallet/memoryStoreBackend.ts";
import { storedReceiveKeyPair } from "../../src/wallet/receiveKeyring.ts";
import { anchoredChain, syncStoreTo } from "./chainFixture.ts";

const address = 0x123n;
const pairs = [1, 2, 3].map(seed => generateMlKemKeyPair(new Uint8Array(64).fill(seed)));
const chainWith = (key: Uint8Array | null, blockNumber = 1n) => anchoredChain({
  blockNumber,
  accounts: [{ address: addressHex(address), nullifierKeyCommitment: 1n, accountRuleSetCommitment: 2n, receiveKey: key }],
});
const chains = pairs.map(pair => chainWith(pair.publicKey));
const storeWith = (chain = chains[0]!, owned = pairs) => memoryWalletStateStore({
  address: addressHex(address), network: { chainId: "1", genesisHash: `0x${"11".repeat(32)}` },
  notes: [], receiveKeys: owned.map(storedReceiveKeyPair),
}, chain.records);

describe("self delivery from a transaction snapshot", () => {
  it("uses an already matching local directory without synchronizing", async () => {
    const store = storeWith(chains[1]);
    const synchronize = vi.fn();
    expect(await loadSelfReceiveKeyAtSnapshot(store, address, chains[1]!.boundary.state.accountStateRoot, synchronize))
      .toEqual(pairs[1]!.publicKey);
    expect(synchronize).not.toHaveBeenCalled();
  });

  it("synchronizes a stale directory once and uses the replacement key", async () => {
    const store = storeWith();
    const synchronize = vi.fn(() => syncStoreTo(store, chains[1]!.records));
    expect(await loadSelfReceiveKeyAtSnapshot(store, address, chains[1]!.boundary.state.accountStateRoot, synchronize))
      .toEqual(pairs[1]!.publicKey);
    expect(synchronize).toHaveBeenCalledTimes(1);
  });

  it.each([0, 2])("refuses a directory that remains behind or advances past the witness (%s)", async index => {
    const store = storeWith();
    const synchronize = vi.fn(() => syncStoreTo(store, chains[index]!.records));
    await expect(loadSelfReceiveKeyAtSnapshot(store, address, chains[1]!.boundary.state.accountStateRoot, synchronize))
      .rejects.toThrow("wallet account state differs from the transaction snapshot");
    expect(synchronize).toHaveBeenCalledTimes(1);
  });

  it("accepts the same authenticated account state at a different block height", async () => {
    const later = chainWith(pairs[1]!.publicKey, 2n);
    const synchronize = vi.fn();
    expect(later.boundary.blockHash).not.toBe(chains[1]!.boundary.blockHash);
    expect(await loadSelfReceiveKeyAtSnapshot(storeWith(later), address, chains[1]!.boundary.state.accountStateRoot, synchronize))
      .toEqual(pairs[1]!.publicKey);
    expect(synchronize).not.toHaveBeenCalled();
  });

  it("does not fall back to a retained key when the matching snapshot has cleared delivery", async () => {
    const cleared = chainWith(null);
    await expect(loadSelfReceiveKeyAtSnapshot(storeWith(cleared), address, cleared.boundary.state.accountStateRoot, vi.fn()))
      .rejects.toThrow("no registered receive key");
  });

  it("requires ownership of the key in the matching snapshot", async () => {
    await expect(loadSelfReceiveKeyAtSnapshot(storeWith(chains[1], [pairs[0]!]), address, chains[1]!.boundary.state.accountStateRoot, vi.fn()))
      .rejects.toThrow("does not own the registered receive key");
  });
});
