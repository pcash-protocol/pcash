import { transactionIdentity } from "@pcash/sdk/protocol";
import {
  DurablePreBroadcastError,
  FileRelayJournal,
  PrivateKeyRelaySubmitter,
  Relayer,
  RelayJournalRecoveryManager,
  assertMempoolAdmissible,
  awaitAcceptedReceipt,
  awaitingAcceptance,
  createMempoolSubmissionAdapter,
  derivePcashProfileFromPrivateKey,
  fromHex,
  networkConfigFromStatus,
  posterPayoutOpening,
  prepareTransactionForL1,
  randomFieldEntropy,
  sleep,
  submitPreparedTransactionToL1,
  type DurableSubmissionAdapter,
  type PcashNodeClient,
  type RelayDaMode,
  type RelayerOptions,
  type RelayerResult,
  type RelaySubmissionResult,
  type StatusResult,
  type SubmissionOutput,
} from "../deps.ts";
import { privateKeyToAccount } from "viem/accounts";
import type { L1Backend } from "../backends/types.ts";

/** Whoever a batch header names: its poster commitment collects the batch's open fees. */
export interface Poster {
  address: bigint;
  nkRoot: bigint;
}

export type HarnessSubmission = DurableSubmissionAdapter<unknown, SubmissionOutput>;

/** L1 transactions the harness key keeps in flight at once, each at its own nonce. */
export const HARNESS_MAX_IN_FLIGHT = 8;

export interface HarnessL1Options {
  privateKey: `0x${string}`;
  l1: L1Backend;
  /** Where wallets submit and where the harness publishes. */
  node: PcashNodeClient;
  /** Where relays select admitted entries; a second node proves they arrived by gossip. */
  relayNode: PcashNodeClient;
  journalDirectory: string;
  maxFeePerGas?: bigint;
  waitForRelayCopy(contentHash: string): Promise<void>;
  record(event: string, detail: Record<string, unknown>): void;
}

/** Gather what arrives within `windowMs` into one call, as a relayer gathers a block's worth of work. */
class Batcher<Item, Result> {
  readonly #windowMs: number;
  readonly #maxItems: number;
  readonly #run: (items: Item[]) => Promise<Result>;
  readonly #queue: Array<{ item: Item; resolve: (result: Result) => void; reject: (error: unknown) => void }> = [];
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(windowMs: number, maxItems: number, run: (items: Item[]) => Promise<Result>) {
    this.#windowMs = windowMs;
    this.#maxItems = maxItems;
    this.#run = run;
  }

  add(item: Item): Promise<Result> {
    return new Promise((resolve, reject) => {
      this.#queue.push({ item, resolve, reject });
      this.#timer ??= setTimeout(() => this.#flush(), this.#windowMs);
    });
  }

  #flush(): void {
    this.#timer = undefined;
    while (this.#queue.length > 0) {
      const batch = this.#queue.splice(0, this.#maxItems);
      this.#run(batch.map((waiter) => waiter.item)).then(
        (result) => batch.forEach((waiter) => waiter.resolve(result)),
        (error: unknown) => batch.forEach((waiter) => waiter.reject(error)),
      );
    }
  }
}

/** Admit at most `size` operations at once, in arrival order. */
class Slots {
  #free: number;
  readonly #waiting: Array<() => void> = [];

  constructor(size: number) {
    this.#free = size;
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#free > 0) this.#free -= 1;
    else await new Promise<void>((resolve) => this.#waiting.push(resolve));
    try {
      return await operation();
    } finally {
      const next = this.#waiting.shift();
      if (next === undefined) this.#free += 1;
      else next();
    }
  }
}

/**
 * The one L1 key a run spends. It posts every batch, relays admitted entries,
 * and funds the few actors that must transact on Ethereum themselves, so
 * actors need no ETH and a live run needs one funded key. Every transaction
 * goes through one journal, which gives each its own nonce, so up to
 * HARNESS_MAX_IN_FLIGHT of them land in the same L1 block.
 */
export class HarnessL1 {
  readonly privateKey: `0x${string}`;
  readonly address: string;
  readonly journal: FileRelayJournal;
  readonly submitter: PrivateKeyRelaySubmitter;
  readonly relayer: Relayer;
  readonly daMode: RelayDaMode;
  readonly #options: HarnessL1Options;
  readonly #slots = new Slots(HARNESS_MAX_IN_FLIGHT);
  readonly #pending = new Set<Promise<unknown>>();
  readonly #relays: Batcher<readonly string[], RelayerResult>;
  readonly #publishes: Batcher<Uint8Array, RelaySubmissionResult>;
  #autoRelay: { stopped: boolean; running: Promise<void> } | undefined;

