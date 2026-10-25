import { homedir } from "node:os";
import { join } from "node:path";
import { Config } from "@pcash/sdk/bcfg";
import { Logger } from "@pcash/sdk/blgr";
import { relayBatchCapacity, type RelayDaMode } from "@pcash/sdk/relay";

export type RelayerCommand =
  | { kind: "relay"; contentHashes: string[] }
  | { kind: "wallet-status" }
  | { kind: "submit-batch"; inputPath: string }
  | { kind: "serve"; pollIntervalMs: number; httpAddr: string }
  | { kind: "journal-show" }
  | { kind: "help" }
  | { kind: "version" };

export interface RelayerCliOptions {
  rpcUrl: string;
  l1Rpc: string;
  journalPath: string;
  l1Key?: string;
  dev: boolean;
  nodeRpcTimeoutMs: number;
  daMode: RelayDaMode;
  maxWaitMs?: bigint;
  maxBatchBytes: bigint;
  maxTransactions: number;
  minValuePerByte: bigint;
  selectedMinPrivateFee: bigint;
  selectedMaxQuoteLifetimeSeconds: bigint;
  maxPages: number;
  sponsorUnpaid: boolean;
  issuanceHaircutBps: number;
  gasLimit?: bigint;
  maxFeePerGas?: bigint;
  receiptTimeoutMs: number;
  receiptPollMs?: number;
  observationPollMs: number;
  observationTimeoutMs: number;
  logLevel: string;
  logFile?: string;
  command: RelayerCommand;
}

export const USAGE = `Usage: pcash-relayer <command> [arguments] [options]

Commands:
  relay [CONTENT_HASH...] Run one policy or explicit relay cycle
  submit-batch [path]     Submit an ordered JSON array of raw transactions,
                          read from stdin when no path is given
  serve                   Run serial relay cycles and operator HTTP
  journal show            Print the journal's in-flight L1 transactions
  wallet-status           Restore and show ordinary fee-note inventory

Options:
  --rpc-url <url>         PCASH node RPC
  --l1-rpc <url>          Ethereum JSON-RPC
  --journal-path <dir>    Durable broadcast journal directory
  --dev                   Use an in-memory journal and default to Anvil account 1
  --da-mode <mode>        auto, calldata, or blob
  --max-wait-ms <n>       Take ready transactions this old first, ignoring the
                          byte floor; unpaid ones still need --sponsor-unpaid
  --max-batch-bytes <n>   Exact batch-byte cap
  --max-transactions <n>  Transaction cap (1 through 64)
  --min-value-per-byte <n> PCASH publication cost per transaction byte; fee plus
                          discounted expected issuance must cover it
  --selected-min-private-fee <n> Minimum private PCASH payment for selected relay
                          (default 0.01 PCASH)
  --selected-max-quote-lifetime-seconds <n> Maximum selected quote lifetime
                          (default 3600, maximum 86400)
  --issuance-haircut-bps <n> Discount on expected issuance, 0 through 10000
                          (default 5000); fees are never discounted
  --max-pages <n>         Mempool pages per cycle
  --sponsor-unpaid        Also relay transactions that pay this relayer nothing or
                          fall below the byte floor
  --gas-limit <n>         Fixed L1 gas limit
  --max-fee-per-gas <n>   EIP-1559 fee cap in wei
  --receipt-timeout-ms <n>
  --receipt-poll-interval-ms <n>
  --observation-poll-interval-ms <n>
  --observation-timeout-ms <n>
  --rpc-timeout-secs <n>  Per-request node RPC timeout
  --poll-interval-ms <n>  Delay between serve cycles
  --http-addr <host:port> Operator HTTP bind address
  --log-level <level>     none, error, warning, info, debug, or spam
                          (default info)
  --log-file <path>       Also write logs to this file, rotated at 20 MiB
  --help
  --version

submit-batch exits 0 when every item succeeds, 3 after a canonical partial
result, 2 for invalid CLI/input, and 1 for submission or observation failure.

Each option above also reads PCASH_RELAYER_<OPTION>, for example
PCASH_RELAYER_L1_RPC for --l1-rpc; --help and --version are command-line only.
The L1 signing key is read only from PCASH_RELAYER_L1_KEY.`;

