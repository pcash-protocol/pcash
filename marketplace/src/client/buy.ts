// Buyer side: wallet-recoverable claim material, the router calls that pay and
// carry claims, and payment recovery.

import {
  createPublicClient,
  encodeAbiParameters,
  encodeFunctionData,
  getContractError,
  keccak256,
  parseAbi,
  stringToHex,
  bytesToHex,
  toHex,
  type Address,
  type BaseError,
  type Hex,
  type PublicClient,
} from "viem";
import {
  assertSignerChain,
  isDefinitelyNotBroadcastL1Error,
  type L1Signer,
} from "./l1Signer.ts";
import {
  scalarFromBytes,
  fullOutputCommitment,
  l1RpcTransport,
  type PcashNodeClient,
} from "@pcash/sdk/browser";
import { BATCH_HEADER_BYTES, ITEM_LENGTH_PREFIX_BYTES } from "@pcash/sdk/relay";
import type { PcashProfile } from "@pcash/sdk/wallet";
import { PADDED_PRIVATE_VALUE_BYTE_SIZE } from "@pcash/sdk/wallet/actions";
import { claimKeyCommitment, MIN_CLAIM_WINDOW_SECONDS, PAYMENT_EVENT_SIG, toBytes32 } from "../commitments.mts";
import { addressHex, sleep } from "@pcash/sdk/browser";
import { publicationEscrowNote, type OfferPublication } from "./publication.ts";
import { deriveVerifiedL2ContractMaterial, type VerifiedL2ContractMaterial } from "./verifiedContractMaterial.ts";
import type { PaymentAnchor } from "./verification.ts";
import { assertPaymentNodeFreshness } from "./paymentFreshness.ts";
import { encodePaymentRecovery, scanPayerPayments } from "./paymentRecovery.ts";
import { selectPaymentLog } from "./paymentLog.ts";
import {
  assertConfiguredL1Chain,
  assertPaymentRouterDeployment,
  PAYMENT_ROUTER_ABI,
  routerPaymentKey,
  selectedL1Client,
} from "./paymentRouter.ts";

/** The reverts buy() and retry() can raise: the router's own, then OpenZeppelin's pause, reentrancy and sendValue. */
const ROUTER_ERRORS_ABI = parseAbi([
  "error ZeroValue()",
  "error ZeroSeller()",
  "error InvalidOfferId()",
  "error ZeroClaimKeyCommitment()",
  "error NotAfterPassed()",
  "error InvalidAnchor()",
  "error AlreadyPaid(bytes32 paymentKey)",
  "error NotPaid(bytes32 paymentKey)",
  "error EnforcedPause()",
  "error ReentrancyGuardReentrantCall()",
  "error FailedCall()",
]);
/** BLOCKHASH resolves only the 256 most recent blocks, so a `buy` names an anchor within them. */
export const MAX_PAYMENT_ANCHOR_AGE_BLOCKS = 256n;
const CLAIM_KEY_DERIVATION_DOMAIN = keccak256(stringToHex("pcash marketplace deterministic claim key"));

export type PurchaseOfferIdentity = Pick<OfferPublication, "chainId" | "terms" | "l2Contract">;

export interface DerivedPurchaseSecrets {
  claimKey: bigint;
}

function derivePurchaseDigest(pub: PurchaseOfferIdentity, profile: PcashProfile, material: VerifiedL2ContractMaterial): Uint8Array {
  if (!(profile.applicationSeed instanceof Uint8Array) || profile.applicationSeed.length !== 32) {
    throw new Error("buyer PCASH profile application seed must be 32 bytes");
  }
  return keccak256(encodeAbiParameters(
    [
      { type: "bytes32" },
      { type: "bytes32" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "address" },
      { type: "address" },
      { type: "uint256" },
      { type: "uint256" },
    ],
    [
      CLAIM_KEY_DERIVATION_DOMAIN,
      bytesToHex(profile.applicationSeed),
      profile.nkRoot,
      BigInt(pub.chainId),
      addressHex(BigInt(pub.terms.router)),
      addressHex(BigInt(pub.terms.seller)),
      BigInt(pub.terms.id),
      material.address,
    ],
  ), "bytes");
}

