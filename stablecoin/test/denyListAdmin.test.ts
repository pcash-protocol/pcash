import { describe, expect, it, vi } from "vitest";
import {
  bytesToHex,
  createWalletClient,
  custom,
  encodeAbiParameters,
  hexToBytes,
  keccak256,
  numberToHex,
  pad,
  parseTransaction,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { buildDenyListTree, LIST_CHANGED_TOPIC0, PUBLICATION_TOPIC0 } from "@pcash/sdk/rules";
import { DenyListAdmin } from "../src/denyListAdmin.ts";
import { EthereumWriter } from "../src/ethereumWriter.ts";
import { DENY_LIST_ABI } from "../src/contracts.ts";
import { memoryIssuerStateStore, stablecoinDefinition, StablecoinIssuer } from "../src/issuer.ts";

const CONTRACT = "0x5fbdb2315678afecb367f032d93f642f64180aa3";
const LIST_ID = pad("0x09", { size: 32 });
const VAULT = "0x00000000000000000000000000000000000000c1";

const blockHash = (number: bigint) => numberToHex(0xb10c0000n + number, { size: 32 });

interface Log { blockNumber: Hex; blockHash: Hex; transactionHash: Hex; transactionIndex: Hex; logIndex: Hex; address: Hex; topics: Hex[]; data: Hex }
type LogBase = Omit<Log, "logIndex" | "topics" | "data">;

/**
 * The DenyList contract's update, heartbeat, publication and logs, and a vault
 * that accepts any issuer write, sent from one account: one transaction per
 * block, twelve seconds apart unless mined later.
 */
function fakeDenyList() {
  const chain = {
    head: 10n,
    root: buildDenyListTree([]).root,
    paused: false,
    timestamps: new Map<bigint, bigint>(),
    logs: [] as Log[],
    writes: [] as { expectedRoot: bigint; newRoot: bigint }[],
    heartbeats: 0,
    sent: 0,
    /** Every send and receipt wait's return, in order, by function name. */
    events: [] as string[],
    functionOf: new Map<Hex, string>(),
    /** Receipt waits started while held return once released. */
    receiptGate: Promise.resolve(),
    holdReceipts(): () => void {
      let release!: () => void;
      chain.receiptGate = new Promise((resolve) => { release = resolve; });
      return () => {
        chain.receiptGate = Promise.resolve();
        release();
      };
    },
    blockReads: 0,
    /** The next write is replaced at its nonce by another transaction from the account. */
    replaceNext: false,
    replacedBy: new Map<Hex, Hex>(),
    /** Writes of these functions mine and revert, once each. */
    revertNext: new Set<string>(),
    reverted: new Set<Hex>(),
    /** Runs before each update applies, as another writer's transaction mined first would. */
    beforeUpdate: () => {},
    timestamp(number: bigint): bigint { return chain.timestamps.get(number) ?? 12n * number; },
    /** An empty block `seconds` after the head. */
    mine(seconds: bigint): void {
      const time = chain.timestamp(chain.head) + seconds;
      chain.head += 1n;
      chain.timestamps.set(chain.head, time);
    },
    block(): LogBase {
      chain.mine(12n);
      const transactionHash = numberToHex(chain.head, { size: 32 });
      return { blockNumber: numberToHex(chain.head), blockHash: blockHash(chain.head), transactionHash, transactionIndex: "0x0" as Hex, address: CONTRACT as Hex };
    },
    publication(base: LogBase, logIndex: Hex): Log {
      return { ...base, logIndex, topics: [bytesToHex(PUBLICATION_TOPIC0), LIST_ID], data: encodeAbiParameters([{ type: "uint256" }, { type: "bool" }, { type: "uint64" }], [chain.root, chain.paused, 3600n]) };
    },
    update(added: Address[], removed: Address[], expectedRoot: bigint, newRoot: bigint): Hex {
      chain.writes.push({ expectedRoot, newRoot });
      if (expectedRoot !== chain.root) throw new Error("execution reverted: StaleRoot");
      chain.root = newRoot;
      const base = chain.block();
      chain.logs.push(
        { ...base, logIndex: "0x0", topics: [bytesToHex(LIST_CHANGED_TOPIC0), LIST_ID], data: encodeAbiParameters([{ type: "address[]" }, { type: "address[]" }], [added, removed]) },
        chain.publication(base, "0x1"),
      );
      return base.transactionHash;
    },
    heartbeat(): Hex {
      if (chain.paused) throw new Error("execution reverted: ListPaused");
      chain.heartbeats += 1;
      const base = chain.block();
      chain.logs.push(chain.publication(base, "0x0"));
      return base.transactionHash;
    },
  };
  const publicClient = {
    getBlockNumber: async () => chain.head,
    getBlock: async ({ blockNumber }: { blockNumber: bigint }) => {
      chain.blockReads += 1;
      return { number: blockNumber, timestamp: chain.timestamp(blockNumber) };
    },
    request: async ({ method, params }: { method: string; params: unknown[] }) => {
      if (method === "eth_getBlockByNumber") {
        const number = params[0] === "latest" ? chain.head : BigInt(params[0] as Hex);
        return number > chain.head ? null : { number: numberToHex(number), hash: blockHash(number) };
      }
      if (method !== "eth_getLogs") throw new Error(`unexpected request ${method}`);
      const filter = params[0] as { topics: Hex[]; fromBlock: Hex; toBlock: Hex };
      return chain.logs.filter((log) => log.topics[0] === filter.topics[0] && log.topics[1] === filter.topics[1]
        && BigInt(log.blockNumber) >= BigInt(filter.fromBlock) && BigInt(log.blockNumber) <= BigInt(filter.toBlock));
    },
    waitForTransactionReceipt: async ({ hash }: { hash: Hex }) => {
      await chain.receiptGate;
      chain.events.push(`receipt ${chain.functionOf.get(hash)}`);
      return { status: chain.reverted.has(hash) ? "reverted" : "success", transactionHash: chain.replacedBy.get(hash) ?? hash, blockNumber: chain.head };
    },
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName !== "lists") throw new Error(`unexpected read ${functionName}`);
      return ["0x00000000000000000000000000000000000000e1", 3600n, false, chain.root];
    },
  } as unknown as PublicClient;
  const send = (address: Address, functionName: string, args: [Hex, Address[], Address[], bigint, bigint]): Hex => {
    if (functionName === "update") chain.sent += 1;
    if (chain.replaceNext) {
      chain.replaceNext = false;
      const replacement = chain.block().transactionHash;
      const hash = numberToHex(0xdead0000n + chain.head, { size: 32 });
      chain.replacedBy.set(hash, replacement);
      return hash;
    }
    if (chain.revertNext.delete(functionName)) {
      const hash = chain.block().transactionHash;
      chain.reverted.add(hash);
      return hash;
    }
    if (address.toLowerCase() === VAULT) return chain.block().transactionHash;
    if (functionName === "heartbeat") return chain.heartbeat();
    if (functionName !== "update") throw new Error(`unexpected write ${functionName}`);
    chain.beforeUpdate();
    return chain.update(args[1], args[2], args[3], args[4]);
  };
  const walletClient = {
    account: { address: "0x00000000000000000000000000000000000000e1" },
    chain: undefined,
    async writeContract({ address, functionName, args }: { address: Address; functionName: string; args: [Hex, Address[], Address[], bigint, bigint] }) {
      const hash = send(address, functionName, args);
      chain.functionOf.set(hash, functionName);
      chain.events.push(`send ${functionName}`);
      return hash;
    },
  } as unknown as WalletClient;
  const writer = () => new EthereumWriter({ publicClient, walletClient });
  const admin = (sharedWriter = writer()) => new DenyListAdmin({
    publicClient, writer: sharedWriter, contract: CONTRACT, listId: LIST_ID, fromBlock: 1n, maxDelta: 7_200n,
  });
  const issuer = (sharedWriter: EthereumWriter) => new StablecoinIssuer({
    wallet: {} as never, node: {} as never,
    definition: stablecoinDefinition({
      metadata: { name: "Private USD", symbol: "pUSD", decimals: 6, contentDigest: new Uint8Array(32) }, vault: VAULT,
      denyList: { contractAddress: BigInt(CONTRACT), listId: hexToBytes(LIST_ID), maxDelta: 7_200n }, startSalt: 0n,
    }),
    ethereum: { publicClient, writer: sharedWriter }, store: memoryIssuerStateStore(),
  });
  return { chain, writer, admin, issuer };
}

