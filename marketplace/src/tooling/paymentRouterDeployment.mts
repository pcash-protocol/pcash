import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  getAddress,
  getContractAddress,
  isAddress,
  isHash,
  keccak256,
  encodeAbiParameters,
  parseTransaction,
  recoverTransactionAddress,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
  type TransactionSerialized,
} from "viem";
import {
  assertPaymentRouterDeployment,
  normalizePaymentRouterConfig,
  PAYMENT_ROUTER_RUNTIME_TEMPLATE_HASH,
  type PaymentRouterConfig,
  type PaymentRouterConfigInput,
} from "../client/paymentRouter.ts";
import { packagePath } from "./packageRoot.mts";

export const PAYMENT_ROUTER_DEPLOYMENT_CACHE_VERSION = 1 as const;

export interface PaymentRouterArtifact {
  abi: Abi;
  bytecode: Hex;
  runtimeBytecode: Hex;
  runtimeTemplateHash: Hex;
}

export interface PaymentRouterDeploymentAccount {
  l1ChainId: string;
  runtimeTemplateHash: Hex;
  runtimeCodeHash: Hex;
  feeRecipient: Address;
  feeBps: number;
  address: Address;
  deployer: Address;
  deploymentNonce: string;
  deploymentTxHash: Hex;
  deploymentBlock?: string;
}

export interface PaymentRouterPendingDeploymentAccount {
  l1ChainId: string;
  runtimeTemplateHash: Hex;
  feeRecipient: Address;
  feeBps: number;
  deployer: Address;
  nonce: string;
  expectedAddress: Address;
  creationCodeHash: Hex;
  deploymentTxHash: Hex;
  serializedTransaction: TransactionSerialized;
}

interface PaymentRouterDeploymentCache {
  version: typeof PAYMENT_ROUTER_DEPLOYMENT_CACHE_VERSION;
  deployments: Record<string, PaymentRouterDeploymentAccount>;
  pendingDeployments: Record<string, PaymentRouterPendingDeploymentAccount>;
}

export interface PaymentRouterDeploymentPlan {
  l1ChainId: number;
  deployer: Address;
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  maximumCostWei: bigint;
  routerConfig: PaymentRouterConfig;
  expectedRuntimeTemplateHash: Hex;
}

export interface PaymentRouterDeploymentRequest {
  abi: Abi;
  bytecode: Hex;
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  nonce: number;
  routerConfig: PaymentRouterConfig;
}

type RouterPublicClient = Pick<
  PublicClient,
  | "estimateGas"
  | "getChainId"
  | "getCode"
  | "getTransaction"
  | "getTransactionCount"
  | "getTransactionReceipt"
  | "readContract"
  | "waitForTransactionReceipt"
>;

export type PaymentRouterReady = {
  kind: "ready";
  source: "explicit" | "cache" | "deployed";
  l1ChainId: number;
  address: Address;
  routerConfig: PaymentRouterConfig;
  runtimeTemplateHash: typeof PAYMENT_ROUTER_RUNTIME_TEMPLATE_HASH;
  runtimeCodeHash: Hex;
  deployment?: PaymentRouterDeploymentAccount;
};

export type PaymentRouterResolution = PaymentRouterReady | {
  kind: "deployment-required";
  l1ChainId: number;
  reason: string;
};

export interface ResolvePaymentRouterOptions {
  client: RouterPublicClient;
  cachePath: string;
  explicitAddress?: string;
  expectedL1ChainId?: number;
  routerConfig?: PaymentRouterConfigInput;
}

export interface DeployPaymentRouterOptions {
  client: RouterPublicClient;
  cachePath: string;
  deployer: string;
  routerConfig: PaymentRouterConfigInput;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  onPlan?: (plan: PaymentRouterDeploymentPlan) => void | Promise<void>;
  sign: (request: PaymentRouterDeploymentRequest) => Promise<TransactionSerialized>;
  broadcast: (serializedTransaction: TransactionSerialized) => Promise<Hex>;
  artifact?: PaymentRouterArtifact;
  expectedL1ChainId?: number;
}

function isBytecode(value: unknown): value is Hex {
  return typeof value === "string" && /^0x(?:[0-9a-fA-F]{2})+$/.test(value);
}

function requiredAddress(value: string, label: string): Address {
  if (!isAddress(value)) throw new Error(`${label} must be a 20-byte Ethereum address`);
  return getAddress(value);
}

function requiredChainId(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) return undefined;
  return value;
}

