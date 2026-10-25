import { defaultWalletDataDir, generatedWalletToken, saveWalletConnection } from "../connection.ts";
import {
  derivePcashProfileFromPrivateKey,
  deriveSeedWalletIdentity,
  normalizeWalletMnemonic,
  validateWalletMnemonic,
  Wallet,
  OPEN_WALLET_INTERNAL,
  receiveKeyHashHex,
  awaitingAcceptance,
  createL1SubmissionAdapter,
  createMempoolSubmissionAdapter,
  type PcashProfile,
  type SubmissionOutput,
  type DurableSubmissionAdapter,
} from "@pcash/sdk/wallet";
import { createWalletProvers, promptSecret, type ProverKind } from "@pcash/sdk/wallet/node";
import type { WalletDatabase } from "@pcash/sdk/wallet/database";
import { existsSync, readdirSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { Config } from "@pcash/sdk/bcfg";
import { Logger, type LoggerContext } from "@pcash/sdk/blgr";
import { PcashNodeClient } from "@pcash/sdk/clients";
import { privateKeyPcashActionSigner } from "@pcash/sdk/eip712";
import {
  FileRelayJournal,
  MemoryRelayJournal,
  PrivateKeyRelaySubmitter,
} from "@pcash/sdk/node";
import {
  Relayer,
  type RelayDaMode,
  type RelaySubmitter,
  type RelayJournal,
  type RelayJournalRecovery,
  RelayJournalRecoveryManager,
  RelayValidationError,
  SelectedRelayHttpClient,
} from "@pcash/sdk/relay";
import { ensurePrivateDirectory, openMemoryWalletDatabase, openNodeWalletDatabase } from "../node/walletDatabase.ts";
import { generateMlKemKeyPair, networkConfigFromStatus } from "@pcash/sdk/protocol";
import { addressHex, fixedHex, fromHexSized, keyedSerialQueue, serialQueue, toHex } from "@pcash/sdk/utils";
import {
  inventoryPath,
  openKeystore,
  keystorePath,
  parseL1KeyFile,
  parsePrivateKeyFile,
  parseReceiveKeyFile,
  type Keystore,
  type StoredWallet,
} from "./credentials.ts";
import { accountCreationSubmission, handleWalletHttp, privateRelayTerms } from "./http.ts";
import {
  createPrometheusWalletMetrics,
  type PrometheusWalletMetrics,
} from "./metrics.ts";
import {
  hasExpectedLoopbackOrigin,
  loopbackRequestAuthority,
} from "./requestSecurity.ts";

export const DEFAULT_LISTEN = "127.0.0.1:8745";
export const DEFAULT_NODE_RPC = "http://127.0.0.1:8645";
export const DEV_ANVIL_WALLET_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

export const DEV_MODE_WARNING = `
================================================================================
= WARNING: PCASH WALLET DEVELOPMENT MODE IS ON                               =
= ANVIL ACCOUNT 0 IS IMPORTED; WALLET STATE AND JOURNAL ARE IN MEMORY.       =
= ALL WALLET SERVICE DATA WILL BE LOST ON EXIT.                              =
================================================================================`;

export const SERVE_USAGE = `Usage: pcash-wallet [serve] [options]

Options:
  --listen <host:port>           Loopback HTTP address (default ${DEFAULT_LISTEN})
  --metrics-addr <host:port>     Loopback OpenMetrics address (disabled by default)
  --rpc-url <url>                PCASH node RPC (default ${DEFAULT_NODE_RPC})
  --data-dir <path>              Private wallet state directory
  --dev                          Use memory state and import Anvil account 0
  --prover wasm|native           Proof backend (default wasm)
  --scan-interval-ms <ms>        Node-tip polling interval (default 2000)
  --l1-rpc <url>                 Default Ethereum RPC for L1 submission
  --l1-key-file <path>           Mode-0600 JSON L1 signing key
  --selected-relayer-url <url>   Relayer that accepts privately paid selected relay
  --da-mode auto|calldata|blobs   Carrier for direct wallet submissions (default auto)
  --max-fee-per-gas <wei>        Refuse a relay above this L1 fee cap
  --min-value-per-byte <amount>  Automatic relay floor on fee plus expected issuance per byte
  --token <token>                Explicit bearer token (default: private local connection file)
  --payout-wallet <address>      Wallet receiving relay payouts (default: sole wallet)
  --log-level <level>            none, error, warning, info, debug, or spam (default info)
  --log-file <path>              Also write logs to this file, rotated at 20 MiB
  -h, --help                     Show this help

Environment:
  Each option also reads PCASH_WALLET_<OPTION>, for example PCASH_WALLET_RPC_URL
  for --rpc-url. PCASH_WALLET_L1_KEY supplies the L1 signing key in place of
  --l1-key-file and is read only from the environment.
  The CLI discovers the generated token and endpoint in the same --data-dir.
  Explicit tokens are never written to that connection file; configure both terminals.
  PCASH_WALLET_PASSWORD unlocks the encrypted wallet vault. Otherwise the server
  prompts in the terminal. Stop the server to lock the wallet.
`;

export interface ServeOptions {
  listen: string;
  rpc: string;
  dataDir: string;
  dev: boolean;
  prover: ProverKind;
  scanIntervalMs: number;
  metricsAddr?: string;
  l1Rpc?: string;
  l1Key?: string;
  l1KeyFile?: string;
  selectedRelayerUrl?: string;
  maxFeePerGas?: bigint;
  minValuePerByte: bigint;
  daMode: RelayDaMode;
  token?: string;
  password?: string;
  payoutWallet?: string;
  logLevel: string;
  logFile?: string;
}

const SERVE_OPTIONS = [
  "listen", "rpc-url", "data-dir", "dev", "prover", "scan-interval-ms", "metrics-addr", "l1-rpc", "l1-key-file",
  "selected-relayer-url", "max-fee-per-gas", "min-value-per-byte", "da-mode", "token", "payout-wallet", "log-level", "log-file",
];

function parseLoopbackAddress(
  value: string,
  option: "--listen" | "--metrics-addr",
): { host: string; port: number } {
  let host: string;
  let portText: string;
  if (value.startsWith("[")) {
    const close = value.indexOf("]");
    if (close <= 1 || value[close + 1] !== ":") {
      throw new Error(`${option} expects host:port, got ${value}`);
    }
    host = value.slice(1, close);
    portText = value.slice(close + 2);
  } else {
    const separator = value.lastIndexOf(":");
    if (separator <= 0) throw new Error(`${option} expects host:port, got ${value}`);
    host = value.slice(0, separator);
    portText = value.slice(separator + 1);
  }
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    const service = option === "--listen" ? "wallet HTTP service" : "wallet metrics";
    throw new Error(`${service} may listen only on 127.0.0.1, localhost, or ::1`);
  }
  const port = Number(portText);
  if (!/^[0-9]+$/.test(portText) || !Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`invalid ${option === "--listen" ? "listen" : "metrics"} port ${value}`);
  }
  return { host, port };
}