/** Re-created from the restored wallet and immutable listing identity. */
export function derivePurchaseSecrets(pub: PurchaseOfferIdentity, profile: PcashProfile, material = deriveVerifiedL2ContractMaterial(pub)): DerivedPurchaseSecrets {
  return {
    claimKey: scalarFromBytes(derivePurchaseDigest(pub, profile, material)),
  };
}

/** The payment binds the funded escrow note, independent of the eventual claim route. */
export function purchaseEscrowOutputCommitment(
  pub: Pick<OfferPublication, "chainId" | "terms" | "l2Contract" | "escrow">,
  material = deriveVerifiedL2ContractMaterial(pub),
): bigint {
  const note = publicationEscrowNote(pub, material);
  return fullOutputCommitment(note, note.leafIndex);
}

export function purchaseCommitment(pub: OfferPublication, profile: PcashProfile): Hex {
  const material = deriveVerifiedL2ContractMaterial(pub);
  return toBytes32(claimKeyCommitment(
    derivePurchaseSecrets(pub, profile, material).claimKey, purchaseEscrowOutputCommitment(pub, material),
  ));
}

/** The claim a `buy` carries, and the snapshot terms the router checks for it. */
export interface CarriedClaim {
  /** The Ethereum block of the claim's PCASH snapshot. */
  anchor: PaymentAnchor;
  /** The latest Ethereum timestamp at which the claim can execute. */
  notAfter: bigint;
  /** The batch the router emits in `PcashBatch`. */
  batch: Hex;
}

/** `buy` pays for the offer and carries its first claim. */
export interface BuyCall {
  functionName: "buy";
  to: Hex;
  data: Hex;
  value: bigint;
  anchor: PaymentAnchor;
}

/** `retry` carries a fresh claim for a recorded payment. It pays nothing. */
export interface RetryCall {
  functionName: "retry";
  to: Hex;
  data: Hex;
  value: 0n;
}

/** One router call that carries a claim. */
export type RouterCall = BuyCall | RetryCall;

/**
 * The latest time a `buy` may execute: the claim's own limit, and no later than
 * `MIN_CLAIM_WINDOW_SECONDS` before T, which leaves time to carry a fresh claim
 * with `retry` if the node that checked this one was wrong.
 */
export function buyNotAfter(pub: Pick<OfferPublication, "terms">, claimNotAfter: bigint): bigint {
  const cutoff = BigInt(pub.terms.deadlineT) - MIN_CLAIM_WINDOW_SECONDS;
  return claimNotAfter < cutoff ? claimNotAfter : cutoff;
}

/** Bytes of the router batch that carries one claim: the batch header, one length prefix, and an S-profile transaction. */
export const CLAIM_BATCH_BYTES = Number(BATCH_HEADER_BYTES + ITEM_LENGTH_PREFIX_BYTES + PADDED_PRIVATE_VALUE_BYTE_SIZE);

/** A claim batch's size in nonzero bytes, which bounds a router call's calldata and log cost before the claim is proved. */
export function claimBatchStandIn(): Hex {
  return toHex(new Uint8Array(CLAIM_BATCH_BYTES).fill(255));
}

/**
 * The router call that pays for an offer and carries its first claim. The
 * claim-key commitment binds the buyer to this offer and funded escrow note;
 * the anchor and the time limit come from the snapshot the claim was proved against.
 */
export function buildBuyCall(
  pub: OfferPublication,
  profile: PcashProfile,
  carried: CarriedClaim,
): BuyCall {
  const data = encodeFunctionData({
    abi: PAYMENT_ROUTER_ABI,
    functionName: "buy",
    args: [
      toBytes32(BigInt(pub.terms.id)),
      addressHex(BigInt(pub.terms.seller)),
      purchaseCommitment(pub, profile),
      carried.anchor.blockNumber,
      carried.anchor.blockHash,
      buyNotAfter(pub, carried.notAfter),
      encodePaymentRecovery(pub),
      carried.batch,
    ],
  });
  return {
    functionName: "buy",
    to: addressHex(BigInt(pub.terms.router)),
    data,
    value: BigInt(pub.terms.ethPriceWei),
    anchor: carried.anchor,
  };
}

/** The router call that carries a fresh claim batch for the offer's recorded payment. */
export function buildRetryCall(pub: OfferPublication, batch: Hex): RetryCall {
  const data = encodeFunctionData({
    abi: PAYMENT_ROUTER_ABI,
    functionName: "retry",
    args: [
      toBytes32(BigInt(pub.terms.id)),
      addressHex(BigInt(pub.terms.seller)),
      BigInt(pub.terms.ethPriceWei),
      batch,
    ],
  });
  return {
    functionName: "retry",
    to: addressHex(BigInt(pub.terms.router)),
    data,
    value: 0n,
  };
}

