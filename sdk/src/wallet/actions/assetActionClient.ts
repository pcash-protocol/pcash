// Durable submission for an already-proved standard asset action. This module
// owns the wallet invariants that begin once exact type-0 bytes exist.

import { privateValueProfile, PRIVATE_VALUE_PROFILES, type PrivateValueShape } from "@pcash/sdk/constants";
import { addressHex, bytes32Hex } from "@pcash/sdk/utils";
import { acceptedReceiptOfKind } from "./walletSession.ts";
import {
  snapshotFromAccountProof,
  type AssetActionBuild,
  type AssetAuthorizationKind,
  type AssetAccountAuthorization,
  type AssetSnapshot,
} from "@pcash/sdk/builders";
import {
  decodeTransaction,
  networkConfigFromStatus,
  privateValuePublicInputs,
  TX_KIND_PRIVATE_VALUE,
  type AssetDefinition,
  type DesignatedIssuanceOpening,
} from "@pcash/sdk/protocol";
import {
  submitDurableAction,
  type DurableSubmissionAdapter,
  type DurableSubmissionCallbacks,
  type DurableSubmissionOutcome,
  settlePollOptions,
  type SettlePollOptions,
} from "./durableSubmission.ts";
import { transactionIdentity } from "@pcash/sdk/protocol";
import { noteBodyCommitment, ownerCommitment } from "@pcash/sdk/protocol";
import {
  addPendingAssetAction,
  addPendingNote,
  addWalletAsset,
  assertPendingAssetActionBelongsToWallet,
  removePendingAssetAction,
  removePendingNotesForTransaction,
  removeWalletAsset,
  type PendingAssetAction,
  type WalletFileData,
} from "../noteStore.ts";
import type { AccountResult, PcashNodeClient, StatusResult } from "@pcash/sdk/clients";
import { localWitnessSnapshot, locallySpent } from "./localChain.ts";
import { SlotClass } from "@pcash/sdk/protocol";
import type { WalletStateStore } from "../store.ts";
import { assetActionInputResources, withWalletReservation } from "../reservations.ts";
import type { PcashProfile } from "../externalIdentity.ts";
import { assertPcashProfileMatchesAccount, assertPcashProfileMatchesAccountIdentity } from "../externalIdentity.ts";
import type { DefaultUserAccountRuleSet } from "@pcash/sdk/rules";
import { assertWalletStoreMatches } from "./walletSession.ts";

export interface OwnedAssetActionOutput {
  outputIndex: number;
  assetId: bigint;
  amount: bigint;
  owner: bigint;
  noteSecret: bigint;
}

export interface PreparedAssetAction {
  transactionBytes: Uint8Array;
  pending: PendingAssetAction;
}

/** Proves an asset action through the transfer kernel under the installed rule its owner authorization selected. */
export interface AssetActionProver {
  /** The shapes this prover can prove; a bulk job plans chunks only in these. */
  readonly shapes: readonly PrivateValueShape[];
  proveAndEncode(build: AssetActionBuild, authorization: { packageName: string; witnessMap: Record<string, unknown> }): Promise<Uint8Array>;
}

export interface PrepareAssetActionParams {
  build: AssetActionBuild;
  transactionBytes: Uint8Array;
  ownedOutputs?: readonly OwnedAssetActionOutput[];
  /** The opening of a designated destination; absent on the open route. */
  designatedIssuanceOpening?: DesignatedIssuanceOpening;
  privateRelayFeeAmount?: bigint;
  privateRelayRecipient?: bigint;
}

export interface AssetActionInputOpeningRequest {
  outputIndex: bigint;
  outputCommitment: bigint;
}

/** An installed owner rule other than the reference wallet's default full ECDSA rule. */
export interface AssetActionOwnerRuleOpening {
  configurationCommitment: bigint;
  commitmentBlinder: bigint;
  entryIndex: number;
  siblings: readonly bigint[];
}

export interface AssetActionWitnesses {
  status: StatusResult;
  account: AccountResult;
  snapshot: AssetSnapshot;
  owner: AssetAccountAuthorization;
  /** Paths for inputOpenings, in the same order. */
  inputSiblings: bigint[][];
  /** Recipients' receive keys from the account set `snapshot` opens against. */
  receiveKeyOf: (address: string) => Promise<Uint8Array | null>;
}

