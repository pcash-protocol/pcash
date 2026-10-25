import { beforeEach, expect, it, vi } from "vitest";
import { noteNk, nullifier } from "@pcash/sdk/protocol";
import { bytes32Hex, toHex, utf8 } from "@pcash/sdk/utils";
import type { WalletChainState } from "../../src/wallet/chainState.ts";
import { NativeActivityReader } from "../../src/wallet/actions/nativeActivity.ts";
import { emptyWalletState, type WalletStateStore } from "../../src/wallet/store.ts";
import type { WalletFileData, WalletNote } from "../../src/wallet/noteStore.ts";
import { deriveTestWallet } from "./testWallet.ts";
import { anchoredChain } from "./chainFixture.ts";

const profile = deriveTestWallet();
const word = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
/** The header timestamp of block `n`. */
const time = (n: number) => 1_800_000_000 + 12 * n;
function data(): WalletFileData {
  return { ...emptyWalletState({ address: profile.address, network: { chainId: 1n, genesisHash: word(1) } }),
    historyStartOutputIndex: "0", historyRevision: "0", syncedThrough: { blockNumber: "10", blockHash: word(10) } };
}
function note(amount: number, tx: number, index: number, spent = false): WalletNote {
  return { leafIndex: String(index), outputIndex: 0, assetId: "0x0", amount: String(amount), owner: String(profile.address),
    noteSecret: "1", commitment: word(index + 1), spent, pending: false,
    cursor: { kind: "ordinary", payout: null, transactionId: word(tx), blockNumber: String(tx), blockHash: word(tx), blockTimestamp: String(time(tx)), outputIndex: "0" } };
}
/** Local chain state in which the transaction at block `tx` consumed each spent note. */
function spentBy(...spends: [WalletNote, number][]): WalletChainState {
  return anchoredChain({ blockNumber: 10n, consumed: spends.map(([spent, tx]) => {
    const id = bytes32Hex(nullifier(BigInt(spent.commitment!), noteNk(profile.nkRoot), BigInt(spent.noteSecret)));
    return [id, { pcashNumber: BigInt(tx), pcashHash: word(tx), timestamp: BigInt(time(tx)), transactionId: word(tx), contentHash: word(tx + 100), nullifiers: [id] }] as const;
  }) }).state();
}
/** A store serving `chain` until a test syncs another one. */
function chainStore(chain: WalletChainState) {
  const readChain = vi.fn(async (read: (current: WalletChainState) => unknown) => read(chain));
  return { store: { readChain } as unknown as WalletStateStore, readChain, sync: (next: WalletChainState) => { chain = next; } };
}
beforeEach(() => vi.clearAllMocks());
/** Each entry's direction and amount, newest first. */
const flows = (result: Awaited<ReturnType<NativeActivityReader["read"]>>) =>
  result.state === "ready" ? result.entries.map((entry) => `${entry.direction} ${entry.amount}`) : result;

it("attributes poster receipts to their block without assigning a transaction", async () => {
  const inventory = data();
  inventory.notes = [note(20, 1, 0), note(7, 1, 1), note(3, 2, 2)];
  for (const item of inventory.notes) item.cursor!.transactionId = null;
  const reader = new NativeActivityReader();
  expect(await reader.read(inventory, {} as WalletStateStore, profile)).toMatchObject({
    state: "ready",
    entries: [{ transactionId: null, blockNumber: 2n, amount: 3n }, { transactionId: null, blockNumber: 1n, amount: 27n }],
  });
});

