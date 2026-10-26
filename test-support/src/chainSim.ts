// An in-memory PCASH chain for tests that drive wallet synchronization.
//
// `ChainSim` serves exactly the public reads synchronization makes (status,
// headers by number, the output frontier, output pages of whole transactions
// with their nullifiers and arenas, and account changes), includes submitted private-value transactions
// in new blocks, reorgs on demand, and records every call so tests can compare
// request transcripts.

import { randomBytes } from "node:crypto";
import { OutputOpeningMismatchError, type AccountChange, type OutputResult, type PcashNodeClient, type ReceiptResult, type StatusResult } from "@pcash/sdk/clients";
import { OUTPUT_DATA_BYTES, MERKLE_DEPTH, PRIVATE_VALUE_PROFILES, privateValueProfile } from "@pcash/sdk/constants";
import { emptyLadder, fieldToHex, poseidon2, type OutputFrontier } from "@pcash/sdk/crypto";
import {
  accountStateCommitment,
  blockHash,
  decodeTransaction,
  encodePayload,
  encryptEnvelope,
  noteBodyCommitment,
  outputCommitment,
  ownerCommitment,
  privateValuePublicInputs,
  randomArena,
  receiveKeyHash,
  stateRoot,
  TX_KIND_PRIVATE_VALUE,
  type CurrentBoundaryEnvelope,
} from "@pcash/sdk/protocol";
import { keccak256, toHex } from "@pcash/sdk/utils";

const ZERO_WORD = `0x${"00".repeat(32)}`;
const word = (value: bigint): string => fieldToHex(value).toLowerCase();

/** The root of the `2^height` leaves starting at `index * 2^height`. */
function subtreeRoot(leaves: readonly bigint[], height: number, index: bigint): bigint {
  const first = index << BigInt(height);
  if (first >= BigInt(leaves.length)) return emptyLadder(MERKLE_DEPTH)[height]!;
  if (height === 0) return leaves[Number(index)]!;
  return poseidon2(subtreeRoot(leaves, height - 1, index * 2n), subtreeRoot(leaves, height - 1, index * 2n + 1n));
}

export function denseRoot(leaves: readonly bigint[]): bigint {
  return subtreeRoot(leaves, MERKLE_DEPTH, 0n);
}

export function frontierOf(leaves: readonly bigint[]): OutputFrontier {
  const count = BigInt(leaves.length);
  const ommers: bigint[] = [];
  for (let height = 0; height < MERKLE_DEPTH; height++) {
    if (((count >> BigInt(height)) & 1n) === 1n) ommers.push(subtreeRoot(leaves, height, (count >> BigInt(height)) - 1n));
  }
  return { count, ommers };
}

export interface AccountRow {
  address: string;
  nullifierKeyCommitment: bigint;
  accountRuleSetCommitment: bigint;
  accountKind?: 0 | 1;
  accountRevision?: number;
  receiveKey?: Uint8Array | null;
}

export function accountChangeOf(
  row: AccountRow,
  index: bigint,
  origin: { pcashNumber: bigint; pcashHash: string },
  introducesKey: boolean,
): AccountChange {
  const receiveKey = row.receiveKey ?? null;
  return {
    origin,
    accountIndex: index,
    address: row.address.toLowerCase() as `0x${string}`,
    nullifierKeyCommitment: row.nullifierKeyCommitment,
    accountRuleSetCommitment: row.accountRuleSetCommitment,
    accountKind: row.accountKind ?? 0,
    accountRevision: row.accountRevision ?? 1,
    receiveKeyHash: (receiveKey === null ? ZERO_WORD : word(receiveKeyHash(receiveKey))) as `0x${string}`,
    receiveKey: introducesKey ? receiveKey : null,
  };
}

function accountLeafOf(change: AccountChange): bigint {
  return accountStateCommitment(
    BigInt(change.address),
    change.nullifierKeyCommitment,
    change.accountRuleSetCommitment,
    change.accountKind,
    change.accountRevision,
    BigInt(change.receiveKeyHash),
  );
}