const SETTINGS = [
  "rpc-url", "l1-rpc", "journal-path", "dev", "rpc-timeout-secs", "da-mode", "max-wait-ms", "max-batch-bytes",
  "max-transactions", "min-value-per-byte", "selected-min-private-fee", "selected-max-quote-lifetime-seconds",
  "issuance-haircut-bps", "max-pages", "sponsor-unpaid", "gas-limit", "max-fee-per-gas", "receipt-timeout-ms",
  "receipt-poll-interval-ms", "observation-poll-interval-ms", "observation-timeout-ms", "poll-interval-ms",
  "http-addr", "log-level", "log-file",
];
const OPERANDS = ["help", "version"];

function integer(value: string | null, fallback: string, flag: string, allowZero = false): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || (allowZero ? parsed < 0 : parsed < 1)) {
    throw new Error(`--${flag} must be ${allowZero ? "a nonnegative" : "a positive"} integer`);
  }
  return parsed;
}

function amount(value: string | null, fallback: string, flag: string, allowZero = true): bigint {
  let parsed: bigint;
  try { parsed = BigInt(value ?? fallback); } catch { throw new Error(`--${flag} must be an unsigned integer`); }
  if (parsed < 0n || (!allowZero && parsed === 0n)) {
    throw new Error(`--${flag} must be ${allowZero ? "nonnegative" : "positive"}`);
  }
  return parsed;
}

function contentHash(value: string): string {
  const body = value.trim().replace(/^0[xX]/, "");
  if (!/^[0-9a-fA-F]{64}$/.test(body)) {
    throw new Error("content hash must be 32 bytes (64 hex characters)");
  }
  return `0x${body.toLowerCase()}`;
}

