// A standard deny list as a holder sees it: the denied set rebuilt from the
// issuer contract's `ListChanged` logs on Ethereum, and the latest
// `Publication`, both read through one Ethereum block. The opening of that
// publication under a proof's anchor comes from a PCASH node during wallet
// sync, so a send makes no request that names its asset.

import type { PublicClient } from "viem";
import { bytesToHex, hexToBytes, numberToHex, pad, type Hex } from "viem";
import { toAddressField } from "@pcash/sdk/crypto";
import type { PcashNodeClient } from "@pcash/sdk/clients";
import type { L1LogGrounding, L1LogInput } from "@pcash/sdk/protocol";
import {
  applyListChanges,
  buildDenyListTree,
  decodeListChangedLog,
  decodePublicationLog,
  LIST_CHANGED_TOPIC0,
  PUBLICATION_TOPIC0,
  type DenyListConfiguration,
  type DenyListPublication,
  type DenyListTree,
} from "@pcash/sdk/rules";

/** An Ethereum log as `eth_getLogs` lists it: `blockLogIndex` is its index within its block. */
export interface L1ListedLog {
  blockNumber: bigint;
  blockHash: Hex;
  transactionHash: Hex;
  transactionIndex: number;
  blockLogIndex: number;
  emitter: bigint;
  topics: readonly Uint8Array[];
  data: Uint8Array;
}

/** One Ethereum log at the coordinates a PCASH log proof names: `logIndex` is its index within its receipt. */
export interface L1EventLog extends L1LogInput {
  blockNumber: bigint;
  transactionIndex: number;
  logIndex: number;
}

/** One Ethereum block by number and lowercase hash. */
export interface L1BlockIdentity {
  number: bigint;
  hash: Hex;
}

export interface L1LogReader {
  /** The newest block the reader serves. */
  head(): Promise<L1BlockIdentity>;
  /** The canonical block at `number`, or null when the reader has no block there. */
  block(number: bigint): Promise<L1BlockIdentity | null>;
  /** Logs of `address` whose topics start with `topics`, in canonical order, in [fromBlock, toBlock]. */
  logs(filter: { address: bigint; topics: readonly Uint8Array[]; fromBlock: bigint; toBlock: bigint }): Promise<L1ListedLog[]>;
  /** The index of the log at `blockLogIndex` within its transaction's receipt. */
  receiptLogIndex(log: Pick<L1ListedLog, "blockHash" | "transactionHash" | "blockLogIndex">): Promise<number>;
}

export interface DenyListState {
  configuration: DenyListConfiguration;
  /** The first Ethereum block the list may have changed in; a rebuild starts here. */
  fromBlock: bigint;
  /** The last Ethereum block whose logs are applied. */
  scannedThrough: bigint;
  /** The hash of block `scannedThrough`, once a sync has read through it. */
  scannedHash?: Hex;
  /** Replaced, never changed in place, by each sync that changes the list. */
  denied: Set<bigint>;
  /** The latest publication and its log, once one exists. */
  latest?: { log: L1ListedLog; publication: DenyListPublication };
  /** The tree of `denied`, rebuilt only after the list changes. */
  tree?: DenyListTree;
}

/** An empty state that scans from `fromBlock`, the block the list was created in or earlier. */
export function emptyDenyListState(configuration: DenyListConfiguration, fromBlock: bigint): DenyListState {
  return { configuration, fromBlock, scannedThrough: fromBlock - 1n, denied: new Set() };
}

/** The list as of one Ethereum block. */
interface DenyListSnapshot {
  scannedThrough: bigint;
  scannedHash: Hex;
  denied: Set<bigint>;
  latest?: { log: L1ListedLog; publication: DenyListPublication };
  tree: DenyListTree;
}

/** Ethereum blocks per `eth_getLogs` call: within the block-range limits of common providers. */
export const L1_LOG_BLOCK_RANGE = 10_000n;

