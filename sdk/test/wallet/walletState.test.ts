import { describe, expect, it } from "vitest";
import { emptyWalletState as makeEmptyWalletFile } from "../../src/wallet/store.ts";
import {
  addPendingNote,
  mergeRecoveredWalletNotes,
  addPendingUserAccountCreation,
  markPendingUserAccountCreationBroadcastRequested,
  markPendingUserAccountCreationPrepared,
  markPendingUserAccountCreationSubmitted,
  type WalletFileData,
  type WalletNote,
} from "../../src/wallet/noteStore.ts";
import { generateMlKemKeyPair } from "@pcash/sdk/protocol";
import { receiveKeyPairs, retainReceiveKeyPair } from "../../src/wallet/receiveKeyring.ts";
import { PCASH_CHAIN_ID } from "@pcash/sdk/constants";

const ADDRESS = 0xabcn;
const NETWORK = {
  chainId: PCASH_CHAIN_ID,
  genesisHash: `0x${"11".repeat(32)}`,
};

const hash = (byte: number): string => `0x${byte.toString(16).padStart(2, "0").repeat(32)}`;
const emptyWalletFile = (): WalletFileData => makeEmptyWalletFile({ address: ADDRESS, network: NETWORK });
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function note(
  commitmentByte: number,
  amount: bigint,
  at: { number: bigint; hash: string; transactionByte?: number; outputIndex?: number },
): WalletNote {
  const outputIndex = at.outputIndex ?? 0;
  return {
    leafIndex: BigInt(commitmentByte).toString(),
    outputIndex,
    assetId: "0x0",
    amount: amount.toString(),
    owner: "0xabc",
    noteSecret: `0x${commitmentByte.toString(16)}`,
    commitment: hash(commitmentByte),
    spent: false,
    pending: false,
    cursor: {
      kind: "ordinary",
      payout: null,
      blockNumber: at.number.toString(),
      blockHash: at.hash,
      blockTimestamp: (1_800_000_000n + at.number * 12n).toString(),
      transactionId: hash(at.transactionByte ?? commitmentByte),
      outputIndex: outputIndex.toString(),
    },
  };
}

describe("wallet inventory", () => {
  it("creates a network-bound inventory without profile secrets", () => {
    const data = emptyWalletFile();
    expect(data.address).toBe("0x0000000000000000000000000000000000000abc");
    expect(data.network).toEqual({
      chainId: PCASH_CHAIN_ID.toString(),
      genesisHash: NETWORK.genesisHash,
    });
    expect(data.receiveKeys).toEqual([]);
    expect(data).not.toHaveProperty("defaultUserRuleSecrets");
    expect(data.syncedThrough).toBeUndefined();
    expect(data.nextOutputIndex).toBeUndefined();
  });

  it("advances the direct-L1 account activation journal", () => {
    const data = emptyWalletFile();
    const pending = {
      contentHash: hash(0xaa),
      transactionHex: "0x0201",
      address: `0x${"12".repeat(20)}`,
      pcashChainId: PCASH_CHAIN_ID.toString(),
      pcashGenesisHash: NETWORK.genesisHash,
      l1ChainId: "11155111",
      inboxAddress: `0x${"50".repeat(20)}`,
      genesisL1Block: "1",
      genesisL1BlockHash: hash(0x99),
      ruleSetCommitment: "1",
      receiveKeyHash: hash(0x98),
      recentPcashBlockNumber: "2",
      recentPcashBlockHash: hash(0xbb),
      validUntilTimestamp: "200",
      state: "prepared" as const,
      l1TxHash: null,
      preparedAtUnixMs: "100",
    };
    addPendingUserAccountCreation(data, pending);
    markPendingUserAccountCreationBroadcastRequested(data, pending.address);
    markPendingUserAccountCreationPrepared(data, pending.address);
    markPendingUserAccountCreationSubmitted(data, pending.address, hash(0xcc));
    expect(data.pendingUserAccountCreations).toEqual([{
      ...pending,
      state: "l1-submitted",
      l1TxHash: hash(0xcc),
    }]);
  });

  it("retains each receive key once and restores every pair from the stored form", () => {
    const data = emptyWalletFile();
    const first = generateMlKemKeyPair(new Uint8Array(64).fill(0x31));
    const second = generateMlKemKeyPair(new Uint8Array(64).fill(0x32));
    expect(retainReceiveKeyPair(data, first)).toBe(true);
    expect(retainReceiveKeyPair(data, second)).toBe(true);
    expect(retainReceiveKeyPair(data, first)).toBe(false);

    expect(receiveKeyPairs(clone(data))).toEqual([first, second]);
  });
});

describe("dense private-output inventory", () => {
  it.each([5, 6])("keeps a pending L output at slot %i separate from a system payout", (outputIndex) => {
    const data = emptyWalletFile();
    const ordinary = note(0x31, 30n, { number: 1n, hash: hash(1), transactionByte: 0xaa, outputIndex });
    addPendingNote(data, hash(0xaa), {
      outputIndex, assetId: 0n, amount: 30n, owner: ADDRESS, noteSecret: 0x31n,
    });
    const payout = note(0x32, 4n, { number: 1n, hash: hash(1), transactionByte: 0xaa, outputIndex });
    payout.cursor!.kind = "system";
    mergeRecoveredWalletNotes(data, [payout]);
    expect(data.notes.filter(note => note.pending)).toHaveLength(1);
    mergeRecoveredWalletNotes(data, [ordinary]);
    expect(data.notes).toEqual([payout, ordinary]);
  });

  it("keys pending outputs by exact transaction position", () => {
    const data = emptyWalletFile();
    const txOne = hash(0xd0);
    const txTwo = hash(0xd1);
    const opening = {
      outputIndex: 2,
      assetId: 7n,
      amount: 9n,
      owner: ADDRESS,
      noteSecret: 0xd2n,
    };

    addPendingNote(data, txOne, opening);
    addPendingNote(data, txOne, opening);
    expect(data.notes).toHaveLength(1);
    expect(() => addPendingNote(data, txOne, { ...opening, amount: 10n }))
      .toThrow(/different note fields/);

    addPendingNote(data, txTwo, opening);
    expect(data.notes).toHaveLength(2);
    expect(data.notes.map((value) => value.pendingContentHash)).toEqual([txOne, txTwo]);
  });
});