export function parseRelayerArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): RelayerCliOptions {
  // Per-command operands come only from the command line; settings also read PCASH_RELAYER_*.
  const operands = new Config("pcash-relayer");
  operands.load({ argv: ["node", "pcash-relayer", ...argv] });
  const known = new Set([...SETTINGS, ...OPERANDS].map((flag) => flag.replace(/-/g, "")));
  for (const key of Object.keys(operands.args)) {
    if (!known.has(key)) throw new Error(`unknown option --${key}`);
  }
  const config = new Config("pcash-relayer");
  config.load({ argv: ["node", "pcash-relayer", ...argv], env });
  const positionals = operands.argv;
  // Booleans first: a bare flag before the command consumes it as its value.
  const dev = config.bool("dev", false);
  const sponsorUnpaid = config.bool("sponsor-unpaid", false);
  const mode = config.str("da-mode", "auto");
  if (mode !== "auto" && mode !== "calldata" && mode !== "blob") {
    throw new Error("--da-mode expects auto, calldata, or blob");
  }
  const maxTransactions = integer(config.str("max-transactions"), "64", "max-transactions");
  if (maxTransactions > 64) throw new Error("--max-transactions must be between 1 and 64");
  const maxBatchBytes = amount(
    config.str("max-batch-bytes"),
    relayBatchCapacity(6).toString(),
    "max-batch-bytes",
    false,
  );
  if (maxBatchBytes > relayBatchCapacity(6)) {
    throw new Error(`--max-batch-bytes must be between 1 and ${relayBatchCapacity(6)}`);
  }
  let command: RelayerCommand;
  if (operands.bool("help", false)) command = { kind: "help" };
  else if (operands.bool("version", false)) command = { kind: "version" };
  else if (positionals[0] === "wallet-status") {
    if (positionals.length !== 1) throw new Error("unexpected wallet command arguments");
    command = { kind: positionals[0] };
  }
  else if (positionals[0] === "relay") {
    command = { kind: "relay", contentHashes: positionals.slice(1).map(contentHash) };
  }
  else if (positionals[0] === "submit-batch") {
    if (positionals.length > 2) throw new Error("submit-batch accepts one input path, or reads stdin without one");
    command = { kind: "submit-batch", inputPath: positionals[1] ?? "-" };
  }
  else if (positionals[0] === "serve") {
    if (positionals.length !== 1) throw new Error("serve does not accept positional arguments");
    command = {
      kind: "serve",
      pollIntervalMs: integer(config.str("poll-interval-ms"), "5000", "poll-interval-ms", true),
      httpAddr: config.str("http-addr", "127.0.0.1:9464"),
    };
  } else if (positionals[0] === "journal" && positionals[1] === "show" && positionals.length === 2) {
    command = { kind: "journal-show" };
  } else {
    throw new Error("expected relay, submit-batch, serve, wallet-status, or journal show");
  }
  const l1Key = config.str("l1-key");
  const maxWait = config.str("max-wait-ms");
  const receiptPoll = config.str("receipt-poll-interval-ms");
  const gasLimit = config.str("gas-limit");
  const maxFee = config.str("max-fee-per-gas");
  const issuanceHaircutBps = integer(config.str("issuance-haircut-bps"), "5000", "issuance-haircut-bps", true);
  if (issuanceHaircutBps > 10_000) throw new Error("--issuance-haircut-bps must be between 0 and 10000");
  const selectedMaxQuoteLifetimeSeconds = amount(
    config.str("selected-max-quote-lifetime-seconds"),
    "3600", "selected-max-quote-lifetime-seconds", false,
  );
  if (selectedMaxQuoteLifetimeSeconds > 86_400n) {
    throw new Error("--selected-max-quote-lifetime-seconds must be at most 86400");
  }
  const logLevel = config.str("log-level", "info").toLowerCase();
  if (!Logger.levelsByVal.includes(logLevel)) {
    throw new Error(`--log-level expects ${Logger.levelsByVal.join(", ")}`);
  }
  const logFile = config.str("log-file");
  return {
    rpcUrl: config.str("rpc-url", "http://127.0.0.1:8645"),
    l1Rpc: config.str("l1-rpc", "http://127.0.0.1:8545"),
    journalPath: config.str("journal-path", join(homedir(), ".pcash", "relay-operator-journal")),
    ...(l1Key === null ? {} : { l1Key }),
    dev,
    nodeRpcTimeoutMs: integer(config.str("rpc-timeout-secs"), "30", "rpc-timeout-secs") * 1_000,
    daMode: mode === "blob" ? "blobs" : mode,
    ...(maxWait === null ? {} : { maxWaitMs: amount(maxWait, "0", "max-wait-ms") }),
    maxBatchBytes,
    maxTransactions,
    minValuePerByte: amount(config.str("min-value-per-byte"), "0", "min-value-per-byte"),
    selectedMinPrivateFee: amount(config.str("selected-min-private-fee"), "10000000000000000", "selected-min-private-fee"),
    selectedMaxQuoteLifetimeSeconds,
    maxPages: integer(config.str("max-pages"), "41", "max-pages"),
    sponsorUnpaid,
    issuanceHaircutBps,
    ...(gasLimit === null ? {} : { gasLimit: amount(gasLimit, "0", "gas-limit", false) }),
    ...(maxFee === null ? {} : { maxFeePerGas: amount(maxFee, "0", "max-fee-per-gas", false) }),
    receiptTimeoutMs: integer(config.str("receipt-timeout-ms"), "300000", "receipt-timeout-ms"),
    ...(receiptPoll === null ? {} : { receiptPollMs: integer(receiptPoll, "0", "receipt-poll-interval-ms") }),
    observationPollMs: integer(config.str("observation-poll-interval-ms"), "2000", "observation-poll-interval-ms"),
    observationTimeoutMs: integer(config.str("observation-timeout-ms"), "120000", "observation-timeout-ms"),
    logLevel,
    ...(logFile === null ? {} : { logFile }),
    command,
  };
}