/** Collect the initiating account and optional note inputs at one canonical boundary. */
export async function collectAssetActionWitnesses(params: {
  node: PcashNodeClient;
  store: WalletStateStore;
  wallet: PcashProfile;
  authorizationKind: AssetAuthorizationKind;
  shape?: PrivateValueShape;
  inputOpenings: readonly AssetActionInputOpeningRequest[];
  ownerRule?: AssetActionOwnerRuleOpening;
}): Promise<AssetActionWitnesses> {
  const status = await params.node.status();
  const snapshot = await localWitnessSnapshot(params.store, {
    accounts: [addressHex(params.wallet.address)], outputs: params.inputOpenings,
  });
  assertWalletStoreMatches(params.store, params.wallet, BigInt(status.pcashChainId), status);
  const accountPath = snapshot.accounts[0]!;
  if (accountPath.status !== "present") throw new Error("asset action requires an existing account");
  const value = { accountPath, outputPaths: snapshot.outputs };
  let defaultRules: DefaultUserAccountRuleSet | null = null;
  if (params.ownerRule === undefined) {
    defaultRules = assertPcashProfileMatchesAccount(params.wallet, value.accountPath.account, networkConfigFromStatus(status));
  } else {
    assertPcashProfileMatchesAccountIdentity(params.wallet, value.accountPath.account);
  }
  const defaultSelectedRule = defaultRules === null ? null : (params.shape === PRIVATE_VALUE_PROFILES.L.shapeId
    ? params.authorizationKind === "asset-creation" ? defaultRules!.largeAssetCreationRule : defaultRules!.largeBatchTransferRule
    : (
    params.authorizationKind === "asset-creation"
      ? defaultRules!.assetCreationRule
      : params.authorizationKind === "asset-payment"
      ? defaultRules!.assetPaymentRule
      : params.authorizationKind === "asset-burn"
        ? defaultRules!.assetBurnRule
        : defaultRules!.batchTransferRule
  ));
  const selectedRule = params.ownerRule ?? defaultSelectedRule!;
  const accountRuleSetCommitment = BigInt(value.accountPath.account.accountRuleSetCommitment);
  return {
    status,
    account: value.accountPath.account,
    snapshot: snapshotFromAccountProof(value.accountPath),
    owner: {
      address: params.wallet.address,
      nkRoot: params.wallet.nkRoot,
      accountIndex: Number(value.accountPath.account.index),
      accountSiblings: value.accountPath.accountSiblings,
      accountRuleSetCommitment,
      accountKind: BigInt(value.accountPath.account.accountKind),
      accountRevision: value.accountPath.account.accountRevision,
      receiveKeyHash: BigInt(value.accountPath.account.receiveKeyHash),
      rule: selectedRule,
    },
    inputSiblings: (value.outputPaths?.paths ?? [])
      .slice(0, params.inputOpenings.length)
      .map((path) => path.siblings),
    receiveKeyOf: snapshot.receiveKeyOf,
  };
}

/**
 * Validate exact wire bytes against the built statement and construct the
 * durable reservation row. A real output opening is retained only after its
 * body matches the proof-bound output position.
 */
