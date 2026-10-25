import { spawn } from "node:child_process";
import { randomInt } from "node:crypto";
import { constants as osConstants, tmpdir } from "node:os";
import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setupAnvilMulticall3 } from "./multicall3.mjs";
import { Config } from "../../sdk/src/bcfg/index.ts";
import { Logger } from "../../sdk/src/blgr/index.ts";
import { PCASH_CHAIN_ID, INBOX_ADDRESS } from "../../sdk/src/constants/networkProfile.ts";
import { toolRoot } from "../../sdk/src/node/toolchain.ts";

const logger = new Logger("info");
await logger.open();

export type DevService = "anvil" | "node" | "wallet" | "relayer" | "web";

export interface NodeStatus {
  pcashChainId: string;
  genesisHash: string;
  l1ChainId: string;
  genesisL1Block: string;
  genesisL1BlockHash: string;
}

export interface LaunchPlan {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

export interface LaunchContext {
  genesisHash?: string;
  l1ChainId?: string;
  nodeStatus?: NodeStatus;
}

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "../..");
const DEFAULT_ANVIL_RPC = "http://127.0.0.1:8545";
const DEFAULT_NODE_RPC = "http://127.0.0.1:8645";
const DEFAULT_CHAIN_ID = PCASH_CHAIN_ID.toString();
const RPC_WAIT_TIMEOUT_MS = 30_000;
const RPC_REQUEST_TIMEOUT_MS = 3_000;

export interface RpcWaitOptions {
  timeoutMs?: number;
  requestTimeoutMs?: number;
  intervalMs?: number;
  fetch?: typeof fetch;
}

class RpcRequestError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable: boolean, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "RpcRequestError";
    this.retryable = retryable;
  }
}

function settings(env: NodeJS.ProcessEnv): Config {
  const config = new Config("pcash");
  config.load({ env });
  return config;
}

function required(config: Config, key: string): string {
  const configured = config.str(key);
  if (configured === null) {
    throw new Error(`PCASH_${key.toUpperCase().replace(/-/g, "_")} is required when using a configured L1 RPC`);
  }
  return configured;
}

export function parseDevService(input: string | undefined): DevService {
  if (input === "anvil" || input === "node" || input === "wallet" || input === "relayer" || input === "web") {
    return input;
  }
  throw new Error("development service expects anvil, node, wallet, relayer, or web");
}