export interface PayResult {
  hash: Hex;
  blockNumber: bigint;
  /** The Ethereum block the transaction landed in. */
  blockHash: Hex;
  replacementReason?: "repriced" | "cancelled" | "replaced";
  originalHash?: Hex;
}

export class PaymentTransactionRevertedError extends Error {
  readonly functionName: RouterCall["functionName"];
  readonly hash: Hex;
  readonly blockNumber: bigint;
  constructor(functionName: RouterCall["functionName"], hash: Hex, blockNumber: bigint) {
    super(`${functionName} transaction ${hash} reverted`);
    this.name = "PaymentTransactionRevertedError";
    this.functionName = functionName;
    this.hash = hash;
    this.blockNumber = blockNumber;
  }
}

export class PaymentTransactionCancelledError extends Error {
  readonly functionName: RouterCall["functionName"];
  readonly originalHash: Hex;
  readonly replacementHash: Hex;
  readonly blockNumber: bigint;
  constructor(functionName: RouterCall["functionName"], originalHash: Hex, replacementHash: Hex, blockNumber: bigint) {
    super(`${functionName} transaction ${originalHash} was cancelled by ${replacementHash}`);
    this.name = "PaymentTransactionCancelledError";
    this.functionName = functionName;
    this.originalHash = originalHash;
    this.replacementHash = replacementHash;
    this.blockNumber = blockNumber;
  }
}

/** The router records the listing's one payment under another claim-key commitment, so no `buy` of this wallet's can pay it. */
export class PaidForAnotherClaimKeyError extends Error {
  constructor() {
    super("this listing was paid for a different claim key; restore its buyer wallet to continue delivery");
    this.name = "PaidForAnotherClaimKeyError";
  }
}

export interface RecoveredPayResult extends PayResult {
  paidAt: number;
}

export interface RecoverablePaymentLog {
  payer: Address;
  amount: bigint;
  claimKeyCommitment: Hex;
  transactionHash: Hex;
  blockNumber: bigint;
}

export function assertPaymentRecoveryHead(observed: bigint, required: bigint): void {
  if (observed < required) {
    throw new Error(
      `selected L1 RPC is at block ${observed}, behind confirmed payment block ${required}; refusing recovery`,
    );
  }
}

/**
 * The canonical Payment event behind the router's record of this wallet's
 * claim-key commitment for the offer.
 */
export function selectRecoverablePayment(
  pub: OfferPublication,
  commitment: Hex,
  logs: readonly RecoverablePaymentLog[],
): RecoverablePaymentLog {
  const amount = BigInt(pub.terms.ethPriceWei);
  const offerLogs = logs.filter((log) => log.amount === amount);
  if (offerLogs.length !== 1) {
    throw new Error(`the router accounts this listing as paid, but its canonical Payment event could not be recovered`);
  }
  const payment = offerLogs[0]!;
  if (payment.claimKeyCommitment.toLowerCase() !== commitment.toLowerCase()) {
    throw new Error("this listing was paid for a different claim key; restore its buyer wallet to continue delivery");
  }
  return payment;
}

/**
 * Find an existing canonical payment before any attempt to send ETH again.
 *
 * Takes the restored profile rather than a signer to derive the claim commitment
 * without holding a broadcast capability.
 */
