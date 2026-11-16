// Argument parsing for the stateless wallet HTTP client.
import { defaultWalletDataDir } from "../connection.ts";
import { Config } from "@pcash/sdk/bcfg";
import { applicationSchemaId, MAX_RECORD_BYTES } from "@pcash/sdk/delivery";
import { fromHex, toHex } from "@pcash/sdk/utils";

type SubmitPath = "mempool" | "l1" | "selected";
type WaitMode = "latest" | "finalized" | "none";
type RelayDaMode = "auto" | "calldata" | "blobs";

const DEFAULT_WALLET_URL = "http://127.0.0.1:8745";

const CLI_OPTIONS = {
  json: { type: "boolean" },
  wait: { type: "string" },
  "data-dir": { type: "string" },
  full: { type: "boolean" },
  "wallet-url": { type: "string" },
  wallet: { type: "string" },
  "key-file": { type: "string" },
  "seed-file": { type: "string" },
  dev: { type: "boolean" },
  "receive-key": { type: "string" },
  file: { type: "string" },
  to: { type: "string" },
  name: { type: "string" },
  symbol: { type: "string" },
  decimals: { type: "string" },
  supply: { type: "string" },
  amount: { type: "string" },
  memo: { type: "string" },
  "include-sender": { type: "boolean" },
  record: { type: "string", multiple: true },
  "self-record": { type: "string", multiple: true },
  "public-record": { type: "string", multiple: true },
  submit: { type: "string" },
  "l1-rpc": { type: "string" },
  "wallet-token": { type: "string" },
  fee: { type: "string" },
  "private-relay-fee": { type: "string" },
  "retry-content-hash": { type: "string" },
  cursor: { type: "string" },
  limit: { type: "string" },
  kind: { type: "string" },
  "min-fee": { type: "string" },
  "max-blobs": { type: "string" },
  "no-submit": { type: "boolean" },
  calldata: { type: "boolean" },
  blobs: { type: "boolean" },
  "transaction-hash": { type: "string" },
  "job-id": { type: "string" },
  "chunk-index": { type: "string" },
  "max-transactions": { type: "string" },
  "target-notes": { type: "string" },
  "asset-id": { type: "string" },
  "content-digest": { type: "string" },
  "note-secret": { type: "string" },
  definition: { type: "string" },
  shape: { type: "string" },
} as const;

const COMMON_FLAGS = ["wallet-url", "json", "wallet-token", "data-dir"] as const;
const WALLET_FLAGS = [...COMMON_FLAGS, "wallet"] as const;
const SUBMISSION_FLAGS = ["submit", "l1-rpc", "private-relay-fee", "wait"] as const;
const HASH_32_PATTERN = /^0x[0-9a-fA-F]{64}$/;

type Flag = keyof typeof CLI_OPTIONS;
type CommandDefinition = {
  flags: readonly Flag[];
  description: string;
  example: string;
  group: "Everyday use" | "Wallet management" | "Advanced";
  operands?: "one" | "many";
};