function parseAnvilChainId(value: string): string {
  if (!/^(0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error("--anvil-chain-id must be a nonnegative safe integer; 0 selects a random chain ID");
  }
  return value;
}

export function anvilChainId(value: string): string {
  const id = parseAnvilChainId(value);
  return id === "0" ? randomInt(0x4000_0000, 0x8000_0000).toString() : id;
}

const DEV_OPTIONS: Record<DevService, readonly string[]> = {
  anvil: ["anvil-chain-id"],
  node: [],
  wallet: [],
  relayer: [],
  web: ["marketplace", "web-fresh"],
};

export function parseDevOptions(
  service: DevService,
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): { marketplace: boolean; fresh: boolean; chainId?: string } {
  const config = new Config("pcash");
  config.load({ argv: ["node", "run.mts", ...args], env });
  const known = new Set(DEV_OPTIONS[service].map((flag) => flag.replace(/-/g, "")));
  if (config.argv.length > 0 || Object.keys(config.args).some((key) => !known.has(key))) {
    throw new Error("anvil accepts --anvil-chain-id=<integer>; web accepts --marketplace and --web-fresh; other services accept no options");
  }
  const chainId = service === "anvil" ? config.str("anvil-chain-id") : null;
  return {
    marketplace: service === "web" && config.bool("marketplace", false),
    fresh: service === "web" && config.bool("web-fresh", false),
    ...(chainId === null ? {} : { chainId: parseAnvilChainId(chainId) }),
  };
}

export function usesLocalAnvil(env: NodeJS.ProcessEnv): boolean {
  return settings(env).str("l1-rpc") === null;
}

function anvilRpc(config: Config): string {
  return config.str("anvil-rpc-url", DEFAULT_ANVIL_RPC);
}

function withL1Rpc(config: Config): string {
  return config.str("l1-rpc") ?? anvilRpc(config);
}

function circuitBundleCommand(args: readonly string[]): { command: string; args: string[] } {
  return {
    command: process.execPath,
    args: [join(REPO_ROOT, "scripts/circuits/bundle.mjs"), "exec", "--", ...args],
  };
}

function hostAndPort(address: string): { host: string; port: string } {
  const separator = address.lastIndexOf(":");
  if (separator <= 0 || separator === address.length - 1) {
    throw new Error("PCASH_WEB_ADDR must have the form host:port");
  }
  return { host: address.slice(0, separator), port: address.slice(separator + 1) };
}

function assertBrowserSafeAnvilRpc(rpcUrl: string): void {
  const hostname = new URL(rpcUrl).hostname;
  if (hostname !== "127.0.0.1" && hostname !== "localhost" && hostname !== "::1" && hostname !== "[::1]") {
    throw new Error("PCASH_BROWSER_L1_RPC_URLS is required for non-loopback Anvil and must be safe to expose to browsers");
  }
}

export function createLaunchPlan(
  service: DevService,
  sourceEnv: NodeJS.ProcessEnv = process.env,
  context: LaunchContext = {},
): LaunchPlan {
  const config = settings(sourceEnv);
  const env = { ...sourceEnv };
  if (service === "anvil") {
    const rpcUrl = anvilRpc(config);
    const parsed = new URL(rpcUrl);
    if (
      !["127.0.0.1", "localhost", "::1", "[::1]"].includes(parsed.hostname)
      || parsed.port === ""
    ) {
      throw new Error("PCASH_ANVIL_RPC_URL must be an explicit loopback URL with a port");
    }
    return {
      command: "anvil",
      args: [
        "--port", parsed.port,
        "--chain-id", anvilChainId(config.str("anvil-chain-id", "0")),
        "--block-time", config.str("anvil-block-time", "1"),
        "--slots-in-an-epoch", config.str("anvil-slots-in-epoch", "1"),
      ],
      env,
    };
  }

  const localAnvil = config.str("l1-rpc") === null;
  if (service === "node" || service === "wallet" || service === "relayer") {
    env[`PCASH_${service.toUpperCase()}_DEV`] = config.str(`${service}-dev`, localAnvil ? "true" : "false");
  }
  if (service === "node") {
    const l1Rpc = withL1Rpc(config);
    // A named network compiles in its whole identity, and the node rejects any
    // identity variable alongside PCASH_NETWORK, so none is supplied here.
    const network = config.str("network");
    if (network !== null && localAnvil) {
      throw new Error("PCASH_NETWORK names a public network; set PCASH_L1_RPC to its L1 execution node");
    }
    env.PCASH_L1_RPC = l1Rpc;
    env.PCASH_BEACON_API = localAnvil ? l1Rpc : required(config, "beacon-api");
    let l1ChainId: string | null = null;
    if (network === null) {
      l1ChainId = localAnvil
        ? BigInt(context.l1ChainId!).toString(10)
        : (config.str("l1-chain-id") ?? (context.l1ChainId === undefined
          ? required(config, "l1-chain-id")
          : BigInt(context.l1ChainId).toString(10)));
      env.PCASH_L1_CHAIN_ID = l1ChainId;
      env.PCASH_CHAIN_ID = config.str("chain-id", DEFAULT_CHAIN_ID);
      env.PCASH_INBOX_ADDRESS = config.str("inbox-address", `0x${INBOX_ADDRESS.toString(16).padStart(40, "0")}`);
      env.PCASH_GENESIS_L1_BLOCK = localAnvil
        ? "0"
        : required(config, "genesis-l1-block");
      env.PCASH_GENESIS_L1_BLOCK_HASH = localAnvil
        ? context.genesisHash
        : required(config, "genesis-l1-block-hash");
    }
    const defaultDataRoot = config.str("dev-root", join(REPO_ROOT, ".cache/pcash/dev/anvil"));
    env.PCASH_DATA_DIR = localAnvil
      ? config.str("anvil-data-dir", join(defaultDataRoot, `${l1ChainId}-${context.genesisHash!.slice(2).toLowerCase()}`, "node"))
      : config.str("data-dir", join(REPO_ROOT, ".cache/pcash", network === null ? "sepolia-node" : `${network}-node`));
    env.PCASH_RPC_ADDR = config.str("rpc-addr", "127.0.0.1:8645");
    env.PCASH_ADMIN_ADDR = config.str("admin-addr", "127.0.0.1:8647");
    env.PCASH_PSCAN_ADDR = config.str("pscan-addr", "127.0.0.1:8648");
    env.PCASH_METRICS_ADDR = config.str("metrics-addr", "127.0.0.1:9465");
    env.PCASH_ENABLE_CATALOG = config.str("enable-catalog", "true");
    env.PCASH_PBOARD = config.str("pboard", "true");
    env.PCASH_ENABLE_SOURCE_SUBMISSIONS = config.str("enable-source-submissions", "true");
    env.PCASH_ENABLE_CONFIGURATION_OPENING_SUBMISSIONS = config.str("enable-configuration-opening-submissions", "true");
    const webAddress = hostAndPort(config.str("web-addr", "127.0.0.1:5173"));
    env.PCASH_PROVER_ASSETS_BASE_URL = config.str(
      "prover-assets-base-url",
      `http://${webAddress.host}:${webAddress.port}/`,
    );
    env.PCASH_PROVER_ASSETS_MANIFEST = config.str(
      "prover-assets-manifest",
      join(REPO_ROOT, "assets/browser-prover-release.json"),
    );
    env.PCASH_TOOL_ROOT = toolRoot();
    env.PCASH_SOURCE_VERIFICATION_REPRODUCER = config.str(
      "source-verification-reproducer",
      join(REPO_ROOT, "scripts/source-verification/index.mts"),
    );
    const release = config.str("node-profile", "debug") === "release" ? ["--release"] : [];
    const command = circuitBundleCommand([
      "cargo", "run", ...release, "-p", "pcash-node", "--bin", "pcash-node",
    ]);
    return { ...command, env };
  }

  if (service === "wallet" || service === "relayer") {
    // Each service reads only its own namespace, so wire it to the shared endpoints here.
    const l1Rpc = withL1Rpc(config);
    const nodeRpc = config.str("rpc-url", DEFAULT_NODE_RPC);
    const status = context.nodeStatus!;
    const dataRoot = join(
      config.str("dev-root", join(REPO_ROOT, ".cache/pcash/dev")),
      `${BigInt(status.l1ChainId)}-${status.genesisHash.slice(2).toLowerCase()}`,
    );
    if (service === "wallet") {
      env.PCASH_WALLET_L1_RPC = config.str("wallet-l1-rpc", l1Rpc);
      env.PCASH_WALLET_RPC_URL = config.str("wallet-rpc-url", nodeRpc);
      env.PCASH_WALLET_LISTEN = config.str("wallet-listen", "127.0.0.1:8745");
      env.PCASH_WALLET_METRICS_ADDR = config.str("wallet-metrics-addr", "127.0.0.1:9470");
      env.PCASH_WALLET_DATA_DIR = config.str("wallet-data-dir", join(dataRoot, "wallet"));
      env.PCASH_WALLET_PROVER = config.str("wallet-prover", "native");
      env.PCASH_WALLET_DA_MODE = config.str("wallet-da-mode", localAnvil ? "calldata" : "auto");
      return {
        command: "npm",
        args: [
          "run", "pcash-wallet", "--workspace", "@pcash/wallet", "--", "serve",
        ],
        env,
      };
    }
    env.PCASH_RELAYER_L1_RPC = config.str("relayer-l1-rpc", l1Rpc);
    env.PCASH_RELAYER_RPC_URL = config.str("relayer-rpc-url", nodeRpc);
    env.PCASH_RELAYER_HTTP_ADDR = config.str("relayer-http-addr", "127.0.0.1:9464");
    env.PCASH_RELAYER_JOURNAL_PATH = config.str("relayer-journal-path", join(dataRoot, "relayer/journal.json"));
    env.PCASH_RELAYER_DA_MODE = config.str("relayer-da-mode", "calldata");
    env.PCASH_RELAYER_SPONSOR_UNPAID = config.str("relayer-sponsor-unpaid", "false");
    return {
      command: "npm",
      args: [
        "run", "pcash-relayer", "--workspace", "@pcash/relayer", "--", "serve",
      ],
      env,
    };
  }

  env.PCASH_RPC_URL = config.str("rpc-url", DEFAULT_NODE_RPC);
  if (localAnvil) {
    const rpcUrl = anvilRpc(config);
    const browserRpcs = config.str("browser-l1-rpc-urls");
    if (browserRpcs === null) assertBrowserSafeAnvilRpc(rpcUrl);
    env.PCASH_BROWSER_L1_RPC_URLS = browserRpcs ?? rpcUrl;
  } else {
    env.PCASH_BROWSER_L1_RPC_URLS = required(config, "browser-l1-rpc-urls");
  }
  const status = context.nodeStatus!;
  // RPC quantities are hexadecimal; browser environment chain IDs are decimal.
  const l1ChainId = BigInt(status.l1ChainId).toString(10);
  env.PCASH_CHAIN_ID = BigInt(status.pcashChainId).toString(10);
  env.PCASH_L1_CHAIN_ID = l1ChainId;
  env.PCASH_GENESIS_HASH = status.genesisHash;
  env.PCASH_PSCAN_URL = config.str("pscan-url", "http://127.0.0.1:8648");
  env.PCASH_REQUIRE_PROVER_ASSETS = "1";
  const address = hostAndPort(config.str("web-addr", "127.0.0.1:5173"));
  const command = circuitBundleCommand([
    "npm", "run", "dev", "--workspace", "@pcash/web", "--",
    "--host", address.host, "--port", address.port, "--strictPort",
  ]);
  return { ...command, env };
}

function transportErrorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const candidate = error as { code?: unknown; cause?: unknown; errors?: unknown };
  if (typeof candidate.code === "string") return candidate.code;
  const fromCause = transportErrorCode(candidate.cause);
  if (fromCause !== undefined) return fromCause;
  if (Array.isArray(candidate.errors)) {
    for (const nested of candidate.errors) {
      const code = transportErrorCode(nested);
      if (code !== undefined) return code;
    }
  }
  return undefined;
}