export async function recoverPayResult(
  node: PcashNodeClient,
  l1Urls: readonly string[],
  profile: PcashProfile,
  pub: OfferPublication,
  recovery: { payer: Address; hash?: Hex; minimumObservedBlock?: bigint },
): Promise<RecoveredPayResult | null> {
  const { minimumObservedBlock } = recovery;
  const status = await node.status();
  if (BigInt(pub.chainId) !== BigInt(status.pcashChainId)) {
    throw new Error(`saved offer belongs to pcash chain ${pub.chainId} but this node is chain ${status.pcashChainId}`);
  }
  const client = await selectedL1Client(node, l1Urls, status);
  const router = addressHex(BigInt(pub.terms.router)) as Address;
  const seller = addressHex(BigInt(pub.terms.seller)) as Address;
  const deployment = await assertPaymentRouterDeployment(client, router);

  if (recovery.hash !== undefined) {
    const receipt = await client.getTransactionReceipt({ hash: recovery.hash });
    const block = await client.getBlock({ blockNumber: receipt.blockNumber });
    if (block.hash !== receipt.blockHash) throw new Error("payment receipt is no longer canonical");
    if (receipt.status !== "success") return null;
    const commitment = purchaseCommitment(pub, profile);
    const matching = receipt.logs.filter(log => log.address.toLowerCase() === router.toLowerCase() && log.topics[0] === PAYMENT_EVENT_SIG);
    if (matching.length === 0) return null;
    const selected = selectPaymentLog(receipt.logs, PAYMENT_EVENT_SIG, { router: BigInt(router),
      offerId: BigInt(pub.terms.id), seller: BigInt(seller), amount: BigInt(pub.terms.ethPriceWei), claimKeyCommitment: commitment });
    if (selected.payer !== BigInt(recovery.payer)) throw new Error("payment receipt names another payer");
    return { hash: receipt.transactionHash, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash, paidAt: Number(block.timestamp * 1000n) };
  }

  const observedHead = await client.getBlockNumber();
  if (minimumObservedBlock !== undefined) {
    assertPaymentRecoveryHead(observedHead, minimumObservedBlock);
  }
  const recorded = await client.readContract({
    address: router,
    abi: PAYMENT_ROUTER_ABI,
    functionName: "paid",
    args: [routerPaymentKey(pub)],
    blockNumber: observedHead,
  });
  if (BigInt(recorded) === 0n) return null;
  const commitment = purchaseCommitment(pub, profile);
  if (recorded.toLowerCase() !== commitment.toLowerCase()) throw new PaidForAnotherClaimKeyError();

  const logs = [];
  for await (const log of scanPayerPayments(client, { router, payer: recovery.payer, deploymentBlock: deployment.deploymentBlock,
    head: observedHead, offerId: toBytes32(BigInt(pub.terms.id)), seller })) logs.push(log);
  const payment = selectRecoverablePayment(
    pub,
    commitment,
    logs.map((log) => ({
      payer: log.args.payer,
      amount: log.args.amount,
      claimKeyCommitment: log.args.claimKeyCommitment,
      transactionHash: log.transactionHash,
      blockNumber: log.blockNumber,
    })),
  );
  const block = await client.getBlock({ blockNumber: payment.blockNumber });
  if (block.hash !== logs.find(log => log.transactionHash === payment.transactionHash)?.blockHash) throw new Error("payment log is no longer canonical");
  return {
    hash: payment.transactionHash,
    blockNumber: payment.blockNumber,
    blockHash: block.hash,
    paidAt: Number(block.timestamp * 1000n),
  };
}

export type PaymentHashCheckpoint = (hash: Hex) => void | Promise<void>;

export interface PaymentBroadcastCallbacks {
  /** Durably records that the call may become live before signer authority is invoked. */
  onBroadcastRequested?: () => void | Promise<void>;
  /** Durably records the transaction hash returned by the signer. */
  onSent?: PaymentHashCheckpoint;
  /** Clears the broadcast-requested state only when the signer proves it did not broadcast. */
  onDefinitelyRejected?: (cause: unknown) => void | Promise<void>;
}

/**
 * The durable boundary around the only call that may broadcast a router call.
 * The gas limit is prepared before the boundary, so the signer does not estimate
 * after it: a revert discovered at that point would leave no transaction hash.
 */
export async function submitRouterCallWithCallbacks(
  signer: L1Signer,
  chainId: bigint,
  call: Pick<RouterCall, "to" | "data" | "value"> & { gas: bigint },
  callbacks: PaymentBroadcastCallbacks = {},
): Promise<Hex> {
  await callbacks.onBroadcastRequested?.();
  let hash: Hex;
  try {
    hash = await signer.sendTransaction({
      chainId,
      to: call.to,
      data: call.data,
      value: call.value,
      gas: call.gas,
    });
  } catch (cause) {
    if (isDefinitelyNotBroadcastL1Error(cause)) {
      await callbacks.onDefinitelyRejected?.(cause);
    }
    throw cause;
  }
  await callbacks.onSent?.(hash);
  return hash;
}

