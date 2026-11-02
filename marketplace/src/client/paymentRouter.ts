import {
  createPublicClient,
  encodeAbiParameters,
  getAddress,
  isAddress,
  keccak256,
  numberToHex,
  padHex,
  parseAbi,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { addressHex, l1RpcTransport, type PcashNodeClient, type StatusResult } from "@pcash/sdk/browser";
import { toBytes32 } from "../commitments.mts";
import type { OfferPublication } from "./publication.ts";

/**
 * keccak256 of PaymentRouter's deployed runtime bytecode template after its
 * immutable words are zeroed, compiled with the
 * checked-in Foundry profile (solc 0.8.37, optimizer enabled, 200 runs,
 * evm_version cancun, CBOR metadata stripped). With metadata stripped the
 * hash depends only on compiled logic and compiler settings; a semantic
 * change to PaymentRouter.sol requires re-pinning this value and redeploying
 * every configured router.
 */
export const PAYMENT_ROUTER_RUNTIME_TEMPLATE_HASH =
  "0xbb1044050c7d3543977ce8cec142d1ebd9753970fa7980bb669c918852e50711" as const;
export const PAYMENT_ROUTER_DEFAULT_FEE_BPS = 500 as const;
export const PAYMENT_ROUTER_FEE_BPS_DENOMINATOR = 10_000 as const;

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const PAYMENT_ROUTER_RUNTIME_BYTES = 3_097;
const FEE_RECIPIENT_IMMUTABLE_REFERENCES = [475, 1_824] as const;
const FEE_BPS_IMMUTABLE_REFERENCES = [308, 1_341] as const;
/** The guardian only pauses `buy`, so clients accept any value in these words. */
const GUARDIAN_IMMUTABLE_REFERENCES = [400, 800, 947] as const;

const DEPLOYMENT_BLOCK_IMMUTABLE_REFERENCES = [611] as const;

const CONFIG_ABI = parseAbi([
  "function feeRecipient() view returns (address)",
  "function feeBps() view returns (uint16)",
  "function deploymentBlock() view returns (uint256)",
]);

/** The router calls a buyer makes, and the payment record they leave. */
export const PAYMENT_ROUTER_ABI = parseAbi([
  "function buy(bytes32 offerId, address seller, bytes32 claimKeyCommitment, uint256 anchorBlockNumber, bytes32 anchorBlockHash, uint64 notAfter, bytes recoveryData, bytes batch) payable",
  "function retry(bytes32 offerId, address seller, uint256 amount, bytes batch)",
  "function paid(bytes32 paymentKey) view returns (bytes32 claimKeyCommitment)",
]);

/** The router's `paymentKey`: the one payment it accepts for an offer id, seller, and gross amount. */
export function paymentKey(offerId: Hex, seller: Address, amount: bigint): Hex {
  return keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "address" }, { type: "uint256" }], [offerId, seller, amount]));
}

/** The key under which the router's `paid` records the one payment a listing accepts. */
export function routerPaymentKey(pub: Pick<OfferPublication, "terms">): Hex {
  return paymentKey(toBytes32(BigInt(pub.terms.id)), addressHex(BigInt(pub.terms.seller)) as Address, BigInt(pub.terms.ethPriceWei));
}

export interface PaymentRouterConfig {
  feeRecipient: Address;
  feeBps: number;
}

export interface PaymentRouterConfigInput {
  feeRecipient: string;
  feeBps?: number;
}

export interface PaymentRouterFeeQuote extends PaymentRouterConfig {
  buyerGrossWei: bigint;
  websiteFeeWei: bigint;
  sellerNetWei: bigint;
}

export interface VerifiedPaymentRouterDeployment {
  deploymentBlock: bigint;
  config: PaymentRouterConfig;
  runtimeCodeHash: Hex;
  runtimeTemplateHash: typeof PAYMENT_ROUTER_RUNTIME_TEMPLATE_HASH;
}

export function normalizePaymentRouterConfig(input: PaymentRouterConfigInput): PaymentRouterConfig {
  if (!isAddress(input.feeRecipient) || input.feeRecipient.toLowerCase() === ZERO_ADDRESS) {
    throw new Error("PaymentRouter fee recipient must be a nonzero 20-byte Ethereum address");
  }
  const feeBps = input.feeBps ?? PAYMENT_ROUTER_DEFAULT_FEE_BPS;
  if (!Number.isInteger(feeBps) || feeBps <= 0 || feeBps >= PAYMENT_ROUTER_FEE_BPS_DENOMINATOR) {
    throw new Error("PaymentRouter fee BPS must be an integer between 1 and 9999");
  }
  return { feeRecipient: getAddress(input.feeRecipient), feeBps };
}

