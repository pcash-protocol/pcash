import { describe, expect, it, vi } from "vitest";
import type { RelayJournalEntry, RelayJournalEntryReconciliation, RelayJournalReconciliation } from "@pcash/sdk/relay";
import { refreshSubmissionLock, SUBMISSION_PROPAGATION_GRACE_MS, type SubmissionLockL1 } from "./submissionLock.ts";

const relayer = `0x${"11".repeat(20)}`;
const hash = `0x${"ab".repeat(32)}`;
const createdAt = Date.parse("2026-09-30T12:00:00.000Z");
// The lock remembers when it first saw each hash, so every entry gets its own resolution.
let sequence = 0;

function setup(options: {
  outcome?: RelayJournalEntryReconciliation["outcome"];
  receiptStatus?: 0 | 1;
  transactionHash?: string | null;
  known?: boolean;
  mined?: number;
  pending?: number;
  nodeL1?: bigint;
}) {
  const outcome = options.outcome ?? "pending";
  const resolutionId = `r${++sequence}`;
  const entry = { kind: "call", resolutionId, createdAt: new Date(createdAt).toISOString(), transactionHash: options.transactionHash === undefined ? hash : options.transactionHash, nonce: "5", relayerAddress: relayer } as RelayJournalEntry;
  let reconciled = false;
  const recovery = {
    reconcile: vi.fn(async (): Promise<RelayJournalReconciliation> => {
      reconciled = true;
      return { latched: outcome !== "cleared", entries: [{ resolutionId, outcome,
        ...(options.receiptStatus === undefined ? {} : { l1Receipt: { status: options.receiptStatus, blockNumber: 100n, blockHash: hash, transactionIndex: 0, gasUsed: 21_000n } }),
      }] };
    }),
    show: vi.fn(async () => ({ latched: outcome !== "cleared" || !reconciled, entries: outcome === "cleared" && reconciled ? [] : [entry] })),
    resolve: vi.fn(async (resolutionId: string) => ({ latched: false, resolutionId, archivePath: "archived" })),
  };
  const l1: SubmissionLockL1 = {
    getBlockNumber: vi.fn(async () => 100n),
    getTransaction: vi.fn(async () => options.known ? {} : null),
    getTransactionCount: vi.fn(async (_address: string, at: bigint | "pending") => at === "pending" ? options.pending ?? options.mined ?? 5 : options.mined ?? 5),
  };
  const node = { status: vi.fn(async () => ({ latestL1BlockNumber: options.nodeL1 ?? 100n }) as never) };
  return { entry, recovery, l1, node, run: (now = createdAt) => refreshSubmissionLock(recovery, l1, node, () => now) };
}

