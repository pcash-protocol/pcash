import { buildAuthorizedReferenceUserAccountCreation } from "@pcash/sdk/builders";
import { encodeUserAccountCreation } from "@pcash/sdk/protocol";
import { transactionIdentity as submissionIdentity } from "@pcash/sdk/protocol";
import { setupPaymentRouter } from "@pcash/marketplace/tooling/paymentRouterSetup";
import { mkdir, writeFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  createPublicClient,
  decodeFunctionData,
  hexToBytes,
  http,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  addressHex,
  buildExtendedCode,
  BN254_SCALAR_MODULUS,
  awaitAcceptedReceipt,
  awaitReceipt,
  bytes32Hex,
  randomFieldEntropy,
  sleep,
  pcashL1Chain,
  buildContractFunctionCall,
  boundaryId,
  decodeContractBody,
  fullOutputCommitment,
  noteNk,
  nullifier,
  createReleaseChonkCircuitResolver,
  nativeChonkBackend,
  proveTransferTransactionChonk,
  requireSameBoundary,
  requestPcashAuthorization,
  requestPcashProfile,
  resolveNetworkConfig,
  createWalletProvers,
  scanWallet,
  snapshotFromAccountProof,
  openMemoryNodeWallet,
  openNodeWallet,
  type NetworkConfigLike,
  type PcashActionSigner,
  type PcashNodeClient,
  type PcashProfile,
  type ReceiptResult,
  type WalletProfile,
  type WalletProfileWithReceiveKeys,
  type Wallet,
} from "../deps.ts";
import {
  MAX_PAYMENT_DEADLINE_T,
  MIN_CLAIM_WINDOW_SECONDS,
  CLAIM_APPLICATION_VK_HASH,
  RECLAIM_APPLICATION_VK_HASH,
  reclaimNotBefore,
  toBytes32,
  RECLAIM_FUNCTION_SELECTOR,
  createOffer,
  type Offer,
  type OfferTerms,
} from "@pcash/marketplace";
import {
  buildReclaimWitnessMap,
  reclaimAuthorizationRequest,
  type ReclaimWitnessParams,
} from "@pcash/marketplace/proofs";
import {
  buildBuyCall,
  claimBatch,
  claimNotAfter,
  fetchCatalogOffers,
  normalizePaymentRouterConfig,
  offerKey,
  parsePublication,
  PAYMENT_ROUTER_ABI,
  paymentCarrier,
  privateKeyL1Signer,
  PURCHASE_MARGIN_SECONDS,
  proveCarriedClaim,
  publicationFromOffer,
  publishCatalogOffer,
  purchaseCommitment,
  readClaimSnapshot,
  sendRouterCall,
  serializePublication,
  verifyOffer,
  verifyOfferForPayment,
  type MarketplaceController,
  type OfferPublication,
  type OfferVerification,
  type PaymentRouterConfig,
} from "@pcash/marketplace/client";
import { prepareMarketplaceSeedOffers } from "@pcash/marketplace/tooling/seedPreparation";
import { l1FeeCaps } from "../backends/rpc.ts";
import type { E2eConfig } from "../config.ts";
import type { AcceptedScenarioSubmission, ScenarioFixture } from "../fixture/scenarioFixture.ts";
import type { ScenarioActor } from "../actors/actor.ts";
import { proofRejectedTransfer } from "../seed/seedControls.ts";
import { marketplaceController, nativeMarketplaceProver } from "./marketplaceClient.ts";
import { setupUserWallets } from "./setup.ts";

const DEFAULT_MARKETPLACE_ETH_PRICE_WEI = 1_000_000_000_000_000n;
/** A sold offer stays open for purchases for an hour before the client's purchase cutoff. */
const DEFAULT_CLAIM_DEADLINE_LEAD_SECONDS = MIN_CLAIM_WINDOW_SECONDS + PURCHASE_MARGIN_SECONDS + 3_600n;
const DEFAULT_RECLAIM_DEADLINE_LEAD_SECONDS = MIN_CLAIM_WINDOW_SECONDS;
const MAX_TRANSFER_TIMESTAMP = 4_000_000_000n;

export interface MarketplaceSubmission {
  contentHash: string;
  kind: string;
  inclusionBlock: bigint;
  inclusionBlockHash: string;
  outputLeafStart: bigint | null;
}

export interface MarketplaceScenarioContext {
  repoRoot: string;
  workDir: string;
  l1RpcUrl: string;
  node: PcashNodeClient;
  network: NetworkConfigLike;
  seller: PcashProfile;
  sellerSigner: PcashActionSigner;
  buyer: PcashProfile;
  buyerSigner: PcashActionSigner;
  /** Durable seller inventory populated by the public CLI journey. */
  sellerWalletDatabasePath: string;
  /** Reuse an already-open seller wallet when the caller owns its lifecycle. */
  sellerWallet?: Wallet;
  /** Only its address is used: the router pays the seller, who never sends an L1 transaction. */
  sellerL1PrivateKey: Hex;
  /** Sends every router call that buys or retries, as the buyer's browser wallet would. */
  buyerL1PrivateKey: Hex;
  /** Deploys a router when none is configured. */
  routerDeployerPrivateKey: Hex;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  /** Open-route fee each seller action pays whoever publishes it. */
  openFeeAmount: bigint;
  /** Admit exact bytes to the shared node/mempool/relayer route and wait only for canonical acceptance. */
  submitAndWait: (entry: Uint8Array, label: string) => Promise<MarketplaceSubmission>;
  /**
   * Publish exact bytes on Ethereum as the seller's own action and wait for
   * canonical acceptance. Zero-fee seed fixtures use this route.
   */
  selfPublish: (entry: Uint8Array, label: string) => Promise<MarketplaceSubmission>;
  /** Persist irreversible-action identifiers before waiting for their receipts. */
  checkpoint?: (label: string, value: Record<string, string>) => void | Promise<void>;
  routerAddress?: Address;
  routerConfig: PaymentRouterConfig;
  ethPriceWei?: bigint;
  pcashAmount?: bigint;
  claimDeadlineLeadSeconds?: bigint;
  reclaimDeadlineLeadSeconds?: bigint;
  pollIntervalMs?: number;
  /** Controllable backends advance chain time past T for the timed reclaim. */
  advanceToTimestamp?: (target: bigint) => Promise<bigint>;
  /** Optional deployment-side publication into a generic source-verification registry. */
  publishSourceVerification?: (offer: Offer) => Promise<void>;
  /** Stop after deploying and publishing source for both contract instances. */
  sourceVerificationOnly?: boolean;
  /** Complete the paid lifecycle but retain the unpaid offer as funded escrow. */
  leaveUnpaidEscrowed?: boolean;
  /**
   * Also sell a third offer whose payment carries a failing claim, and finish
   * that purchase from a freshly restored buyer wallet through `retry`.
   */
  recoverFailedClaim?: boolean;
  /** Seed mode selects current-run inventory only when funding actually starts. */
  deferFundingInventory?: boolean;
  /** Optional wave barrier before the paid offer selects seller inventory. */
  beforePaidFunding?: () => Promise<void>;
  randomField?: () => bigint;
  log?: (message: string) => void;
}

export interface MarketplaceEscrowSeedEvidence {
  router: MarketplaceScenarioEvidence["router"];
  catalog: MarketplaceScenarioEvidence["catalog"];
  paidOffer: MarketplaceScenarioEvidence["paidOffer"];
  unpaidOffer: {
    offerId: string;
    contractAddress: Address;
    contractContentHash: string;
    fundingContentHash: string;
    deadlineT: string;
    escrowLeaf: string;
    escrowAmount: string;
  };
}

export function marketplaceSellerWalletSettleOptions(
  context: Pick<MarketplaceScenarioContext, "deferFundingInventory" | "pollIntervalMs">,
): { settlePollIntervalMs?: number; settlePollMaxAttempts?: number } {
  return context.deferFundingInventory === true
    ? { settlePollIntervalMs: Math.min(context.pollIntervalMs ?? 1_000, 100), settlePollMaxAttempts: 1 }
    : {};
}

