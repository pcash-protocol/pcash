import assert from "node:assert/strict";
import test from "node:test";
import type { PcashNodeClient } from "@pcash/sdk/clients";
import { advanceLinkSet, createLinkSet, linkSets } from "../src/client/links.ts";
import { fundContractNotes, type TokensRuntime } from "../src/client/runtime.ts";
import { MemoryTokensStore, type DropRecord } from "../src/client/store.ts";
import { fundedLeaves, fundedOutputs } from "../src/witness.ts";

const CONTRACT = 0xc0n;
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;

function receipt(id: string, outputLeafStart: bigint) {
  return {
    outcome: "succeeded", kind: "privateValue", transactionId: hash(Number(BigInt(id)) + 0x1000), contentHash: id, outputLeafStart, failureDetail: null,
    l1Sender: `0x${"00".repeat(20)}`, issuanceOwnerCommitment: null, settledOpenFeeAmount: 0n, settledIssuanceAmount: 0n,
    inclusion: { l1BlockNumber: 1n, l1BlockHash: hash(0xb10c) },
  };
}

/**
 * A wallet whose chunks are accepted but never final: every chunk outcome
 * stays unresolved, as it does until Ethereum finalizes its block. A chunk
 * submitted unaccepted lands after `landAfterReads` receipt reads; `saved`
 * chunks were journaled by an earlier run and never reached the chain.
 */
function fakeChain(notes: number, options: { accepted?: boolean; landAfterReads?: number; saved?: number } = {}) {
  const leafStarts = new Map<string, bigint>();
  const landing = new Map<string, number>();
  const chunks: { contentHash: string; firstRecipient: number; recipientCount: number; outcome: "unresolved" }[] = [];
  const steps: (number | undefined)[] = [];
  const recipients = Array.from({ length: notes }, () => ({ to: `0x${CONTRACT.toString(16).padStart(40, "0")}`, amount: 1n }));
  const addChunk = () => {
    const first = chunks.reduce((sum, chunk) => sum + chunk.recipientCount, 0);
    chunks.push({ contentHash: hash(chunks.length + 1), firstRecipient: first, recipientCount: Math.min(4, notes - first), outcome: "unresolved" });
  };
  for (let saved = 0; saved < (options.saved ?? 0); saved++) addChunk();
  let started = chunks.length > 0;
  const wallet = {
    bulkJobs: async () => started ? [{ jobId: "job", assetId: 5n, recipients, chunks: structuredClone(chunks) }] : [],
    startBulkJob: async (intent: { accountCreation: { kind: string; body: Uint8Array } }) => { assert.deepEqual(intent.accountCreation, { kind: "contract", body: Uint8Array.of(1, 2, 3) }); started = true; return { jobId: "job" }; },
    sync: async () => undefined,
    runBulkJobStep: async ({ chunkIndex }: { chunkIndex?: number }) => {
      steps.push(chunkIndex);
      const index = chunkIndex!;
      if (index === chunks.length) addChunk();
      const chunk = chunks[index]!;
      const accepted = options.accepted ?? true;
      if (accepted) leafStarts.set(chunk.contentHash, BigInt(100 * (index + 1)));
      else landing.set(chunk.contentHash, options.landAfterReads ?? 1);
      return { state: "submitted", jobId: "job", chunkIndex: index, result: { contentHash: chunk.contentHash, accepted, settled: false } };
    },
  };
  const node = {
    getReceipt: async ({ contentHash }: { contentHash: string }) => {
      const reads = landing.get(contentHash);
      if (reads !== undefined) {
        if (reads > 1) landing.set(contentHash, reads - 1);
        else { landing.delete(contentHash); leafStarts.set(contentHash, BigInt(100 * Number(BigInt(contentHash)))); }
      }
      const start = leafStarts.get(contentHash);
      return start === undefined ? [] : [receipt(contentHash, start)];
    },
  } as unknown as PcashNodeClient;
  return { wallet, node, chunks, steps };
}

async function fund(chain: ReturnType<typeof fakeChain>, notes: number, jobId?: string) {
  const store = new MemoryTokensStore();
  await store.update("drop", () => ({ kind: "drop", key: "drop" } as DropRecord));
  const rt = { wallet: chain.wallet, node: chain.node, prover: {}, store, pollIntervalMs: 0, pollMaxAttempts: 10, now: () => 0 } as unknown as TokensRuntime;
  return fundContractNotes(rt, "drop", {
    contract: { address: CONTRACT, body: Uint8Array.of(1, 2, 3) },
    assetId: 5n,
    notes: Array.from({ length: notes }, (_, index) => ({ noteSecret: BigInt(index + 1), amount: 1n })),
    jobId,
    recoveryTag: Uint8Array.of(1),
    openFeeAmount: undefined,
  }, undefined);
}

test("funding proves each chunk once the previous one is accepted, never waiting for finality", async () => {
  const chain = fakeChain(9);
  const funding = await fund(chain, 9);
  assert.deepEqual(funding, [{ contentHash: hash(1), firstIndex: 0, count: 4 }, { contentHash: hash(2), firstIndex: 4, count: 4 }, { contentHash: hash(3), firstIndex: 8, count: 1 }]);
  assert.deepEqual(chain.steps, [0, 1, 2]);
  assert.ok(chain.chunks.every((chunk) => chunk.outcome === "unresolved"));
  assert.deepEqual(await fundedLeaves(chain.node, fundedOutputs(funding)), [100, 101, 102, 103, 200, 201, 202, 203, 300]);
});