export function prepareAssetAction(params: PrepareAssetActionParams): PreparedAssetAction {
  const decoded = decodeTransaction(params.transactionBytes);
  if (decoded.kind !== TX_KIND_PRIVATE_VALUE) throw new Error("asset action must use type 0x00");
  const profile = privateValueProfile(decoded.shape);
  const publicInputs = privateValuePublicInputs(decoded);
  if (
    publicInputs.length !== params.build.publicInputs.length
    || publicInputs.some((value, index) => value !== params.build.publicInputs[index])
  ) {
    throw new Error("asset action bytes do not match the built verifier statement");
  }
  const openFeeAmount = BigInt(params.build.transaction.global.openFeeAmount);
  const ownedOutputs = (params.ownedOutputs ?? []).map((output) => {
    if (!Number.isInteger(output.outputIndex) || output.outputIndex < 0 || output.outputIndex >= profile.outputs) {
      throw new Error(`owned asset output index must be in 0..${profile.outputs - 1}`);
    }
    const transactionOutput = params.build.transaction.outputs[output.outputIndex]!;
    const expectedClass = output.assetId === 0n ? SlotClass.NATIVE : SlotClass.ASSET;
    if (transactionOutput.slotClass !== expectedClass) {
      throw new Error(`owned output ${output.outputIndex} has the wrong asset namespace`);
    }
    if (output.assetId !== 0n && output.assetId !== params.build.assetId) {
      throw new Error(`owned output ${output.outputIndex} has a foreign assetId`);
    }
    if (output.amount <= 0n) throw new Error(`owned output ${output.outputIndex} amount must be positive`);
    const expectedBody = params.build.publicInputs[profile.offsets.outputs + output.outputIndex]!;
    if (noteBodyCommitment(ownerCommitment(output.owner, output.noteSecret), output.assetId, output.amount) !== expectedBody) {
      throw new Error(`owned output ${output.outputIndex} opening does not match the action`);
    }
    return {
      outputIndex: output.outputIndex,
      assetId: bytes32Hex(output.assetId),
      amount: output.amount.toString(),
      owner: addressHex(output.owner),
      noteSecret: bytes32Hex(output.noteSecret),
    };
  });
  if (new Set(ownedOutputs.map((output) => output.outputIndex)).size !== ownedOutputs.length) {
    throw new Error("owned asset outputs contain a duplicate position");
  }

  const { contentHash, transactionHex } = transactionIdentity(params.transactionBytes);
  const pending: PendingAssetAction = {
    contentHash,
    transactionHex,
    assetId: bytes32Hex(params.build.assetId),
    owner: addressHex(params.build.address),
    notBeforeTimestamp: BigInt(params.build.transaction.global.notBeforeTimestamp).toString(),
    validUntilTimestamp: BigInt(params.build.transaction.global.validUntilTimestamp).toString(),
    openFeeAmount: openFeeAmount.toString(),
    ...(params.privateRelayRecipient === undefined ? {} : {
      privateRelayFeeAmount: (params.privateRelayFeeAmount ?? 0n).toString(),
      privateRelayRecipient: addressHex(params.privateRelayRecipient),
    }),
    issuanceOwnerCommitment: BigInt(params.build.transaction.global.issuanceOwnerCommitment).toString(),
    ...(params.designatedIssuanceOpening === undefined ? {} : {
      issuanceRecipient: addressHex(BigInt(params.designatedIssuanceOpening.recipientAddress)),
    }),
    inputs: params.build.transaction.inputs.map((input) => ({
      nullifier: bytes32Hex(BigInt(input.nullifier)),
      spentCommitment:
        input.slotClass === SlotClass.ASSET || input.slotClass === SlotClass.NATIVE
          ? bytes32Hex(BigInt(input.inputCommitment))
          : null,
    })),
    ownedOutputs,
  };
  return { transactionBytes: params.transactionBytes, pending };
}


function addPendingOutputs(data: WalletFileData, pending: PendingAssetAction): void {
  for (const output of pending.ownedOutputs) {
    addPendingNote(data, pending.contentHash, {
      outputIndex: output.outputIndex,
      assetId: BigInt(output.assetId),
      amount: BigInt(output.amount),
      owner: BigInt(output.owner),
      noteSecret: BigInt(output.noteSecret),
    });
  }
}

function removePendingOutputs(data: WalletFileData, pending: PendingAssetAction): void {
  removePendingNotesForTransaction(data, pending.contentHash);
}

export interface AssetActionSubmissionResult<Output = unknown>
  extends DurableSubmissionOutcome<Output> {
  contentHash: string;
  transactionHex: string;
  assetId: bigint;
}

function result<Output>(
  pending: PendingAssetAction,
  outcome: DurableSubmissionOutcome<Output>,
): AssetActionSubmissionResult<Output> {
  return {
    contentHash: pending.contentHash,
    transactionHex: pending.transactionHex,
    assetId: BigInt(pending.assetId),
    ...outcome,
  };
}

/** Check the synced chain's spentness before reserving an action. */
async function validateCurrentAssetInputs(store: WalletStateStore, pending: PendingAssetAction): Promise<void> {
  const spent = await locallySpent(store, pending.inputs.map((input) => input.nullifier));
  if (spent.some(Boolean)) throw new Error("an asset-action nullifier was spent before reservation");
}