export interface MarketplaceScenarioEvidence {
  router: {
    address: Address;
    deploymentTxHash: Hex | null;
    deploymentBlock: string | null;
  };
  catalog: {
    paidOfferKey: string;
    unpaidOfferKey: string;
    paidOfferChecks: string[];
    unpaidOfferChecks: string[];
  };
  paidOffer: {
    offerId: string;
    contractAddress: Address;
    contractContentHash: string;
    fundingContentHash: string;
    /** The one `buy` that paid for the offer and carried its claim. */
    paymentTxHash: Hex;
    paymentBlock: string;
    claimContentHash: string;
    buyerOutputLeaf: string;
    buyerNoteAmount: string;
    sellerPayoutWei: string;
    feePayoutWei: string;
  };
  recoveredOffer?: {
    offerId: string;
    contractAddress: Address;
    paymentTxHash: Hex;
    /** The outcome the payment's own carried claim received. */
    failedClaimOutcome: string;
    retryTxHash: Hex;
    claimContentHash: string;
    buyerOutputLeaf: string;
  };
  unpaidOffer: {
    offerId: string;
    contractAddress: Address;
    contractContentHash: string;
    fundingContentHash: string;
    deadlineT: string;
    observedReclaimTimestamp: string;
    reclaimContentHash: string;
    sellerOutputLeaf: string;
    sellerNoteAmount: string;
  };
  controls: {
    /** The accepted claim's exact bytes, carried again by the router, as the node's dry run classifies them. */
    duplicateClaimOutcome: string;
    earlyReclaimRejected: true;
    paidEscrowSpent: true;
    reclaimedEscrowSpent: true;
  };
}

interface SpendNote {
  leafIndex: number;
  noteSecret: bigint;
  amount: bigint;
  assetId: bigint;
}

type VerificationTarget = "payable" | "escrowed" | "spent";

interface FundedOffer {
  offer: Offer;
  publication: OfferPublication;
  contractSubmission: MarketplaceSubmission;
  fundingSubmission: MarketplaceSubmission;
  escrow: SpendNote;
  catalogPublication: OfferPublication;
  verification: OfferVerification;
}

/** The buyer's Marketplace client over its own wallet, as the website runs it. */
interface MarketplaceBuyer {
  wallet: Wallet;
  controller: MarketplaceController;
  close(): Promise<void>;
}

interface Runtime {
  context: MarketplaceScenarioContext;
  network: ReturnType<typeof resolveNetworkConfig>;
  l1: ReturnType<typeof createPublicClient>;
  router: Address;
  sellerAccount: ReturnType<typeof privateKeyToAccount>;
  sellerWallet: Wallet;
  buyer: MarketplaceBuyer;
  pollIntervalMs: number;
  log: (message: string) => void;
}

async function synchronizeSellerInventory(runtime: Runtime): Promise<void> {
  await runtime.sellerWallet.sync();
}

async function proveTransaction(
  build: ReturnType<typeof buildContractFunctionCall>,
  authorizationPackage: string,
  authorizationWitnessMap: Record<string, unknown>,
): Promise<Uint8Array> {
  return (await proveTransferTransactionChonk({
    build,
    authorizationPackage,
    authorizationWitnessMap,
    resolve: createReleaseChonkCircuitResolver(),
    backend: nativeChonkBackend(),
  })).proof;
}

async function filterUnspent(runtime: Runtime, wallet: WalletProfile, notes: SpendNote[]): Promise<SpendNote[]> {
  if (notes.length === 0) return [];
  const nk = noteNk(wallet.nkRoot);
  const nullifiers = notes.map((note) => toBytes32(nullifier(
    fullOutputCommitment(
      { owner: wallet.address, noteSecret: note.noteSecret, assetId: note.assetId, amount: note.amount },
      note.leafIndex,
    ),
    nk,
    note.noteSecret,
  )));
  const spent = await currentNullifierDecision(runtime, nullifiers);
  return notes.filter((_, index) => !spent[index]);
}

async function currentNullifierDecision(runtime: Runtime, nullifiers: readonly string[]): Promise<boolean[]> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const decision = await runtime.context.node.getCurrentNullifierStatuses(nullifiers);
    if (decision.boundary === null || decision.statuses.length !== nullifiers.length) {
      throw new Error("node returned the wrong marketplace nullifier status count");
    }
    const status = await runtime.context.node.status();
    if (
      decision.boundary.header.number === status.latestBlock
      && boundaryId(decision.boundary).toLowerCase() === status.latestBlockHash.toLowerCase()
    ) return decision.statuses.map((result) => result.spent);
  }
  throw new Error("PCASH head changed during marketplace nullifier decision");
}

async function findSpendableNote(
  runtime: Runtime,
  wallet: WalletProfileWithReceiveKeys,
  minimumAmount: bigint,
): Promise<SpendNote> {
  for (let attempt = 0; attempt < 120; attempt++) {
    const report = await scanWallet(runtime.context.node, wallet, runtime.network.pcashChainId);
    const candidates = report.recovered
      .map((note) => ({
        leafIndex: Number(note.leafIndex),
        noteSecret: BigInt(note.noteSecret),
        amount: BigInt(note.amount),
        assetId: BigInt(note.assetId),
      }))
      .filter((note) => note.assetId === 0n && note.amount >= minimumAmount)
      .sort((left, right) => (left.amount > right.amount ? -1 : left.amount < right.amount ? 1 : 0));
    const unspent = await filterUnspent(runtime, wallet, candidates);
    if (unspent[0] !== undefined) return unspent[0];
    if (attempt < 119) await sleep(runtime.pollIntervalMs);
  }
  throw new Error(`seller has no spendable PCASH note of at least ${minimumAmount}`);
}

async function recoverExactNote(
  runtime: Runtime,
  wallet: WalletProfileWithReceiveKeys,
  leafIndex: bigint,
  amount: bigint,
  label: string,
): Promise<SpendNote> {
  const safeLeafIndex = Number(leafIndex);
  if (!Number.isSafeInteger(safeLeafIndex) || safeLeafIndex < 0) throw new Error(`${label} leaf index is not a safe nonnegative integer`);
  for (let attempt = 0; attempt < 120; attempt++) {
    const report = await scanWallet(runtime.context.node, wallet, runtime.network.pcashChainId);
    const matches = report.recovered
      .filter((note) => Number(note.leafIndex) === safeLeafIndex && BigInt(note.amount) === amount)
      .map((note) => ({
        leafIndex: safeLeafIndex,
        noteSecret: BigInt(note.noteSecret),
        amount,
        assetId: BigInt(note.assetId),
      }));
    const unspent = await filterUnspent(runtime, wallet, matches);
    if (unspent[0] !== undefined) return unspent[0];
    if (attempt < 119) await sleep(runtime.pollIntervalMs);
  }
  throw new Error(`${label} was not recovered at note leaf ${leafIndex}`);
}

async function waitForContract(runtime: Runtime, offer: Offer): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt++) {
    const contract = await runtime.context.node.getContract(
      addressHex(offer.l2ContractAddress),
    ).catch(() => null);
    if (contract?.status === "contract") {
      if (BigInt(contract.accountProof.account.accountRuleSetCommitment) !== offer.functionSetCommitment) {
        throw new Error("marketplace contract function-set commitment mismatch");
      }
      return;
    }
    if (contract?.status === "notContract") {
      throw new Error("marketplace contract address is occupied by a user account");
    }
    if (attempt < 119) await sleep(runtime.pollIntervalMs);
  }
  throw new Error(`marketplace contract ${addressHex(offer.l2ContractAddress)} never appeared on the node`);
}

async function deployOrUseRouter(
  context: MarketplaceScenarioContext,
  network: ReturnType<typeof resolveNetworkConfig>,
): Promise<MarketplaceScenarioEvidence["router"]> {
  const ready = await setupPaymentRouter({
    rpcUrl: context.l1RpcUrl,
    l1ChainId: network.l1ChainId,
    cacheRoot: join(context.workDir, "marketplace"),
    routerConfig: context.routerConfig,
    explicitAddress: context.routerAddress,
    privateKey: context.routerDeployerPrivateKey,
    fees: {
      maxFeePerGas: context.maxFeePerGas,
      maxPriorityFeePerGas: context.maxPriorityFeePerGas,
    },
  });
  return {
    address: ready.address,
    deploymentTxHash: ready.deployment?.deploymentTxHash ?? null,
    deploymentBlock: ready.deployment?.deploymentBlock ?? null,
  };
}

