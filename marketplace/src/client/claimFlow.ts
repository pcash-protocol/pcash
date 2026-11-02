import {
  boundedNetworkFee,
  ETHEREUM_SLOT_SECONDS,
  nativeBurnAmount,
  NO_BURN,
  privateValueUnits,
  quoteNativeBurn,
  requiredProtocolFee,
  type AccountCreationAttachment,
  type NativeBurn,
} from "@pcash/sdk/protocol";
// Browser-native marketplace claim. The claim travels in the router call that
// pays for it (`buy`) or in a later `retry`, as the router's `PcashBatch` event.
// This module proves the claim against one PCASH snapshot, frames it as that
// event's batch, dry-runs it with the router's carrier context, and reads the
// claim that spent the escrow.

import { formatUnits, hexToBytes, toHex, type Hex } from "viem";
import {
  addressHex,
  assertTransactionTypeAccepted,
  decodeTransaction,
  dummyNullifier,
  encodeBatchForVersion,
  fullOutputCommitment,
  isFinalized,
  issuancePayoutOpening,
  noteNk,
  nullifier,
  posterPayoutOpening,
  PRIVATE_VALUE_PROFILES,
  privateValueProfile,
  RECENT_PCASH_BLOCK_WINDOW_SECONDS,
  sectionPublicInput,
  selectBatchVersion,
  sleep,
  transactionIdentity,
  TX_KIND_PRIVATE_VALUE,
  type AccountProofResult,
  type CarrierContextInput,
  type PcashNodeClient,
  type StatusResult,
  type WitnessSnapshotResult,
} from "@pcash/sdk/browser";
import { deferSubmission, WalletConflictError, type PcashProfile } from "@pcash/sdk/wallet";
import { InsufficientNotesError, ProtocolFeeFundingError } from "@pcash/sdk/wallet/actions";
import { bytes32Hex, randomFieldEntropy } from "@pcash/sdk/utils";
import { buildContractFunctionCall, snapshotFromAccountProof } from "@pcash/sdk/builders";
import type { AssetProver, Prover, ProveStatus } from "@pcash/sdk/browser-prover";
import { MARKETPLACE_CIRCUITS } from "../circuits.ts";
import { claimKeyCommitment, paymentCarrierContext, paymentCarrierContextHash } from "../commitments.mts";
import { buildClaimWitnessMap } from "./claimWitness.ts";
import { deriveVerifiedOfferClaimMaterial } from "./verifiedContractMaterial.ts";
import {
  assertPublicationChainId,
  publicationAssetDefinition,
  publicationEscrowNote,
  publicationTerms,
  type OfferPublication,
} from "./publication.ts";
import {
  buildUnsponsoredTokenEscrowRelease,
  ESCROW_INPUT_SLOT,
  ESCROW_PAYOUT_SLOT,
  tokenEscrowReleaseSide,
  type MarketplaceFeeSponsor,
} from "./tokenEscrowRelease.ts";
import { derivePurchaseSecrets } from "./buy.ts";
import { escrowPayoutAmount } from "./networkFee.ts";
import { escrowCommitments } from "./offerAvailability.ts";
import type { ClaimTxFinality } from "./offerPersistence.ts";
import { defaultMarketplaceProver } from "./prover.ts";
import type { PaymentAnchor } from "./verification.ts";

/** Browser proving for both native claims and token escrow releases. */
export type MarketplaceProver = Prover & AssetProver;

/**
 * A router call that carries a claim must execute this long before the claim's
 * snapshot leaves the recent-block window. The window check uses the including
 * Ethereum block's timestamp, so this is margin, not a correction.
 */
export const CLAIM_NOT_AFTER_MARGIN_SECONDS = 60n;

/** One PCASH snapshot a claim is proved against, and the Ethereum anchor the router call names for it. */
export interface ClaimSnapshot {
  /** The Ethereum block the snapshot's PCASH block was derived from; the router checks it with `blockhash`. */
  anchor: PaymentAnchor;
  /** The snapshot block's timestamp, which is its Ethereum block's header timestamp. */
  timestamp: bigint;
  /** The escrow contract's account, opened beneath the snapshot block. */
  account: Extract<AccountProofResult, { status: "present" }>;
  /** The escrow note's output path beneath the same block. */
  escrowSiblings: readonly bigint[];
  /** The fee state the node read with the snapshot, which the claim's burn is quoted from. */
  fee: ClaimFeeStatus;
}

