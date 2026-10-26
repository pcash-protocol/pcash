import { registeredSelfReceiveKey } from "./selfDelivery.ts";
// Sponsored Contract Account asset action (spec §11.7): this wallet pays the
// open fee or the selected relay output of one contract's asset action from its
// own native notes. The contract's installed function authorizes the contract's
// side; this wallet's contract-fee-sponsorship rule authorizes only its fee,
// relay payment, and change. The payment is journaled like any other
// note-spending action, so its inputs stay reserved until the action settles.

import type { SelectedRelayQuoteProvider } from "@pcash/sdk/eip712";
import { requestPcashAuthorization, type PcashActionSigner } from "@pcash/sdk/eip712";
import { formatUnits } from "viem";
import {
  buildAssetAction,
  assetActionInputNullifiers,
  buildSponsoredTransferWitness,
  openedAssetActionOutput,
  prepareContractFeeSponsorshipAuthorization,
  snapshotFromAccountProof,
  type AccountProofSnapshot,
  type AssetAccountAuthorization,
  type AssetActionBuild,
  type AssetActionInput,
  type AssetActionOutput,
  type AssetSnapshot,
  type WitnessMap,
} from "@pcash/sdk/builders";
import type {
  AccountProofResult,
  OutputLeafPath,
  PcashNodeClient,
  StatusResult,
  WitnessSnapshotQuery,
  WitnessSnapshotResult,
} from "@pcash/sdk/clients";
import {
  transactionIdentity,
  networkConfigFromStatus,
  noteNk,
  ownerChangeNoteSecret,
  ownerCommitment,
  SlotClass,
  type DesignatedIssuanceOpening,
} from "@pcash/sdk/protocol";
import { ACCOUNT_KIND_USER, PRIVATE_VALUE_PROFILES } from "@pcash/sdk/constants";
import { addressHex, bytes32Hex, randomFieldEntropy } from "@pcash/sdk/utils";
import { CIRCUIT_URLS, type AssetProver } from "@pcash/sdk/browser-prover/requests";
import type { DurableSubmissionAdapter, DurableSubmissionCallbacks, SettlePollOptions } from "./durableSubmission.ts";
import { settlePollOptions } from "./durableSubmission.ts";
import { submitPreparedAssetAction, type AssetActionSubmissionResult } from "./assetActionClient.ts";
import { loadReceiveKeyAtSnapshot } from "./localChain.ts";
import {
  actionPublication,
  fixPublication,
  paddedPrivateValueByteSize,
  planPublication,
  publicationOf,
  publicationValidUntil,
  resolvePublicationFunding,
  type ActionPublication,
} from "./publication.ts";
import { reconcilePendingWalletActions } from "./clientReconciliation.ts";
import { localWitnessSnapshot } from "./localChain.ts";
import { retryWhileSyncConflict } from "./syncConflictRetry.ts";
import { WalletSyncRequiredError } from "../chainState.ts";
import { assertWalletStoreMatches } from "./walletSession.ts";
import { assertPcashProfileMatchesAccount, type PcashProfile } from "../externalIdentity.ts";
import { InsufficientNotesError, selectInputNotes, type PendingAssetAction, type WalletNote } from "../noteStore.ts";
import { directSendsToRecord } from "../directSends.ts";
import type { WalletStateStore } from "../store.ts";

/** One consistent snapshot the contract's side of the action is built from. */
export interface SponsoredContractAssetActionContext {
  status: StatusResult;
  /** A recipient's receive key from the account set of this action's snapshot. */
  receiveKeyOf(address: string): Promise<Uint8Array | null>;
  /** The sponsor's registered owned receive key in this action's snapshot. */
  selfReceiveKey(): Uint8Array;
  /** The node's snapshot: the contract's account, then the application's own reads. */
  snapshot: WitnessSnapshotResult;
  /** Block-header-proved roots of that snapshot. */
  roots: AssetSnapshot;
  /** The primary Contract Account's opening in that snapshot. */
  contractAccount: Extract<AccountProofResult, { status: "present" }>;
  /** Paths for `snapshotQuery.outputs`, in request order. */
  outputPaths: readonly OutputLeafPath[];
}