function retryableTransportError(error: unknown): boolean {
  const name = error instanceof Error ? error.name : "";
  if (name === "AbortError" || name === "TimeoutError") return true;
  return ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH"]
    .includes(transportErrorCode(error) ?? "");
}

async function jsonRpc<T>(
  url: string,
  method: string,
  params: readonly unknown[],
  requestTimeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<T> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
  } catch (error) {
    const code = transportErrorCode(error);
    throw new RpcRequestError(
      `${method} request failed: ${error instanceof Error ? error.message : String(error)}${code === undefined ? "" : ` (${code})`}`,
      retryableTransportError(error),
      error,
    );
  }
  if (!response.ok) {
    throw new RpcRequestError(
      `${method} returned HTTP ${response.status}`,
      response.status === 429 || response.status === 502 || response.status === 503 || response.status === 504,
    );
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    throw new RpcRequestError(`${method} returned malformed JSON`, false, error);
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new RpcRequestError(`${method} returned a malformed JSON-RPC response`, false);
  }
  const rpc = payload as { result?: T; error?: { message?: string } };
  if (rpc.error !== undefined) throw new RpcRequestError(rpc.error.message || `${method} failed`, false);
  if (!("result" in rpc)) throw new RpcRequestError(`${method} response has no result`, false);
  return rpc.result as T;
}