/** The fee terms a run deploys a new router with. */
export function marketplaceRouterConfig(config: E2eConfig): PaymentRouterConfig {
  return normalizePaymentRouterConfig({
    feeRecipient: config.marketplace.feeRecipient,
    feeBps: config.marketplace.feeBps,
  });
}

/** The buyer's own wallet, restored from its profile and synced from the node, and its Marketplace client. */
async function openBuyer(context: MarketplaceScenarioContext, profile: PcashProfile, router: Address): Promise<MarketplaceBuyer> {
  const wallet = await openMemoryNodeWallet({
    node: context.node,
    profile,
    signer: context.buyerSigner,
    provers: createWalletProvers("native"),
  });
  try {
    await wallet.sync();
  } catch (error) {
    await wallet.close();
    throw error;
  }
  const controller = marketplaceController({
    node: context.node,
    wallet,
    l1RpcUrl: context.l1RpcUrl,
    l1PrivateKey: context.buyerL1PrivateKey,
    router,
    feeCap: { maxFeePerGas: context.maxFeePerGas, maxPriorityFeePerGas: context.maxPriorityFeePerGas },
  });
  return { wallet, controller, close: () => wallet.close() };
}

async function publishContract(runtime: Runtime, offer: Offer, label: string): Promise<MarketplaceSubmission> {
  const submission = await publishAttachedContract(runtime, offer, label);
  if (submission.kind !== "privateValue") {
    throw new Error(`${label} contract was accepted as ${submission.kind}, expected privateValue`);
  }
  await waitForContract(runtime, offer);
  return submission;
}

/** Seed fixtures publish bodies separately; zero-fee fixtures self-publish. */
async function publishAttachedContract(runtime: Runtime, offer: Offer, label: string): Promise<MarketplaceSubmission> {
  const selfPublished = runtime.context.openFeeAmount === 0n;
  const created = await runtime.sellerWallet.send({
    to: addressHex(runtime.context.seller.address),
    amount: 0n,
    accountCreation: { kind: "contract", body: offer.l2ContractBody },
    openFeeAmount: runtime.context.openFeeAmount,
    submission: {
      mode: selfPublished ? "l1" : "mempool",
      preflight: async () => undefined,
      async submit({ transactionBytes: entry }) {
        const { contentHash } = submissionIdentity(entry);

        const accepted = await (selfPublished ? runtime.context.selfPublish : runtime.context.submitAndWait)(entry, `${label}:contract`);
        if (accepted.contentHash.toLowerCase() !== contentHash.toLowerCase()) {
          throw new Error(`${label} attached contract submission returned the wrong content hash`);
        }
        return { accepted: true, queued: false, output: accepted };
      },
    },
    onPrepared: (contentHash, transactionHex) => runtime.context.checkpoint?.(`${label}:contract-prepared`, { contentHash, transactionHex }),
  });
  const receipt = await awaitAcceptedReceipt(runtime.context.node, created.contentHash);
  const submission = (created.submission?.output as MarketplaceSubmission | undefined) ?? {
    contentHash: created.contentHash,
    kind: receipt.kind,
    inclusionBlock: receipt.inclusion.l1BlockNumber,
    inclusionBlockHash: receipt.inclusion.l1BlockHash,
    outputLeafStart: receipt.outputLeafStart,
  };
  if (receipt.settledOpenFeeAmount !== runtime.context.openFeeAmount) {
    throw new Error(`${label} attached contract creation did not settle the relayer fee`);
  }
  return submission;
}

async function fundOffer(runtime: Runtime, offer: Offer, contractSubmission: MarketplaceSubmission | undefined, amount: bigint, label: string, verificationTarget: Exclude<VerificationTarget, "spent">): Promise<FundedOffer> {
  const funding = await runtime.sellerWallet.send({
      to: buildExtendedCode({ chainId: runtime.network.pcashChainId, address: offer.l2ContractAddress, mlKemPublicKey: offer.l2ContractWallet.mlKemPublicKey! }),
      accountCreation: { kind: "contract", body: offer.l2ContractBody },
      amount,
      openFeeAmount: runtime.context.openFeeAmount,
      validUntilTimestamp: MAX_TRANSFER_TIMESTAMP,
      validUntilMode: "exact",
      submission: {
        mode: "mempool",
        preflight: async () => undefined,
        async submit({ transactionBytes: entry }) {
          const { contentHash } = submissionIdentity(entry);

          const accepted = await runtime.context.submitAndWait(entry, `${label}:fund`);
          if (accepted.contentHash.toLowerCase() !== contentHash.toLowerCase()) {
            throw new Error(`${label} funding submission returned the wrong content hash`);
          }
          return { accepted: true, queued: false, output: accepted };
        },
      },
      onPrepared: (contentHash, transactionHex) => runtime.context.checkpoint?.(`${label}:funding-prepared`, { contentHash, transactionHex }),
  });
  let fundingSubmission = funding.submission?.output as MarketplaceSubmission | undefined;
  if (fundingSubmission === undefined) {
    const receipt = await awaitAcceptedReceipt(runtime.context.node, funding.contentHash);
    fundingSubmission = {
      contentHash: funding.contentHash,
      kind: receipt.kind,
      inclusionBlock: receipt.inclusion.l1BlockNumber,
      inclusionBlockHash: receipt.inclusion.l1BlockHash,
      outputLeafStart: receipt.outputLeafStart,
    };
  }
  if (fundingSubmission.kind !== "privateValue" || fundingSubmission.outputLeafStart === null) {
    throw new Error(`${label} funding did not produce a privateValue note receipt`);
  }
  const escrow = await recoverExactNote(
    runtime,
    offer.l2ContractWallet,
    fundingSubmission.outputLeafStart,
    amount,
    `${label} escrow note`,
  );
  const publication = publicationFromOffer(offer);
  publication.escrow = {
    leafIndex: escrow.leafIndex,
    noteSecret: bytes32Hex(escrow.noteSecret),
    amount: bytes32Hex(escrow.amount),
  };
  const { catalogPublication, verification } = await publishFetchAndVerify(runtime, publication, label, verificationTarget);
  return { offer, publication, contractSubmission: contractSubmission ?? fundingSubmission, fundingSubmission, escrow, catalogPublication, verification };
}

async function fetchCatalogPublication(runtime: Runtime, expected: OfferPublication): Promise<OfferPublication> {
  // The adapter already skips malformed and wrong-network entries and collapses
  // duplicates, so a miss here means our own offer is genuinely absent.
  const expectedKey = offerKey(expected);
  const offers = await fetchCatalogOffers(runtime.context.node);
  const found = offers.filter((candidate) => offerKey(candidate) === expectedKey);
  if (found.length !== 1) {
    throw new Error(`catalog returned ${found.length} copies of marketplace offer ${expectedKey}, expected 1`);
  }
  return found[0]!;
}

async function verifyUntil(runtime: Runtime, publication: OfferPublication, target: VerificationTarget): Promise<OfferVerification> {
  let latest: OfferVerification | undefined;
  for (let attempt = 0; attempt < 30; attempt++) {
    latest = target === "payable"
      ? await verifyOfferForPayment(runtime.context.node, publication, {
          expectedRouter: publication.terms.router,
          expectedNetwork: runtime.network,
          l1Urls: [runtime.context.l1RpcUrl],
        })
      : await verifyOffer(runtime.context.node, publication, {
          expectedRouter: publication.terms.router,
          expectedNetwork: runtime.network,
        });
    if (
      (target === "payable" && latest.safeToPay)
      || (target === "escrowed" && latest.escrow === "escrowed")
      || (target === "spent" && latest.escrow === "spent")
    ) return latest;
    if (attempt < 29) await sleep(runtime.pollIntervalMs);
  }
  throw new Error(`marketplace offer never reached ${target} verification:\n${latest?.checks.join("\n") ?? "no verification result"}`);
}

