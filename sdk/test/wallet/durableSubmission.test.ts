import { describe, expect, it } from "vitest";
import {
  DurablePreBroadcastError,
  deferSubmission,
  submitDurableAction,
} from "../../src/wallet/actions/durableSubmission.ts";
import { transactionIdentity } from "@pcash/sdk/protocol";
import { WalletConflictError } from "../../src/wallet/store.ts";
import { memoryWalletStateStore } from "../../src/wallet/memoryStoreBackend.ts";
import {
  acquireWalletReservation,
  type WalletReservation,
} from "../../src/wallet/reservations.ts";
import { emptyWalletState } from "../../src/wallet/store.ts";
import { RelayDeadlineError } from "@pcash/sdk/relay";

const IDENTITY = {
  address: 0xabcn,
  network: { chainId: 8191n, genesisHash: `0x${"11".repeat(32)}` },
};

describe("durable submission reservation boundary", () => {
  it.each(["included_unfinalized", "suspended"])(
    "reconciles an exact retained %s retry without resubmitting it",
    async (retainedStatus) => {
      const store = memoryWalletStateStore(emptyWalletState(IDENTITY));
      const data = (await store.load())!;
      const reservation = await acquireWalletReservation(store, ["note:active"]);
      const entry = Uint8Array.of(9);
      const action = { ...transactionIdentity(entry), kind: "noteFundedTransfer" as const };
      let submitted = false;
      const node = {
        status: async () => ({}),
        getReceipt: async () => [],
        getMempoolTransaction: async () => ({
          contentHash: action.contentHash,
          statementId: `0x${"11".repeat(32)}`,
          stableId: `0x${"22".repeat(32)}`,
          conflictKeys: [],
          kind: "privateValue",
          byteSize: 1n,
          openFeeAmount: 0n,
          issuanceOwnerCommitment: `0x${"00".repeat(32)}`,
          issuanceRoute: "open",
          validUntil: null,
          status: retainedStatus,
          conflictCount: 0n,
          receivedAtUnixMs: 0n,
          headCheckedBlock: 0n,
          headCheckedBlockHash: `0x${"00".repeat(32)}`,
          rawTransaction: action.transactionHex,
        }),
      } as never;

      const result = await submitDurableAction({
        node,
        store,
        data,
        status: {} as never,
        action,
        reservation,
        submission: {
          mode: "mempool",
          preflight: async () => undefined,
          submit: async () => {
            submitted = true;
            return { accepted: false, queued: true, output: undefined };
          },
        },
        state: { retry: true },
        isAccepted: async () => false,
        isPending: () => false,
      });

      expect(submitted).toBe(false);
      expect(result).toMatchObject({ queued: false, retried: true, recovered: true });
      await reservation.release();
    },
  );

  it("records the Ethereum hash of an L1-published transfer as soon as the wallet returns it", async () => {
    const store = memoryWalletStateStore(emptyWalletState(IDENTITY));
    const data = (await store.load())!;
    const reservation = await acquireWalletReservation(store, ["note:active"]);
    const entry = Uint8Array.of(7);
    const action = { ...transactionIdentity(entry), kind: "noteFundedTransfer" as const };
    const hash = `0x${"ab".repeat(32)}`;
    let recordedBeforeReturn: string | undefined;
    await submitDurableAction({
      node: {} as never,
      store,
      data,
      status: {} as never,
      action,
      reservation,
      submission: {
        mode: "l1",
        preflight: async () => undefined,
        submit: async ({ onL1Submitted }) => {
          expect((await store.load())!.pendingNoteFundedTransfers![0]!.l1TxHash).toBeUndefined();
          await onL1Submitted?.(hash);
          recordedBeforeReturn = (await store.load())!.pendingNoteFundedTransfers![0]!.l1TxHash;
          return { accepted: false, queued: true, l1Hash: hash, output: undefined };
        },
      },
      state: {
        retry: false,
        prepared: undefined,
        journal: () => {
          data.pendingNoteFundedTransfers = [{
            kind: "payment", contentHash: action.contentHash, transactionHex: action.transactionHex, notBeforeTimestamp: "0", validUntilTimestamp: "100",
            transferAmount: "1", openFeeAmount: "0", privateRelayFeeAmount: "0", privateRelayRecipient: null,
            issuanceOwnerCommitment: "0", issuanceRecipient: null, recipient: `0x${"bb".repeat(20)}`,
            recipientAddress: `0x${"bb".repeat(20)}`, inputs: [{ nullifier: `0x${"cc".repeat(32)}`, spentCommitment: null }], change: null,
          }];
        },
        rollback: () => undefined,
      },
      isAccepted: async () => false,
      isPending: () => true,
    });
    expect(recordedBeforeReturn).toBe(hash);
    expect(data.pendingNoteFundedTransfers![0]!.l1TxHash).toBe(hash);
    await reservation.release();
  });

  it("does not submit after the journaled lease expires and is reclaimed", async () => {
    const store = memoryWalletStateStore(emptyWalletState(IDENTITY));
    const data = (await store.load())!;
    let now = 100;
    const active = await acquireWalletReservation(store, ["note:active"], {
      reservationId: "active",
      ttlMs: 10_000,
      nowUnixMilliseconds: () => now,
    });
    let replacement: WalletReservation | undefined;
    let submitted = false;
    const entry = Uint8Array.of(1);
    const action = { ...transactionIdentity(entry), kind: "noteFundedTransfer" as const };

    await expect(submitDurableAction({
      node: {} as never,
      store,
      data,
      status: {} as never,
      action,
      reservation: active,
      submission: {
        mode: "l1",
        preflight: async () => undefined,
        submit: async () => {
          submitted = true;
          return { accepted: true, queued: false, output: undefined };
        },
      },
      state: {
        retry: false,
        prepared: undefined,
        journal: () => {
          data.syncedThrough = { blockNumber: "1", blockHash: `0x${"22".repeat(32)}` };
        },
        rollback: () => undefined,
      },
      callbacks: {
        onPrepared: async () => {
          now = 10_101;
          replacement = await acquireWalletReservation(store, ["note:active"], {
            reservationId: "replacement",
            ttlMs: 10_000,
            nowUnixMilliseconds: () => now,
          });
        },
      },
      isAccepted: async () => false,
      isPending: () => true,
    })).rejects.toBeInstanceOf(WalletConflictError);

    expect(submitted).toBe(false);
    expect((await store.load())!.resourceReservations?.map((item) => item.reservationId))
      .toEqual(["replacement"]);

    await active.release();
    await replacement!.release();
  });

  it("accepts a scanner that canonically removes the outbox while submission waits", async () => {
    const store = memoryWalletStateStore(emptyWalletState(IDENTITY));
    const data = (await store.load())!;
    const reservation = await acquireWalletReservation(store, ["note:active"]);
    const entry = Uint8Array.of(2);
    const action = { ...transactionIdentity(entry), kind: "noteFundedTransfer" as const };
    const status = {} as never;

    const result = await submitDurableAction({
      node: { status: async () => status } as never,
      store,
      data,
      status,
      action,
      reservation,
      submission: {
        mode: "mempool",
        preflight: async () => undefined,
        submit: async () => {
          await store.transaction((current) => {
            if (current === null) throw new Error("missing wallet state");
            delete current.mempoolOutbox;
            return { data: current, value: undefined };
          });
          return { accepted: true, queued: false, output: undefined };
        },
      },
      state: {
        retry: false,
        prepared: undefined,
        journal: () => undefined,
        rollback: () => undefined,
      },
      isAccepted: async () => false,
      isPending: () => false,
    });

    expect(result.accepted).toBe(true);
    expect((await store.load())!.mempoolOutbox).toBeUndefined();
    await reservation.release();
  });

  it("marks adapter-classified definite rejection after rolling back the journal", async () => {
    const store = memoryWalletStateStore(emptyWalletState(IDENTITY));
    const data = (await store.load())!;
    const reservation = await acquireWalletReservation(store, ["note:active"]);
    const entry = Uint8Array.of(4);
    const action = { ...transactionIdentity(entry), kind: "noteFundedTransfer" as const };
    let rolledBack = false;

    await expect(submitDurableAction({
      node: {} as never,
      store,
      data,
      status: {} as never,
      action,
      reservation,
      submission: {
        mode: "mempool",
        preflight: async () => undefined,
        submit: async () => {
          throw new Error("node rejected the transaction");
        },
        isDefinitePreBroadcastError: () => true,
      },
      state: {
        retry: false,
        prepared: undefined,
        journal: () => undefined,
        rollback: () => {
          rolledBack = true;
        },
      },
      isAccepted: async () => false,
      isPending: () => true,
    })).rejects.toBeInstanceOf(DurablePreBroadcastError);

    expect(rolledBack).toBe(true);
    await reservation.release();
  });

  it("retains the durable action journal after an acceptance deadline", async () => {
    const store = memoryWalletStateStore(emptyWalletState(IDENTITY));
    const data = (await store.load())!;
    const reservation = await acquireWalletReservation(store, ["note:active"]);
    const entry = Uint8Array.of(3);
    const action = { ...transactionIdentity(entry), kind: "noteFundedTransfer" as const };
    const journaledBoundary = { blockNumber: "1", blockHash: `0x${"22".repeat(32)}` };
    let rolledBack = false;

    await expect(submitDurableAction({
      node: { status: async () => ({}) } as never,
      store,
      data,
      status: {} as never,
      action,
      reservation,
      submission: {
        mode: "l1",
        preflight: async () => undefined,
        submit: async () => {
          throw new RelayDeadlineError("PCASH acceptance observation timed out");
        },
      },
      state: {
        retry: false,
        prepared: undefined,
        journal: () => {
          data.syncedThrough = journaledBoundary;
        },
        rollback: () => {
          rolledBack = true;
        },
      },
      isAccepted: async () => false,
      isPending: () => true,
    })).rejects.toBeInstanceOf(RelayDeadlineError);

    expect(rolledBack).toBe(false);
    expect((await store.load())!.syncedThrough).toEqual(journaledBoundary);
    await reservation.release();
  });
});


