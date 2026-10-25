// Local copy of the public chain data a wallet spends against.
//
// Synchronization downloads the same public feeds for every wallet: every
// output commitment, the nullifiers each transaction consumed, every account
// write, and every published receive key. This store keeps what spending
// needs from them: the output-tree frontier and the sibling paths of this
// wallet's own notes, the consumption of the nullifiers it watches, and the
// full account set with its receive keys. Transaction builders read witnesses
// and recipients from here, so no node request names the notes, accounts, or
// counterparties an action involves.
//
// Everything is anchored at one synced block. A checkpoint per synced block
// back to finality holds the frontier and the account rows each step
// replaced, so a reorganization rewinds instead of rescanning.

import {
  DenseMerkleTree,
  OutputWitnessTree,
  emptyOutputFrontier,
  fieldToHex,
  type OutputFrontier,
} from "@pcash/sdk/crypto";
import type {
  AccountChange,
  AccountProofResult,
  AccountResult,
  OutputPathsResult,
} from "@pcash/sdk/clients";
import {
  BLOCK_HEADER_KEY_STATE_ROOT,
  MERKLE_DEPTH,
  STATE_KEY_ACCOUNT_STATE_ROOT,
} from "@pcash/sdk/constants";
import {
  accountStateCommitment,
  openBlockHeaderKey,
  openStateKey,
  receiveKeyHash,
  type CurrentBoundaryEnvelope,
} from "@pcash/sdk/protocol";
import { fromHex, toHex } from "@pcash/sdk/utils";

/** One account row exactly as its tree leaf commits it. */
interface ChainAccount {
  index: bigint;
  /** Lowercase 20-byte hex. */
  address: string;
  nullifierKeyCommitment: string;
  accountRuleSetCommitment: string;
  accountKind: number;
  accountRevision: bigint;
  receiveKeyHash: string;
  /** Block whose write produced this row. */
  pcashNumber: bigint;
}

/** The canonical transaction that consumed a watched nullifier. */
export interface NullifierConsumption {
  pcashNumber: bigint;
  pcashHash: string;
  /** The consuming block header's timestamp, in seconds. */
  timestamp: bigint;
  transactionId: string;
  contentHash: string;
  /** Every nullifier the transaction inserted, in input-slot order. */
  nullifiers: string[];
}

export interface ChainBlock {
  pcashNumber: bigint;
  pcashHash: string;
}

interface ChainBirthday extends ChainBlock {
  outputCount: bigint;
}

interface AccountUndo {
  index: bigint;
  previous: ChainAccount | null;
  previousKey: string | null;
}

interface Checkpoint extends ChainBlock {
  frontier: OutputFrontier;
  /** Account writes of the step that ended here, with what each replaced. */
  accountUndo: AccountUndo[];
}

/**
 * Record writes committed in the same transaction as the wallet document.
 * A null value deletes the record; `replace` first deletes every record the
 * slot holds.
 */
export interface ChainCommit {
  replace: boolean;
  writes: Map<string, unknown>;
}

/** The unavailable-material lifecycle of a synced key that does not hash to its account's digest. */
export const MISMATCHED_RECEIVE_KEY = "mismatched";

const META = "meta";
const accountKey = (index: bigint): string => `account:${index.toString(16).padStart(10, "0")}`;
const receiveKeyKey = (address: string): string => `key:${address}`;
const checkpointKey = (pcashNumber: bigint): string => `checkpoint:${pcashNumber.toString(16).padStart(16, "0")}`;
const nullifierKey = (nullifier: string): string => `nullifier:${nullifier}`;

/** Thrown when an action needs local chain state this wallet has not synced. */
export class WalletSyncRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WalletSyncRequiredError";
  }
}

function lowerHex(value: string): string {
  return value.toLowerCase();
}

function storedAccount(account: ChainAccount): Record<string, unknown> {
  return {
    index: account.index.toString(),
    address: account.address,
    nullifierKeyCommitment: account.nullifierKeyCommitment,
    accountRuleSetCommitment: account.accountRuleSetCommitment,
    accountKind: account.accountKind,
    accountRevision: account.accountRevision.toString(),
    receiveKeyHash: account.receiveKeyHash,
    pcashNumber: account.pcashNumber.toString(),
  };
}