/**
 * Claim material from a snapshot that opened the escrow contract and the escrow
 * output. The anchor and the proof's state come from the same PCASH block.
 */
export function claimSnapshotFrom(snapshot: WitnessSnapshotResult): ClaimSnapshot | null {
  const contract = snapshot.contracts[0];
  const path = snapshot.outputs?.paths[0];
  if (contract?.status !== "contract" || path === undefined || snapshot.block === null) return null;
  return {
    anchor: { blockNumber: snapshot.block.l1Origin.blockNumber, blockHash: snapshot.block.l1Origin.blockHash as Hex },
    timestamp: contract.accountProof.boundary.header.timestamp,
    account: contract.accountProof,
    escrowSiblings: path.siblings,
    fee: {
      feeExcess: snapshot.status.feeExcess,
      baseFee: snapshot.status.baseFee,
      latestBlockTimestamp: snapshot.status.latestBlockTimestamp,
    },
  };
}

/** Read the current head's claim snapshot for a funded offer. */
export async function readClaimSnapshot(node: PcashNodeClient, offer: OfferPublication): Promise<ClaimSnapshot> {
  const material = deriveVerifiedOfferClaimMaterial(offer);
  const escrow = publicationEscrowNote(offer, material.l2Contract);
  const commitments = escrowCommitments(offer, offer.escrow!, material.l2Contract);
  const snapshot = await node.getWitnessSnapshot({
    contracts: [addressHex(material.l2Contract.address)],
    outputs: [{ outputIndex: escrow.leafIndex, outputCommitment: commitments.leaf }],
    nullifiers: [commitments.nullifier],
  });
  if (snapshot.nullifiers.statuses[0]?.spent) {
    throw new Error("the escrow note is already spent; refresh to see whether your claim landed");
  }
  const claim = claimSnapshotFrom(snapshot);
  if (claim === null) throw new Error("the node does not hold the escrow contract and note at its head");
  return claim;
}

/**
 * The latest timestamp at which a router call should carry a claim proved
 * against a snapshot taken at `snapshotTimestamp`: inside the recent-block
 * window, and no later than the claim itself is valid.
 */
export function claimNotAfter(snapshotTimestamp: bigint, validUntilTimestamp: bigint): bigint {
  const windowEnd = snapshotTimestamp + RECENT_PCASH_BLOCK_WINDOW_SECONDS - CLAIM_NOT_AFTER_MARGIN_SECONDS;
  return windowEnd < validUntilTimestamp ? windowEnd : validUntilTimestamp;
}

export interface ProvedClaim {
  contentHash: Hex;
  transactionHex: Hex;
  /** The snapshot a buyer-funded claim was proved against, which the wallet reads itself. */
  provedAgainst?: Pick<ClaimSnapshot, "anchor" | "timestamp">;
}

/** What a claim burns, who pays it, and what its buyer receives. */
export interface ClaimQuote {
  burn: NativeBurn;
  /** The listing's asset; 0 is native PCASH. */
  assetId: bigint;
  /** The payout: a native escrow less its burn, or a token escrow in full. */
  receivedAmount: bigint;
  /**
   * The buyer's own native PCASH pays the burn, with the escrow contract as
   * the primary account of a sponsored transfer: a token claim that burns.
   */
  buyerFunded: boolean;
  /** For a claim `buy` carries that burns a fee, the latest Ethereum timestamp through which the burn covers it. */
  feeCoveredUntil?: bigint;
}

/** A native claim's burn would take the whole escrow, so the claim cannot pay out. */
export class NativeClaimFeeError extends Error {
  readonly nativeBurnAmount: bigint;
  constructor(nativeBurnAmount: bigint, escrowAmount: bigint) {
    super(`this listing's claim would burn ${formatUnits(nativeBurnAmount, 18)} PCASH for the network fee, `
      + `at least the ${formatUnits(escrowAmount, 18)} PCASH listed; it can be claimed once the fee falls`);
    this.name = "NativeClaimFeeError";
    this.nativeBurnAmount = nativeBurnAmount;
  }
}

