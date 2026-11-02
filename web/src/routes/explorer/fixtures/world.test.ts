// The recording stands in for a node, so it has to be complete: every
// cross-reference a page follows must land on recorded data, every named
// state must exist, and every page of a cursor walk must be disjoint.

import { describe, expect, it } from "vitest";
import type { ExplorerCursor } from "@pcash/sdk/clients";
import { pscanIdentityMatches } from "../rpc.ts";
import { fixtureIds, fixtureStatus, fixtureWorld } from "./world.ts";
import { createFixtureReader } from "./reader.ts";

const reader = createFixtureReader();
const hash32 = /^0x[0-9a-f]{64}$/;

function inclusionKey(inclusion: { l1BlockHash: string; l1TransactionIndex: bigint; batchItemIndex: bigint }): string {
  return `${inclusion.l1BlockHash.toLowerCase()}:${inclusion.l1TransactionIndex}:${inclusion.batchItemIndex}`;
}

describe("recorded fixture completeness", () => {
  it("places every transaction in a recorded block at a dense ordinal", () => {
    const perBlock = new Map<string, bigint[]>();
    for (const { summary } of fixtureWorld.transactions) {
      const block = fixtureWorld.blocksByHash.get(summary.block.blockHash.toLowerCase());
      expect(block, summary.transactionId).toBeDefined();
      expect(block?.number).toBe(summary.block.blockNumber);
      perBlock.set(summary.block.blockHash, [...(perBlock.get(summary.block.blockHash) ?? []), summary.pcashTransactionIndex]);
    }
    for (const [blockHash, ordinals] of perBlock) {
      const block = fixtureWorld.blocksByHash.get(blockHash.toLowerCase())!;
      expect([...ordinals].sort((left, right) => Number(left - right)), blockHash)
        .toEqual(ordinals.map((_value, index) => BigInt(index)));
      expect(BigInt(ordinals.length)).toBe(block.transactionResultCount);
    }
  });

  it("resolves every receipt onto exactly one recorded admitted batch item", () => {
    const items = new Map<string, { contentHash: string; exclusionReason: string | null }>();
    for (const batch of fixtureWorld.batches) {
      for (const item of batch.items) {
        items.set(inclusionKey({ l1BlockHash: batch.l1BlockHash, l1TransactionIndex: batch.l1TransactionIndex, batchItemIndex: item.batchItemIndex }), item);
      }
    }
    for (const { summary, receipts } of fixtureWorld.transactions) {
      expect(receipts.length, summary.transactionId).toBe(1);
      const item = items.get(inclusionKey(receipts[0]!.inclusion));
      expect(item, summary.transactionId).toBeDefined();
      expect(item?.contentHash.toLowerCase()).toBe(summary.contentHash.toLowerCase());
      expect(item?.exclusionReason).toBeNull();
    }
  });

  it("holds every failure outcome the seed produces, both blockPayouts routes, and zero and nonzero fees", () => {
    const outcomes = new Set(fixtureWorld.transactions.map(({ summary }) => summary.outcome));
    expect(outcomes.size).toBe(22);
    expect(outcomes).toEqual(new Set(Object.keys(fixtureIds.outcomes)));
    for (const [outcome, transactionId] of Object.entries(fixtureIds.outcomes)) {
      expect(fixtureWorld.transactionsById.get(transactionId.toLowerCase())?.summary.outcome, outcome).toBe(outcome);
    }
    const outputMutation = fixtureIds.transactions["control-transfer-output-byte-zero"]!;
    expect(fixtureWorld.transactionsById.get(outputMutation.toLowerCase())?.summary.outcome).toBe("proofRejected");
    // The node labels every private-value action's blockPayouts open or designated by its
    // declared commitment, zero fees included; "none" is the label for kinds without a section.
    const succeededValue = fixtureWorld.transactions
      .map(({ summary }) => summary)
      .filter((summary) => summary.outcome === "succeeded" && summary.kind === "privateValue");
    for (const route of ["open", "designated"] as const) {
      expect(succeededValue.some((summary) => summary.issuanceRoute === route), route).toBe(true);
    }
    expect(succeededValue.some((summary) => summary.declaredOpenFeeAmount === 0n)).toBe(true);
    expect(succeededValue.some((summary) => (summary.declaredOpenFeeAmount ?? 0n) > 0n)).toBe(true);
    expect(fixtureWorld.transactions.some(({ summary }) => summary.kind !== "privateValue" && summary.issuanceRoute === "none")).toBe(true);
  });

  it("records the batch states the states page links to", async () => {
    const only = async (hash: string) => {
      const batches = await reader.l1DeliveryBatches(hash);
      expect(batches).toHaveLength(1);
      return batches[0];
    };
    const admitted = await only(fixtureIds.batches.allAdmitted);
    expect(admitted?.items.length).toBeGreaterThan(1);
    expect(admitted?.items.every((item) => item.exclusionReason === null)).toBe(true);
    const gaps = await only(fixtureIds.batches.withExclusions);
    expect(gaps?.items.some((item) => item.exclusionReason !== null)).toBe(true);
    expect(gaps?.items.some((item) => item.exclusionReason === null)).toBe(true);
    const allExcluded = await only(fixtureIds.batches.allExcluded);
    expect(allExcluded?.exclusionReason).toBeNull();
    expect(allExcluded?.items.every((item) => item.exclusionReason !== null)).toBe(true);
    const reasons = new Set(fixtureWorld.batches.flatMap((batch) => batch.items.map((item) => item.exclusionReason)).filter((reason) => reason !== null));
    expect(reasons).toEqual(new Set(["itemTooLarge", "empty", "truncated", "trailingBytes", "unknownKind", "wrongChainId", "unknownYParity", "unknownAccountCreationTag", "unknownReceiveKeyMode", "unknownPublishesNkRootFlag"]));
    const blob = await only(fixtureIds.batches.blob);
    expect(blob?.carrierType).toBe("blob");
    expect(blob?.blobVersionedHashes).toHaveLength(2);
    expect(blob?.items).toEqual([
      expect.objectContaining({ exclusionReason: "itemTooLarge" }),
    ]);
    const event = await only(fixtureIds.batches.event);
    expect(event?.carrierType).toBe("event");
    expect(event?.emitter).toMatch(/^0x[0-9a-f]{40}$/);
    expect(event?.logIndex).not.toBeNull();
    expect(event?.context).toMatch(/^0x[0-9a-f]{256}$/);
    const claim = fixtureWorld.transactionsById.get(fixtureIds.transactions["marketplace:claim"]!.toLowerCase());
    expect(event?.items).toEqual([expect.objectContaining({ contentHash: claim?.summary.contentHash, exclusionReason: null })]);
    expect(claim?.receipts[0]?.inclusion.l1TransactionHash.toLowerCase()).toBe(fixtureIds.batches.event);
    for (const [label, hash] of Object.entries(fixtureIds.batches.excluded)) {
      const batch = await only(hash);
      expect(batch?.exclusionReason, label).not.toBeNull();
      expect(batch?.items, label).toEqual([]);
    }
  });

  it("records the account states the states page links to", async () => {
    for (const address of fixtureIds.contracts.verified) {
      expect((await reader.contractSource(address))?.verificationStatus, address).toBe("verified");
      expect((await reader.accountSnapshot(address)).account?.accountKind).toBe(1);
    }
    const vault = await reader.contractSource(fixtureIds.contracts.unverified);
    expect(vault === null || vault.verificationStatus === "not_verified").toBe(true);
    expect((await reader.accountSnapshot(fixtureIds.contracts.unverified)).account?.accountKind).toBe(1);
    const { account: keyless } = await reader.accountSnapshot(fixtureIds.addresses.keyless);
    expect(keyless?.receiveKeyHash).toBe(`0x${"00".repeat(32)}`);
    const { account: updated } = await reader.accountSnapshot(fixtureIds.addresses.actors.R!);
    expect(updated?.accountRevision).toBeGreaterThan(0n);
    expect((await reader.accountSnapshot(fixtureIds.addresses.relayer)).account).toBeNull();
    expect((await reader.accountSnapshot(fixtureIds.addresses.unknown)).account).toBeNull();
    const history = await reader.accountHistory({ address: fixtureIds.addresses.actors.S!, limit: 500 });
    expect(history.items.length).toBeGreaterThan(0);
  });

  it("records every contract as a contract account whose history holds its creation", async () => {
    for (const contract of fixtureWorld.contracts) {
      expect((await reader.accountSnapshot(contract.address)).account?.accountKind, contract.address).toBe(1);
      const history = await reader.accountHistory({ address: contract.address, limit: 500 });
      expect(history.items.map((item) => item.transactionId), contract.address).toContain(contract.transactionId);
    }
  });

  it("serves source for every implementation a recorded contract names", async () => {
    for (const contract of fixtureWorld.contracts) {
      if (contract.sourceVerification !== "verified") continue;
      const view = await reader.contractSource(contract.address);
      expect(view?.presentation, contract.address).not.toBeNull();
      for (const implementation of view?.implementations ?? []) {
        const source = await reader.implementationSource(implementation.applicationVkHash);
        expect(source, implementation.applicationVkHash).not.toBeNull();
        for (const { path } of source?.sourceFiles ?? []) {
          expect((await reader.sourceFile(implementation.applicationVkHash, path))?.content.length).toBeGreaterThan(0);
        }
      }
      expect(await reader.contractBundle(contract.address)).not.toBeNull();
    }
  });

  it("pins the source service to the same chain the status reports", async () => {
    const { info, status } = await reader.sourceInfo();
    expect(pscanIdentityMatches(info, status)).toBe(true);
    expect(fixtureStatus.pcashChainId).toBe(fixtureWorld.status.pcashChainId);
    expect(fixtureIds.spentNullifier).toMatch(hash32);
    expect(fixtureIds.pending.length).toBeGreaterThanOrEqual(3);
    for (const hash of fixtureIds.pending) expect(fixtureWorld.mempool.some((item) => item.contentHash.toLowerCase() === hash)).toBe(true);
  });

  it("returns nothing for unknown keys", async () => {
    const missing = `0x${"00".repeat(32)}`;
    expect(await reader.transaction(missing)).toBeNull();
    expect(await reader.receipt(missing)).toEqual([]);
    expect(await reader.blockByHash(missing)).toBeNull();
    expect(await reader.l1DeliveryBatches(missing)).toEqual([]);
    expect(await reader.implementationSource(missing)).toBeNull();
    expect(await reader.sourceFile(missing, "src/main.nr")).toBeNull();
    expect(await reader.contractBundle(fixtureIds.addresses.unknown)).toBeNull();
    expect(await reader.block(fixtureStatus.latestBlock + 1n)).toBeNull();
    expect(await reader.blockBlockPayouts({ blockNumber: fixtureStatus.latestBlock + 1n, blockHash: missing })).toBeNull();
    expect(await reader.blockBlockPayouts({ blockNumber: fixtureStatus.latestBlock, blockHash: missing })).toBeNull();
  });
});

