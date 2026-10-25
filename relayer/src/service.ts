import { createServer, type Server } from "node:http";
import { inspect } from "node:util";
import { Counter, Gauge, Histogram, Registry } from "prom-client";
import type { LoggerContext } from "@pcash/sdk/blgr";
import type { PrivateKeyRelaySubmitter } from "@pcash/sdk/node";
import {
  publicErrorMessage,
  RelayFeeCeilingError,
  RelayJournalConflictError,
  type RelayJournal,
  type Relayer,
  type RelayerOptions,
  type RelayerResult,
} from "@pcash/sdk/relay";
import type { RelayerCliOptions } from "./args.ts";
import { selectedRelayHandler, type SelectedRelayServiceConfig } from "./selectedService.ts";

type RelayerState = "starting" | "idle" | "relaying" | "stopped";

interface Snapshot {
  feeWallet: Record<string, unknown> | null;
  version: 1;
  state: RelayerState;
  relayerAddress: string;
  nodeOrigin: string;
  l1Origin: string;
  journalPath: string;
  journalLatched: boolean;
  feeCeiling: { resolutionId: string; transactionHash: string; maxFeePerGas: string } | null;
  l1ChainId: number | null;
  inboxAddress: string | null;
  l1BalanceWei: string | null;
  policy: Record<string, unknown>;
  cycles: { total: number; idle: number; relayed: number; failed: number };
  lastCycle: Record<string, unknown> | null;
  stopped: { message: string; transactionHash: string | null } | null;
  uptimeSeconds: number;
}

function origin(value: string): string {
  try { return new URL(value).origin; } catch { return "invalid:"; }
}

function listenAddress(value: string): { host: string; port: number } {
  const bracketed = /^\[([^\]]+)]:(\d+)$/.exec(value);
  const split = value.lastIndexOf(":");
  const host = bracketed?.[1] ?? (split < 1 ? "" : value.slice(0, split));
  const rawPort = bracketed?.[2] ?? (split < 1 ? "" : value.slice(split + 1));
  const port = Number(rawPort);
  if (host === "" || !Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`invalid --http-addr ${value}`);
  }
  return { host, port };
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

class Metrics {
  readonly registry = new Registry<typeof Registry.OPENMETRICS_CONTENT_TYPE>();
  readonly cycles = new Counter({
    name: "pcash_relayer_cycles_total",
    help: "Relay cycles by outcome",
    labelNames: ["outcome"],
    registers: [this.registry],
  });
  readonly transactionsRelayed = new Counter({
    name: "pcash_relayer_transactions_relayed_total",
    help: "PCASH transactions included in confirmed batches",
    registers: [this.registry],
  });
  readonly transactionsRejected = new Counter({
    name: "pcash_relayer_transactions_rejected_total",
    help: "Candidates rejected during preparation",
    registers: [this.registry],
  });
  readonly batches = new Counter({
    name: "pcash_relayer_batches_total",
    help: "Confirmed L1 batch transactions",
    registers: [this.registry],
  });
  readonly batchBytes = new Counter({
    name: "pcash_relayer_batch_bytes_total",
    help: "Batch bytes posted to L1",
    registers: [this.registry],
  });
  readonly gasUsed = new Counter({
    name: "pcash_relayer_gas_used_total",
    help: "L1 gas spent on confirmed batches",
    registers: [this.registry],
  });
  readonly collectibleOpenFee = new Counter({
    name: "pcash_relayer_collectible_open_fee_total",
    help: "Public PCASH open fees collectible by this relayer, in whole PCASH",
    registers: [this.registry],
  });
  readonly collectiblePrivateFee = new Counter({
    name: "pcash_relayer_collectible_private_fee_total",
    help: "Encrypted native PCASH notes opened by this relayer in confirmed batches, in whole PCASH",
    registers: [this.registry],
  });
  readonly expectedIssuance = new Counter({
    name: "pcash_relayer_expected_issuance_total",
    help: "Expected PCASH issuance for this relayer from submitted batches, before the haircut, in whole PCASH",
    registers: [this.registry],
  });
  readonly balance = new Gauge({
    name: "pcash_relayer_l1_balance_ether",
    help: "Relayer balance in whole ether",
    registers: [this.registry],
  });
  readonly considered = new Gauge({
    name: "pcash_relayer_mempool_considered",
    help: "Mempool transactions examined in the last cycle",
    registers: [this.registry],
  });
  readonly latched = new Gauge({
    name: "pcash_relayer_journal_latched",
    help: "Whether the relay journal holds an unsettled transaction",
    registers: [this.registry],
  });
  readonly duration = new Histogram({
    name: "pcash_relayer_cycle_duration_seconds",
    help: "Relay cycle duration",
    buckets: [0.05, 0.1, 0.2, 0.4, 0.8, 1.6, 3.2, 6.4, 12.8, 25.6, 51.2, 102.4],
    registers: [this.registry],
  });