/** A token claim must burn, and the buyer's wallet holds too little spendable native PCASH to pay it. */
export class ClaimFundingError extends Error {
  readonly nativeBurnAmount: bigint;
  constructor(nativeBurnAmount: bigint, paid: boolean, options?: { cause?: unknown }) {
    super(paid
      ? `this claim must burn ${formatUnits(nativeBurnAmount, 18)} PCASH for the network fee from this wallet, which holds too little spendable PCASH; `
        + "add PCASH, for example by buying a PCASH listing, and retry before the listing's deadline, or retry once the fee returns to zero"
      : `buying this listing now burns ${formatUnits(nativeBurnAmount, 18)} PCASH for the network fee from this wallet, which holds too little spendable PCASH; `
        + "add PCASH or buy while the network fee is zero", options);
    this.name = "ClaimFundingError";
    this.nativeBurnAmount = nativeBurnAmount;
  }
}

/** An earlier buyer-funded claim for this purchase still holds the escrow in this wallet's journal. */
export class EarlierClaimPendingError extends Error {
  constructor(options?: { cause?: unknown }) {
    super("an earlier claim for this purchase stays reserved in this wallet until it lands or expires, at most 30 minutes after it was proved; retry the claim after then", options);
    this.name = "EarlierClaimPendingError";
  }
}

/**
 * A claim carried by `buy` burns enough to cover the fee through this long
 * after the Ethereum head at quote time: proving, approval, and landing.
 */
export const PURCHASE_FEE_WINDOW_SECONDS = 180n;

/** The Ethereum block a carried claim's fee bound starts from, usually the head. */
export interface EthereumHead {
  gasLimit: bigint;
  timestamp: bigint;
}

export type ClaimQuoteOptions = {
  /** The claim attaches the buyer's account creation. */
  createsAccount?: boolean;
  voluntaryBurnAmount?: bigint;
} & (
  /** The payment already landed, so the claim is for `retry`. */
  | { paid: true }
  /** The claim travels in `buy`, which pays before the claim executes. */
  | { paid?: false; ethereumHead: EthereumHead }
);

/** The node's fee state at a PCASH block, which a claim's burn is quoted from. */
export type ClaimFeeStatus = Pick<StatusResult, "feeExcess" | "baseFee" | "latestBlockTimestamp">;

/**
 * The fee a claim `buy` carries burns, and until when. While an hour of full
 * blocks leaves the fee waived, it burns nothing and its own limit stands;
 * that hour outlasts any claim's limit. Otherwise it burns the fee's worst
 * case through the purchase window, and `buy` may carry it no later. Blocks
 * count from the claim's snapshot, the block the router protects; the window
 * from the Ethereum head, or the snapshot when the head is behind it.
 */
function carriedClaimFee(status: ClaimFeeStatus, head: EthereumHead, units: bigint): { networkFeeAmount: bigint; feeCoveredUntil?: bigint } {
  const tip = status.latestBlockTimestamp;
  const from = head.timestamp > tip ? head.timestamp : tip;
  const blocksThrough = (seconds: bigint) => (from + seconds - tip + ETHEREUM_SLOT_SECONDS - 1n) / ETHEREUM_SLOT_SECONDS;
  if (boundedNetworkFee(status.feeExcess, units, blocksThrough(RECENT_PCASH_BLOCK_WINDOW_SECONDS), head.gasLimit) === 0n) {
    return { networkFeeAmount: 0n };
  }
  return {
    networkFeeAmount: boundedNetworkFee(status.feeExcess, units, blocksThrough(PURCHASE_FEE_WINDOW_SECONDS), head.gasLimit),
    feeCoveredUntil: from + PURCHASE_FEE_WINDOW_SECONDS,
  };
}

/**
 * Quote one claim. A claim `buy` carries pays before it executes, so it burns
 * what `carriedClaimFee` says; `retry` pays nothing and can repeat, so its
 * claim burns the fee projected from the node's `feeExcess`. A native escrow
 * pays the burn out of the buyer's payout. A token escrow pays out in full and
 * has no native value, so the buyer's own PCASH pays it. A paid token claim
 * burns nothing while the next block requires no fee, since a zero-burn claim
 * then succeeds whatever the projection.
 */
