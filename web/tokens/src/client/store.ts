// Creator records. A record holds which sets and drops this creator started,
// their recovery material and terms, and the handles of the steps already
// taken. Canonical wallet recovery records can rebuild records lost with this
// store; progress is re-read from the chain or the wallet's own journals.
//
// Values are strings and plain numbers so any host store can hold them.

import type { FundingChunk } from "../witness.ts";

interface RecordBase {
  key: string;
  chainId: string;
  /** Canonical address of the creating wallet. */
  creator: string;
  assetId: string;
  /** The asset's definition in share-text form. */
  definition: string;
  /** Approved open fee for relayed steps; absent uses the wallet's default. */
  openFeeAmount?: string;
  /** Canonical wallet recovery job that rebuilt this record after local storage loss. */
  recoveryJobId?: string;
  /** The contract creation, once journaled. */
  /** The wallet bulk job that funds the contract's notes. */
  fundingJobId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface LinkSetRecord extends RecordBase {
  kind: "links";
  /** With the wallet's nullifier key root, derives the set's secret. */
  nonce: string;
  amounts: string[];
  /** The links' funding transactions in link order, once every one is accepted. */
  funding?: FundingChunk[];
}

export interface DropRecord extends RecordBase {
  kind: "drop";
  dropSeed: string;
  claimAmount: string;
  count: number;
  cutoffBlockNumber: string;
  claimEndTimestamp: string;
  /** The inventory's funding transactions in note order, once every one is accepted. */
  funding?: FundingChunk[];
  /** The catalog content ID of the drop's publication. */
  publicationContentId?: string;
}

export type TokensRecord = LinkSetRecord | DropRecord;

/** Host-owned transactional store for creator records. */
export interface TokensStore {
  list(): Promise<TokensRecord[]>;
  get(key: string): Promise<TokensRecord | null>;
  /** Atomically replace or remove one record from its latest durable value. */
  update(key: string, operation: (current: TokensRecord | null) => TokensRecord | null): Promise<TokensRecord | null>;
}

export class MemoryTokensStore implements TokensStore {
  readonly #records = new Map<string, TokensRecord>();

  async list(): Promise<TokensRecord[]> {
    return [...this.#records.values()].map((record) => structuredClone(record));
  }

  async get(key: string): Promise<TokensRecord | null> {
    const record = this.#records.get(key);
    return record === undefined ? null : structuredClone(record);
  }

  async update(key: string, operation: (current: TokensRecord | null) => TokensRecord | null): Promise<TokensRecord | null> {
    const current = this.#records.get(key);
    const next = operation(current === undefined ? null : structuredClone(current));
    if (next === null) this.#records.delete(key);
    else this.#records.set(key, structuredClone(next));
    return next === null ? null : structuredClone(next);
  }
}

export function linkSetKey(chainId: bigint, creator: string, nonce: string): string {
  return `links:${chainId}:${creator.toLowerCase()}:${nonce}`;
}

export function dropKey(chainId: bigint, creator: string, dropSeed: string): string {
  return `drop:${chainId}:${creator.toLowerCase()}:${dropSeed}`;
}
