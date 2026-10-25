import type { EthereumName, ReverseNameResult } from "@pcash/sdk/names";

export const NAME_CACHE_KEY = "pcash-ethereum-names";
export const NAME_TTL = 5 * 60_000;
export const MISS_TTL = 60_000;
export const FAILURE_TTL = 30_000;
const CAPACITY = 1_000;

export interface NameCacheEntry {
  identity: EthereumName | null;
  expiresAt: number;
  failed: boolean;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Browser storage is client-controlled input. Check its shape once when restoring,
// rather than validating entries produced by our own lookup code on every read.
function restoredEntry(value: unknown): value is NameCacheEntry {
  if (!object(value) || typeof value.expiresAt !== "number" || !Number.isFinite(value.expiresAt) || typeof value.failed !== "boolean") return false;
  const identity = value.identity;
  return identity === null || (object(identity)
    && typeof identity.address === "string" && /^0x[0-9a-fA-F]{40}$/.test(identity.address)
    && typeof identity.name === "string" && identity.name.length > 0
    && ["ens", "gns", "wns"].includes(identity.system as string));
}

/** Only complete RPC results reach persistent storage. TanStack Query owns memory and in-flight sharing. */
export class NameCache {
  private entries: Record<string, NameCacheEntry> | undefined;
  constructor(private readonly storage: () => Pick<Storage, "getItem" | "setItem" | "removeItem">, private readonly now = () => Date.now()) {}

  private load(): Record<string, NameCacheEntry> {
    if (this.entries === undefined) {
      try {
        const stored: unknown = JSON.parse(this.storage().getItem(NAME_CACHE_KEY) ?? "{}");
        this.entries = object(stored) ? Object.fromEntries(Object.entries(stored)
          .filter((entry): entry is [string, NameCacheEntry] => restoredEntry(entry[1]))
          .slice(-CAPACITY)) : {};
      }
      catch { this.entries = {}; }
    }
    return this.entries!;
  }

  clear(): void {
    this.entries = {};
    try { this.storage().removeItem(NAME_CACHE_KEY); }
    catch { /* Memory is cleared even if the browser denies storage access. */ }
  }

  read(key: string): NameCacheEntry | undefined {
    const entry = this.load()[key];
    return entry !== undefined && entry.expiresAt > this.now() ? entry : undefined;
  }

  write(key: string, result: ReverseNameResult): NameCacheEntry {
    const entry = {
      identity: result.identity,
      expiresAt: this.now() + (!result.complete ? FAILURE_TTL : result.identity === null ? MISS_TTL : NAME_TTL),
      failed: false,
    };
    if (result.complete) {
      const entries = this.load();
      delete entries[key];
      entries[key] = entry;
      for (const [storedKey, stored] of Object.entries(entries)) {
        if (stored.expiresAt <= this.now()) delete entries[storedKey];
      }
      for (const oldest of Object.keys(entries).slice(0, Math.max(0, Object.keys(entries).length - CAPACITY))) delete entries[oldest];
      try { this.storage().setItem(NAME_CACHE_KEY, JSON.stringify(entries)); }
      catch { /* Storage may be disabled or full; the query still works in memory. */ }
    }
    return entry;
  }
}