export function quoteClaim(
  status: ClaimFeeStatus,
  offer: { assetId: bigint; amount: bigint },
  options: ClaimQuoteOptions,
): ClaimQuote {
  const units = privateValueUnits(PRIVATE_VALUE_PROFILES.S.inputs, options.createsAccount === true);
  const voluntaryBurnAmount = options.voluntaryBurnAmount ?? 0n;
  let burn: NativeBurn;
  let coverage: { feeCoveredUntil?: bigint } = {};
  if (options.paid === true) {
    burn = offer.assetId !== 0n && requiredProtocolFee(status.baseFee, units) === 0n && voluntaryBurnAmount === 0n
      ? NO_BURN
      : quoteNativeBurn(status.feeExcess, units, voluntaryBurnAmount);
  } else {
    const { networkFeeAmount, ...covered } = carriedClaimFee(status, options.ethereumHead, units);
    burn = { networkFeeAmount, voluntaryBurnAmount };
    coverage = covered;
  }
  if (offer.assetId !== 0n) {
    return { burn, assetId: offer.assetId, receivedAmount: offer.amount, buyerFunded: nativeBurnAmount(burn) !== 0n, ...coverage };
  }
  if (nativeBurnAmount(burn) >= offer.amount) throw new NativeClaimFeeError(nativeBurnAmount(burn), offer.amount);
  return { burn, assetId: 0n, receivedAmount: escrowPayoutAmount(0n, offer.amount, 0n, nativeBurnAmount(burn)), buyerFunded: false, ...coverage };
}

function claimPublicInput(transactionHex: Hex, offset: "nativeBurnAmount" | "validUntil"): bigint {
  const transaction = decodeTransaction(hexToBytes(transactionHex));
  if (transaction.kind !== TX_KIND_PRIVATE_VALUE) throw new Error("a claim is a private-value transaction");
  return sectionPublicInput(transaction, privateValueProfile(transaction.shape).offsets[offset]);
}

/** The native burn the exact bytes of a saved claim declare. */
export function savedClaimBurn(transactionHex: Hex): bigint {
  return claimPublicInput(transactionHex, "nativeBurnAmount");
}

/** The deadline the exact bytes of a claim declare. */
export function claimValidUntil(transactionHex: Hex): bigint {
  return claimPublicInput(transactionHex, "validUntil");
}

/** The wallet journals a buyer-funded claim and its fee notes; the payment router's call carries its exact bytes. */
function carriedClaimSubmission() {
  return deferSubmission({
    mode: "l1",
    preflight: async () => undefined,
    submit: async () => {
      throw new Error("a carried claim is posted by the payment router");
    },
  });
}

export type ProveClaimParams = {
  node: PcashNodeClient;
  offer: OfferPublication;
  buyer: PcashProfile;
  /** The buyer's account creation, attached only while the buyer's account does not exist. */
  accountCreation?: AccountCreationAttachment;
  /** PCASH the buyer burns beyond the quoted network fee, from a native payout. */
  voluntaryBurnAmount?: bigint;
  /** The buyer's wallet, which funds a token claim's burn. */
  sponsor?: MarketplaceFeeSponsor;
  snapshot: ClaimSnapshot;
  /** Resolve the buyer's owned receive key from the account directory at the snapshot's account root. */
  buyerReceiveKey(accountStateRoot: bigint): Promise<Uint8Array>;
  prover?: MarketplaceProver;
  onStatus?: (status: ProveStatus) => void;
} & (
  /** The payment already landed and the claim is for `retry`. */
  | { paid: true }
  /** The claim travels in `buy`; its fee bound starts from this Ethereum block. */
  | { paid?: false; ethereumHead: EthereumHead }
);

function safeIndex(value: bigint, label: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`${label} must be a safe nonnegative integer`);
  return number;
}

