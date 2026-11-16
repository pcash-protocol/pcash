import { useSyncExternalStore } from "react";
import type { AmountUnit } from "../components/tokenAmount.ts";

/**
 * Token actions this browser submitted, for the Activity feed. The wallet
 * retires a token action once it settles and keeps no record of what it did,
 * so the website records the action's meaning once its exact bytes are
 * journaled, before the submission, so a closed tab cannot lose it.
 */
export type TokenActivityKind = "token-created" | "token-sent" | "token-burned" | "token-claimed";

export interface TokenActivity {
  kind: TokenActivityKind;
  /** Content hash of the submitted transaction. */
  contentHash: string;
  amount: bigint;
  unit: AmountUnit;
  /** Recipient of a sent token. */
  to?: string;
  /** When this browser submitted it, in milliseconds. */
  at: number;
  /** The bytes are journaled but no Ethereum hash or mempool acceptance is known yet. */
  awaitingSubmission?: true;
}

const LIMIT = 256;
const listeners = new Set<() => void>();
const cache = new Map<string, { raw: string | null; value: TokenActivity[] }>();
const memory = new Map<string, string>();

export function tokenActivityKey(network: { pcashChainId: bigint | number; l1ChainId: bigint | number; genesisHash: string }, address: string): string {
  return `pcash:token-activity:${network.pcashChainId}:${network.l1ChainId}:${network.genesisHash.toLowerCase()}:${address.toLowerCase()}`;
}

/** The signed-in wallet's key, once its network and account are known. */
export function walletTokenActivityKey({ status, snapshot }: {
  status?: { pcashChainId: bigint | number; l1ChainId: bigint | number; genesisHash: string } | undefined;
  snapshot?: { address: string } | undefined;
}): string | undefined {
  return status === undefined || snapshot === undefined ? undefined : tokenActivityKey(status, snapshot.address);
}

function readRaw(key: string): string | null {
  try { return localStorage.getItem(key) ?? memory.get(key) ?? null; } catch { return memory.get(key) ?? null; }
}

function parse(raw: string | null): TokenActivity[] {
  if (raw === null) return [];
  try {
    return (JSON.parse(raw) as Array<Omit<TokenActivity, "amount"> & { amount: string }>).map((entry) => ({ ...entry, amount: BigInt(entry.amount) }));
  } catch { return []; }
}

export function readTokenActivity(key: string): TokenActivity[] {
  const raw = readRaw(key);
  const cached = cache.get(key);
  if (cached !== undefined && cached.raw === raw) return cached.value;
  const value = parse(raw);
  cache.set(key, { raw, value });
  return value;
}

function write(key: string, entries: TokenActivity[]): void {
  const raw = JSON.stringify(entries.slice(0, LIMIT).map((entry) => ({ ...entry, amount: entry.amount.toString() })));
  memory.set(key, raw);
  try { localStorage.setItem(key, raw); } catch { /* The in-memory copy serves this page when storage is unavailable. */ }
  for (const notify of listeners) notify();
}

/** Remember one token action; a resubmission of the same transaction replaces its entry. */
export function recordTokenActivity(key: string, activity: TokenActivity): void {
  const contentHash = activity.contentHash.toLowerCase();
  write(key, [{ ...activity, contentHash }, ...readTokenActivity(key).filter((entry) => entry.contentHash !== contentHash)]);
}

/** Its Ethereum hash or mempool acceptance is known. */
export function markTokenActivitySubmitted(key: string, contentHash: string): void {
  const id = contentHash.toLowerCase();
  const entries = readTokenActivity(key);
  if (!entries.some((entry) => entry.contentHash === id && entry.awaitingSubmission)) return;
  write(key, entries.map(({ awaitingSubmission, ...entry }) => entry.contentHash === id ? entry : { ...entry, ...(awaitingSubmission ? { awaitingSubmission } : {}) }));
}

/** The action was refused before anything left this browser. */
export function forgetTokenActivity(key: string, contentHash: string): void {
  const id = contentHash.toLowerCase();
  const entries = readTokenActivity(key);
  if (entries.some((entry) => entry.contentHash === id)) write(key, entries.filter((entry) => entry.contentHash !== id));
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  addEventListener("storage", listener);
  return () => { listeners.delete(listener); removeEventListener("storage", listener); };
}

const EMPTY: TokenActivity[] = [];

export function useTokenActivity(key: string | undefined): TokenActivity[] {
  return useSyncExternalStore(subscribe, () => key === undefined ? EMPTY : readTokenActivity(key), () => EMPTY);
}