const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;

describe("deny list admin", () => {
  it("names the root a change is computed from, and recomputes once when another writer got there first", async () => {
    const { chain, admin } = fakeDenyList();
    const ours = admin();
    await ours.freeze([address(0xa1)]);
    // Another writer's change, computed from the same root, mines first.
    chain.beforeUpdate = () => {
      chain.beforeUpdate = () => {};
      chain.update([address(0xb1)], [], chain.root, buildDenyListTree([0xa1n, 0xb1n]).root);
    };
    await ours.freeze([address(0xa2)]);
    expect(chain.writes.map((write) => write.expectedRoot === buildDenyListTree([0xa1n]).root)).toEqual([false, true, true, false]);
    expect(chain.root).toBe(buildDenyListTree([0xa1n, 0xa2n, 0xb1n]).root);
    expect(await admin().denied()).toEqual([0xa1n, 0xa2n, 0xb1n]);
  });

  it("does not retry a failure that left the root unchanged", async () => {
    const { chain, admin } = fakeDenyList();
    chain.beforeUpdate = () => { throw new Error("nonce too low"); };
    await expect(admin().freeze([address(0xa1)])).rejects.toThrow("nonce too low");
    expect(chain.sent).toBe(1);
  });

  it("runs one admin's changes one at a time, each from the root the last one published", async () => {
    const { chain, admin } = fakeDenyList();
    const ours = admin();
    await Promise.all([ours.freeze([address(0xa1)]), ours.freeze([address(0xa2)]), ours.unfreeze([address(0xa1)])]);
    expect(chain.writes).toHaveLength(3);
    expect(await ours.denied()).toEqual([0xa2n]);
  });

  it("does not report a freeze replaced at its nonce as done", async () => {
    const { chain, admin } = fakeDenyList();
    const ours = admin();
    chain.replaceNext = true;
    await expect(ours.freeze([address(0xa1)])).rejects.toThrow(/^update transaction 0x[0-9a-f]{64} was replaced by 0x[0-9a-f]{64}; the write is not done$/);
    // The list is unchanged, so the admin does not recompute and send again.
    expect(chain.sent).toBe(1);
    expect(await ours.denied()).toEqual([]);
  });

  it("rejects a reverted write", async () => {
    const { chain, admin } = fakeDenyList();
    chain.revertNext.add("heartbeat");
    await expect(admin().heartbeat()).rejects.toThrow(/^heartbeat transaction 0x[0-9a-f]{64} reverted$/);
    expect(chain.heartbeats).toBe(0);
  });
});

