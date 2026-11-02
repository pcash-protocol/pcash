import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FileRelayJournal,
  MemoryRelayJournal,
} from "../src/node/relayJournal.ts";
import { IndexedDbRelayJournal } from "../src/relay/browserJournal.ts";
import type {
  RelayBatchJournalEntry,
  RelayCallJournalEntry,
  RelayJournal,
} from "../src/relay/journal.ts";
import { RelayJournalConflictError, RelayValidationError } from "../src/relay/errors.ts";

function hash(byte: number): string {
  return `0x${byte.toString(16).padStart(2, "0").repeat(32)}`;
}

function entry(nonce = 2, overrides: Partial<RelayBatchJournalEntry> = {}): RelayBatchJournalEntry {
  return {
    kind: "batch",
    createdAt: "2026-08-24T00:00:00.000Z",
    resolutionId: hash(0x10 + nonce),
    phase: "broadcast_attempted",
    submissionKind: "signed_raw",
    transactionHash: hash(0x10 + nonce),
    signedTransaction: "0x02aa",
    previousTransactionHashes: [],
    lastBroadcastBlock: "9",
    carrier: "calldata",
    batch: "0x010000",
    selected: [hash(0x80 + nonce)],
    batchItemIndexes: ["0"],
    observationMode: "selected",
    collectibleOpenFee: "10",
    relayerAddress: `0x${"33".repeat(20)}`,
    chainId: "1",
    inboxAddress: `0x${"44".repeat(20)}`,
    nonce: String(nonce),
    gasLimit: "21000",
    maxFeePerGas: "10",
    maxPriorityFeePerGas: "1",
    maxFeePerBlobGas: null,
    genesisL1Block: "0",
    genesisL1BlockHash: `0x${"66".repeat(32)}`,
    headCheckedBlock: "3",
    headCheckedBlockHash: `0x${"55".repeat(32)}`,
    ...overrides,
  };
}

function callEntry(nonce: number): RelayCallJournalEntry {
  const batch = entry(nonce);
  return {
    kind: "call",
    createdAt: batch.createdAt,
    resolutionId: batch.resolutionId,
    phase: batch.phase,
    submissionKind: batch.submissionKind,
    transactionHash: batch.transactionHash,
    signedTransaction: batch.signedTransaction,
    previousTransactionHashes: [],
    lastBroadcastBlock: "9",
    relayerAddress: batch.relayerAddress,
    chainId: batch.chainId,
    nonce: batch.nonce,
    gasLimit: batch.gasLimit,
    maxFeePerGas: batch.maxFeePerGas,
    maxPriorityFeePerGas: batch.maxPriorityFeePerGas,
    genesisL1Block: batch.genesisL1Block,
    genesisL1BlockHash: batch.genesisL1BlockHash,
    to: `0x${"77".repeat(20)}`,
    value: "1000",
    data: "0x",
  };
}

let databases = 0;
const backends: Array<[string, () => RelayJournal]> = [
  ["MemoryRelayJournal", () => new MemoryRelayJournal()],
  ["FileRelayJournal", () => new FileRelayJournal(join(mkdtempSync(join(tmpdir(), "pcash-relay-journal-")), "journal"))],
  ["IndexedDbRelayJournal", () => new IndexedDbRelayJournal({ databaseName: `relay-${databases += 1}`, accountKey: "account" })],
];