describe("refreshing the Ethereum submission lock", () => {
  it("reports nothing locked when reconciliation already released it", async () => {
    const { run, recovery } = setup({ outcome: "cleared" });
    expect(await run()).toEqual({ waiting: [], awaitingDerivation: [], released: [] });
    expect(recovery.resolve).not.toHaveBeenCalled();
  });

  it("clears a reverted ordinary Ethereum call without inventing a failed batch", async () => {
    const { run, recovery } = setup({ outcome: "cleared", receiptStatus: 0 });
    expect(await run()).toEqual({ waiting: [], awaitingDerivation: [], released: [] });
    expect(recovery.resolve).not.toHaveBeenCalled();
  });

  it("does not classify successful canonical delivery as a failed release", async () => {
    const { run } = setup({ outcome: "cleared", receiptStatus: 1 });
    expect(await run()).toEqual({ waiting: [], awaitingDerivation: [], released: [] });
  });

  it.each([0, 1] as const)("recovers a canonical batch hash independently of Ethereum receipt status %s", async (receiptStatus) => {
    const { run, recovery, entry } = setup({ outcome: "cleared", receiptStatus });
    const batch = { ...entry, kind: "batch", selected: ["content"] } as RelayJournalEntry;
    recovery.show.mockResolvedValueOnce({ latched: true, entries: [batch] });
    expect(await run()).toEqual({ waiting: [], awaitingDerivation: [], released: [], recovered: [{ resolutionId: entry.resolutionId, transactionHash: hash, selected: ["content"] }] });
  });

  it("keeps a transaction the L1 still knows", async () => {
    const { run, recovery, entry } = setup({ known: true });
    expect(await run()).toEqual({ waiting: [entry], awaitingDerivation: [], released: [] });
    expect(recovery.resolve).not.toHaveBeenCalled();
  });

  it("keeps a mined batch until the node derives it", async () => {
    const { run, recovery, entry } = setup({ outcome: "unobserved", known: true });
    expect(await run()).toMatchObject({ waiting: [entry], awaitingDerivation: [entry.resolutionId] });
    expect(recovery.resolve).not.toHaveBeenCalled();
  });

  it("keeps a status-zero batch pending until the node derives its delivery", async () => {
    const { run, recovery, entry, l1 } = setup({ outcome: "unobserved", receiptStatus: 0 });
    const batch = { ...entry, kind: "batch", selected: ["content"] } as RelayJournalEntry;
    recovery.show.mockResolvedValue({ latched: true, entries: [batch] });
    const result = await run();
    expect(result.waiting).toEqual([batch]);
    expect(result.awaitingDerivation).toEqual([batch.resolutionId]);
    expect(result.released).toEqual([]);
    expect(recovery.resolve).not.toHaveBeenCalled();
    expect(l1.getTransaction).not.toHaveBeenCalled();
  });

  it("keeps a just-broadcast transaction the site's L1 RPC has not seen yet", async () => {
    // The wallet broadcast through its own RPC after a long prompt; this RPC
    // knows neither the hash nor a pending transaction at the nonce.
    const { run, recovery } = setup({ mined: 5, pending: 5 });
    const hashRecorded = createdAt + 10 * SUBMISSION_PROPAGATION_GRACE_MS;
    expect((await run(hashRecorded)).waiting).toHaveLength(1);
    expect((await run(hashRecorded + SUBMISSION_PROPAGATION_GRACE_MS - 1)).waiting).toHaveLength(1);
    expect(recovery.resolve).not.toHaveBeenCalled();
  });

  it("keeps a transaction whose nonce is occupied in the mempool", async () => {
    const { run, recovery } = setup({ mined: 5, pending: 6 });
    await run();
    expect((await run(createdAt + 10 * SUBMISSION_PROPAGATION_GRACE_MS)).waiting).toHaveLength(1);
    expect(recovery.resolve).not.toHaveBeenCalled();
  });

  it("releases a dropped transaction whose nonce is still free once it has had time to propagate", async () => {
    const { run, recovery, entry } = setup({ mined: 5, pending: 5 });
    expect((await run()).waiting).toHaveLength(1);
    expect(await run(createdAt + SUBMISSION_PROPAGATION_GRACE_MS)).toEqual({ waiting: [], awaitingDerivation: [], released: [entry] });
    expect(recovery.resolve).toHaveBeenCalledWith(entry.resolutionId);
  });

  it("releases a replaced transaction once the node has derived past the replacement", async () => {
    const behind = setup({ mined: 6, nodeL1: 99n });
    expect((await behind.run()).waiting).toHaveLength(1);
    expect(behind.recovery.resolve).not.toHaveBeenCalled();
    const caughtUp = setup({ mined: 6, nodeL1: 100n });
    // A mined nonce is final: no grace applies.
    expect((await caughtUp.run()).released).toHaveLength(1);
    expect(caughtUp.recovery.resolve).toHaveBeenCalledWith(caughtUp.entry.resolutionId);
  });

  it("keeps an unhashed send while something occupies its nonce in the mempool", async () => {
    const { run, recovery } = setup({ outcome: "ambiguous", transactionHash: null, mined: 5, pending: 6 });
    expect((await run()).waiting).toHaveLength(1);
    expect(recovery.resolve).not.toHaveBeenCalled();
  });

  it("releases an unhashed send that never reached the mempool once it has had time to propagate", async () => {
    const { run, recovery, entry } = setup({ outcome: "ambiguous", transactionHash: null, mined: 5, pending: 5 });
    expect((await run(createdAt + SUBMISSION_PROPAGATION_GRACE_MS - 1)).waiting).toHaveLength(1);
    expect((await run(createdAt + SUBMISSION_PROPAGATION_GRACE_MS)).released).toHaveLength(1);
    expect(recovery.resolve).toHaveBeenCalledWith(entry.resolutionId);
  });

  it("settles each in-flight submission on its own", async () => {
    const { recovery, l1, node, entry } = setup({ mined: 5 });
    const queued = { ...entry, resolutionId: `${entry.resolutionId}-queued`, transactionHash: `0x${"cd".repeat(32)}`, nonce: "6" } as RelayJournalEntry;
    recovery.reconcile.mockResolvedValue({ latched: true, entries: [{ resolutionId: entry.resolutionId, outcome: "pending" }, { resolutionId: queued.resolutionId, outcome: "pending" }] });
    recovery.show.mockResolvedValue({ latched: true, entries: [entry, queued] });
    vi.mocked(l1.getTransaction).mockImplementation(async (transactionHash) => transactionHash === queued.transactionHash ? {} : null);
    await refreshSubmissionLock(recovery, l1, node, () => createdAt);
    expect(await refreshSubmissionLock(recovery, l1, node, () => createdAt + SUBMISSION_PROPAGATION_GRACE_MS)).toEqual({ waiting: [queued], awaitingDerivation: [], released: [entry] });
    expect(recovery.resolve).toHaveBeenCalledOnce();
  });
});
