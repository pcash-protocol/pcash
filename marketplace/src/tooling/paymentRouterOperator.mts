import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createPublicClient, encodeAbiParameters, getAddress, http, isAddress, parseAbi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { Config } from "@pcash/sdk/bcfg";
import { Logger } from "@pcash/sdk/blgr";
import { pcashL1Chain } from "@pcash/sdk/l1";
import {
  assertPaymentRouterDeployment,
  normalizePaymentRouterConfig,
  type PaymentRouterConfig,
} from "../client/paymentRouter.ts";
import { paymentRouterContractsRoot } from "./paymentRouterDeployment.mts";

const PRIVATE_KEY = /^0x[0-9a-fA-F]{64}$/;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const logger = new Logger("info");
await logger.open();

const DEFAULT_ENVRC = resolve(dirname(fileURLToPath(import.meta.url)), "../../../.envrc.payment-router");
const ENV_KEYS = new Set([
  "PCASH_L1_RPC",
  "PCASH_L1_CHAIN_ID",
  "PCASH_L1_KEY",
  "PCASH_L1_MAX_FEE_PER_GAS",
  "PCASH_PAYMENT_ROUTER_GUARDIAN",
  "PCASH_PAYMENT_ROUTER_FEE_RECIPIENT",
  "PCASH_PAYMENT_ROUTER_FEE_BPS",
  "PCASH_PAYMENT_ROUTER_ADDRESS",
  "PCASH_PAYMENT_ROUTER_RECEIPT_DIR",
  "PCASH_ETHERSCAN_API_KEY",
]);
const REQUIRED_ENV_KEYS = [
  "PCASH_L1_RPC",
  "PCASH_L1_CHAIN_ID",
  "PCASH_PAYMENT_ROUTER_ADDRESS",
];
const DEPLOYMENT_ABI = parseAbi(["function guardian() view returns (address)"]);

export interface PaymentRouterOperatorConfig {
  rpcUrl: string;
  l1ChainId: number;
  guardian?: Address;
  routerConfig?: PaymentRouterConfig;
  address?: Address;
  deployerKey?: Hex;
  maxFeePerGas?: bigint;
  etherscanApiKey?: string;
  receiptDirectory: string;
}

export interface ForgeDeploymentRecord {
  address: Address;
  transactionHash: Hex;
  blockNumber?: string;
}

function required(config: Config, name: string): string {
  const value = config.str(name);
  if (value === null) throw new Error(`PCASH_${name.toUpperCase().replace(/-/g, "_")} is required`);
  return value;
}

function positiveBigInt(value: string, name: string): bigint {
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error(`${name} must be a positive integer in wei`);
  return BigInt(value);
}