/** `[fromBlock, toBlock]` ranges of at most `L1_LOG_BLOCK_RANGE` blocks covering `fromBlock` through `throughBlock`. */
export function* l1LogRanges(fromBlock: bigint, throughBlock: bigint): Generator<{ fromBlock: bigint; toBlock: bigint }> {
  for (let from = fromBlock; from <= throughBlock; from += L1_LOG_BLOCK_RANGE) {
    const to = from + L1_LOG_BLOCK_RANGE - 1n;
    yield { fromBlock: from, toBlock: to < throughBlock ? to : throughBlock };
  }
}

/** Reads whose target block is replaced while they run are retried up to this many times in all. */
export const L1_SNAPSHOT_ATTEMPTS = 3;

/**
 * Bring `state` to `throughBlock`, or the reader's head if earlier, and return
 * the rebuilt tree, checked against the latest publication's root. `state`
 * changes only when the check passes. A state whose last block is no longer
 * canonical, or is past the target, is rebuilt from `state.fromBlock`.
 */
export async function syncDenyList(reader: L1LogReader, state: DenyListState, throughBlock?: bigint): Promise<DenyListTree> {
  return (await syncSnapshot(reader, state, throughBlock)).tree;
}

async function syncSnapshot(reader: L1LogReader, state: DenyListState, throughBlock?: bigint): Promise<DenyListSnapshot> {
  for (let attempt = 1; ; attempt += 1) {
    const target = (throughBlock === undefined ? null : await reader.block(throughBlock)) ?? await reader.head();
    if (state.scannedHash === target.hash && state.tree !== undefined) {
      return { scannedThrough: state.scannedThrough, scannedHash: state.scannedHash, denied: state.denied,
        ...(state.latest === undefined ? {} : { latest: state.latest }), tree: state.tree };
    }
    const resumes = state.scannedHash !== undefined && state.scannedThrough <= target.number
      && (await reader.block(state.scannedThrough))?.hash === state.scannedHash;
    const next = await readThrough(reader, resumes ? state : emptyDenyListState(state.configuration, state.fromBlock), target);
    // Logs are read by block number; the target's unchanged hash shows they all came from its chain.
    if ((await reader.block(target.number))?.hash !== target.hash) {
      if (attempt < L1_SNAPSHOT_ATTEMPTS) continue;
      throw new Error("Ethereum reorganized while the deny list was read; try again");
    }
    if (next.latest !== undefined && next.tree.root !== next.latest.publication.root) {
      throw new Error("the deny list rebuilt from Ethereum does not match its published root");
    }
    state.scannedThrough = next.scannedThrough;
    state.scannedHash = next.scannedHash;
    state.denied = next.denied;
    state.tree = next.tree;
    if (next.latest === undefined) delete state.latest;
    else state.latest = next.latest;
    return next;
  }
}

/** `base` with every log after `base.scannedThrough` through `target` applied; `base` is not changed. */
async function readThrough(reader: L1LogReader, base: DenyListState, target: L1BlockIdentity): Promise<DenyListSnapshot> {
  const address = toAddressField(base.configuration.contractAddress, "contractAddress");
  let { denied, latest, tree } = base;
  const start = base.scannedThrough + 1n > base.fromBlock ? base.scannedThrough + 1n : base.fromBlock;
  for (const range of l1LogRanges(start, target.number)) {
    const [changes, publications] = await Promise.all([
      reader.logs({ address, topics: [LIST_CHANGED_TOPIC0, base.configuration.listId], ...range }),
      reader.logs({ address, topics: [PUBLICATION_TOPIC0, base.configuration.listId], ...range }),
    ]);
    if (changes.length > 0) {
      if (denied === base.denied) denied = new Set(denied);
      for (const log of changes) applyListChanges(denied, decodeListChangedLog(log));
      tree = undefined;
    }
    const last = publications.at(-1);
    if (last !== undefined) latest = { log: last, publication: decodePublicationLog(last) };
  }
  return {
    scannedThrough: target.number, scannedHash: target.hash, denied,
    ...(latest === undefined ? {} : { latest }), tree: tree ?? buildDenyListTree(denied),
  };
}

type RpcBlock = { number: Hex | null; hash: Hex | null } | null;