export function parseListen(value: string): { host: string; port: number } {
  return parseLoopbackAddress(value, "--listen");
}

export function parseMetricsAddress(value: string): { host: string; port: number } {
  return parseLoopbackAddress(value, "--metrics-addr");
}

function nonnegativeArg(value: string | null, label: string): bigint | undefined {
  if (value === null) return undefined;
  if (!/^(?:0|[1-9][0-9]*|0[xX][0-9a-fA-F]+)$/.test(value)) {
    throw new Error(`${label} must be a nonnegative decimal or 0x integer`);
  }
  return BigInt(value);
}

export function parseServeArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): ServeOptions {
  const config = new Config("pcash-wallet");
  config.load({ argv: ["node", "pcash-wallet", ...argv], env });
  const known = new Set(SERVE_OPTIONS.map((flag) => flag.replace(/-/g, "")));
  for (const key of Object.keys(config.args)) {
    if (!known.has(key)) throw new Error(`unknown option --${key}`);
  }
  if (config.argv.length > 1 || (config.argv.length === 1 && config.argv[0] !== "serve")) {
    throw new Error(`unexpected argument ${config.argv.at(-1)}`);
  }
  const dev = config.bool("dev", false);
  const prover = config.str("prover", "wasm");
  if (prover !== "wasm" && prover !== "native") throw new Error("--prover expects wasm or native");
  const scanIntervalMs = Number(config.str("scan-interval-ms", "2000"));
  if (!Number.isInteger(scanIntervalMs) || scanIntervalMs < 1) {
    throw new Error("--scan-interval-ms must be a positive integer");
  }
  const listen = config.str("listen", DEFAULT_LISTEN);
  parseListen(listen);
  const metricsAddr = config.str("metrics-addr");
  if (metricsAddr !== null) parseMetricsAddress(metricsAddr);
  const maxFeePerGas = nonnegativeArg(config.str("max-fee-per-gas"), "--max-fee-per-gas");
  const minValuePerByte = nonnegativeArg(config.str("min-value-per-byte"), "--min-value-per-byte") ?? 0n;
  const daMode = config.str("da-mode", "auto");
  if (daMode !== "auto" && daMode !== "calldata" && daMode !== "blobs") throw new Error("--da-mode expects auto, calldata, or blobs");
  const l1Rpc = config.str("l1-rpc");
  const l1Key = config.str("l1-key");
  const l1KeyFile = config.str("l1-key-file");
  if (l1Key !== null && l1KeyFile !== null) {
    throw new Error("PCASH_WALLET_L1_KEY and --l1-key-file are mutually exclusive");
  }
  const selectedRelayerUrl = config.str("selected-relayer-url");
  if (selectedRelayerUrl !== null && !/^https?:\/\//.test(selectedRelayerUrl)) {
    throw new Error("--selected-relayer-url must be an HTTP or HTTPS URL");
  }
  const token = config.str("token");
  const payoutWallet = config.str("payout-wallet");
  const logLevel = config.str("log-level", "info").toLowerCase();
  if (!Logger.levelsByVal.includes(logLevel)) {
    throw new Error(`--log-level expects ${Logger.levelsByVal.join(", ")}`);
  }
  const logFile = config.str("log-file");
  return {
    listen,
    rpc: config.str("rpc-url", DEFAULT_NODE_RPC),
    dataDir: config.str("data-dir", defaultWalletDataDir()),
    dev,
    prover,
    scanIntervalMs,
    minValuePerByte,
    daMode,
    ...(metricsAddr === null ? {} : { metricsAddr }),
    ...(maxFeePerGas === undefined ? {} : { maxFeePerGas }),
    ...(l1Rpc === null ? {} : { l1Rpc }),
    ...(l1Key === null ? {} : { l1Key }),
    ...(l1KeyFile === null ? {} : { l1KeyFile }),
    ...(selectedRelayerUrl === null ? {} : { selectedRelayerUrl }),
    ...(token === null ? {} : { token }),
    ...(env.PCASH_WALLET_PASSWORD === undefined ? {} : { password: env.PCASH_WALLET_PASSWORD }),
    ...(payoutWallet === null ? {} : { payoutWallet: fixedHex(payoutWallet, 20, "payout wallet") }),
    logLevel,
    ...(logFile === null ? {} : { logFile }),
  };
}