describe("fixture reader pagination", () => {
  it("walks every transaction exactly once", async () => {
    const seen: string[] = [];
    let cursor: ExplorerCursor | undefined;
    for (let page = 0; page < 500; page += 1) {
      const result = await reader.transactions({ limit: 7, ...(cursor ? { cursor } : {}) });
      for (const item of result.items) seen.push(item.transactionId);
      if (result.nextCursor === null) break;
      cursor = result.nextCursor;
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.length).toBe(fixtureWorld.transactions.length);
  });

  it("filters transactions by kind and block while paging", async () => {
    const page = await reader.transactions({ limit: 50, kind: "contractAccount" });
    expect(page.items.length).toBeGreaterThan(1);
    expect(page.items.every((item) => item.kind === "contractAccount")).toBe(true);
    const succeeded = page.items.filter((item) => item.outcome === "succeeded");
    expect(succeeded.every(item => item.accountCreation === 1)).toBe(true);
    const block = fixtureWorld.blocksByHash.get(fixtureIds.blocks.withTransactions)!;
    const inBlock = await reader.transactions({ limit: 50, blockNumber: block.number });
    expect(inBlock.items.length).toBe(Number(block.transactionResultCount));
    expect(inBlock.items.every((item) => item.block.blockNumber === block.number)).toBe(true);
  });

  it("walks every contract exactly once and honours verifiedOnly", async () => {
    const seen: string[] = [];
    let cursor: ExplorerCursor | undefined;
    for (let page = 0; page < 50; page += 1) {
      const result = await reader.contracts({ limit: 2, ...(cursor ? { cursor } : {}) });
      for (const item of result.items) seen.push(item.address);
      if (result.nextCursor === null) break;
      cursor = result.nextCursor;
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.length).toBe(fixtureWorld.contracts.length);
    const verified = await reader.contracts({ limit: 50, verifiedOnly: true });
    expect(verified.items.length).toBe(fixtureIds.contracts.verified.length);
    expect(verified.items.every((item) => item.sourceVerification === "verified")).toBe(true);
  });

  it("walks the mempool exactly once under both sorts and filters by fee", async () => {
    for (const sort of ["receivedAt", "feeDensity"] as const) {
      const seen: string[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 50; page += 1) {
        const result = await reader.mempool({ limit: 2, sort, ...(cursor ? { cursor } : {}) });
        for (const item of result.items) seen.push(item.contentHash);
        if (result.nextCursor === null) break;
        cursor = result.nextCursor;
      }
      expect(new Set(seen).size, sort).toBe(seen.length);
      expect(seen.length, sort).toBe(fixtureWorld.mempool.length);
    }
    const dense = await reader.mempool({ limit: 50, sort: "feeDensity" });
    const densities = dense.items.map((item) => (item.openFeeAmount * 1_000_000n) / item.byteSize);
    expect([...densities].sort((left, right) => (right > left ? 1 : right < left ? -1 : 0))).toEqual(densities);
    const fees = fixtureWorld.mempool.map((item) => item.openFeeAmount);
    const minimum = fees.reduce((largest, fee) => (fee > largest ? fee : largest), 0n);
    const rich = await reader.mempool({ limit: 50, minOpenFee: minimum });
    expect(rich.items.every((item) => item.openFeeAmount >= minimum)).toBe(true);
    expect(rich.items.length).toBeGreaterThan(0);
  });



  it("assembles the dashboard from one consistent head", async () => {
    const [blocks, transactions] = await reader.dashboard(
      fixtureStatus.latestBlock - 6n,
      fixtureStatus.latestBlock,
    );
    expect(blocks.map((block) => block.number)).toEqual([0, 1, 2, 3, 4, 5, 6].map((offset) =>
      fixtureStatus.latestBlock - 6n + BigInt(offset)));
    expect(transactions.items.length).toBe(10);
    expect(transactions.head.blockHash).toBe(fixtureStatus.latestBlockHash);
  });


});