/** Match the contract's overflow-safe floor rounding exactly. */
export function quotePaymentRouterFee(
  buyerGrossWei: bigint,
  config: PaymentRouterConfig,
): PaymentRouterFeeQuote {
  if (buyerGrossWei < 0n) throw new Error("PaymentRouter gross payment cannot be negative");
  const normalized = normalizePaymentRouterConfig(config);
  const websiteFeeWei = buyerGrossWei * BigInt(normalized.feeBps) / BigInt(PAYMENT_ROUTER_FEE_BPS_DENOMINATOR);
  return {
    buyerGrossWei,
    websiteFeeWei,
    sellerNetWei: buyerGrossWei - websiteFeeWei,
    ...normalized,
  };
}

export async function assertConfiguredL1Chain(
  client: Pick<PublicClient, "getChainId">,
  expectedChainId: bigint,
): Promise<number> {
  const rpcChainId = await client.getChainId();
  if (BigInt(rpcChainId) !== expectedChainId) {
    throw new Error(`configured L1 RPC is chain ${rpcChainId}, but the PCASH node follows L1 chain ${expectedChainId}`);
  }
  return rpcChainId;
}

export async function assertNodeL1Identity(
  client: Pick<PublicClient, "getChainId" | "getBlock">,
  status: Pick<StatusResult, "l1ChainId" | "genesisL1Block" | "genesisL1BlockHash">,
): Promise<number> {
  const rpcChainId = await assertConfiguredL1Chain(client, status.l1ChainId);
  if (BigInt(rpcChainId) !== status.l1ChainId) {
    throw new Error(
      `selected L1 RPC is chain ${rpcChainId}, but the PCASH node follows L1 chain ${status.l1ChainId}`,
    );
  }
  const genesis = await client.getBlock({ blockNumber: status.genesisL1Block });
  if (!genesis.hash || genesis.hash.toLowerCase() !== status.genesisL1BlockHash.toLowerCase()) {
    throw new Error("selected L1 RPC does not match the PCASH node's genesis anchor");
  }
  return rpcChainId;
}

function immutableWord(config: PaymentRouterConfig, field: "feeRecipient" | "feeBps"): string {
  return field === "feeRecipient"
    ? padHex(config.feeRecipient, { size: 32 }).slice(2).toLowerCase()
    : numberToHex(config.feeBps, { size: 32 }).slice(2).toLowerCase();
}

function replaceWord(bytes: string, start: number, word: string): string {
  const offset = start * 2;
  return `${bytes.slice(0, offset)}${word}${bytes.slice(offset + 64)}`;
}

/** Materialize the exact configured runtime from the compiler's zero-immutable template. */
export function configurePaymentRouterRuntimeCode(
  runtimeTemplate: Hex,
  config: PaymentRouterConfig,
  guardian: Address,
  deploymentBlock: bigint,
): Hex {
  const normalized = normalizePaymentRouterConfig(config);
  let runtime = runtimeTemplate.slice(2).toLowerCase();
  if (
    runtime.length !== PAYMENT_ROUTER_RUNTIME_BYTES * 2
    || keccak256(runtimeTemplate).toLowerCase() !== PAYMENT_ROUTER_RUNTIME_TEMPLATE_HASH.toLowerCase()
  ) {
    throw new Error("PaymentRouter runtime template does not match the pinned release");
  }
  for (const start of FEE_RECIPIENT_IMMUTABLE_REFERENCES) {
    runtime = replaceWord(runtime, start, immutableWord(normalized, "feeRecipient"));
  }
  for (const start of FEE_BPS_IMMUTABLE_REFERENCES) {
    runtime = replaceWord(runtime, start, immutableWord(normalized, "feeBps"));
  }
  const guardianWord = padHex(getAddress(guardian), { size: 32 }).slice(2).toLowerCase();
  for (const start of GUARDIAN_IMMUTABLE_REFERENCES) {
    runtime = replaceWord(runtime, start, guardianWord);
  }
  for (const start of DEPLOYMENT_BLOCK_IMMUTABLE_REFERENCES) {
    runtime = replaceWord(runtime, start, numberToHex(deploymentBlock, { size: 32 }).slice(2));
  }
  return `0x${runtime}` as Hex;
}