function loadedAccount(value: unknown): ChainAccount {
  const row = value as Record<string, unknown>;
  return {
    index: BigInt(row.index as string),
    address: row.address as string,
    nullifierKeyCommitment: row.nullifierKeyCommitment as string,
    accountRuleSetCommitment: row.accountRuleSetCommitment as string,
    accountKind: row.accountKind as number,
    accountRevision: BigInt(row.accountRevision as string),
    receiveKeyHash: row.receiveKeyHash as string,
    pcashNumber: BigInt(row.pcashNumber as string),
  };
}

function storedFrontier(frontier: OutputFrontier): Record<string, unknown> {
  return { count: frontier.count.toString(), ommers: frontier.ommers.map((hash) => fieldToHex(hash)) };
}

function loadedFrontier(value: unknown): OutputFrontier {
  const frontier = value as { count: string; ommers: string[] };
  return { count: BigInt(frontier.count), ommers: frontier.ommers.map((hash) => BigInt(hash)) };
}

function storedCheckpoint(checkpoint: Checkpoint): Record<string, unknown> {
  return {
    pcashNumber: checkpoint.pcashNumber.toString(),
    pcashHash: checkpoint.pcashHash,
    frontier: storedFrontier(checkpoint.frontier),
    accountUndo: checkpoint.accountUndo.map((undo) => ({
      index: undo.index.toString(),
      previous: undo.previous === null ? null : storedAccount(undo.previous),
      previousKey: undo.previousKey,
    })),
  };
}

function loadedCheckpoint(value: unknown): Checkpoint {
  const checkpoint = value as Record<string, unknown>;
  return {
    pcashNumber: BigInt(checkpoint.pcashNumber as string),
    pcashHash: checkpoint.pcashHash as string,
    frontier: loadedFrontier(checkpoint.frontier),
    accountUndo: (checkpoint.accountUndo as Array<Record<string, unknown>>).map((undo) => ({
      index: BigInt(undo.index as string),
      previous: undo.previous === null ? null : loadedAccount(undo.previous),
      previousKey: undo.previousKey as string | null,
    })),
  };
}

function storedConsumption(consumption: NullifierConsumption): Record<string, unknown> {
  return {
    pcashNumber: consumption.pcashNumber.toString(),
    pcashHash: consumption.pcashHash,
    timestamp: consumption.timestamp.toString(),
    transactionId: consumption.transactionId,
    contentHash: consumption.contentHash,
    nullifiers: consumption.nullifiers,
  };
}

function loadedConsumption(value: unknown): NullifierConsumption {
  const consumption = value as Record<string, unknown>;
  return {
    pcashNumber: BigInt(consumption.pcashNumber as string),
    pcashHash: consumption.pcashHash as string,
    timestamp: BigInt(consumption.timestamp as string),
    transactionId: consumption.transactionId as string,
    contentHash: consumption.contentHash as string,
    nullifiers: consumption.nullifiers as string[],
  };
}

function storedEnvelope(envelope: CurrentBoundaryEnvelope): Record<string, unknown> {
  const { state, header } = envelope;
  return {
    state: {
      outputRoot: fieldToHex(state.outputRoot),
      outputCount: state.outputCount.toString(),
      issuedSoFar: state.issuedSoFar.toString(),
      lagQ: state.lagQ.toString(),
      accountStateRoot: fieldToHex(state.accountStateRoot),
      accountCount: state.accountCount.toString(),
      nullifierRoot: fieldToHex(state.nullifierRoot),
      nullifierCount: state.nullifierCount.toString(),
    },
    header: {
      parentHash: fieldToHex(header.parentHash),
      number: header.number.toString(),
      timestamp: header.timestamp.toString(),
      transactionResultsRoot: fieldToHex(header.transactionResultsRoot),
      stateRoot: fieldToHex(header.stateRoot),
      l1OriginRoot: fieldToHex(header.l1OriginRoot),
      historyRoot: fieldToHex(header.historyRoot),
    },
    blockHash: fieldToHex(envelope.blockHash),
  };
}

function loadedEnvelope(value: unknown): CurrentBoundaryEnvelope {
  const raw = value as { state: Record<string, string>; header: Record<string, string>; blockHash: string };
  return {
    state: {
      outputRoot: BigInt(raw.state.outputRoot!),
      outputCount: BigInt(raw.state.outputCount!),
      issuedSoFar: BigInt(raw.state.issuedSoFar!),
      lagQ: BigInt(raw.state.lagQ!),
      accountStateRoot: BigInt(raw.state.accountStateRoot!),
      accountCount: BigInt(raw.state.accountCount!),
      nullifierRoot: BigInt(raw.state.nullifierRoot!),
      nullifierCount: BigInt(raw.state.nullifierCount!),
    },
    header: {
      parentHash: BigInt(raw.header.parentHash!),
      number: BigInt(raw.header.number!),
      timestamp: BigInt(raw.header.timestamp!),
      transactionResultsRoot: BigInt(raw.header.transactionResultsRoot!),
      stateRoot: BigInt(raw.header.stateRoot!),
      l1OriginRoot: BigInt(raw.header.l1OriginRoot!),
      historyRoot: BigInt(raw.header.historyRoot!),
    },
    blockHash: BigInt(raw.blockHash),
  };
}

