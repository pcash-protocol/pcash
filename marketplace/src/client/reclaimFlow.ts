// Browser-side seller reclaim flow. The seller calls the L2 smart contract's reclaim
// reclaim circuit locally, checkpoints the exact transaction before mempool
// admission, and keeps those bytes available for reorg recovery until finality.

import {
  bytesToHex,
  encodeAbiParameters,
  hexToBytes,
  keccak256,
  stringToHex,
  type Hex,
} from "viem";
import {
  assertTransactionTypeAccepted,
  scalarFromBytes,
  networkConfigFromStatus,
  fullOutputCommitment,
  nullifier,
  noteNk,
  dummyNullifier,
  issuancePayoutOpening,
  payoutTransactionContext,
  ownerCommitment,
  verifySelectedRelayQuote,
  type SelectedRelayQuoteProvider,
  randomFieldEntropy,
  TX_KIND_PRIVATE_VALUE,
  type OutputPathResult,
  type PcashActionSigner,
  type PcashNodeClient,
  type AccountProofResult,
  addressHex,
  sleep,
} from "@pcash/sdk/browser";
import { deferSubmission, type PcashProfile, type Wallet } from "@pcash/sdk/wallet";
import { PADDED_PRIVATE_VALUE_BYTE_SIZE } from "@pcash/sdk/wallet/actions";
import { buildContractFunctionCall, snapshotFromAccountProof, type AssetActionBuild } from "@pcash/sdk/builders";
import {
  awaitAcceptedReceipt,
  isFinalized,
  pollReceipt,
  type ReceiptResult,
} from "@pcash/sdk/browser";
import type { ProveStatus } from "@pcash/sdk/browser-prover";
import type { AssetDefinition } from "@pcash/sdk/protocol";
import { MARKETPLACE_CIRCUITS } from "../circuits.ts";
import {
  MAX_PAYMENT_DEADLINE_T,
  RECLAIM_APPLICATION_VK_HASH,
  RECLAIM_FUNCTION_SELECTOR,
  reclaimConfigurationCommitment,
  reclaimNotBefore,
} from "../commitments.mts";
import { authorizeReclaimWitnessMap, type UnsignedReclaimWitnessParams } from "./reclaimWitness.ts";
import {
  restoreMarketplaceTransactionToMempool,
  submitMarketplaceTransactionToMempool,
  type MarketplaceTransactionSubmitter,
} from "./mempoolSubmission.ts";
import {
  deriveVerifiedOfferClaimMaterial,
  type VerifiedOfferClaimMaterial,
  type VerifiedFunctionMaterial,
} from "./verifiedContractMaterial.ts";
import { assertPublicationChainId, publicationAssetDefinition, publicationEscrowNote, type OfferPublication } from "./publication.ts";
import { escrowPayoutAmount } from "./networkFee.ts";
import { defaultMarketplaceProver } from "./prover.ts";
import { selectedRelayTransactionExpiry } from "./selectedRelayExpiry.ts";
import type { MarketplaceProver } from "./claimFlow.ts";
import {
  buildUnsponsoredTokenEscrowRelease,
  ESCROW_INPUT_SLOT,
  ESCROW_PAYOUT_SLOT,
  tokenEscrowReleaseSide,
  type TokenEscrowRelease,
} from "./tokenEscrowRelease.ts";


export type ReclaimOfferPublication = OfferPublication;

/** A wallet that pays a token escrow's network fee from its own native notes. */
export type MarketplaceFeeSponsor = Pick<Wallet, "sponsorContractAction">;

/** The wallet journals its fee spend; the Marketplace submits the exact bytes itself. */
export function preparedMempoolSubmission() {
  return deferSubmission({
    mode: "mempool",
    preflight: async () => undefined,
    submit: async () => {
      throw new Error("a prepared Marketplace action is submitted by the Marketplace");
    },
  });
}

export interface ReclaimStateSnapshot {
  recentPcashBlockHash: bigint;
  outputPath: OutputPathResult;
  accountProof: Extract<AccountProofResult, { status: "present" }>;
}

