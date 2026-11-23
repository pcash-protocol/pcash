import { describe, expect, it } from "vitest";
import { encodeAbiParameters, type Address, type Hex } from "viem";
import { buildDenyListTree, LIST_CHANGED_TOPIC0, PUBLICATION_TOPIC0, type DenyListConfiguration } from "../src/rules/senderDenyList.ts";
import { DenyLists, emptyDenyListState, syncDenyList, type L1ListedLog, type L1LogReader } from "../src/wallet/denyListSync.ts";
import { fromHex } from "../src/utils/hex.ts";

const CONTRACT = 0x5fbdb2315678afecb367f032d93f642f64180aa3n;
const LIST_ID = new Uint8Array(32).fill(9);
const CONFIGURATION: DenyListConfiguration = { contractAddress: CONTRACT, listId: LIST_ID, maxDelta: 7_200n };
const address = (value: bigint) => `0x${value.toString(16).padStart(40, "0")}` as Address;
/** The hash of block `number` on fork `fork`. */
const hashOf = (number: bigint, fork = 0) => `0x${fork.toString(16).padStart(2, "0")}${number.toString(16).padStart(62, "0")}` as Hex;

function changed(blockNumber: bigint, added: bigint[], removed: bigint[] = [], fork = 0): L1ListedLog {
  return {
    blockNumber, blockHash: hashOf(blockNumber, fork), transactionHash: hashOf(blockNumber, 0xff), transactionIndex: 0, blockLogIndex: 4,
    emitter: CONTRACT, topics: [LIST_CHANGED_TOPIC0, LIST_ID],
    data: fromHex(encodeAbiParameters([{ type: "address[]" }, { type: "address[]" }], [added.map(address), removed.map(address)])),
  };
}

function published(blockNumber: bigint, denied: bigint[], paused = false, fork = 0): L1ListedLog {
  return {
    blockNumber, blockHash: hashOf(blockNumber, fork), transactionHash: hashOf(blockNumber, 0xff), transactionIndex: 0, blockLogIndex: 5,
    emitter: CONTRACT, topics: [PUBLICATION_TOPIC0, LIST_ID],
    data: fromHex(encodeAbiParameters([{ type: "uint256" }, { type: "bool" }, { type: "uint64" }], [buildDenyListTree(denied).root, paused, 3600n])),
  };
}

/**
 * An Ethereum log reader over a chain whose blocks from `forkFrom` carry fork
 * `fork`'s hashes. Its receipts put each log one place after its block index,
 * less the four logs earlier transactions in the block emitted.
 */
function reader(initial: L1ListedLog[], tip: bigint) {
  const chain = {
    entries: initial, tip, fork: 0, forkFrom: 0n,
    logReads: 0,
    receiptReads: [] as Hex[],
    /** Runs once, inside the next log read. */
    duringNextLogRead: undefined as (() => void) | undefined,
    reorg(fromBlock: bigint, logs: L1ListedLog[]) {
      chain.fork += 1;
      chain.forkFrom = fromBlock;
      chain.entries = [...chain.entries.filter((log) => log.blockNumber < fromBlock), ...logs];
    },
  };
  const hashAt = (number: bigint) => hashOf(number, number >= chain.forkFrom ? chain.fork : 0);
  const source: L1LogReader = {
    head: async () => ({ number: chain.tip, hash: hashAt(chain.tip) }),
    block: async (number) => number > chain.tip ? null : { number, hash: hashAt(number) },
    async logs({ topics, fromBlock, toBlock }) {
      chain.logReads += 1;
      const hook = chain.duringNextLogRead;
      chain.duringNextLogRead = undefined;
      hook?.();
      return chain.entries.filter((log) => log.topics[0]!.every((byte, index) => byte === topics[0]![index])
        && log.blockNumber >= fromBlock && log.blockNumber <= toBlock);
    },
    async receiptLogIndex(log) {
      chain.receiptReads.push(log.blockHash);
      return log.blockLogIndex - 4;
    },
  };
  return Object.assign(chain, source);
}