it("nets change and self transfers per transaction, retaining only the self-send fee", async () => {
  const inventory = data();
  inventory.notes = [note(100, 1, 0, true), note(30, 2, 1, true), note(27, 3, 2)];
  const { store } = chainStore(spentBy([inventory.notes[0]!, 2], [inventory.notes[1]!, 3]));
  const reader = new NativeActivityReader();
  const result = await reader.read(inventory, store, profile);
  if (result.state !== "ready") throw new Error("missing activity");
  // Receives are dated by their output's block, spends by the block of the transaction that consumed the note.
  // Each entry names the notes it created, which a reorg that re-includes the transaction does not change.
  expect(result.entries.map(({ transactionId, contentHash, amount, direction, timestamp, commitments }) => ({ transactionId, contentHash, amount, direction, timestamp, commitments }))).toEqual([
    { transactionId: word(3), contentHash: word(103), amount: 3n, direction: "spent", timestamp: BigInt(time(3)), commitments: [word(3)] },
    { transactionId: word(2), contentHash: word(102), amount: 70n, direction: "spent", timestamp: BigInt(time(2)), commitments: [word(2)] },
    { transactionId: word(1), contentHash: undefined, amount: 100n, direction: "received", timestamp: BigInt(time(1)), commitments: [word(1)] },
  ]);
});

it("carries received memos and claimed senders, and what each payment sent", async () => {
  const inventory = data();
  const received = { ...note(30, 1, 0), memo: toHex(utf8("rent")), sender: `0x${"44".repeat(20)}` };
  const paid = note(100, 2, 1, true);
  inventory.notes = [received, paid, note(40, 3, 2)];
  inventory.sentOutputs = [{ noteSecret: "0x01", contentHash: bytes32Hex(20n), privateValueShape: 0,
    transactionId: word(3), slot: 0, leafIndex: "2", recipientAddress: `0x${"55".repeat(20)}`, assetId: "0x0", amount: "60",
    memo: toHex(utf8("dinner")), senderIncluded: true, blockNumber: "3", blockHash: word(3), blockTimestamp: String(time(3)),
  }];
  const { store } = chainStore(spentBy([paid, 3]));
  const result = await new NativeActivityReader().read(inventory, store, profile);
  if (result.state !== "ready") throw new Error("missing activity");
  const byTx = (tx: number) => result.entries.find((entry) => entry.transactionId === word(tx))!;
  expect(byTx(1)).toMatchObject({ direction: "received", messages: [{ memo: utf8("rent"), sender: BigInt(`0x${"44".repeat(20)}`) }] });
  expect(byTx(3)).toMatchObject({
    direction: "spent", amount: 60n,
    sent: [{ recipientAddress: BigInt(`0x${"55".repeat(20)}`), amount: 60n, memo: utf8("dinner"), senderIncluded: true }],
  });
  expect(byTx(3)).not.toHaveProperty("messages");
});

it("keeps what a payment sent when issuance it earned offsets or outweighs the spend", async () => {
  for (const [issued, direction, amount] of [[10, "spent", 0n], [20, "received", 10n]] as const) {
    const inventory = data();
    const paid = note(100, 2, 1, true);
    const payout = note(issued, 3, 3);
    payout.cursor = { ...payout.cursor!, kind: "system", payout: { sourceKind: "designatedIssuance", component: "issuance" } };
    inventory.notes = [paid, note(90, 3, 2), payout];
    inventory.sentOutputs = [{ noteSecret: "0x01", contentHash: bytes32Hex(20n), privateValueShape: 0,
      transactionId: word(3), slot: 0, leafIndex: "4", recipientAddress: `0x${"55".repeat(20)}`, assetId: "0x0", amount: "10",
      senderIncluded: false, blockNumber: "3", blockHash: word(3), blockTimestamp: String(time(3)),
    }];
    const { store } = chainStore(spentBy([paid, 3]));
    const result = await new NativeActivityReader().read(inventory, store, profile);
    if (result.state !== "ready") throw new Error("missing activity");
    expect(result.entries.find((entry) => entry.transactionId === word(3))).toMatchObject({
      direction, amount, sent: [{ recipientAddress: BigInt(`0x${"55".repeat(20)}`), amount: 10n }],
    });
  }
});