function accountLeaf(account: ChainAccount): bigint {
  return accountStateCommitment(
    BigInt(account.address),
    BigInt(account.nullifierKeyCommitment),
    BigInt(account.accountRuleSetCommitment),
    account.accountKind,
    account.accountRevision,
    BigInt(account.receiveKeyHash),
  );
}

export class WalletChainState {
  /** Increments on every committed step; readers reload when it moves. */
  revision: number;
  birthday: ChainBirthday;
  /** The block every local witness is anchored at, or null before the first step completes. */
  anchor: CurrentBoundaryEnvelope | null;
  /** The block the frontier, accounts, and consumption currently reflect. */
  synced: ChainBlock;
  readonly outputs: OutputWitnessTree;
  readonly consumed: Map<string, NullifierConsumption>;
  readonly #accounts: ChainAccount[];
  readonly #byAddress: Map<string, number>;
  readonly #keys: Map<string, string>;
  /** Per address, the key and digest last checked, and whether the key hashes to the digest. */
  readonly #checkedKeys = new Map<string, { key: string; receiveKeyHash: string; matches: boolean }>();
  readonly #checkpoints: Checkpoint[];
  #tree: DenseMerkleTree | null = null;
  #writes = new Map<string, unknown>();
  #replace = false;
  #stepUndo: AccountUndo[] = [];

  private constructor(fields: {
    revision: number;
    birthday: ChainBirthday;
    anchor: CurrentBoundaryEnvelope | null;
    synced: ChainBlock;
    outputs: OutputWitnessTree;
    consumed: Map<string, NullifierConsumption>;
    accounts: ChainAccount[];
    keys: Map<string, string>;
    checkpoints: Checkpoint[];
  }) {
    this.revision = fields.revision;
    this.birthday = fields.birthday;
    this.anchor = fields.anchor;
    this.synced = fields.synced;
    this.outputs = fields.outputs;
    this.consumed = fields.consumed;
    this.#accounts = fields.accounts;
    this.#byAddress = new Map(fields.accounts.map((account, index) => [account.address, index]));
    this.#keys = fields.keys;
    this.#checkpoints = fields.checkpoints;
  }

  /**
   * A new store whose outputs start at `birthday` with `frontier` and whose
   * accounts start empty at genesis. `previousRevision` keeps the revision
   * moving when a store is replaced, so cached readers reload it.
   */
  static create(birthday: ChainBirthday, frontier: OutputFrontier, previousRevision = 0): WalletChainState {
    const state = new WalletChainState({
      revision: previousRevision,
      birthday,
      anchor: null,
      synced: { pcashNumber: birthday.pcashNumber, pcashHash: birthday.pcashHash },
      outputs: new OutputWitnessTree(frontier),
      consumed: new Map(),
      accounts: [],
      keys: new Map(),
      checkpoints: [],
    });
    state.#replace = true;
    return state;
  }

  /** Rebuild from every record of one wallet slot, or null when the slot has none. */
  static fromRecords(records: ReadonlyMap<string, unknown>): WalletChainState | null {
    const meta = records.get(META) as Record<string, unknown> | undefined;
    if (meta === undefined) return null;
    const accounts: ChainAccount[] = [];
    const keys = new Map<string, string>();
    const checkpoints: Checkpoint[] = [];
    const consumed = new Map<string, NullifierConsumption>();
    for (const [key, value] of records) {
      if (key.startsWith("account:")) accounts.push(loadedAccount(value));
      else if (key.startsWith("key:")) keys.set(key.slice("key:".length), value as string);
      else if (key.startsWith("checkpoint:")) checkpoints.push(loadedCheckpoint(value));
      else if (key.startsWith("nullifier:")) consumed.set(key.slice("nullifier:".length), loadedConsumption(value));
    }
    accounts.sort((left, right) => (left.index < right.index ? -1 : 1));
    checkpoints.sort((left, right) => (left.pcashNumber < right.pcashNumber ? -1 : 1));
    const birthday = meta.birthday as Record<string, string>;
    const synced = meta.synced as Record<string, string>;
    return new WalletChainState({
      revision: meta.revision as number,
      birthday: {
        pcashNumber: BigInt(birthday.pcashNumber!),
        pcashHash: birthday.pcashHash!,
        outputCount: BigInt(birthday.outputCount!),
      },
      anchor: meta.anchor === null ? null : loadedEnvelope(meta.anchor),
      synced: { pcashNumber: BigInt(synced.pcashNumber!), pcashHash: synced.pcashHash! },
      outputs: OutputWitnessTree.fromJSON(meta.outputs),
      consumed,
      accounts,
      keys,
      checkpoints,
    });
  }