async function publishFetchAndVerify(runtime: Runtime, publication: OfferPublication, label: string, target: Exclude<VerificationTarget, "spent">): Promise<{ catalogPublication: OfferPublication; verification: OfferVerification }> {
  const transported = parsePublication(serializePublication(publication));
  const stored = await publishCatalogOffer(runtime.context.node, transported);
  runtime.log(`${label}: catalog stored contentId ${stored.artifact.contentId} createdAt ${stored.createdAt}`);
  const catalogPublication = await fetchCatalogPublication(runtime, transported);
  const verification = await verifyUntil(runtime, catalogPublication, target);
  runtime.log(`${label}: catalog publication fetched and independently verified`);
  return { catalogPublication, verification };
}

async function readConsistentContractState(runtime: Runtime, offer: Offer, escrow: SpendNote) {
  const commitment = fullOutputCommitment(
    { owner: offer.l2ContractAddress, noteSecret: escrow.noteSecret, assetId: 0n, amount: escrow.amount },
    escrow.leafIndex,
  );
  for (let attempt = 0; attempt < 120; attempt++) {
    const [block, outputPath, accountPath] = await Promise.all([
      runtime.context.node.getBlockHeader("latest"),
      runtime.context.node.getOutputPath(escrow.leafIndex, commitment),
      runtime.context.node.getAccountProof(addressHex(offer.l2ContractAddress)),
    ]);
    if (outputPath === null) throw new Error("escrow output is not in the current tree");
    if (accountPath.status === "present") {
      try {
        requireSameBoundary(block.boundary, outputPath.boundary);
        requireSameBoundary(block.boundary, accountPath.boundary);
        return { block, outputPath, accountPath };
      } catch {
        // A normal head advance retries this small coherent read.
      }
    }
    if (attempt < 119) await sleep(runtime.pollIntervalMs);
  }
  throw new Error("node never exposed one consistent marketplace contract snapshot");
}

/** ETH an account gained in one L1 block; the router pays sellers and fees inside buy(). */
async function balanceGain(runtime: Runtime, address: Address, blockNumber: bigint): Promise<bigint> {
  const [before, after] = await Promise.all([
    runtime.l1.getBalance({ address, blockNumber: blockNumber - 1n }),
    runtime.l1.getBalance({ address, blockNumber }),
  ]);
  return after - before;
}

/**
 * The accepted receipt of a claim the router carried: its Ethereum transaction
 * is a router `buy` or `retry`, and the node's one manifest for that
 * transaction is the router's `PcashBatch` event, which holds the claim.
 */
async function routerCarriedClaim(
  runtime: Runtime,
  contentHash: string,
  functionName: "buy" | "retry",
): Promise<ReceiptResult> {
  const receipt = await awaitAcceptedReceipt(runtime.context.node, contentHash);
  const hash = receipt.inclusion.l1TransactionHash as Hex;
  const [transaction, carriers] = await Promise.all([
    runtime.l1.getTransaction({ hash }),
    runtime.context.node.getL1DeliveryBatches(hash),
  ]);
  const call = decodeFunctionData({ abi: PAYMENT_ROUTER_ABI, data: transaction.input });
  if (transaction.to?.toLowerCase() !== runtime.router.toLowerCase() || call.functionName !== functionName) {
    throw new Error(`claim ${contentHash} was carried by ${call.functionName} to ${transaction.to}, expected router ${functionName}`);
  }
  const carrier = carriers[0];
  if (
    carriers.length !== 1
    || carrier?.carrierType !== "event"
    || carrier.emitter?.toLowerCase() !== runtime.router.toLowerCase()
    || carrier.logIndex === null
    || carrier.exclusionReason !== null
    || !carrier.items.some((item) => item.batchItemIndex === receipt.inclusion.batchItemIndex
      && item.contentHash.toLowerCase() === contentHash.toLowerCase())
  ) {
    throw new Error(`Ethereum transaction ${hash} has no router event carrier holding claim ${contentHash}`);
  }
  return receipt;
}

/** An escrow claim registers its fresh recipient in the same result. */
async function buyAndRegister(runtime: Runtime, publication: OfferPublication): Promise<{ claimContentHash: Hex; paymentHash: Hex }> {
  const { context } = runtime;
  const { node, buyer } = context;
  const snapshot = await readClaimSnapshot(node, publication);
  const validUntilTimestamp = BigInt(publication.terms.deadlineT);
  const creation = await buildAuthorizedReferenceUserAccountCreation({
    chainId: runtime.network.pcashChainId, network: runtime.network, wallet: buyer,
    defaultRuleSecrets: buyer.defaultUserRuleSecrets, mlKemPublicKey: buyer.mlKemPublicKey!,
    recentPcashBlockHash: snapshot.account.boundary.blockHash, validUntilTimestamp,
  }, context.buyerSigner);
  const accountCreation = { kind: "user" as const, transactionBytes: encodeUserAccountCreation(runtime.network.pcashChainId, creation.body) };
  const proved = await proveCarriedClaim({ node, offer: publication, buyer, snapshot, accountCreation,
    buyerReceiveKey: async () => buyer.mlKemPublicKey!, prover: nativeMarketplaceProver() });
  const dryRun = await node.checkRawTransaction(hexToBytes(proved.transactionHex), paymentCarrier(publication, purchaseCommitment(publication, buyer)));
  if (dryRun.outcome !== "succeeded") throw new Error(`fresh-recipient claim dry-ran as ${dryRun.outcome}`);
  const call = buildBuyCall(publication, buyer, { anchor: snapshot.anchor,
    notAfter: claimNotAfter(snapshot.timestamp, validUntilTimestamp), batch: claimBatch(await node.status(), buyer, proved.transactionHex) });
  const payment = await sendRouterCall(node, [context.l1RpcUrl], privateKeyL1Signer(context.buyerL1PrivateKey, context.l1RpcUrl, {
    maxFeePerGas: context.maxFeePerGas, maxPriorityFeePerGas: context.maxPriorityFeePerGas,
  }), call);
  await awaitAcceptedReceipt(node, proved.contentHash);
  return { claimContentHash: proved.contentHash, paymentHash: payment.hash };
}

async function runPaidLifecycle(runtime: Runtime, funded: FundedOffer): Promise<{
  evidence: MarketplaceScenarioEvidence["paidOffer"];
  duplicateClaimOutcome: string;
}> {
  const publication = funded.catalogPublication;
  const feeQuote = funded.verification.feeQuote;
  if (!funded.verification.safeToPay || feeQuote === null) {
    throw new Error("paid marketplace offer lost its safe-to-pay verdict before payment");
  }
  const { node, buyer } = runtime.context;
  // The client proves the claim, dry-runs it with the router's carrier context,
  // and sends one buy() that pays and carries it.
  const unregistered = (await node.getAccountProof(addressHex(buyer.address))).status === "notFound";
  const bought = unregistered
    ? await buyAndRegister(runtime, publication)
    : await runtime.buyer.controller.buy(publication);
  if (unregistered) {
    if ((await node.getAccountProof(addressHex(buyer.address))).status !== "present") throw new Error("claim did not register its recipient");
    await runtime.buyer.wallet.sync();
  }
  const claim = await routerCarriedClaim(runtime, bought.claimContentHash, "buy");
  if (claim.inclusion.l1TransactionHash.toLowerCase() !== bought.paymentHash.toLowerCase()) {
    throw new Error("the marketplace claim was not carried by the payment that bought it");
  }
  const paymentBlock = claim.inclusion.l1BlockNumber;
  runtime.log(`marketplace buy paid and claimed in Ethereum block ${paymentBlock}`);
  const [sellerPayoutWei, feePayoutWei] = await Promise.all([
    balanceGain(runtime, runtime.sellerAccount.address, paymentBlock),
    balanceGain(runtime, feeQuote.feeRecipient, paymentBlock),
  ]);
  if (sellerPayoutWei !== feeQuote.sellerNetWei || feePayoutWei !== feeQuote.websiteFeeWei) {
    throw new Error(
      `PaymentRouter paid seller ${sellerPayoutWei} and fee recipient ${feePayoutWei} wei; expected ${feeQuote.sellerNetWei} and ${feeQuote.websiteFeeWei}`,
    );
  }
  if (claim.kind !== "privateValue" || claim.outputLeafStart === null) {
    throw new Error("marketplace claim did not produce a privateValue note receipt");
  }
  // The claim pays the buyer the whole escrow with no open fee.
  const amount = BigInt(publication.terms.amount);
  const buyerNote = await recoverExactNote(runtime, buyer, claim.outputLeafStart, amount, "buyer marketplace claim note");

  // The same bytes, carried again by the router, would find the escrow note spent.
  const accepted = await node.getTransaction(claim.transactionId);
  if (accepted === null) throw new Error("the accepted marketplace claim is not readable");
  const duplicate = await node.checkRawTransaction(
    hexToBytes(accepted.rawTransaction as Hex),
    paymentCarrier(publication, purchaseCommitment(publication, buyer)),
  );
  if (duplicate.outcome !== "nullifierAlreadySpent") {
    throw new Error(`a duplicate marketplace claim dry-ran as ${duplicate.outcome}, expected nullifierAlreadySpent`);
  }

  const spentVerification = await verifyUntil(runtime, publication, "spent");
  if (spentVerification.escrow !== "spent") throw new Error("paid marketplace escrow did not verify as spent");

  return {
    evidence: {
      offerId: funded.offer.terms.id.toString(),
      contractAddress: addressHex(funded.offer.l2ContractAddress),
      contractContentHash: funded.contractSubmission.contentHash,
      fundingContentHash: funded.fundingSubmission.contentHash,
      paymentTxHash: bought.paymentHash,
      paymentBlock: paymentBlock.toString(),
      claimContentHash: bought.claimContentHash,
      buyerOutputLeaf: buyerNote.leafIndex.toString(),
      buyerNoteAmount: buyerNote.amount.toString(),
      sellerPayoutWei: sellerPayoutWei.toString(),
      feePayoutWei: feePayoutWei.toString(),
    },
    duplicateClaimOutcome: duplicate.outcome,
  };
}