it("counts system payouts as ordinary note inflows without replaying history at each head", async () => {
  const inventory = data();
  inventory.notes = [note(20, 1, 0, true), note(10, 2, 1), note(20, 3, 2)];
  const { store, readChain } = chainStore(spentBy([inventory.notes[0]!, 2]));
  const reader = new NativeActivityReader();
  expect(flows(await reader.read(inventory, store, profile))).toEqual(["received 20", "spent 10", "received 20"]);
  inventory.syncedThrough = { blockNumber: "11", blockHash: word(11) };
  expect(await reader.read(inventory, store, profile)).toMatchObject({ state: "ready", pcashNumber: 11n });
  inventory.notes.push(note(5, 4, 3));
  expect(flows(await reader.read(inventory, store, profile))).toEqual(["received 5", "received 20", "spent 10", "received 20"]);
  expect(readChain).toHaveBeenCalledTimes(1);
});

it("invalidates spender records when the existing scanner rebuilds after a reorg", async () => {
  const inventory = data(); inventory.notes = [note(20, 1, 0, true)];
  const { store, readChain, sync } = chainStore(spentBy([inventory.notes[0]!, 2]));
  const reader = new NativeActivityReader();
  expect(await reader.read(inventory, store, profile)).toMatchObject({ entries: [expect.objectContaining({ transactionId: word(2) }), expect.anything()] });
  inventory.historyRevision = "1";
  sync(spentBy([inventory.notes[0]!, 3]));
  expect(await reader.read(inventory, store, profile)).toMatchObject({ entries: [expect.objectContaining({ transactionId: word(3) }), expect.anything()] });
  expect(readChain).toHaveBeenCalledTimes(2);
});

it("keeps incomplete history unknown and retries a missing spender instead of caching false history", async () => {
  const inventory = data(); delete inventory.historyStartOutputIndex;
  const { store, readChain, sync } = chainStore(spentBy());
  const reader = new NativeActivityReader();
  expect(await reader.read(inventory, store, profile)).toEqual({ state: "unavailable", reason: "history-not-scanned" });
  expect(readChain).not.toHaveBeenCalled();
  inventory.historyStartOutputIndex = "0"; inventory.notes = [note(20, 1, 0, true)];
  expect(await reader.read(inventory, store, profile)).toEqual({ state: "unavailable", reason: "stale" });
  sync(spentBy([inventory.notes[0]!, 2]));
  expect(flows(await reader.read(inventory, store, profile))).toEqual(["spent 20", "received 20"]);
});

it("separates open fee and issuance for system payouts and leaves ordinary flows plain", async () => {
  const inventory = data();
  const payout = (amount: number, tx: number | null, block: number, index: number, openFeeAmount: number): WalletNote => ({
    ...note(amount, block, index),
    cursor: { kind: "system", payout: { sourceKind: tx === null ? "posterPayout" : "designatedIssuance",
      component: openFeeAmount === 0 ? "issuance" : "openFee" },
      transactionId: tx === null ? null : word(tx), blockNumber: String(block), blockHash: word(block), blockTimestamp: String(time(block)), outputIndex: "5" },
  });
  // Two poster payouts in one block and a designated payout for another sender's transaction.
  inventory.notes = [payout(3, null, 3, 0, 3), payout(9, null, 3, 1, 0), payout(6, 7, 4, 2, 0), note(20, 5, 3)];
  const result = await new NativeActivityReader().read(inventory, {} as WalletStateStore, profile);
  if (result.state !== "ready") throw new Error("missing activity");
  expect(result.entries.map(({ transactionId, amount, payout: split, timestamp }) => ({ transactionId, amount, payout: split, timestamp }))).toEqual([
    { transactionId: word(5), amount: 20n, payout: null, timestamp: BigInt(time(5)) },
    { transactionId: word(7), amount: 6n, payout: { openFeeAmount: 0n, issuanceAmount: 6n }, timestamp: BigInt(time(4)) },
    { transactionId: null, amount: 12n, payout: { openFeeAmount: 3n, issuanceAmount: 9n }, timestamp: BigInt(time(3)) },
  ]);
});
