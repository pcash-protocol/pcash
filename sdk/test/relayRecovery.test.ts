import { custom, TimeoutError } from "viem";
import { describe, expect, it, vi } from "vitest";
import type { L1DeliveryBatchResult } from "../src/clients/index.ts";
import { MemoryRelayJournal } from "../src/node/relayJournal.ts";
import {
  RelayDeadlineError,
  RelayJournalRecoveryManager,
  type RelayBatchJournalEntry,
  type RelayCallJournalEntry,
  RelayUpstreamError,
} from "../src/relay/index.ts";

const HASH = `0x${"11".repeat(32)}`;
const OTHER_HASH = `0x${"12".repeat(32)}`;
const TX_ID = `0x${"22".repeat(32)}`;
const BLOCK_HASH = `0x${"33".repeat(32)}`;

function l1Receipt(outcome: "success" | "reverted" = "success") {
  return {
    status: outcome,
    blockNumber: 9n,
    blockHash: BLOCK_HASH,
    transactionIndex: 0,
    gasUsed: 21_000n,
  };
}

const recorded = { l1TransactionHash: HASH } as L1DeliveryBatchResult;
const nodeWithout = { getInboxDeliveryBatch: async () => null };
const nodeWith = { getInboxDeliveryBatch: async () => recorded };
const nodeNeverAsked = {
  getInboxDeliveryBatch: async (): Promise<L1DeliveryBatchResult | null> => {
    throw new Error("must not consult the node");
  },
};

function entry(): RelayBatchJournalEntry {
  return {
    kind: "batch",
    createdAt: "2026-08-25T00:00:00.000Z",
    resolutionId: HASH,
    phase: "broadcast_attempted",
    submissionKind: "signed_raw",
    transactionHash: HASH,
    signedTransaction: "0x02aa",
    previousTransactionHashes: [],
    lastBroadcastBlock: "9",
    carrier: "calldata",
    batch: "0x010001",
    selected: [TX_ID],
    batchItemIndexes: ["0"],
    observationMode: "selected",
    collectibleOpenFee: "10",
    relayerAddress: `0x${"44".repeat(20)}`,
    chainId: "1",
    inboxAddress: `0x${"55".repeat(20)}`,
    nonce: "2",
    gasLimit: "21000",
    maxFeePerGas: "10",
    maxPriorityFeePerGas: "1",
    maxFeePerBlobGas: null,
    genesisL1Block: "0",
    genesisL1BlockHash: BLOCK_HASH,
    headCheckedBlock: "3",
    headCheckedBlockHash: BLOCK_HASH,
  };
}

function callEntry(): RelayCallJournalEntry {
  const batch = entry();
  return {
    kind: "call",
    createdAt: batch.createdAt,
    resolutionId: OTHER_HASH,
    phase: "broadcast_accepted",
    submissionKind: "signed_raw",
    transactionHash: OTHER_HASH,
    signedTransaction: "0x02bb",
    previousTransactionHashes: [],
    lastBroadcastBlock: "9",
    relayerAddress: batch.relayerAddress,
    chainId: batch.chainId,
    nonce: "3",
    gasLimit: "21000",
    maxFeePerGas: "10",
    maxPriorityFeePerGas: "1",
    genesisL1Block: batch.genesisL1Block,
    genesisL1BlockHash: batch.genesisL1BlockHash,
    to: `0x${"66".repeat(20)}`,
    value: "1000",
    data: "0x",
  };
}

async function journalWith(...entries: Array<RelayBatchJournalEntry | RelayCallJournalEntry>): Promise<MemoryRelayJournal> {
  const journal = new MemoryRelayJournal();
  for (const value of entries) await journal.create(value);
  return journal;
}

