// The issuer's side of a standard deny list: create it, freeze and unfreeze
// addresses, pause and unpause, set Δ up to the maximum its assets commit to,
// and heartbeat, by hand or on a timer. Every change computes the next root
// from the list rebuilt from the contract's own logs, the same way a holder's
// wallet rebuilds it, and names the root it computed from, so the contract
// rejects a change another writer has overtaken. One admin's writes, timed
// heartbeats included, run one at a time. It sends through an
// `EthereumWriter`, which a stablecoin issuer that uses the same key shares.

import { hexToBytes, type Address, type Hex, type PublicClient } from "viem";
import { buildDenyListTree, type DenyListConfiguration, type DenyListTree } from "@pcash/sdk/rules";
import { emptyDenyListState, syncDenyList, viemL1LogReader, type DenyListState } from "@pcash/sdk/wallet";
import { DENY_LIST_ABI } from "./contracts.ts";
import type { EthereumWriter } from "./ethereumWriter.ts";

export interface DenyListAdminParams {
  publicClient: PublicClient;
  /** Sends from the list's issuer account; shared with a `StablecoinIssuer` that uses the same key. */
  writer: EthereumWriter;
  contract: Address;
  listId: Hex;
  /** The block the list was created in, from which its logs are read. */
  fromBlock: bigint;
  /** The largest Δ the list's assets accept; a publication above it authorizes nothing. */
  maxDelta: bigint;
}

/** The age, in Ethereum seconds, at which a timed heartbeat publishes the list again. */
export const HEARTBEAT_INTERVAL_SECONDS = 900n;
const HEARTBEAT_CHECK_MS = 60_000;

export interface HeartbeatOptions {
  /** Publish again once the latest publication is this many Ethereum seconds old. */
  intervalSeconds?: bigint;
  /** How often the timer reads the latest publication's age. */
  checkEveryMs?: number;
  /** A failed check is reported here and the timer checks again later. */
  onError(error: unknown): void;
}

export class DenyListAdmin {
  readonly #params: DenyListAdminParams;
  readonly #state: DenyListState;
  #tail: Promise<unknown> = Promise.resolve();

  constructor(params: DenyListAdminParams) {
    this.#params = params;
    this.#state = emptyDenyListState(this.configuration, params.fromBlock);
  }