describe.each(backends)("%s", (_name, open) => {
  beforeEach(() => {
    vi.stubGlobal("indexedDB", new IDBFactory());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("holds several in-flight entries and reads them in nonce order", async () => {
    const journal = open();
    await expect(journal.read()).resolves.toEqual([]);
    await journal.create(entry(11));
    await journal.create(callEntry(3));
    await journal.create(entry(9));
    await expect(journal.read()).resolves.toEqual([callEntry(3), entry(9), entry(11)]);
  });

  it("holds each nonce and each resolution once, even under concurrent creates", async () => {
    const journal = open();
    const attempts = await Promise.allSettled([journal.create(entry(2)), journal.create(entry(2))]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
    const other = hash(0x99);
    await expect(journal.create(entry(2, { resolutionId: other, transactionHash: other })))
      .rejects.toBeInstanceOf(RelayJournalConflictError);
    await expect(journal.create(entry(4, { resolutionId: entry(2).resolutionId, transactionHash: entry(2).transactionHash })))
      .rejects.toThrow(/already holds resolution/);
    await expect(journal.read()).resolves.toEqual([entry(2)]);
  });

  it("replaces an entry in place, keeping its nonce, kind, and createdAt", async () => {
    const journal = open();
    await journal.create(entry(2));
    await journal.create(entry(3));
    await journal.replace({ ...entry(2), phase: "broadcast_accepted" });
    await expect(journal.read()).resolves.toEqual([{ ...entry(2), phase: "broadcast_accepted" }, entry(3)]);
    await expect(journal.replace({ ...entry(2), createdAt: "2026-08-25T00:00:00.000Z" }))
      .rejects.toThrow(/cannot change createdAt/);
    await expect(journal.replace({ ...entry(2), nonce: "3" })).rejects.toThrow(/cannot change its nonce or kind/);
    await expect(journal.replace({ ...callEntry(2), resolutionId: entry(2).resolutionId, transactionHash: entry(2).transactionHash }))
      .rejects.toThrow(/cannot change its nonce or kind/);
    await expect(journal.read()).resolves.toEqual([{ ...entry(2), phase: "broadcast_accepted" }, entry(3)]);
    await expect(journal.replace(entry(7))).rejects.toThrow(/holds no resolution/);
    await expect(journal.replace({ ...entry(2), phase: "bogus" as never })).rejects.toThrow(/phase/);
  });

  it("clears one entry by resolution, idempotently and case-insensitively", async () => {
    const journal = open();
    await journal.create(entry(2));
    await journal.create(entry(3));
    await journal.clear(entry(2).resolutionId.toUpperCase().replace("0X", "0x"));
    await journal.clear(entry(2).resolutionId);
    await journal.clear(hash(0x99));
    await expect(journal.read()).resolves.toEqual([entry(3)]);
    await expect(journal.clear("")).rejects.toThrow(/resolutionId is invalid/);
    await expect(journal.clear("x".repeat(257))).rejects.toThrow(/resolutionId is invalid/);
  });

  it("archives one operator-resolved entry and frees its nonce", async () => {
    const journal = open();
    await journal.create(entry(2));
    await journal.create(entry(3));
    const archived = await journal.archive(entry(2).resolutionId);
    expect(archived).not.toBe("");
    await expect(journal.read()).resolves.toEqual([entry(3)]);
    await expect(journal.archive(entry(2).resolutionId)).rejects.toThrow(/holds no resolution/);
    await expect(journal.archive("")).rejects.toThrow(/resolutionId is invalid/);
    await journal.create(entry(2));
    await expect(journal.read()).resolves.toEqual([entry(2), entry(3)]);
  });

  it("does not store a malformed entry", async () => {
    const journal = open();
    await expect(journal.create(entry(2, { selected: ["not-hex"] }))).rejects.toThrow(/selected/);
    await expect(journal.create({ ...entry(2), nonce: "-1" })).rejects.toThrow(/nonce/);
    await expect(journal.read()).resolves.toEqual([]);
  });

  it("preserves duplicate transaction ids in an exact raw batch", async () => {
    const journal = open();
    const duplicate = entry(2).selected[0]!;
    const exactBatchEntry = entry(2, { selected: [duplicate, duplicate], batchItemIndexes: ["0", "1"] });
    await journal.create(exactBatchEntry);
    await expect(journal.read()).resolves.toEqual([exactBatchEntry]);
  });
});

describe("FileRelayJournal storage", () => {
  function directory(): string {
    const root = mkdtempSync(join(tmpdir(), "pcash-relay-journal-"));
    chmodSync(root, 0o700);
    return join(root, "journal");
  }

  it("writes one mode-0600 file per nonce into a private directory", async () => {
    const path = directory();
    const journal = new FileRelayJournal(path);
    await journal.create(entry(2));
    await journal.create(entry(10));
    expect(statSync(path).mode & 0o777).toBe(0o700);
    expect(readdirSync(path).sort()).toEqual(["nonce-10.json", "nonce-2.json"]);
    expect(statSync(join(path, "nonce-2.json")).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(join(path, "nonce-2.json"), "utf8"))).toEqual(entry(2));
  });

  it("reports a nonce another process took after this one read the journal as a conflict", async () => {
    const path = directory();
    await new FileRelayJournal(path).create(entry(2));
    const other = hash(0x99);
    const failure = await new FileRelayJournal(path)
      .create(entry(2, { resolutionId: other, transactionHash: other }))
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RelayJournalConflictError);
    expect((failure as Error).message).toMatch(/already exists/);
  });

  it("archives into resolved/ and refuses to overwrite an archive of the same name", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-09-01T00:00:00.000Z"));
      const path = directory();
      const journal = new FileRelayJournal(path);
      await journal.create(entry(2));
      const first = await journal.archive(entry(2).resolutionId);
      expect(first).toBe(join(path, "resolved", `2026-09-01T00-00-00-000Z-nonce-2-${entry(2).resolutionId}.json`));
      expect(JSON.parse(readFileSync(first, "utf8"))).toEqual(entry(2));
      await journal.create(entry(2));
      await expect(journal.archive(entry(2).resolutionId)).rejects.toThrow(/archive .* already exists/);
      await expect(journal.read()).resolves.toEqual([entry(2)]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores replacement residue a crashed process left behind", async () => {
    const path = directory();
    const journal = new FileRelayJournal(path);
    await journal.create(entry(2));
    writeFileSync(join(path, ".nonce-2.replace-1-crash"), "stale crash residue", { mode: 0o600 });

    await journal.replace({ ...entry(2), phase: "broadcast_accepted" });

    await expect(journal.read()).resolves.toEqual([{ ...entry(2), phase: "broadcast_accepted" }]);
    expect(readFileSync(join(path, ".nonce-2.replace-1-crash"), "utf8")).toBe("stale crash residue");
  });

  it("reads an absent directory as empty", async () => {
    const path = directory();
    await expect(new FileRelayJournal(path).read()).resolves.toEqual([]);
    expect(existsSync(path)).toBe(false);
  });

  it("fails closed on an entry that is not a regular file or does not parse", async () => {
    const notFile = directory();
    mkdirSync(join(notFile, "nonce-2.json"), { recursive: true });
    await expect(new FileRelayJournal(notFile).read()).rejects.toThrow(/not a regular file/);

    const unparseable = directory();
    mkdirSync(unparseable);
    writeFileSync(join(unparseable, "nonce-2.json"), "{not json");
    await expect(new FileRelayJournal(unparseable).read()).rejects.toThrow(/malformed/);

    const invalid = directory();
    mkdirSync(invalid);
    writeFileSync(join(invalid, "nonce-2.json"), JSON.stringify({ ...entry(2), carrier: "ssz" }));
    await expect(new FileRelayJournal(invalid).read()).rejects.toBeInstanceOf(RelayJournalConflictError);
    await expect(new FileRelayJournal(invalid).create(entry(3))).rejects.toThrow(/malformed/);
  });

  it("reports a non-EEXIST open failure unchanged", async () => {
    const path = directory();
    mkdirSync(path);
    chmodSync(path, 0o500);
    try {
      const failure = await new FileRelayJournal(path).create(entry(2)).catch((error: unknown) => error);
      expect(failure).not.toBeInstanceOf(RelayJournalConflictError);
      expect((failure as NodeJS.ErrnoException).code).toBe("EACCES");
    } finally {
      chmodSync(path, 0o700);
    }
  });
});

describe("IndexedDbRelayJournal storage", () => {
  beforeEach(() => {
    vi.stubGlobal("indexedDB", new IDBFactory());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps each account's entries apart in one database", async () => {
    const first = new IndexedDbRelayJournal({ databaseName: "relay-accounts", accountKey: "1:1:0xaa:0x01" });
    const second = new IndexedDbRelayJournal({ databaseName: "relay-accounts", accountKey: "1:1:0xaa:0x0102" });
    await first.create(entry(2));
    await second.create(entry(2));
    await second.create(entry(3));
    await expect(first.read()).resolves.toEqual([entry(2)]);
    await expect(second.read()).resolves.toEqual([entry(2), entry(3)]);
    await first.clear(entry(2).resolutionId);
    await expect(first.read()).resolves.toEqual([]);
    await expect(second.read()).resolves.toEqual([entry(2), entry(3)]);
    await first.close();
    await second.close();
  });

  it("rejects an empty account key", () => {
    expect(() => new IndexedDbRelayJournal({ accountKey: "  " })).toThrow(RelayValidationError);
  });
});