const LOGS = [
  changed(10n, [0xaan]), published(10n, [0xaan]),
  changed(20n, [0xbbn]), published(20n, [0xaan, 0xbbn]),
  changed(30n, [], [0xaan]), published(30n, [0xbbn], true),
];

/** A node that answers log proofs, recording the Ethereum block of each request. */
function proofNode(fail: () => boolean = () => false) {
  const requests: bigint[] = [];
  return {
    requests,
    async getL1LogProof(anchorHash: bigint, l1Block: bigint, _transactionIndex: bigint | number, logIndex: bigint | number) {
      requests.push(l1Block);
      if (fail()) throw new Error("node unavailable");
      return { l1LogsRoot: 1n, l1LogCount: 2, l1BlockTimestamp: (1_000n + l1Block).toString(), anchorHash, logIndex } as never;
    },
  };
}

describe("deny list sync", () => {
  it("rebuilds the list through a block and keeps its tree until the list changes", async () => {
    const source = reader(LOGS, 40n);
    const state = emptyDenyListState(CONFIGURATION, 1n);
    const first = await syncDenyList(source, state, 25n);
    expect([...state.denied]).toEqual([0xaan, 0xbbn]);
    expect(state.latest?.log.blockNumber).toBe(20n);
    expect(state.scannedThrough).toBe(25n);
    expect(state.scannedHash).toBe(hashOf(25n));
    const reads = source.logReads;
    expect(await syncDenyList(source, state, 25n)).toBe(first);
    expect(source.logReads).toBe(reads);
    const later = await syncDenyList(source, state);
    expect(later).not.toBe(first);
    expect([...state.denied]).toEqual([0xbbn]);
    expect(state.latest?.publication.paused).toBe(true);
    expect(source.receiptReads).toEqual([]);
  });

  it("refuses a list whose rebuilt root differs from its publication and keeps the previous state", async () => {
    const source = reader(LOGS.slice(0, 4), 25n);
    const state = emptyDenyListState(CONFIGURATION, 1n);
    const tree = await syncDenyList(source, state);
    const before = { denied: state.denied, latest: state.latest, scannedThrough: state.scannedThrough, scannedHash: state.scannedHash };
    source.entries.push(changed(30n, [0xccn]), published(30n, [0xddn]));
    source.tip = 35n;
    await expect(syncDenyList(source, state)).rejects.toThrow("does not match its published root");
    expect(state).toMatchObject(before);
    expect(state.tree).toBe(tree);
    expect([...state.denied]).toEqual([0xaan, 0xbbn]);
  });

  it("rebuilds from the start after a reorganization at the same height", async () => {
    const source = reader(LOGS.slice(0, 4), 25n);
    const state = emptyDenyListState(CONFIGURATION, 1n);
    await syncDenyList(source, state);
    expect([...state.denied]).toEqual([0xaan, 0xbbn]);
    // Block 20's change is orphaned; the replacement chain removes 0xaa at block 22 and is still at height 25.
    source.reorg(20n, [changed(22n, [], [0xaan], 1), published(22n, [], false, 1)]);
    await syncDenyList(source, state);
    expect([...state.denied]).toEqual([]);
    expect(state.latest?.log.blockNumber).toBe(22n);
    expect(state.scannedHash).toBe(hashOf(25n, 1));
  });

  it("reads again when the target block is replaced while its logs are read", async () => {
    const source = reader(LOGS.slice(0, 4), 25n);
    const state = emptyDenyListState(CONFIGURATION, 1n);
    source.duringNextLogRead = () => source.reorg(20n, [changed(21n, [0xeen], [], 1), published(21n, [0xaan, 0xeen], false, 1)]);
    await syncDenyList(source, state);
    expect([...state.denied]).toEqual([0xaan, 0xeen]);
    expect(state.scannedHash).toBe(hashOf(25n, 1));
  });

  it("opens the publication an anchor holds with the tree it publishes, fetched once per anchor", async () => {
    const lists = new DenyLists(reader(LOGS, 40n), 1n);
    const node = proofNode();
    // Genesis L1 block 0: PCASH block n holds Ethereum blocks through n.
    const atBlock25 = { blockHash: 0x25n, number: 25n };
    await lists.prefetch(node, [CONFIGURATION], atBlock25, 0n);
    await lists.prefetch(node, [CONFIGURATION], atBlock25, 0n);
    expect(node.requests).toEqual([20n]);
    const anchored = await lists.prefetched(CONFIGURATION, 0x25n);
    expect(anchored?.entry.log.blockNumber).toBe(20n);
    expect(anchored?.entry.log.logIndex).toBe(1);
    expect(anchored?.tree.root).toBe(buildDenyListTree([0xaan, 0xbbn]).root);
    expect(await lists.prefetched(CONFIGURATION, 0x26n)).toBeUndefined();

    // A later anchor sees the paused publication; an earlier one reads the list again from its start.
    expect((await lists.anchored(node, CONFIGURATION, { blockHash: 0x40n, number: 40n }, 0n))?.entry.publication.paused).toBe(true);
    const early = await lists.anchored(node, CONFIGURATION, { blockHash: 0x15n, number: 15n }, 0n);
    expect(early?.entry.log.blockNumber).toBe(10n);
    expect(early?.tree.isDenied(0xbbn)).toBe(false);
    expect(await lists.anchored(node, CONFIGURATION, { blockHash: 0x5n, number: 5n }, 0n)).toBeNull();
  });

  it("reads a receipt only for the publication a proof opens, once per log", async () => {
    const source = reader(LOGS, 40n);
    const lists = new DenyLists(source, 1n);
    const node = proofNode();
    await lists.prefetch(node, [CONFIGURATION], { blockHash: 0x40n, number: 40n }, 0n);
    await lists.prefetch(node, [CONFIGURATION], { blockHash: 0x41n, number: 41n }, 0n);
    expect(source.receiptReads).toEqual([hashOf(30n)]);
    expect(node.requests).toEqual([30n, 30n]);
  });

  it("forgets a failed prefetch, so the next sync at that anchor requests it again", async () => {
    const lists = new DenyLists(reader(LOGS, 40n), 1n);
    let failing = true;
    const node = proofNode(() => failing);
    const anchor = { blockHash: 0x25n, number: 25n };
    await expect(lists.prefetch(node, [CONFIGURATION], anchor, 0n)).rejects.toThrow("node unavailable");
    expect(await lists.prefetched(CONFIGURATION, 0x25n)).toBeUndefined();
    failing = false;
    await lists.prefetch(node, [CONFIGURATION], anchor, 0n);
    expect(node.requests).toEqual([20n, 20n]);
    expect((await lists.prefetched(CONFIGURATION, 0x25n))?.entry.log.blockNumber).toBe(20n);
  });

  it("keeps the last eight anchors' openings and waits for one in flight", async () => {
    const lists = new DenyLists(reader(LOGS, 40n), 1n);
    const node = proofNode();
    for (let number = 31n; number <= 39n; number += 1n) {
      await lists.prefetch(node, [CONFIGURATION], { blockHash: number, number }, 0n);
    }
    expect(await lists.prefetched(CONFIGURATION, 31n)).toBeUndefined();
    for (let number = 32n; number <= 39n; number += 1n) {
      expect((await lists.prefetched(CONFIGURATION, number))?.anchorHash).toBe(number);
    }

    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const slow = { async getL1LogProof(...args: Parameters<typeof node.getL1LogProof>) { await gate; return node.getL1LogProof(...args); } };
    const fetching = lists.prefetch(slow, [CONFIGURATION], { blockHash: 40n, number: 40n }, 0n);
    const waiting = lists.prefetched(CONFIGURATION, 40n);
    const requests = node.requests.length;
    release();
    expect((await waiting)?.anchorHash).toBe(40n);
    await fetching;
    expect(node.requests.length).toBe(requests + 1);
  });
});