export const COMMAND_DEFINITIONS = {
  status: { flags: WALLET_FLAGS, description: "Show network, sync, balances and pending actions", example: "status", group: "Everyday use" },
  balance: { flags: WALLET_FLAGS, description: "Show private and spendable balances in atomic units", example: "balance", group: "Everyday use" },
  receive: { flags: WALLET_FLAGS, description: "Print the complete receive code", example: "receive", group: "Everyday use" },
  send: { flags: [...WALLET_FLAGS, ...SUBMISSION_FLAGS, "to", "amount", "fee", "shape", "memo", "include-sender", "record", "self-record", "public-record"], description: "Send PCASH (amounts and fees are atomic units)", example: "send --to <receive-code> --amount 10", group: "Everyday use" },
  sync: { flags: [...WALLET_FLAGS, "full"], description: "Synchronize with the node; normally automatic", example: "sync", group: "Everyday use" },
  "account ensure": { flags: [...WALLET_FLAGS, ...SUBMISSION_FLAGS, "fee"], description: "Register or update the account to match this wallet; registration defaults to L1 publication, or the mempool when the service runs with --network-privacy tor", example: "account ensure", group: "Wallet management" },
  "wallet create": { flags: COMMON_FLAGS, description: "Generate a recovery phrase and verify its backup in a terminal", example: "wallet create", group: "Wallet management" },
  "wallet import": { flags: [...COMMON_FLAGS, "seed-file", "dev", "key-file"], description: "Restore a 24-word phrase from hidden input or a private local seed file", example: "wallet import", group: "Wallet management" },
  "wallet list": { flags: COMMON_FLAGS, description: "List loaded wallet addresses", example: "wallet list", group: "Wallet management" },
  "asset create": { flags: [...WALLET_FLAGS, ...SUBMISSION_FLAGS, "name", "symbol", "supply", "decimals", "content-digest", "fee", "retry-content-hash", "asset-id"], description: "Create a private standard asset", example: "asset create --name Example --symbol EX --supply 100 --content-digest <0x32-bytes>", group: "Advanced" },
  "asset list": { flags: WALLET_FLAGS, description: "List standard assets", example: "asset list", group: "Advanced" },
  "asset send": { flags: [...WALLET_FLAGS, ...SUBMISSION_FLAGS, "asset-id", "to", "amount", "note-secret", "file", "fee", "retry-content-hash"], description: "Send an asset to a recipient or outputs from a JSON file", example: "asset send --asset-id <field> --to <receive-code> --amount 10", group: "Advanced" },
  "asset burn": { flags: [...WALLET_FLAGS, ...SUBMISSION_FLAGS, "asset-id", "amount", "fee", "retry-content-hash"], description: "Burn standard asset units", example: "asset burn --asset-id <field> --amount 10", group: "Advanced" },
  "asset import": { flags: [...WALLET_FLAGS, "definition"], description: "Import a standard asset definition", example: "asset import --definition <share-text-or-link>", group: "Advanced" },
  "bulk start": { flags: [...WALLET_FLAGS, "file"], description: "Approve a durable bulk job; execution is a separate step", example: "bulk start --file job.json", group: "Advanced" },
  "bulk consolidate": { flags: [...WALLET_FLAGS, "fee", "max-transactions", "target-notes", "asset-id", "shape"], description: "Approve consolidation with an explicit transaction budget", example: "bulk consolidate --max-transactions 10", group: "Advanced" },
  "bulk show": { flags: WALLET_FLAGS, description: "Inspect durable bulk jobs", example: "bulk show", group: "Advanced" },
  "bulk step": { flags: [...WALLET_FLAGS, ...SUBMISSION_FLAGS, "job-id", "chunk-index"], description: "Execute a step of an approved bulk job", example: "bulk step --job-id <id>", group: "Advanced" },
  "receive-key list": { flags: WALLET_FLAGS, description: "List receive keys", example: "receive-key list", group: "Advanced" },
  "receive-key create": { flags: [...WALLET_FLAGS, ...SUBMISSION_FLAGS, "receive-key", "fee"], description: "Create a receive key (development wallets only; seed wallets have one fixed key)", example: "receive-key create", group: "Advanced" },
  "receive-key import": { flags: [...WALLET_FLAGS, ...SUBMISSION_FLAGS, "receive-key", "fee", "file"], description: "Import a receive key (development wallets only)", example: "receive-key import --file <server-local-key.json>", group: "Advanced" },
  mempool: { flags: [...COMMON_FLAGS, "cursor", "limit", "kind", "min-fee"], description: "List the mempool or inspect a content hash", example: "mempool", group: "Advanced", operands: "one" },
  relay: { flags: [...COMMON_FLAGS, "l1-rpc", "no-submit", "calldata", "blobs", "max-blobs"], description: "Build and optionally publish an L1 batch", example: "relay --no-submit", group: "Advanced", operands: "many" },
  "relay-journal show": { flags: COMMON_FLAGS, description: "Inspect in-flight L1 transactions", example: "relay-journal show", group: "Advanced" },
  "relay-journal reconcile": { flags: COMMON_FLAGS, description: "Reconcile in-flight L1 transactions", example: "relay-journal reconcile", group: "Advanced" },
  "relay-journal resolve": { flags: [...COMMON_FLAGS, "transaction-hash"], description: "Resolve one exact L1 transaction", example: "relay-journal resolve --transaction-hash <hash>", group: "Advanced" },
} as const satisfies Record<string, CommandDefinition>;
type CommandPath = keyof typeof COMMAND_DEFINITIONS;
type RootCommand<T extends string> = T extends `${infer Root} ${string}` ? Root : T;
type CommandName = RootCommand<CommandPath>;