function enumValue<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
  label: string,
): T {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new RelayValidationError(`${label} expects one of: ${allowed.join(", ")}`);
  }
  return value as T;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function devAnvilWallet(): { address: string; privateKey: string } {
  const privateKey = fromHexSized(DEV_ANVIL_WALLET_PRIVATE_KEY, 32, "development Anvil key");
  return {
    address: addressHex(privateKeyPcashActionSigner(privateKey).address),
    privateKey: toHex(privateKey),
  };
}

type ServiceWallet = Pick<Wallet, "close" | "startSync" | "sync">;

export async function activateWallet<T extends ServiceWallet>(
  existing: T | undefined,
  build: () => Promise<T>,
  publish: (wallet: T) => void | Promise<void>,
  intervalMs: number,
  discard?: (wallet: T) => void | Promise<void>,
): Promise<T> {
  const wallet = existing ?? await build();
  try {
    await wallet.sync({ rescan: true });
    await publish(wallet);
    if (existing === undefined) wallet.startSync({ intervalMs });
    return wallet;
  } catch (error) {
    if (existing === undefined) {
      await wallet.close().catch(() => undefined);
      await Promise.resolve().then(() => discard?.(wallet)).catch(() => undefined);
    }
    throw error;
  }
}

/** Serialize wallet activation so the existence check is current when building. */
export function createWalletActivator() {
  const run = keyedSerialQueue();
  return function activateStoredWallet<T extends ServiceWallet>(
    key: string,
    existing: () => T | undefined,
    build: () => Promise<T>,
    publish: (wallet: T) => void | Promise<void>,
    intervalMs: number,
    discard?: (wallet: T) => void | Promise<void>,
  ): Promise<T> {
    return run(key, () => activateWallet(existing(), build, publish, intervalMs, discard));
  };
}

/** Build restored wallets as one owned set, closing the partial set on failure. */
export async function buildWalletRegistry<
  Stored extends { address: string },
  T extends Pick<Wallet, "close">,
>(
  wallets: readonly Stored[],
  build: (wallet: Stored) => Promise<T>,
): Promise<Map<string, T>> {
  const runtimes = new Map<string, T>();
  try {
    for (const wallet of wallets) runtimes.set(wallet.address, await build(wallet));
    return runtimes;
  } catch (error) {
    await Promise.allSettled([...runtimes.values()].map((runtime) => runtime.close()));
    throw error;
  }
}

/** Wait for active HTTP requests before taking the final Wallet ownership snapshot. */
export async function closeWalletRegistryAfterRequests<
  T extends Pick<Wallet, "close">,
>(
  requestsDrained: Promise<void>,
  runtimes: ReadonlyMap<string, T>,
): Promise<void> {
  try {
    await requestsDrained;
  } finally {
    await Promise.all([...runtimes.values()].map((runtime) => runtime.close()));
  }
}

/** Track async handlers independently of their sockets so shutdown can drain them. */
export function createRequestDrain() {
  const active = new Set<Promise<unknown>>();
  return {
    track<T>(request: Promise<T>): Promise<T> {
      active.add(request);
      void request.then(() => active.delete(request), () => active.delete(request));
      return request;
    },
    async drain(): Promise<void> {
      while (active.size > 0) await Promise.allSettled([...active]);
    },
  };
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolve();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
}

function loopbackUrl(host: string, port: number): string {
  return `http://${host === "::1" ? `[${host}]` : host}:${port}`;
}

