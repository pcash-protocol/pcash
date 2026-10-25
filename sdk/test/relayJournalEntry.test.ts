// Durable relay journal validation: the journal entry parser and the browser
// journal's guards around it.

import { IDBFactory } from "fake-indexeddb";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IndexedDbRelayJournal } from "../src/relay/browserJournal.ts";
import { RelayJournalConflictError } from "../src/relay/errors.ts";
import {
  parseRelayJournalEntry,
  type RelayBatchJournalEntry,
  type RelayCallJournalEntry,
} from "../src/relay/journal.ts";

const HASH = `0x${"11".repeat(32)}`;

function entry(): RelayBatchJournalEntry {
  return {
    kind: "batch",
    createdAt: "2026-08-24T00:00:00.000Z",
    resolutionId: HASH,
    phase: "broadcast_attempted",
    submissionKind: "signed_raw",
    transactionHash: HASH,
    signedTransaction: "0x02aa",
    previousTransactionHashes: [],
    lastBroadcastBlock: "9",
    carrier: "calldata",
    batch: "0x010000",
    selected: [`0x${"22".repeat(32)}`],
    batchItemIndexes: ["0"],
    observationMode: "selected",
    collectibleOpenFee: "10",
    relayerAddress: `0x${"33".repeat(20)}`,
    chainId: "1",
    inboxAddress: `0x${"44".repeat(20)}`,
    nonce: "2",
    gasLimit: "21000",
    maxFeePerGas: "10",
    maxPriorityFeePerGas: "1",
    maxFeePerBlobGas: null,
    genesisL1Block: "0",
    genesisL1BlockHash: `0x${"66".repeat(32)}`,
    headCheckedBlock: "3",
    headCheckedBlockHash: `0x${"55".repeat(32)}`,
  };
}

function intentEntry(): RelayBatchJournalEntry {
  return {
    ...entry(),
    resolutionId: "attempt-1",
    submissionKind: "eip1193_intent",
    transactionHash: null,
    signedTransaction: null,
  };
}

function callEntry(): RelayCallJournalEntry {
  return {
    kind: "call",
    createdAt: "2026-08-24T00:00:00.000Z",
    resolutionId: HASH,
    phase: "broadcast_accepted",
    submissionKind: "signed_raw",
    transactionHash: HASH,
    signedTransaction: "0x02aa",
    previousTransactionHashes: [],
    lastBroadcastBlock: "9",
    relayerAddress: `0x${"33".repeat(20)}`,
    chainId: "1",
    nonce: "2",
    gasLimit: "21000",
    maxFeePerGas: "10",
    maxPriorityFeePerGas: "1",
    genesisL1Block: "0",
    genesisL1BlockHash: `0x${"66".repeat(32)}`,
    to: `0x${"77".repeat(20)}`,
    value: "1000",
    data: "0x",
  };
}