function requiredBlockNumber(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value)) return undefined;
  return value;
}

function requiredNonce(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value)) return undefined;
  const nonce = Number(value);
  if (!Number.isSafeInteger(nonce)) return undefined;
  return value;
}

function decodedConfig(record: Record<string, unknown>): PaymentRouterConfig | undefined {
  if (typeof record.feeRecipient !== "string" || typeof record.feeBps !== "number") return undefined;
  try {
    return normalizePaymentRouterConfig({ feeRecipient: record.feeRecipient, feeBps: record.feeBps });
  } catch {
    return undefined;
  }
}

function configKey(config: PaymentRouterConfig): string {
  return `${config.feeRecipient.toLowerCase()}:${config.feeBps}`;
}

function cacheKey(
  l1ChainId: number,
  config: PaymentRouterConfig,
  runtimeTemplateHash: Hex = PAYMENT_ROUTER_RUNTIME_TEMPLATE_HASH,
): string {
  return `${l1ChainId}:${runtimeTemplateHash.toLowerCase()}:${configKey(config)}`;
}

function pendingCacheKey(
  l1ChainId: number,
  deployer: Address,
  config: PaymentRouterConfig,
  runtimeTemplateHash: Hex = PAYMENT_ROUTER_RUNTIME_TEMPLATE_HASH,
): string {
  return `${cacheKey(l1ChainId, config, runtimeTemplateHash)}:${deployer.toLowerCase()}`;
}

export function paymentRouterContractsRoot(): string {
  return packagePath(import.meta.url, "l1-contracts");
}

export function paymentRouterArtifactPath(contractsRoot = paymentRouterContractsRoot()): string {
  return path.join(contractsRoot, "out", "PaymentRouter.sol", "PaymentRouter.json");
}