/** The contract's side of the action, placed in the slots it reserved. */
export interface SponsoredContractAssetActionPrimary {
  /** The authenticated contract account and its selected function. */
  authorization: AssetAccountAuthorization;
  assetId: bigint;
  /** Contract-owned asset inputs and application markers, by input slot. */
  inputs: readonly { slot: number; input: Extract<AssetActionInput, { kind: "asset" | "application" }> }[];
  /** Realize encrypted outputs once for these exact final nullifiers and retain their owned openings. */
  realizeOutputs(nullifiers: readonly bigint[]): {
    outputs: readonly { slot: number; output: AssetActionOutput }[];
    ownedOutputs: readonly { slot: number; noteSecret: bigint }[];
  };
  /** The contract function's application circuit. */
  circuitUrl: string;
  label: string;
  /**
   * The function's witness over the finished action, returning the primary
   * fee-payer statement. A designated issuance route comes with its opening.
   */
  witness(
    build: AssetActionBuild,
    issuance: { designatedIssuanceOpening?: DesignatedIssuanceOpening },
  ): WitnessMap | Promise<WitnessMap>;
}

export interface SponsoredContractAssetActionIntent extends DurableSubmissionCallbacks {
  accountCreation?: import("@pcash/sdk/protocol").AccountCreationAttachment;
  /** The Contract Account whose asset action this wallet sponsors. */
  contract: bigint;
  /** Input and output slots the contract's side occupies; this wallet fills the rest. */
  reservedInputSlots: readonly number[];
  reservedOutputSlots: readonly number[];
  /** Application reads that must share the action's snapshot. */
  snapshotQuery?: Pick<WitnessSnapshotQuery, "outputs" | "l1Logs" | "nullifiers"> & { accounts?: readonly string[] };
  primary(context: SponsoredContractAssetActionContext): SponsoredContractAssetActionPrimary | Promise<SponsoredContractAssetActionPrimary>;
  /** Proves with the contract function's pinned circuit and the protocol sponsored-transfer stack. */
  prover: AssetProver;
  /** Absent selects the node's estimate; a sponsored action always pays a positive fee. */
  openFeeAmount?: bigint;
  privateRelayFeeAmount?: bigint;
  selectedRelayQuote?: SelectedRelayQuoteProvider;
  /** Exact note commitment (0x-hex) or array index to spend for the fee. */
  noteSelector?: string;
  notBeforeTimestamp?: bigint;
  validUntilTimestamp?: bigint;
  validUntilMode?: "exact" | "ceiling";
  /** The requested destination of a bearer claim, bound to durable retries. */
  claimLinkRecipient?: bigint;
}

export interface SponsoredContractAssetActionClientParams<Prepared = unknown, Output = unknown>
  extends SponsoredContractAssetActionIntent, SettlePollOptions {
  node: PcashNodeClient;
  store: WalletStateStore;
  wallet: PcashProfile;
  signer: PcashActionSigner;
  chainId: bigint;
  submission: DurableSubmissionAdapter<Prepared, Output>;
  status?: StatusResult;
}

export interface SponsoredContractAssetActionResult<Output = unknown> extends AssetActionSubmissionResult<Output> {
  /** The exact action, so the application can recover its own outputs. */
  build: AssetActionBuild;
  openFeeAmount: bigint;
  changeAmount: bigint;
  publicationDetails: ActionPublication;
}

const DEFAULT_VALIDITY_WINDOW = 1_800n;
const SHAPE = PRIVATE_VALUE_PROFILES.S;

function freeSlots(count: number, reserved: readonly number[], label: string): number[] {
  const taken = new Set(reserved);
  if (taken.size !== reserved.length || reserved.some((slot) => !Number.isInteger(slot) || slot < 0 || slot >= count)) {
    throw new Error(`reserved ${label} slots must be distinct and within the S profile`);
  }
  return Array.from({ length: count }, (_, slot) => slot).filter((slot) => !taken.has(slot));
}

/**
 * The sponsor's account opening and fee-note paths from the local chain state,
 * which must be at the node snapshot's account and output roots. A wallet
 * behind the snapshot synchronizes once, waiting out a synchronization that
 * already holds the wallet's sync lease.
 */