export async function startWalletMetricsServer(
  metrics: Pick<PrometheusWalletMetrics, "contentType" | "metrics">,
  address: string,
): Promise<{ close: () => Promise<void>; url: string }> {
  const { host, port } = parseMetricsAddress(address);
  const server = createServer((request, response) => {
    const authority = loopbackRequestAuthority(request);
    if (authority === undefined) {
      response.writeHead(400, {
        "cache-control": "no-store",
        "content-type": "text/plain; charset=utf-8",
      });
      response.end("unexpected Host header\n");
      return;
    }
    if (!hasExpectedLoopbackOrigin(request, authority)) {
      response.writeHead(403, {
        "cache-control": "no-store",
        "content-type": "text/plain; charset=utf-8",
      });
      response.end("unexpected Origin header\n");
      return;
    }
    const pathname = (() => {
      try {
        return new URL(request.url ?? "/", "http://metrics.local").pathname;
      } catch {
        return "/unknown";
      }
    })();
    if (request.method !== "GET" || pathname !== "/metrics") {
      response.writeHead(404, {
        "cache-control": "no-store",
        "content-type": "text/plain; charset=utf-8",
      });
      response.end("not found\n");
      return;
    }
    void metrics.metrics().then(
      (body) => {
        response.writeHead(200, {
          "cache-control": "no-store",
          "content-type": metrics.contentType,
        });
        response.end(body);
      },
      () => {
        response.writeHead(500, {
          "cache-control": "no-store",
          "content-type": "text/plain; charset=utf-8",
        });
        response.end("metrics unavailable\n");
      },
    );
  });
  try {
    await listen(server, port, host);
  } catch (error) {
    await closeServer(server).catch(() => undefined);
    throw error;
  }
  const bound = server.address();
  const boundPort = typeof bound === "object" && bound !== null ? bound.port : port;
  let closing: Promise<void> | undefined;
  return {
    url: loopbackUrl(host, boundPort),
    close() {
      closing ??= closeServer(server);
      return closing;
    },
  };
}

/** Bind the service surfaces as one owned startup unit. */
export async function startWalletServiceListeners(params: {
  server: Server;
  host: string;
  port: number;
  wallets: Iterable<Pick<Wallet, "close">>;
  metrics?: {
    recorder: PrometheusWalletMetrics;
    address: string;
  };
  startMetricsServer?: typeof startWalletMetricsServer;
  onListening?: () => void;
}): Promise<{ metricsServer?: Awaited<ReturnType<typeof startWalletMetricsServer>> }> {
  const wallets = [...params.wallets];
  let metricsServer: Awaited<ReturnType<typeof startWalletMetricsServer>> | undefined;
  try {
    if (params.metrics !== undefined) {
      metricsServer = await (params.startMetricsServer ?? startWalletMetricsServer)(
        params.metrics.recorder,
        params.metrics.address,
      );
    }
    await listen(params.server, params.port, params.host);
    params.onListening?.();
    return metricsServer === undefined ? {} : { metricsServer };
  } catch (error) {
    await Promise.allSettled([
      closeServer(params.server),
      ...(metricsServer === undefined ? [] : [metricsServer.close()]),
      ...wallets.map((wallet) => wallet.close()),
    ]);
    throw error;
  }
}

interface WalletServer {
  close: () => Promise<void>;
  closed: Promise<void>;
  metricsUrl?: string;
  url: string;
}

/** The loaded wallet a request names, or the only one when it names none. */
export function selectServedWallet<T>(wallets: ReadonlyMap<string, T>, wallet: string | undefined): T {
  if (wallets.size === 0) {
    throw new RelayValidationError("No wallets loaded. Run pcash-wallet-cli wallet create or pcash-wallet-cli wallet import.");
  }
  if (wallet !== undefined) {
    let address: string;
    try {
      address = fixedHex(wallet, 20, "wallet");
    } catch (error) {
      throw new RelayValidationError("wallet must be a 20-byte 0x-prefixed hex string", error);
    }
    const found = wallets.get(address);
    if (found === undefined) throw new RelayValidationError(`unknown wallet ${wallet}`);
    return found;
  }
  if (wallets.size === 1) return wallets.values().next().value!;
  throw new RelayValidationError(`Multiple wallets loaded: ${[...wallets.keys()].join(", ")}. Pass --wallet <address>; run pcash-wallet-cli wallet list.`);
}

export interface ServiceSubmissionOptions {
  node: PcashNodeClient;
  /** Default Ethereum RPC for --submit l1. */
  l1Rpc?: string;
  daMode: RelayDaMode;
  submitterFor: (l1Rpc?: string, wallet?: string) => RelaySubmitter;
  recovery?: () => Promise<RelayJournalRecovery>;
  /** The restored profile of the wallet a request names. */
  profileFor: (wallet: string | undefined) => PcashProfile;
}

/**
 * The transport each request selects: the node mempool by default, or
 * `--submit l1`. The selected wallet pays gas unless a service gas key was
 * configured. Payouts belong to the selected wallet in either case.
 */
