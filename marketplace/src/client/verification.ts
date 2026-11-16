// Live verification of a portable marketplace publication against PCASH and L1.

import { escrowCommitments } from "./offerAvailability.ts";
import {
  TX_KIND_PRIVATE_VALUE,
  buildContractFunctionSet,
  l1RpcTransport,
  networkConfigFromStatus,
  resolveNetworkConfig,
  type ContractFunction,
  type NetworkConfigLike,
  type PcashNodeClient,
} from "@pcash/sdk/browser";
import { createPublicClient, type Address, type Hex } from "viem";
import { assertPaymentNodeFreshness, MAX_PAYMENT_NODE_LAG_BLOCKS } from "./paymentFreshness.ts";
import {
  CLAIM_FUNCTION_SELECTOR,
  CLAIM_APPLICATION_VK_HASH,
  RECLAIM_APPLICATION_VK_HASH,
  RECLAIM_FUNCTION_SELECTOR,
  claimConfigurationCommitment,
  reclaimConfigurationCommitment,
  type OfferTerms,
} from "../commitments.mts";
import { addressHex } from "@pcash/sdk/browser";
import {
  PAYMENT_ROUTER_ABI,
  quotePaymentRouterFee,
  routerPaymentKey,
  verifyPaymentRouterDeployment,
  type PaymentRouterFeeQuote,
  type VerifiedPaymentRouterDeployment,
} from "./paymentRouter.ts";
import {
  publicationAssetDefinition,
  publicationTerms,
  type OfferPublication,
} from "./publication.ts";
import {
  deriveVerifiedL2ContractMaterial,
  type VerifiedL2ContractMaterial,
} from "./verifiedContractMaterial.ts";
import { claimSnapshotFrom, type ClaimSnapshot } from "./claimFlow.ts";

export type EscrowStatus = "unfunded" | "escrowed" | "spent" | "amount-mismatch" | "opening-invalid" | "unknown";

export interface PaymentAnchor {
  blockNumber: bigint;
  blockHash: Hex;
}

export interface VerifyOfferOptions {
  /** The only deployed PaymentRouter buyers are allowed to fund. */
  expectedRouter: string;
  /** Runtime network whose reclaim signature domain the offer must commit. */
  expectedNetwork?: NetworkConfigLike;
}

export interface VerifyPayableOfferOptions extends VerifyOfferOptions {
  /** Selected L1 endpoint; its router deployment must match the pinned runtime bytecode. */
  l1Urls: readonly string[];
  /**
   * The expected router's deployment, already verified on that endpoint. One check
   * serves every offer paid through the same router; without it, this call checks.
   */
  routerDeployment?: VerifiedPaymentRouterDeployment;
}

export interface OfferVerification {
  /** Client-side verification of the Smart Contract body, both marketplace functions, and a token listing's asset definition. */
  l2ContractVerification: "verified" | "unverified";
  /** claim() and reclaim() configurations bind the advertised offer and reclaim timing. */
  functionsBound: boolean;
  chainMatches: boolean;
  routerPinned: boolean;
  /** Router bytecode and its reported fee terms were verified on the selected L1. */
  routerConfigVerified: boolean | null;
  /** Gross buyer payment and its exact on-router website-fee split. */
  feeQuote: PaymentRouterFeeQuote | null;
  /** The router already records the listing's one payment at the selected L1 head (null when not read). */
  routerPaid: boolean | null;
  /** node.getContract agrees the L2 smart contract is on the ledger (null when node unreachable). */
  liveOnNode: boolean | null;
  escrow: EscrowStatus;
  /**
   * The verified snapshot: the claim is proved against it, and the router call
   * names its Ethereum anchor, which the router must still recognize.
   */
  claimSnapshot: ClaimSnapshot | null;
  /** Every check needed before sending an irreversible L1 payment passed now. */
  safeToPay: boolean;
  /** Human-readable per-check trace, newest checks last. */
  checks: string[];
  error?: string;
}

/**
 * Verify an offer publication. The client-side portion binds the offer to the expected network.
 * The node portion (L2 smart contract liveness + escrow-note
 * membership) degrades to `liveOnNode: null` / `escrow: "unknown"` when the node
 * is unreachable rather than failing the whole check.
 */
interface ClientVerification {
  l2ContractVerification: OfferVerification["l2ContractVerification"];
  functionsBound: boolean;
  chainMatches: boolean;
  routerPinned: boolean;
  checks: string[];
}

function materializedContractFunctionSet(functions: readonly {
  selector: number;
  applicationVkHash: string;
  configurationCommitment: string;
}[]): bigint {
  return buildContractFunctionSet(functions.map((entry) => ({
    selector: entry.selector as ContractFunction["selector"],
    applicationVkHash: BigInt(entry.applicationVkHash),
    configurationCommitment: BigInt(entry.configurationCommitment),
  }))).functionSetCommitment;
}

