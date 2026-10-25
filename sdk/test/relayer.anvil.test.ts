// PrivateKeyRelaySubmitter against a local Anvil. This is the real-node gate
// for the SDK's raw EIP-1559 transaction path and is skipped when Anvil is not
// available on PATH.

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPublicClient, http } from "viem";
import { Transaction } from "ethers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MempoolItemResult, PcashNodeClient, StatusResult } from "../src/clients/index.ts";
import { assembleBatch } from "../src/l1/relayer.ts";
import { FileRelayJournal } from "../src/node/relayJournal.ts";
import { PrivateKeyRelaySubmitter } from "../src/node/privateKeyRelaySubmitter.ts";
import { decodeBatch, encodeUserAccountCreation } from "../src/protocol/codec.ts";
import { transactionId } from "../src/protocol/block.ts";
import { bytesEqual, concatBytes, beBytes } from "../src/utils/bytes.ts";
import { keccak256 } from "../src/utils/keccak.ts";
import { fromHex, toHex } from "../src/utils/hex.ts";

function anvilAvailable(): boolean {
  try {
    execFileSync("anvil", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// Anvil dev account 0 (well-known and funded on the ephemeral local chain).
const ANVIL_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const INBOX = `0x${"22".repeat(20)}`;
const PORT = 8_600 + (process.pid % 200);
const RPC = `http://127.0.0.1:${PORT}`;

async function anvilRpc(method: string, params: unknown[] = []): Promise<unknown> {
  const response = await fetch(RPC, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = await response.json() as { result?: unknown; error?: { message: string } };
  if (body.error !== undefined) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

async function rpcReady(url: string, tries: number): Promise<boolean> {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
      });
      if (response.ok) return true;
    } catch {
      // Anvil may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

const suite = anvilAvailable() ? describe : describe.skip;

suite("PrivateKeyRelaySubmitter against Anvil", () => {
  let anvil: ChildProcess;
  let ready = false;
  let status: StatusResult;
  const directory = mkdtempSync(join(tmpdir(), "pcash-relayer-anvil-"));
  const client = createPublicClient({ transport: http(RPC) });
  // One real selected entry shared by both cases so submit-time batch
  // verification re-reads honest mempool bytes from the node stub.
  const entry = encodeUserAccountCreation(
    0x50435348n,
    concatBytes(Uint8Array.of(1), new Uint8Array(20).fill(3), beBytes(1n, 32), beBytes(2n, 32),
      Uint8Array.of(0), beBytes(0, 2), beBytes(3n, 32), beBytes(100n, 8),
      beBytes(1n, 32), beBytes(2n, 32), Uint8Array.of(0)),
  );
  const TX_ID = toHex(keccak256(entry));
  const selectedEntry = (): MempoolItemResult => ({
    contentHash: TX_ID,
    statementId: `0x${"aa".repeat(32)}`,
    stableId: "1",
    conflictKeys: [],
    kind: "userAccountCreation",
    fundingMode: null,
    byteSize: BigInt(entry.length),
    openFeeAmount: 0n,
    issuanceOwnerCommitment: `0x${"00".repeat(20)}`,
    issuanceRoute: "open",
    validUntil: null,
    status: "ready",
    conflictCount: 0n,
    receivedAtUnixMs: 0n,
    headCheckedBlock: 0n,
    headCheckedBlockHash: `0x${"44".repeat(32)}`,
    recentPcashBlockHash: null,
    publicRecords: [],
    rawTransaction: toHex(entry),
  });
  const node: Pick<PcashNodeClient, "getMempoolTransaction" | "getReceipt" | "status" | "getInboxDeliveryBatch"> = {
    getMempoolTransaction: async () => selectedEntry(),
    getInboxDeliveryBatch: async () => null,
    status: async () => status,
    getReceipt: async (query) => {
      if (typeof query === "string" || !("inclusionId" in query)) throw new Error("expected inclusion query");
      return [{
        contentHash: TX_ID,
        transactionId: toHex(transactionId({
          l1BlockHash: fromHex(query.inclusionId.l1BlockHash, "block hash"),
          l1TransactionIndex: BigInt(query.inclusionId.l1TransactionIndex),
          batchItemIndex: BigInt(query.inclusionId.batchItemIndex),
        })),
        outcome: "succeeded",
        failureDetail: null,
        l1Sender: "0x0000000000000000000000000000000000000000",
        issuanceOwnerCommitment: null,
        settledOpenFeeAmount: 0n,
        settledIssuanceAmount: 0n,
        kind: "userAccountCreation",
        fundingMode: null,
        inclusion: {
          l1BlockNumber: 1n,
          l1BlockHash: query.inclusionId.l1BlockHash,
          l1TransactionIndex: BigInt(query.inclusionId.l1TransactionIndex),
          l1TransactionHash: "0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd",
          batchItemIndex: BigInt(query.inclusionId.batchItemIndex),
        },
        outputLeafStart: 0n,
        outputsAdded: 0n,
        nullifiers: [],
        account: null,
      }];
    },
  };

  beforeAll(async () => {
    anvil = spawn("anvil", ["--port", String(PORT), "--silent"], { stdio: "ignore" });
    ready = await rpcReady(RPC, 50);
    if (!ready) return;
    const genesis = await client.getBlock({ blockNumber: 0n });
    status = {
      pcashChainId: 8191,
      l1ChainId: 31_337n,
      inboxAddress: INBOX,
      genesisL1Block: 0n,
      genesisL1BlockHash: genesis.hash,
      finalizedL1BlockNumber: 1n,
      finalizedL1BlockHash: genesis.hash,
      acceptedBatchVersions: [1],
    } as StatusResult;
  }, 30_000);

  afterAll(() => {
    anvil?.kill("SIGKILL");
    rmSync(directory, { recursive: true, force: true });
  });

  it("mines the exact calldata transaction and observes PCASH acceptance", async () => {
    expect(ready).toBe(true);
    const calldata = assembleBatch([entry], 1n, 0n);
    const submitter = new PrivateKeyRelaySubmitter({
      rpcUrl: RPC,
      privateKey: ANVIL_KEY,
      node,
      journal: new FileRelayJournal(join(directory, "relay-journal")),
      receiptTimeoutMs: 10_000,
      receiptPollMs: 50,
      observationTimeoutMs: 1_000,
      observationPollMs: 10,
    });
    const quotes = await submitter.quote(status, toHex(calldata), "calldata");
    const broadcast = await submitter.send(status, toHex(calldata), quotes.selected, {
      selected: [TX_ID],
      collectibleOpenFee: 0n,
      headCheckedBlock: 0n,
      headCheckedBlockHash: status.genesisL1BlockHash,
    });
    const result = await broadcast.settle();

    expect(result.receipt.status).toBe(1);
    const mined = await client.getTransaction({ hash: result.txHash as `0x${string}` });
    const minedInput = Uint8Array.from(Buffer.from(mined.input.slice(2), "hex"));
    expect(bytesEqual(minedInput, calldata)).toBe(true);
    const decoded = decodeBatch(minedInput);
    expect(decoded.items).toHaveLength(1);
    expect(bytesEqual(decoded.items[0]!, entry)).toBe(true);
  }, 60_000);

  it("journals and mines a plain value transfer at the account's next nonce", async () => {
    expect(ready).toBe(true);
    const journal = new FileRelayJournal(join(directory, "call-journal"));
    const submitter = new PrivateKeyRelaySubmitter({
      rpcUrl: RPC,
      privateKey: ANVIL_KEY,
      node,
      journal,
      receiptTimeoutMs: 10_000,
      receiptPollMs: 50,
    });
    const recipient = `0x${"5a".repeat(20)}` as const;
    const before = await client.getBalance({ address: recipient });

    const call = await submitter.sendCall({ to: recipient, value: 12_345n });
    await expect(journal.read()).resolves.toMatchObject([{ kind: "call", to: recipient, value: "12345" }]);
    const receipt = await call.settle();

    expect(receipt.txHash).toBe(call.txHash);
    expect(await client.getBalance({ address: recipient })).toBe(before + 12_345n);
    await expect(journal.read()).resolves.toEqual([]);
  }, 60_000);

  it.each([
    ["calldata", false], ["blobs", false], ["calldata", true],
  ] as const)("replaces a fee-blocked %s batch and settles it (original wins: %s)", async (carrier, originalWins) => {
    expect(ready).toBe(true);
    const snapshot = await anvilRpc("evm_snapshot");
    const journal = new FileRelayJournal(join(directory, `replace-${carrier}-${originalWins}`));
    let settlement: Promise<unknown> | undefined;
    try {
      await anvilRpc("anvil_setAutomine", [false]);
      const batch = toHex(assembleBatch([entry], 1n, 0n));
      const submitter = new PrivateKeyRelaySubmitter({
        rpcUrl: RPC, privateKey: ANVIL_KEY, node, journal,
        receiptTimeoutMs: 15_000, receiptPollMs: 20,
        observationTimeoutMs: 1_000, observationPollMs: 10,
      });
      const quote = (await submitter.quote(status, batch, carrier)).selected;
      const sent = await submitter.send(status, batch, quote, {
        selected: [TX_ID], collectibleOpenFee: 0n,
        headCheckedBlock: 0n, headCheckedBlockHash: status.genesisL1BlockHash,
      });
      const original = (await journal.read())[0]!;
      await anvilRpc("anvil_setNextBlockBaseFeePerGas", [`0x${(quote.maxFeePerGas * 2n).toString(16)}`]);
      await anvilRpc("evm_mine");
      await expect(client.getTransactionReceipt({ hash: sent.txHash as `0x${string}` })).rejects.toThrow();
      settlement = sent.settle().catch((error: unknown) => error);
      const deadline = Date.now() + 10_000;
      let replacement = original;
      while (Date.now() < deadline) {
        replacement = (await journal.read())[0]!;
        if (replacement.transactionHash !== original.transactionHash && replacement.phase === "broadcast_accepted") break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(replacement.transactionHash).not.toBe(original.transactionHash);
      expect(replacement.phase).toBe("broadcast_accepted");
      expect(replacement).toMatchObject({ nonce: original.nonce, batch, carrier, gasLimit: original.gasLimit,
        resolutionId: original.resolutionId, previousTransactionHashes: [sent.txHash] });
      const before = Transaction.from(original.signedTransaction!);
      const after = Transaction.from(replacement.signedTransaction!);
      expect(after.blobs).toEqual(before.blobs);
      expect(after.data).toBe(before.data);
      if (carrier === "blobs") {
        expect(after.maxFeePerGas! >= before.maxFeePerGas! * 2n).toBe(true);
        expect(after.maxPriorityFeePerGas! >= before.maxPriorityFeePerGas! * 2n).toBe(true);
        expect(after.maxFeePerBlobGas! >= before.maxFeePerBlobGas! * 2n).toBe(true);
      }
      if (originalWins) {
        await anvilRpc("anvil_dropTransaction", [replacement.transactionHash]);
        await anvilRpc("anvil_setNextBlockBaseFeePerGas", ["0x1"]);
        await anvilRpc("evm_mine");
        await anvilRpc("eth_sendRawTransaction", [original.signedTransaction]);
      }
      await anvilRpc("anvil_setNextBlockBaseFeePerGas", ["0x1"]);
      await anvilRpc("evm_mine");
      expect(await settlement).toMatchObject({
        txHash: originalWins ? original.transactionHash : replacement.transactionHash,
        observed: true, receipt: { status: 1 },
      });
      await expect(journal.read()).resolves.toEqual([]);
    } finally {
      await settlement;
      await anvilRpc("evm_revert", [snapshot]);
      await anvilRpc("anvil_setAutomine", [true]);
    }
  }, 60_000);

  it("rejects an unfunded submitter before broadcast", async () => {
    expect(ready).toBe(true);
    const calldata = toHex(assembleBatch([entry], 1n, 0n));
    const submitter = new PrivateKeyRelaySubmitter({
      rpcUrl: RPC,
      privateKey: `0x${"77".repeat(32)}`,
      node,
      journal: new FileRelayJournal(join(directory, "unfunded-relay-journal")),
    });
    const quotes = await submitter.quote(status, calldata, "calldata");

    await expect(submitter.send(status, calldata, quotes.selected, {
      selected: [TX_ID],
      collectibleOpenFee: 0n,
      headCheckedBlock: 0n,
      headCheckedBlockHash: status.genesisL1BlockHash,
    })).rejects.toThrow(/underfunded/);
  }, 60_000);
});