  constructor() {
    this.registry.setContentType(Registry.OPENMETRICS_CONTENT_TYPE);
    this.balance.set(Number.NaN);
    new Gauge({
      name: "pcash_relayer_up",
      help: "Whether the relayer process is running",
      registers: [this.registry],
    }).set(1);
  }

  success(result: RelayerResult, seconds: number): void {
    const relayed = result.submitted;
    this.cycles.inc({ outcome: relayed ? "relayed" : "idle" });
    this.duration.observe(seconds);
    this.considered.set(result.considered);
    this.transactionsRejected.inc(result.rejected.length);
    if (!relayed) return;
    this.batches.inc();
    this.transactionsRelayed.inc(result.selectedContentHashes.length);
    this.batchBytes.inc(Number(result.batchBytes));
    this.gasUsed.inc(Number(result.receipt?.gasUsed ?? 0n));
    this.collectibleOpenFee.inc(Number(result.collectibleOpenFee) / 1e18);
    this.collectiblePrivateFee.inc(Number(result.collectiblePrivateFee) / 1e18);
    this.expectedIssuance.inc(Number(result.valuation?.expectedIssuance ?? 0n) / 1e18);
  }

  failure(stopped: boolean, seconds: number): void {
    this.cycles.inc({ outcome: stopped ? "stopped" : "failed" });
    this.duration.observe(seconds);
  }
}

export interface RelayerServiceConfig {
  logger: LoggerContext;
  selected?: SelectedRelayServiceConfig;
  observeFees?: () => Promise<Record<string, unknown>>;
  options: RelayerCliOptions;
  relayer: Relayer;
  submitter: PrivateKeyRelaySubmitter;
  journal: RelayJournal;
}

function relayOptions(options: RelayerCliOptions): RelayerOptions {
  return { daMode: options.daMode, maxBatchBytes: options.maxBatchBytes };
}

function transactionHash(error: unknown, entryHash: string | null): string | null {
  if (entryHash !== null) return entryHash;
  if (error !== null && typeof error === "object" && "transactionHash" in error) {
    const value = (error as { transactionHash?: unknown }).transactionHash;
    if (typeof value === "string") return value;
  }
  return null;
}

async function journalState(journal: RelayJournal): Promise<{
  latched: boolean;
  ambiguous: boolean;
  transactionHash: string | null;
}> {
  try {
    const entries = await journal.read();
    return {
      latched: entries.length > 0,
      ambiguous: entries.some((entry) => entry.transactionHash === null),
      transactionHash: entries.find((entry) => entry.transactionHash !== null)?.transactionHash ?? null,
    };
  } catch {
    return { latched: true, ambiguous: true, transactionHash: null };
  }
}

function lastCycle(result: RelayerResult, startedAt: number, durationMs: number): Record<string, unknown> {
  return {
    startedAtUnixMs: startedAt,
    durationMs,
    outcome: result.submitted ? "relayed" : "idle",
    considered: result.considered,
    selected: result.selectedContentHashes.length,
    rejected: result.rejected.length,
    byteSize: Number(result.batchBytes),
    carrier: result.carrier === "blobs" ? "blob" : result.carrier,
    collectibleOpenFee: result.collectibleOpenFee.toString(),
    collectiblePrivateFee: result.collectiblePrivateFee.toString(),
    collectibleQualifyingActions: Number(result.collectibleQualifyingActions),
    selectedQualifyingActions: Number(result.selectedQualifyingActions),
    expectedIssuance: result.valuation?.expectedIssuance.toString() ?? null,
    discountedExpectedIssuance: result.valuation?.discountedExpectedIssuance.toString() ?? null,
    l1TransactionHash: result.txHash ?? null,
    gasUsed: result.receipt === undefined ? null : Number(result.receipt.gasUsed),
    l1BlockNumber: result.receipt === undefined ? null : Number(result.receipt.blockNumber),
    error: null,
  };
}