export interface BrowserReclaimParams {
  node: PcashNodeClient;
  offer: ReclaimOfferPublication;
  sellerProfile: PcashProfile;
  /** Resolve the seller's owned receive key from the account directory at the final witness root. */
  sellerReceiveKey(accountStateRoot: bigint): Promise<Uint8Array>;
  sellerSigner: PcashActionSigner;
  /** Latest timestamp from the selected L1 endpoint. */
  readL1Timestamp: () => Promise<bigint>;
  /**
   * Open PCASH fee paid to whichever relayer includes the reclaim. A native
   * escrow pays it from the escrowed value; a token reclaim's seller pays it.
   */
  openFeeAmount: bigint;
  publicationMode?: "open" | "self";
  selectedRelay?: { provider: SelectedRelayQuoteProvider; privateFeeAmount: bigint };
  /** The seller's wallet; pays a token reclaim's positive open fee or selected relay output. */
  sponsor?: MarketplaceFeeSponsor;
  prover?: MarketplaceProver;
  pollIntervalMs?: number;
  pollMaxAttempts?: number;
  groundingPollIntervalMs?: number;
  groundingMaxAttempts?: number;
  onPrepared?: (contentHash: string, transactionHex: Hex) => void | Promise<void>;
  onAccepted?: (receipt: ReceiptResult) => void | Promise<void>;
  onStatus?: (status: ProveStatus) => void;
  submitTransaction?: MarketplaceTransactionSubmitter;
}

export interface ResumeMarketplaceReclaimParams {
  node: PcashNodeClient;
  contentHash: string;
  transactionHex: Hex;
  pollIntervalMs?: number;
  pollMaxAttempts?: number;
  onAccepted?: (receipt: ReceiptResult) => void | Promise<void>;
  onStatus?: (status: ProveStatus) => void;
  submitTransaction?: MarketplaceTransactionSubmitter;
}

export interface MarketplaceReclaimResult {
  contentHash: Hex;
  transactionHex: Hex;
  receipt: ReceiptResult;
}

export type MarketplaceReclaimFinality =
  | { phase: "missing" | "skipped" }
  | { phase: "accepted" | "finalized"; receipt: ReceiptResult };

const RECLAIM_DUMMY_ENTROPY_DERIVATION_DOMAIN = keccak256(
  stringToHex("pcash marketplace deterministic reclaim dummy entropy"),
);

function progress(
  callback: ((status: ProveStatus) => void) | undefined,
  phase: ProveStatus["phase"],
  message: string,
): void {
  callback?.({ phase, message, elapsedMs: 0 });
}


/** Stable private dummy entropy bound to seller secrets and the immutable offer identity. */
export function deriveMarketplaceReclaimDummyEntropy(input: {
  seller: Pick<PcashProfile, "applicationSeed" | "nkRoot">;
  chainId: bigint;
  offerId: bigint;
  contractAddress: bigint;
}): bigint {
  if (input.seller.applicationSeed.length !== 32) {
    throw new Error("seller application seed must be 32 bytes");
  }
  const digest = keccak256(encodeAbiParameters(
    [
      { type: "bytes32" },
      { type: "bytes32" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "uint256" },
    ],
    [
      RECLAIM_DUMMY_ENTROPY_DERIVATION_DOMAIN,
      bytesToHex(input.seller.applicationSeed),
      input.seller.nkRoot,
      input.chainId,
      input.offerId,
      input.contractAddress,
    ],
  ), "bytes");
  return scalarFromBytes(digest);
}