/**
 * A payment whose carried claim fails, finished by a freshly restored wallet.
 * The client refuses to pay with a claim its dry run rejects, so the scenario
 * pays itself, through the router's `buy`, with a claim whose proof it
 * corrupted. The restored wallet holds no purchase data: it finds the payment
 * on Ethereum and claims through `retry`.
 */
async function runRecoveredLifecycle(runtime: Runtime, funded: FundedOffer): Promise<NonNullable<MarketplaceScenarioEvidence["recoveredOffer"]>> {
  const publication = funded.catalogPublication;
  if (!funded.verification.safeToPay) {
    throw new Error("recovered marketplace offer lost its safe-to-pay verdict before payment");
  }
  const { context } = runtime;
  const { node, buyer } = context;
  const snapshot = await readClaimSnapshot(node, publication);
  const proved = await proveCarriedClaim({
    node,
    offer: publication,
    buyer,
    snapshot,
    buyerReceiveKey: async () => buyer.mlKemPublicKey!,
    prover: nativeMarketplaceProver(),
  });
  const corrupted = proofRejectedTransfer(hexToBytes(proved.transactionHex));
  const commitment = purchaseCommitment(publication, buyer);
  const dryRun = await node.checkRawTransaction(corrupted, paymentCarrier(publication, commitment));
  if (dryRun.outcome !== "proofRejected") {
    throw new Error(`the corrupted claim dry-ran as ${dryRun.outcome}, expected proofRejected`);
  }
  const call = buildBuyCall(publication, buyer, {
    anchor: snapshot.anchor,
    notAfter: claimNotAfter(snapshot.timestamp, BigInt(publication.terms.deadlineT)),
    batch: claimBatch(await node.status(), buyer, toHex(corrupted)),
  });
  const payment = await sendRouterCall(node, [context.l1RpcUrl], privateKeyL1Signer(context.buyerL1PrivateKey, context.l1RpcUrl, {
    maxFeePerGas: context.maxFeePerGas,
    maxPriorityFeePerGas: context.maxPriorityFeePerGas,
  }), call);
  const failed = await awaitReceipt(node, submissionIdentity(corrupted).contentHash, { pollIntervalMs: runtime.pollIntervalMs });
  if (failed?.outcome !== "proofRejected" || failed.inclusion.l1TransactionHash.toLowerCase() !== payment.hash.toLowerCase()) {
    throw new Error(`the corrupted claim's receipt reported ${failed?.outcome ?? "nothing"}, expected proofRejected in payment ${payment.hash}`);
  }
  await verifyUntil(runtime, publication, "escrowed");
  runtime.log(`recovered offer: payment ${payment.hash} carried a claim that failed with proofRejected`);

  const restoredProfile = await requestPcashProfile(context.buyerSigner, runtime.network);
  if (restoredProfile.address !== buyer.address || restoredProfile.nkRoot !== buyer.nkRoot) {
    throw new Error("fresh buyer profile recovery derived different wallet material");
  }
  const restored = await openBuyer(context, restoredProfile, runtime.router);
  try {
    const refreshed = await restored.controller.refresh();
    if ((refreshed.recoveryErrors ?? []).length > 0) {
      throw new Error(`the restored buyer wallet could not recover its purchases: ${refreshed.recoveryErrors!.join("; ")}`);
    }
    const found = refreshed.localOffers.find((offer) => offer.key === offerKey(publication))?.buys?.[restored.wallet.address];
    if (found?.txHash?.toLowerCase() !== payment.hash.toLowerCase()) {
      throw new Error("the restored buyer wallet did not find its payment on Ethereum");
    }
    const finished = await restored.controller.buy(found.publication);
    if (finished.paymentHash.toLowerCase() !== payment.hash.toLowerCase()) {
      throw new Error("the restored purchase finished under another payment");
    }
    const claim = await routerCarriedClaim(runtime, finished.claimContentHash, "retry");
    if (claim.outputLeafStart === null) throw new Error("the retried marketplace claim did not produce a note receipt");
    const buyerNote = await recoverExactNote(runtime, restoredProfile, claim.outputLeafStart, BigInt(publication.terms.amount), "restored buyer claim note");
    const spentVerification = await verifyUntil(runtime, publication, "spent");
    if (spentVerification.escrow !== "spent") throw new Error("recovered marketplace escrow did not verify as spent");
    runtime.log(`recovered offer: restored wallet claimed through retry ${claim.inclusion.l1TransactionHash}`);
    return {
      offerId: funded.offer.terms.id.toString(),
      contractAddress: addressHex(funded.offer.l2ContractAddress),
      paymentTxHash: payment.hash,
      failedClaimOutcome: "proofRejected",
      retryTxHash: claim.inclusion.l1TransactionHash as Hex,
      claimContentHash: finished.claimContentHash,
      buyerOutputLeaf: buyerNote.leafIndex.toString(),
    };
  } finally {
    await restored.close();
  }
}

async function buildReclaim(runtime: Runtime, funded: FundedOffer, notBeforeTimestamp: bigint) {
  const snapshot = await readConsistentContractState(runtime, funded.offer, funded.escrow);
  return buildContractFunctionCall({
    chainId: runtime.network.pcashChainId,
    contract: decodeContractBody(funded.offer.l2ContractBody),
    selector: RECLAIM_FUNCTION_SELECTOR,
    recipientAddress: runtime.context.seller.address,
    paymentAmount: reclaimPayout(runtime, funded),
    inputs: [{
      amount: funded.escrow.amount,
      noteSecret: funded.escrow.noteSecret,
      outputIndex: funded.escrow.leafIndex,
      siblings: snapshot.outputPath.siblings,
    }],
    ...snapshotFromAccountProof(snapshot.accountPath),
    openFeeAmount: runtime.context.openFeeAmount,
    issuanceOwnerCommitment: 0n,
    dummyInputEntropy: runtime.context.randomField?.() ?? randomFieldEntropy(),
    notBeforeTimestamp,
    validUntilTimestamp: MAX_PAYMENT_DEADLINE_T,
    accountIndex: Number(snapshot.accountPath.account.index),
    accountSiblings: snapshot.accountPath.accountSiblings,
    recipientReceiveKey: runtime.context.seller.mlKemPublicKey!,
  });
}

