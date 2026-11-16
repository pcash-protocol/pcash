import { useNetwork } from "../../components/NetworkContext.tsx";
import { friendlyError } from "../../components/friendlyError.ts";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { PcashNodeClient, type ExplorerCursor, type StatusResult } from "@pcash/sdk/clients";
import { bytes32Hex } from "@pcash/sdk/utils";
import {
  explorerIdentityMismatch,
  resolveNetworkExplorerConfig,
  type ExplorerConfig,
} from "./config.ts";
import { SourceRpcClient } from "./rpc.ts";

export const EXPLORER_IDENTITY_TIMEOUT_MS = 5_000;
export const EXPLORER_STATUS_POLL_MS = 12_000;

/** One L1 slot, mirroring EXPECTED_INCLUSION_SECONDS in @pcash/sdk/relay, which the explorer may not import. */
const NEXT_BLOCK_INCLUSION_SECONDS = 12n;

interface ExplorerClients {
  node: PcashNodeClient;
  source: SourceRpcClient;
}

type GuardedRead = <T>(operation: (clients: ExplorerClients, status: StatusResult) => Promise<T>) => Promise<T>;

export function createExplorerReader(read: GuardedRead) {
  return {
    dashboard: (from: bigint, to: bigint) => read(({ node }) => Promise.all([
      node.getBlocks(from, to),
      node.getTransactions({ limit: 10 }),
    ])),
    blocks: (from: bigint, to: bigint) => read(({ node }) => node.getBlocks(from, to)),
    block: (number: bigint) => read(({ node }) => node.getBlock(number)),
    // The blockPayouts record is keyed by block id, so it is read after the
    // block it belongs to and travels with it: one loading state for the page.
    blockSnapshot: (number: bigint) => read(async ({ node }, status) => {
      const block = await node.getBlock(number);
      return {
        block,
        status,
        blockPayouts: block === null
          ? null
          : await node.getBlockPayouts({ blockNumber: block.number, blockHash: block.hash }),
      };
    }),
    blockByHash: (blockHash: string) => read(({ node }) => node.getBlockByHash(blockHash)),
    transactions: (query: Parameters<PcashNodeClient["getTransactions"]>[0]) =>
      read(({ node }) => node.getTransactions(query)),
    transaction: (transactionId: string) => read(({ node }) => node.getTransaction(transactionId)),
    l1DeliveryBatches: (l1TransactionHash: string) => read(({ node }) => node.getL1DeliveryBatches(l1TransactionHash)),
    blockBlockPayouts: (block: Parameters<PcashNodeClient["getBlockPayouts"]>[0]) =>
      read(({ node }) => node.getBlockPayouts(block)),
    // Display-only: quote the next candidate block directly with no retry, so a
    // failed read surfaces like any other failed explorer read.
    issuanceQuote: () => read(({ node }, status) => node.getIssuanceQuote(status.latestBlockTimestamp + NEXT_BLOCK_INCLUSION_SECONDS)),
    blockEconomics: (query: Parameters<PcashNodeClient["getBlockEconomics"]>[0]) => read(({ node }) => node.getBlockEconomics(query)),
    payouts: (query: Parameters<PcashNodeClient["getPayouts"]>[0]) => read(({ node }) => node.getPayouts(query)),
    submission: (contentHash: string, cursor?: ExplorerCursor) => read(({ node }) => node.getSubmission({ contentHash, limit: 25, ...(cursor === undefined ? {} : { cursor }) })),
    mempoolTransaction: (contentHash: string) => read(({ node }) => node.getMempoolTransaction(contentHash)),
    contracts: (query: Parameters<PcashNodeClient["getContracts"]>[0]) =>
      read(({ node }) => node.getContracts(query)),
    mempool: (query: Parameters<PcashNodeClient["getMempool"]>[0]) =>
      read(({ node }) => node.getMempool(query)),
    receipt: (transactionId: string) => read(({ node }) => node.getReceipt(transactionId)),
    accountSnapshot: (address: string) => read(async ({ node }) => {
      const proof = await node.getAccountProof(address);
      if (proof.status !== "present") return { account: null, headHash: undefined };
      const headHash: string = bytes32Hex(proof.boundary.blockHash);
      return { account: proof.account, headHash };
    }),
    accountHistory: (query: Parameters<PcashNodeClient["getAccountHistory"]>[0]) =>
      read(({ node }) => node.getAccountHistory(query)),
    // Pscan is configured independently of the RPC endpoint, so pairing them
    // uses the identity confirmed for this node session.
    sourceInfo: () => read(async ({ source }, status) => ({ info: await source.sourceInfo(), status })),
    contractSource: (address: string) => read(({ source }) => source.contractSource(address)),
    implementationSource: (applicationVkHash: string) => read(({ source }) => source.implementationSource(applicationVkHash)),
    sourceFile: (applicationVkHash: string, path: string) => read(({ source }) => source.sourceFile(applicationVkHash, path)),
    contractBundle: (address: string) => read(({ source }) => source.contractBundle(address)),
  };
}