  // ---- synchronization ----

  /** Record that a watched nullifier was consumed. */
  recordConsumption(nullifier: string, consumption: NullifierConsumption): void {
    const key = lowerHex(nullifier);
    this.consumed.set(key, consumption);
    this.#writes.set(nullifierKey(key), storedConsumption(consumption));
  }

  /**
   * Apply one account write from the change feed, remembering what it
   * replaced. With `checkReceiveKey`, a key that does not hash to the
   * committed digest rejects the change before anything is applied; without
   * it the key is stored unchecked and checked where it is handed out.
   */
  applyAccountChange(change: AccountChange, options: { checkReceiveKey?: boolean } = {}): void {
    const address = lowerHex(change.address);
    if (options.checkReceiveKey === true && change.receiveKey !== null
      && !this.#keyMatches(address, toHex(change.receiveKey), lowerHex(change.receiveKeyHash))) {
      throw new Error(`account change for ${address} carries a receive key that does not match its committed digest`);
    }
    const index = Number(change.accountIndex);
    const previous = this.#accounts[index] ?? null;
    if (previous === null && index !== this.#accounts.length) {
      throw new Error(`account change at index ${change.accountIndex} skips the next free index ${this.#accounts.length}`);
    }
    if (previous !== null && previous.address !== address) {
      throw new Error(`account change at index ${change.accountIndex} names a different address`);
    }
    const next: ChainAccount = {
      index: change.accountIndex,
      address,
      nullifierKeyCommitment: lowerHex(fieldToHex(change.nullifierKeyCommitment)),
      accountRuleSetCommitment: lowerHex(fieldToHex(change.accountRuleSetCommitment)),
      accountKind: change.accountKind,
      accountRevision: BigInt(change.accountRevision),
      receiveKeyHash: lowerHex(change.receiveKeyHash),
      pcashNumber: change.origin.pcashNumber,
    };
    const previousKey = this.#keys.get(address) ?? null;
    this.#stepUndo.push({ index: change.accountIndex, previous, previousKey });
    this.#setAccount(next);
    // A kept key stays; a cleared digest, or one that changed without bytes to
    // match it, leaves no key that hashes to what the account commits.
    if (change.receiveKey !== null) this.#setKey(address, toHex(change.receiveKey));
    else if (previous?.receiveKeyHash !== next.receiveKeyHash) this.#setKey(address, null);
  }

  /**
   * Seal the current step at `anchor`: write a checkpoint, drop checkpoints
   * finality has made unnecessary, drop consumption nobody watches any more,
   * and return the record writes to commit with the wallet document.
   */
  finishStep(params: {
    anchor: CurrentBoundaryEnvelope;
    finalizedBlock: bigint;
    watched: ReadonlySet<string>;
  }): ChainCommit {
    const block = { pcashNumber: params.anchor.header.number, pcashHash: lowerHex(fieldToHex(params.anchor.blockHash)) };
    const checkpoint: Checkpoint = { ...block, frontier: this.outputs.frontier(), accountUndo: this.#stepUndo };
    this.#stepUndo = [];
    const last = this.#checkpoints.at(-1);
    if (last !== undefined && last.pcashNumber === checkpoint.pcashNumber) {
      // A step that found no new block extends the previous checkpoint.
      checkpoint.accountUndo = [...last.accountUndo, ...checkpoint.accountUndo];
      this.#checkpoints.pop();
    }
    this.#checkpoints.push(checkpoint);
    this.#writes.set(checkpointKey(checkpoint.pcashNumber), storedCheckpoint(checkpoint));
    // Keep every checkpoint above finality and the newest one at or below it.
    let firstKept = 0;
    this.#checkpoints.forEach((candidate, index) => {
      if (candidate.pcashNumber <= params.finalizedBlock) firstKept = index;
    });
    for (const pruned of this.#checkpoints.splice(0, firstKept)) {
      this.#writes.set(checkpointKey(pruned.pcashNumber), null);
    }
    // Only a checkpoint with an older one to rewind to ever needs its undo.
    const oldest = this.#checkpoints[0]!;
    if (oldest.accountUndo.length !== 0) {
      oldest.accountUndo = [];
      this.#writes.set(checkpointKey(oldest.pcashNumber), storedCheckpoint(oldest));
    }
    for (const [nullifier, consumption] of this.consumed) {
      if (!params.watched.has(nullifier) && consumption.pcashNumber <= params.finalizedBlock) {
        this.consumed.delete(nullifier);
        this.#writes.set(nullifierKey(nullifier), null);
      }
    }
    this.anchor = params.anchor;
    this.synced = block;
    this.revision += 1;
    this.#writes.set(META, this.#meta());
    const commit = { replace: this.#replace, writes: this.#writes };
    this.#writes = new Map();
    this.#replace = false;
    return commit;
  }