  get configuration(): DenyListConfiguration {
    return { contractAddress: BigInt(this.#params.contract), listId: hexToBytes(this.#params.listId), maxDelta: this.#params.maxDelta };
  }

  /** Create a list with the writer's account as issuer and publish its empty root. */
  static async create(params: Omit<DenyListAdminParams, "listId" | "fromBlock"> & { salt: Hex; delta: bigint }): Promise<DenyListAdmin> {
    if (params.delta > params.maxDelta) throw new Error("delta exceeds the list's maximum");
    const receipt = await params.writer.write({
      address: params.contract, abi: DENY_LIST_ABI, functionName: "create",
      args: [params.salt, buildDenyListTree([]).root, params.delta],
    });
    const listId = await params.publicClient.readContract({
      address: params.contract, abi: DENY_LIST_ABI, functionName: "listIdOf", args: [params.writer.address, params.salt],
    });
    return new DenyListAdmin({ ...params, listId, fromBlock: receipt.blockNumber });
  }

  /** The denied addresses as the contract's logs define them. */
  denied(): Promise<bigint[]> {
    return this.#exclusive(async () => [...(await this.#sync()).denied]);
  }

  freeze(addresses: readonly Address[]): Promise<Hex> {
    return this.#exclusive(() => this.#update(addresses.map((address) => BigInt(address)), []));
  }

  unfreeze(addresses: readonly Address[]): Promise<Hex> {
    return this.#exclusive(() => this.#update([], addresses.map((address) => BigInt(address))));
  }

  pause(): Promise<Hex> { return this.#exclusive(() => this.#write("pause", [this.#params.listId])); }
  unpause(): Promise<Hex> { return this.#exclusive(() => this.#write("unpause", [this.#params.listId])); }
  heartbeat(): Promise<Hex> { return this.#exclusive(() => this.#write("heartbeat", [this.#params.listId])); }
  setDelta(delta: bigint): Promise<Hex> {
    if (delta > this.#params.maxDelta) return Promise.reject(new Error("delta exceeds the list's maximum"));
    return this.#exclusive(() => this.#write("setDelta", [this.#params.listId, delta]));
  }

  /**
   * Heartbeat if the latest publication is at least `intervalSeconds` old by
   * Ethereum block time. Returns the heartbeat's transaction, or undefined
   * when the publication is younger or the list is paused, which the contract
   * does not heartbeat.
   */
  heartbeatIfDue(intervalSeconds = HEARTBEAT_INTERVAL_SECONDS): Promise<Hex | undefined> {
    return this.#exclusive(async () => {
      await this.#sync();
      const latest = this.#state.latest;
      if (latest === undefined || latest.publication.paused) return undefined;
      const { publicClient } = this.#params;
      const [published, now] = await Promise.all([
        publicClient.getBlock({ blockNumber: latest.log.blockNumber }),
        publicClient.getBlock({ blockNumber: this.#state.scannedThrough }),
      ]);
      if (now.timestamp - published.timestamp < intervalSeconds) return undefined;
      return this.#write("heartbeat", [this.#params.listId]);
    });
  }

  /** Run `heartbeatIfDue` now and every `checkEveryMs` until stopped. */
  startHeartbeat(options: HeartbeatOptions): { stop(): Promise<void> } {
    const intervalSeconds = options.intervalSeconds ?? HEARTBEAT_INTERVAL_SECONDS;
    const checkEveryMs = options.checkEveryMs ?? HEARTBEAT_CHECK_MS;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let check: Promise<void> = Promise.resolve();
    const run = () => {
      check = this.heartbeatIfDue(intervalSeconds).then(() => undefined, (error: unknown) => { options.onError(error); }).finally(() => {
        if (!stopped) timer = setTimeout(run, checkEveryMs);
      });
    };
    run();
    return {
      stop: async () => {
        stopped = true;
        clearTimeout(timer);
        await check;
      },
    };
  }

  #exclusive<T>(run: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(run, run);
    this.#tail = next.catch(() => undefined);
    return next;
  }

  #sync(): Promise<DenyListTree> {
    return syncDenyList(viemL1LogReader(this.#params.publicClient), this.#state);
  }

  async #update(added: bigint[], removed: bigint[]): Promise<Hex> {
    const toAddress = (value: bigint) => `0x${value.toString(16).padStart(40, "0")}` as Address;
    for (let attempt = 0; ; attempt += 1) {
      const current = await this.#sync();
      // Removals apply before additions, as every reader applies them.
      const next = new Set(current.denied);
      for (const address of removed) next.delete(address);
      for (const address of added) next.add(address);
      try {
        return await this.#write("update", [
          this.#params.listId, added.map(toAddress), removed.map(toAddress), current.root, buildDenyListTree(next).root,
        ]);
      } catch (error) {
        // Another writer changed the list after it was read: read it again and recompute once.
        if (attempt > 0 || (await this.#storedRoot()) === current.root) throw error;
      }
    }
  }

  async #storedRoot(): Promise<bigint> {
    const [, , , root] = await this.#params.publicClient.readContract({
      address: this.#params.contract, abi: DENY_LIST_ABI, functionName: "lists", args: [this.#params.listId],
    });
    return root;
  }

  async #write(functionName: "update" | "pause" | "unpause" | "heartbeat" | "setDelta", args: readonly unknown[]): Promise<Hex> {
    const { writer, contract } = this.#params;
    return (await writer.write({ address: contract, abi: DENY_LIST_ABI, functionName, args })).transactionHash;
  }
}