describe("parseRelayJournalEntry", () => {
  it("accepts well-formed signed-raw, injected-wallet, and call entries", () => {
    expect(parseRelayJournalEntry(entry())).toEqual(entry());
    expect(parseRelayJournalEntry(intentEntry())).toEqual(intentEntry());
    expect(parseRelayJournalEntry(callEntry())).toEqual(callEntry());
    expect(parseRelayJournalEntry({ ...callEntry(), data: "0xa9059cbb" })).toMatchObject({ data: "0xa9059cbb" });
    expect(parseRelayJournalEntry({ ...entry(), carrier: "blobs", maxFeePerBlobGas: "7" }))
      .toMatchObject({ maxFeePerBlobGas: "7" });
  });

  it.each<[string, unknown, RegExp]>([
    ["null", null, /not an object/],
    ["an array", [], /not an object/],
    ["a string", "entry", /not an object/],
    ["a missing kind", { ...entry(), kind: undefined }, /kind is invalid/],
    ["an unknown kind", { ...entry(), kind: "deploy" }, /kind is invalid/],
    ["a missing string field", { ...entry(), nonce: undefined }, /field nonce is invalid/],
    ["a numeric string field", { ...entry(), chainId: 1 }, /field chainId is invalid/],
    ["an empty resolutionId", { ...intentEntry(), resolutionId: "" }, /resolutionId is invalid/],
    ["an oversized resolutionId", { ...intentEntry(), resolutionId: "x".repeat(257) }, /resolutionId is invalid/],
    ["an unknown phase", { ...entry(), phase: "mined" }, /phase is invalid/],
    ["an unknown submission kind", { ...entry(), submissionKind: "other" }, /submissionKind is invalid/],
    ["an unknown carrier", { ...entry(), carrier: "ssz" }, /carrier is invalid/],
    ["a short transaction hash", { ...entry(), transactionHash: "0x11" }, /transactionHash is invalid/],
    ["odd-length signed bytes", { ...entry(), signedTransaction: "0x02a" }, /signedTransaction is invalid/],
    ["a non-hex batch", { ...entry(), batch: "batch" }, /transaction request is invalid/],
    ["a short relayer address", { ...entry(), relayerAddress: "0x33" }, /account identity is invalid/],
    ["a short inbox address", { ...entry(), inboxAddress: "0x44" }, /transaction request is invalid/],
    ["a short genesis hash", { ...entry(), genesisL1BlockHash: "0x66" }, /account identity is invalid/],
    ["a short head hash", { ...entry(), headCheckedBlockHash: "0x55" }, /block identity is invalid/],
    ["no selected hashes", { ...entry(), selected: [], batchItemIndexes: [] }, /selected content hashes/],
    ["selected not an array", { ...entry(), selected: HASH }, /selected content hashes/],
    ["a short selected hash", { ...entry(), selected: ["0x22"] }, /selected content hashes/],
    ["indexes of another length", { ...entry(), batchItemIndexes: ["0", "1"] }, /batch item indexes/],
    ["a padded index", { ...entry(), batchItemIndexes: ["01"] }, /batch item indexes/],
    ["a numeric index", { ...entry(), batchItemIndexes: [0] }, /batch item indexes/],
    [
      "duplicate indexes",
      { ...entry(), selected: [HASH, HASH], batchItemIndexes: ["1", "1"] },
      /batch item indexes/,
    ],
    ["an unknown observation mode", { ...entry(), observationMode: "all" }, /observation mode/],
    ["a numeric blob fee", { ...entry(), maxFeePerBlobGas: 7 }, /maxFeePerBlobGas is not an unsigned integer/],
    ["a negative nonce", { ...entry(), nonce: "-1" }, /nonce is not an unsigned integer/],
    ["a hex gas limit", { ...entry(), gasLimit: "0x5208" }, /gasLimit is not an unsigned integer/],
    ["a padded fee", { ...entry(), collectibleOpenFee: "010" }, /collectibleOpenFee is not an unsigned integer/],
    ["a decimal blob fee", { ...entry(), maxFeePerBlobGas: "1.5" }, /maxFeePerBlobGas is not an unsigned integer/],
    ["signed raw without bytes", { ...entry(), signedTransaction: null }, /missing exact transaction bytes/],
    ["signed raw without a hash", { ...entry(), transactionHash: null }, /missing exact transaction bytes/],
    ["an intent carrying signed bytes", { ...intentEntry(), signedTransaction: "0x02" }, /cannot contain signed/],
    [
      "an accepted intent without a hash",
      { ...intentEntry(), phase: "broadcast_accepted" },
      /accepted relay journal is missing its transaction hash/,
    ],
    ["a call without a recipient", { ...callEntry(), to: undefined }, /field to is invalid/],
    ["a call to a short address", { ...callEntry(), to: "0x77" }, /call request is invalid/],
    ["a call with non-hex data", { ...callEntry(), data: "data" }, /call request is invalid/],
    ["a call with a hex value", { ...callEntry(), value: "0x10" }, /value is not an unsigned integer/],
  ])("rejects %s", (_label, value, message) => {
    let thrown: unknown;
    try {
      parseRelayJournalEntry(value);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(RelayJournalConflictError);
    expect((thrown as Error).message).toMatch(message);
  });

  it("matches a signed-raw resolutionId to its hash case-insensitively", () => {
    expect(() => parseRelayJournalEntry({ ...entry(), resolutionId: HASH.toUpperCase().replace("0X", "0x") }))
      .not.toThrow();
  });
});

describe("IndexedDbRelayJournal guards", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fails closed when IndexedDB is unavailable", async () => {
    vi.stubGlobal("indexedDB", undefined);
    const journal = new IndexedDbRelayJournal({ databaseName: "relay-unavailable", accountKey: "k" });
    await expect(journal.read()).rejects.toThrow(/IndexedDB is unavailable/);
    await expect(journal.create(entry())).rejects.toBeInstanceOf(RelayJournalConflictError);
  });

  it("reports a blocked upgrade and opens on the next call", async () => {
    const real = new IDBFactory();
    let blockNext = true;
    const open = vi.fn((name: string, version?: number) => {
      if (!blockNext) return real.open(name, version);
      blockNext = false;
      const request: { onblocked?: () => void } = {};
      queueMicrotask(() => request.onblocked?.());
      return request;
    });
    vi.stubGlobal("indexedDB", { open });
    const journal = new IndexedDbRelayJournal({ databaseName: "relay-blocked", accountKey: "k" });
    await expect(journal.read()).rejects.toThrow(/upgrade is blocked by another tab/);
    await expect(journal.read()).resolves.toEqual([]);
    expect(open).toHaveBeenCalledTimes(2);
    await journal.close();
  });

  it("refuses to use a journal holding a malformed stored entry", async () => {
    vi.stubGlobal("indexedDB", new IDBFactory());
    const journal = new IndexedDbRelayJournal({ databaseName: "relay-malformed", accountKey: "k" });
    await journal.create(entry());
    await journal.close();

    // Corrupt the stored entry through a second connection.
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = globalThis.indexedDB.open("relay-malformed", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction("latches", "readwrite");
      transaction.objectStore("latches").put({ ...entry(), phase: "mined" }, "k|nonce-2");
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();

    const reopened = new IndexedDbRelayJournal({ databaseName: "relay-malformed", accountKey: "k" });
    await expect(reopened.read()).rejects.toThrow(/malformed and must be resolved by an operator/);
    await expect(reopened.create({ ...entry(), nonce: "3" })).rejects.toBeInstanceOf(RelayJournalConflictError);
    await expect(reopened.clear(HASH)).rejects.toBeInstanceOf(RelayJournalConflictError);
    await reopened.close();
  });
});