test("resumed funding resubmits a saved chunk that never reached the chain before proving the next", async () => {
  const chain = fakeChain(5, { saved: 1 });
  const funding = await fund(chain, 5, "job");
  assert.deepEqual(chain.steps, [0, 1]);
  assert.deepEqual(funding, [{ contentHash: hash(1), firstIndex: 0, count: 4 }, { contentHash: hash(2), firstIndex: 4, count: 1 }]);
});

test("funding waits for a chunk it sent to land instead of sending it again", async () => {
  const chain = fakeChain(5, { accepted: false, landAfterReads: 3 });
  const funding = await fund(chain, 5);
  assert.deepEqual(chain.steps, [0, 1]);
  assert.deepEqual(funding, [{ contentHash: hash(1), firstIndex: 0, count: 4 }, { contentHash: hash(2), firstIndex: 4, count: 1 }]);
});

test("a leaf resolves only while its funding transaction has an accepted receipt", async () => {
  const chain = fakeChain(1);
  assert.deepEqual(await fundedLeaves(chain.node, [{ contentHash: hash(1), slot: 0 }]), [null]);
  await fund(chain, 1);
  assert.deepEqual(await fundedLeaves(chain.node, [{ contentHash: hash(1), slot: 0 }, { contentHash: hash(7), slot: 2 }]), [100, null]);
});

test("createLinkSet reports the key before funding finishes, keeps an unsubmitted attempt, and resumes after a post-funding sync failure", async () => {
  const store = new MemoryTokensStore();
  const jobs: { jobId: string; assetId: bigint; openFeeAmount?: bigint; recipients: { to: string; amount: bigint }[]; chunks: { contentHash: string; firstRecipient: number; recipientCount: number; outcome: "unresolved" }[] }[] = [];
  let failBeforeChunk = true;
  let failSyncOnce = false;
  let syncs = 0;
  const wallet = {
    address: `0x${"11".repeat(20)}`,
    network: { chainId: 1n },
    assets: async () => [],
    balances: async () => [{ assetId: 0n, spendable: 100n }],
    bulkRecoveries: async () => [],
    execute: async (action: (ctx: unknown) => unknown) => action({ profile: { nkRoot: 7n }, submission: {} }),
    bulkJobs: async () => structuredClone(jobs),
    startBulkJob: async (intent: { assetId: bigint; openFeeAmount?: bigint; recipients: { to: string; amount: bigint }[] }) => {
      const job = { jobId: `job:${jobs.length + 1}`, assetId: intent.assetId, openFeeAmount: intent.openFeeAmount, recipients: intent.recipients, chunks: [] };
      jobs.push(job);
      return { jobId: job.jobId };
    },
    runBulkJobStep: async ({ jobId }: { jobId: string }) => {
      if (failBeforeChunk) throw new Error("failed before any chunk was submitted");
      const job = jobs.find((candidate) => candidate.jobId === jobId)!;
      const contentHash = hash(jobs.length);
      job.chunks.push({ contentHash, firstRecipient: 0, recipientCount: 1, outcome: "unresolved" });
      return { state: "submitted", jobId, chunkIndex: 0, result: { contentHash, accepted: true, settled: false } };
    },
    sync: async () => {
      syncs += 1;
      if (failSyncOnce) { failSyncOnce = false; throw new Error("sync failed after funding"); }
    },
  };
  const node = { getReceipt: async ({ contentHash }: { contentHash: string }) => [receipt(contentHash, 100n)] } as unknown as PcashNodeClient;
  const rt = { wallet, node, prover: {}, store, pollIntervalMs: 0, pollMaxAttempts: 2, now: () => 1 } as unknown as TokensRuntime;

  let firstKey: string | undefined;
  await assert.rejects(() => createLinkSet(rt, { assetId: 0n, amounts: [10n], openFeeAmount: 100n, onCreated: (key) => { firstKey = key; } }), /failed before any chunk/);
  assert.ok(firstKey !== undefined);

  failBeforeChunk = false;
  failSyncOnce = true;
  let secondKey: string | undefined;
  await assert.rejects(() => createLinkSet(rt, { assetId: 0n, amounts: [10n], openFeeAmount: 1n, onCreated: (key) => { secondKey = key; } }), /sync failed after funding/);
  assert.ok(secondKey !== undefined && secondKey !== firstKey);
  assert.deepEqual(jobs.map((job) => ({ openFeeAmount: job.openFeeAmount, chunks: job.chunks.length })), [
    { openFeeAmount: 100n, chunks: 0 },
    { openFeeAmount: 1n, chunks: 1 },
  ]);

  // Even after linkSets reconciles the funded record to ready, resuming its key finishes the sync without a second funding job.
  // The earlier attempt stays stored: another tab may still be proving its first chunk.
  const all = await linkSets(rt);
  assert.deepEqual(Object.fromEntries(all.map((set) => [set.key, set.phase])), { [firstKey!]: "funding", [secondKey!]: "ready" });
  const resumed = await advanceLinkSet(rt, secondKey!);
  assert.equal(resumed.key, secondKey);
  assert.equal(resumed.phase, "ready");
  assert.equal(jobs.length, 2);
  assert.equal(syncs, 2);
});