  /** Checkpoints newest first, for finding where a reorganization forked. */
  checkpoints(): ChainBlock[] {
    return this.#checkpoints.map(({ pcashNumber, pcashHash }) => ({ pcashNumber, pcashHash })).reverse();
  }

  /** Rewind to an earlier checkpoint that is still canonical. */
  rewindTo(block: ChainBlock): void {
    const target = this.#checkpoints.findIndex((checkpoint) => checkpoint.pcashNumber === block.pcashNumber);
    if (target === -1) throw new Error(`no checkpoint at PCASH block ${block.pcashNumber}`);
    for (const checkpoint of this.#checkpoints.splice(target + 1).reverse()) {
      for (const undo of [...checkpoint.accountUndo].reverse()) {
        const current = this.#accounts[Number(undo.index)]!;
        if (undo.previous === null) {
          this.#accounts.pop();
          this.#byAddress.delete(current.address);
          this.#tree?.truncate(this.#accounts.length);
          this.#writes.set(accountKey(undo.index), null);
        } else {
          this.#setAccount(undo.previous);
        }
        this.#setKey(current.address, undo.previousKey);
      }
      this.#writes.set(checkpointKey(checkpoint.pcashNumber), null);
    }
    const kept = this.#checkpoints[target]!;
    this.outputs.rewind(kept.frontier);
    for (const [nullifier, consumption] of this.consumed) {
      if (consumption.pcashNumber > kept.pcashNumber) {
        this.consumed.delete(nullifier);
        this.#writes.set(nullifierKey(nullifier), null);
      }
    }
    this.anchor = null;
    this.synced = { pcashNumber: kept.pcashNumber, pcashHash: kept.pcashHash };
  }