/** A reclaim pays its open fee from the escrow and returns the rest to the seller. */
function reclaimPayout(runtime: Runtime, funded: FundedOffer): bigint {
  return funded.offer.terms.amount - runtime.context.openFeeAmount;
}

async function authorizeReclaim(
  runtime: Runtime,
  params: Omit<ReclaimWitnessParams, "authorization">,
): Promise<ReclaimWitnessParams> {
  const authorization = await requestPcashAuthorization(
    runtime.context.sellerSigner,
    reclaimAuthorizationRequest(params),
  );
  return { ...params, authorization };
}

async function runUnpaidReclaimLifecycle(runtime: Runtime, funded: FundedOffer): Promise<{
  evidence: MarketplaceScenarioEvidence["unpaidOffer"];
}> {
  const advanceToTimestamp = runtime.context.advanceToTimestamp;
  if (advanceToTimestamp === undefined) throw new Error("a timed reclaim needs a backend that can advance L1 time");
  const payoutAmount = reclaimPayout(runtime, funded);
  const deadlineT = funded.offer.terms.deadlineT;
  // A reclaim valid at T itself could execute alongside a timely claim.
  const earlyBuild = await buildReclaim(runtime, funded, deadlineT);
  const earlyParams = await authorizeReclaim(runtime, {
    configurationSalt: funded.offer.reclaimConfigurationSalt,
    ...reclaimActionForSeller(earlyBuild, funded, runtime.context.seller, payoutAmount),
    network: runtime.network,
    deadlineT,
    sellerProfile: runtime.context.seller,
  });
  let earlyRejected = false;
  try {
    const witness = buildReclaimWitnessMap(earlyParams);
    await proveTransaction(earlyBuild, "contracts/escrow/reclaim", witness);
  } catch {
    earlyRejected = true;
  }
  if (!earlyRejected) throw new Error("marketplace reclaim proof accepted notBeforeTimestamp = T");
  const notBefore = reclaimNotBefore(deadlineT);
  runtime.log(`unpaid offer reclaim at T rejected; advancing to L1 timestamp ${notBefore}`);

  const observedReclaimTimestamp = await advanceToTimestamp(notBefore);
  const build = await buildReclaim(runtime, funded, notBefore);
  const reclaimParams = await authorizeReclaim(runtime, {
    configurationSalt: funded.offer.reclaimConfigurationSalt,
    ...reclaimActionForSeller(build, funded, runtime.context.seller, payoutAmount),
    network: runtime.network,
    deadlineT,
    sellerProfile: runtime.context.seller,
  });
  const proof = await proveTransaction(build, "contracts/escrow/reclaim", buildReclaimWitnessMap(reclaimParams));
  const submission = await runtime.context.submitAndWait(build.encodeTransaction(proof), "marketplace:reclaim");
  if (submission.kind !== "privateValue" || submission.outputLeafStart === null) {
    throw new Error("marketplace reclaim did not produce a privateValue note receipt");
  }
  const sellerNote = await recoverExactNote(
    runtime,
    runtime.context.seller,
    submission.outputLeafStart,
    payoutAmount,
    "seller reclaimed marketplace note",
  );
  const spentVerification = await verifyUntil(runtime, funded.catalogPublication, "spent");
  if (spentVerification.escrow !== "spent") throw new Error("reclaimed marketplace escrow did not verify as spent");

  return {
    evidence: {
      offerId: funded.offer.terms.id.toString(),
      contractAddress: addressHex(funded.offer.l2ContractAddress),
      contractContentHash: funded.contractSubmission.contentHash,
      fundingContentHash: funded.fundingSubmission.contentHash,
      deadlineT: funded.offer.terms.deadlineT.toString(),
      observedReclaimTimestamp: observedReclaimTimestamp.toString(),
      reclaimContentHash: submission.contentHash,
      sellerOutputLeaf: sellerNote.leafIndex.toString(),
      sellerNoteAmount: sellerNote.amount.toString(),
    },
  };
}

function reclaimActionForSeller(build: ReturnType<typeof buildContractFunctionCall>, funded: FundedOffer, seller: WalletProfile, payoutAmount: bigint) {
  return {
    recentPcashBlockHash: build.recentPcashBlockHash,
    feePaid: false,
    transaction: build.transaction,
    outputData: build.outputData,
    arena: build.arena,
    escrowContract: funded.offer.l2ContractAddress,
    offerId: funded.offer.terms.id,
    recipient: seller.address,
    escrowNote: {
      noteSecret: funded.escrow.noteSecret,
      assetId: 0n,
      amount: funded.escrow.amount,
      outputIndex: BigInt(funded.escrow.leafIndex),
    },
    payoutNoteSecret: build.outputNoteSecrets[0]!,
    payoutAmount,
    relayFeeAmount: 0n,
    relayFeeOwnerCommitment: 0n,
    payoutOpeningBlinder: randomFieldEntropy(),
  };
}

export interface MarketplaceSession {
  runtime: Runtime;
  router: MarketplaceScenarioEvidence["router"];
  close(): Promise<void>;
}

/** Resolve the router and open the seller's inventory and the buyer's client once, for any number of trades. */
export async function openMarketplaceSession(context: MarketplaceScenarioContext): Promise<MarketplaceSession> {
  mkdirSync(context.workDir, { recursive: true });
  const network = resolveNetworkConfig(context.network);
  if (context.openFeeAmount < 0n) throw new Error("marketplace relayer fee must be nonnegative");
  if (!context.seller.mlKemPublicKey || !context.buyer.mlKemPublicKey) {
    throw new Error("marketplace seller and buyer wallets require receive keys");
  }
  if (context.sellerSigner.address !== context.seller.address || context.buyerSigner.address !== context.buyer.address) {
    throw new Error("marketplace action signer does not match its recoverable profile");
  }
  const l1 = createPublicClient({ chain: pcashL1Chain(network.l1ChainId, context.l1RpcUrl), transport: http(context.l1RpcUrl) });
  const rpcChainId = await l1.getChainId();
  if (BigInt(rpcChainId) !== network.l1ChainId) {
    throw new Error(`selected L1 RPC is chain ${rpcChainId}, expected ${network.l1ChainId}`);
  }
  const sellerAccount = privateKeyToAccount(context.sellerL1PrivateKey);
  if (BigInt(sellerAccount.address) !== context.seller.address) {
    throw new Error("seller L1 fixture key does not match the seller profile");
  }
  const ownsSellerWallet = context.sellerWallet === undefined;
  const sellerWallet = context.sellerWallet ?? await openNodeWallet({
    dataDir: context.sellerWalletDatabasePath,
    node: context.node,
    profile: context.seller,
    signer: context.sellerSigner,
    provers: createWalletProvers("native"),
    ...marketplaceSellerWalletSettleOptions(context),
  });
  let buyer: MarketplaceBuyer | undefined;
  try {
    const router = await deployOrUseRouter(context, network);
    const log = context.log ?? (() => {});
    log(`PaymentRouter ready at ${router.address}`);
    buyer = await openBuyer(context, context.buyer, router.address);
    const runtime: Runtime = {
      context,
      network,
      l1,
      router: router.address,
      sellerAccount,
      sellerWallet,
      buyer,
      pollIntervalMs: context.pollIntervalMs ?? 6_000,
      log,
    };
    const opened = buyer;
    return {
      runtime,
      router,
      close: async () => {
        await opened.close();
        if (ownsSellerWallet) await sellerWallet.close();
      },
    };
  } catch (error) {
    await buyer?.close();
    if (ownsSellerWallet) await sellerWallet.close();
    throw error;
  }
}