export type ExplorerReader = ReturnType<typeof createExplorerReader>;
export type AccountSnapshot = Awaited<ReturnType<ExplorerReader["accountSnapshot"]>>;

/** Every read shares one behaviour. Only the fixture loading and error states use this. */
function overrideReader(reader: ExplorerReader, behaviour: () => Promise<never>): ExplorerReader {
  return Object.fromEntries(Object.keys(reader).map((name) => [name, behaviour])) as unknown as ExplorerReader;
}

type ExplorerConnection =
  | { phase: "misconfigured"; message: string }
  | { phase: "connecting"; config: ExplorerConfig }
  | { phase: "unavailable"; config: ExplorerConfig; message: string }
  | { phase: "mismatch"; config: ExplorerConfig; status: StatusResult; message: string }
  | { phase: "ready"; config: ExplorerConfig; reader: ExplorerReader; status: StatusResult };

interface ExplorerContextValue {
  connection: ExplorerConnection;
  retry(): void;
}

class ExplorerRequestCancelled extends Error {}

export class ExplorerIdentityMismatch extends Error {
  constructor(readonly status: StatusResult, message: string) { super(message); }
}

export class ExplorerSession {
  readonly clients: ExplorerClients;
  readonly #active = new Set<AbortController>();
  #status: StatusResult | undefined;
  #generation = 0;

  constructor(readonly config: ExplorerConfig) {
    const node = new PcashNodeClient(config.rpcUrl);
    this.clients = { node, source: new SourceRpcClient(node, config.pscanUrl) };
  }

  readonly read: GuardedRead = async (operation) => {
    const status = this.#status;
    const generation = this.#generation;
    if (status === undefined) throw new Error("Explorer node identity has not been confirmed");
    const result = await operation(this.clients, status);
    if (generation !== this.#generation) throw new Error("Explorer node identity is no longer confirmed");
    return result;
  };

  /** Whether a read can already use a confirmed identity. */
  get confirmed(): boolean {
    return this.#status !== undefined;
  }

  async refresh(): Promise<StatusResult> {
    return this.accept(await this.status());
  }

  /** Confirm the node's identity from a status read from the same node, by this session or another reader. */
  accept(status: StatusResult): StatusResult {
    const mismatch = explorerIdentityMismatch(this.config, status);
    if (mismatch !== undefined) {
      this.#status = undefined;
      this.#generation += 1;
      throw new ExplorerIdentityMismatch(status, mismatch);
    }
    this.#status = status;
    return status;
  }

  async status(): Promise<StatusResult> {
    const controller = new AbortController();
    this.#active.add(controller);
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, EXPLORER_IDENTITY_TIMEOUT_MS);
    const fetchFn: typeof fetch = (url, init) => fetch(url, {
      ...init,
      signal: init?.signal ? AbortSignal.any([controller.signal, init.signal]) : controller.signal,
    });
    try {
      return await new PcashNodeClient(this.config.rpcUrl, { fetchFn }).status();
    } catch (cause) {
      if (controller.signal.aborted) {
        if (timedOut) throw new Error(`The configured node did not report its identity within ${EXPLORER_IDENTITY_TIMEOUT_MS} ms.`);
        throw new ExplorerRequestCancelled("Explorer identity request was cancelled");
      }
      throw cause;
    } finally {
      clearTimeout(timeout);
      this.#active.delete(controller);
    }
  }