/**
 * Prove the escrow claim against `snapshot`. The claim requires the router's
 * carrier context for this payment, pays the buyer the escrow with no open fee,
 * and designates its issuance to the buyer's own one-time commitment, as
 * self-publication does. A native claim burns the network fee `quoteClaim`
 * quotes from the buyer's payout. A token claim that burns is a sponsored
 * transfer: the buyer's wallet pays the burn from its own notes, takes its
 * change, and journals the action. Proving again after the fee rises quotes
 * again. It is valid until the offer's deadline `T`, and a claim for `buy`
 * that burns a fee only while its burn covers the fee.
 */
export async function proveCarriedClaim(params: ProveClaimParams): Promise<ProvedClaim> {
  const status = await params.node.status();
  assertTransactionTypeAccepted(status, TX_KIND_PRIVATE_VALUE);
  assertPublicationChainId(status, params.offer);
  const material = deriveVerifiedOfferClaimMaterial(params.offer);
  const terms = material.terms;
  const quote = quoteClaim(params.snapshot.fee, terms, {
    createsAccount: params.accountCreation !== undefined,
    ...(params.voluntaryBurnAmount === undefined ? {} : { voluntaryBurnAmount: params.voluntaryBurnAmount }),
    ...(params.paid === true ? { paid: true } : { ethereumHead: params.ethereumHead }),
  });
  const validUntilTimestamp = quote.feeCoveredUntil !== undefined && quote.feeCoveredUntil < terms.deadlineT
    ? quote.feeCoveredUntil : terms.deadlineT;
  const pcashChainId = material.l2Contract.chainId;
  const escrow = publicationEscrowNote(params.offer, material.l2Contract);
  const escrowOutputCommitment = fullOutputCommitment(escrow, escrow.leafIndex);
  const claimKey = derivePurchaseSecrets(params.offer, params.buyer, material.l2Contract).claimKey;
  const carrierContextHash = paymentCarrierContextHash(terms, claimKeyCommitment(claimKey, escrowOutputCommitment));
  const dummyInputEntropy = randomFieldEntropy();
  const claimNullifiers = [
    nullifier(escrowOutputCommitment, noteNk(material.l2Contract.nkRoot), escrow.noteSecret),
    dummyNullifier(dummyInputEntropy, 1n),
    dummyNullifier(dummyInputEntropy, 2n),
    dummyNullifier(dummyInputEntropy, 3n),
  ];
  const issuance = issuancePayoutOpening(params.buyer.address, params.buyer.nkRoot, pcashChainId, claimNullifiers);
  const designatedIssuanceOpening = {
    recipientAddress: params.buyer.address,
    noteSecret: issuance.noteSecret,
    transactionContext: issuance.context,
  };
  const { snapshot } = params;
  const prover = params.prover ?? await defaultMarketplaceProver(params.node);
  const witness = (build: {
    recentPcashBlockHash: bigint;
    address: bigint;
    transaction: Parameters<typeof buildClaimWitnessMap>[0]["transaction"];
    payoutNoteSecret: bigint;
  }, feePaid = false) => buildClaimWitnessMap({
    recentPcashBlockHash: build.recentPcashBlockHash,
    address: build.address,
    pcashChainId,
    feePaid,
    configurationSalt: material.claimConfigurationSalt,
    offer: terms,
    claimKey,
    transaction: build.transaction,
    escrowNote: { noteSecret: escrow.noteSecret, outputIndex: BigInt(escrow.leafIndex) },
    payoutOwner: params.buyer.address,
    payoutNoteSecret: build.payoutNoteSecret,
    relayFeeAmount: 0n,
    relayFeeOwnerCommitment: 0n,
  });

  if (quote.buyerFunded) {
    if (params.sponsor === undefined) throw new ClaimFundingError(nativeBurnAmount(quote.burn), params.paid === true);
    if (params.accountCreation !== undefined) throw new Error("a buyer-funded claim cannot create the buyer's account");
    const assetDefinition = publicationAssetDefinition(params.offer)!;
    let provedAgainst: ProvedClaim["provedAgainst"];
    let result;
    try {
      result = await params.sponsor.sponsorContractAction({
        contract: material.l2Contract.address,
        reservedInputSlots: [ESCROW_INPUT_SLOT],
        reservedOutputSlots: [ESCROW_PAYOUT_SLOT],
        snapshotQuery: {
          outputs: [{ outputIndex: escrow.leafIndex, outputCommitment: escrowOutputCommitment }],
          nullifiers: [bytes32Hex(claimNullifiers[0]!)],
        },
        primary: (context) => {
          if (context.snapshot.nullifiers.statuses[0]?.spent) {
            throw new Error("the escrow note is already spent; refresh to see whether your claim landed");
          }
          const block = context.snapshot.block;
          if (block === null) throw new Error("the node has not derived a block to prove the claim against");
          provedAgainst = {
            anchor: { blockNumber: block.l1Origin.blockNumber, blockHash: block.l1Origin.blockHash as Hex },
            timestamp: context.contractAccount.boundary.header.timestamp,
          };
          const side = tokenEscrowReleaseSide({
            pcashChainId,
            l2Contract: material.l2Contract,
            selector: material.claim.selector,
            contractAccount: context.contractAccount,
            escrow: { ...escrow, siblings: context.outputPaths[0]!.siblings },
            assetDefinition,
            payout: { recipientAddress: params.buyer.address, receiveKey: context.selfReceiveKey() },
          });
          return {
            authorization: side.authorization,
            assetId: escrow.assetId,
            inputs: [{ slot: ESCROW_INPUT_SLOT, input: side.input }],
            realizeOutputs: () => ({ outputs: [{ slot: ESCROW_PAYOUT_SLOT, output: side.output }], ownedOutputs: [] }),
            circuitUrl: MARKETPLACE_CIRCUITS.claim,
            label: "claim circuit",
            witness: (build) => witness({
              recentPcashBlockHash: build.recentPcashBlockHash,
              address: build.address,
              transaction: build.transaction,
              payoutNoteSecret: build.outputNoteSecrets[ESCROW_PAYOUT_SLOT]!,
            }, true),
          };
        },
        prover,
        networkFeeAmount: quote.burn.networkFeeAmount,
        ...(quote.burn.voluntaryBurnAmount === 0n ? {} : { voluntaryBurnAmount: quote.burn.voluntaryBurnAmount }),
        carrierContextHash,
        validUntilTimestamp,
        validUntilMode: "ceiling",
        submission: carriedClaimSubmission(),
        ...(params.onStatus === undefined ? {} : {
          onProgress: (phase: ProveStatus["phase"], message: string) => params.onStatus!({ phase, message, elapsedMs: 0 }),
        }),
      });
    } catch (error) {
      if (error instanceof ProtocolFeeFundingError || (error instanceof Error && error.cause instanceof InsufficientNotesError)) {
        throw new ClaimFundingError(nativeBurnAmount(quote.burn), params.paid === true, { cause: error });
      }
      if (error instanceof WalletConflictError) throw new EarlierClaimPendingError({ cause: error });
      throw error;
    }
    return {
      contentHash: result.contentHash as Hex,
      transactionHex: result.transactionHex as Hex,
      ...(provedAgainst === undefined ? {} : { provedAgainst }),
    };
  }

  const receiveKey = await params.buyerReceiveKey(snapshot.account.accountStateRoot);
  if (terms.assetId === 0n) {
    const transfer = buildContractFunctionCall({
      chainId: pcashChainId,
      contract: material.l2Contract.body,
      selector: material.claim.selector,
      recipientAddress: params.buyer.address,
      paymentAmount: quote.receivedAmount,
      inputs: [{
        amount: terms.amount,
        noteSecret: escrow.noteSecret,
        outputIndex: escrow.leafIndex,
        siblings: snapshot.escrowSiblings,
      }],
      ...snapshotFromAccountProof(snapshot.account),
      openFeeAmount: 0n,
      burn: quote.burn,
      issuanceOwnerCommitment: issuance.ownerCommitment,
      designatedIssuanceOpening,
      dummyInputEntropy,
      validUntilTimestamp,
      carrierContextHash,
      ...(params.accountCreation === undefined ? {} : { accountCreation: params.accountCreation }),
      outputEntropies: [randomFieldEntropy()],
      accountIndex: safeIndex(snapshot.account.account.index, "account state commitment index"),
      accountSiblings: snapshot.account.accountSiblings,
      recipientReceiveKey: receiveKey,
    });
    const proof = await prover.proveTransfer({
      authorizationWitnessMap: witness({
        recentPcashBlockHash: transfer.recentPcashBlockHash,
        address: transfer.address,
        transaction: transfer.transaction,
        payoutNoteSecret: transfer.outputNoteSecrets[0],
      }),
      buildKernelWitnessMap: transfer.buildKernelWitnessMap,
      expectedPublicInputs: transfer.publicInputs,
      authorizationCircuitUrl: MARKETPLACE_CIRCUITS.claim,
      authorizationLabel: "claim circuit",
    }, params.onStatus);
    return transactionIdentity(transfer.encodeTransaction(proof.proof));
  }

  const build = buildUnsponsoredTokenEscrowRelease({
    pcashChainId,
    l2Contract: material.l2Contract,
    selector: material.claim.selector,
    contractAccount: snapshot.account,
    escrow: { ...escrow, siblings: snapshot.escrowSiblings },
    assetDefinition: publicationAssetDefinition(params.offer)!,
    payout: { recipientAddress: params.buyer.address, receiveKey },
    issuanceOwnerCommitment: issuance.ownerCommitment,
    designatedIssuanceOpening,
    validUntilTimestamp,
    carrierContextHash,
    ...(params.accountCreation === undefined ? {} : { accountCreation: params.accountCreation }),
    dummyInputSeed: dummyInputEntropy,
  });
  const proof = await prover.proveAssetAction({
    operation: "transfer",
    authorization: {
      circuitUrl: MARKETPLACE_CIRCUITS.claim,
      witnessMap: witness({
        recentPcashBlockHash: build.recentPcashBlockHash,
        address: build.address,
        transaction: build.transaction,
        payoutNoteSecret: build.outputNoteSecrets[ESCROW_PAYOUT_SLOT]!,
      }),
      label: "claim circuit",
    },
    buildKernelWitnessMap: build.buildKernelWitnessMap,
    expectedPublicInputs: build.publicInputs,
  }, params.onStatus);
  return transactionIdentity(build.encodeTransaction(proof.proof));
}