export function parsePaymentRouterEnvironment(contents: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [index, raw] of contents.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const assignment = line.startsWith("export ") ? line.slice("export ".length) : "";
    const separator = assignment.indexOf("=");
    if (separator < 0) throw new Error(`Invalid PaymentRouter environment assignment at line ${index + 1}; expected export KEY=value`);
    const key = assignment.slice(0, separator).trim();
    if (!ENV_KEYS.has(key)) throw new Error(`Unknown PaymentRouter environment key ${key} at line ${index + 1}`);
    if (Object.hasOwn(env, key)) throw new Error(`Duplicate PaymentRouter environment key ${key} at line ${index + 1}`);
    let value = assignment.slice(separator + 1).trim();
    if (value.startsWith("\"") || value.startsWith("'")) {
      if (value.length < 2 || !value.endsWith(value[0]!)) throw new Error(`Unclosed PaymentRouter environment value for ${key}`);
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  for (const key of REQUIRED_ENV_KEYS) {
    if (!Object.hasOwn(env, key)) throw new Error(`PaymentRouter environment is missing ${key}`);
  }
  return env;
}

export function paymentRouterOperatorConfig(env: NodeJS.ProcessEnv): PaymentRouterOperatorConfig {
  const config = new Config("pcash");
  config.load({ env });
  const l1ChainIdText = required(config, "l1-chain-id");
  const l1ChainId = Number(l1ChainIdText);
  if (!/^[1-9][0-9]*$/.test(l1ChainIdText) || !Number.isSafeInteger(l1ChainId)) {
    throw new Error("PCASH_L1_CHAIN_ID must be a positive safe integer");
  }
  const addressText = config.str("payment-router-address");
  if (addressText && !isAddress(addressText)) throw new Error("PCASH_PAYMENT_ROUTER_ADDRESS must be a 20-byte Ethereum address");
  const key = config.str("l1-key");
  if (key && !PRIVATE_KEY.test(key)) throw new Error("PCASH_L1_KEY must be a 32-byte private key");
  const maxFee = config.str("l1-max-fee-per-gas");
  const guardian = config.str("payment-router-guardian");
  if (guardian && (!isAddress(guardian) || guardian.toLowerCase() === ZERO_ADDRESS)) {
    throw new Error("PCASH_PAYMENT_ROUTER_GUARDIAN must be a nonzero 20-byte Ethereum address");
  }
  const routerConfig = addressText ? undefined : normalizePaymentRouterConfig({
    feeRecipient: required(config, "payment-router-fee-recipient"),
    feeBps: Number(required(config, "payment-router-fee-bps")),
  });
  if (!addressText && !guardian) throw new Error("PCASH_PAYMENT_ROUTER_GUARDIAN is required when deploying a new PaymentRouter");
  const etherscanApiKey = config.str("etherscan-api-key");
  return {
    rpcUrl: required(config, "l1-rpc"),
    l1ChainId,
    ...(guardian ? { guardian: getAddress(guardian) } : {}),
    ...(routerConfig ? { routerConfig } : {}),
    ...(addressText ? { address: getAddress(addressText) } : {}),
    ...(key ? { deployerKey: key as Hex } : {}),
    ...(maxFee ? { maxFeePerGas: positiveBigInt(maxFee, "PCASH_L1_MAX_FEE_PER_GAS") } : {}),
    ...(etherscanApiKey ? { etherscanApiKey } : {}),
    receiptDirectory: resolve(config.str("payment-router-receipt-dir", ".cache/pcash/payment-router")),
  };
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} is not an object`);
  return value as Record<string, unknown>;
}

function hash(value: unknown, label: string): Hex {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error(`${label} is not a transaction hash`);
  return value as Hex;
}

/** Read only the PaymentRouter CREATE from Foundry's chain-specific broadcast journal. */
export function forgeDeploymentRecord(value: unknown): ForgeDeploymentRecord {
  const document = object(value, "Foundry broadcast journal");
  if (!Array.isArray(document.transactions)) throw new Error("Foundry broadcast journal has no transactions");
  const candidates = document.transactions.map((entry, index) => object(entry, `transactions[${index}]`)).filter((entry) => (
    entry.transactionType === "CREATE" && entry.contractName === "PaymentRouter"
  ));
  if (candidates.length !== 1) throw new Error(`Foundry broadcast journal contains ${candidates.length} PaymentRouter creations`);
  const transaction = candidates[0]!;
  if (typeof transaction.contractAddress !== "string" || !isAddress(transaction.contractAddress)) {
    throw new Error("PaymentRouter creation has no contract address");
  }
  const transactionHash = hash(transaction.hash, "PaymentRouter creation hash");
  let blockNumber: string | undefined;
  if (Array.isArray(document.receipts)) {
    const receipt = document.receipts.map((entry, index) => object(entry, `receipts[${index}]`)).find((entry) => (
      typeof entry.transactionHash === "string" && entry.transactionHash.toLowerCase() === transactionHash.toLowerCase()
    ));
    if (receipt?.blockNumber !== undefined) {
      const raw = receipt.blockNumber;
      if (typeof raw !== "string" || !/^(?:0x[0-9a-fA-F]+|[0-9]+)$/.test(raw)) throw new Error("PaymentRouter receipt has invalid block number");
      blockNumber = BigInt(raw).toString();
    }
  }
  return { address: getAddress(transaction.contractAddress), transactionHash, ...(blockNumber ? { blockNumber } : {}) };
}

export function forgeDeploymentArgs(config: PaymentRouterOperatorConfig): string[] {
  if (config.maxFeePerGas === undefined) throw new Error("PCASH_L1_MAX_FEE_PER_GAS is required when deploying a new PaymentRouter");
  return [
    "script",
    "script/Deploy.s.sol:Deploy",
    "--root", paymentRouterContractsRoot(),
    "--rpc-url", config.rpcUrl,
    "--broadcast",
    "--non-interactive",
    "--with-gas-price", config.maxFeePerGas.toString(),
  ];
}

export function forgeDeploymentEnvironment(config: PaymentRouterOperatorConfig, host = process.env): NodeJS.ProcessEnv {
  if (!config.routerConfig || !config.guardian) throw new Error("PaymentRouter deployment requires fee configuration and guardian");
  return {
    ...(host.PATH ? { PATH: host.PATH } : {}),
    ...(host.HOME ? { HOME: host.HOME } : {}),
    ...(host.TMPDIR ? { TMPDIR: host.TMPDIR } : {}),
    PCASH_L1_KEY: config.deployerKey,
    PCASH_PAYMENT_ROUTER_GUARDIAN: config.guardian,
    PCASH_PAYMENT_ROUTER_FEE_RECIPIENT: config.routerConfig.feeRecipient,
    PCASH_PAYMENT_ROUTER_FEE_BPS: String(config.routerConfig.feeBps),
  };
}

export function forgeSourceVerificationArgs(config: PaymentRouterOperatorConfig, address: Address, constructorArgs: Hex): string[] {
  return [
    "verify-contract",
    "--root", paymentRouterContractsRoot(),
    "--chain", String(config.l1ChainId),
    "--verifier", "etherscan",
    "--watch",
    "--constructor-args", constructorArgs,
    address,
    "src/PaymentRouter.sol:PaymentRouter",
  ];
}

export function paymentRouterConstructorArgs(feeRecipient: Address, feeBps: number, guardian: Address): Hex {
  return encodeAbiParameters(
    [{ type: "address" }, { type: "uint16" }, { type: "address" }],
    [feeRecipient, feeBps, guardian],
  );
}

export function forgeSourceVerificationEnvironment(config: PaymentRouterOperatorConfig, host = process.env): NodeJS.ProcessEnv {
  if (!config.etherscanApiKey) throw new Error("PCASH_ETHERSCAN_API_KEY is required for verify-source");
  return {
    ...(host.PATH ? { PATH: host.PATH } : {}),
    ...(host.HOME ? { HOME: host.HOME } : {}),
    ...(host.TMPDIR ? { TMPDIR: host.TMPDIR } : {}),
    ETH_RPC_URL: config.rpcUrl,
    ETHERSCAN_API_KEY: config.etherscanApiKey,
  };
}

function runForgeSourceVerification(config: PaymentRouterOperatorConfig, address: Address, constructorArgs: Hex): void {
  const result = spawnSync("forge", forgeSourceVerificationArgs(config, address, constructorArgs), {
    cwd: paymentRouterContractsRoot(),
    env: forgeSourceVerificationEnvironment(config),
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`forge verify-contract exited with code ${result.status ?? "unknown"}`);
}

function runForge(config: PaymentRouterOperatorConfig): ForgeDeploymentRecord {
  if (!config.deployerKey) throw new Error("PCASH_L1_KEY is required when no existing PCASH_PAYMENT_ROUTER_ADDRESS is configured");
  if (!config.routerConfig || !config.guardian) throw new Error("PaymentRouter deployment requires fee configuration and guardian");
  if (config.maxFeePerGas === undefined) throw new Error("PCASH_L1_MAX_FEE_PER_GAS is required when deploying a new PaymentRouter");
  const deployer = privateKeyToAccount(config.deployerKey).address;
  if (deployer === config.routerConfig.feeRecipient) throw new Error("PaymentRouter fee recipient must differ from deployer");
  const root = paymentRouterContractsRoot();
  logger.info([
    "Deploying PaymentRouter with Foundry",
    `L1 chain: ${config.l1ChainId}`,
    `Deployer: ${deployer}`,
    `Guardian: ${config.guardian}`,
    `Fee recipient: ${config.routerConfig.feeRecipient}`,
    `Fee BPS: ${config.routerConfig.feeBps}`,
  ].join("\n"));
  const result = spawnSync("forge", forgeDeploymentArgs(config), {
    cwd: root,
    env: forgeDeploymentEnvironment(config),
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`forge script exited with code ${result.status ?? "unknown"}`);
  const journal = join(root, "broadcast", "Deploy.s.sol", String(config.l1ChainId), "run-latest.json");
  return forgeDeploymentRecord(JSON.parse(readFileSync(journal, "utf8")) as unknown);
}

function atomicReceipt(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
}

export function vercelPaymentRouterVariables(address: Address): string {
  return `PCASH_PAYMENT_ROUTER_ADDRESS=${address}`;
}

export async function runPaymentRouterOperator(command: "deploy" | "verify" | "verify-source", env: NodeJS.ProcessEnv): Promise<void> {
  const config = paymentRouterOperatorConfig(env);
  if (command === "verify-source") {
    if (!config.address) throw new Error("PCASH_PAYMENT_ROUTER_ADDRESS is required for verify-source");
    if (!config.etherscanApiKey) throw new Error("PCASH_ETHERSCAN_API_KEY is required for verify-source");
  }
  const chain = pcashL1Chain(BigInt(config.l1ChainId), config.rpcUrl);
  const client = createPublicClient({ chain, transport: http(config.rpcUrl) });
  const actualL1ChainId = await client.getChainId();
  if (actualL1ChainId !== config.l1ChainId) throw new Error(`selected L1 RPC is chain ${actualL1ChainId}, expected ${config.l1ChainId}`);
  let deployment: ForgeDeploymentRecord | undefined;
  let address = config.address;
  if (address === undefined) {
    if (command === "verify") throw new Error("PCASH_PAYMENT_ROUTER_ADDRESS is required for verify");
    deployment = runForge(config);
    address = deployment.address;
  }
  const verified = await assertPaymentRouterDeployment(client, address);
  const guardian = await client.readContract({ address, abi: DEPLOYMENT_ABI, functionName: "guardian" });
  if (config.guardian && getAddress(guardian) !== config.guardian) {
    throw new Error(`PaymentRouter ${address} has guardian ${guardian}, expected ${config.guardian}`);
  }
  if (command === "verify-source") {
    const constructorArgs = paymentRouterConstructorArgs(
      verified.config.feeRecipient, verified.config.feeBps, getAddress(guardian),
    );
    runForgeSourceVerification(config, address, constructorArgs);
    logger.raw(`PaymentRouter source verified on Etherscan: ${address}`);
    return;
  }
  const receipt = {
    version: 1,
    deploymentBlock: verified.deploymentBlock.toString(),
    l1ChainId: String(config.l1ChainId),
    address,
    guardian: getAddress(guardian),
    feeRecipient: verified.config.feeRecipient,
    feeBps: verified.config.feeBps,
    runtimeTemplateHash: verified.runtimeTemplateHash,
    runtimeCodeHash: verified.runtimeCodeHash,
    ...(deployment ? { deploymentTransactionHash: deployment.transactionHash } : {}),
  };
  const receiptPath = join(config.receiptDirectory, `${config.l1ChainId}-${address.toLowerCase()}.json`);
  atomicReceipt(receiptPath, receipt);
  logger.raw(`PaymentRouter verified; receipt: ${receiptPath}\n\n# Vercel build variables\n${vercelPaymentRouterVariables(address)}`);
}

async function main(argv = process.argv.slice(2)): Promise<void> {
  // Only the command line selects the file, so exported variables can never
  // choose a different funded key or network.
  const args = new Config("pcash");
  args.load({ argv: ["node", "payment-router-operator", ...argv] });
  for (const key of Object.keys(args.args)) if (key !== "envrc") throw new Error(`unknown option --${key}`);
  const [command, ...extra] = args.argv;
  if (extra.length > 0 || command === undefined || !["deploy", "verify", "verify-source"].includes(command)) {
    throw new Error("usage: payment-router-operator [--envrc PATH] <deploy|verify|verify-source>");
  }
  const envFile = resolve(args.str("envrc", DEFAULT_ENVRC));
  let contents: string;
  try {
    contents = readFileSync(envFile, "utf8");
  } catch {
    throw new Error(`PaymentRouter environment not found or unreadable: ${envFile}`);
  }
  await runPaymentRouterOperator(command as "deploy" | "verify" | "verify-source", parsePaymentRouterEnvironment(contents));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    logger.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