export async function waitForJsonRpc<T>(
  url: string,
  method: string,
  params: readonly unknown[] = [],
  options: RpcWaitOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? RPC_WAIT_TIMEOUT_MS;
  const requestTimeoutMs = options.requestTimeoutMs ?? RPC_REQUEST_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? 250;
  if (timeoutMs < 1 || requestTimeoutMs < 1 || intervalMs < 1) {
    throw new Error("RPC readiness deadlines and intervals must be positive");
  }
  const deadline = Date.now() + timeoutMs;
  let lastError: RpcRequestError | undefined;
  do {
    try {
      return await jsonRpc<T>(
        url,
        method,
        params,
        Math.min(requestTimeoutMs, Math.max(1, deadline - Date.now())),
        options.fetch ?? fetch,
      );
    } catch (error) {
      if (!(error instanceof RpcRequestError) || !error.retryable) throw error;
      lastError = error;
    }
    if (Date.now() < deadline) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, Math.min(intervalMs, deadline - Date.now())));
    }
  } while (Date.now() < deadline);
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${method}; last error: ${lastError?.message ?? "unknown"}`,
    { cause: lastError });
}

export async function assertBrowserL1Identity(
  rpcUrl: string,
  status: NodeStatus,
  options: RpcWaitOptions = {},
): Promise<void> {
  const l1RpcChainId = await waitForJsonRpc<string>(rpcUrl, "eth_chainId", [], options);
  if (BigInt(l1RpcChainId) !== BigInt(status.l1ChainId)) {
    throw new Error(`browser L1 RPC chain ${BigInt(l1RpcChainId)} does not match node L1 chain ${status.l1ChainId}`);
  }
  const blockNumber = `0x${BigInt(status.genesisL1Block).toString(16)}`;
  const anchor = await waitForJsonRpc<{ hash?: string } | null>(
    rpcUrl,
    "eth_getBlockByNumber",
    [blockNumber, false],
    options,
  );
  const hash = anchor?.hash?.toLowerCase();
  if (hash !== status.genesisL1BlockHash.toLowerCase()) {
    throw new Error(`browser L1 RPC anchor ${hash ?? "<missing>"} does not match node anchor ${status.genesisL1BlockHash}`);
  }
}

async function prepare(service: DevService, env: NodeJS.ProcessEnv): Promise<void> {
  if (settings(env).bool("dev-prepared", false) || service === "anvil") return;
  if (service === "node" || service === "wallet") await runChecked("just", ["tools"], env);
  if (service === "wallet" || service === "relayer" || service === "web") {
    await runChecked("npm", ["run", "build:packages"], env);
  }
}

function runChild(command: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolveExit, reject) => {
    const child = spawn(command, [...args], { cwd: REPO_ROOT, env, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code !== null) resolveExit(code);
      else resolveExit(128 + (signal === null ? 0 : (osConstants.signals[signal] ?? 0)));
    });
  });
}

async function runChecked(command: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<void> {
  const code = await runChild(command, args, env);
  if (code !== 0) throw new Error(`${command} exited with code ${code}`);
}

export async function prepareWebMarketplace(
  env: NodeJS.ProcessEnv,
  localAnvil: boolean,
  suppliedTooling?: typeof import("../../marketplace/src/tooling/paymentRouterSetup.mts"),
): Promise<NodeJS.ProcessEnv> {
  const config = settings(env);
  const explicitAddress = config.str("payment-router-address");
  if (!localAnvil && explicitAddress === null) {
    throw new Error("--marketplace requires PCASH_PAYMENT_ROUTER_ADDRESS when PCASH_L1_RPC is configured; automatic deployment is local-Anvil only");
  }
  if (localAnvil && explicitAddress === null) {
    const hostname = new URL(withL1Rpc(config)).hostname;
    if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(hostname)) {
      throw new Error("automatic PaymentRouter deployment requires a loopback Anvil RPC");
    }
  }
  // Load package exports after prepare() has built the workspaces.
  const tooling = suppliedTooling ?? await import("@pcash/marketplace/tooling/paymentRouterSetup");
  const ready = await tooling.setupPaymentRouter({
    rpcUrl: withL1Rpc(config),
    l1ChainId: BigInt(required(config, "l1-chain-id")),
    cacheRoot: tooling.localPaymentRouterCacheRoot(REPO_ROOT, config.str("dev-root") ?? undefined),
    ...(explicitAddress === null ? { routerConfig: {
      feeRecipient: config.str("payment-router-fee-recipient", tooling.LOCAL_PAYMENT_ROUTER_CONFIG.feeRecipient),
      feeBps: Number(config.str("payment-router-fee-bps", String(tooling.LOCAL_PAYMENT_ROUTER_CONFIG.feeBps))),
    } } : {}),
    explicitAddress: explicitAddress ?? undefined,
    ...(localAnvil ? { privateKey: tooling.LOCAL_PAYMENT_ROUTER_KEY } : {}),
  });
  logger.context("web").info(`PaymentRouter ${ready.source}: ${ready.address} (fee recipient ${ready.routerConfig.feeRecipient}, ${ready.routerConfig.feeBps} bps).`);
  const { PCASH_PAYMENT_ROUTER_FEE_RECIPIENT: _feeRecipient, PCASH_PAYMENT_ROUTER_FEE_BPS: _feeBps, ...websiteEnv } = env;
  return { ...websiteEnv, PCASH_PAYMENT_ROUTER_ADDRESS: ready.address };
}

/** Register the reusable escrow source before serving the local marketplace. */
export async function prepareMarketplaceSource(
  env: NodeJS.ProcessEnv,
  localAnvil: boolean,
  run: typeof runChecked = runChecked,
): Promise<void> {
  // External registries are published by their operator using source:publish.
  if (!localAnvil) return;
  const adminUrl = `http://${settings(env).str("admin-addr", "127.0.0.1:8647")}`;
  // The admin listener is unauthenticated; automatic dev setup targets loopback only.
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(new URL(adminUrl).hostname)) {
    throw new Error("automatic escrow source publication requires a loopback PCASH_ADMIN_ADDR");
  }
  const scratch = await mkdtemp(join(tmpdir(), "pcash-marketplace-source-"));
  const bundle = join(scratch, "bundle");
  const script = join(REPO_ROOT, "scripts/source-verification/index.mts");
  try {
    await run(process.execPath, [script, "build", "--definition", "marketplace/src/tooling/sourceVerification.mts", "--out", bundle], env);
    await run(process.execPath, [script, "publish", "--bundle", bundle, "--admin-url", adminUrl], env);
    logger.context("web").info("Escrow claim/reclaim source registered with local Pscan.");
  } finally {
    logger.context("web").info(`Source preparation artifacts: ${scratch}`);
  }
}

