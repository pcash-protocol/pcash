import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { SigningKey, Transaction } from "ethers";
import { afterEach, describe, expect, it } from "vitest";
import { FileRelayJournal } from "../src/node/relayJournal.ts";
import type { RelayJournalEntry } from "../src/relay/journal.ts";

const ANCHOR = `0x${"33".repeat(32)}`;
const workers: ChildProcess[] = [];
const directories: string[] = [];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

type Message = { event: string; id: number; method: string; params: unknown[]; error?: string; message?: string };

function worker(directory: string, rpc: (message: Message) => Promise<unknown> = async () => null) {
  const child = spawn(process.execPath, [fileURLToPath(new URL("./relayJournalWorker.ts", import.meta.url)), directory], {
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  workers.push(child);
  const events = new Map<string, ReturnType<typeof deferred<Message>>>();
  const event = (name: string) => {
    if (!events.has(name)) events.set(name, deferred<Message>());
    return events.get(name)!.promise;
  };
  let stderr = "";
  child.stderr!.on("data", (chunk) => { stderr += String(chunk); });
  child.on("message", (message: Message) => {
    if (message.event === "rpc") {
      void rpc(message).then(
        (result) => child.connected && child.send({ id: message.id, result }),
        (error: Error) => child.connected && child.send({ id: message.id, error: error.message }),
      );
    } else {
      void event(message.event);
      events.get(message.event)!.resolve(message);
    }
  });
  child.on("exit", () => {
    for (const pending of events.values()) pending.resolve({ event: "exit", error: stderr } as Message);
  });
  return {
    child, event,
    async run(command = "recover") {
      events.delete("starting");
      events.delete("done");
      await event("ready");
      child.send({ command });
      return event("done");
    },
  };
}

async function seed() {
  const directory = mkdtempSync(join(tmpdir(), "pcash-relay-process-"));
  directories.push(directory);
  const transaction = Transaction.from({
    type: 2, chainId: 1n, nonce: 2, gasLimit: 30_000n, to: `0x${"22".repeat(20)}`,
    value: 0n, data: "0x010000", maxFeePerGas: 10n, maxPriorityFeePerGas: 1n,
  });
  transaction.signature = new SigningKey(`0x${"11".repeat(32)}`).sign(transaction.unsignedHash);
  const entry: RelayJournalEntry = {
    kind: "batch", createdAt: "2026-10-09T00:00:00Z", resolutionId: transaction.hash!,
    phase: "broadcast_accepted", submissionKind: "signed_raw", transactionHash: transaction.hash!,
    signedTransaction: transaction.serialized, previousTransactionHashes: [], lastBroadcastBlock: "9",
    relayerAddress: transaction.from!, chainId: "1", nonce: "2", gasLimit: "30000",
    maxFeePerGas: "10", maxPriorityFeePerGas: "1", genesisL1Block: "5", genesisL1BlockHash: ANCHOR,
    carrier: "calldata", batch: transaction.data, selected: [`0x${"44".repeat(32)}`],
    batchItemIndexes: ["0"], observationMode: "selected", collectibleOpenFee: "0",
    inboxAddress: transaction.to!, maxFeePerBlobGas: null, headCheckedBlock: "0", headCheckedBlockHash: ANCHOR,
  };
  const journal = new FileRelayJournal(directory);
  await journal.create(entry);
  return { directory, journal, entry };
}

afterEach(async () => {
  await Promise.all(workers.splice(0).map((child) => new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once("exit", () => resolve());
    child.kill("SIGKILL");
  })));
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("relay journal across processes", () => {
  it("serializes independent repricers through the accepted-phase write and recovers the first writer's hash", async () => {
    const { directory, journal, entry } = await seed();
    const estimated = deferred<void>();
    const allowEstimate = deferred<void>();
    const broadcasting = deferred<void>();
    const allowBroadcast = deferred<void>();
    const sends: Array<{ writer: string; hash: string }> = [];
    const calls: Array<{ writer: string; method: string }> = [];
    let head = 12n;
    let minedHash: string | undefined;
    const rpc = (writer: string) => async ({ method, params }: Message) => {
      calls.push({ writer, method });
      switch (method) {
        case "eth_chainId": return "0x1";
        case "eth_getBlockByNumber": return {
          number: params[0] === "0x5" ? "0x5" : `0x${head.toString(16)}`, hash: ANCHOR, baseFeePerGas: "0x1",
        };
        case "eth_feeHistory": return { baseFeePerGas: ["0x1", "0x1"] };
        case "eth_maxPriorityFeePerGas":
          if (writer === "A") { estimated.resolve(); await allowEstimate.promise; }
          return writer === "A" ? "0x1" : "0x9";
        case "eth_getBalance": return "0xf4240";
        case "eth_sendRawTransaction": {
          const transaction = Transaction.from(params[0] as string);
          sends.push({ writer, hash: transaction.hash! });
          broadcasting.resolve();
          await allowBroadcast.promise;
          return transaction.hash;
        }
        case "eth_getTransactionReceipt":
          return params[0] === minedHash ? {
            transactionHash: minedHash, status: "0x1", blockNumber: "0xd", blockHash: ANCHOR,
            transactionIndex: "0x0", gasUsed: "0x5208", cumulativeGasUsed: "0x5208", effectiveGasPrice: "0x2",
            logs: [], logsBloom: `0x${"00".repeat(256)}`, type: "0x2",
          } : null;
        default: throw new Error(`unexpected ${method}`);
      }
    };
    const first = worker(directory, rpc("A"));
    const second = worker(directory, rpc("B"));
    const firstDone = first.run();
    await estimated.promise;
    const secondDone = second.run();
    await second.event("starting");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls.filter((call) => call.writer === "B")).toEqual([]);
    allowEstimate.resolve();
    await broadcasting.promise;
    const pending = JSON.parse(readFileSync(join(directory, "nonce-2.json"), "utf8"));
    expect(pending).toMatchObject({ phase: "broadcast_attempted", previousTransactionHashes: [entry.transactionHash] });
    expect(calls.filter((call) => call.writer === "B")).toEqual([]);
    allowBroadcast.resolve();
    expect(await firstDone).toMatchObject({ error: "RelayJournalConflictError" });
    expect(await secondDone).toMatchObject({ error: "RelayJournalConflictError" });
    expect(sends).toEqual([{ writer: "A", hash: pending.transactionHash }]);
    await expect(journal.read()).resolves.toMatchObject([{ phase: "broadcast_accepted", transactionHash: pending.transactionHash,
      previousTransactionHashes: [entry.transactionHash], lastBroadcastBlock: "12" }]);
    head = 15n;
    expect(await second.run()).toMatchObject({ error: "RelayJournalConflictError" });
    expect(sends).toHaveLength(2);
    expect(sends[1]!.writer).toBe("B");
    expect(sends[1]!.hash).not.toBe(pending.transactionHash);
    await expect(journal.read()).resolves.toMatchObject([{ transactionHash: sends[1]!.hash,
      previousTransactionHashes: [entry.transactionHash, pending.transactionHash] }]);
    minedHash = pending.transactionHash;
    expect(await second.run()).toEqual({ event: "done" });
    await expect(journal.read()).resolves.toEqual([]);
  }, 15_000);

  it("releases the lock on an exception and recovers an expired lock after a killed writer", async () => {
    const { directory, journal } = await seed();
    await expect(journal.runExclusive(async () => { throw new Error("failed operation"); })).rejects.toThrow("failed operation");
    await expect(journal.read()).resolves.toHaveLength(1);
    const holder = worker(directory);
    void holder.run("hold");
    await holder.event("locked");
    const exited = new Promise((resolve) => holder.child.once("exit", resolve));
    holder.child.kill("SIGKILL");
    await exited;
    const expired = new Date(Date.now() - 61_000);
    utimesSync(join(directory, ".lock"), expired, expired);
    await expect(new FileRelayJournal(directory).read()).resolves.toHaveLength(1);
  }, 10_000);
});