describe("RelayJournalRecoveryManager", () => {
  it("shows every in-flight transaction in nonce order", async () => {
    const journal = await journalWith(callEntry(), entry());
    const recovery = new RelayJournalRecoveryManager({ journal, node: nodeNeverAsked, readL1Receipt: async () => null });

    await expect(recovery.show()).resolves.toEqual({ latched: true, entries: [entry(), callEntry()] });
    await expect(new RelayJournalRecoveryManager({ journal: new MemoryRelayJournal(), node: nodeNeverAsked }).show())
      .resolves.toEqual({ latched: false, entries: [] });
  });

  it("reconciles an empty journal to nothing", async () => {
    const recovery = new RelayJournalRecoveryManager({ journal: new MemoryRelayJournal(), node: nodeNeverAsked });
    await expect(recovery.reconcile()).resolves.toEqual({ latched: false, entries: [] });
  });

  it("retains a hashless intent as ambiguous", async () => {
    const journal = await journalWith({
      ...entry(),
      resolutionId: "attempt-1",
      transactionHash: null,
      signedTransaction: null,
      submissionKind: "eip1193_intent",
    });
    const recovery = new RelayJournalRecoveryManager({
      journal,
      node: nodeNeverAsked,
      readL1Receipt: async () => { throw new Error("must not read L1 without a hash"); },
    });

    await expect(recovery.reconcile()).resolves.toEqual({
      latched: true,
      entries: [{ outcome: "ambiguous", resolutionId: "attempt-1" }],
    });
    await expect(journal.read()).resolves.toHaveLength(1);
  });

  it("retains a broadcast transaction until it is mined", async () => {
    const journal = await journalWith(entry());
    const recovery = new RelayJournalRecoveryManager({ journal, node: nodeNeverAsked, readL1Receipt: async () => null });

    await expect(recovery.reconcile()).resolves.toEqual({
      latched: true,
      entries: [{ outcome: "pending", resolutionId: HASH, transactionHash: HASH }],
    });
    await expect(journal.read()).resolves.toEqual([entry()]);
  });

  it("retains a mined batch until the node has recorded its delivery", async () => {
    const journal = await journalWith(entry());
    const recovery = new RelayJournalRecoveryManager({ journal, node: nodeWithout, readL1Receipt: async () => l1Receipt() });

    await expect(recovery.reconcile()).resolves.toEqual({
      latched: true,
      entries: [{
        outcome: "unobserved",
        resolutionId: HASH,
        transactionHash: HASH,
        l1Receipt: { status: 1, blockNumber: 9n, blockHash: BLOCK_HASH, transactionIndex: 0, gasUsed: 21_000n },
      }],
    });
    await expect(journal.read()).resolves.toEqual([entry()]);
  });

  it("clears once the node has recorded the delivery, without waiting for finality", async () => {
    const journal = await journalWith(entry());
    const recovery = new RelayJournalRecoveryManager({ journal, node: nodeWith, readL1Receipt: async () => l1Receipt() });

    await expect(recovery.reconcile()).resolves.toEqual({
      latched: false,
      entries: [{
        outcome: "cleared",
        resolutionId: HASH,
        transactionHash: HASH,
        l1Receipt: { status: 1, blockNumber: 9n, blockHash: BLOCK_HASH, transactionIndex: 0, gasUsed: 21_000n },
      }],
    });
    await expect(journal.read()).resolves.toEqual([]);
  });

  it.each([HASH, OTHER_HASH])("reconciles the mined attempt %s under the original resolution", async (minedHash) => {
    const journal = await journalWith({ ...entry(), transactionHash: OTHER_HASH, previousTransactionHashes: [HASH] });
    const delivery = vi.fn(async () => recorded);
    const read = vi.fn(async (_entry, hash: string) => hash === minedHash ? l1Receipt() : null);
    const recovery = new RelayJournalRecoveryManager({ journal, node: { getInboxDeliveryBatch: delivery }, readL1Receipt: read });
    await expect(recovery.reconcile()).resolves.toMatchObject({
      latched: false, entries: [{ outcome: "cleared", resolutionId: HASH, transactionHash: minedHash }],
    });
    expect(delivery).toHaveBeenCalledWith(minedHash);
    expect(read.mock.calls.map((call) => call[1])).toEqual(minedHash === HASH ? [OTHER_HASH, HASH] : [OTHER_HASH]);
    await expect(journal.read()).resolves.toEqual([]);
  });

  it("retains a status-zero batch until canonical delivery is recorded", async () => {
    const journal = await journalWith(entry());
    let delivery: L1DeliveryBatchResult | null = null;
    const recovery = new RelayJournalRecoveryManager({
      journal, node: { getInboxDeliveryBatch: async () => delivery }, readL1Receipt: async () => l1Receipt("reverted"),
    });
    await expect(recovery.reconcile()).resolves.toMatchObject({
      latched: true, entries: [{ outcome: "unobserved", l1Receipt: { status: 0 } }],
    });
    await expect(journal.read()).resolves.toEqual([entry()]);
    delivery = recorded;
    await expect(recovery.reconcile()).resolves.toMatchObject({
      latched: false, entries: [{ outcome: "cleared", l1Receipt: { status: 0 } }],
    });
    await expect(journal.read()).resolves.toEqual([]);
  });

  it("clears a reverted generic call at its receipt without consulting the node", async () => {
    const journal = await journalWith(callEntry());
    const recovery = new RelayJournalRecoveryManager({ journal, node: nodeNeverAsked, readL1Receipt: async () => l1Receipt("reverted") });
    await expect(recovery.reconcile()).resolves.toMatchObject({
      latched: false, entries: [{ outcome: "cleared", l1Receipt: { status: 0 } }],
    });
    await expect(journal.read()).resolves.toEqual([]);
  });

  it("clears a mined call at its receipt without consulting the node", async () => {
    const journal = await journalWith(callEntry());
    const recovery = new RelayJournalRecoveryManager({ journal, node: nodeNeverAsked, readL1Receipt: async () => l1Receipt() });

    await expect(recovery.reconcile()).resolves.toMatchObject({
      latched: false,
      entries: [{ outcome: "cleared", resolutionId: OTHER_HASH, l1Receipt: { status: 1 } }],
    });
    await expect(journal.read()).resolves.toEqual([]);
  });

  it("settles each in-flight entry independently", async () => {
    const journal = await journalWith(entry(), callEntry());
    const recovery = new RelayJournalRecoveryManager({
      journal,
      node: nodeNeverAsked,
      readL1Receipt: async (value) => value.kind === "call" ? l1Receipt() : null,
    });

    await expect(recovery.reconcile()).resolves.toMatchObject({
      latched: true,
      entries: [
        { outcome: "pending", resolutionId: HASH },
        { outcome: "cleared", resolutionId: OTHER_HASH },
      ],
    });
    await expect(journal.read()).resolves.toEqual([entry()]);
  });

  it("archives only the entry under the exact resolution id", async () => {
    const journal = await journalWith(entry(), callEntry());
    const recovery = new RelayJournalRecoveryManager({ journal, node: nodeNeverAsked, readL1Receipt: async () => null });

    await expect(recovery.resolve(`0x${"99".repeat(32)}`)).rejects.toThrow(/holds no resolution/);
    await expect(recovery.resolve(HASH)).resolves.toEqual({
      latched: true,
      resolutionId: HASH,
      transactionHash: HASH,
      archivePath: `memory://relay-journal/resolved/${HASH}`,
    });
    await expect(journal.read()).resolves.toEqual([callEntry()]);
    await expect(recovery.resolve(OTHER_HASH)).resolves.toMatchObject({ latched: false, resolutionId: OTHER_HASH });
    await expect(journal.read()).resolves.toEqual([]);
  });

  it("fails when unconfigured l1Rpc is needed for default receipt recovery", async () => {
    const journal = await journalWith(entry());
    const recovery = new RelayJournalRecoveryManager({ journal, node: nodeNeverAsked });

    await expect(recovery.reconcile()).rejects.toThrow(/recovery requires an L1 RPC URL/);
  });

  it("reports an L1 identity mismatch verbatim instead of only its error name", async () => {
    const journal = await journalWith(entry());
    const recovery = new RelayJournalRecoveryManager({
      journal,
      node: nodeNeverAsked,
      l1Rpc: "http://unused",
      transportFor: () => custom({
        async request({ method }) {
          if (method === "eth_chainId") return "0x2";
          throw new Error(`unexpected RPC method ${method}`);
        },
      }),
    });

    const failure = await recovery.reconcile().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RelayUpstreamError);
    expect((failure as Error).message).toMatch(/L1 endpoint chain id 2 does not match node L1 chain id 1/);
    await expect(journal.read()).resolves.toHaveLength(1);
  });

  it("leaves no deadline timer running when a receipt read throws synchronously", async () => {
    vi.useFakeTimers();
    try {
      const journal = await journalWith(entry());
      const recovery = new RelayJournalRecoveryManager({
        journal,
        node: nodeNeverAsked,
        readL1Receipt: () => {
          throw new Error("synchronous read failure");
        },
      });

      await expect(recovery.reconcile()).rejects.toThrow(/reading the journal L1 receipt failed/);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("classifies an L1 transport timeout as a deadline", async () => {
    const journal = await journalWith(entry());
    const recovery = new RelayJournalRecoveryManager({
      journal,
      node: nodeNeverAsked,
      l1Rpc: "https://user:secret@l1.example/rpc",
      transportFor: () => custom({
        async request() {
          throw new TimeoutError({ body: {}, url: "https://user:secret@l1.example/rpc" });
        },
      }),
    });

    const failure = await recovery.reconcile().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RelayDeadlineError);
    expect((failure as Error).message).not.toContain("secret");
  });
});