  constructor(options: HarnessL1Options) {
    this.#options = options;
    this.privateKey = options.privateKey;
    this.address = privateKeyToAccount(options.privateKey).address;
    // Ordinary journeys cover calldata on Anvil; the profile scenario publishes real blobs.
    this.daMode = options.l1.anvil ? "calldata" : "auto";
    this.journal = new FileRelayJournal(options.journalDirectory);
    this.submitter = new PrivateKeyRelaySubmitter({
      privateKey: options.privateKey,
      rpcUrl: options.l1.rpcUrl,
      node: options.node,
      journal: this.journal,
      maxInFlight: HARNESS_MAX_IN_FLIGHT,
      observationPollMs: 500,
      ...(options.l1.anvil
        ? { receiptPollMs: 250 }
        : { receiptPollMs: 2_000, receiptTimeoutMs: 600_000, observationTimeoutMs: 600_000 }),
      ...(options.maxFeePerGas === undefined ? {} : { maxFeePerGas: options.maxFeePerGas }),
    });
    this.relayer = this.relayerWith({});
    // Anvil mines every second; a live L1 block takes about twelve.
    const windowMs = options.l1.anvil ? 250 : 4_000;
    this.#relays = new Batcher(windowMs, 32, (lists) => {
      const seen = new Set<string>();
      const contentHashes = lists.flat().filter((hash) => !seen.has(hash.toLowerCase()) && seen.add(hash.toLowerCase()));
      return this.relay({ contentHashes });
    });
    this.#publishes = new Batcher(windowMs, 16, (entries) => this.#publishEntries(entries, undefined, this.daMode));
  }

  /** Keep `operation` in the set `idle` waits for until it settles. */
  #track<T>(operation: Promise<T>): Promise<T> {
    this.#pending.add(operation);
    const settled = () => { this.#pending.delete(operation); };
    void operation.then(settled, settled);
    return operation;
  }

  /** Run one L1 operation in a free journal slot. */
  #l1<T>(operation: () => Promise<T>): Promise<T> {
    return this.#track(this.#slots.run(operation));
  }

  /** A relayer that pays its fees and issuance to the harness key's own profile. */
  relayerWith(config: { sponsorUnpaid?: boolean; minPrivateFee?: bigint }): Relayer {
    return new Relayer({
      node: this.#options.relayNode,
      payoutRecipient: async (status: StatusResult) =>
        derivePcashProfileFromPrivateKey(fromHex(this.privateKey), networkConfigFromStatus(status)),
      submitterFor: () => this.submitter,
      ...config,
    });
  }

  relay(options: RelayerOptions = {}, relayer = this.relayer): Promise<RelayerResult> {
    return this.#l1(() => relayer.relay({ daMode: this.daMode, ...options }));
  }

  /** Publish exactly these admitted entries in one carrier of their own. */
  async relayExact(contentHashes: readonly string[]): Promise<RelayerResult> {
    return published(contentHashes, await this.relay({ contentHashes }));
  }

  /**
   * Publish these admitted entries in the next carrier, together with every
   * other entry admitted within the batch window.
   */
  async relayBatched(contentHashes: readonly string[]): Promise<RelayerResult> {
    return published(contentHashes, await this.#track(this.#relays.add(contentHashes)));
  }

  /**
   * Relay entries in the next batch and resolve with `outcome` as soon as the
   * node shows it, as a scenario watching a separate relayer would. The
   * relay's own L1 receipt and observation polling finish in the background;
   * `idle` waits for them.
   */
  async relayUntil<T>(contentHashes: readonly string[], outcome: () => Promise<T>): Promise<T> {
    const relay = this.relayBatched(contentHashes);
    relay.catch((error: unknown) => this.#options.record("relay-failed", {
      contentHashes, error: error instanceof Error ? error.message : String(error),
    }));
    const observed = outcome();
    return Promise.race([observed, relay.then(() => observed)]);
  }

  /** Wait until every L1 operation the harness started has settled. */
  async idle(): Promise<void> {
    while (this.#pending.size > 0) await Promise.allSettled([...this.#pending]);
  }

  /** Post one entry as its own batch, naming `poster`'s commitment for the batch's fees. */
  publish(entry: Uint8Array, poster: Poster, daMode: RelayDaMode = this.daMode): Promise<RelaySubmissionResult> {
    return this.#publishEntries([entry], poster, daMode);
  }

  /** Post entries in order as one batch, naming `poster`, or the harness key's own profile. */
  #publishEntries(entries: readonly Uint8Array[], poster: Poster | undefined, daMode: RelayDaMode): Promise<RelaySubmissionResult> {
    const node = this.#options.node;
    return this.#l1(async () => {
      const status = await node.status();
      const named = poster ?? derivePcashProfileFromPrivateKey(fromHex(this.privateKey), networkConfigFromStatus(status));
      const opening = posterPayoutOpening(named.address, named.nkRoot, randomFieldEntropy());
      const [first, ...rest] = entries;
      const prepared = await prepareTransactionForL1(
        first!, status, this.submitter, opening.ownerCommitment, opening.context, daMode, { required: rest },
      );
      return submitPreparedTransactionToL1(node, prepared, this.submitter);
    });
  }

  fundEth(to: string, value: bigint): Promise<void> {
    return this.#l1(async () => {
      const sent = await this.submitter.sendCall({ to, value, gasLimit: 21_000n });
      await sent.settle();
      this.#options.record("eth-funded", { to, value, txHash: sent.txHash });
    });
  }

  /**
   * The wallet's `--submit l1` path: the harness posts the action as its own
   * batch, and the batch names `poster`, usually the acting wallet itself.
   */
  l1(poster: Poster, daMode: RelayDaMode = this.daMode): HarnessSubmission {
    return this.#publishing((entry) => this.publish(entry, poster, daMode));
  }

  /**
   * The `--submit l1` path for actions whose issuance the action itself
   * designates, such as account creations and zero-fee earning payments: the
   * harness posts every such action arriving within the batch window in one
   * batch that names its own commitment.
   */
  l1Batched(): HarnessSubmission {
    return this.#publishing((entry) => this.#track(this.#publishes.add(entry)));
  }

  /**
   * A wallet transport over the harness's own publish pipeline, which batches
   * by window and bounds the L1 key's in-flight slots; it then waits for the
   * accepted PCASH receipt, as the wallet service does.
   */
  #publishing(publish: (entry: Uint8Array) => Promise<RelaySubmissionResult>): HarnessSubmission {
    return awaitingAcceptance({
      mode: "l1",
      preflight: async ({ status, transactionBytes, additionalTransactions = [] }) => {
        if (additionalTransactions.length > 0) {
          throw new DurablePreBroadcastError(new Error("the harness L1 transport publishes one transaction per action"));
        }
        assertMempoolAdmissible(status, transactionBytes);
      },
      async submit({ transactionBytes }) {
        const relay = await publish(transactionBytes);
        return { accepted: false, queued: false, l1Hash: relay.txHash, output: { path: "l1", relay } };
      },
    }, { node: this.#options.node, ...this.#acceptanceWait() });
  }

  /**
   * The public mempool path. Nothing else relays on a live network, so the
   * harness relays admitted entries itself, a batch window at a time, unless
   * the caller relays them later.
   */
  mempool(options: { relay?: boolean } = {}): HarnessSubmission {
    const node = this.#options.node;
    const admit: HarnessSubmission = createMempoolSubmissionAdapter(node);
    if (options.relay === false) return admit;
    return {
      ...admit,
      submit: async (context) => {
        const admitted = await admit.submit(context);
        const { contentHash } = transactionIdentity(context.transactionBytes);
        await this.#options.waitForRelayCopy(contentHash);
        const wait = this.#acceptanceWait();
        const receipt = await this.relayUntil([contentHash], () => awaitAcceptedReceipt(node, contentHash, {
          pollIntervalMs: wait.pollIntervalMs,
          pollMaxAttempts: wait.pollMaxAttempts,
        }));
        return {
          accepted: true,
          queued: false,
          output: { ...admitted.output, pcashReceipt: receipt },
        };
      },
    };
  }

  recovery(): RelayJournalRecoveryManager {
    return new RelayJournalRecoveryManager({
      journal: this.journal,
      node: this.#options.node,
      l1Rpc: this.#options.l1.rpcUrl,
    });
  }

  /** Relay whatever the mempool holds, as a polling relayer service would. */
  startAutoRelay(): void {
    if (this.#autoRelay !== undefined) return;
    const relayer = this.relayerWith({ sponsorUnpaid: true });
    const state = { stopped: false, running: Promise.resolve() };
    state.running = (async () => {
      while (!state.stopped) {
        try {
          await this.relay({}, relayer);
        } catch (error) {
          this.#options.record("auto-relay-failed", { error: error instanceof Error ? error.message : String(error) });
        }
        if (!state.stopped) await sleep(500);
      }
    })();
    this.#autoRelay = state;
  }

  async stopAutoRelay(): Promise<void> {
    const state = this.#autoRelay;
    if (state === undefined) return;
    this.#autoRelay = undefined;
    state.stopped = true;
    await state.running;
  }

  /**
   * How long an actor's wallet waits after acceptance for its action to
   * finalize. Anvil finalizes within seconds; on a live L1 finality takes
   * minutes, so the wallet returns at acceptance and later syncs settle it.
   */
  walletSettleWait(): { settlePollMaxAttempts?: number } {
    return this.#options.l1.anvil ? {} : { settlePollMaxAttempts: 1 };
  }

  #acceptanceWait(): { pollIntervalMs: number; pollMaxAttempts: number } {
    return this.#options.l1.anvil
      ? { pollIntervalMs: 500, pollMaxAttempts: 360 }
      : { pollIntervalMs: 2_000, pollMaxAttempts: 450 };
  }
}

/** `result`, once it is known to have published every one of `contentHashes`. */
function published(contentHashes: readonly string[], result: RelayerResult): RelayerResult {
  const selected = new Set(result.selectedContentHashes.map((hash) => hash.toLowerCase()));
  if (!result.submitted || contentHashes.some((hash) => !selected.has(hash.toLowerCase()))) {
    const wanted = new Set(contentHashes.map((hash) => hash.toLowerCase()));
    const rejected = result.rejected
      .filter((item) => wanted.has(item.contentHash.toLowerCase()))
      .map((item) => `${item.contentHash}: ${item.reason}`).join("; ");
    throw new Error(`relay did not publish ${contentHashes.join(", ")}${rejected === "" ? "" : ` (${rejected})`}`);
  }
  return result;
}