/** The router's batch for one claim, framed with the self-publication header that names the buyer as poster. */
export function claimBatch(
  status: Pick<StatusResult, "acceptedBatchVersions">,
  buyer: Pick<PcashProfile, "address" | "nkRoot">,
  transactionHex: Hex,
): Hex {
  const poster = posterPayoutOpening(buyer.address, buyer.nkRoot, randomFieldEntropy());
  return toHex(encodeBatchForVersion([hexToBytes(transactionHex)], selectBatchVersion(status), poster.ownerCommitment, poster.context));
}

/** The carrier context of the router's `PcashBatch` for this payment, as the node takes it. */
export function paymentCarrier(offer: OfferPublication, commitment: Hex): Extract<CarrierContextInput, { kind: "event" }> {
  const terms = publicationTerms(offer);
  return {
    kind: "event",
    address: addressHex(terms.router),
    context: hexToBytes(paymentCarrierContext(terms, BigInt(commitment))),
  };
}

/** The node's dry run would not admit and execute the claim successfully. */
export class ClaimCheckError extends Error {
  readonly outcome: string;
  constructor(outcome: string) {
    super(`the claim would not succeed: ${outcome}`);
    this.name = "ClaimCheckError";
    this.outcome = outcome;
  }
}

/**
 * Dry-run exact claim bytes as the router's event would deliver them in the next
 * block. Anything but success throws `ClaimCheckError`, so no router call
 * carries a claim the node already rejects.
 */
