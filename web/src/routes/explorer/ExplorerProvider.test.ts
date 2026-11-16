import { describe, expect, it, vi } from "vitest";
import { ExplorerIdentityMismatch, ExplorerSession, createExplorerReader } from "./ExplorerProvider.tsx";
import { fixtureStatus, fixtureWorld } from "./fixtures/world.ts";

function session() {
  return new ExplorerSession({ rpcUrl: "http://localhost:8645", rpcDisplayUrl: "localhost", pcashChainId: fixtureStatus.pcashChainId });
}

describe("Explorer connection reads", () => {
  it("reads transaction details once without a separate receipt snapshot", async () => {
    const connection = session();
    vi.spyOn(connection, "status").mockResolvedValue(fixtureStatus);
    const { summary, rawTransaction } = fixtureWorld.transactions[0]!;
    const canonical = { summary, rawTransaction };
    const transaction = vi.spyOn(connection.clients.node, "getTransaction").mockResolvedValue(canonical);
    const receipt = vi.spyOn(connection.clients.node, "getReceipt");
    await connection.refresh();
    const reader = createExplorerReader(connection.read);
    expect(await reader.transaction(summary.transactionId)).toBe(canonical);
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(transaction).toHaveBeenCalledWith(summary.transactionId);
    expect(receipt).not.toHaveBeenCalled();
  });

  it("confirms identity once and uses refreshed status without a status call per read", async () => {
    const connection = session();
    const status = vi.spyOn(connection, "status").mockResolvedValue(fixtureStatus);
    const blocks = vi.spyOn(connection.clients.node, "getBlocks").mockResolvedValue([]);
    const reader = createExplorerReader(connection.read);
    await expect(reader.blocks(0n, 1n)).rejects.toThrow("identity has not been confirmed");
    expect(blocks).not.toHaveBeenCalled();
    await connection.refresh();
    await reader.blocks(0n, 1n);
    await reader.blocks(1n, 2n);
    expect(status).toHaveBeenCalledTimes(1);
    const updated = { ...fixtureStatus, latestBlock: fixtureStatus.latestBlock + 1n };
    status.mockResolvedValue(updated);
    await connection.refresh();
    expect(await connection.read(async (_, accepted) => accepted)).toBe(updated);
    expect(status).toHaveBeenCalledTimes(2);
  });

  it("keeps confirmed reads available through a refresh failure and recovers on the next refresh", async () => {
    const connection = session();
    const status = vi.spyOn(connection, "status").mockResolvedValue(fixtureStatus);
    await connection.refresh();
    status.mockRejectedValue(new Error("RPC timeout"));
    await expect(connection.refresh()).rejects.toThrow("RPC timeout");
    expect(await connection.read(async (_, accepted) => accepted)).toBe(fixtureStatus);
    const updated = { ...fixtureStatus, latestBlock: fixtureStatus.latestBlock + 1n };
    status.mockResolvedValue(updated);
    await connection.refresh();
    expect(await connection.read(async (_, accepted) => accepted)).toBe(updated);
  });

  it("blocks new and pending reads after an identity mismatch, including after recovery", async () => {
    const connection = session();
    const status = vi.spyOn(connection, "status").mockResolvedValue(fixtureStatus);
    await connection.refresh();
    let finish!: (value: string) => void;
    const pending = connection.read(() => new Promise<string>((resolve) => { finish = resolve; }));
    status.mockResolvedValue({ ...fixtureStatus, pcashChainId: fixtureStatus.pcashChainId + 1 });
    await expect(connection.refresh()).rejects.toBeInstanceOf(ExplorerIdentityMismatch);
    await expect(connection.read(async () => "unexpected")).rejects.toThrow("identity has not been confirmed");
    status.mockRejectedValue(new Error("RPC timeout"));
    await expect(connection.refresh()).rejects.toThrow("RPC timeout");
    await expect(connection.read(async () => "unexpected")).rejects.toThrow("identity has not been confirmed");
    status.mockResolvedValue(fixtureStatus);
    await connection.refresh();
    finish("old result");
    await expect(pending).rejects.toThrow("no longer confirmed");
    expect(await connection.read(async () => "recovered")).toBe("recovered");
  });
});