describe("one key for the vault and the deny list", () => {
  /** Each send is followed by its own receipt before the next send. */
  const expectOneAtATime = (events: string[]) => {
    for (let index = 0; index < events.length; index += 2) {
      expect([events[index], events[index + 1]]).toEqual([events[index], events[index]!.replace("send", "receipt")]);
      expect(events[index]).toMatch(/^send /);
    }
  };

  it("sends the issuer's and the admin's writes through one writer, each only after the last one's receipt", async () => {
    const { chain, writer, admin, issuer } = fakeDenyList();
    const shared = writer();
    const ours = admin(shared);
    const vault = issuer(shared);
    const release = chain.holdReceipts();
    const writes = Promise.all([vault.allow(address(0xa1), true), ours.heartbeat(), ours.freeze([address(0xb1)]), vault.setDepositCap(5n)]);
    await vi.waitFor(() => expect(chain.events).toEqual(["send setAllowed"]));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(chain.events).toEqual(["send setAllowed"]);
    release();
    await writes;
    expect(chain.events).toHaveLength(8);
    expectOneAtATime(chain.events);
    expect(chain.events.filter((event) => event.startsWith("send")).sort()).toEqual(["send heartbeat", "send setAllowed", "send setDepositCap", "send update"]);
    expect(await ours.denied()).toEqual([0xb1n]);
  });

  it("holds a due timed heartbeat until a vault write's receipt", async () => {
    const { chain, writer, admin, issuer } = fakeDenyList();
    const shared = writer();
    const ours = admin(shared);
    const vault = issuer(shared);
    await ours.freeze([address(0xa1)]);
    chain.mine(900n);
    const release = chain.holdReceipts();
    const capped = vault.setDepositCap(5n);
    await vi.waitFor(() => expect(chain.events.at(-1)).toBe("send setDepositCap"));
    const errors: unknown[] = [];
    const heartbeat = ours.startHeartbeat({ intervalSeconds: 900n, checkEveryMs: 5, onError: (error) => errors.push(error) });
    // The check has read the publication's age and found it due.
    await vi.waitFor(() => expect(chain.blockReads).toBe(2));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(chain.events.at(-1)).toBe("send setDepositCap");
    release();
    await capped;
    await vi.waitFor(() => expect(chain.heartbeats).toBe(1));
    await heartbeat.stop();
    expect(chain.events).toEqual(["send update", "receipt update", "send setDepositCap", "receipt setDepositCap", "send heartbeat", "receipt heartbeat"]);
    expect(errors).toEqual([]);
  });
});