export async function loadPaymentRouterArtifact(
  artifactPath = paymentRouterArtifactPath(),
): Promise<PaymentRouterArtifact> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(artifactPath, "utf8"));
  } catch (error) {
    throw new Error(`cannot read PaymentRouter Foundry artifact ${artifactPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`PaymentRouter Foundry artifact ${artifactPath} is not an object`);
  }
  const artifact = parsed as {
    abi?: unknown;
    bytecode?: { object?: unknown };
    deployedBytecode?: { object?: unknown; immutableReferences?: unknown };
  };
  if (!Array.isArray(artifact.abi) || !isBytecode(artifact.bytecode?.object) || !isBytecode(artifact.deployedBytecode?.object)) {
    throw new Error(`PaymentRouter Foundry artifact ${artifactPath} is missing ABI or bytecode`);
  }
  const runtimeTemplateHash = keccak256(artifact.deployedBytecode.object);
  if (runtimeTemplateHash.toLowerCase() !== PAYMENT_ROUTER_RUNTIME_TEMPLATE_HASH.toLowerCase()) {
    throw new Error(
      `PaymentRouter Foundry artifact runtime template hash is ${runtimeTemplateHash}, expected ${PAYMENT_ROUTER_RUNTIME_TEMPLATE_HASH}`,
    );
  }
  return {
    abi: artifact.abi as Abi,
    bytecode: artifact.bytecode.object,
    runtimeBytecode: artifact.deployedBytecode.object,
    runtimeTemplateHash,
  };
}

/** Tooling deployments make the deployer the router's pause guardian. */
export function paymentRouterCreationCode(
  artifact: PaymentRouterArtifact,
  config: PaymentRouterConfig,
  deployer: Address,
): Hex {
  const normalized = normalizePaymentRouterConfig(config);
  const constructorArguments = encodeAbiParameters(
    [{ type: "address" }, { type: "uint16" }, { type: "address" }],
    [normalized.feeRecipient, normalized.feeBps, deployer],
  );
  return `${artifact.bytecode}${constructorArguments.slice(2)}` as Hex;
}

export function buildPaymentRouterArtifact(
  contractsRoot = paymentRouterContractsRoot(),
): Promise<PaymentRouterArtifact> {
  execFileSync("forge", ["build", "--root", contractsRoot, "--skip", "test", "--skip", "script"], {
    stdio: "inherit",
  });
  return loadPaymentRouterArtifact(paymentRouterArtifactPath(contractsRoot));
}

async function rpcChainId(client: RouterPublicClient, expectedChainId?: number): Promise<number> {
  const chainId = await client.getChainId();
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error(`selected L1 RPC returned invalid chain ID ${chainId}`);
  if (expectedChainId !== undefined && chainId !== expectedChainId) {
    throw new Error(`selected L1 RPC is chain ${chainId}, expected chain ${expectedChainId}`);
  }
  return chainId;
}

function decodeAccount(value: unknown): PaymentRouterDeploymentAccount | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const l1ChainId = requiredChainId(record.l1ChainId);
  const config = decodedConfig(record);
  if (
    l1ChainId === undefined
    || config === undefined
    || typeof record.runtimeTemplateHash !== "string"
    || !isHash(record.runtimeTemplateHash)
    || typeof record.runtimeCodeHash !== "string"
    || !isHash(record.runtimeCodeHash)
    || typeof record.address !== "string"
    || !isAddress(record.address)
    || typeof record.deployer !== "string"
    || !isAddress(record.deployer)
    || requiredNonce(record.deploymentNonce) === undefined
    || typeof record.deploymentTxHash !== "string"
    || !isHash(record.deploymentTxHash)
    || (record.deploymentBlock !== undefined && requiredBlockNumber(record.deploymentBlock) === undefined)
  ) return undefined;
  return {
    l1ChainId,
    runtimeTemplateHash: record.runtimeTemplateHash,
    runtimeCodeHash: record.runtimeCodeHash,
    ...config,
    address: getAddress(record.address),
    deployer: getAddress(record.deployer),
    deploymentNonce: record.deploymentNonce as string,
    deploymentTxHash: record.deploymentTxHash,
    ...(record.deploymentBlock === undefined ? {} : { deploymentBlock: record.deploymentBlock as string }),
  };
}

function decodePendingAccount(value: unknown): PaymentRouterPendingDeploymentAccount | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const l1ChainId = requiredChainId(record.l1ChainId);
  const nonce = requiredNonce(record.nonce);
  const config = decodedConfig(record);
  if (
    l1ChainId === undefined
    || nonce === undefined
    || config === undefined
    || typeof record.runtimeTemplateHash !== "string"
    || !isHash(record.runtimeTemplateHash)
    || typeof record.deployer !== "string"
    || !isAddress(record.deployer)
    || typeof record.expectedAddress !== "string"
    || !isAddress(record.expectedAddress)
    || typeof record.creationCodeHash !== "string"
    || !isHash(record.creationCodeHash)
    || typeof record.deploymentTxHash !== "string"
    || !isHash(record.deploymentTxHash)
    || typeof record.serializedTransaction !== "string"
    || !isBytecode(record.serializedTransaction)
  ) return undefined;
  return {
    l1ChainId,
    runtimeTemplateHash: record.runtimeTemplateHash,
    ...config,
    deployer: getAddress(record.deployer),
    nonce,
    expectedAddress: getAddress(record.expectedAddress),
    creationCodeHash: record.creationCodeHash,
    deploymentTxHash: record.deploymentTxHash,
    serializedTransaction: record.serializedTransaction as TransactionSerialized,
  };
}

async function readCache(cachePath: string): Promise<{ cache: PaymentRouterDeploymentCache; issue?: string }> {
  const empty = (): PaymentRouterDeploymentCache => ({
    version: PAYMENT_ROUTER_DEPLOYMENT_CACHE_VERSION,
    deployments: {},
    pendingDeployments: {},
  });
  let text: string;
  try {
    text = await readFile(cachePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { cache: empty(), issue: "no cached deployment" };
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`PaymentRouter deployment cache ${cachePath} is not valid JSON; refusing to ignore possible pending deployment state`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`PaymentRouter deployment cache ${cachePath} is not an object; refusing to ignore possible pending deployment state`);
  }
  const document = parsed as { version?: unknown; deployments?: unknown; pendingDeployments?: unknown };
  if (document.version !== PAYMENT_ROUTER_DEPLOYMENT_CACHE_VERSION || typeof document.deployments !== "object" || document.deployments === null) {
    throw new Error(`PaymentRouter deployment cache ${cachePath} has an unsupported format; refusing to ignore possible pending deployment state`);
  }
  const deployments: Record<string, PaymentRouterDeploymentAccount> = {};
  for (const [key, value] of Object.entries(document.deployments)) {
    const record = decodeAccount(value);
    if (record === undefined) throw new Error(`PaymentRouter deployment cache ${cachePath} has invalid completed record ${key}`);
    deployments[key] = record;
  }
  const pendingDeployments: Record<string, PaymentRouterPendingDeploymentAccount> = {};
  if (document.pendingDeployments !== undefined) {
    if (typeof document.pendingDeployments !== "object" || document.pendingDeployments === null) {
      throw new Error(`PaymentRouter deployment cache ${cachePath} has invalid pending deployment state`);
    }
    for (const [key, value] of Object.entries(document.pendingDeployments)) {
      const record = decodePendingAccount(value);
      if (record === undefined) throw new Error(`PaymentRouter deployment cache ${cachePath} has invalid pending record ${key}`);
      pendingDeployments[key] = record;
    }
  }
  return { cache: { version: PAYMENT_ROUTER_DEPLOYMENT_CACHE_VERSION, deployments, pendingDeployments } };
}

async function atomicWriteCache(cachePath: string, cache: PaymentRouterDeploymentCache): Promise<void> {
  await mkdir(path.dirname(cachePath), { recursive: true });
  const temporaryPath = `${cachePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(cache, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporaryPath, cachePath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

function pendingAccountsForChain(
  cache: PaymentRouterDeploymentCache,
  l1ChainId: number,
): Array<[string, PaymentRouterPendingDeploymentAccount]> {
  return Object.entries(cache.pendingDeployments).filter(([, record]) => (
    record.l1ChainId === String(l1ChainId)
  ));
}

async function assertPendingAccount(
  key: string,
  l1ChainId: number,
  pending: PaymentRouterPendingDeploymentAccount,
): Promise<void> {
  const config = normalizePaymentRouterConfig(pending);
  if (key !== pendingCacheKey(l1ChainId, pending.deployer, config, pending.runtimeTemplateHash)) {
    throw new Error(`pending PaymentRouter deployment ${key} is not bound to its chain, runtime, fee configuration, and deployer`);
  }
  if (keccak256(pending.serializedTransaction).toLowerCase() !== pending.deploymentTxHash.toLowerCase()) {
    throw new Error(`pending PaymentRouter deployment ${pending.deploymentTxHash} does not match its signed transaction`);
  }
  const transaction = parseTransaction(pending.serializedTransaction);
  const nonce = Number(pending.nonce);
  if (transaction.chainId !== l1ChainId || transaction.nonce !== nonce) {
    throw new Error(`pending PaymentRouter deployment ${pending.deploymentTxHash} has the wrong chain or nonce`);
  }
  if (transaction.to != null || transaction.data === undefined || keccak256(transaction.data).toLowerCase() !== pending.creationCodeHash.toLowerCase()) {
    throw new Error(`pending PaymentRouter deployment ${pending.deploymentTxHash} is not the recorded contract creation`);
  }
  const signer = getAddress(await recoverTransactionAddress({ serializedTransaction: pending.serializedTransaction }));
  if (signer !== pending.deployer) {
    throw new Error(`pending PaymentRouter deployment ${pending.deploymentTxHash} was signed by ${signer}, expected ${pending.deployer}`);
  }
  const expectedAddress = getAddress(getContractAddress({ from: pending.deployer, nonce: BigInt(nonce) }));
  if (expectedAddress !== pending.expectedAddress) {
    throw new Error(`pending PaymentRouter deployment ${pending.deploymentTxHash} has the wrong deterministic address`);
  }
}

async function optionalTransactionReceipt(client: RouterPublicClient, hash: Hex) {
  try {
    return await client.getTransactionReceipt({ hash });
  } catch (error) {
    if (error instanceof TransactionReceiptNotFoundError) return undefined;
    throw error;
  }
}

async function optionalTransaction(client: RouterPublicClient, hash: Hex) {
  try {
    return await client.getTransaction({ hash });
  } catch (error) {
    if (error instanceof TransactionNotFoundError) return undefined;
    throw error;
  }
}

function completedAccount(
  pending: PaymentRouterPendingDeploymentAccount,
  runtimeCodeHash: Hex,
  receipt?: { transactionHash: Hex; blockNumber: bigint },
): PaymentRouterDeploymentAccount {
  return {
    l1ChainId: pending.l1ChainId,
    runtimeTemplateHash: PAYMENT_ROUTER_RUNTIME_TEMPLATE_HASH,
    runtimeCodeHash,
    feeRecipient: pending.feeRecipient,
    feeBps: pending.feeBps,
    address: pending.expectedAddress,
    deployer: pending.deployer,
    deploymentNonce: pending.nonce,
    deploymentTxHash: receipt?.transactionHash ?? pending.deploymentTxHash,
    ...(receipt === undefined ? {} : {
      deploymentBlock: receipt.blockNumber.toString(),
    }),
  };
}

function assertReceiptMatchesPending(
  pending: PaymentRouterPendingDeploymentAccount,
  receipt: { status: "success" | "reverted"; transactionHash: Hex; contractAddress?: Address | null },
): void {
  if (receipt.transactionHash.toLowerCase() !== pending.deploymentTxHash.toLowerCase()) {
    throw new Error(`PaymentRouter receipt ${receipt.transactionHash} does not match pending transaction ${pending.deploymentTxHash}`);
  }
  if (
    receipt.status === "success"
    && (receipt.contractAddress == null || getAddress(receipt.contractAddress) !== pending.expectedAddress)
  ) {
    throw new Error(
      `PaymentRouter deployment ${pending.deploymentTxHash} returned unexpected contract address ${receipt.contractAddress ?? "none"}; refusing another deployment`,
    );
  }
}

async function finishPendingDeployment(
  cachePath: string,
  cache: PaymentRouterDeploymentCache,
  pendingKey: string,
  l1ChainId: number,
  pending: PaymentRouterPendingDeploymentAccount,
  runtimeCodeHash: Hex,
  receipt?: { transactionHash: Hex; blockNumber: bigint },
): Promise<PaymentRouterReady> {
  const routerConfig = normalizePaymentRouterConfig(pending);
  const deployment = completedAccount(pending, runtimeCodeHash, receipt);
  cache.deployments[cacheKey(l1ChainId, routerConfig)] = deployment;
  delete cache.pendingDeployments[pendingKey];
  await atomicWriteCache(cachePath, cache);
  return {
    kind: "ready",
    source: "cache",
    l1ChainId,
    address: pending.expectedAddress,
    routerConfig,
    runtimeTemplateHash: PAYMENT_ROUTER_RUNTIME_TEMPLATE_HASH,
    runtimeCodeHash,
    deployment,
  };
}

type PendingReconciliation =
  | { kind: "none" }
  | { kind: "retryable"; key: string; pending: PaymentRouterPendingDeploymentAccount }
  | { kind: "ready"; ready: PaymentRouterReady };

async function reconcilePendingDeployment(params: {
  client: RouterPublicClient;
  cachePath: string;
  cache: PaymentRouterDeploymentCache;
  l1ChainId: number;
  routerConfig: PaymentRouterConfig;
  deployer?: Address;
}): Promise<PendingReconciliation> {
  const records = pendingAccountsForChain(params.cache, params.l1ChainId);
  if (records.length === 0) return { kind: "none" };
  if (records.length > 1) {
    throw new Error(`multiple pending PaymentRouter deployments exist for L1 chain ${params.l1ChainId}; refusing another deployment`);
  }
  const [key, pending] = records[0]!;
  await assertPendingAccount(key, params.l1ChainId, pending);
  if (pending.runtimeTemplateHash.toLowerCase() !== PAYMENT_ROUTER_RUNTIME_TEMPLATE_HASH.toLowerCase()) {
    throw new Error(
      `PaymentRouter deployment ${pending.deploymentTxHash} targets a different runtime; reconcile it before deploying the current router`,
    );
  }
  if (configKey(normalizePaymentRouterConfig(pending)) !== configKey(params.routerConfig)) {
    throw new Error(
      `PaymentRouter deployment ${pending.deploymentTxHash} targets a different fee configuration; reconcile it before deploying the configured router`,
    );
  }
  if (params.deployer !== undefined && pending.deployer !== params.deployer) {
    throw new Error(`PaymentRouter deployment ${pending.deploymentTxHash} from ${pending.deployer} is unresolved; refusing a deployment from ${params.deployer}`);
  }

  const code = await params.client.getCode({ address: pending.expectedAddress });
  if (code !== undefined && code !== "0x") {
    const verified = await assertPaymentRouterDeployment(params.client, pending.expectedAddress, params.routerConfig);
    const receipt = await optionalTransactionReceipt(params.client, pending.deploymentTxHash);
    if (receipt !== undefined) {
      assertReceiptMatchesPending(pending, receipt);
      if (receipt.status !== "success") {
        throw new Error(`PaymentRouter deployment ${pending.deploymentTxHash} has code at ${pending.expectedAddress} but its receipt reverted`);
      }
    }
    return {
      kind: "ready",
      ready: await finishPendingDeployment(
        params.cachePath,
        params.cache,
        key,
        params.l1ChainId,
        pending,
        verified.runtimeCodeHash,
        receipt === undefined ? undefined : { transactionHash: receipt.transactionHash, blockNumber: receipt.blockNumber },
      ),
    };
  }

  const receipt = await optionalTransactionReceipt(params.client, pending.deploymentTxHash);
  if (receipt !== undefined) {
    assertReceiptMatchesPending(pending, receipt);
    if (receipt.status === "reverted") {
      delete params.cache.pendingDeployments[key];
      await atomicWriteCache(params.cachePath, params.cache);
      throw new Error(`PaymentRouter deployment ${pending.deploymentTxHash} reverted; its terminal pending record was cleared, rerun to deploy again`);
    }
    throw new Error(`PaymentRouter deployment ${pending.deploymentTxHash} succeeded but ${pending.expectedAddress} has no contract code; refusing another deployment`);
  }

  const transaction = await optionalTransaction(params.client, pending.deploymentTxHash);
  if (transaction !== undefined) {
    if (
      getAddress(transaction.from) !== pending.deployer
      || transaction.nonce !== Number(pending.nonce)
      || transaction.to != null
      || keccak256(transaction.input).toLowerCase() !== pending.creationCodeHash.toLowerCase()
    ) {
      throw new Error(`pending PaymentRouter transaction ${pending.deploymentTxHash} does not match the recorded deployment`);
    }
    throw new Error(`PaymentRouter deployment ${pending.deploymentTxHash} is still pending; refusing another deployment`);
  }

  const [latestNonce, pendingNonce] = await Promise.all([
    params.client.getTransactionCount({ address: pending.deployer, blockTag: "latest" }),
    params.client.getTransactionCount({ address: pending.deployer, blockTag: "pending" }),
  ]);
  const nonce = Number(pending.nonce);
  if (latestNonce === nonce && pendingNonce === nonce) {
    return { kind: "retryable", key, pending };
  }
  if (latestNonce > nonce) {
    delete params.cache.pendingDeployments[key];
    await atomicWriteCache(params.cachePath, params.cache);
    throw new Error(`PaymentRouter deployment nonce ${nonce} was consumed without deploying the router; its terminal pending record was cleared, rerun to deploy again`);
  }
  throw new Error(
    `PaymentRouter deployment ${pending.deploymentTxHash} is not retrievable but deployer nonces are latest=${latestNonce}, pending=${pendingNonce}, expected=${nonce}; refusing another deployment`,
  );
}

export async function resolvePaymentRouter(options: ResolvePaymentRouterOptions): Promise<PaymentRouterResolution> {
  const l1ChainId = await rpcChainId(options.client, options.expectedL1ChainId);
  if (options.explicitAddress !== undefined) {
    const address = requiredAddress(options.explicitAddress, "PCASH_PAYMENT_ROUTER_ADDRESS");
    const verified = await assertPaymentRouterDeployment(options.client, address);
    return {
      kind: "ready",
      source: "explicit",
      l1ChainId,
      address,
      routerConfig: verified.config,
      runtimeTemplateHash: PAYMENT_ROUTER_RUNTIME_TEMPLATE_HASH,
      runtimeCodeHash: verified.runtimeCodeHash,
    };
  }
  if (options.routerConfig === undefined) throw new Error("PaymentRouter fee configuration is required for automatic deployment");
  const routerConfig = normalizePaymentRouterConfig(options.routerConfig);
  const { cache, issue } = await readCache(options.cachePath);
  const pending = await reconcilePendingDeployment({
    client: options.client,
    cachePath: options.cachePath,
    cache,
    l1ChainId,
    routerConfig,
  });
  if (pending.kind === "ready") return pending.ready;

  const key = cacheKey(l1ChainId, routerConfig);
  const record = cache.deployments[key];
  let reason = issue ?? `no cached deployment for L1 chain ${l1ChainId}`;
  if (record !== undefined) {
    if (
      record.l1ChainId !== String(l1ChainId)
      || record.runtimeTemplateHash.toLowerCase() !== PAYMENT_ROUTER_RUNTIME_TEMPLATE_HASH.toLowerCase()
      || configKey(normalizePaymentRouterConfig(record)) !== configKey(routerConfig)
    ) {
      reason = `cached deployment ${key} is not bound to the selected chain and runtime`;
    } else {
      try {
        const verified = await assertPaymentRouterDeployment(options.client, record.address, routerConfig);
        if (verified.runtimeCodeHash.toLowerCase() !== record.runtimeCodeHash.toLowerCase()) {
          throw new Error(`cached runtime code hash ${record.runtimeCodeHash} does not match ${verified.runtimeCodeHash}`);
        }
        return {
          kind: "ready",
          source: "cache",
          l1ChainId,
          address: record.address,
          routerConfig,
          runtimeTemplateHash: PAYMENT_ROUTER_RUNTIME_TEMPLATE_HASH,
          runtimeCodeHash: verified.runtimeCodeHash,
          deployment: record,
        };
      } catch (error) {
        reason = `cached PaymentRouter ${record.address} is stale: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
  }

  if (pending.kind === "retryable") {
    reason = `signed PaymentRouter deployment ${pending.pending.deploymentTxHash} is ready for idempotent rebroadcast`;
  }
  return { kind: "deployment-required", l1ChainId, reason };
}

function validateFeeCap(maxFeePerGas: bigint, maxPriorityFeePerGas: bigint): void {
  if (maxFeePerGas <= 0n) throw new Error("PaymentRouter maxFeePerGas must be positive");
  if (maxPriorityFeePerGas < 0n || maxPriorityFeePerGas > maxFeePerGas) {
    throw new Error("PaymentRouter maxPriorityFeePerGas must be between zero and maxFeePerGas");
  }
}

function assertPendingArtifact(
  pending: PaymentRouterPendingDeploymentAccount,
  artifact: PaymentRouterArtifact,
): void {
  const creationCode = paymentRouterCreationCode(
    artifact,
    normalizePaymentRouterConfig(pending),
    pending.deployer,
  );
  if (pending.creationCodeHash.toLowerCase() !== keccak256(creationCode).toLowerCase()) {
    throw new Error(
      `pending PaymentRouter deployment ${pending.deploymentTxHash} does not contain the current PaymentRouter creation code`,
    );
  }
}

async function pendingAccountFromSignedTransaction(params: {
  l1ChainId: number;
  deployer: Address;
  nonce: number;
  artifact: PaymentRouterArtifact;
  routerConfig: PaymentRouterConfig;
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  serializedTransaction: TransactionSerialized;
}): Promise<PaymentRouterPendingDeploymentAccount> {
  if (!isBytecode(params.serializedTransaction)) throw new Error("PaymentRouter signer returned an invalid serialized transaction");
  const transaction = parseTransaction(params.serializedTransaction);
  const creationCode = paymentRouterCreationCode(params.artifact, params.routerConfig, params.deployer);
  if (
    transaction.chainId !== params.l1ChainId
    || transaction.nonce !== params.nonce
    || transaction.to != null
    || transaction.data?.toLowerCase() !== creationCode.toLowerCase()
    || transaction.gas !== params.gas
    || transaction.maxFeePerGas !== params.maxFeePerGas
    || transaction.maxPriorityFeePerGas !== params.maxPriorityFeePerGas
    || (transaction.value ?? 0n) !== 0n
  ) {
    throw new Error("PaymentRouter signer returned a transaction that does not match the deployment plan");
  }
  const signer = getAddress(await recoverTransactionAddress({ serializedTransaction: params.serializedTransaction }));
  if (signer !== params.deployer) {
    throw new Error(`PaymentRouter transaction was signed by ${signer}, expected ${params.deployer}`);
  }
  return {
    l1ChainId: String(params.l1ChainId),
    runtimeTemplateHash: PAYMENT_ROUTER_RUNTIME_TEMPLATE_HASH,
    feeRecipient: params.routerConfig.feeRecipient,
    feeBps: params.routerConfig.feeBps,
    deployer: params.deployer,
    nonce: String(params.nonce),
    expectedAddress: getAddress(getContractAddress({ from: params.deployer, nonce: BigInt(params.nonce) })),
    creationCodeHash: keccak256(creationCode),
    deploymentTxHash: keccak256(params.serializedTransaction),
    serializedTransaction: params.serializedTransaction,
  };
}

async function broadcastAndFinishPendingDeployment(params: {
  options: DeployPaymentRouterOptions;
  cache: PaymentRouterDeploymentCache;
  key: string;
  l1ChainId: number;
  pending: PaymentRouterPendingDeploymentAccount;
}): Promise<PaymentRouterReady> {
  const broadcastHash = await params.options.broadcast(params.pending.serializedTransaction);
  if (!isHash(broadcastHash) || broadcastHash.toLowerCase() !== params.pending.deploymentTxHash.toLowerCase()) {
    throw new Error(`PaymentRouter broadcaster returned ${broadcastHash}, expected ${params.pending.deploymentTxHash}`);
  }
  const receipt = await params.options.client.waitForTransactionReceipt({ hash: params.pending.deploymentTxHash });
  assertReceiptMatchesPending(params.pending, receipt);
  if (receipt.status === "reverted") {
    delete params.cache.pendingDeployments[params.key];
    await atomicWriteCache(params.options.cachePath, params.cache);
    throw new Error(`PaymentRouter deployment ${params.pending.deploymentTxHash} reverted; its terminal pending record was cleared`);
  }
  const verified = await assertPaymentRouterDeployment(
    params.options.client,
    params.pending.expectedAddress,
    normalizePaymentRouterConfig(params.pending),
  );
  const ready = await finishPendingDeployment(
    params.options.cachePath,
    params.cache,
    params.key,
    params.l1ChainId,
    params.pending,
    verified.runtimeCodeHash,
    { transactionHash: receipt.transactionHash, blockNumber: receipt.blockNumber },
  );
  return { ...ready, source: "deployed" };
}

export async function deployPaymentRouter(options: DeployPaymentRouterOptions): Promise<PaymentRouterReady> {
  const l1ChainId = await rpcChainId(options.client, options.expectedL1ChainId);
  const deployer = requiredAddress(options.deployer, "PaymentRouter deployer");
  const routerConfig = normalizePaymentRouterConfig(options.routerConfig);
  validateFeeCap(options.maxFeePerGas, options.maxPriorityFeePerGas);

  const existingResolution = await resolvePaymentRouter({
    client: options.client,
    cachePath: options.cachePath,
    expectedL1ChainId: l1ChainId,
    routerConfig,
  });
  if (existingResolution.kind === "ready") return existingResolution;
  const artifact = options.artifact ?? await buildPaymentRouterArtifact();
  const compiledRuntimeTemplateHash = keccak256(artifact.runtimeBytecode);
  if (
    artifact.runtimeTemplateHash.toLowerCase() !== compiledRuntimeTemplateHash.toLowerCase()
    || compiledRuntimeTemplateHash.toLowerCase() !== PAYMENT_ROUTER_RUNTIME_TEMPLATE_HASH.toLowerCase()
  ) {
    throw new Error(
      `refusing to deploy PaymentRouter artifact with runtime template hash ${compiledRuntimeTemplateHash}; expected ${PAYMENT_ROUTER_RUNTIME_TEMPLATE_HASH}`,
    );
  }
  const { cache } = await readCache(options.cachePath);
  const pendingResolution = await reconcilePendingDeployment({
    client: options.client,
    cachePath: options.cachePath,
    cache,
    l1ChainId,
    routerConfig,
    deployer,
  });
  if (pendingResolution.kind === "ready") return pendingResolution.ready;
  if (pendingResolution.kind === "retryable") {
    assertPendingArtifact(pendingResolution.pending, artifact);
    return broadcastAndFinishPendingDeployment({
      options,
      cache,
      key: pendingResolution.key,
      l1ChainId,
      pending: pendingResolution.pending,
    });
  }

  const creationCode = paymentRouterCreationCode(artifact, routerConfig, deployer);
  const gas = await options.client.estimateGas({ account: deployer, data: creationCode });
  const plan: PaymentRouterDeploymentPlan = {
    l1ChainId,
    deployer,
    gas,
    maxFeePerGas: options.maxFeePerGas,
    maxPriorityFeePerGas: options.maxPriorityFeePerGas,
    maximumCostWei: gas * options.maxFeePerGas,
    routerConfig,
    expectedRuntimeTemplateHash: PAYMENT_ROUTER_RUNTIME_TEMPLATE_HASH,
  };
  await options.onPlan?.(plan);

  const nonce = await options.client.getTransactionCount({ address: deployer, blockTag: "pending" });
  const serializedTransaction = await options.sign({
    abi: artifact.abi,
    bytecode: creationCode,
    gas,
    maxFeePerGas: options.maxFeePerGas,
    maxPriorityFeePerGas: options.maxPriorityFeePerGas,
    nonce,
    routerConfig,
  });
  const pending = await pendingAccountFromSignedTransaction({
    l1ChainId,
    deployer,
    nonce,
    artifact,
    routerConfig,
    gas,
    maxFeePerGas: options.maxFeePerGas,
    maxPriorityFeePerGas: options.maxPriorityFeePerGas,
    serializedTransaction,
  });
  const key = pendingCacheKey(l1ChainId, deployer, routerConfig);
  cache.pendingDeployments[key] = pending;
  await atomicWriteCache(options.cachePath, cache);
  return broadcastAndFinishPendingDeployment({ options, cache, key, l1ChainId, pending });
}