/** The account-tree leaf of one account row. */
export function accountRowLeaf(row: AccountRow): bigint {
  const receiveKey = row.receiveKey ?? null;
  return accountStateCommitment(
    BigInt(row.address),
    row.nullifierKeyCommitment,
    row.accountRuleSetCommitment,
    row.accountKind ?? 0,
    row.accountRevision ?? 1,
    receiveKey === null ? 0n : receiveKeyHash(receiveKey),
  );
}

function simStatus(fields: {
  pcashChainId: bigint;
  l1ChainId: bigint;
  inboxAddress: string;
  genesisHash: string;
  head: { number: bigint; hash: string; timestamp: bigint; outputCount: bigint };
  finalized: { number: bigint; hash: string; timestamp: bigint };
  indexed: { number: bigint; hash: string };
}): StatusResult {
  const { head, finalized } = fields;
  const prefixHash = ZERO_WORD;
  return {
    latestBlock: head.number,
    latestBlockHash: head.hash,
    latestBlockTimestamp: head.timestamp,
    finalizedBlock: finalized.number,
    finalizedBlockHash: finalized.hash,
    finalizedBlockTimestamp: finalized.timestamp,
    latestL1BlockNumber: head.number,
    latestL1BlockHash: head.hash,
    observedL1BlockNumber: head.number,
    derivation: { state: "following", sinceUnixMs: 0n },
    finalizedL1BlockNumber: finalized.number,
    finalizedL1BlockHash: finalized.hash,
    stateRoot: head.hash,
    l1OriginRoot: head.hash,
    historyRoot: head.hash,
    outputCount: head.outputCount,
    issuedSoFar: 0n,
    supplyCap: 1_000_000_000n * 10n ** 18n,
    totalSucceeded: 0n,
    totalFailed: 0n,
    totalTransactions: 0n,
    index: { status: "ready", cursor: { blockNumber: fields.indexed.number, blockHash: fields.indexed.hash } },
    proverAssets: null,
    pcashChainId: Number(fields.pcashChainId),
    genesisHash: fields.genesisHash,
    acceptedTransactionTypes: [0],
    acceptedBatchVersions: [1],
    l1ChainId: fields.l1ChainId,
    inboxAddress: fields.inboxAddress,
    genesisL1Block: 0n,
    genesisL1BlockHash: fields.genesisHash,
    forkCapability: {
      chainId: fields.pcashChainId,
      genesisHash: fields.genesisHash,
      headTimestamp: head.timestamp,
      currentForkCount: 0n,
      currentPrefixHash: prefixHash,
      nextActivationTimestamp: 0n,
      nextPrefixHash: prefixHash,
    },
  };
}

/** A note one wallet can decrypt, delivered to `receiveKey`. */
export interface SimNote {
  owner: bigint;
  receiveKey: Uint8Array;
  amount: bigint;
  noteSecret?: bigint;
  assetId?: bigint;
}

export interface SimTransaction {
  contentHash?: string;
  shape?: number;
  /** Every nullifier the transaction consumes, in input-slot order. */
  nullifiers?: readonly string[];
  /** The section's arena; random bytes (no regions) by default. */
  arena?: Uint8Array;
  /** One entry per output slot: a note, or null for undecryptable padding. */
  outputs: readonly (SimNote | { body: bigint; outputData: Uint8Array } | null)[];
}

export interface SimBlockInput {
  transactions?: readonly SimTransaction[];
  accounts?: readonly AccountRow[];
  timestamp?: bigint;
}

export interface SimBlock {
  number: bigint;
  hash: bigint;
  envelope: CurrentBoundaryEnvelope;
  outputs: OutputResult[];
  changes: AccountChange[];
  leaves: bigint[];
  accounts: AccountChange[];
}

export interface SimCall {
  method: string;
  params: string;
}