/** One paid trade: publish and fund an escrow, list it, and let the buyer buy it with its carried claim. */
export async function runPaidMarketplaceTrade(
  session: MarketplaceSession,
  amount: bigint,
): Promise<MarketplaceScenarioEvidence["paidOffer"]> {
  const { runtime, router } = session;
  const { context } = runtime;
  const entropy = context.randomField ?? randomFieldEntropy;
  const latestTimestamp = (await runtime.l1.getBlock({ blockTag: "latest" })).timestamp;
  const offer = createOffer({
    network: runtime.network,
    terms: {
      router: BigInt(router.address),
      seller: BigInt(runtime.sellerAccount.address),
      assetId: 0n,
      amount,
      ethPriceWei: context.ethPriceWei ?? DEFAULT_MARKETPLACE_ETH_PRICE_WEI,
      deadlineT: latestTimestamp + (context.claimDeadlineLeadSeconds ?? DEFAULT_CLAIM_DEADLINE_LEAD_SECONDS),
    },
    sellerWallet: context.seller,
    l2ContractNkRoot: entropy(),
    claimApplicationVkHash: CLAIM_APPLICATION_VK_HASH,
    reclaimApplicationVkHash: RECLAIM_APPLICATION_VK_HASH,
  });
  const funded = await fundOffer(runtime, offer, undefined, amount, "trade", "payable");
  return (await runPaidLifecycle(runtime, funded)).evidence;
}

/**
 * Run the marketplace acceptance flow. Receipt waits use ordinary latest-chain
 * inclusion; a local backend may provide controlled timestamp advancement.
 */
export async function runMarketplaceScenarioFlow(context: MarketplaceScenarioContext): Promise<MarketplaceScenarioEvidence | MarketplaceEscrowSeedEvidence | {
  sourceVerificationOnly: true;
  routerAddress: string;
  contractAddresses: string[];
}> {
  const session = await openMarketplaceSession(context);
  const { runtime, router } = session;
  const { network, l1 } = runtime;
  try {
    const latestTimestamp = (await l1.getBlock({ blockTag: "latest" })).timestamp;
    const claimLead = context.claimDeadlineLeadSeconds ?? DEFAULT_CLAIM_DEADLINE_LEAD_SECONDS;
    const reclaimLead = context.reclaimDeadlineLeadSeconds ?? DEFAULT_RECLAIM_DEADLINE_LEAD_SECONDS;
    if (claimLead <= MIN_CLAIM_WINDOW_SECONDS + PURCHASE_MARGIN_SECONDS) {
      throw new Error(`a paid offer's deadline lead must exceed ${MIN_CLAIM_WINDOW_SECONDS + PURCHASE_MARGIN_SECONDS} seconds to stay open for purchases`);
    }
    if (reclaimLead < MIN_CLAIM_WINDOW_SECONDS) {
      throw new Error(`unpaid-offer deadline lead must be at least ${MIN_CLAIM_WINDOW_SECONDS} seconds`);
    }

    let amount: bigint;
    if (context.sourceVerificationOnly === true || context.deferFundingInventory === true) {
      amount = context.pcashAmount ?? 1_000n;
    } else {
      const minimumRequired = context.pcashAmount === undefined
        ? 8n * (context.openFeeAmount + 1n)
        : 3n * (context.pcashAmount + context.openFeeAmount);
      await synchronizeSellerInventory(runtime);
      const source = await findSpendableNote(runtime, context.seller, minimumRequired);
      amount = context.pcashAmount ?? source.amount / 8n;
    }
    if (amount <= context.openFeeAmount) {
      throw new Error(`marketplace amount ${amount} must exceed relayer fee ${context.openFeeAmount}`);
    }

    const entropy = context.randomField ?? randomFieldEntropy;
    const paidTerms: OfferTerms = {
      router: BigInt(router.address),
      seller: BigInt(runtime.sellerAccount.address),
      id: entropy(),
      assetId: 0n,
      amount,
      ethPriceWei: context.ethPriceWei ?? DEFAULT_MARKETPLACE_ETH_PRICE_WEI,
      deadlineT: latestTimestamp + claimLead,
    };
    const unpaidTerms: OfferTerms = {
      ...paidTerms,
      id: entropy(),
      deadlineT: latestTimestamp + reclaimLead,
    };
    if (paidTerms.id === unpaidTerms.id) {
      unpaidTerms.id = unpaidTerms.id === BN254_SCALAR_MODULUS - 1n ? 1n : unpaidTerms.id + 1n;
    }
    let paidOffer: Offer;
    let unpaidOffer: Offer;
    if (context.deferFundingInventory === true) {
      const prepared = prepareMarketplaceSeedOffers({
        network,
        seller: { wallet: context.seller, paymentAddress: BigInt(runtime.sellerAccount.address) },
        router: BigInt(router.address),
        latestL1Timestamp: latestTimestamp,
        paid: {
          entropy: {
            l2ContractNkRoot: entropy(),
          },
          amounts: { pcashAmount: amount, ethPriceWei: paidTerms.ethPriceWei },
          deadlineLeadSeconds: claimLead,
        },
        unpaid: {
          entropy: {
            l2ContractNkRoot: entropy(),
          },
          amounts: { pcashAmount: amount, ethPriceWei: unpaidTerms.ethPriceWei },
          deadlineLeadSeconds: reclaimLead,
        },
      });
      paidOffer = prepared.paid.offer;
      unpaidOffer = prepared.unpaid.offer;
    } else {
      paidOffer = createOffer({
        network,
        terms: paidTerms,
        sellerWallet: context.seller,
        l2ContractNkRoot: entropy(),
        claimApplicationVkHash: CLAIM_APPLICATION_VK_HASH,
        reclaimApplicationVkHash: RECLAIM_APPLICATION_VK_HASH,
      });
      unpaidOffer = createOffer({
        network,
        terms: unpaidTerms,
        sellerWallet: context.seller,
        l2ContractNkRoot: entropy(),
        claimApplicationVkHash: CLAIM_APPLICATION_VK_HASH,
        reclaimApplicationVkHash: RECLAIM_APPLICATION_VK_HASH,
      });
    }
    const recoveredOffer = context.recoverFailedClaim === true
      ? createOffer({
          network,
          terms: paidTerms,
          sellerWallet: context.seller,
          l2ContractNkRoot: entropy(),
          claimApplicationVkHash: CLAIM_APPLICATION_VK_HASH,
          reclaimApplicationVkHash: RECLAIM_APPLICATION_VK_HASH,
        })
      : undefined;

    // Seed waves and source-only runs publish bodies before funding is released.
    const publishBeforeFunding = context.sourceVerificationOnly === true || context.deferFundingInventory === true;
    const paidContractSubmission = publishBeforeFunding ? await publishContract(runtime, paidOffer, "paid-offer") : undefined;
    if (publishBeforeFunding) await synchronizeSellerInventory(runtime);
    const unpaidContractSubmission = publishBeforeFunding ? await publishContract(runtime, unpaidOffer, "unpaid-offer") : undefined;
    if (publishBeforeFunding) await synchronizeSellerInventory(runtime);
    const recoveredContractSubmission = publishBeforeFunding && recoveredOffer !== undefined
      ? await publishContract(runtime, recoveredOffer, "recovered-offer") : undefined;
    if (publishBeforeFunding && recoveredOffer !== undefined) await synchronizeSellerInventory(runtime);
    if (context.publishSourceVerification !== undefined) {
      await context.publishSourceVerification(paidOffer);
      await context.publishSourceVerification(unpaidOffer);
    }
    if (context.sourceVerificationOnly === true) {
      return {
        sourceVerificationOnly: true,
        routerAddress: router.address,
        contractAddresses: [paidOffer, unpaidOffer].map((offer) => addressHex(offer.l2ContractAddress)),
      };
    }
    await context.beforePaidFunding?.();
    const fundedPaid = await fundOffer(runtime, paidOffer, paidContractSubmission, amount, "paid-offer", "payable");

    // The later escrows use the seller change from each earlier funding transfer.
    // Their proving and submission overlap the independent paid purchase.
    await synchronizeSellerInventory(runtime);
    const fundedUnpaidPromise = fundOffer(runtime, unpaidOffer, unpaidContractSubmission, amount, "unpaid-offer", "escrowed");
    const fundedRecoveredPromise = recoveredOffer === undefined
      ? Promise.resolve(undefined)
      : fundedUnpaidPromise.then(async () => {
          await synchronizeSellerInventory(runtime);
          return fundOffer(runtime, recoveredOffer, recoveredContractSubmission, amount, "recovered-offer", "payable");
        });
    const paidLifecyclePromise = runPaidLifecycle(runtime, fundedPaid);
    const [fundedUnpaid, fundedRecovered, paidLifecycle] = await Promise.all([
      fundedUnpaidPromise,
      fundedRecoveredPromise,
      paidLifecyclePromise,
    ]);
    // The buyer's Ethereum key sends one router call at a time.
    const recoveredLifecycle = fundedRecovered === undefined ? undefined : await runRecoveredLifecycle(runtime, fundedRecovered);
    if (context.leaveUnpaidEscrowed === true) {
      return {
        router,
        catalog: {
          paidOfferKey: offerKey(fundedPaid.catalogPublication),
          unpaidOfferKey: offerKey(fundedUnpaid.catalogPublication),
          paidOfferChecks: fundedPaid.verification.checks,
          unpaidOfferChecks: fundedUnpaid.verification.checks,
        },
        paidOffer: paidLifecycle.evidence,
        unpaidOffer: {
          offerId: fundedUnpaid.offer.terms.id.toString(),
          contractAddress: addressHex(fundedUnpaid.offer.l2ContractAddress),
          contractContentHash: fundedUnpaid.contractSubmission.contentHash,
          fundingContentHash: fundedUnpaid.fundingSubmission.contentHash,
          deadlineT: fundedUnpaid.offer.terms.deadlineT.toString(),
          escrowLeaf: fundedUnpaid.escrow.leafIndex.toString(),
          escrowAmount: fundedUnpaid.escrow.amount.toString(),
        },
      };
    }
    const unpaidLifecycle = await runUnpaidReclaimLifecycle(runtime, fundedUnpaid);

    const evidence: MarketplaceScenarioEvidence = {
      router,
      catalog: {
        paidOfferKey: offerKey(fundedPaid.catalogPublication),
        unpaidOfferKey: offerKey(fundedUnpaid.catalogPublication),
        paidOfferChecks: fundedPaid.verification.checks,
        unpaidOfferChecks: fundedUnpaid.verification.checks,
      },
      paidOffer: paidLifecycle.evidence,
      ...(recoveredLifecycle === undefined ? {} : { recoveredOffer: recoveredLifecycle }),
      unpaidOffer: unpaidLifecycle.evidence,
      controls: {
        duplicateClaimOutcome: paidLifecycle.duplicateClaimOutcome,
        earlyReclaimRejected: true,
        paidEscrowSpent: true,
        reclaimedEscrowSpent: true,
      },
    };
    return evidence;
  } finally {
    await session.close();
  }
}