export function serviceSubmissionFor(options: ServiceSubmissionOptions) {
  return (body: Record<string, unknown>, wallet: string | undefined): DurableSubmissionAdapter => {
    const path = enumValue(body.submit, ["mempool", "l1", "selected"] as const, "mempool", "submit");
    const waitMode = enumValue(body.waitMode, ["latest", "finalized", "none"] as const, "latest", "waitMode");
    const waiting = <Prepared>(transport: DurableSubmissionAdapter<Prepared, SubmissionOutput>): DurableSubmissionAdapter =>
      waitMode === "none"
        ? transport
        : awaitingAcceptance(transport, { node: options.node, finalized: waitMode === "finalized" });
    if (path === "selected" && body.l1Rpc !== undefined) {
      throw new RelayValidationError("selected mempool submission does not use an L1 endpoint");
    }
    if (body.l1Rpc !== undefined && typeof body.l1Rpc !== "string") {
      throw new RelayValidationError("l1Rpc must be a string");
    }
    if (path !== "l1") return waiting({
      ...createMempoolSubmissionAdapter(options.node),
      ...(options.recovery === undefined ? {} : { l1Recovery: options.recovery }),
    });
    if (waitMode === "none") {
      throw new RelayValidationError("--submit l1 requires --wait accepted or finalized; PCASH acceptance must be observed");
    }
    const l1Rpc = typeof body.l1Rpc === "string" ? body.l1Rpc : undefined;
    if ((l1Rpc ?? options.l1Rpc) === undefined) {
      throw new RelayValidationError(
        "L1 submission requires --l1-rpc. Configure it and fund the Ethereum account paying gas, or explicitly choose --submit mempool",
      );
    }
    // Registration carries its own signature, even when the same account posts it.
    return waiting(createL1SubmissionAdapter({
      node: options.node,
      submitterFor: () => options.submitterFor(l1Rpc, wallet),
      payoutRecipient: () => options.profileFor(wallet),
      daMode: options.daMode,
      ...(options.recovery === undefined ? {} : { recovery: options.recovery }),
    }));
  };
}

/** One nonce queue and journal per Ethereum signer, shared by posting and recovery. */
export function createServiceRelayJournals(options: {
  dataDir: string;
  dev: boolean;
  node: PcashNodeClient;
  l1Rpc?: string;
}) {
  const directory = join(options.dataDir, "relay-journal");
  const signers = new Map<string, {
    journal: RelayJournal;
    runExclusive: ReturnType<typeof serialQueue>;
    recovery: RelayJournalRecoveryManager;
  }>();
  const forAddress = (address: string) => {
    const key = address.toLowerCase();
    let signer = signers.get(key);
    if (signer === undefined) {
      const journal = options.dev ? new MemoryRelayJournal() : new FileRelayJournal(join(directory, key));
      const runExclusive = serialQueue();
      const recovery = new RelayJournalRecoveryManager({
        journal, node: options.node, runExclusive,
        ...(options.l1Rpc === undefined ? {} : { l1Rpc: options.l1Rpc }),
      });
      signer = { journal, runExclusive, recovery };
      signers.set(key, signer);
    }
    return signer;
  };
  const all = () => {
    if (!options.dev && existsSync(directory)) {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.isDirectory() && /^0x[0-9a-f]{40}$/.test(entry.name)) forAddress(entry.name);
      }
    }
    return [...signers.values()];
  };
  const recovery: RelayJournalRecovery = {
    async show() {
      const views = await Promise.all(all().map(({ recovery }) => recovery.show()));
      return { latched: views.some(view => view.latched), entries: views.flatMap(view => view.entries) };
    },
    async reconcile() {
      const results = await Promise.all(all().map(({ recovery }) => recovery.reconcile()));
      return { latched: results.some(result => result.latched), entries: results.flatMap(result => result.entries) };
    },
    async resolve(resolutionId) {
      for (const signer of all()) {
        const view = await signer.recovery.show();
        if (view.entries.some(entry => entry.resolutionId.toLowerCase() === resolutionId.toLowerCase())) {
          const resolved = await signer.recovery.resolve(resolutionId);
          return { ...resolved, latched: (await recovery.show()).latched };
        }
      }
      throw new RelayValidationError(`no relay journal entry matches ${resolutionId}`);
    },
  };
  return { forAddress, recovery };
}

export async function startWalletServer(opts: ServeOptions, logger: LoggerContext): Promise<WalletServer> {
  const generatedToken = !opts.dev && opts.token === undefined;
  if (generatedToken) opts = { ...opts, token: generatedWalletToken(opts.dataDir) };
  if (!opts.dev && !opts.password) throw new Error("wallet vault password is required");
  if (!opts.dev) ensurePrivateDirectory(opts.dataDir, "wallet data directory");
  const vault = opts.dev ? undefined : await openKeystore(opts.dataDir, opts.password!);
  let database: WalletDatabase | undefined;
  try {
    database = opts.dev ? await openMemoryWalletDatabase()
      : await openNodeWalletDatabase(inventoryPath(opts.dataDir), { cipher: vault!.storageCipher });
    const service = await startWalletServerWithDatabase(opts, database, vault, logger);
    try {
      if (generatedToken) saveWalletConnection(opts.dataDir, { url: service.url, token: opts.token! });
    } catch (error) {
      await service.close();
      throw error;
    }
    const closed = service.closed.then(async () => {
      try { await database!.close(); } finally { vault?.close(); }
    });
    return {
      ...service,
      closed,
      close: async () => {
        try { await service.close(); } finally { await closed; }
      },
    };
  } catch (error) {
    try { await database?.close(); } finally { vault?.close(); }
    throw error;
  }
}