function json(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    typeof item === "bigint" ? `${item}n` : item instanceof Uint8Array ? toHex(item) : item);
}

export class ChainSim {
  readonly pcashChainId: bigint;
  /** The Ethereum side of the network identity profiles are derived for. */
  readonly l1ChainId: bigint;
  readonly inboxAddress: string;
  readonly calls: SimCall[] = [];
  /** Blocks behind the head that are not yet final. */
  finalityLag = 0n;
  /** Blocks the derived index trails the head by; its cursor is the sync target. */
  indexLag = 0n;
  /** Rows per output or account-change page. An output page holds whole transactions. */
  pageSize = 2_000;
  /**
   * Answer receipts by content hash, output paths at the head, and included
   * transactions by ID, as a node does for a wallet resolving a direct send.
   * Off, receipts are never found.
   */
  servesFundingReads = false;
  #blocks: SimBlock[] = [];
  /** The exact bytes of each transaction `include` added, by content hash. */
  readonly #entries = new Map<string, Uint8Array>();
  #salt = 0n;

  constructor(pcashChainId: bigint, network: { l1ChainId?: bigint; inboxAddress?: string } = {}) {
    this.pcashChainId = pcashChainId;
    this.l1ChainId = network.l1ChainId ?? 11_155_111n;
    this.inboxAddress = network.inboxAddress ?? `0x${"66".repeat(20)}`;
    this.#blocks.push(this.#seal(null, { timestamp: 1_800_000_000n }, [], [], [], []));
  }

  get head(): SimBlock {
    return this.#blocks.at(-1)!;
  }

  block(number: bigint): SimBlock {
    const block = this.#blocks[Number(number)];
    if (block === undefined) throw new Error(`unknown PCASH block ${number}`);
    return block;
  }

  get genesisHash(): string {
    return word(this.#blocks[0]!.hash);
  }

  #seal(
    parent: SimBlock | null,
    input: SimBlockInput,
    leaves: bigint[],
    accounts: AccountChange[],
    outputs: OutputResult[],
    changes: AccountChange[],
  ): SimBlock {
    const number = parent === null ? 0n : parent.number + 1n;
    const state = {
      outputRoot: denseRoot(leaves),
      outputCount: BigInt(leaves.length),
      issuedSoFar: 0n,
      lagQ: 0n,
      accountStateRoot: denseRoot(accounts.map(accountLeafOf)),
      accountCount: BigInt(accounts.length),
      nullifierRoot: 0n,
      nullifierCount: 0n,
    };
    const header = {
      parentHash: parent?.hash ?? 0n,
      number,
      timestamp: input.timestamp ?? (parent === null ? 1_800_000_000n : parent.envelope.header.timestamp + 12n),
      transactionResultsRoot: 0n,
      stateRoot: stateRoot(state),
      l1OriginRoot: this.#salt,
      historyRoot: 0n,
    };
    const hash = blockHash(header);
    const origin = { pcashNumber: number, pcashHash: word(hash) };
    return {
      number,
      hash,
      envelope: { state, header, blockHash: hash },
      outputs: outputs.map((output) => ({ ...output, origin: { ...origin, timestamp: header.timestamp } })),
      changes: changes.map((change) => ({ ...change, origin })),
      leaves,
      accounts,
    };
  }

