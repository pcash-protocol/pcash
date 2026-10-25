import type { WalletProfile } from "@pcash/sdk/protocol";
import { bytes32Hex, fromHex } from "@pcash/sdk/utils";
import { noteNullifier } from "./publication.ts";
import type { StoredSentOutput, WalletFileData, WalletNote } from "../noteStore.ts";
import type { WalletStateStore } from "../store.ts";

/** What the sender of one received note wrote into it. Unauthenticated: any sender can write anything. */
export interface WalletReceivedMessage {
  /** Empty when the sender wrote no memo. */
  memo: Uint8Array;
  /** Address the sender wrote as its own, or null. */
  sender: bigint | null;
}

/** One output this wallet paid, reopened through the sender region it wrote. */
export interface WalletSentOutput {
  recipientAddress: bigint;
  amount: bigint;
  /** Empty when the payment carried no memo. */
  memo: Uint8Array;
  senderIncluded: boolean;
}

/** System payout this wallet collected in one entry: explicit fees and issuance, from its own recovered system notes. */
export interface WalletSystemPayoutActivity {
  openFeeAmount: bigint;
  issuanceAmount: bigint;
}

export interface WalletNativeActivityEntry {
  transactionId: string | null;
  /** Content hash of a transaction that spent this wallet's notes; a pending payment uses the same content hash. */
  contentHash?: string;
  direction: "received" | "spent";
  amount: bigint;
  blockNumber: bigint;
  blockHash: string;
  /** The block header's timestamp, in seconds. */
  timestamp: bigint;
  /** Null when the entry holds no payout note. */
  payout: WalletSystemPayoutActivity | null;
  /** Commitments of the notes the entry created for this wallet; unlike transactionId, they survive re-inclusion after a reorg. */
  commitments: string[];
  /** Memos and sender addresses on this entry's received notes; absent when none carried either. */
  messages?: WalletReceivedMessage[];
  /** What this transaction paid, when this wallet wrote a sender region for it. */
  sent?: WalletSentOutput[];
}
export type WalletNativeActivity =
  | { state: "unavailable"; reason: "not-synchronized" | "history-not-scanned" | "stale" }
  | { state: "ready"; entries: WalletNativeActivityEntry[]; pcashNumber: bigint; pcashHash: string };

type Position = { transactionId: string | null; contentHash?: string; blockNumber: bigint; blockHash: string; timestamp: bigint };
type Contribution = Position & { amount: bigint; payout?: WalletSystemPayoutActivity; commitments: string[]; message?: WalletReceivedMessage };

export function nativeActivityKey(data: WalletFileData): string {
  return JSON.stringify([data.historyRevision, data.historyStartOutputIndex,
    data.notes.filter((note) => !note.pending && BigInt(note.assetId) === 0n)
      .map((note) => [note.commitment, note.amount, note.spent, note.cursor]),
    data.sentOutputs ?? []]);
}

function nativeActivityEntries(
  contributions: readonly Contribution[],
  sent: ReadonlyMap<string, WalletSentOutput[]> = new Map(),
): WalletNativeActivityEntry[] {
  const grouped = new Map<string, Contribution & { messages: WalletReceivedMessage[] }>();
  for (const contribution of contributions) {
    const key = contribution.transactionId ?? `poster:${contribution.blockHash}`;
    const prior = grouped.get(key);
    const payout = prior?.payout === undefined ? contribution.payout
      : contribution.payout === undefined ? prior.payout : {
        openFeeAmount: prior.payout.openFeeAmount + contribution.payout.openFeeAmount,
        issuanceAmount: prior.payout.issuanceAmount + contribution.payout.issuanceAmount,
      };
    grouped.set(key, {
      ...prior, ...contribution, amount: (prior?.amount ?? 0n) + contribution.amount,
      commitments: [...prior?.commitments ?? [], ...contribution.commitments],
      ...(payout === undefined ? {} : { payout }),
      messages: [...prior?.messages ?? [], ...contribution.message === undefined ? [] : [contribution.message]],
    });
  }
  return [...grouped.values()].flatMap(({ amount, payout, message: _message, messages, ...position }): WalletNativeActivityEntry[] => {
    const paid = position.transactionId === null ? undefined : sent.get(position.transactionId.toLowerCase());
    // A payment still paid someone when issuance it earned offsets or outweighs its spend.
    if (amount === 0n && paid === undefined) return [];
    return [{
      ...position, direction: amount > 0n ? "received" : "spent", amount: amount < 0n ? -amount : amount,
      payout: payout ?? null,
      ...(messages.length === 0 ? {} : { messages }),
      ...(paid === undefined ? {} : { sent: paid }),
    }];
  }).sort((a, b) => a.blockNumber === b.blockNumber ? (a.transactionId ?? "").localeCompare(b.transactionId ?? "") : a.blockNumber > b.blockNumber ? -1 : 1);
}