  abortPending(): void {
    this.#status = undefined;
    this.#generation += 1;
    for (const controller of this.#active) controller.abort();
    this.#active.clear();
  }
}

const ExplorerContext = createContext<ExplorerContextValue | null>(null);

/** A status another reader of the same node just read, and when. */
export type FollowedStatus = { status: StatusResult; observedAt: number };

/** How long a followed status stands in for the explorer's own poll. */
const FOLLOWED_STATUS_FRESH_MS = 2 * EXPLORER_STATUS_POLL_MS;

export function ExplorerProvider({ children, followedStatus }: { children: ReactNode; followedStatus?: FollowedStatus | undefined }) {
  const parent = useContext(ExplorerContext);
  return parent === null ? <ExplorerSessionProvider followedStatus={followedStatus}>{children}</ExplorerSessionProvider> : children;
}

function ExplorerSessionProvider({ children, followedStatus }: { children: ReactNode; followedStatus: FollowedStatus | undefined }) {
  const followed = useRef(followedStatus);
  followed.current = followedStatus;
  const { network } = useNetwork();
  const configuration = useMemo(() => resolveNetworkExplorerConfig(network), [network]);
  const session = useMemo(
    () => configuration.status === "valid" ? new ExplorerSession(configuration.config) : undefined,
    [configuration],
  );
  const [attempt, setAttempt] = useState(0);
  const [connection, setConnection] = useState<ExplorerConnection>(() => configuration.status === "invalid"
    ? { phase: "misconfigured", message: configuration.message }
    : { phase: "connecting", config: configuration.config });
  const { search } = useLocation();
  const fixtureState = new URLSearchParams(search).get("fixture");

  const reader = useMemo(() => createExplorerReader(session?.read ?? (() => Promise.reject(new Error("Explorer is not configured")))), [session]);

  useEffect(() => {
    if (configuration.status === "invalid" || session === undefined) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setConnection({ phase: "connecting", config: configuration.config });
    const refresh = async () => {
      // A hidden tab waits; a wallet following this node already reads its status.
      const borrowed = followed.current !== undefined && Date.now() - followed.current.observedAt < FOLLOWED_STATUS_FRESH_MS;
      try {
        if (borrowed || (document.visibilityState === "hidden" && session.confirmed)) return;
        const status = await session.refresh();
        if (!cancelled) setConnection({ phase: "ready", config: configuration.config, reader, status });
      } catch (cause) {
        if (cancelled || cause instanceof ExplorerRequestCancelled) return;
        if (cause instanceof ExplorerIdentityMismatch) {
          setConnection({ phase: "mismatch", config: configuration.config, status: cause.status, message: cause.message });
        } else {
          setConnection((previous) => previous.phase === "ready" || previous.phase === "mismatch"
            ? previous
            : { phase: "unavailable", config: configuration.config, message: friendlyError(cause) });
        }
      } finally {
        if (!cancelled) timer = setTimeout(() => void refresh(), EXPLORER_STATUS_POLL_MS);
      }
    };
    void refresh();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      session.abortPending();
    };
  }, [attempt, configuration, reader, session]);

  useEffect(() => {
    if (followedStatus === undefined || configuration.status !== "valid" || session === undefined) return;
    try {
      const status = session.accept(followedStatus.status);
      setConnection({ phase: "ready", config: configuration.config, reader, status });
    } catch (cause) {
      if (cause instanceof ExplorerIdentityMismatch) {
        setConnection({ phase: "mismatch", config: configuration.config, status: cause.status, message: cause.message });
      }
    }
  }, [followedStatus, configuration, reader, session]);

  // Fixture mode: no session, no polling. The world is loaded on demand so it
  // never ships in a production bundle. `?fixture=` selects a connection or
  // reader state; content states are ordinary objects in the world.
  useEffect(() => {
    // The static check is what lets a non-fixture build drop the world entirely;
    // the status check narrows the configuration.
    if (import.meta.env.VITE_PCASH_MODE !== "fixtures" || configuration.status !== "fixtures") return;
    const { config } = configuration;
    if (fixtureState === "connecting") { setConnection({ phase: "connecting", config }); return; }
    if (fixtureState === "misconfigured") { setConnection({ phase: "misconfigured", message: "Fixture: the explorer is not configured." }); return; }
    if (fixtureState === "unavailable") { setConnection({ phase: "unavailable", config, message: "Fixture: the configured node did not report its identity." }); return; }
    let cancelled = false;
    setConnection({ phase: "connecting", config });
    void Promise.all([import("./fixtures/reader.ts"), import("./fixtures/world.ts")]).then(([{ createFixtureReader }, { fixtureStatus }]) => {
      if (cancelled) return;
      if (fixtureState === "mismatch") {
        const status = { ...fixtureStatus, pcashChainId: fixtureStatus.pcashChainId + 1 };
        setConnection({ phase: "mismatch", config, status, message: explorerIdentityMismatch(config, status) ?? "Fixture: identity mismatch." });
        return;
      }
      const fixtureReader = createFixtureReader();
      setConnection({
        phase: "ready",
        config,
        status: fixtureStatus,
        reader: fixtureState === "loading" ? overrideReader(fixtureReader, () => new Promise<never>(() => {}))
          : fixtureState === "error" ? overrideReader(fixtureReader, () => Promise.reject(new Error("Fixture: the node returned an error.")))
          : fixtureReader,
      });
    });
    return () => { cancelled = true; };
  }, [attempt, configuration, fixtureState]);

  const retry = useCallback(() => setAttempt((current) => current + 1), []);
  return <ExplorerContext.Provider value={{ connection, retry }}>{children}</ExplorerContext.Provider>;
}

export function useExplorer(): ExplorerContextValue {
  const value = useContext(ExplorerContext);
  if (value === null) throw new Error("ExplorerProvider is missing");
  return value;
}

export function useReadyExplorer(): Extract<ExplorerConnection, { phase: "ready" }> {
  const { connection } = useExplorer();
  if (connection.phase !== "ready") throw new Error("Explorer connection is not ready");
  return connection;
}