const FLAG_HELP: Record<Flag, string> = {
  json: "Emit compact JSON; errors are JSON on stderr",
  wait: "<accepted|finalized|none> Receipt wait (default accepted; L1 requires acceptance)",
  "data-dir": "<path> Local connection directory (default ~/.pcash/wallet; PCASH_WALLET_DATA_DIR)",
  "wallet-url": "<url> Override the discovered wallet endpoint (PCASH_WALLET_URL)",
  "wallet-token": "<token> Explicit bearer token (PCASH_WALLET_TOKEN)",
  wallet: "<address> Select a wallet when several are loaded",
  full: "Rescan chain history",
  "key-file": "<path> Server-local private JSON test key (requires --dev)",
  "seed-file": "<path> Local recovery phrase file, owned by you with mode 0600",
  dev: "Import a test signing key into a disposable --dev service",
  "receive-key": "<replace> Publish the new key; development wallets only",
  file: "<path> Input JSON file (receive-key files are server-local)",
  to: "<recipient> Receive code or registered address",
  amount: "<atomic-units> Payment amount; native PCASH allows 0 (no recipient note)",
  fee: "<atomic-units> Public fee, including 0; default is suggested for relay, zero for L1",
  memo: "<text> Text encrypted to the recipient, including with amount 0",
  "include-sender": "Include an unverified sender claim",
  record: `<schema>=<value> Repeatable application record encrypted to the recipient; use a namespaced schema or record ID and hex bytes or @file (max ${MAX_RECORD_BYTES} bytes)`,
  "self-record": "<schema>=<value> Repeatable application record encrypted to this wallet; hex bytes or @file",
  "public-record": "<schema>=<value> Repeatable application record visible to everyone; hex bytes or @file",
  submit: "<mempool|l1|selected> Publication path (default mempool, except initial registration: l1 unless the service runs with --network-privacy tor)",
  "l1-rpc": "<url> Override the server's Ethereum RPC for this request",
  "private-relay-fee": "<atomic-units> Positive private fee required for --submit selected",
  "retry-content-hash": "<hash> Retry the journaled asset action's exact bytes and quote",
  name: "<name> Asset name", symbol: "<symbol> Asset symbol",
  decimals: "<count> Asset decimal places (default 0)", supply: "<atomic-units> Initial asset supply",
  "content-digest": "<0x32-bytes> Content digest; use 64 zero hex digits for none",
  "asset-id": "<field> Asset identity; with asset create, reprove an expired creation",
  "note-secret": "<field> Explicit asset output note secret",
  definition: "<share-text-or-link> Asset definition",
  cursor: "<hash> Pagination cursor", limit: "<count> Maximum entries",
  kind: "<kind> Mempool transaction kind", "min-fee": "<atomic-units> Minimum open fee",
  "no-submit": "Show a prepared batch and quotes without publishing",
  calldata: "Force calldata carrier", blobs: "Force blob carrier",
  "max-blobs": "<1-6> Maximum batch capacity (default 3)",
  "transaction-hash": "<hash> Exact Ethereum transaction hash",
  "job-id": "<id> Approved bulk job", "chunk-index": "<index> Specific bulk chunk",
  "max-transactions": "<count> Explicit consolidation budget",
  "target-notes": "<count> Target consolidated note count", shape: "<S|L> Proof shape",
};