function sentOutputsByTransaction(outputs: readonly StoredSentOutput[]): Map<string, WalletSentOutput[]> {
  const byTransaction = new Map<string, WalletSentOutput[]>();
  for (const output of [...outputs].sort((a, b) => a.slot - b.slot)) {
    if (BigInt(output.assetId) !== 0n) continue;
    const list = byTransaction.get(output.transactionId) ?? [];
    list.push({
      recipientAddress: BigInt(output.recipientAddress),
      amount: BigInt(output.amount),
      memo: output.memo === undefined ? new Uint8Array(0) : fromHex(output.memo),
      senderIncluded: output.senderIncluded,
    });
    byTransaction.set(output.transactionId, list);
  }
  return byTransaction;
}

/** Historical reads are cached independently of head-only wallet refreshes. */
export class NativeActivityReader {
  #generation: string | undefined;
  #spenders = new Map<string, Promise<Position | null>>();
  #result: { key: string; promise: Promise<WalletNativeActivityEntry[] | null> } | undefined;

  async read(data: WalletFileData, store: WalletStateStore, profile: WalletProfile): Promise<WalletNativeActivity> {
    if (data.syncedThrough === undefined) return { state: "unavailable", reason: "not-synchronized" };
    if (data.historyStartOutputIndex !== "0") return { state: "unavailable", reason: "history-not-scanned" };
    const generation = data.historyRevision ?? "0";
    if (generation !== this.#generation) {
      this.#generation = generation;
      this.#spenders.clear(); this.#result = undefined;
    }
    const key = nativeActivityKey(data);
    if (this.#result?.key !== key) {
      const pending = { key, promise: this.#read(data, store, profile) };
      this.#result = pending;
      pending.promise.catch(() => { if (this.#result === pending) this.#result = undefined; });
    }
    const cached = this.#result;
    const result = await cached.promise;
    if (result === null) {
      if (this.#result === cached) this.#result = undefined;
      return { state: "unavailable", reason: "stale" };
    }
    return { state: "ready", entries: structuredClone(result), pcashNumber: BigInt(data.syncedThrough.blockNumber), pcashHash: data.syncedThrough.blockHash };
  }

  async #read(data: WalletFileData, store: WalletStateStore, profile: WalletProfile): Promise<WalletNativeActivityEntry[] | null> {
    const generation = this.#generation;
    const notes = data.notes.filter((note) => !note.pending && BigInt(note.assetId) === 0n);
    // A note without provenance cannot be assigned to a payment without guessing.
    if (notes.some((note) => note.cursor === undefined || note.commitment === null)) return null;
    // A recovered system note is this wallet's by construction: it derived the opening from its seed.
    const flows: Contribution[] = notes.map((note) => ({
      transactionId: note.cursor!.transactionId, blockNumber: BigInt(note.cursor!.blockNumber), blockHash: note.cursor!.blockHash,
      timestamp: BigInt(note.cursor!.blockTimestamp), amount: BigInt(note.amount), commitments: [note.commitment!],
      ...(note.memo === undefined && note.sender === undefined ? {} : { message: {
        memo: note.memo === undefined ? new Uint8Array(0) : fromHex(note.memo),
        sender: note.sender === undefined ? null : BigInt(note.sender),
      } }),
      ...(note.cursor!.payout === null ? {} : { payout: {
        openFeeAmount: note.cursor!.payout.component === "openFee" ? BigInt(note.amount) : 0n,
        issuanceAmount: note.cursor!.payout.component === "issuance" ? BigInt(note.amount) : 0n,
      } }),
    }));
    const spent = notes.filter((note) => note.spent);
    for (let offset = 0; offset < spent.length; offset += 8) {
      const debits = await Promise.all(spent.slice(offset, offset + 8).map(async (note) => {
        const position = await this.#spender(note, store, profile);
        return position === null ? null : { ...position, amount: -BigInt(note.amount), commitments: [] };
      }));
      if (debits.some((debit) => debit === null)) return null;
      flows.push(...debits as Contribution[]);
    }
    if (generation !== this.#generation) return null;
    if (flows.some((entry) => entry.blockNumber > BigInt(data.syncedThrough!.blockNumber))) return null;
    return nativeActivityEntries(flows, sentOutputsByTransaction(data.sentOutputs ?? []));
  }

  /** The synced transaction that consumed a spent note, from the wallet's local chain state. */
  #spender(note: WalletNote, store: WalletStateStore, profile: WalletProfile): Promise<Position | null> {
    const key = note.commitment!;
    let pending = this.#spenders.get(key);
    if (pending === undefined) {
      const spent = bytes32Hex(noteNullifier(profile.nkRoot, { commitment: key, noteSecret: note.noteSecret }));
      pending = store.readChain((chain) => {
        const consumption = chain?.consumption([spent])[0] ?? null;
        return consumption === null ? null : {
          transactionId: consumption.transactionId, contentHash: consumption.contentHash.toLowerCase(),
          blockNumber: consumption.pcashNumber, blockHash: consumption.pcashHash, timestamp: consumption.timestamp,
        };
      });
      this.#spenders.set(key, pending);
      const attempt = pending;
      pending.then((value) => { if (value === null && this.#spenders.get(key) === attempt) this.#spenders.delete(key); }, () => {
        if (this.#spenders.get(key) === attempt) this.#spenders.delete(key);
      });
    }
    return pending;
  }

}