/** Exact configured runtime check: template plus every fee-configuration immutable occurrence. */
export function assertPaymentRouterCode(
  router: Address,
  code: Hex | undefined,
  expectedConfig: PaymentRouterConfig,
): Hex {
  if (code === undefined || code === "0x") {
    throw new Error(`configured PaymentRouter ${router} has no contract code on the selected L1 RPC`);
  }
  const normalizedConfig = normalizePaymentRouterConfig(expectedConfig);
  let runtime = code.slice(2).toLowerCase();
  if (runtime.length !== PAYMENT_ROUTER_RUNTIME_BYTES * 2) {
    throw new Error(
      `configured PaymentRouter ${router} has ${runtime.length / 2} runtime bytes, expected ${PAYMENT_ROUTER_RUNTIME_BYTES}`,
    );
  }
  const expectedRecipient = immutableWord(normalizedConfig, "feeRecipient");
  for (const start of FEE_RECIPIENT_IMMUTABLE_REFERENCES) {
    if (runtime.slice(start * 2, start * 2 + 64) !== expectedRecipient) {
      throw new Error(`configured PaymentRouter ${router} does not embed the expected fee recipient`);
    }
    runtime = replaceWord(runtime, start, "0".repeat(64));
  }
  const expectedFeeBps = immutableWord(normalizedConfig, "feeBps");
  for (const start of FEE_BPS_IMMUTABLE_REFERENCES) {
    if (runtime.slice(start * 2, start * 2 + 64) !== expectedFeeBps) {
      throw new Error(`configured PaymentRouter ${router} does not embed the expected fee BPS`);
    }
    runtime = replaceWord(runtime, start, "0".repeat(64));
  }
  for (const start of [...GUARDIAN_IMMUTABLE_REFERENCES, ...DEPLOYMENT_BLOCK_IMMUTABLE_REFERENCES]) {
    runtime = replaceWord(runtime, start, "0".repeat(64));
  }
  const actualTemplateHash = keccak256(`0x${runtime}` as Hex);
  if (actualTemplateHash.toLowerCase() !== PAYMENT_ROUTER_RUNTIME_TEMPLATE_HASH.toLowerCase()) {
    throw new Error(
      `configured PaymentRouter ${router} has runtime template hash ${actualTemplateHash}, expected ${PAYMENT_ROUTER_RUNTIME_TEMPLATE_HASH}`,
    );
  }
  return keccak256(code);
}

export async function readPaymentRouterConfig(
  client: Pick<PublicClient, "readContract">,
  router: Address,
): Promise<PaymentRouterConfig> {
  const [feeRecipient, feeBps] = await Promise.all([
    client.readContract({ address: router, abi: CONFIG_ABI, functionName: "feeRecipient" }),
    client.readContract({ address: router, abi: CONFIG_ABI, functionName: "feeBps" }),
  ]);
  return normalizePaymentRouterConfig({ feeRecipient, feeBps });
}

export async function assertPaymentRouterDeployment(
  client: Pick<PublicClient, "getCode" | "readContract">,
  router: Address,
  expectedConfig?: PaymentRouterConfig,
): Promise<VerifiedPaymentRouterDeployment> {
  const code = await client.getCode({ address: router });
  if (code === undefined || code === "0x") {
    throw new Error(`configured PaymentRouter ${router} has no contract code on the selected L1 RPC`);
  }
  const [actual, deploymentBlock] = await Promise.all([
    readPaymentRouterConfig(client, router),
    client.readContract({ address: router, abi: CONFIG_ABI, functionName: "deploymentBlock" }),
  ]);
  const runtimeCodeHash = assertPaymentRouterCode(
    router,
    code,
    actual,
  );
  if (expectedConfig !== undefined) {
    const normalized = normalizePaymentRouterConfig(expectedConfig);
    if (actual.feeRecipient !== normalized.feeRecipient || actual.feeBps !== normalized.feeBps) {
      throw new Error(
        `configured PaymentRouter ${router} reports fee recipient ${actual.feeRecipient} and ${actual.feeBps} BPS; expected ${normalized.feeRecipient} and ${normalized.feeBps} BPS`,
      );
    }
  }
  return {
    config: actual,
    deploymentBlock,
    runtimeCodeHash,
    runtimeTemplateHash: PAYMENT_ROUTER_RUNTIME_TEMPLATE_HASH,
  };
}

export async function selectedL1Client(
  node: PcashNodeClient,
  l1Urls: readonly string[],
  status?: Pick<StatusResult, "l1ChainId" | "genesisL1Block" | "genesisL1BlockHash">,
): Promise<ReturnType<typeof createPublicClient>> {
  const client = createPublicClient({ transport: l1RpcTransport(l1Urls) });
  await assertNodeL1Identity(client, status ?? await node.status());
  return client;
}

export async function verifyPaymentRouterDeployment(
  node: PcashNodeClient,
  l1Urls: readonly string[],
  router: Address,
  expectedConfig?: PaymentRouterConfig,
): Promise<VerifiedPaymentRouterDeployment> {
  const client = await selectedL1Client(node, l1Urls);
  return assertPaymentRouterDeployment(client, router, expectedConfig);
}