const definitions: Record<string, CommandDefinition> = COMMAND_DEFINITIONS;
export function cliHelp(path: readonly string[] = []): string {
  const name = path.join(" ");
  const definition = definitions[name];
  if (definition !== undefined) {
    return `Usage: pcash-wallet-cli ${name}${definition.operands ? " [content-hash" + (definition.operands === "many" ? "..." : "") + "]" : ""} [options]\n\n${definition.description}\n\nOptions:\n`
      + definition.flags.map(flag => `  --${flag} ${FLAG_HELP[flag]}`).join("\n")
      + `\n  -h, --help Show this help\n\nExample:\n  pcash-wallet-cli ${definition.example}\n`;
  }
  const entries = Object.entries(definitions).filter(([key]) => name === "" || key.startsWith(name + " "));
  if (entries.length === 0) throw new Error(`unknown command "${name}"; run pcash-wallet-cli --help`);
  let help = `Usage: pcash-wallet-cli ${name === "" ? "<command>" : name + " <subcommand>"} [options]\n`;
  for (const group of ["Everyday use", "Wallet management", "Advanced"] as const) {
    const commands = entries.filter(([, value]) => value.group === group);
    if (commands.length) help += `\n${group}:\n` + commands.map(([key, value]) => `  ${key.padEnd(24)} ${value.description}`).join("\n") + "\n";
  }
  if (name === "") help += `\nStart here:\n  pcash-wallet --l1-rpc <ethereum-rpc-url>\n  pcash-wallet-cli wallet create\n  # Fund the displayed Ethereum address, then:\n  pcash-wallet-cli account ensure\n\nOver Tor, with no Ethereum account:\n  pcash-wallet --network-privacy tor --rpc-url <https-or-onion-node-url>\n  pcash-wallet-cli wallet create\n  pcash-wallet-cli account ensure\n\nUse --json for scripts. Use --data-dir for a custom local connection.\n`;
  return help + `\nRun pcash-wallet-cli ${name ? name + " <subcommand>" : "<command>"} --help for options and an example.\n`;
}
export const CLI_USAGE = cliHelp();

/** One record: its schema ID, and its bytes as hex or a local file the client reads. */
export type RecordInput = { schema: string; data: string } | { schema: string; file: string };

export interface Cli {
  command: CommandName;
  subcommand?: "ensure" | "import" | "list" | "create" | "show" | "reconcile" | "resolve" | "start" | "step" | "consolidate" | "send" | "burn";
  shape?: 0 | 1;
  jobId?: string;
  chunkIndex?: number;
  maxTransactions?: number;
  targetNotes?: number;
  assetId?: bigint;
  url: string;
  explicitUrl: boolean;
  dataDir: string;
  json: boolean;
  token?: string;
  wallet?: string;
  keyFile?: string;
  seedFile?: string;
  dev: boolean;
  publishReceiveKey: boolean;
  file?: string;
  to?: string;
  amount?: bigint;
  memo?: string;
  includeSender: boolean;
  /** Records by audience; `to` joins --memo and --include-sender for the --to recipient. */
  records: { to: RecordInput[]; self: RecordInput[]; public: RecordInput[] };
  assetName?: string;
  assetSymbol?: string;
  assetDecimals?: number;
  assetSupply?: bigint;
  assetContentDigest?: string;
  noteSecret?: bigint;
  definition?: string;
  fee?: bigint;
  privateRelayFee?: bigint;
  retryContentHash?: string;
  /** Absent lets the service choose: L1 for initial registration (the mempool in Tor mode) and the mempool for updates and transfers. */
  submit?: SubmitPath;
  l1Rpc?: string;
  waitMode: WaitMode;
  full: boolean;
  mempoolContentHash?: string;
  cursor?: string;
  limit?: number;
  kind?: string;
  minOpenFee?: bigint;
  relayContentHashes: string[];
  noSubmit: boolean;
  daMode: RelayDaMode;
  maxBlobs: number;
  transactionHash?: string;
}