  /** Append one block holding these transactions and account writes. */
  addBlock(input: SimBlockInput = {}): SimBlock {
    const parent = this.head;
    const leaves = [...parent.leaves];
    const accounts = [...parent.accounts];
    const outputs: OutputResult[] = [];
    const placeholder = { pcashNumber: 0n, pcashHash: ZERO_WORD };
    for (const transaction of input.transactions ?? []) {
      const contentHash = transaction.contentHash ?? toHex(randomBytes(32));
      const transactionId = toHex(randomBytes(32));
      const shape = transaction.shape ?? PRIVATE_VALUE_PROFILES.S.shapeId;
      const arena = transaction.arena ?? randomArena(shape as 0 | 1);
      transaction.outputs.forEach((output, slot) => {
        const index = BigInt(leaves.length);
        let body: bigint;
        let outputData: Uint8Array;
        if (output === null) {
          body = BigInt(toHex(randomBytes(31)));
          outputData = new Uint8Array(randomBytes(OUTPUT_DATA_BYTES));
        } else if ("body" in output) {
          ({ body, outputData } = output);
        } else {
          const noteSecret = output.noteSecret ?? BigInt(toHex(randomBytes(31)));
          const assetId = output.assetId ?? 0n;
          body = noteBodyCommitment(ownerCommitment(output.owner, noteSecret), assetId, output.amount);
          outputData = encryptEnvelope(output.receiveKey, encodePayload({
            chainId: this.pcashChainId, assetId, amount: output.amount, owner: output.owner, noteSecret, outputIndex: slot,
          }));
        }
        const leaf = outputCommitment(body, index);
        leaves.push(leaf);
        outputs.push({
          outputIndex: index,
          outputCommitment: word(leaf),
          origin: { ...placeholder, timestamp: 0n },
          kind: "ordinary",
          outputData,
          transactionId,
          contentHash: contentHash as `0x${string}`,
          transactionType: 0,
          privateValueShape: shape as 0 | 1,
          outputSlot: slot,
          nullifiers: slot === 0 ? (transaction.nullifiers ?? []).map((value) => value.toLowerCase() as `0x${string}`) : [],
          arena: slot === 0 ? arena : null,
        });
      });
    }
    const changes: AccountChange[] = [];
    for (const row of input.accounts ?? []) {
      const existing = accounts.findIndex((account) => account.address === row.address.toLowerCase());
      const index = existing === -1 ? BigInt(accounts.length) : BigInt(existing);
      const previousKey = existing === -1 ? null : accounts[existing]!.receiveKeyHash;
      const change = accountChangeOf(row, index, placeholder, true);
      if (previousKey !== null && previousKey === change.receiveKeyHash) change.receiveKey = null;
      accounts[Number(index)] = change;
      changes.push(change);
    }
    this.#blocks.push(this.#seal(parent, input, leaves, accounts, outputs, changes));
    return this.head;
  }

  /** Include an encoded private-value transaction, as the node would after admission. */
  include(entry: Uint8Array, input: Omit<SimBlockInput, "transactions"> = {}): SimBlock {
    const decoded = decodeTransaction(entry);
    if (decoded.kind !== TX_KIND_PRIVATE_VALUE) throw new Error("the simulator includes private-value transactions only");
    const profile = privateValueProfile(decoded.shape);
    const publicInputs = privateValuePublicInputs(decoded);
    const nullifiers = publicInputs.slice(profile.offsets.nullifiers, profile.offsets.nullifiers + profile.inputs).map(word);
    const bodies = publicInputs.slice(profile.offsets.outputs, profile.offsets.outputs + profile.outputs);
    const contentHash = toHex(keccak256(entry)).toLowerCase();
    this.#entries.set(contentHash, entry);
    return this.addBlock({
      ...input,
      transactions: [{
        contentHash,
        shape: decoded.shape,
        nullifiers,
        arena: decoded.arena,
        outputs: bodies.map((body, slot) => ({ body, outputData: decoded.outputData[slot]! })),
      }],
    });
  }

  /** Replace every block above `forkAt` with new ones. */
  reorg(forkAt: bigint, blocks: readonly SimBlockInput[]): void {
    this.#blocks.length = Number(forkAt) + 1;
    this.#salt += 1n;
    for (const block of blocks) this.addBlock(block);
  }