/**
 * An `L1LogReader` over a viem public client. Listing logs makes one
 * `eth_getLogs` call per range; a log's receipt is read only when its
 * receipt-local index is asked for.
 */
export function viemL1LogReader(client: PublicClient): L1LogReader {
  const identity = (block: RpcBlock): L1BlockIdentity | null => {
    if (block === null) return null;
    if (block.number === null || block.hash === null) throw new Error("the Ethereum endpoint returned a pending block");
    return { number: BigInt(block.number), hash: block.hash.toLowerCase() as Hex };
  };
  const blockAt = async (tag: Hex | "latest") =>
    identity(await client.request({ method: "eth_getBlockByNumber", params: [tag, false] }) as RpcBlock);
  return {
    async head() {
      const head = await blockAt("latest");
      if (head === null) throw new Error("the Ethereum endpoint returned no latest block");
      return head;
    },
    block: (number) => blockAt(numberToHex(number)),
    async logs({ address, topics, fromBlock, toBlock }) {
      const raw = await client.request({
        method: "eth_getLogs",
        params: [{
          address: pad(numberToHex(address), { size: 20 }),
          topics: topics.map((topic) => bytesToHex(topic)),
          fromBlock: numberToHex(fromBlock),
          toBlock: numberToHex(toBlock),
        }],
      }) as { blockNumber: Hex; blockHash: Hex; transactionHash: Hex; transactionIndex: Hex; logIndex: Hex; address: Hex; topics: Hex[]; data: Hex }[];
      return raw.map((log) => ({
        blockNumber: BigInt(log.blockNumber),
        blockHash: log.blockHash.toLowerCase() as Hex,
        transactionHash: log.transactionHash,
        transactionIndex: Number(BigInt(log.transactionIndex)),
        blockLogIndex: Number(BigInt(log.logIndex)),
        emitter: BigInt(log.address),
        topics: log.topics.map((topic) => hexToBytes(topic)),
        data: hexToBytes(log.data),
      }));
    },
    async receiptLogIndex(log) {
      const receipt = await client.getTransactionReceipt({ hash: log.transactionHash });
      if (receipt.blockHash.toLowerCase() !== log.blockHash) {
        throw new Error("the log's block is no longer canonical on Ethereum; try again");
      }
      const index = receipt.logs.findIndex((item) => item.logIndex === log.blockLogIndex);
      if (index < 0) throw new Error("the transaction's receipt does not hold the listed log");
      return index;
    },
  };
}

/** The newest publication a proof anchored at one PCASH block can open, with the list it publishes. */
export interface AnchoredPublication {
  anchorHash: bigint;
  entry: { log: L1EventLog; publication: DenyListPublication };
  /** The denied set as of `entry`, whose root it publishes. */
  tree: DenyListTree;
  opening: L1LogGrounding;
}

function listKey(configuration: DenyListConfiguration): string {
  return `${toAddressField(configuration.contractAddress, "contractAddress").toString(16)}:${bytesToHex(configuration.listId)}`;
}

/** Openings kept per list, so a send planned at a recent earlier anchor still finds its own. */
const OPENINGS_KEPT = 8;

/** Deny lists this wallet tracks, keyed by contract and list ID. */
export class DenyLists {
  readonly #reader: L1LogReader;
  readonly #fromBlock: bigint;
  readonly #states = new Map<string, DenyListState>();
  /** Per list, the opening fetched or being fetched at each recent anchor, oldest first. */
  readonly #openings = new Map<string, Map<bigint, Promise<AnchoredPublication | null>>>();
  /** Receipt-local log indices, keyed by block hash and block-wide log index. */
  readonly #receiptLogIndices = new Map<string, number>();

  /** `fromBlock` is the first Ethereum block a tracked list may have changed in, such as the network's genesis L1 block. */
  constructor(reader: L1LogReader, fromBlock: bigint) {
    this.#reader = reader;
    this.#fromBlock = fromBlock;
  }