function parseBig(value: string, flag: string): bigint {
  try {
    return BigInt(value);
  } catch {
    throw new Error(`--${flag} expects an integer, got "${value}"`);
  }
}

export function tokenize(argv: readonly string[]): {
  positionals: string[];
  flags: Record<string, string | true | string[]>;
} {
  const names = new Map(Object.keys(CLI_OPTIONS).map((name) => [name.replace(/-/g, ""), name as keyof typeof CLI_OPTIONS]));
  // bcfg keeps one value per option, so repeatable options are taken out before it parses the rest.
  const repeated: Record<string, string[]> = {};
  const rest: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const match = /^--([^=]+)(?:=(.*))?$/s.exec(argv[index]!);
    const name = match === null ? undefined : names.get(match[1]!.replace(/-/g, ""));
    if (name === undefined || !("multiple" in CLI_OPTIONS[name])) {
      rest.push(argv[index]!);
      continue;
    }
    const found = match![2] ?? argv[++index];
    if (found === undefined) throw new Error(`--${name} requires a value`);
    (repeated[name] ??= []).push(found);
  }
  const args = new Config("pcash");
  args.load({ argv: ["node", "pcash-wallet-cli", ...rest] });
  const flags: Record<string, string | true | string[]> = {};
  for (const key of Object.keys(args.args)) {
    const name = names.get(key);
    if (name === undefined) throw new Error(`unknown option --${key}`);
    if (CLI_OPTIONS[name].type === "string") flags[name] = args.str(key)!;
    else if (args.bool(key)) flags[name] = true;
  }
  return { positionals: args.argv, flags: { ...flags, ...repeated } };
}

function value(flags: Record<string, string | true | string[]>, name: string): string | undefined {
  const found = flags[name];
  return typeof found === "string" ? found : undefined;
}

/** Each `<schema>=<value>`: an application name or record ID, then hex bytes or `@` and a file path. */
function records(flags: Record<string, string | true | string[]>, flag: string): RecordInput[] {
  const entries = flags[flag];
  return (Array.isArray(entries) ? entries : []).map((entry) => {
    const split = entry.indexOf("=");
    if (split < 0) throw new Error(`--${flag} expects <schema>=<value>`);
    const label = entry.slice(0, split), content = entry.slice(split + 1);
    const schema = label.startsWith("0x") ? label.toLowerCase() : applicationSchemaId(label);
    return content.startsWith("@") ? { schema, file: content.slice(1) } : { schema, data: toHex(fromHex(content, `--${flag} ${label}`)) };
  });
}

function requirePositionals(positionals: string[], expected: number, usage: string): void {
  if (positionals.length !== expected) throw new Error(`usage: ${usage}`);
}

function requireAllowedFlags(
  flags: Record<string, string | true | string[]>,
  allowed: readonly string[],
  command: string,
): void {
  const allowedSet = new Set(allowed);
  const invalid = Object.keys(flags).find((name) => !allowedSet.has(name));
  if (invalid !== undefined) throw new Error(`--${invalid} is not valid for ${command}`);
}