describe("writer nonces", () => {
  it("takes each nonce from the endpoint, so a retry of a dropped write fills its nonce", async () => {
    const sent: Hex[] = [];
    const request = async ({ method, params }: { method: string; params?: unknown }) => {
      switch (method) {
        case "eth_chainId": return "0x1";
        // The account sent five transactions before, and the first write was dropped from the mempool.
        case "eth_getTransactionCount": return "0x5";
        case "eth_estimateGas": return "0x5208";
        case "eth_maxPriorityFeePerGas": return "0x1";
        case "eth_getBlockByNumber": return { number: "0x1", baseFeePerGas: "0x1", hash: blockHash(1n), timestamp: "0x0", transactions: [] };
        case "eth_sendRawTransaction": {
          const [raw] = params as [Hex];
          sent.push(raw);
          return keccak256(raw);
        }
        default: throw new Error(`unexpected request ${method}`);
      }
    };
    const walletClient = createWalletClient({ account: privateKeyToAccount(generatePrivateKey()), transport: custom({ request }) });
    const writer = new EthereumWriter({ publicClient: {} as PublicClient, walletClient: walletClient as WalletClient });
    const heartbeat = { address: CONTRACT as Address, abi: DENY_LIST_ABI, functionName: "heartbeat", args: [LIST_ID] } as const;
    await writer.send(heartbeat);
    await writer.send(heartbeat);
    expect(sent.map((raw) => parseTransaction(raw).nonce)).toEqual([5, 5]);
  });
});

describe("timed heartbeat", () => {
  it("publishes again only once the latest publication is the interval old by Ethereum time, and never while paused", async () => {
    const { chain, admin } = fakeDenyList();
    const ours = admin();
    await ours.freeze([address(0xa1)]);
    chain.mine(899n);
    expect(await ours.heartbeatIfDue(900n)).toBeUndefined();
    chain.mine(1n);
    expect(await ours.heartbeatIfDue(900n)).toBe(numberToHex(chain.head, { size: 32 }));
    expect(chain.heartbeats).toBe(1);
    // The heartbeat is the latest publication now.
    expect(await ours.heartbeatIfDue(900n)).toBeUndefined();
    chain.paused = true;
    chain.update([], [], chain.root, chain.root);
    chain.mine(3_600n);
    expect(await ours.heartbeatIfDue(900n)).toBeUndefined();
    expect(chain.heartbeats).toBe(1);
  });

  it("checks on its timer, reports a failed check and keeps checking, and stops", async () => {
    const { chain, admin } = fakeDenyList();
    const ours = admin();
    await ours.freeze([address(0xa1)]);
    chain.mine(900n);
    const errors: unknown[] = [];
    let failNext = true;
    const original = ours.heartbeatIfDue.bind(ours);
    const spy = vi.spyOn(ours, "heartbeatIfDue").mockImplementation(async (interval) => {
      if (failNext) {
        failNext = false;
        throw new Error("rpc down");
      }
      return original(interval);
    });
    const heartbeat = ours.startHeartbeat({ intervalSeconds: 900n, checkEveryMs: 5, onError: (error) => errors.push(error) });
    await vi.waitFor(() => expect(chain.heartbeats).toBe(1));
    expect(errors).toEqual([new Error("rpc down")]);
    await heartbeat.stop();
    const checks = spy.mock.calls.length;
    chain.mine(900n);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(spy.mock.calls.length).toBe(checks);
    expect(chain.heartbeats).toBe(1);
  });
});