  /** Bring one list up to `throughBlock`, or the reader's head, and return the list as of that block. */
  async sync(configuration: DenyListConfiguration, throughBlock?: bigint): Promise<{
    latest?: { log: L1ListedLog; publication: DenyListPublication };
    tree: DenyListTree;
  }> {
    const key = listKey(configuration);
    let state = this.#states.get(key);
    if (state === undefined) {
      state = emptyDenyListState(configuration, this.#fromBlock);
      this.#states.set(key, state);
    }
    return syncSnapshot(this.#reader, state, throughBlock);
  }

  /**
   * The newest publication of `configuration` a proof anchored at `anchor`
   * can open, with its opening from `node`, or null before the list's first
   * publication. `genesisL1Block` maps PCASH block numbers to the Ethereum
   * blocks their L1 origin trees hold.
   */
  async anchored(
    node: Pick<PcashNodeClient, "getL1LogProof">,
    configuration: DenyListConfiguration,
    anchor: { blockHash: bigint; number: bigint },
    genesisL1Block: bigint,
  ): Promise<AnchoredPublication | null> {
    const { latest, tree } = await this.sync(configuration, genesisL1Block + anchor.number);
    if (latest === undefined) return null;
    const log = await this.#located(latest.log);
    const proof = await node.getL1LogProof(anchor.blockHash, log.blockNumber, log.transactionIndex, log.logIndex, log);
    return {
      anchorHash: anchor.blockHash, entry: { log, publication: latest.publication }, tree,
      opening: { ...proof, logsRoot: proof.l1LogsRoot, logCount: proof.l1LogCount },
    };
  }

  async #located(listed: L1ListedLog): Promise<L1EventLog> {
    const key = `${listed.blockHash}:${listed.blockLogIndex}`;
    let logIndex = this.#receiptLogIndices.get(key);
    if (logIndex === undefined) {
      logIndex = await this.#reader.receiptLogIndex(listed);
      this.#receiptLogIndices.set(key, logIndex);
    }
    return {
      blockNumber: listed.blockNumber, transactionIndex: listed.transactionIndex, logIndex,
      emitter: listed.emitter, topics: listed.topics, data: listed.data,
    };
  }

  /**
   * Fetch `anchored` for each list at `anchor`, keeping the last few anchors'
   * openings. Wallet sync calls this whenever its anchor moves; a send then
   * reads only `prefetched`. A failed fetch is forgotten, so the next prefetch
   * at the same anchor requests it again; this rejects with the first failure.
   */
  async prefetch(
    node: Pick<PcashNodeClient, "getL1LogProof">,
    configurations: readonly DenyListConfiguration[],
    anchor: { blockHash: bigint; number: bigint },
    genesisL1Block: bigint,
  ): Promise<void> {
    const results = await Promise.allSettled(configurations.map((configuration) => {
      const key = listKey(configuration);
      let openings = this.#openings.get(key);
      if (openings === undefined) {
        openings = new Map();
        this.#openings.set(key, openings);
      }
      const existing = openings.get(anchor.blockHash);
      if (existing !== undefined) return existing;
      const result = this.anchored(node, configuration, anchor, genesisL1Block);
      openings.set(anchor.blockHash, result);
      for (const old of openings.keys()) {
        if (openings.size <= OPENINGS_KEPT) break;
        openings.delete(old);
      }
      const kept = openings;
      result.catch(() => {
        if (kept.get(anchor.blockHash) === result) kept.delete(anchor.blockHash);
      });
      return result;
    }));
    const failure = results.find((result) => result.status === "rejected");
    if (failure !== undefined) throw failure.reason;
  }

  /**
   * What `prefetch` fetched for `configuration` at `anchorHash`, waiting for a
   * fetch still in flight; undefined when it fetched nothing there or failed.
   * Makes no request of its own.
   */
  async prefetched(configuration: DenyListConfiguration, anchorHash: bigint): Promise<AnchoredPublication | null | undefined> {
    const result = this.#openings.get(listKey(configuration))?.get(anchorHash);
    return result === undefined ? undefined : result.catch(() => undefined);
  }
}
