import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { PcashNodeClient } from "@pcash/sdk/clients";
import type { RelayCallJournalEntry } from "@pcash/sdk/relay";
import { createServiceRelayJournals } from "../../src/service/serve.ts";

const A = `0x${"aa".repeat(20)}`;
const B = `0x${"bb".repeat(20)}`;
const node = {} as PcashNodeClient;

function entry(address: string, resolutionId: string): RelayCallJournalEntry {
  return {
    kind: "call", createdAt: "2026-10-09T00:00:00Z", resolutionId,
    phase: "broadcast_attempted", submissionKind: "eip1193_intent", transactionHash: null,
    signedTransaction: null, previousTransactionHashes: [], lastBroadcastBlock: null, relayerAddress: address, chainId: "1", nonce: "0", gasLimit: "21000",
    maxFeePerGas: "2", maxPriorityFeePerGas: "1", genesisL1Block: "1", genesisL1BlockHash: `0x${"11".repeat(32)}`,
    to: A, value: "0", data: "0x",
  };
}

it("keeps each sender's same-numbered nonce separate and discovers both journals after restart", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "wallet-signer-journals-"));
  const first = createServiceRelayJournals({ dataDir, dev: false, node });
  await first.forAddress(A).journal.create(entry(A, "setup-a"));
  await first.forAddress(B).journal.create(entry(B, "gas-key-b"));
  expect((await first.forAddress(A).journal.read()).map(value => value.resolutionId)).toEqual(["setup-a"]);
  expect((await first.forAddress(B).journal.read()).map(value => value.resolutionId)).toEqual(["gas-key-b"]);

  const reopened = createServiceRelayJournals({ dataDir, dev: false, node });
  expect((await reopened.recovery.show()).entries.map(value => value.resolutionId).sort()).toEqual(["gas-key-b", "setup-a"]);
  const resolved = await reopened.recovery.resolve("setup-a");
  expect(resolved.archivePath).toContain(A);
  expect(resolved.latched).toBe(true);
  expect((await reopened.recovery.show()).entries.map(value => value.resolutionId)).toEqual(["gas-key-b"]);
  expect((await reopened.recovery.resolve("gas-key-b")).latched).toBe(false);
});

it("shares a queue for the same actual signer and lets another signer progress", async () => {
  const journals = createServiceRelayJournals({ dataDir: "/unused", dev: true, node });
  const own = journals.forAddress(A);
  const configuredGasKey = journals.forAddress(A.toUpperCase());
  expect(configuredGasKey).toBe(own);
  let release!: () => void;
  let started!: () => void;
  const start = new Promise<void>(resolve => { started = resolve; });
  const block = new Promise<void>(resolve => { release = resolve; });
  const order: string[] = [];
  const first = own.runExclusive(async () => { started(); await block; order.push("own"); });
  await start;
  const second = configuredGasKey.runExclusive(async () => { order.push("same-signer"); });
  await journals.forAddress(B).runExclusive(async () => { order.push("other-signer"); });
  expect(order).toEqual(["other-signer"]);
  release();
  await Promise.all([first, second]);
  expect(order).toEqual(["other-signer", "own", "same-signer"]);
});