export async function checkCarriedClaim(
  node: Pick<PcashNodeClient, "checkRawTransaction">,
  transactionHex: Hex,
  offer: OfferPublication,
  commitment: Hex,
): Promise<void> {
  const result = await node.checkRawTransaction(hexToBytes(transactionHex), paymentCarrier(offer, commitment));
  if (result.outcome !== "succeeded") throw new ClaimCheckError(result.outcome);
}

/** The transaction that spent a paid listing's escrow note. */
export interface EscrowSpend {
  contentHash: string;
  /** The Ethereum block that included it. */
  l1BlockNumber: bigint;
  /**
   * The claim for the payment `commitment` names: it executed by T, which only
   * a claim can, and required the router's carrier context for that payment.
   * A spend that is not ours is the seller's reclaim after T, which may carry
   * any context, or another buyer's claim on a branch that replaced this
   * buyer's payment.
   */
  ours: boolean;
}

/**
 * The transaction that spent this paid listing's escrow note, or null while it
 * is unspent. The spender is this purchase's claim, whichever call carried it,
 * exactly when it executed by T, since a reclaim executes only after T, and its
 * `carrierContextHash` is the router's carrier context for the payment that
 * `commitment` names.
 */
export async function readEscrowSpend(
  node: Pick<PcashNodeClient, "getTransactionByNullifier">,
  offer: OfferPublication,
  commitment: Hex,
): Promise<EscrowSpend | null> {
  const spender = await node.getTransactionByNullifier(escrowCommitments(offer, offer.escrow!).nullifier);
  if (spender === null) return null;
  const transaction = decodeTransaction(hexToBytes(spender.rawTransaction as Hex));
  return {
    contentHash: spender.summary.contentHash.toLowerCase(),
    l1BlockNumber: spender.summary.inclusion.l1BlockNumber,
    ours: spender.summary.timestamp <= BigInt(offer.terms.deadlineT)
      && transaction.kind === TX_KIND_PRIVATE_VALUE
      && sectionPublicInput(transaction, privateValueProfile(transaction.shape).offsets.carrierContextHash)
        === paymentCarrierContextHash(publicationTerms(offer), BigInt(commitment)),
  };
}