async function localSponsorWitnesses(
  params: Pick<SponsoredContractAssetActionClientParams, "store" | "wallet" | "synchronize">,
  feeNotes: readonly WalletNote[],
  roots: AccountProofSnapshot,
): Promise<{ sponsorAccount: Extract<AccountProofResult, { status: "present" }>; feePaths: readonly OutputLeafPath[] }> {
  const address = addressHex(params.wallet.address);
  const read = async () => {
    const local = await localWitnessSnapshot(params.store, {
      accounts: [address], outputs: feeNotes.map((note) => ({ outputIndex: BigInt(note.leafIndex!) })),
    });
    const { state } = local.blockHeader.boundary;
    return state.accountStateRoot === roots.accountStateRoot && state.outputRoot === roots.outputRoot ? local : undefined;
  };
  let local = await read();
  if (local === undefined && params.synchronize !== undefined) {
    await retryWhileSyncConflict(params.synchronize);
    local = await read();
  }
  if (local === undefined) {
    throw new WalletSyncRequiredError("wallet chain state differs from the sponsored action's snapshot; retry this action");
  }
  const sponsorAccount = local.accounts[0]!;
  if (sponsorAccount.status !== "present") throw new Error(`sponsor ${address} has no authenticated account`);
  return { sponsorAccount, feePaths: local.outputs!.paths };
}