const clientVerificationCache = new WeakMap<OfferPublication, Map<string, ClientVerification>>();

/** Verification inputs after the network configuration has been resolved. */
interface ResolvedVerifyOptions extends VerifyOfferOptions {
  expectedNetwork: NetworkConfigLike;
}

function clientVerification(pub: OfferPublication, options: ResolvedVerifyOptions, derived?: VerifiedL2ContractMaterial): ClientVerification {
  const expectedNetwork = resolveNetworkConfig(options.expectedNetwork);
  const cacheKey = `${expectedNetwork.pcashChainId}:${expectedNetwork.l1ChainId}:${expectedNetwork.inboxAddress}:${options.expectedRouter.trim().toLowerCase()}`;
  const hit = clientVerificationCache.get(pub)?.get(cacheKey);
  if (hit) return hit;

  const checks: string[] = [];
  let chainId = 0n;
  let terms: OfferTerms | null = null;
  let chainMatches = false;
  let routerPinned = false;
  try {
    chainId = BigInt(pub.chainId);
    terms = publicationTerms(pub);
    chainMatches = chainId === expectedNetwork.pcashChainId;
    checks.push(chainMatches ? "publication targets this pcash chain" : "publication targets a different pcash chain");
    if (options.expectedRouter.trim() !== "") {
      routerPinned = terms.router === BigInt(options.expectedRouter);
    }
    checks.push(routerPinned ? "payment router matches the configured deployment" : "payment router is NOT the configured deployment");
  } catch (err) {
    checks.push(`publication terms are malformed: ${err instanceof Error ? err.message : String(err)}`);
  }

  let l2ContractVerification: OfferVerification["l2ContractVerification"] = "unverified";
  let functionsBound = false;
  try {
    if (terms === null) throw new Error("publication terms are malformed");
    const material = derived ?? deriveVerifiedL2ContractMaterial(pub);
    const body = material.body;
    const claimFunction = body.functions.find((entry) => entry.selector === CLAIM_FUNCTION_SELECTOR);
    const reclaimFunction = body.functions.find((entry) => entry.selector === RECLAIM_FUNCTION_SELECTOR);
    const exactlyTwo = body.functions.length === 2 && claimFunction !== undefined && reclaimFunction !== undefined;
    checks.push(exactlyTwo ? "Smart Contract exposes exactly claim() and reclaim()" : "Smart Contract has unexpected or missing functions");
    const claimApplicationVkOk = claimFunction?.applicationVkHash === CLAIM_APPLICATION_VK_HASH;
    const claimConfigurationOk = claimFunction?.configurationCommitment === claimConfigurationCommitment(
      BigInt(pub.l2Contract.claimConfigurationSalt), terms,
    );
    checks.push(claimApplicationVkOk ? "claim() uses the approved application" : "claim() does NOT use the approved application");
    checks.push(claimConfigurationOk ? "claim() configuration binds the advertised terms" : "claim() configuration does NOT match the advertised terms");
    // Each function authenticates only its own configuration, so this check is
    // what binds reclaim() to the same T as claim().
    const reclaimApplicationVkOk = reclaimFunction?.applicationVkHash === RECLAIM_APPLICATION_VK_HASH;
    const reclaimConfigurationOk = reclaimFunction?.configurationCommitment === reclaimConfigurationCommitment(
      BigInt(pub.l2Contract.reclaimConfigurationSalt), expectedNetwork, BigInt(pub.reclaimAuthority), terms.id, terms.deadlineT,
    );
    checks.push(reclaimApplicationVkOk ? "reclaim() uses the approved application" : "reclaim() does NOT use the approved application");
    checks.push(reclaimConfigurationOk ? `reclaim() opens only after T (${terms.deadlineT}) and binds this network` : "reclaim() configuration does NOT bind the advertised T and this network");
    let assetOk = false;
    try {
      const definition = publicationAssetDefinition(pub);
      assetOk = true;
      checks.push(definition === null
        ? "listing escrows native PCASH"
        : `token definition (${definition.metadata.symbol}, ${definition.metadata.decimals} decimals) derives the listed asset ID`);
    } catch (error) {
      checks.push(`listed asset is NOT verified: ${error instanceof Error ? error.message : String(error)}`);
    }

    functionsBound = Boolean(claimConfigurationOk && reclaimConfigurationOk);
    if (chainMatches && routerPinned && exactlyTwo && claimApplicationVkOk && claimConfigurationOk
      && reclaimApplicationVkOk && reclaimConfigurationOk && assetOk) {
      l2ContractVerification = "verified";
    }
  } catch (err) {
    checks.push(`L2 smart contract body failed verification: ${err instanceof Error ? err.message : String(err)}`);
  }

  const result = { l2ContractVerification, functionsBound, chainMatches, routerPinned, checks };
  const byOptions = clientVerificationCache.get(pub) ?? new Map<string, ClientVerification>();
  byOptions.set(cacheKey, result);
  clientVerificationCache.set(pub, byOptions);
  return result;
}