  /** The canonical inclusion of one exact transaction, as an accepted receipt. */
  #receipts(contentHash: string): ReceiptResult[] {
    const rows = this.#blocks.flatMap((block) => block.outputs)
      .filter((output): output is Extract<OutputResult, { kind: "ordinary" }> => output.kind === "ordinary"
        && output.contentHash.toLowerCase() === contentHash.toLowerCase());
    if (rows.length === 0) return [];
    const first = rows[0]!;
    return [{
      inclusion: { l1BlockNumber: first.origin.pcashNumber, l1BlockHash: first.origin.pcashHash, l1TransactionIndex: 0n,
        l1TransactionHash: ZERO_WORD, batchItemIndex: 0n },
      contentHash: first.contentHash.toLowerCase(),
      transactionId: first.transactionId,
      outcome: "succeeded",
      failureDetail: null,
      l1Sender: `0x${"00".repeat(20)}`,
      issuanceOwnerCommitment: null,
      settledOpenFeeAmount: 0n,
      settledIssuanceAmount: 0n,
      kind: "privateValue",
      accountCreation: 0,
      outputLeafStart: first.outputIndex,
      outputsAdded: BigInt(rows.length),
      nullifiers: first.nullifiers,
      account: null,
    }];
  }

  status(): StatusResult {
    const head = this.head;
    const finalized = this.block(head.number > this.finalityLag ? head.number - this.finalityLag : 0n);
    const indexed = this.block(head.number > this.indexLag ? head.number - this.indexLag : 0n);
    return simStatus({
      pcashChainId: this.pcashChainId,
      l1ChainId: this.l1ChainId,
      inboxAddress: this.inboxAddress,
      genesisHash: this.genesisHash,
      head: { number: head.number, hash: word(head.hash), timestamp: head.envelope.header.timestamp, outputCount: BigInt(head.leaves.length) },
      finalized: { number: finalized.number, hash: word(finalized.hash), timestamp: finalized.envelope.header.timestamp },
      indexed: { number: indexed.number, hash: word(indexed.hash) },
    });
  }

  #target(target: { pcashNumber: bigint; pcashHash: string }): SimBlock {
    const block = this.block(target.pcashNumber);
    if (word(block.hash) !== target.pcashHash.toLowerCase()) throw new Error("target block is not canonical");
    return block;
  }

  /** A node client serving the simulated chain. Any read outside synchronization's public set throws. */
  client(): PcashNodeClient {
    const record = (method: string, params: unknown) => this.calls.push({ method, params: json(params) });
    const methods = {
      // Polling for the wallet's own submitted transaction; never answered here.
      getReceipt: async (query: unknown) => {
        record("getReceipt", [query]);
        if (!this.servesFundingReads || typeof query !== "object" || query === null || !("contentHash" in query)) return [];
        return this.#receipts(String(query.contentHash));
      },
      getTransaction: async (transactionId: string) => {
        record("getTransaction", [transactionId]);
        if (!this.servesFundingReads) throw new Error("simulated node does not serve getTransaction");
        const row = this.#blocks.flatMap((block) => block.outputs)
          .find((output) => output.kind === "ordinary" && output.transactionId === transactionId);
        if (row?.kind !== "ordinary") return null;
        const entry = this.#entries.get(row.contentHash.toLowerCase());
        return entry === undefined ? null : { summary: { transactionId, contentHash: row.contentHash }, rawTransaction: toHex(entry) };
      },
      getOutputPaths: async (requests: readonly { outputIndex: bigint | number; outputCommitment: bigint }[]) => {
        record("getOutputPaths", [requests]);
        if (!this.servesFundingReads) throw new Error("simulated node does not serve getOutputPaths");
        const head = this.head;
        if (requests.some(({ outputIndex }) => BigInt(outputIndex) >= BigInt(head.leaves.length))) return null;
        return {
          root: word(head.envelope.state.outputRoot),
          count: BigInt(head.leaves.length),
          paths: requests.map(({ outputIndex, outputCommitment: expected }) => {
            const index = BigInt(outputIndex);
            if (head.leaves[Number(index)] !== expected) throw new OutputOpeningMismatchError("batched output path mismatch");
            return { outputIndex: index, siblings: Array.from({ length: MERKLE_DEPTH }, (_, h) => subtreeRoot(head.leaves, h, (index >> BigInt(h)) ^ 1n)) };
          }),
          boundary: head.envelope,
        };
      },
      getMempoolTransaction: async (contentHash: string) => {
        record("getMempoolTransaction", [contentHash]);
        return null;
      },
      status: async () => {
        record("status", []);
        return this.status();
      },
      getBlockHeader: async (number: bigint) => {
        record("getBlockHeader", [number]);
        const block = this.block(BigInt(number));
        return { recentPcashBlockHash: block.hash, boundary: block.envelope };
      },
      getOutputFrontier: async (target: { pcashNumber: bigint; pcashHash: string }) => {
        record("getOutputFrontier", [target]);
        const block = this.#target(target);
        return {
          target: { pcashNumber: block.number, pcashHash: word(block.hash) },
          outputCount: BigInt(block.leaves.length),
          outputRoot: block.envelope.state.outputRoot,
          frontier: frontierOf(block.leaves),
        };
      },
      getOutputs: async (query: {
        fromOutputIndex: bigint;
        target: { pcashNumber: bigint; pcashHash: string };
        continuation?: Record<string, unknown>;
      }) => {
        record("getOutputs", [query]);
        const block = this.#target(query.target);
        const all = this.#blocks.slice(0, Number(block.number) + 1).flatMap((candidate) => candidate.outputs);
        // A request inside a transaction starts at that transaction's first output.
        const requested = all.find((output) => output.outputIndex === query.fromOutputIndex);
        const fromOutputIndex = requested?.kind === "ordinary" ? query.fromOutputIndex - BigInt(requested.outputSlot) : query.fromOutputIndex;
        const from = query.continuation === undefined ? fromOutputIndex : BigInt(query.continuation.next as string);
        const rows = all.filter((output) => output.outputIndex >= from);
        const page: OutputResult[] = [];
        let next = 0;
        while (next < rows.length) {
          const first = rows[next]!;
          let end = next + 1;
          while (first.kind === "ordinary" && end < rows.length && rows[end]!.kind === "ordinary"
            && (rows[end] as typeof first).transactionId === first.transactionId) end++;
          if (page.length + end - next > this.pageSize) {
            if (page.length === 0) throw new Error("invalid derived-index request: limits are too small for one transaction");
            break;
          }
          page.push(...rows.slice(next, end));
          next = end;
        }
        const complete = next === rows.length;
        return {
          fromOutputIndex,
          target: { pcashNumber: block.number, pcashHash: word(block.hash), outputCount: BigInt(block.leaves.length) },
          outputs: page,
          continuation: complete ? null : { next: (page.at(-1)!.outputIndex + 1n).toString() },
          complete,
        };
      },
      getAccountChanges: async (query: {
        fromBlock: bigint;
        target: { pcashNumber: bigint; pcashHash: string };
        continuation?: Record<string, unknown>;
      }) => {
        record("getAccountChanges", [query]);
        const block = this.#target(query.target);
        const rows = this.#blocks.slice(Number(query.fromBlock), Number(block.number) + 1).flatMap((candidate) => candidate.changes);
        const skip = query.continuation === undefined ? 0 : Number(query.continuation.skip);
        const page = rows.slice(skip, skip + this.pageSize);
        const complete = skip + page.length === rows.length;
        return {
          fromBlock: query.fromBlock,
          target: { pcashNumber: block.number, pcashHash: word(block.hash), accountCount: BigInt(block.accounts.length) },
          changes: page,
          continuation: complete ? null : { skip: String(skip + page.length) },
          complete,
        };
      },
    };
    return new Proxy(methods, {
      get: (target, property) => {
        if (property in target) return target[property as keyof typeof target];
        if (property === "then") return undefined;
        return () => { throw new Error(`simulated node does not serve ${String(property)}`); };
      },
    }) as unknown as PcashNodeClient;
  }
}