export async function runSponsoredContractAssetActionClient<Prepared, Output>(
  params: SponsoredContractAssetActionClientParams<Prepared, Output>,
): Promise<SponsoredContractAssetActionResult<Output>> {
  const initialStatus = params.status ?? await params.node.status();
  assertWalletStoreMatches(params.store, params.wallet, params.chainId, initialStatus);
  const data = await params.store.load();
  if (data === null) throw new Error("wallet state is required to sponsor a contract action");
  if (await params.store.readChain((chain) => reconcilePendingWalletActions(data, chain, initialStatus))) await params.store.save(data);

  const freeInputs = freeSlots(SHAPE.inputs, params.reservedInputSlots, "input");
  const freeOutputs = freeSlots(SHAPE.outputs, params.reservedOutputSlots, "output");
  const relaySlot = SHAPE.outputs - 1;
  const publication = publicationOf(params.submission, params.privateRelayFeeAmount ?? 0n);
  if (publication === "self") {
    throw new Error("a self-published contract action pays no fee; publish it in the contract's transfer role");
  }
  let plan = await planPublication({
    qualifying: true,
    byteSize: paddedPrivateValueByteSize(SHAPE.shapeId, params.accountCreation),
    openFeeAmount: params.openFeeAmount,
    privateRelayFeeAmount: params.privateRelayFeeAmount,
    publication,
    selectedRelayQuote: params.selectedRelayQuote,
    node: params.node,
  });
  if (plan.openFeeAmount + plan.privateRelayFeeAmount === 0n) {
    throw new Error("a zero-fee contract action spends no sponsor notes; publish it in the contract's transfer role");
  }
  if (plan.privateRelayFeeAmount > 0n && !freeOutputs.includes(relaySlot)) {
    throw new Error(`a selected relay payment needs free output slot ${relaySlot}`);
  }

  let feeNotes: WalletNote[];
  try {
    const resolved = resolvePublicationFunding(plan,
      (fee) => selectInputNotes(data, params.noteSelector, fee, freeInputs.length));
    plan = resolved.plan;
    feeNotes = resolved.funding;
  } catch (cause) {
    if (!(cause instanceof InsufficientNotesError)) throw cause;
    const fee = plan.openFeeAmount + plan.privateRelayFeeAmount;
    throw new Error(
      `Sponsoring this action needs ${formatUnits(fee, 18)} PCASH in spendable notes, `
      + `but only ${formatUnits(cause.maximumTransfer, 18)} PCASH in notes can be used.`,
      { cause },
    );
  }
  const feeTotal = feeNotes.reduce((sum, note) => sum + BigInt(note.amount), 0n);
  const changeAmount = feeTotal - plan.openFeeAmount - plan.privateRelayFeeAmount;
  const changeSlot = changeAmount === 0n ? undefined : freeOutputs.find((slot) => slot !== relaySlot || plan.privateRelayFeeAmount === 0n);
  if (changeAmount !== 0n && changeSlot === undefined) throw new Error("no free output slot for the sponsor's change");

  const applicationOutputs = params.snapshotQuery?.outputs ?? [];
  // The node reads only the contract and the application's openings. The
  // sponsor's account and fee notes open from the local chain state at the
  // same roots, so the request names neither.
  const snapshot = await params.node.getWitnessSnapshot({
    accounts: [addressHex(params.contract), ...(params.snapshotQuery?.accounts ?? [])],
    outputs: applicationOutputs,
    ...(params.snapshotQuery?.nullifiers === undefined ? {} : { nullifiers: params.snapshotQuery.nullifiers }),
    ...(params.snapshotQuery?.l1Logs === undefined ? {} : { l1Logs: params.snapshotQuery.l1Logs }),
  });
  const status = snapshot.status;
  assertWalletStoreMatches(params.store, params.wallet, params.chainId, status);
  const contractAccount = snapshot.accounts[0]!;
  if (contractAccount.status !== "present") throw new Error(`contract ${addressHex(params.contract)} has no authenticated account`);
  if (applicationOutputs.length > 0 && snapshot.outputs === null) throw new Error("an action input is not in the current output tree");
  const roots = snapshotFromAccountProof(contractAccount);
  const { sponsorAccount, feePaths } = await localSponsorWitnesses(params, feeNotes, roots);
  const network = networkConfigFromStatus(status);
  const rules = assertPcashProfileMatchesAccount(params.wallet, sponsorAccount.account, network);
  const feePayer: AssetAccountAuthorization = {
    address: params.wallet.address,
    nkRoot: params.wallet.nkRoot,
    accountIndex: Number(sponsorAccount.account.index),
    accountSiblings: sponsorAccount.accountSiblings,
    accountRuleSetCommitment: rules.accountRuleSetCommitment,
    accountKind: ACCOUNT_KIND_USER,
    accountRevision: sponsorAccount.account.accountRevision,
    receiveKeyHash: BigInt(sponsorAccount.account.receiveKeyHash),
    rule: rules.contractFeeSponsorshipRule,
  };
  let resolvedSelfReceiveKey: Uint8Array | undefined;
  const selfReceiveKey = () => resolvedSelfReceiveKey ??= registeredSelfReceiveKey(sponsorAccount.account, data);
  const primary = await params.primary({
    status,
    receiveKeyOf: (address) => loadReceiveKeyAtSnapshot(params.store, address, roots.accountStateRoot, params.synchronize),
    selfReceiveKey,
    snapshot,
    roots,
    contractAccount,
    outputPaths: snapshot.outputs?.paths ?? [],
  });
  const usedInputs = primary.inputs.map((entry) => entry.slot);
  if (new Set(usedInputs).size !== usedInputs.length || usedInputs.some((slot) => !params.reservedInputSlots.includes(slot))) {
    throw new Error("the contract's side uses a slot it did not reserve");
  }

  const nativeInputs = feeNotes.map((note, index) => ({
    slot: freeInputs[index]!,
    noteSecret: BigInt(note.noteSecret),
    amount: BigInt(note.amount),
    leafIndex: Number(note.leafIndex!),
    siblings: feePaths[index]!.siblings,
  }));
  const inputs: AssetActionInput[] = Array.from({ length: SHAPE.inputs }, () => ({ kind: "dummy" }));
  for (const entry of primary.inputs) inputs[entry.slot] = entry.input;
  for (const input of nativeInputs) {
    inputs[input.slot] = {
      kind: "native", amount: input.amount, noteSecret: input.noteSecret, leafIndex: input.leafIndex,
      siblings: input.siblings, owner: params.wallet.address, nk: noteNk(params.wallet.nkRoot),
    };
  }
  const receiveKey = changeAmount === 0n ? undefined : selfReceiveKey();
  const dummyInputSeed = randomFieldEntropy();
  const nullifiers = assetActionInputNullifiers({
    owner: primary.authorization,
    assetId: primary.assetId,
    inputs,
    dummyInputSeed,
    nativeFeePayer: true,
  });
  // The sponsorship rule accepts change only under the sponsor's derived secret.
  const changeSecret = changeSlot === undefined ? 0n
    : ownerChangeNoteSecret(params.wallet.nkRoot, nullifiers, changeSlot, SHAPE.shapeId);
  const { outputs: primaryOutputs, ownedOutputs: owned } = primary.realizeOutputs(nullifiers);
  const usedOutputs = primaryOutputs.map((entry) => entry.slot);
  if (new Set(usedOutputs).size !== usedOutputs.length || usedOutputs.some((slot) => !params.reservedOutputSlots.includes(slot))) {
    throw new Error("the contract's side uses a slot it did not reserve");
  }
  const chainNow = status.latestBlockTimestamp;
  const validUntilTimestamp = publicationValidUntil({
    chainNow, defaultWindow: DEFAULT_VALIDITY_WINDOW, selectedRelayQuote: params.selectedRelayQuote,
    requested: params.validUntilTimestamp, requestedMode: params.validUntilMode, action: "sponsored contract action",
  });
  const build = (
    relay: { amount: bigint; recipientAddress: bigint; receiveKey: Uint8Array; noteSecret: bigint } | undefined,
    issuance: { issuanceOwnerCommitment: bigint; designatedIssuanceOpening?: DesignatedIssuanceOpening },
  ): AssetActionBuild => {
    const outputs: AssetActionOutput[] = Array.from({ length: SHAPE.outputs }, () => ({
      kind: "dummy", dummySecret: randomFieldEntropy(), amount: 0n,
    }));
    for (const entry of primaryOutputs) outputs[entry.slot] = entry.output;
    if (changeSlot !== undefined) {
      outputs[changeSlot] = openedAssetActionOutput({
        kind: "native", pcashChainId: params.chainId, assetId: 0n, outputIndex: changeSlot, noteSecret: changeSecret,
        amount: changeAmount, recipientAddress: params.wallet.address, recipientMlKemPublicKey: receiveKey!,
        authenticatedRecipient: true, change: true,
      });
    }
    if (relay !== undefined) {
      outputs[relaySlot] = openedAssetActionOutput({
        kind: "native", pcashChainId: params.chainId, assetId: 0n, outputIndex: relaySlot, noteSecret: relay.noteSecret,
        amount: relay.amount, recipientAddress: relay.recipientAddress, recipientMlKemPublicKey: relay.receiveKey,
        authenticatedRecipient: true,
      });
    }
    return buildAssetAction({
      ...(params.accountCreation === undefined ? {} : { accountCreation: params.accountCreation }),
      shape: SHAPE.shapeId,
      pcashChainId: params.chainId,
      snapshot: roots,
      owner: primary.authorization,
      nativeFeePayer: true,
      assetId: primary.assetId,
      inputs,
      outputs,
      openFeeAmount: plan.openFeeAmount,
      ...(relay === undefined ? {} : {
        privateRelayPayment: { amount: relay.amount, ownerCommitment: ownerCommitment(relay.recipientAddress, relay.noteSecret) },
      }),
      issuanceOwnerCommitment: issuance.issuanceOwnerCommitment,
      ...(issuance.designatedIssuanceOpening === undefined ? {} : { designatedIssuanceOpening: issuance.designatedIssuanceOpening }),
      ...(params.notBeforeTimestamp === undefined ? {} : { notBeforeTimestamp: params.notBeforeTimestamp }),
      validUntilTimestamp,
      dummyInputSeed,
      sender: { outgoingKey: params.wallet.outgoingKey, directSendOpenings: directSendsToRecord(data, params.wallet.address, feeNotes) },
    });
  };
  // The input set and dummy seed fix nullifiers before recipient outputs exist.
  const fixed = await fixPublication({
    maxTransactionBytes: paddedPrivateValueByteSize(SHAPE.shapeId, params.accountCreation),
    selectedRelayQuote: params.selectedRelayQuote,
    publication,
    owner: params.wallet,
    requestedCommitment: 0n,
    node: params.node,
    status,
    nullifiers,
    shape: SHAPE.shapeId,
    openFeeAmount: plan.openFeeAmount,
    privateRelayFeeAmount: plan.privateRelayFeeAmount,
    validUntilTimestamp,
  });
  const relayPayment = fixed.privateRelayPayment === undefined ? undefined : {
    ...fixed.privateRelayPayment, noteSecret: randomFieldEntropy(),
  };
  const action = build(relayPayment, fixed);

  const relayOwnerCommitment = relayPayment === undefined ? undefined
    : ownerCommitment(relayPayment.recipientAddress, relayPayment.noteSecret);
  const nativeChange = changeSlot === undefined ? null : { slot: changeSlot, noteSecret: changeSecret, amount: changeAmount };
  const nativeRelayPayment = relayPayment === undefined ? undefined
    : { slot: relaySlot, amount: relayPayment.amount, ownerCommitment: relayOwnerCommitment! };
  const primaryWitness = await primary.witness(action, fixed.designatedIssuanceOpening === undefined
    ? {} : { designatedIssuanceOpening: fixed.designatedIssuanceOpening });
  const sponsorship = prepareContractFeeSponsorshipAuthorization({
    build: action,
    primary: primary.authorization,
    wallet: params.wallet,
    network,
    sponsoredContract: params.contract,
    ...(nativeRelayPayment === undefined ? {} : { nativeRelayPayment }),
    ...(fixed.designatedIssuanceOpening === undefined ? {} : { designatedIssuanceOpening: fixed.designatedIssuanceOpening }),
  });
  params.onProgress?.("preparing", "requesting the sponsorship signature…");
  const sponsorWitness = sponsorship.authorize(
    await requestPcashAuthorization(params.signer, sponsorship.request),
  ).witnessMap;
  params.onProgress?.("proving", "generating the sponsored contract action proof…");
  const proof = await params.prover.proveAssetAction({
    operation: "sponsored-transfer",
    primary: { circuitUrl: primary.circuitUrl, witnessMap: primaryWitness, label: primary.label },
    feePayer: {
      circuitUrl: CIRCUIT_URLS.account_rule_contract_fee_sponsorship_ecdsa,
      witnessMap: sponsorWitness,
      label: "contract fee sponsorship rule",
    },
    buildKernelWitnessMap: (primaryVk, feeVk) => buildSponsoredTransferWitness({
      build: action,
      snapshot: roots,
      pcashChainId: params.chainId,
      assetId: primary.assetId,
      primary: primary.authorization,
      feePayer,
      ...(nativeRelayPayment === undefined ? {} : { nativeRelayPayment }),
      primaryVk,
      feeVk,
    }).witnessMap,
    expectedPublicInputs: action.publicInputs,
  });
  const entry = action.encodeTransaction(proof.proof);
  const { contentHash, transactionHex } = transactionIdentity(entry);
  if (new Set(owned.map(({ slot }) => slot)).size !== owned.length) throw new Error("duplicate owned contract output slot");
  const ownedContractOutputs = owned.map(({ slot, noteSecret }) => {
    if (!usedOutputs.includes(slot) || action.transaction.outputs[slot]?.slotClass !== SlotClass.ASSET
      || action.outputNoteSecrets[slot] !== noteSecret
      || action.outputOwnerCommitments[slot] !== ownerCommitment(params.wallet.address, noteSecret)) {
      throw new Error(`contract output ${slot} does not open to the sponsor wallet`);
    }
    return {
      outputIndex: slot,
      assetId: `0x${primary.assetId.toString(16)}`,
      amount: action.outputAmounts[slot]!.toString(),
      owner: addressHex(params.wallet.address),
      noteSecret: bytes32Hex(noteSecret),
    };
  });
  const pending: PendingAssetAction = {
    contentHash,
    transactionHex,
    ...(params.claimLinkRecipient === undefined ? {} : { claimLinkRecipient: addressHex(params.claimLinkRecipient) }),
    assetId: bytes32Hex(0n),
    owner: addressHex(params.wallet.address),
    notBeforeTimestamp: (params.notBeforeTimestamp ?? 0n).toString(),
    validUntilTimestamp: validUntilTimestamp.toString(),
    openFeeAmount: plan.openFeeAmount.toString(),
    ...(relayPayment === undefined ? {} : {
      privateRelayFeeAmount: plan.privateRelayFeeAmount.toString(),
      privateRelayRecipient: addressHex(relayPayment.recipientAddress),
    }),
    issuanceOwnerCommitment: fixed.issuanceOwnerCommitment.toString(),
    ...(fixed.designatedIssuanceOpening === undefined ? {} : {
      issuanceRecipient: addressHex(BigInt(fixed.designatedIssuanceOpening.recipientAddress)),
    }),
    // Only this wallet's fee notes are its spends; the contract's inputs,
    // markers, and dummies reserve nothing here.
    inputs: action.transaction.inputs.map((input, slot) => {
      const index = nativeInputs.findIndex((native) => native.slot === slot);
      return {
        nullifier: bytes32Hex(BigInt(input.nullifier)),
        spentCommitment: index === -1 ? null : bytes32Hex(BigInt(feeNotes[index]!.commitment!)),
      };
    }),
    ownedOutputs: [...ownedContractOutputs, ...(nativeChange === null ? [] : [{
      outputIndex: nativeChange.slot,
      assetId: "0x0",
      amount: nativeChange.amount.toString(),
      owner: addressHex(params.wallet.address),
      noteSecret: bytes32Hex(nativeChange.noteSecret),
    }])],
  };
  const preparedSubmission = await params.submission.preflight({ transactionBytes: entry, status, retry: false });
  const outcome = await submitPreparedAssetAction({
    node: params.node,
    store: params.store,
    data,
    status,
    preparedAction: { transactionBytes: entry, pending },
    submission: params.submission,
    preparedSubmission,
    callbacks: params,
    ...settlePollOptions(params),
  });
  return {
    ...outcome,
    build: action,
    openFeeAmount: plan.openFeeAmount,
    changeAmount,
    publicationDetails: actionPublication(pending, plan.beneficiary),
  };
}
