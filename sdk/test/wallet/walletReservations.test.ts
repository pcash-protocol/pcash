import { describe, expect, it } from "vitest";
import { WalletConflictError } from "../../src/wallet/store.ts";
import { memoryWalletStateStore } from "../../src/wallet/memoryStoreBackend.ts";
import type { WalletNote } from "../../src/wallet/noteStore.ts";
import {
  FULL_RESCAN_RESOURCE,
  acquireWalletReservation,
  noteResource,
  withWalletReservation,
} from "../../src/wallet/reservations.ts";
import { emptyWalletState } from "../../src/wallet/store.ts";

const IDENTITY = {
  address: 0xabcn,
  network: { chainId: 8191n, genesisHash: `0x${"11".repeat(32)}` },
};

const store = () => memoryWalletStateStore(emptyWalletState(IDENTITY));

function note(commitment: number): WalletNote {
  return {
    leafIndex: String(commitment),
    outputIndex: 0,
    assetId: "0x0",
    amount: "1",
    owner: "0xabc",
    noteSecret: `0x${(commitment + 1).toString(16)}`,
    commitment: `0x${commitment.toString(16).padStart(64, "0")}`,
    spent: false,
    pending: false,
  };
}

const UPDATE_NULLIFIER = `0x${"5c".repeat(32)}`;
const UPDATE_CONTENT_HASH = `0x${"a1".repeat(32)}`;

/** A wallet holding one journaled fee-paying account update. */
function storeWithPendingUpdate() {
  const state = store();
  const data = emptyWalletState(IDENTITY);
  data.pendingUserAccountUpdates = [{
    contentHash: UPDATE_CONTENT_HASH,
    transactionHex: "0x03",
    address: `0x${"11".repeat(20)}`,
    currentAccountRevision: "1",
    newRuleSetCommitment: `0x${"02".repeat(32)}`,
    receiveKeyOperation: "keep",
    newReceiveKeyHash: `0x${"22".repeat(32)}`,
    validUntilTimestamp: "1900000000",
    openFeeAmount: "5",
    privateRelayFeeAmount: "0",
    privateRelayRecipient: null,
    issuanceOwnerCommitment: "0",
    issuanceRecipient: null,
    inputs: [{ nullifier: UPDATE_NULLIFIER, spentCommitment: `0x${"33".repeat(32)}` }],
    change: null,
  }];
  return { state, data };
}