export function parseCli(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): Cli {
  const { positionals, flags } = tokenize(argv);
  const settings = new Config("pcash");
  settings.load({ argv: ["node", "pcash-wallet-cli", ...argv], env });
  const command = positionals[0] as CommandName | undefined;
  const roots = new Set(Object.keys(definitions).map(path => path.split(" ")[0]));
  if (command === undefined || !roots.has(command)) throw new Error(`unknown command "${command ?? ""}"; run pcash-wallet-cli --help`);
  const nested = definitions[command] === undefined;
  const path = nested ? `${command} ${positionals[1] ?? ""}` : command;
  const definition = definitions[path];
  if (definition === undefined) throw new Error(`usage: pcash-wallet-cli ${command} <subcommand>; run pcash-wallet-cli ${command} --help`);
  const subcommand = nested ? positionals[1] as Cli["subcommand"] : undefined;
  const count = nested ? 2 : 1;
  if (definition.operands === undefined) requirePositionals(positionals, count, `pcash-wallet-cli ${path} [options]`);
  else if (definition.operands === "one" && positionals.length > count + 1) throw new Error(`usage: pcash-wallet-cli ${path} [content-hash]`);
  if (definition.operands !== undefined && positionals.slice(count).some(hash => !HASH_32_PATTERN.test(hash))) {
    throw new Error(`${command} content hash must be a 32-byte 0x-prefixed hex string`);
  }
  requireAllowedFlags(flags, definition.flags, path);
  const wait = value(flags, "wait") ?? "accepted";
  if (!["accepted", "finalized", "none"].includes(wait)) throw new Error("--wait expects accepted, finalized, or none");
  const submit = value(flags, "submit");
  if (submit !== undefined && submit !== "mempool" && submit !== "l1" && submit !== "selected") throw new Error("--submit expects mempool, l1, or selected");
  if (submit === "l1" && wait === "none") throw new Error("--submit l1 requires --wait accepted or finalized");
  const receiveKey = value(flags, "receive-key");
  if (receiveKey !== undefined && receiveKey !== "replace") {
    throw new Error("--receive-key expects replace");
  }

  const amountValue = value(flags, "amount");
  const feeValue = value(flags, "fee");
  const amount = amountValue === undefined ? undefined : parseBig(amountValue, "amount");
  const fee = feeValue === undefined ? undefined : parseBig(feeValue, "fee");
  const privateRelayFeeValue = value(flags, "private-relay-fee");
  const privateRelayFee = privateRelayFeeValue === undefined ? undefined : parseBig(privateRelayFeeValue, "private-relay-fee");
  if (amount !== undefined && amount < 0n) throw new Error("--amount must be nonnegative");
  if (fee !== undefined && fee < 0n) throw new Error("--fee must be nonnegative");
  if (submit === "selected") {
    if (privateRelayFee === undefined || privateRelayFee <= 0n) throw new Error("--submit selected requires a positive --private-relay-fee");
    if (fee !== undefined && fee !== 0n) throw new Error("--submit selected cannot carry a public --fee");
    if (value(flags, "l1-rpc") !== undefined) throw new Error("--submit selected uses the public PCASH mempool");
    if (command === "receive-key" && receiveKey !== "replace") {
      throw new Error("--submit selected on receive-key requires --receive-key replace");
    }
  } else if (privateRelayFee !== undefined) throw new Error("--private-relay-fee requires --submit selected");
  const token = settings.str("wallet-token");
  const wallet = value(flags, "wallet");
  const keyFile = value(flags, "key-file");
  const seedFile = value(flags, "seed-file");
  const file = value(flags, "file");
  const to = value(flags, "to");
  const memo = value(flags, "memo");
  const l1Rpc = value(flags, "l1-rpc");
  const limitValue = value(flags, "limit");
  const limit = limitValue === undefined ? undefined : Number(limitValue);
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) {
    throw new Error("--limit must be a positive integer");
  }
  const minOpenFeeValue = value(flags, "min-fee");
  const minOpenFee = minOpenFeeValue === undefined ? undefined : parseBig(minOpenFeeValue, "min-fee");
  if (minOpenFee !== undefined && minOpenFee < 0n) throw new Error("--min-fee must be nonnegative");
  if (flags.calldata === true && flags.blobs === true) {
    throw new Error("--calldata and --blobs are mutually exclusive");
  }
  const maxBlobsValue = value(flags, "max-blobs");
  const maxBlobs = maxBlobsValue === undefined ? 3 : Number(maxBlobsValue);
  if (!Number.isInteger(maxBlobs) || maxBlobs < 1 || maxBlobs > 6) {
    throw new Error("--max-blobs must be an integer from 1 through 6");
  }
  const cursor = value(flags, "cursor");
  const kind = value(flags, "kind");
  const transactionHash = value(flags, "transaction-hash");
  const retryContentHash = value(flags, "retry-content-hash");
  if (retryContentHash !== undefined && !HASH_32_PATTERN.test(retryContentHash)) throw new Error("--retry-content-hash must be a 32-byte 0x-prefixed hash");
  if (transactionHash !== undefined && !HASH_32_PATTERN.test(transactionHash)) {
    throw new Error("--transaction-hash must be a 32-byte 0x-prefixed hex string");
  }

  const cli: Cli = {
    command,
    ...(subcommand === undefined ? {} : { subcommand }),
    url: settings.str("wallet-url", DEFAULT_WALLET_URL),
    explicitUrl: settings.str("wallet-url") !== null,
    dataDir: value(flags, "data-dir") ?? env.PCASH_WALLET_DATA_DIR ?? defaultWalletDataDir(),
    json: flags.json === true,
    dev: flags.dev === true,
    publishReceiveKey: receiveKey === "replace",
    ...(submit === undefined ? {} : { submit }),
    waitMode: wait === "accepted" ? "latest" : wait as WaitMode,
    full: flags.full === true,
    includeSender: flags["include-sender"] === true,
    records: { to: records(flags, "record"), self: records(flags, "self-record"), public: records(flags, "public-record") },
    relayContentHashes: command === "relay" ? positionals.slice(1) : [],
    noSubmit: flags["no-submit"] === true,
    daMode: flags.calldata === true ? "calldata" : flags.blobs === true ? "blobs" : "auto",
    maxBlobs,
    ...(transactionHash === undefined ? {} : { transactionHash }),
    ...(retryContentHash === undefined ? {} : { retryContentHash }),
    ...(token === null ? {} : { token }),
    ...(wallet === undefined ? {} : { wallet }),
    ...(keyFile === undefined ? {} : { keyFile }),
    ...(seedFile === undefined ? {} : { seedFile }),
    ...(file === undefined ? {} : { file }),
    ...(to === undefined ? {} : { to }),
    ...(amount === undefined ? {} : { amount }),
    ...(memo === undefined ? {} : { memo }),
    ...(fee === undefined ? {} : { fee }),
    ...(privateRelayFee === undefined ? {} : { privateRelayFee }),
    ...(l1Rpc === undefined ? {} : { l1Rpc }),
    ...(command === "mempool" && positionals[1] !== undefined ? { mempoolContentHash: positionals[1] } : {}),
    ...(cursor === undefined ? {} : { cursor }),
    ...(limit === undefined ? {} : { limit }),
    ...(kind === undefined ? {} : { kind }),
    ...(minOpenFee === undefined ? {} : { minOpenFee }),
  };
  const asset = value(flags, "asset-id");
  if (asset !== undefined) cli.assetId = parseBig(asset, "asset-id");
  if (command === "asset" && subcommand === "create") {
    const assetName = value(flags, "name"), assetSymbol = value(flags, "symbol");
    const supply = value(flags, "supply");
    if (!assetName || !assetSymbol || supply === undefined) throw new Error("asset create requires --name, --symbol and --supply");
    cli.assetName = assetName; cli.assetSymbol = assetSymbol;
    cli.assetSupply = parseBig(supply, "supply");
    cli.assetDecimals = Number(value(flags, "decimals") ?? "0");
    if (cli.assetSupply <= 0n || !Number.isInteger(cli.assetDecimals) || cli.assetDecimals < 0 || cli.assetDecimals > 255) throw new Error("invalid asset supply or decimals");
    const contentDigest = value(flags, "content-digest");
    if (contentDigest === undefined || !HASH_32_PATTERN.test(contentDigest)) {
      throw new Error("asset create requires --content-digest as a 32-byte 0x-prefixed hex digest; pass 0x followed by 64 zeros for none");
    }
    cli.assetContentDigest = contentDigest;
    if (cli.retryContentHash !== undefined && cli.assetId !== undefined) throw new Error("--retry-content-hash and --asset-id are mutually exclusive");
  }
  if (command === "asset") {
    if ((subcommand === "send" || subcommand === "burn") && cli.assetId === undefined) throw new Error(`asset ${subcommand} requires --asset-id`);
    if (subcommand === "send") {
      const noteSecret = value(flags, "note-secret");
      if (noteSecret !== undefined) cli.noteSecret = parseBig(noteSecret, "note-secret");
      if ((cli.file === undefined) === (cli.to === undefined)) throw new Error("asset send requires either --to with --amount or --file");
      if (cli.to !== undefined && (cli.amount === undefined || cli.amount <= 0n)) throw new Error("asset send requires a positive --amount");
      if (cli.file !== undefined && (cli.amount !== undefined || cli.noteSecret !== undefined)) {
        throw new Error("asset send --file carries each output's amount and note secret");
      }
    }
    if (subcommand === "burn" && (cli.amount === undefined || cli.amount <= 0n)) throw new Error("asset burn requires a positive --amount");
    if (subcommand === "import") {
      const definition = value(flags, "definition");
      if (definition === undefined) throw new Error("asset import requires --definition");
      cli.definition = definition;
    }
  }
  const shape = value(flags, "shape");
  if (shape !== undefined) {
    if (shape !== "S" && shape !== "L") throw new Error("--shape expects S or L");
    cli.shape = shape === "S" ? 0 : 1;
  }
  if (command === "bulk") {
    const jobId = value(flags, "job-id");
    if (jobId !== undefined) cli.jobId = jobId;
    for (const [flag, field, minimum] of [
      ["chunk-index", "chunkIndex", 0], ["max-transactions", "maxTransactions", 1], ["target-notes", "targetNotes", 1],
    ] as const) {
      const raw = value(flags, flag);
      if (raw === undefined) continue;
      const parsed = Number(raw);
      if (!Number.isSafeInteger(parsed) || parsed < minimum) throw new Error(`--${flag} must be an integer >= ${minimum}`);
      cli[field] = parsed;
    }
    if (subcommand === "start" && cli.file === undefined) throw new Error("bulk start requires --file");
    if (subcommand === "step" && !cli.jobId) throw new Error("bulk step requires --job-id");
    if (subcommand === "consolidate" && cli.maxTransactions === undefined) {
      throw new Error("bulk consolidate requires --max-transactions");
    }
  }
  const hasSubmissionOptions = SUBMISSION_FLAGS.some((name) => Object.hasOwn(flags, name));

  if (command === "wallet" && subcommand === "import") {
    if (cli.keyFile !== undefined && !cli.dev) throw new Error("raw key import requires --dev; restore a recovery phrase with wallet import");
    if (cli.dev && cli.keyFile === undefined) throw new Error("--dev wallet import requires --key-file");
    if (cli.dev && cli.seedFile !== undefined) throw new Error("--seed-file cannot be combined with --dev");
  }
  if (command === "receive-key" && subcommand === "import" && cli.file === undefined) {
    throw new Error("receive-key import requires --file");
  }
  if (
    command === "receive-key"
    && subcommand !== "list"
    && !cli.publishReceiveKey
    && (hasSubmissionOptions || cli.fee !== undefined)
  ) {
    throw new Error("receive-key submission options require --receive-key replace");
  }
  if (command === "send") {
    if (cli.to === undefined) throw new Error("send requires --to");
    if (cli.amount === undefined) throw new Error("send requires --amount");
  }
  if (command === "relay-journal" && subcommand === "resolve" && cli.transactionHash === undefined) {
    throw new Error("relay-journal resolve requires --transaction-hash");
  }
  return cli;
}

export function jsonSafe(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}