describe("deferred submission", () => {
  it.each(["l1", "mempool"] as const)("journals an authorized %s action without broadcasting or adding an outbox entry", async (mode) => {
    const store = memoryWalletStateStore(emptyWalletState(IDENTITY));
    const data = (await store.load())!;
    const reservation = await acquireWalletReservation(store, ["note:prepared"]);
    const action = { ...transactionIdentity(Uint8Array.of(9)), kind: "noteFundedTransfer" as const };
    const events: string[] = [];
    const adapter = deferSubmission({ mode,
      preflight: async () => { throw new Error("deferred preparation must not preflight a single transaction"); },
      submit: async () => { throw new Error("deferred preparation must not broadcast"); },
    });
    const result = await submitDurableAction({
      node: {} as never, store, data, status: {} as never, action, reservation, submission: adapter,
      state: { retry: false, prepared: await adapter.preflight({ transactionBytes: Uint8Array.of(9), status: {} as never, retry: false }),
        journal: () => { data.fullRescanRequired = true; events.push("journal"); }, rollback: () => { throw new Error("must retain prepared action"); } },
      callbacks: { onPrepared: async (id, bytes) => {
        expect(id).toBe(action.contentHash); expect(bytes).toBe(action.transactionHex);
        expect((await store.load())!.fullRescanRequired).toBe(true);
        events.push("checkpoint");
      } },
      isAccepted: async () => false, isPending: () => true,
    });
    expect(result).toMatchObject({ submission: null, accepted: false, queued: false, settled: false });
    expect(events).toEqual(["journal", "checkpoint"]);
    expect((await store.load())!.mempoolOutbox ?? []).toEqual([]);
    await reservation.release();
  });
});