function announceLocalLaunch(): void {
  logger.context("node").info("Empty genesis; issuance begins at the canonical anchor.");
}

export async function runDevService(service: DevService, sourceEnv: NodeJS.ProcessEnv = process.env, marketplace = false): Promise<number> {
  const env = { ...sourceEnv };
  const config = settings(env);
  const localAnvil = config.str("l1-rpc") === null;
  if (service === "node") logger.context("node").info(localAnvil
    ? "Using local Anvil; set PCASH_L1_RPC to use an existing execution node."
    : "Using the execution node configured by PCASH_L1_RPC.");
  await prepare(service, env);
  const context: LaunchContext = {};
  if (service === "node") {
    const rpcUrl = withL1Rpc(config);
    context.l1ChainId = await waitForJsonRpc<string>(rpcUrl, "eth_chainId", [], { timeoutMs: 5 * 60_000 });
    if (localAnvil) {
      const genesis = await waitForJsonRpc<{ hash?: string }>(rpcUrl, "eth_getBlockByNumber", ["0x0", false]);
      const genesisHash = genesis.hash ?? "";
      if (!/^0x[0-9a-fA-F]{64}$/.test(genesisHash)) throw new Error("Anvil genesis block has no valid hash");
      context.genesisHash = genesisHash;
    }
  }
  if (service === "wallet" || service === "relayer" || service === "web") {
    const rpcUrl = config.str("rpc-url", DEFAULT_NODE_RPC);
    const status = await waitForJsonRpc<{
      pcashChainId?: unknown;
      genesisHash?: unknown;
      l1ChainId?: unknown;
      genesisL1Block?: unknown;
      genesisL1BlockHash?: unknown;
    }>(rpcUrl, "pcash_status");
    if (
      status.pcashChainId === undefined
      || typeof status.genesisHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(status.genesisHash)
      || status.l1ChainId === undefined
      || status.genesisL1Block === undefined
      || typeof status.genesisL1BlockHash !== "string"
    ) {
      throw new Error("pcash_status response is missing chain identity");
    }
    context.nodeStatus = {
      pcashChainId: String(status.pcashChainId),
      genesisHash: status.genesisHash,
      l1ChainId: String(status.l1ChainId),
      genesisL1Block: String(status.genesisL1Block),
      genesisL1BlockHash: status.genesisL1BlockHash,
    };
  }
  const plan = createLaunchPlan(service, env, context);
  if (service === "anvil") logger.context("anvil").info(`Chain ID ${plan.args[plan.args.indexOf("--chain-id") + 1]}`);
  if (service === "node" && localAnvil) announceLocalLaunch();
  if (service === "web") {
    // The browser may read from any endpoint in the list, so each must serve the node's L1.
    const browserRpcs = settings(plan.env).array("browser-l1-rpc-urls")!;
    await Promise.all(browserRpcs.map((browserRpc) => assertBrowserL1Identity(browserRpc, context.nodeStatus!)));
    if (localAnvil) {
      await setupAnvilMulticall3((method, params) => waitForJsonRpc(anvilRpc(config), method, params));
      logger.context("web").info("Multicall3 installed on local Anvil.");
    }
    if (marketplace) {
      const deploymentRpc = withL1Rpc(config);
      if (!browserRpcs.includes(deploymentRpc)) {
        await assertBrowserL1Identity(deploymentRpc, context.nodeStatus!);
      }
      await runChecked("just", ["_solidity-dependencies"], plan.env);
      plan.env = await prepareWebMarketplace(plan.env, localAnvil);
      await prepareMarketplaceSource(plan.env, localAnvil);
    }
  }
  return runChild(plan.command, plan.args, plan.env);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  Promise.resolve().then(() => {
    const service = parseDevService(process.argv[2]);
    const options = parseDevOptions(service, process.argv.slice(3));
    return runDevService(service, {
      ...process.env,
      PCASH_WEB_FRESH: String(options.fresh),
      ...(options.chainId === undefined ? {} : { PCASH_ANVIL_CHAIN_ID: options.chainId }),
    }, options.marketplace);
  }).then(
    (code) => { process.exitCode = code; },
    (error: unknown) => {
      logger.error(`Development service failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    },
  );
}