/** A sent payment still needs its canonical receipt checkpoint after a reload. */
export function isPaymentConfirmationPending(payment?: { txHash?: string; blockNumber?: string }): boolean {
  return Boolean(payment?.txHash && !payment.blockNumber);
}

type LandedReceipt = { status: "success" | "reverted"; blockNumber: bigint; blockHash: Hex };

export function successfulPayResult(
  hash: Hex,
  receipt: LandedReceipt,
  functionName: RouterCall["functionName"],
): PayResult {
  if (receipt.status !== "success") {
    throw new PaymentTransactionRevertedError(functionName, hash, receipt.blockNumber);
  }
  return { hash, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash };
}

export async function awaitPayResult(
  l1Urls: readonly string[],
  hash: Hex,
  expectedL1ChainId: bigint,
  functionName: RouterCall["functionName"],
): Promise<PayResult> {
  const client = createPublicClient({ transport: l1RpcTransport(l1Urls) });
  await assertConfiguredL1Chain(client, expectedL1ChainId);
  let replacementReason: PayResult["replacementReason"];
  const receipt = await client.waitForTransactionReceipt({
    hash,
    onReplaced: (replacement) => { replacementReason = replacement.reason; },
  });
  return replacementPayResult(hash, receipt, functionName, replacementReason);
}

export function replacementPayResult(
  originalHash: Hex,
  receipt: LandedReceipt & { transactionHash?: Hex },
  functionName: RouterCall["functionName"],
  replacementReason?: PayResult["replacementReason"],
): PayResult {
  const actualHash = receipt.transactionHash ?? originalHash;
  if (replacementReason === "cancelled") {
    throw new PaymentTransactionCancelledError(functionName, originalHash, actualHash, receipt.blockNumber);
  }
  return {
    ...successfulPayResult(actualHash, receipt, functionName),
    ...(actualHash === originalHash ? {} : { originalHash }),
    ...(replacementReason === undefined ? {} : { replacementReason }),
  };
}

interface PaymentAnchorHeadClient {
  getBlockNumber(): Promise<bigint>;
}

export interface PaymentAnchorWaitOptions {
  pollIntervalMs?: number;
  maxAttempts?: number;
}

/** The payer cannot cover the call value even before Ethereum gas is added. */
export class InsufficientPaymentBalanceError extends Error {
  readonly balanceWei: bigint;
  readonly paymentWei: bigint;

  constructor(balanceWei: bigint, paymentWei: bigint) {
    super(`not enough ETH for payment: balance ${balanceWei} wei < payment ${paymentWei} wei before gas`);
    this.name = "InsufficientPaymentBalanceError";
    this.balanceWei = balanceWei;
    this.paymentWei = paymentWei;
  }
}

/** Refuse an unaffordable payment before waiting on or simulating its router call. */
function assertPaymentBalance(balanceWei: bigint, paymentWei: bigint): void {
  if (balanceWei < paymentWei) throw new InsufficientPaymentBalanceError(balanceWei, paymentWei);
}

/** Read the payer's current L1 balance and require the payment principal. */
export async function checkPaymentBalance(
  client: Pick<PublicClient, "getBalance">,
  address: Address,
  paymentWei: bigint,
): Promise<bigint> {
  const balanceWei = await client.getBalance({ address });
  assertPaymentBalance(balanceWei, paymentWei);
  return balanceWei;
}

/** Wait until BLOCKHASH can resolve the snapshot anchor a `buy` names. */
export async function waitForHistoricalPaymentAnchor(
  client: PaymentAnchorHeadClient,
  anchorBlockNumber: bigint,
  options: PaymentAnchorWaitOptions = {},
): Promise<bigint> {
  const pollIntervalMs = options.pollIntervalMs ?? 1_000;
  const maxAttempts = options.maxAttempts ?? 300;
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 0) {
    throw new Error("payment-anchor poll interval must be a nonnegative finite number");
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error("payment-anchor maximum attempts must be a positive integer");
  }

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const head = await client.getBlockNumber();
    if (head >= anchorBlockNumber + MAX_PAYMENT_ANCHOR_AGE_BLOCKS) {
      throw new Error("the claim's snapshot anchor expired before the router call; prove the claim again");
    }
    if (head > anchorBlockNumber) return head;
    if (attempt + 1 < maxAttempts) {
      await sleep(pollIntervalMs);
    }
  }
  throw new Error("L1 head did not advance beyond the payment anchor; try again");
}

