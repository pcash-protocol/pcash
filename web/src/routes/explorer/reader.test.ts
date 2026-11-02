import { describe, expect, it, vi } from "vitest";
import { PcashNodeClient, type BlockResult, type ExplorerCursor } from "@pcash/sdk/clients";
import { createExplorerReader } from "./ExplorerProvider.tsx";
import { SourceRpcClient } from "./rpc.ts";
import { fixtureStatus, fixtureWorld } from "./fixtures/world.ts";

function client() {
  const node = new PcashNodeClient("http://localhost:1");
  return { node, source: new SourceRpcClient(node) };
}

describe("explorer reads", () => {
  it("attaches account data to its proof boundary despite status changing away and back", async () => {
    const clients = client();
    let status = fixtureStatus;
    type AccountProof = Awaited<ReturnType<PcashNodeClient["getAccountProof"]>>;
    let finish!: (proof: AccountProof) => void;
    const get = vi.spyOn(clients.node, "getAccountProof").mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const reader = createExplorerReader((operation) => operation(clients, status));
    const account = [...fixtureWorld.accounts.values()].find((entry) => entry.account)?.account!;
    const proofHeadHash = `0x${"0b".repeat(32)}`;
    const pending = reader.accountSnapshot(account.address);
    status = { ...fixtureStatus, latestBlockHash: proofHeadHash };
    await Promise.resolve();
    status = fixtureStatus;
    // The SDK verifies the proof; this reader only consumes its account and boundary hash.
    finish({ status: "present", account, boundary: { blockHash: BigInt(proofHeadHash) } } as AccountProof);
    expect(await pending).toEqual({ account, headHash: proofHeadHash });
    expect(get).toHaveBeenCalledWith(account.address);
  });

  it("quotes issuance for one L1 slot after the status it was given", async () => {
    const clients = client();
    const quote = vi.spyOn(clients.node, "getIssuanceQuote").mockResolvedValue(fixtureWorld.issuance);
    const reader = createExplorerReader((operation) => operation(clients, fixtureStatus));
    expect(await reader.issuanceQuote()).toBe(fixtureWorld.issuance);
    expect(quote).toHaveBeenCalledWith(fixtureStatus.latestBlockTimestamp + 12n);
  });

  it("fails the issuance quote read like any other failed read", async () => {
    const clients = client();
    const failure = new Error("quote unavailable");
    vi.spyOn(clients.node, "getIssuanceQuote").mockRejectedValue(failure);
    const reader = createExplorerReader((operation) => operation(clients, fixtureStatus));
    await expect(reader.issuanceQuote()).rejects.toBe(failure);
  });

  it("does not attach an ambient head to an unauthenticated missing account", async () => {
    const clients = client();
    const address = `0x${"ab".repeat(20)}`;
    vi.spyOn(clients.node, "getAccountProof").mockResolvedValue({ status: "notFound", address, authenticated: false });
    const reader = createExplorerReader((operation) => operation(clients, fixtureStatus));
    expect(await reader.accountSnapshot(address)).toEqual({ account: null, headHash: undefined });
  });

  it("keeps block finality attached to the status that authorized the read", async () => {
    const clients = client();
    let status = fixtureStatus;
    let finish!: (block: BlockResult | null) => void;
    vi.spyOn(clients.node, "getBlock").mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const blockPayouts = vi.spyOn(clients.node, "getBlockPayouts").mockResolvedValue(null);
    const reader = createExplorerReader((operation) => operation(clients, status));
    const pending = reader.blockSnapshot(fixtureStatus.latestBlock);
    status = { ...fixtureStatus, finalizedBlock: fixtureStatus.latestBlock };
    const block = fixtureWorld.blocks.at(-1)!;
    finish(block);
    const snapshot = await pending;
    expect(snapshot.status.finalizedBlock).toBe(fixtureStatus.finalizedBlock);
    expect(snapshot.status).not.toBe(status);
    // The blockPayouts record is asked for by the block id the page loaded.
    expect(blockPayouts).toHaveBeenCalledWith({ blockNumber: block.number, blockHash: block.hash });
  });

  it("asks for no blockPayouts record for a block the node does not have", async () => {
    const clients = client();
    vi.spyOn(clients.node, "getBlock").mockResolvedValue(null);
    const blockPayouts = vi.spyOn(clients.node, "getBlockPayouts").mockResolvedValue(null);
    const reader = createExplorerReader((operation) => operation(clients, fixtureStatus));
    expect(await reader.blockSnapshot(fixtureStatus.latestBlock + 1n))
      .toEqual({ block: null, status: fixtureStatus, blockPayouts: null });
    expect(blockPayouts).not.toHaveBeenCalled();
  });

  it("forwards submission cursors so older successes remain reachable", async () => {
    const clients = client();
    const cursor: ExplorerCursor = { head: { blockNumber: fixtureStatus.latestBlock, blockHash: fixtureStatus.latestBlockHash }, blockNumber: 30n, pcashTransactionIndex: 2n };
    const response = { items: [], head: cursor.head, nextCursor: null };
    const get = vi.spyOn(clients.node, "getSubmission").mockResolvedValue(response);
    const reader = createExplorerReader((operation) => operation(clients, fixtureStatus));
    const hash = `0x${"ab".repeat(32)}`;
    expect(await reader.submission(hash, cursor)).toBe(response);
    expect(get).toHaveBeenCalledWith({ contentHash: hash, cursor, limit: 25 });
  });
});