async function verifyOfferSnapshot(
  node: PcashNodeClient,
  pub: OfferPublication,
  options: VerifyOfferOptions,
): Promise<OfferVerification & { settlementAccepted: boolean }> {
  let snapshot: Awaited<ReturnType<PcashNodeClient["getWitnessSnapshot"]>> | null = null;
  let statusError: string | null = null;
  const opening = pub.escrow;
  let material: VerifiedL2ContractMaterial | undefined;
  try { material = deriveVerifiedL2ContractMaterial(pub); } catch { /* Client verification reports malformed body. */ }
  const commitments = opening === undefined || material === undefined ? undefined : escrowCommitments(pub, opening, material);
  try {
    snapshot = await node.getWitnessSnapshot({
      contracts: material === undefined ? [] : [addressHex(material.address)],
      ...(opening !== undefined && commitments !== undefined ? {
        outputs: [{ outputIndex: opening.leafIndex, outputCommitment: commitments.leaf }],
        nullifiers: [commitments.nullifier],
      } : {}),
    });
  } catch (err) {
    statusError = err instanceof Error ? err.message : String(err);
  }
  const status = snapshot?.status ?? null;
  if (status === null && options.expectedNetwork === undefined) {
    throw new Error(`offer verification requires the connected node's status: ${statusError}`);
  }
  const resolvedOptions: ResolvedVerifyOptions = {
    ...options,
    expectedNetwork: options.expectedNetwork ?? networkConfigFromStatus(status!),
  };
  const client = clientVerification(pub, resolvedOptions, material);
  const checks = [...client.checks];
  if (statusError !== null) {
    checks.push(`settlement capability unknown: ${statusError}`);
  }
  let terms: OfferTerms;
  try {
    BigInt(pub.chainId);
    terms = publicationTerms(pub);
  } catch {
    return {
      ...client,
      routerConfigVerified: null,
      feeQuote: null,
      routerPaid: null,
      liveOnNode: null,
      escrow: pub.escrow ? "unknown" : "unfunded",
      claimSnapshot: null,
      safeToPay: false,
      settlementAccepted: false,
      checks,
    };
  }
  let liveOnNode: boolean | null = null;
  let escrow: EscrowStatus = pub.escrow ? "unknown" : "unfunded";
  let claimSnapshot: ClaimSnapshot | null = null;
  // A fork may retire the settlement transaction type for new blocks, so the
  // verdict checks it before any payment.
  let settlementAccepted: boolean | null = null;
  if (status !== null) {
    settlementAccepted = status.acceptedTransactionTypes.includes(TX_KIND_PRIVATE_VALUE);
    if (!settlementAccepted) {
      checks.push(
        "node no longer admits the settlement transaction type; this listing cannot be claimed",
      );
    }
  }
  try {
    if (snapshot === null) throw new Error(statusError ?? "node unavailable");
    const onChain = snapshot.contracts[0]!;
    if (onChain.status !== "contract") {
      liveOnNode = false;
      checks.push("node has no L2 smart contract at this address yet (not included, or reorged out)");
    } else {
      const onChainContract = onChain;
      const functionSet = materializedContractFunctionSet(onChainContract.functions);
      liveOnNode = material !== undefined && functionSet === material.functionSetCommitment;
      checks.push(liveOnNode ? "node confirms the L2 smart contract is on the ledger" : "node L2 smart contract function-set commitment disagrees");
    }

    if (pub.escrow) {
      const opening = pub.escrow;
      const openingAmount = BigInt(opening.amount);
      const amountMatches = openingAmount === terms.amount;
      checks.push(amountMatches ? "escrow amount exactly matches the advertised amount" : "escrow amount does NOT match the advertised amount");
      if (amountMatches) {
        const path = snapshot.outputs;
        if (path === null) {
          escrow = "opening-invalid";
          checks.push("escrow note is not in the node's commitment tree");
        } else {
          checks.push("escrow note is live in the node's commitment tree");
          const nullifierStatus = snapshot.nullifiers;
          const spent = nullifierStatus.statuses[0]!.spent;
          escrow = spent ? "spent" : "escrowed";
          checks.push(spent ? "escrow nullifier is already spent" : "escrow nullifier is unspent");
          if (!spent && liveOnNode === true) {
            claimSnapshot = claimSnapshotFrom(snapshot);
            if (claimSnapshot !== null) checks.push(`payment is anchored to pcash snapshot block ${path.boundary.header.number}`);
          }
        }
      } else {
        escrow = "amount-mismatch";
      }
    } else {
      checks.push("publication does NOT include a funded escrow opening");
    }
  } catch (err) {
    // Node unreachable: keep the client-side verdict, mark the node checks unknown.
    checks.push(`node checks unavailable: ${err instanceof Error ? err.message : String(err)}`);
    if (pub.escrow) escrow = "unknown";
  }

  // This general verifier never authorizes an irreversible payment. The full
  // payment verifier below adds the selected-L1 deployment check and sets
  // safeToPay from this snapshot's settlement capability.
  return {
    ...client,
    routerConfigVerified: null,
    feeQuote: null,
    routerPaid: null,
    liveOnNode,
    escrow,
    claimSnapshot,
    safeToPay: false,
    settlementAccepted: settlementAccepted === true,
    checks,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function verifyOffer(
  node: PcashNodeClient,
  pub: OfferPublication,
  options: VerifyOfferOptions,
): Promise<OfferVerification> {
  const { settlementAccepted: _settlementAccepted, ...verification } = await verifyOfferSnapshot(node, pub, options);
  return verification;
}

/** Include the selected L1's exact PaymentRouter deployment in the irreversible-payment verdict. */
export async function verifyOfferForPayment(
  node: PcashNodeClient,
  pub: OfferPublication,
  options: VerifyPayableOfferOptions,
): Promise<OfferVerification> {
  const { l1Urls, routerDeployment, ...offerOptions } = options;
  const l1 = createPublicClient({ transport: l1RpcTransport(l1Urls) });
  // One PCASH snapshot, the router check, and the selected L1 head, with the
  // router's payment record at that head, decide the payment.
  const [snapshot, router, head] = await Promise.all([
    verifyOfferSnapshot(node, pub, offerOptions),
    (async () => {
      const deployment = routerDeployment
        ?? await verifyPaymentRouterDeployment(node, l1Urls, addressHex(BigInt(offerOptions.expectedRouter)) as Address);
      return quotePaymentRouterFee(BigInt(pub.terms.ethPriceWei), deployment.config);
    })().then((feeQuote) => ({ feeQuote }), (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) })),
    l1.getBlockNumber({ cacheTime: 0 }).then(async (blockNumber) => ({
      blockNumber,
      paid: await l1.readContract({
        address: addressHex(BigInt(offerOptions.expectedRouter)) as Address, abi: PAYMENT_ROUTER_ABI,
        functionName: "paid", args: [routerPaymentKey(pub)], blockNumber,
      }).then((recorded) => ({ recorded: BigInt(recorded) !== 0n }), (error: unknown) => ({ error: errorMessage(error) })),
    }), (error: unknown) => ({ error: errorMessage(error) })),
  ]);
  const { settlementAccepted, ...verification } = snapshot;
  const checks = [...verification.checks];
  let nodeFresh = false;
  let routerPaid: boolean | null = null;
  if ("error" in head) {
    checks.push(`node freshness unavailable: selected L1 head could not be read: ${head.error}`);
  } else if ("error" in head.paid) {
    checks.push(`the router's payment record could not be read: ${head.paid.error}`);
  } else {
    routerPaid = head.paid.recorded;
    checks.push(routerPaid ? "the router already records a payment for this listing" : "the router records no payment for this listing");
  }
  if (!("error" in head) && verification.claimSnapshot !== null) {
    try {
      assertPaymentNodeFreshness(verification.claimSnapshot.anchor.blockNumber, head.blockNumber);
      nodeFresh = true;
      checks.push(`PCASH payment snapshot is within ${MAX_PAYMENT_NODE_LAG_BLOCKS} blocks of the selected L1 head`);
    } catch (error) {
      checks.push(error instanceof Error ? error.message : String(error));
    }
  }
  if ("error" in router) {
    checks.push(`selected L1 RPC does NOT host the approved PaymentRouter: ${router.error}`);
    return { ...verification, routerConfigVerified: false, feeQuote: null, routerPaid, safeToPay: false, checks };
  }
  const { feeQuote } = router;
  checks.push(
    `selected L1 RPC hosts the approved PaymentRouter with fee recipient ${feeQuote.feeRecipient} and ${feeQuote.feeBps} BPS`,
  );
  if (pub.escrow === undefined) {
    checks.push("publication has no escrow opening for a payment decision");
    return { ...verification, routerConfigVerified: true, feeQuote, routerPaid, safeToPay: false, checks };
  }
  const safeToPay =
    verification.l2ContractVerification === "verified" &&
    verification.functionsBound &&
    verification.chainMatches &&
    verification.routerPinned &&
    verification.liveOnNode === true &&
    verification.escrow === "escrowed" &&
    verification.claimSnapshot !== null &&
    nodeFresh &&
    routerPaid === false &&
    settlementAccepted;
  return { ...verification, routerConfigVerified: true, feeQuote, routerPaid, safeToPay, checks };
}