/**
 * Estimate affordable `buy` calls for a quote. A call reverts while its anchor
 * is still the L1 head, so estimates wait until the newest anchor is historical.
 */
export async function estimateRouterCallsGas(
  client: PaymentAnchorHeadClient & Pick<PublicClient, "estimateGas">,
  account: Address,
  calls: readonly BuyCall[],
  options: PaymentAnchorWaitOptions = {},
): Promise<bigint[]> {
  if (calls.length === 0) return [];
  const newestAnchor = calls.reduce((newest, call) => call.anchor.blockNumber > newest ? call.anchor.blockNumber : newest, 0n);
  await waitForHistoricalPaymentAnchor(client, newestAnchor, options);
  return Promise.all(calls.map(call => estimateRouterCallGas(client, account, call)));
}

/** Estimate the exact call bytes, naming the router's error if the call would revert. */
async function estimateRouterCallGas(
  client: Pick<PublicClient, "estimateGas">,
  account: Address,
  call: Pick<RouterCall, "functionName" | "to" | "data" | "value">,
): Promise<bigint> {
  try {
    return await client.estimateGas({ account, to: call.to as Address, data: call.data as Hex, value: call.value });
  } catch (error) {
    // The ABI holds only errors, so viem prints no call arguments.
    throw getContractError(error as BaseError, { abi: ROUTER_ERRORS_ABI, args: undefined, address: call.to as Address, functionName: call.functionName, sender: account });
  }
}

/** Latest timestamp from the exact L1 chain followed by the selected PCASH node. */
export async function paymentL1Timestamp(node: PcashNodeClient, l1Urls: readonly string[]): Promise<bigint> {
  const client = await selectedL1Client(node, l1Urls);
  return (await client.getBlock({ blockTag: "latest" })).timestamp;
}

/** The L1 balance must cover the call's value and its gas at the current fee cap. Returns the gas estimate. */
export async function assertRouterCallBudget(
  client: Pick<PublicClient, "estimateGas" | "estimateFeesPerGas" | "getBalance">,
  address: Address,
  call: RouterCall,
): Promise<bigint> {
  const balance = await checkPaymentBalance(client, address, call.value);
  const [gas, fees] = await Promise.all([
    estimateRouterCallGas(client, address, call),
    client.estimateFeesPerGas(),
  ]);
  if (balance < call.value + gas * fees.maxFeePerGas) {
    throw new Error(call.value === 0n ? "not enough ETH for the retry's gas" : "not enough ETH for the payment and its gas");
  }
  return gas;
}

/**
 * Send a router call and wait for its Ethereum receipt.
 *
 * Every precondition is checked before the signer is asked to broadcast. The
 * caller has already dry-run the claim a `buy` carries; a reverting call, such as
 * `buy` on a paused router, fails at the gas estimate before any broadcast.
 */
export async function sendRouterCall(
  node: PcashNodeClient,
  l1Urls: readonly string[],
  signer: L1Signer,
  call: RouterCall,
  callbacks: PaymentBroadcastCallbacks = {},
): Promise<PayResult> {
  const status = await node.status();
  const client = await selectedL1Client(node, l1Urls, status);
  // The signer can be on a different network than the read RPC, so this is
  // checked on its own rather than inferred from the client above.
  await assertSignerChain(signer, status.l1ChainId);
  await assertPaymentRouterDeployment(client, call.to as Address);
  if (call.functionName === "buy") {
    await waitForHistoricalPaymentAnchor(client, call.anchor.blockNumber);
    await assertSignerChain(signer, status.l1ChainId);
  }
  const gas = await assertRouterCallBudget(client, signer.address, call);
  const [latestStatus, l1Head] = await Promise.all([
    node.status(),
    client.getBlockNumber({ cacheTime: 0 }),
  ]);
  assertPaymentNodeFreshness(latestStatus.latestL1BlockNumber, l1Head);
  const hash = await submitRouterCallWithCallbacks(signer, status.l1ChainId, { ...call, gas }, callbacks);
  let replacementReason: PayResult["replacementReason"];
  const receipt = await client.waitForTransactionReceipt({
    hash,
    onReplaced: (replacement) => { replacementReason = replacement.reason; },
  });
  return replacementPayResult(hash, receipt, call.functionName, replacementReason);
}