describe("wallet resource reservations", () => {
  it("fences a pending account update's fee notes after its lease is released", async () => {
    const { state, data } = storeWithPendingUpdate();
    await state.save(data);

    // The update's temporary lease is gone, but its journaled fee note must
    // still block a competing action that selected the same note earlier.
    await expect(withWalletReservation(state, [noteResource(UPDATE_NULLIFIER)], async () => "taken"))
      .rejects.toBeInstanceOf(WalletConflictError);

    // The update's own retry reclaims exactly its journaled inputs.
    await expect(withWalletReservation(
      state,
      [noteResource(UPDATE_NULLIFIER)],
      async () => "resumed",
      { allowPendingContentHash: UPDATE_CONTENT_HASH },
    )).resolves.toBe("resumed");
  });


  it("permits non-overlapping work and rejects an overlapping resource", async () => {
    const state = store();
    let releaseFirst: () => void = () => undefined;
    const hold = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let acquired = false;
    const first = withWalletReservation(state, ["note:one"], async () => {
      acquired = true;
      await hold;
    });
    while (!acquired) await Promise.resolve();

    await expect(withWalletReservation(state, ["note:two"], async () => "ok"))
      .resolves.toBe("ok");
    await expect(withWalletReservation(state, ["note:one"], async () => undefined))
      .rejects.toBeInstanceOf(WalletConflictError);
    releaseFirst();
    await first;
  });

  it("expires abandoned reservations and lets a later owner reclaim them", async () => {
    const state = store();
    let now = 100;
    const first = await acquireWalletReservation(state, ["credit:7"], {
      reservationId: "first",
      ttlMs: 10,
      nowUnixMilliseconds: () => now,
    });
    now = 111;
    const second = await acquireWalletReservation(state, ["credit:7"], {
      reservationId: "second",
      ttlMs: 10,
      nowUnixMilliseconds: () => now,
    });

    expect(state.snapshot()!.resourceReservations?.map((item) => item.reservationId))
      .toEqual(["second"]);
    await first.release();
    expect(state.snapshot()!.resourceReservations?.map((item) => item.reservationId))
      .toEqual(["second"]);
    await second.release();
  });

  it("extends an active lease with a heartbeat", async () => {
    const state = store();
    let now = 100;
    const active = await acquireWalletReservation(state, ["account:0xabc:4"], {
      reservationId: "active",
      ttlMs: 10,
      nowUnixMilliseconds: () => now,
    });
    now = 105;
    await active.heartbeat();
    now = 111;
    await expect(acquireWalletReservation(state, ["account:0xabc:4"], {
      ttlMs: 10,
      nowUnixMilliseconds: () => now,
    })).rejects.toBeInstanceOf(WalletConflictError);
    now = 116;
    const replacement = await acquireWalletReservation(state, ["account:0xabc:4"], {
      ttlMs: 10,
      nowUnixMilliseconds: () => now,
    });
    await replacement.release();
  });

  it("refuses to journal after an active operation loses and another owner reclaims its lease", async () => {
    const state = store();
    let now = 100;
    const active = await acquireWalletReservation(state, ["note:active"], {
      reservationId: "active",
      ttlMs: 10_000,
      nowUnixMilliseconds: () => now,
    });
    const stale = await state.load();
    stale!.syncedThrough = { blockNumber: "1", blockHash: `0x${"22".repeat(32)}` };
    now = 10_101;
    const replacement = await acquireWalletReservation(state, ["note:active"], {
      reservationId: "replacement",
      ttlMs: 10_000,
      nowUnixMilliseconds: () => now,
    });

    await expect(active.save(stale!)).rejects.toBeInstanceOf(WalletConflictError);
    expect((await state.load())!.syncedThrough).toBeUndefined();
    expect((await state.load())!.resourceReservations?.map((item) => item.reservationId))
      .toEqual(["replacement"]);

    await active.release();
    await replacement.release();
  });

  it("makes a full rescan conflict with every active action resource", async () => {
    const state = store();
    const action = await acquireWalletReservation(state, ["account:0xabc:1"]);
    await expect(acquireWalletReservation(state, [FULL_RESCAN_RESOURCE]))
      .rejects.toBeInstanceOf(WalletConflictError);
    await action.release();
  });

  it("applies a stale scan checkpoint without overwriting a fresh reservation", async () => {
    const state = store();
    const scan = await state.load();
    scan!.syncedThrough = { blockNumber: "1", blockHash: `0x${"22".repeat(32)}` };
    const reservation = await acquireWalletReservation(state, ["note:active"]);

    await state.save(scan!);

    expect((await state.load())!.syncedThrough?.blockNumber).toBe("1");
    expect((await state.load())!.resourceReservations?.[0]?.resources).toEqual(["note:active"]);
    await reservation.release();
  });

  it("commits neither a resource lease nor partial action state when atomic initialization fails", async () => {
    const state = store();

    await expect(acquireWalletReservation(state, ["note:active"], {
      initialize: (data) => {
        data.syncedThrough = { blockNumber: "1", blockHash: `0x${"22".repeat(32)}` };
        throw new Error("journal initialization failed");
      },
    })).rejects.toThrow("journal initialization failed");

    expect(await state.load()).toEqual(emptyWalletState(IDENTITY));
  });

  it("merges distinct note changes and rejects two edits to the same note", async () => {
    const state = store();
    const left = await state.load();
    const right = await state.load();
    left!.notes.push(note(1));
    right!.notes.push(note(2));
    await state.save(left!);
    await state.save(right!);
    expect((await state.load())!.notes.map((item) => item.commitment)).toHaveLength(2);

    const firstEdit = await state.load();
    const secondEdit = await state.load();
    firstEdit!.notes[0]!.spent = true;
    secondEdit!.notes[0]!.amount = "2";
    await state.save(firstEdit!);
    await expect(state.save(secondEdit!)).rejects.toBeInstanceOf(WalletConflictError);
  });

  it("merges the action and scanner observing the same spend", async () => {
    const state = store();
    const initial = await state.load();
    initial!.notes.push(note(1));
    await state.save(initial!);
    const action = await state.load();
    const scanner = await state.load();
    action!.notes[0]!.spent = true;
    scanner!.notes[0]!.spent = true;

    await state.save(scanner!);
    await state.save(action!);

    expect((await state.load())!.notes[0]).toMatchObject({ spent: true });
  });

  it("rejects a stale deletion when the fresh note was edited", async () => {
    const state = store();
    const initial = await state.load();
    initial!.notes.push(note(1));
    await state.save(initial!);
    const deleting = await state.load();
    const editing = await state.load();
    deleting!.notes = [];
    editing!.notes[0]!.spent = true;

    await state.save(editing!);

    await expect(state.save(deleting!)).rejects.toBeInstanceOf(WalletConflictError);
    expect((await state.load())!.notes[0]!.spent).toBe(true);
  });

  it("rejects a stale edit when the fresh note was deleted", async () => {
    const state = store();
    const initial = await state.load();
    initial!.notes.push(note(1));
    await state.save(initial!);
    const editing = await state.load();
    const deleting = await state.load();
    editing!.notes[0]!.spent = true;
    deleting!.notes = [];

    await state.save(deleting!);

    await expect(state.save(editing!)).rejects.toBeInstanceOf(WalletConflictError);
    expect((await state.load())!.notes).toEqual([]);
  });
});