async function startWalletServerWithDatabase(
  opts: ServeOptions,
  database: WalletDatabase,
  vault: Awaited<ReturnType<typeof openKeystore>> | undefined,
  logger: LoggerContext,
): Promise<WalletServer> {
  const metrics = opts.metricsAddr === undefined
    ? undefined
    : createPrometheusWalletMetrics();
  const node = new PcashNodeClient(opts.rpc);
  const network = networkConfigFromStatus(await node.status());
  const selectedSession = opts.selectedRelayerUrl === undefined
    ? undefined : await SelectedRelayHttpClient.connect(opts.selectedRelayerUrl);
  const provers = createWalletProvers(opts.prover);
  const configuredL1Key = opts.l1KeyFile === undefined ? opts.l1Key : parseL1KeyFile(opts.l1KeyFile);
  const l1PrivateKey = configuredL1Key === undefined
    ? undefined
    : fixedHex(configuredL1Key, 32, "L1 private key");
  const journals = createServiceRelayJournals({
    dataDir: opts.dataDir, dev: opts.dev, node,
    ...(opts.l1Rpc === undefined ? {} : { l1Rpc: opts.l1Rpc }),
  });
  const recovery = async () => journals.recovery;
  const gasAddress = l1PrivateKey === undefined ? undefined
    : addressHex(privateKeyPcashActionSigner(fromHexSized(l1PrivateKey, 32, "L1 private key")).address);
  const makeSubmitter = (privateKey: string, address: string, l1RpcOverride?: string) => {
    const rpcUrl = l1RpcOverride ?? opts.l1Rpc;
    if (rpcUrl === undefined) {
      throw new RelayValidationError(
        "L1 submission requires --l1-rpc. Configure it and fund the Ethereum account paying gas, or explicitly choose --submit mempool",
      );
    }
    const { journal, runExclusive } = journals.forAddress(address);
    return new PrivateKeyRelaySubmitter({
      rpcUrl, privateKey, node, journal, runExclusive,
      ...(opts.maxFeePerGas === undefined ? {} : { maxFeePerGas: opts.maxFeePerGas }),
    });
  };
  const profiles = new Map<string, PcashProfile>();
  const profileFor = (wallet?: string): PcashProfile => selectServedWallet(profiles, wallet);
  const relay = new Relayer({
    node,
    payoutRecipient: async () => profileFor(opts.payoutWallet),
    submitterFor: (l1RpcOverride) => {
      if (l1PrivateKey === undefined) throw new RelayValidationError("relay requires a configured gas key; use --l1-key-file or PCASH_WALLET_L1_KEY");
      return makeSubmitter(l1PrivateKey, gasAddress!, l1RpcOverride);
    },
    minValuePerByte: opts.minValuePerByte,
  });
  type RuntimeIdentity = { profile: PcashProfile; privateKey: Uint8Array };
  const identities: { address: string; identity: RuntimeIdentity }[] = [];
  const devSigningKeys = new Map<string, string>();
  const keystore: Keystore = vault?.store ?? { wallets: [] };
  for (const stored of keystore.wallets) {
    const identity = deriveSeedWalletIdentity(stored.mnemonic, network);
    if (addressHex(identity.profile.address) !== stored.address) throw new Error("wallet vault address does not match its recovery phrase");
    identities.push({ address: stored.address, identity });
  }
  if (opts.dev) {
    const dev = devAnvilWallet();
    const privateKey = fromHexSized(dev.privateKey, 32, "development key");
    identities.push({ address: dev.address, identity: { privateKey, profile: derivePcashProfileFromPrivateKey(privateKey, network) } });
  }
  const buildRuntime = async (identity: RuntimeIdentity): Promise<Wallet> => {
    try {
      if (opts.dev && identity.profile.recoveryContract !== "seed-derived") {
        devSigningKeys.set(addressHex(identity.profile.address), toHex(identity.privateKey));
      }
      return await Wallet[OPEN_WALLET_INTERNAL]({
        node, database, profile: identity.profile,
        signer: privateKeyPcashActionSigner(identity.privateKey),
        provers,
        submission: awaitingAcceptance({ ...createMempoolSubmissionAdapter(node), l1Recovery: recovery }, { node }),
        ...(metrics === undefined ? {} : { metrics }),
      });
    } finally {
      identity.privateKey.fill(0);
    }
  };
  const runtimes = await buildWalletRegistry(identities, ({ identity }) => buildRuntime(identity));
  for (const { address, identity } of identities) profiles.set(address, identity.profile);
  metrics?.setLoadedAccounts(runtimes.size);
  const activateWallet = createWalletActivator();

  const runtimeFor = (wallet?: string): Wallet => selectServedWallet(runtimes, wallet);

  const walletSubmitterFor = (l1RpcOverride?: string, wallet?: string) => {
    if (l1PrivateKey !== undefined) return makeSubmitter(l1PrivateKey, gasAddress!, l1RpcOverride);
    const address = addressHex(profileFor(wallet).address);
    const stored = keystore.wallets.find(candidate => candidate.address === address);
    if (stored !== undefined) {
      const { privateKey } = deriveSeedWalletIdentity(stored.mnemonic, network);
      try { return makeSubmitter(toHex(privateKey), address, l1RpcOverride); }
      finally { privateKey.fill(0); }
    }
    return makeSubmitter(devSigningKeys.get(address)!, address, l1RpcOverride);
  };

  const submissionFor = serviceSubmissionFor({
    node,
    ...(opts.l1Rpc === undefined ? {} : { l1Rpc: opts.l1Rpc }),
    daMode: opts.daMode,
    submitterFor: walletSubmitterFor,
    profileFor,
    recovery,
  });
  const optionalOpenFeeAmount = (body: Record<string, unknown>): bigint | undefined => {
    if (body.openFeeAmount === undefined) return undefined;
    if (typeof body.openFeeAmount !== "string" || !/^(0|[1-9][0-9]*)$/.test(body.openFeeAmount)) {
      throw new RelayValidationError("openFeeAmount must be a decimal string");
    }
    return BigInt(body.openFeeAmount);
  };
  const publishesReceiveKey = (body: Record<string, unknown>): boolean => {
    if (body.receiveKey === undefined) return false;
    if (body.receiveKey !== "replace") throw new RelayValidationError("receiveKey expects replace");
    return true;
  };

  const publishWallet = (wallet: StoredWallet | undefined, profile: PcashProfile, runtime: Wallet): void => {
    const previous = keystore.wallets;
    if (wallet !== undefined) keystore.wallets = [...previous.filter((item) => item.address !== wallet.address), wallet];
    try {
      vault?.save();
    } catch (error) {
      keystore.wallets = previous;
      throw error;
    }
    profiles.set(runtime.address, profile);
    runtimes.set(runtime.address, runtime);
    metrics?.setLoadedAccounts(runtimes.size);
  };

  const follow = (runtime: Wallet): void => {
    runtime.startSync({ intervalMs: opts.scanIntervalMs });
  };

  const updateReceiveKey = async (
    wallet: string | undefined,
    body: Record<string, unknown>,
    pair: ReturnType<typeof generateMlKemKeyPair>,
  ) => {
    const runtime = runtimeFor(wallet);
    const openFeeAmount = optionalOpenFeeAmount(body);
    const submission = submissionFor(body, wallet);
    const published = publishesReceiveKey(body)
      ? await runtime.updateAccount({
          receiveKey: { operation: "replace", keyPair: pair },
          ...(openFeeAmount === undefined ? {} : { openFeeAmount }),
          ...privateRelayTerms(body, selectedSession),
          submission,
          userAccountCreationSubmission: accountCreationSubmission(submissionFor, body, wallet, recovery),
        })
      : await runtime.importReceiveKey(pair).then(() => undefined);
    return {
      receiveKeyHash: receiveKeyHashHex(pair),
      syncedThrough: (await runtime.snapshot()).syncedThrough,
      ...(published === undefined ? {} : { published }),
    };
  };

  const { host, port } = parseListen(opts.listen);
  const requests = createRequestDrain();
  const server = createServer((request, response) => {
    void requests.track(handleWalletHttp(request, response, {
      logger,
      node,
      relay,
      relayJournal: journals.recovery,
      ...(metrics === undefined ? {} : { metrics }),
      ...(opts.token === undefined ? {} : { token: opts.token }),
      runtimeFor,
      listWallets: () => [...runtimes.keys()].map(address => ({ address })),
      submissionFor,
      ...(selectedSession === undefined ? {} : { selectedRelayQuote: selectedSession }),
      async sync(wallet, full) {
        const runtime = runtimeFor(wallet);
        return runtime.sync(full ? { rescan: true } : {});
      },
      async importWallet(body) {
        let identity: RuntimeIdentity;
        let stored: StoredWallet | undefined;
        if (typeof body.mnemonic === "string" && validateWalletMnemonic(body.mnemonic)) {
          const mnemonic = normalizeWalletMnemonic(body.mnemonic);
          identity = deriveSeedWalletIdentity(mnemonic, network);
          stored = { address: addressHex(identity.profile.address), mnemonic };
        } else if (opts.dev && typeof body.keyFile === "string") {
          const privateKey = parsePrivateKeyFile(body.keyFile);
          identity = { privateKey, profile: derivePcashProfileFromPrivateKey(privateKey, network) };
        } else {
          throw new RelayValidationError("wallet import requires a valid 24-word recovery phrase");
        }
        const address = addressHex(identity.profile.address);
        const runtime = await activateWallet(
          address,
          () => runtimes.get(address),
          () => buildRuntime(identity),
          (value) => publishWallet(stored, identity.profile, value),
          opts.scanIntervalMs,
          () => { devSigningKeys.delete(address); metrics?.removeAccount(address); },
        );
        return {
          address: runtime.address,
          ethereumFundingAddress: gasAddress ?? runtime.address,
          l1ChainId: network.l1ChainId.toString(),
          pcashChainId: network.pcashChainId.toString(),
          syncedThrough: (await runtime.snapshot()).syncedThrough,
        };
      },
      async createReceiveKey(wallet, body) {
        if (profileFor(wallet).recoveryContract === "seed-derived") throw new RelayValidationError("seed wallets use one recoverable receive key; rotation is not supported");
        return updateReceiveKey(wallet, body, generateMlKemKeyPair());
      },
      async importReceiveKey(wallet, body) {
        if (profileFor(wallet).recoveryContract === "seed-derived") throw new RelayValidationError("seed wallets do not import receive keys");
        if (typeof body.file !== "string") {
          throw new RelayValidationError("receive-key import requires file");
        }
        return updateReceiveKey(wallet, body, parseReceiveKeyFile(body.file));
      },
      async listReceiveKeys(wallet) {
        const runtime = runtimeFor(wallet);
        return {
          address: runtime.address,
          receiveKeys: await runtime.receiveKeys(),
        };
      },
    })).catch(() => undefined);
  });

  let metricsServer: Awaited<ReturnType<typeof startWalletMetricsServer>> | undefined;
  try {
    const listeners = await startWalletServiceListeners({
      server,
      host,
      port,
      wallets: runtimes.values(),
      ...(metrics === undefined || opts.metricsAddr === undefined ? {} : {
        metrics: { recorder: metrics, address: opts.metricsAddr },
      }),
      onListening: () => {
        for (const runtime of runtimes.values()) follow(runtime);
      },
    });
    metricsServer = listeners.metricsServer;
    metrics?.setServiceHealth(true);
  } catch (error) {
    metrics?.setServiceHealth(false);
    metrics?.setLoadedAccounts(0);
    throw error;
  }
  const bound = server.address();
  const boundPort = typeof bound === "object" && bound !== null ? bound.port : port;

  let resolveClosed: () => void = () => undefined;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closePromise === undefined) {
      closePromise = (async () => {
        metrics?.setServiceHealth(false);
        try {
          await closeWalletRegistryAfterRequests((async () => {
            const results = await Promise.allSettled([
              closeServer(server),
              ...(metricsServer === undefined ? [] : [metricsServer.close()]),
            ]);
            await requests.drain();
            const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
            if (failure !== undefined) throw failure.reason;
          })(), runtimes);
        } finally {
          profiles.clear();
          devSigningKeys.clear();
          metrics?.setLoadedAccounts(0);
          process.off("SIGINT", onStop);
          process.off("SIGTERM", onStop);
        }
      })();
      void closePromise.then(resolveClosed, resolveClosed);
    }
    return closePromise;
  };
  const onStop = () => {
    void close().catch((error: unknown) => {
      logger.error(`wallet shutdown failed: ${errorMessage(error)}`);
    });
  };
  process.on("SIGINT", onStop);
  process.on("SIGTERM", onStop);
  return {
    close,
    closed,
    url: loopbackUrl(host, boundPort),
    ...(metricsServer === undefined ? {} : { metricsUrl: metricsServer.url }),
  };
}