  #setAccount(account: ChainAccount): void {
    const index = Number(account.index);
    this.#accounts[index] = account;
    this.#byAddress.set(account.address, index);
    this.#tree?.set(index, accountLeaf(account));
    this.#writes.set(accountKey(account.index), storedAccount(account));
  }

  #setKey(address: string, key: string | null): void {
    if (key === null) {
      if (!this.#keys.delete(address)) return;
    } else {
      if (this.#keys.get(address) === key) return;
      this.#keys.set(address, key);
    }
    this.#writes.set(receiveKeyKey(address), key);
  }

  #meta(): Record<string, unknown> {
    return {
      revision: this.revision,
      birthday: {
        pcashNumber: this.birthday.pcashNumber.toString(),
        pcashHash: this.birthday.pcashHash,
        outputCount: this.birthday.outputCount.toString(),
      },
      anchor: this.anchor === null ? null : storedEnvelope(this.anchor),
      synced: { pcashNumber: this.synced.pcashNumber.toString(), pcashHash: this.synced.pcashHash },
      outputs: this.outputs.toJSON(),
    };
  }

  // ---- reads ----

  get accountCount(): bigint {
    return BigInt(this.#accounts.length);
  }

  /** Root of the local account tree; builds the tree on first use. */
  accountRoot(): bigint {
    return this.#accountTree().root();
  }

  #accountTree(): DenseMerkleTree {
    this.#tree ??= new DenseMerkleTree(MERKLE_DEPTH, this.#accounts.map(accountLeaf));
    return this.#tree;
  }

  account(address: string): ChainAccount | null {
    const index = this.#byAddress.get(lowerHex(address));
    return index === undefined ? null : this.#accounts[index]!;
  }

  /**
   * The published receive key of a registered account, or null when it has
   * none or its synced key does not hash to the digest the account commits.
   */
  receiveKey(address: string): Uint8Array | null {
    const account = this.account(address);
    const key = account === null ? undefined : this.#checkedKey(account);
    return key === undefined || key === null ? null : fromHex(key);
  }

  /**
   * The account's synced key, `null` when it does not hash to the digest the
   * account commits, or `undefined` when none is synced. A fresh replay of the
   * account-change feed stores keys unchecked, so this is the check before
   * any encryption to them.
   */
  #checkedKey(account: ChainAccount): string | null | undefined {
    const key = this.#keys.get(account.address);
    if (key === undefined) return undefined;
    return this.#keyMatches(account.address, key, account.receiveKeyHash) ? key : null;
  }

  #keyMatches(address: string, key: string, digest: string): boolean {
    const checked = this.#checkedKeys.get(address);
    if (checked?.key === key && checked.receiveKeyHash === digest) return checked.matches;
    const matches = fieldToHex(receiveKeyHash(fromHex(key))) === digest;
    this.#checkedKeys.set(address, { key, receiveKeyHash: digest, matches });
    return matches;
  }

  /** The anchor, or a sync-required error before the first completed step. */
  requireAnchor(): CurrentBoundaryEnvelope {
    if (this.anchor === null) throw new WalletSyncRequiredError("wallet chain state has no synced anchor; sync before spending");
    return this.anchor;
  }

  /** The account row in the node's `pcash_getAccount` shape. */
  accountResult(address: string): AccountResult | null {
    const account = this.account(address);
    if (account === null) return null;
    const key = this.#checkedKey(account);
    return {
      address: account.address,
      index: account.index,
      accountRevision: account.accountRevision,
      nullifierKeyCommitment: account.nullifierKeyCommitment,
      accountRuleSetCommitment: account.accountRuleSetCommitment,
      accountKind: account.accountKind,
      receiveKeyHash: account.receiveKeyHash,
      material: BigInt(account.receiveKeyHash) === 0n
        ? { status: "notPresent" }
        : key === undefined
          ? { status: "unavailable", lifecycle: "absent" }
          : key === null
            ? { status: "unavailable", lifecycle: MISMATCHED_RECEIVE_KEY }
            : { status: "available", mlKem768PublicKey: key },
    };
  }

  /** An account opening at the anchor, in the node's `pcash_getAccountProof` shape. */
  accountProof(address: string): AccountProofResult {
    const anchor = this.requireAnchor();
    const account = this.accountResult(address);
    if (account === null) return { status: "notFound", address: lowerHex(address), authenticated: false };
    return {
      status: "present",
      account,
      accountStateRoot: anchor.state.accountStateRoot,
      accountSiblings: this.#accountTree().path(Number(account.index)),
      accountCount: anchor.state.accountCount,
      stateRootHeaderSiblings: openBlockHeaderKey(anchor.header, BLOCK_HEADER_KEY_STATE_ROOT).siblings,
      accountStateRootStateSiblings: openStateKey(anchor.state, STATE_KEY_ACCOUNT_STATE_ROOT).siblings,
      boundary: anchor,
    };
  }

  /** Output openings for this wallet's marked notes at the anchor. */
  outputPaths(outputs: readonly { outputIndex: bigint | number }[]): OutputPathsResult {
    const anchor = this.requireAnchor();
    return {
      root: fieldToHex(anchor.state.outputRoot),
      count: anchor.state.outputCount,
      paths: outputs.map(({ outputIndex }) => {
        const index = BigInt(outputIndex);
        if (!this.outputs.isMarked(index)) {
          throw new WalletSyncRequiredError(`output ${index} is not tracked by this wallet's local chain state`);
        }
        return { outputIndex: index, siblings: this.outputs.witness(index) };
      }),
      boundary: anchor,
    };
  }

  /** Consumption of each nullifier, or null where no synced block consumed it. */
  consumption(nullifiers: readonly string[]): (NullifierConsumption | null)[] {
    return nullifiers.map((nullifier) => this.consumed.get(lowerHex(nullifier)) ?? null);
  }
}

/** A new, empty wallet chain store bootstrapped at genesis. */
export function genesisChainState(genesis: ChainBlock, previousRevision = 0): WalletChainState {
  return WalletChainState.create({ ...genesis, outputCount: 0n }, emptyOutputFrontier(), previousRevision);
}