function safeIndex(value: bigint | number, label: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${label} must be a safe nonnegative integer`);
  return parsed;
}

/** Read the recent block, note, and account openings from one node snapshot. */
export async function readReclaimStateSnapshot(params: {
  node: PcashNodeClient;
  escrowLeafIndex: number;
  l2ContractAddress: bigint;
  escrowOutputCommitment: bigint;
  pollIntervalMs?: number;
  maxAttempts?: number;
  onWait?: (attempt: number, reason: string) => void;
}): Promise<ReclaimStateSnapshot> {
  const interval = params.pollIntervalMs ?? 1000;
  const maxAttempts = params.maxAttempts ?? 120;
  let lastReason = "node has not exposed one consistent reclaim snapshot";
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const snapshot = await params.node.getWitnessSnapshot({
        accounts: [addressHex(params.l2ContractAddress)],
        outputs: [{ outputIndex: params.escrowLeafIndex, outputCommitment: params.escrowOutputCommitment }],
      });
      const block = snapshot.blockHeader;
      if (block === null) throw new Error("node has not derived a block yet");
      const accountResult = snapshot.accounts[0]!;
      const paths = snapshot.outputs;
      const outputPath = paths === null ? null : {
        ...paths.paths[0]!, root: paths.root, count: paths.count, boundary: paths.boundary,
      };
      if (accountResult.status !== "present") throw new Error("L2 smart contract account is unavailable");
      if (outputPath === null) throw new Error("escrow output is not in the current tree");
      return { recentPcashBlockHash: block.recentPcashBlockHash, outputPath, accountProof: accountResult };
    } catch (error) {
      lastReason = error instanceof Error ? error.message : String(error);
    }
    params.onWait?.(attempt, lastReason);
    if (attempt < maxAttempts - 1) await sleep(interval);
  }
  throw new Error(`timed out waiting for one consistent reclaim snapshot: ${lastReason}`);
}

/** Re-read a durable reclaim journal without discarding exact bytes before finality. */
export async function readMarketplaceReclaimFinality(
  node: PcashNodeClient,
  contentHash: string,
): Promise<MarketplaceReclaimFinality> {
  const receipt = await pollReceipt(node, contentHash);
  if (receipt === null) return { phase: "missing" };
  if (receipt.outcome !== "succeeded") return { phase: "skipped" };
  const status = await node.status();
  return {
    phase: isFinalized(receipt.inclusion.l1BlockNumber, status) ? "finalized" : "accepted",
    receipt,
  };
}

export async function resumeMarketplaceReclaim(
  params: ResumeMarketplaceReclaimParams,
): Promise<MarketplaceReclaimResult> {
  progress(params.onStatus, "submitting", "restoring the exact reclaim transaction to this node if needed…");
  await restoreMarketplaceTransactionToMempool({
    node: params.node,
    contentHash: params.contentHash,
    transactionHex: params.transactionHex,
    ...(params.onStatus !== undefined
      ? { onProgress: (phase, message) => progress(params.onStatus, phase, message) }
      : {}),
    ...(params.submitTransaction !== undefined ? { submit: params.submitTransaction } : {}),
  });
  progress(params.onStatus, "confirming", "waiting for canonical reclaim acceptance…");
  const receipt = await awaitAcceptedReceipt(params.node, params.contentHash, {
    ...(params.pollIntervalMs !== undefined ? { pollIntervalMs: params.pollIntervalMs } : {}),
    ...(params.pollMaxAttempts !== undefined ? { pollMaxAttempts: params.pollMaxAttempts } : {}),
  });
  if (receipt.kind !== "privateValue") {
    throw new Error(`accepted marketplace reclaim has receipt kind ${receipt.kind}`);
  }
  await params.onAccepted?.(receipt);
  progress(params.onStatus, "done", "reclaim accepted on L1");
  return { contentHash: params.contentHash as Hex, transactionHex: params.transactionHex, receipt };
}

interface ReclaimSetup {
  network: ReturnType<typeof networkConfigFromStatus>;
  canonical: VerifiedOfferClaimMaterial;
  reclaimFunction: VerifiedFunctionMaterial;
  reclaimConfigurationSalt: bigint;
  notBefore: bigint;
  escrow: ReturnType<typeof publicationEscrowNote>;
  assetDefinition: AssetDefinition | null;
  escrowOutputCommitment: bigint;
  snapshot: ReclaimStateSnapshot;
  prover: MarketplaceProver;
}

/** The seller-signed reclaim witness for one built escrow release. */
function reclaimWitness(setup: ReclaimSetup, params: BrowserReclaimParams, build: {
  recentPcashBlockHash: bigint;
  transaction: UnsignedReclaimWitnessParams["transaction"];
  outputData: UnsignedReclaimWitnessParams["outputData"];
  arena: UnsignedReclaimWitnessParams["arena"];
  designatedIssuanceOpening?: UnsignedReclaimWitnessParams["designatedIssuanceOpening"];
  payoutNoteSecret: bigint;
  payoutAmount: bigint;
  relayFeeAmount: bigint;
  relayFeeOwnerCommitment: bigint;
  feePaid: boolean;
}) {
  progress(params.onStatus, "preparing", "requesting seller authorization for the reclaim payout and fee…");
  return authorizeReclaimWitnessMap({
    recentPcashBlockHash: build.recentPcashBlockHash,
    feePaid: build.feePaid,
    network: setup.network,
    configurationSalt: setup.reclaimConfigurationSalt,
    offerId: setup.canonical.terms.id,
    deadlineT: setup.canonical.terms.deadlineT,
    escrowContract: setup.canonical.l2Contract.address,
    recipient: params.sellerProfile.address,
    sellerProfile: params.sellerProfile,
    transaction: build.transaction,
    outputData: build.outputData,
    arena: build.arena,
    escrowNote: {
      noteSecret: setup.escrow.noteSecret,
      assetId: setup.escrow.assetId,
      amount: setup.escrow.amount,
      outputIndex: BigInt(setup.escrow.leafIndex),
    },
    payoutNoteSecret: build.payoutNoteSecret,
    payoutAmount: build.payoutAmount,
    ...(build.designatedIssuanceOpening === undefined ? {} : { designatedIssuanceOpening: build.designatedIssuanceOpening }),
    relayFeeAmount: build.relayFeeAmount,
    relayFeeOwnerCommitment: build.relayFeeOwnerCommitment,
    payoutOpeningBlinder: randomFieldEntropy(),
  }, params.sellerSigner);
}

function reclaimDummyEntropy(setup: ReclaimSetup, params: BrowserReclaimParams): bigint {
  return deriveMarketplaceReclaimDummyEntropy({
    seller: params.sellerProfile,
    chainId: setup.canonical.l2Contract.chainId,
    offerId: setup.canonical.terms.id,
    contractAddress: setup.canonical.l2Contract.address,
  });
}

function reclaimNullifiers(setup: ReclaimSetup, dummyInputEntropy: bigint): bigint[] {
  return [
    nullifier(setup.escrowOutputCommitment, noteNk(setup.canonical.l2Contract.nkRoot), setup.escrow.noteSecret),
    dummyNullifier(dummyInputEntropy, 1n),
    dummyNullifier(dummyInputEntropy, 2n),
    dummyNullifier(dummyInputEntropy, 3n),
  ];
}

/** A native escrow pays the open fee or selected relay output from its own value. */
async function proveNativeReclaim(
  setup: ReclaimSetup,
  params: BrowserReclaimParams,
  status: Awaited<ReturnType<PcashNodeClient["status"]>>,
): Promise<Uint8Array> {
  const { canonical, snapshot, network, notBefore } = setup;
  const netAmount = escrowPayoutAmount(canonical.terms.assetId, canonical.terms.amount, params.selectedRelay?.privateFeeAmount ?? params.openFeeAmount);
  const dummyInputEntropy = reclaimDummyEntropy(setup, params);
  const nullifiers = reclaimNullifiers(setup, dummyInputEntropy);
  const selfIssuance = params.publicationMode === "self"
    ? issuancePayoutOpening(params.sellerProfile.address, params.sellerProfile.nkRoot, canonical.l2Contract.chainId, nullifiers)
    : undefined;
  const quoteBinding = canonical.terms.id;
  const selectedValidUntil = params.selectedRelay === undefined ? MAX_PAYMENT_DEADLINE_T
    : selectedRelayTransactionExpiry(
      status.latestBlockTimestamp, MAX_PAYMENT_DEADLINE_T, params.selectedRelay.provider, "reclaim",
    );
  const selectedQuote = params.selectedRelay === undefined ? undefined : await params.selectedRelay.provider.requestQuote({
    pcashChainId: canonical.l2Contract.chainId,
    recipient: params.selectedRelay.provider.recipient,
    privateFeeAmount: params.selectedRelay.privateFeeAmount,
    maxTransactionBytes: PADDED_PRIVATE_VALUE_BYTE_SIZE,
    transactionContext: payoutTransactionContext(canonical.l2Contract.chainId, nullifiers),
    quoteBinding,
    validUntilTimestamp: selectedValidUntil,
  });
  const selected = selectedQuote === undefined ? undefined : verifySelectedRelayQuote(network, selectedQuote, {
    pcashChainId: canonical.l2Contract.chainId,
    recipient: params.selectedRelay!.provider.recipient,
    privateFeeAmount: params.selectedRelay!.privateFeeAmount,
    maxTransactionBytes: PADDED_PRIVATE_VALUE_BYTE_SIZE,
    transactionContext: payoutTransactionContext(canonical.l2Contract.chainId, nullifiers),
    quoteBinding,
    nowTimestamp: status.latestBlockTimestamp,
  });
  if (selectedQuote !== undefined && BigInt(selectedQuote.validUntilTimestamp) < selectedValidUntil) {
    throw new Error("selected relay quote expires before the reclaim transaction");
  }
  const designatedIssuanceOpening = selected?.designatedIssuanceOpening ?? (selfIssuance === undefined ? undefined : {
    recipientAddress: params.sellerProfile.address,
    noteSecret: selfIssuance.noteSecret,
    transactionContext: selfIssuance.context,
  });

  const transfer = buildContractFunctionCall({
    chainId: canonical.l2Contract.chainId,
    contract: canonical.l2Contract.body,
    selector: setup.reclaimFunction.selector,
    recipientAddress: params.sellerProfile.address,
    paymentAmount: netAmount,
    inputs: [{
      amount: canonical.terms.amount,
      noteSecret: setup.escrow.noteSecret,
      outputIndex: setup.escrow.leafIndex,
      siblings: snapshot.outputPath.siblings,
    }],
    ...snapshotFromAccountProof(snapshot.accountProof),
    openFeeAmount: params.openFeeAmount,
    issuanceOwnerCommitment: selected?.issuanceOwnerCommitment ?? selfIssuance?.ownerCommitment ?? 0n,
    ...(designatedIssuanceOpening === undefined ? {} : { designatedIssuanceOpening }),
    ...(selected === undefined ? {} : { secondOutput: {
      address: params.selectedRelay!.provider.recipient,
      amount: selected.privateFeeAmount,
      receiveKey: selected.receiveKey,
    } }),
    dummyInputEntropy,
    notBeforeTimestamp: notBefore,
    validUntilTimestamp: selectedQuote === undefined ? MAX_PAYMENT_DEADLINE_T : selectedValidUntil,
    accountIndex: safeIndex(snapshot.accountProof.account.index, "account state commitment index"),
    accountSiblings: snapshot.accountProof.accountSiblings,
    recipientReceiveKey: await params.sellerReceiveKey(snapshot.accountProof.accountStateRoot),
  });
  const witness = await reclaimWitness(setup, params, {
    recentPcashBlockHash: transfer.recentPcashBlockHash,
    transaction: transfer.transaction,
    outputData: transfer.outputData,
    arena: transfer.arena,
    ...(designatedIssuanceOpening === undefined ? {} : { designatedIssuanceOpening }),
    payoutNoteSecret: transfer.outputNoteSecrets[0],
    payoutAmount: netAmount,
    relayFeeAmount: selected?.privateFeeAmount ?? 0n,
    relayFeeOwnerCommitment: selected === undefined ? 0n : ownerCommitment(
      params.selectedRelay!.provider.recipient, transfer.outputNoteSecrets[1]!,
    ),
    feePaid: false,
  });
  const publicInputs = transfer.publicInputs;
  const proof = await setup.prover.proveTransfer({
    authorizationWitnessMap: witness,
    buildKernelWitnessMap: transfer.buildKernelWitnessMap,
    expectedPublicInputs: publicInputs,
    authorizationCircuitUrl: MARKETPLACE_CIRCUITS.reclaim,
    authorizationLabel: "reclaim circuit",
  }, params.onStatus);
  return transfer.encodeTransaction(proof.proof);
}

function tokenReclaimRelease(setup: ReclaimSetup, params: BrowserReclaimParams, snapshot: Pick<ReclaimStateSnapshot, "accountProof"> & { siblings: readonly bigint[] }, receiveKey: Uint8Array): TokenEscrowRelease {
  return {
    pcashChainId: setup.canonical.l2Contract.chainId,
    l2Contract: setup.canonical.l2Contract,
    selector: setup.reclaimFunction.selector,
    contractAccount: snapshot.accountProof,
    escrow: { ...setup.escrow, siblings: snapshot.siblings },
    assetDefinition: setup.assetDefinition!,
    payout: { recipientAddress: params.sellerProfile.address, receiveKey },
  };
}

function tokenReclaimWitness(setup: ReclaimSetup, params: BrowserReclaimParams, build: AssetActionBuild, feePaid: boolean, designatedIssuanceOpening?: UnsignedReclaimWitnessParams["designatedIssuanceOpening"]) {
  return reclaimWitness(setup, params, {
    recentPcashBlockHash: build.recentPcashBlockHash,
    transaction: build.transaction,
    outputData: build.outputData,
    arena: build.arena,
    ...(designatedIssuanceOpening === undefined ? {} : { designatedIssuanceOpening }),
    payoutNoteSecret: build.outputNoteSecrets[ESCROW_PAYOUT_SLOT]!,
    payoutAmount: setup.escrow.amount,
    relayFeeAmount: 0n,
    relayFeeOwnerCommitment: 0n,
    feePaid,
  });
}

/** A token reclaim with no network fee spends only the escrow: self-publication or a zero-fee open route. */
async function proveUnsponsoredTokenReclaim(setup: ReclaimSetup, params: BrowserReclaimParams): Promise<Uint8Array> {
  const { canonical, snapshot } = setup;
  const dummyInputSeed = reclaimDummyEntropy(setup, params);
  const selfIssuance = params.publicationMode === "self"
    ? issuancePayoutOpening(params.sellerProfile.address, params.sellerProfile.nkRoot, canonical.l2Contract.chainId, reclaimNullifiers(setup, dummyInputSeed))
    : undefined;
  const designatedIssuanceOpening = selfIssuance === undefined ? undefined : {
    recipientAddress: params.sellerProfile.address,
    noteSecret: selfIssuance.noteSecret,
    transactionContext: selfIssuance.context,
  };
  const build = buildUnsponsoredTokenEscrowRelease({
    ...tokenReclaimRelease(setup, params, { accountProof: snapshot.accountProof, siblings: snapshot.outputPath.siblings },
      await params.sellerReceiveKey(snapshot.accountProof.accountStateRoot)),
    issuanceOwnerCommitment: selfIssuance?.ownerCommitment ?? 0n,
    ...(designatedIssuanceOpening === undefined ? {} : { designatedIssuanceOpening }),
    notBeforeTimestamp: setup.notBefore,
    validUntilTimestamp: MAX_PAYMENT_DEADLINE_T,
    dummyInputSeed,
  });
  const proof = await setup.prover.proveAssetAction({
    operation: "transfer",
    authorization: {
      circuitUrl: MARKETPLACE_CIRCUITS.reclaim,
      witnessMap: await tokenReclaimWitness(setup, params, build, false, designatedIssuanceOpening),
      label: "reclaim circuit",
    },
    buildKernelWitnessMap: build.buildKernelWitnessMap,
    expectedPublicInputs: build.publicInputs,
  }, params.onStatus);
  return build.encodeTransaction(proof.proof);
}

/** The seller's wallet pays a token reclaim's open fee or selected relay output; the token returns in full. */
async function proveSponsoredTokenReclaim(setup: ReclaimSetup, params: BrowserReclaimParams): Promise<Uint8Array> {
  if (params.sponsor === undefined) {
    throw new Error("a token reclaim with a network fee needs the seller's wallet to pay it");
  }
  const result = await params.sponsor.sponsorContractAction({
    contract: setup.canonical.l2Contract.address,
    reservedInputSlots: [ESCROW_INPUT_SLOT],
    reservedOutputSlots: [ESCROW_PAYOUT_SLOT],
    snapshotQuery: { outputs: [{ outputIndex: setup.escrow.leafIndex, outputCommitment: setup.escrowOutputCommitment }] },
    primary: (context) => {
      const side = tokenEscrowReleaseSide(tokenReclaimRelease(setup, params, {
        accountProof: context.contractAccount,
        siblings: context.outputPaths[0]!.siblings,
      }, context.selfReceiveKey()));
      return {
        authorization: side.authorization,
        assetId: setup.escrow.assetId,
        inputs: [{ slot: ESCROW_INPUT_SLOT, input: side.input }],
        realizeOutputs: () => ({ outputs: [{ slot: ESCROW_PAYOUT_SLOT, output: side.output }], ownedOutputs: [] }),
        circuitUrl: MARKETPLACE_CIRCUITS.reclaim,
        label: "reclaim circuit",
        witness: (build, issuance) => tokenReclaimWitness(setup, params, build, true, issuance.designatedIssuanceOpening),
      };
    },
    prover: setup.prover,
    ...(params.selectedRelay === undefined
      ? { openFeeAmount: params.openFeeAmount }
      : { privateRelayFeeAmount: params.selectedRelay.privateFeeAmount, selectedRelayQuote: params.selectedRelay.provider }),
    submission: preparedMempoolSubmission(),
    notBeforeTimestamp: setup.notBefore,
    ...(params.onStatus === undefined ? {} : {
      onProgress: (phase: ProveStatus["phase"], message: string) => progress(params.onStatus, phase, message),
    }),
  });
  return hexToBytes(result.transactionHex as Hex);
}

export async function reclaimMarketplaceOffer(
  params: BrowserReclaimParams,
): Promise<MarketplaceReclaimResult> {
  if (params.sellerSigner.address !== params.sellerProfile.address) {
    throw new Error("selected PCASH signer does not match the seller profile");
  }
  const status = await params.node.status();
  // Fail before a long proving run when this node does not accept the relation,
  // or is not the chain the saved offer belongs to.
  assertTransactionTypeAccepted(status, TX_KIND_PRIVATE_VALUE);
  const publication = params.offer;
  if (publication.version !== 1) throw new Error("marketplace reclaim requires publication version 1");
  assertPublicationChainId(status, publication);
  if (publication.escrow === undefined) throw new Error("offer has no funded escrow opening");

  const canonical = deriveVerifiedOfferClaimMaterial(publication);
  const reclaimFunction = canonical.l2Contract.function(RECLAIM_FUNCTION_SELECTOR);
  if (reclaimFunction.applicationVkHash !== RECLAIM_APPLICATION_VK_HASH) {
    throw new Error("marketplace L2 smart contract reclaim function does not use the approved application");
  }
  if (params.sellerProfile.address !== BigInt(publication.reclaimAuthority)) {
    throw new Error("the selected wallet is not this offer's reclaim authority");
  }

  const notBefore = reclaimNotBefore(canonical.terms.deadlineT);
  if (notBefore > MAX_PAYMENT_DEADLINE_T) throw new Error("reclaim time does not fit uint64");
  const network = networkConfigFromStatus(status);
  if (canonical.l2Contract.chainId !== network.pcashChainId) {
    throw new Error("marketplace offer targets a different PCASH network");
  }
  const reclaimConfigurationSalt = BigInt(publication.l2Contract.reclaimConfigurationSalt);
  const expectedAuth = reclaimConfigurationCommitment(
    reclaimConfigurationSalt,
    network,
    params.sellerProfile.address,
    canonical.terms.id,
    canonical.terms.deadlineT,
  );
  if (reclaimFunction.configurationCommitment !== expectedAuth) {
    throw new Error("marketplace L2 smart contract reclaim function does not bind the advertised reclaim deadline and authority");
  }
  const escrow = publicationEscrowNote(publication, canonical.l2Contract);
  if (escrow.amount !== canonical.terms.amount) {
    throw new Error("escrow opening amount does not match the offered amount");
  }
  escrowPayoutAmount(canonical.terms.assetId, canonical.terms.amount, params.selectedRelay?.privateFeeAmount ?? params.openFeeAmount);
  if (params.selectedRelay !== undefined && (params.openFeeAmount !== 0n || params.publicationMode === "self")) {
    throw new Error("selected reclaim requires zero open fee and a public mempool submitter");
  }
  if (params.publicationMode === "self" && params.openFeeAmount !== 0n) {
    throw new Error("self-published reclaim cannot carry an open fee");
  }

  const l1Timestamp = await params.readL1Timestamp();
  if (l1Timestamp < notBefore) {
    throw new Error(`reclaim opens at L1 timestamp ${notBefore}; current L1 timestamp is ${l1Timestamp}`);
  }

  progress(params.onStatus, "preparing", "reading the escrow and L2 smart contract at one node snapshot…");
  const escrowOutputCommitment = fullOutputCommitment(escrow, escrow.leafIndex);
  const snapshot = await readReclaimStateSnapshot({
    node: params.node,
    escrowLeafIndex: escrow.leafIndex,
    l2ContractAddress: canonical.l2Contract.address,
    escrowOutputCommitment,
    ...(params.groundingPollIntervalMs !== undefined ? { pollIntervalMs: params.groundingPollIntervalMs } : {}),
    ...(params.groundingMaxAttempts !== undefined ? { maxAttempts: params.groundingMaxAttempts } : {}),
    onWait: () => progress(
      params.onStatus,
      "preparing",
      "Preparing reclaim…",
    ),
  });
  const setup: ReclaimSetup = {
    network,
    canonical,
    reclaimFunction,
    reclaimConfigurationSalt,
    notBefore,
    escrow,
    assetDefinition: publicationAssetDefinition(publication),
    escrowOutputCommitment,
    snapshot,
    prover: params.prover ?? await defaultMarketplaceProver(params.node),
  };
  const sponsored = canonical.terms.assetId !== 0n
    && (params.selectedRelay !== undefined || params.openFeeAmount !== 0n);
  const entry = canonical.terms.assetId === 0n
    ? await proveNativeReclaim(setup, params, status)
    : sponsored ? await proveSponsoredTokenReclaim(setup, params) : await proveUnsponsoredTokenReclaim(setup, params);
  const prepared = await submitMarketplaceTransactionToMempool({
    node: params.node,
    transactionBytes: entry,
    ...(params.onPrepared !== undefined
      ? {
          onPrepared: (contentHash: string, transactionHex: Hex) => params.onPrepared!(contentHash, transactionHex),
        }
      : {}),
    ...(params.onStatus !== undefined
      ? { onProgress: (phase, message) => progress(params.onStatus, phase, message) }
      : {}),
    ...(params.submitTransaction !== undefined ? { submit: params.submitTransaction } : {}),
  });

  progress(params.onStatus, "confirming", "waiting for canonical reclaim acceptance…");
  const receipt = await awaitAcceptedReceipt(params.node, prepared.contentHash, {
    ...(params.pollIntervalMs !== undefined ? { pollIntervalMs: params.pollIntervalMs } : {}),
    ...(params.pollMaxAttempts !== undefined ? { pollMaxAttempts: params.pollMaxAttempts } : {}),
  });
  if (receipt.kind !== "privateValue") {
    throw new Error(`accepted marketplace reclaim has receipt kind ${receipt.kind}`);
  }
  await params.onAccepted?.(receipt);
  progress(params.onStatus, "done", "reclaim accepted on L1");
  return { ...prepared, receipt };
}