/**
 * Publication, catalog, a one-transaction buy and payout, a failed carried
 * claim finished by a restored wallet through retry, and a timed reclaim.
 */
export async function runMarketplaceScenario(
  fixture: ScenarioFixture,
  options: {
    publishSourceVerification?: (offer: Offer) => Promise<void>;
    sourceVerificationOnly?: boolean;
  } = {},
): Promise<void> {
  // Source-only fixtures publish bodies; ordinary offers create and fund atomically.
  await setupUserWallets(fixture, options.sourceVerificationOnly === true
    ? { actors: ["S", "M"], accounts: ["S"], funded: [] }
    : { actors: ["S", "M"], accounts: [], funded: ["S"] });
  const S = fixture.actors.S!;
  const M = fixture.actors.M!;
  if (options.sourceVerificationOnly !== true) {
    // Two buys and a retry, each carrying a claim, and two listing prices.
    await fixture.fundL1Gas(M.address, 4, 2n * fixture.config.marketplace.ethPriceWei);
  }
  const result = await runMarketplaceScenarioFlow({
    ...await fixtureMarketplaceContext(fixture, {
      seller: S,
      buyer: M,
      label: "marketplace",
      // A nonzero relayer fee pays whoever publishes the escrow contract's
      // creation from the seller's notes. A source-verification run funds no
      // notes, so its zero-fee creations pay no publisher and the seller
      // publishes them itself.
      openFeeAmount: options.sourceVerificationOnly === true ? 0n : fixture.config.assets.actionFee,
    }),
    ...(options.publishSourceVerification === undefined
      ? {}
      : { publishSourceVerification: options.publishSourceVerification }),
    ...(options.sourceVerificationOnly === true ? {} : { recoverFailedClaim: true }),
    ...(options.sourceVerificationOnly === true ? { sourceVerificationOnly: true } : {}),
    // A live L1 cannot be advanced past T, at least the router's claim window
    // away, so a live run leaves the unpaid offer escrowed.
    ...(fixture.backend.setNextTimestamp === undefined ? { leaveUnpaidEscrowed: true } : {}),
  });
  fixture.artifacts.record("marketplace-complete", { result });
}

/** The marketplace flow's view of a fixture: its node, L1, harness, and one seller and buyer. */
export async function fixtureMarketplaceContext(
  fixture: ScenarioFixture,
  params: {
    seller: ScenarioActor;
    buyer: ScenarioActor;
    label: string;
    openFeeAmount: bigint;
  },
): Promise<MarketplaceScenarioContext> {
  const { seller, buyer, label } = params;
  const workDir = fixture.artifacts.path(label);
  await mkdir(workDir, { recursive: true, mode: 0o700 });
  const backend = fixture.backend;
  const mine = backend.mine?.bind(backend);
  const setNextTimestamp = backend.setNextTimestamp?.bind(backend);
  const latestTimestamp = async () =>
    (await createPublicClient({ transport: http(backend.rpcUrl) }).getBlock({ blockTag: "latest" })).timestamp;
  return {
    repoRoot: fixture.repoRoot,
    workDir,
    l1RpcUrl: backend.rpcUrl,
    node: fixture.nodeA.client,
    network: fixture.network,
    seller: seller.wallet,
    sellerSigner: seller.signer,
    buyer: buyer.wallet,
    buyerSigner: buyer.signer,
    sellerWalletDatabasePath: seller.walletDatabasePath,
    sellerWallet: await seller.client(),
    sellerL1PrivateKey: seller.privateKey,
    buyerL1PrivateKey: buyer.privateKey,
    routerDeployerPrivateKey: fixture.harness.privateKey,
    ...await l1FeeCaps(backend.rpcUrl, fixture.config.maxFeePerGas),
    openFeeAmount: params.openFeeAmount,
    routerConfig: marketplaceRouterConfig(fixture.config),
    ...(fixture.config.marketplace.routerAddress === undefined
      ? {}
      : { routerAddress: fixture.config.marketplace.routerAddress }),
    ethPriceWei: fixture.config.marketplace.ethPriceWei,
    randomField: () => fixture.randomField(),
    submitAndWait: async (entry, submissionLabel) => marketplaceSubmission(
      await fixture.submitAndWait(entry, submissionLabel),
    ),
    selfPublish: async (entry, submissionLabel) => marketplaceSubmission(
      await fixture.publishOnL1(entry, submissionLabel, seller.wallet),
    ),
    checkpoint: async (checkpointLabel, value) => {
      await writeFile(
        join(workDir, "checkpoint.json"),
        `${JSON.stringify({ label: checkpointLabel, ...value }, null, 2)}\n`,
        { mode: 0o600 },
      );
    },
    log: (message) => fixture.artifacts.record(`${label}-progress`, { message }),
    pollIntervalMs: backend.anvil ? 500 : 2_000,
    // A local L1 jumps to the reclaim time in one block.
    ...(mine === undefined || setNextTimestamp === undefined
      ? {}
      : {
          advanceToTimestamp: async (target: bigint) => {
            if (target > await latestTimestamp()) {
              await setNextTimestamp(target);
              await mine();
            }
            await fixture.waitForNodesAtL1Head();
            const timestamp = await latestTimestamp();
            if (timestamp < target) throw new Error(`Anvil timestamp ${timestamp} did not reach ${target}`);
            return timestamp;
          },
        }),
  };
}

function marketplaceSubmission(accepted: AcceptedScenarioSubmission): MarketplaceSubmission {
  const inclusion = accepted.nodeA.inclusion;
  return {
    contentHash: accepted.contentHash,
    kind: accepted.nodeA.kind,
    inclusionBlock: BigInt(String(inclusion.l1BlockNumber)),
    inclusionBlockHash: String(inclusion.l1BlockHash),
    outputLeafStart: accepted.nodeA.outputLeafStart === undefined || accepted.nodeA.outputLeafStart === null
      ? null
      : BigInt(accepted.nodeA.outputLeafStart),
  };
}