export async function main(argv: readonly string[]): Promise<number> {
  let options: ServeOptions;
  try {
    options = parseServeArgs(argv);
  } catch (error) {
    const logger = new Logger("info");
    await logger.open();
    logger.error(errorMessage(error));
    return 2;
  }
  const logger = new Logger({ level: options.logLevel, filename: options.logFile });
  await logger.open();
  try {
    if (options.dev) logger.warning(DEV_MODE_WARNING);
    if (!options.dev && options.password === undefined) {
      options.password = await promptSecret("Wallet vault password: ");
      if (!existsSync(keystorePath(options.dataDir))) {
        const confirmation = await promptSecret("Confirm wallet vault password: ");
        if (confirmation !== options.password) throw new Error("passwords do not match");
      }
    }
    const service = await startWalletServer(options, logger.context("wallet"));
    logger.info(`pcash-wallet listening on ${service.url}`);
    if (!options.dev) logger.info(`Wallet data directory: ${options.dataDir}`);
    const connectionFlags = options.dev || options.token !== undefined ? ` --wallet-url ${service.url}`
      : ` --data-dir ${shellArgument(options.dataDir)}`;
    logger.info(`Next: pcash-wallet-cli wallet list${connectionFlags}`);
    logger.info(`Create a wallet: pcash-wallet-cli wallet create${connectionFlags}`);
    if (options.token !== undefined) logger.info("Set the same PCASH_WALLET_TOKEN in the CLI terminal; the explicit token is not saved for discovery.");
    if (service.metricsUrl !== undefined) {
      logger.info(`pcash-wallet metrics on ${service.metricsUrl}/metrics`);
    }
    await service.closed;
    return 0;
  } catch (error) {
    logger.error(errorMessage(error));
    return 1;
  } finally {
    await logger.close();
  }
}

function shellArgument(value: string): string {
  return "'" + value.replaceAll("'", "'\"'\"'") + "'";
}
