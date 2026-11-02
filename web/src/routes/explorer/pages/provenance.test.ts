import { describe, expect, it, vi } from "vitest";
import { PcashNodeRpcError } from "@pcash/sdk/clients";
import { createFixtureReader } from "../fixtures/reader.ts";
import { fixtureIds, fixtureStatus } from "../fixtures/world.ts";
import { resolveHashMatches } from "./SearchPage.tsx";
import { loadBatchView } from "./BatchPage.tsx";

const reader = createFixtureReader();

describe("pending hash search", () => {
  it("finds bytes held in the mempool before their first canonical inclusion", async () => {
    const hash = fixtureIds.pending[0]!;
    expect(await reader.transaction(hash)).toBeNull();
    expect((await reader.submission(hash)).items).toEqual([]);
    expect(await resolveHashMatches(reader, hash)).toEqual([
      { label: "Pending submission", detail: "Known to this node; not posted", path: `/tx/${hash}` },
    ]);
  });

  it("keeps the same destination when the bytes acquire an inclusion", async () => {
    const hash = fixtureIds.pending[0]!;
    const summary = (await reader.transactions({ limit: 1 })).items[0]!;
    const posted = { ...reader, submission: vi.fn().mockResolvedValue({ items: [{ ...summary, contentHash: hash }], nextCursor: null, head: summary.block }) };
    const matches = await resolveHashMatches(posted, hash);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.path).toBe(`/tx/${hash}`);
    expect(matches[0]?.label).toBe("Content hash");
  });
});

describe("hash search availability", () => {
  const missing = `0x${"ff".repeat(32)}`;

  it("reports absence only after every lookup succeeds", async () => {
    expect(await resolveHashMatches(reader, missing)).toEqual([]);
  });

  it("reads the node refusing the bytes as a block hash as no block", async () => {
    const refused = new PcashNodeRpcError(
      { code: -32602, message: "blockHash must be a nonzero canonical BN254 field encoding" },
      { method: "pcash_getBlockByHash", url: "http://node" },
    );
    const node = { ...reader, blockByHash: vi.fn().mockRejectedValue(refused) };
    expect(await resolveHashMatches(node, missing)).toEqual([]);
    const batch = fixtureIds.batches.allExcluded;
    expect(await resolveHashMatches(node, batch)).toEqual([expect.objectContaining({ label: "L1 batch", path: `/batch/${batch}` })]);
  });

  it.each(["transaction", "submission", "blockByHash", "l1DeliveryBatches", "mempoolTransaction"] as const)("propagates %s failure instead of reporting absence", async (method) => {
    const failure = new Error("catchingUp");
    const unavailable = { ...reader, [method]: vi.fn().mockRejectedValue(failure) };
    await expect(resolveHashMatches(unavailable, missing)).rejects.toBe(failure);
  });

  it("does not claim a pending match is unique when the canonical index is unavailable", async () => {
    const failure = new Error("catchingUp");
    const unavailable = { ...reader, submission: vi.fn().mockRejectedValue(failure) };
    await expect(resolveHashMatches(unavailable, fixtureIds.pending[0]!)).rejects.toBe(failure);
  });
});

describe("batch provenance", () => {
  it.each([
    ["all framed items excluded", fixtureIds.batches.allExcluded],
    ...Object.entries(fixtureIds.batches.excluded),
  ])("retains the PCASH block when %s", async (_kind, hash) => {
    const transaction = vi.spyOn(reader, "transaction");
    const view = await loadBatchView(reader, hash, fixtureStatus.genesisL1Block);
    expect(view.batches).not.toHaveLength(0);
    expect(view.outcome).toEqual({ blockNumber: view.batches[0]!.l1BlockNumber - fixtureStatus.genesisL1Block, succeeded: 0, failed: 0 });
    expect(transaction).not.toHaveBeenCalled();
    transaction.mockRestore();
  });

  it("keeps a missing block distinct from a block with zero transaction outcomes", async () => {
    const unavailable = { ...reader, block: vi.fn().mockResolvedValue(null) };
    const view = await loadBatchView(unavailable, fixtureIds.batches.allExcluded, fixtureStatus.genesisL1Block);
    expect(view.batches).not.toHaveLength(0);
    expect(view.outcome).toBeNull();
  });
});

describe("batch outcome refresh", () => {
  it("retains known outcomes on a transient block read failure for the same inclusion", async () => {
    const id = fixtureIds.batches.allExcluded;
    const prior = await loadBatchView(reader, id, fixtureStatus.genesisL1Block);
    const unavailable = { ...reader, block: vi.fn().mockRejectedValue(new Error("node offline")) };
    const delayed = await loadBatchView(unavailable, id, fixtureStatus.genesisL1Block, prior);
    expect(delayed.outcome).toEqual(prior.outcome);
    expect(delayed.detailError).toBe("node offline");
    const replacement = { ...unavailable, l1DeliveryBatches: vi.fn().mockResolvedValue([{ ...prior.batches[0]!, l1BlockHash: "replacement" }]) };
    expect((await loadBatchView(replacement, id, fixtureStatus.genesisL1Block, prior)).outcome).toBeNull();
  });
});