export async function submitPreparedAssetAction<Prepared, Output>(params: SettlePollOptions & {
  node: PcashNodeClient;
  store: WalletStateStore;
  data: WalletFileData;
  status: StatusResult;
  preparedAction: PreparedAssetAction;
  submission: DurableSubmissionAdapter<Prepared, Output>;
  preparedSubmission: Prepared;
  callbacks?: DurableSubmissionCallbacks;
  /** Bulk manifests retain exact retry state even after a definite non-broadcast. */
  retainForRetry?: boolean;
  /** Creation material, journaled in the same write as the action so it is durable before any broadcast. */
  createdAsset?: { assetId: bigint; definition: AssetDefinition; assetSecret: bigint };
}): Promise<AssetActionSubmissionResult<Output>> {
  const pending = params.preparedAction.pending;
  assertPendingAssetActionBelongsToWallet(params.data, pending);
  const existing = params.data.pendingAssetActions?.find(
    (action) => action.contentHash.toLowerCase() === pending.contentHash.toLowerCase(),
  );
  if (existing !== undefined) {
    return submitPendingAssetAction({
      node: params.node,
      store: params.store,
      data: params.data,
      status: params.status,
      pending: existing,
      submission: params.submission,
      ...(params.callbacks === undefined ? {} : { callbacks: params.callbacks }),
      ...settlePollOptions(params),
    });
  }
  return withWalletReservation(
    params.store,
    assetActionInputResources(pending),
    async (reservation) => {
  let insertedAsset = false;
  const outcome = await submitDurableAction({
    ...params,
    reservation,
    action: { contentHash: pending.contentHash, transactionHex: pending.transactionHex, kind: "assetAction" },
    state: {
      retry: false,
      prepared: params.preparedSubmission,
      validateJournal: async () => {
        await validateCurrentAssetInputs(params.store, pending);
      },
      journal: () => {
        addPendingAssetAction(params.data, pending);
        addPendingOutputs(params.data, pending);
        if (params.createdAsset !== undefined) insertedAsset = addWalletAsset(params.data, params.createdAsset);
      },
      rollback: () => {
        if (params.retainForRetry === true) return;
        removePendingAssetAction(params.data, pending.contentHash);
        removePendingOutputs(params.data, pending);
        if (insertedAsset) removeWalletAsset(params.data, params.createdAsset!.assetId);
      },
    },
    isAccepted: () => acceptedReceiptOfKind(params.node, pending.contentHash, "privateValue", "pending asset action"),
    isPending: (current) => (current.pendingAssetActions ?? [])
      .some((action) => action.contentHash.toLowerCase() === pending.contentHash.toLowerCase()),
  });
  return result(pending, outcome);
    },
  );
}

export async function submitPendingAssetAction<Prepared, Output>(params: {
  node: PcashNodeClient;
  store: WalletStateStore;
  data: WalletFileData;
  status: StatusResult;
  pending: PendingAssetAction;
  submission: DurableSubmissionAdapter<Prepared, Output>;
  callbacks?: DurableSubmissionCallbacks;
}): Promise<AssetActionSubmissionResult<Output>> {
  assertPendingAssetActionBelongsToWallet(params.data, params.pending);
  let canonicalMiss: unknown;
  try {
    await validateCurrentAssetInputs(params.store, params.pending);
  } catch (error) {
    canonicalMiss = error;
  }
  return withWalletReservation(
    params.store,
    assetActionInputResources(params.pending),
    async (reservation) => {
  const outcome = await submitDurableAction({
    ...params,
    reservation,
    action: {
      contentHash: params.pending.contentHash,
      transactionHex: params.pending.transactionHex,
      kind: "assetAction",
    },
    state: {
      retry: true,
      ...(canonicalMiss === undefined ? {} : {
        onCanonicalMiss: () => {
          throw canonicalMiss;
        },
      }),
    },
    isAccepted: () => acceptedReceiptOfKind(params.node, params.pending.contentHash, "privateValue", "pending asset action"),
    isPending: (current) => (current.pendingAssetActions ?? [])
      .some((action) => action.contentHash.toLowerCase() === params.pending.contentHash.toLowerCase()),
  });
  return result(params.pending, outcome);
    },
    { allowPendingContentHash: params.pending.contentHash },
  );
}