/** A fixed canonical PCASH block below which a missing record is absent. */
interface RecordBoundary {
  number: bigint;
  hash: string;
}

/** No absence decision within the attempt cap: the node has not derived or indexed the boundary block yet. */
export class RecordUnsettledError extends Error {
  constructor() {
    super("the node has not yet derived and indexed the block that settles whether the record exists");
    this.name = "RecordUnsettledError";
  }
}

/**
 * Find a record, or establish that none exists at or below a fixed canonical
 * block. The boundary is the first canonical head observed whose Ethereum
 * origin is at or after `l1BlockNumber`, so it holds anything that Ethereum
 * block carried; it stays fixed while the head moves. `find` reads the record
 * after each status read. A missing record is absent once the derived index
 * has reached the boundary and the boundary is still canonical; a boundary
 * reorged out is captured again. Throws `RecordUnsettledError` after
 * `maxAttempts` reads without a decision.
 */
export async function awaitRecordOrAbsence<T>(params: {
  node: Pick<PcashNodeClient, "status" | "getBlock">;
  find: () => Promise<T | null>;
  l1BlockNumber: bigint;
  pollIntervalMs?: number;
  maxAttempts?: number;
}): Promise<T | null> {
  const pollIntervalMs = params.pollIntervalMs ?? 3_000;
  const maxAttempts = params.maxAttempts ?? 300;
  let boundary: RecordBoundary | undefined;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const status = await params.node.status();
    // PCASH block N is derived from Ethereum block genesisL1Block + N.
    if (boundary === undefined && status.genesisL1Block + status.latestBlock >= params.l1BlockNumber) {
      boundary = { number: status.latestBlock, hash: status.latestBlockHash };
    }
    const found = await params.find();
    if (found !== null) return found;
    if (boundary !== undefined && status.index.cursor !== null && status.index.cursor.blockNumber >= boundary.number) {
      if ((await params.node.getBlock(boundary.number))?.hash === boundary.hash) return null;
      boundary = undefined;
      continue;
    }
    if (attempt + 1 < maxAttempts) await sleep(pollIntervalMs);
  }
  throw new RecordUnsettledError();
}

/** Read whether the claim for the payment `commitment` names landed, and whether its inclusion is final. */
export async function readPurchaseClaimFinality(
  node: PcashNodeClient,
  offer: OfferPublication,
  commitment: Hex,
): Promise<ClaimTxFinality> {
  const spend = await readEscrowSpend(node, offer, commitment);
  if (spend === null || !spend.ours) return { phase: "missing" };
  const status = await node.status();
  return {
    phase: isFinalized(spend.l1BlockNumber, status) ? "finalized" : "accepted",
    contentHash: spend.contentHash,
    acceptedBlock: spend.l1BlockNumber,
  };
}
