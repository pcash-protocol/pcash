// Durable journals for one L1 account's in-flight transactions.
//
// An eth_sendRawTransaction failure is ambiguous. The exact signed bytes are
// persisted before that call and retained until the transaction settles, so a
// later request cannot spend the same nonce or post the same batch without
// operator reconciliation.

import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { lock } from "proper-lockfile";
import { join } from "node:path";
import {
  StoredRelayJournal,
  type RelayJournalEntry,
  type RelayJournalRecords,
} from "../relay/journal.ts";
import { RelayDeadlineError, RelayJournalConflictError } from "../relay/errors.ts";
import { sleep } from "../utils/time.ts";

class MemoryRecords implements RelayJournalRecords {
  readonly #records = new Map<string, RelayJournalEntry>();

  async list(): Promise<unknown[]> {
    return [...this.#records.values()].map((record) => structuredClone(record));
  }

  async add(key: string, record: RelayJournalEntry): Promise<void> {
    if (this.#records.has(key)) {
      throw new RelayJournalConflictError(`in-memory relay journal already holds ${key}`);
    }
    this.#records.set(key, structuredClone(record));
  }

  async put(key: string, record: RelayJournalEntry): Promise<void> {
    this.#records.set(key, structuredClone(record));
  }

  async remove(key: string): Promise<void> {
    this.#records.delete(key);
  }

  async archive(key: string, record: RelayJournalEntry): Promise<string> {
    this.#records.delete(key);
    return `memory://relay-journal/resolved/${encodeURIComponent(record.resolutionId)}`;
  }
}

/** Process-local journal for explicit development sessions. */
export class MemoryRelayJournal extends StoredRelayJournal {
  readonly path = "memory://relay-journal";

  constructor() {
    super("in-memory relay journal", new MemoryRecords());
  }
}

function syncDirectory(path: string): void {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

/**
 * Write, fsync, and close a freshly created entry file. A failed write
 * unlinks the partial file; if that also fails, the leftover still fails
 * closed on the next request, so the original write error is reported.
 */
function writeEntry(descriptor: number, path: string, entry: RelayJournalEntry): void {
  let complete = false;
  try {
    writeFileSync(descriptor, `${JSON.stringify(entry, null, 2)}\n`, "utf8");
    fsyncSync(descriptor);
    complete = true;
  } finally {
    closeSync(descriptor);
    if (!complete) {
      try { unlinkSync(path); } catch { /* report the original write error */ }
    }
  }
}

const ENTRY_FILE = /^nonce-(?:0|[1-9][0-9]*)\.json$/;

class FileRecords implements RelayJournalRecords {
  readonly #directory: string;

  constructor(directory: string) {
    this.#directory = directory;
  }

  #file(key: string): string {
    return join(this.#directory, `${key}.json`);
  }

  async list(): Promise<unknown[]> {
    if (!existsSync(this.#directory)) return [];
    return readdirSync(this.#directory)
      .filter((name) => ENTRY_FILE.test(name))
      .map((name) => {
        const path = join(this.#directory, name);
        const stat = lstatSync(path);
        if (!stat.isFile() || stat.isSymbolicLink()) {
          throw new RelayJournalConflictError(`relay journal ${path} exists but is not a regular file`);
        }
        try {
          return JSON.parse(readFileSync(path, "utf8")) as unknown;
        } catch (error) {
          throw new RelayJournalConflictError(`relay journal ${path} is malformed and must be resolved by an operator`, error);
        }
      });
  }

  async add(key: string, record: RelayJournalEntry): Promise<void> {
    mkdirSync(this.#directory, { recursive: true, mode: 0o700 });
    const path = this.#file(key);
    let descriptor: number;
    try {
      descriptor = openSync(path, "wx", 0o600);
    } catch (error) {
      // Another process holds this nonce.
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new RelayJournalConflictError(
          `relay journal ${path} already exists; reconcile its signed transaction before relaying again`,
          error,
        );
      }
      throw error;
    }
    writeEntry(descriptor, path, record);
    syncDirectory(this.#directory);
  }

  async put(key: string, record: RelayJournalEntry): Promise<void> {
    const replacement = join(this.#directory, `.${key}.replace-${process.pid}-${randomUUID()}`);
    writeEntry(openSync(replacement, "wx", 0o600), replacement, record);
    renameSync(replacement, this.#file(key));
    syncDirectory(this.#directory);
  }

  async remove(key: string): Promise<void> {
    unlinkSync(this.#file(key));
    syncDirectory(this.#directory);
  }

  async archive(key: string, record: RelayJournalEntry): Promise<string> {
    const resolved = join(this.#directory, "resolved");
    mkdirSync(resolved, { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const suffix = record.resolutionId.replace(/[^a-zA-Z0-9_-]/g, "").toLowerCase();
    const archivePath = join(resolved, `${stamp}-${key}-${suffix}.json`);
    if (existsSync(archivePath)) {
      throw new RelayJournalConflictError(`relay journal archive ${archivePath} already exists`);
    }
    renameSync(this.#file(key), archivePath);
    syncDirectory(this.#directory);
    return archivePath;
  }
}

/** One mode-0600 JSON file per in-flight nonce in a host-selected directory. */
export class FileRelayJournal extends StoredRelayJournal {
  readonly path: string;
  readonly #lockContext = new AsyncLocalStorage<{ active: boolean }>();

  constructor(directory: string) {
    super(`relay journal ${directory}`, new FileRecords(directory));
    this.path = directory;
  }

  /** Hold the file lock through reload, signing, persistence, send, and phase update. */
  async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#lockContext.getStore()?.active) return operation();
    mkdirSync(this.path, { recursive: true, mode: 0o700 });
    const directory = realpathSync(this.path);
    let release: () => Promise<void>;
    const deadline = Date.now() + 30_000;
    while (true) {
      try {
        release = await lock(directory, {
          lockfilePath: join(directory, ".lock"),
          stale: 60_000,
          update: 10_000,
          // Keep the default fatal onCompromised behavior: a writer that loses
          // ownership must not continue broadcasting or updating the journal.
        });
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ELOCKED") throw error;
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new RelayDeadlineError("waiting for the relay journal lock timed out", error);
        await sleep(Math.min(250, remaining));
      }
    }
    const context = { active: true };
    try {
      return await this.#lockContext.run(context, operation);
    } finally {
      context.active = false;
      await release();
    }
  }

  override read(): Promise<RelayJournalEntry[]> {
    if (!existsSync(this.path)) return Promise.resolve([]);
    return this.runExclusive(() => super.read());
  }

  override create(entry: RelayJournalEntry): Promise<void> {
    return this.runExclusive(() => super.create(entry));
  }

  override replace(entry: RelayJournalEntry): Promise<void> {
    return this.runExclusive(() => super.replace(entry));
  }

  override clear(resolutionId: string): Promise<void> {
    return this.runExclusive(() => super.clear(resolutionId));
  }

  override archive(resolutionId: string): Promise<string> {
    return this.runExclusive(() => super.archive(resolutionId));
  }
}