async function listen(server: Server, address: string): Promise<void> {
  const { host, port } = listenAddress(address);
  await new Promise<void>((resolve, reject) => {
    const failed = (error: Error) => { server.off("listening", ready); reject(error); };
    const ready = () => { server.off("error", failed); resolve(); };
    server.once("error", failed);
    server.once("listening", ready);
    server.listen(port, host);
  });
}

export async function serveRelayer(config: RelayerServiceConfig): Promise<void> {
  const { options, relayer, submitter, journal, logger } = config;
  const command = options.command;
  if (command.kind !== "serve") throw new Error("serveRelayer requires the serve command");
  const started = Date.now();
  const metrics = new Metrics();
  const snapshot: Snapshot = {
    version: 1,
    feeWallet: null,
    state: "starting",
    relayerAddress: submitter.address,
    nodeOrigin: origin(options.rpcUrl),
    l1Origin: origin(options.l1Rpc),
    journalPath: options.dev ? "memory://relay-journal" : options.journalPath,
    journalLatched: false,
    feeCeiling: null,
    l1ChainId: null,
    inboxAddress: null,
    l1BalanceWei: null,
    policy: {
      daMode: options.daMode === "blobs" ? "blob" : options.daMode,
      maxBatchBytes: Number(options.maxBatchBytes),
      maxTransactions: options.maxTransactions,
      minValuePerByte: options.minValuePerByte.toString(),
      issuanceHaircutBps: options.issuanceHaircutBps,
      maxPages: options.maxPages,
      sponsorUnpaid: options.sponsorUnpaid,
      maxWaitMs: options.maxWaitMs === undefined ? null : Number(options.maxWaitMs),
      pollIntervalMs: command.pollIntervalMs,
      gasLimit: options.gasLimit === undefined ? null : Number(options.gasLimit),
    },
    cycles: { total: 0, idle: 0, relayed: 0, failed: 0 },
    lastCycle: null,
    stopped: null,
    uptimeSeconds: 0,
  };
  let shutdown = false;
  const selected = config.selected === undefined ? undefined : selectedRelayHandler({
    ...config.selected,
    isAvailable: () => !shutdown && !snapshot.journalLatched
      && snapshot.state !== "starting" && snapshot.state !== "stopped"
      && snapshot.lastCycle?.outcome !== "failed" && snapshot.lastCycle?.outcome !== "stopped"
      && (config.selected?.isAvailable?.() ?? true),
  });
  const server = createServer((request, response) => {
    if (request.url?.startsWith("/selected/")) {
      if (selected === undefined) { response.writeHead(404).end(); return; }
      void selected(request, response);
      return;
    }
    if (request.method !== "GET") { response.writeHead(405).end(); return; }
    if (request.url === "/health") {
      const reason = snapshot.state === "stopped" ? "stopped" : snapshot.feeCeiling !== null ? "fee ceiling" : null;
      response.writeHead(reason === null ? 200 : 503, { "content-type": "text/plain" });
      response.end(`${reason ?? "ok"}\n`);
      return;
    }
    if (request.url === "/status") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(json(snapshot));
      return;
    }
    if (request.url === "/metrics") {
      void metrics.registry.metrics().then((body) => {
        response.writeHead(200, { "content-type": metrics.registry.contentType });
        response.end(body);
      }, () => response.writeHead(500).end());
      return;
    }
    response.writeHead(404).end();
  });
  await listen(server, command.httpAddr);
  logger.info(`operator http listening on ${command.httpAddr}`);

  let wake: (() => void) | undefined;
  const stop = () => { shutdown = true; wake?.(); };
  let closingServer = false;
  let httpError: Error | undefined;
  const failHttp = (error?: Error) => {
    if (closingServer || httpError !== undefined) return;
    httpError = error ?? new Error("operator http server exited unexpectedly");
    stop();
  };
  server.on("error", failHttp);
  server.on("close", failHttp);
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  let stoppedError: unknown;
  try {
    while (!shutdown) {
      const cycleStarted = Date.now();
      snapshot.state = "relaying";
      try {
        const result = await relayer.relay(relayOptions(options));
        const elapsedMs = Date.now() - cycleStarted;
        snapshot.cycles.total += 1;
        snapshot.cycles[result.submitted ? "relayed" : "idle"] += 1;
        snapshot.state = "idle";
        snapshot.journalLatched = false;
        snapshot.feeCeiling = null;
        snapshot.l1ChainId = Number(result.status.l1ChainId);
        snapshot.inboxAddress = result.status.inboxAddress;
        snapshot.lastCycle = lastCycle(result, cycleStarted, elapsedMs);
        if (config.observeFees !== undefined) {
          try { snapshot.feeWallet = await config.observeFees(); }
          catch (error) { snapshot.feeWallet = { error: publicErrorMessage(error) }; }
        }
        snapshot.uptimeSeconds = Math.floor((Date.now() - started) / 1_000);
        metrics.success(result, elapsedMs / 1_000);
        metrics.latched.set(0);
        try {
          const balance = await submitter.balance(result.status);
          snapshot.l1BalanceWei = balance.toString();
          metrics.balance.set(Number(balance) / 1e18);
        } catch {
          snapshot.l1BalanceWei = null;
          metrics.balance.set(Number.NaN);
        }
      } catch (error) {
        const elapsedMs = Date.now() - cycleStarted;
        const latch = await journalState(journal);
        // Known transactions can be repriced and reconciled on later cycles.
        // Only a hashless entry, or an unreadable journal, stops the service.
        const stopped = latch.ambiguous;
        snapshot.cycles.total += 1;
        snapshot.cycles.failed += 1;
        snapshot.journalLatched = latch.latched;
        if (error instanceof RelayFeeCeilingError) {
          snapshot.feeCeiling = {
            resolutionId: error.resolutionId,
            transactionHash: error.transactionHash,
            maxFeePerGas: error.maxFeePerGas.toString(),
          };
        } else if (!latch.latched || error instanceof RelayJournalConflictError) {
          snapshot.feeCeiling = null;
        }
        snapshot.uptimeSeconds = Math.floor((Date.now() - started) / 1_000);
        metrics.failure(stopped, elapsedMs / 1_000);
        metrics.latched.set(latch.latched ? 1 : 0);
        // Status shows our message; the log keeps the whole chain.
        const message = publicErrorMessage(error);
        const hash = transactionHash(error, latch.transactionHash);
        snapshot.lastCycle = {
          startedAtUnixMs: cycleStarted,
          durationMs: elapsedMs,
          outcome: stopped ? "stopped" : "failed",
          considered: 0,
          selected: 0,
          rejected: 0,
          byteSize: 0,
          carrier: null,
          collectibleOpenFee: "0",
          collectiblePrivateFee: "0",
          collectibleQualifyingActions: 0,
          selectedQualifyingActions: 0,
          expectedIssuance: null,
          discountedExpectedIssuance: null,
          l1TransactionHash: hash,
          gasUsed: null,
          l1BlockNumber: null,
          error: message,
        };
        if (stopped) {
          snapshot.state = "stopped";
          snapshot.stopped = { message, transactionHash: hash };
          stoppedError = error;
          logger.error(`relaying stopped: ${inspect(error, { depth: 8 })}`);
          break;
        }
        snapshot.state = "idle";
        logger.error(`relay cycle failed${latch.latched ? " with the journal latched" : ""}: ${inspect(error, { depth: 8 })}`);
      }
      if (shutdown) break;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, command.pollIntervalMs);
        function done(): void { clearTimeout(timer); wake = undefined; resolve(); }
        wake = done;
      });
    }
    while (stoppedError !== undefined && !shutdown) {
      await new Promise<void>((resolve) => { wake = resolve; });
    }
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    closingServer = true;
    server.off("error", failHttp);
    server.off("close", failHttp);
    if (server.listening) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
  if (stoppedError !== undefined) throw stoppedError;
  if (httpError !== undefined) throw httpError;
}
