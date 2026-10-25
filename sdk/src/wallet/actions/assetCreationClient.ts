import type { PcashNodeClient } from "@pcash/sdk/clients";
import { buildAssetAction, openedAssetActionOutput, ownerChangeAssetActionOutput, type AssetActionBuild, type AssetActionOutput } from "@pcash/sdk/builders";
import { requestPcashAuthorization, type PcashActionSigner, type SelectedRelayQuoteProvider } from "@pcash/sdk/eip712";
import { PRIVATE_VALUE_PROFILES } from "@pcash/sdk/constants";
import {
  assetDefinitionFromCreated,
  assetCreationMarker,
  createStandardFungibleAsset,
  deriveStandardFungibleAssetFromEntropy,
  fungibleMetadataCommitment,
  dummyNullifier,
  networkConfigFromStatus,
  ownerCommitment,
  type AssetDefinition,
  type FungibleMetadata,
} from "@pcash/sdk/protocol";
import { addressHex, bytes32Hex, randomFieldEntropy } from "@pcash/sdk/utils";
import type { PcashProfile } from "../externalIdentity.ts";
import { loadWalletStateOrEmpty, type WalletStateStore } from "../store.ts";
import { knownAssetDefinition, selectInputNotes, storedAssetDefinition, walletAssetRecord, type WalletFileData } from "../noteStore.ts";
import { collectAssetActionWitnesses, prepareAssetAction, submitPendingAssetAction, submitPreparedAssetAction, type AssetActionSubmissionResult } from "./assetActionClient.ts";
import { settlePollOptions, type DurableSubmissionAdapter, type DurableSubmissionCallbacks, type SettlePollOptions } from "./durableSubmission.ts";
import { actionPublication, fixPublication, noteNullifier, pendingIssuanceBeneficiary, planPublication, publicationOf, publicationValidUntil, type ActionPublication } from "./publication.ts";

import { registeredSelfReceiveKey } from "./selfDelivery.ts";

export interface AssetCreationProver {
  proveAndEncode(build: AssetActionBuild, authorizationWitnessMap: Record<string, unknown>): Promise<Uint8Array>;
}

export interface AssetCreationIntent extends DurableSubmissionCallbacks {
  metadata: FungibleMetadata;
  initialSupply: bigint;
  validUntilTimestamp?: bigint;
  openFeeAmount?: bigint;
  privateRelayFeeAmount?: bigint;
  selectedRelayQuote?: SelectedRelayQuoteProvider;
  /** Reuse one exact journaled creation; no new asset secret, quote, or proof is generated. */
  retryContentHash?: string;
  /**
   * Prove this wallet's persisted creation of `assetId` again after its earlier
   * proof expired uncommitted. The identity and asset secret are reused;
   * `metadata` and `initialSupply` must match its definition.
   */
  assetId?: bigint;
}

/** Rebuild a persisted, never-created asset after checking its reviewed terms and its unspent marker. */
async function persistedCreation(params: {
  node: PcashNodeClient;
  data: WalletFileData;
  assetId: bigint;
  metadata: FungibleMetadata;
  initialSupply: bigint;
}) {
  const record = walletAssetRecord(params.data, params.assetId);
  if (record?.assetSecret === undefined) throw new Error("this wallet holds no creation material for the asset");
  const definition = storedAssetDefinition(record);
  if (fungibleMetadataCommitment(definition.metadata) !== fungibleMetadataCommitment(params.metadata)
    || definition.initialSupply !== params.initialSupply) {
    throw new Error("persisted asset definition differs from the reviewed terms");
  }
  const pending = params.data.pendingAssetActions?.find((action) =>
    action.assetCreationReview !== undefined && BigInt(action.assetId) === params.assetId);
  if (pending !== undefined) throw new Error(`asset creation ${pending.contentHash} is still pending; retry its exact bytes`);
  const assetSecret = BigInt(record.assetSecret);
  const marker = assetCreationMarker(params.assetId, assetSecret);
  if ((await params.node.getWitnessSnapshot({ nullifiers: [bytes32Hex(marker)] })).nullifiers.statuses[0]!.spent) {
    throw new Error("the asset was already created");
  }
  return deriveStandardFungibleAssetFromEntropy({
    metadata: definition.metadata, initialSupply: definition.initialSupply, assetSecret,
  });
}

/**
 * Registered zero-native-input asset creation. With no native inputs it carries
 * no fee: relayed on the open route, its issuance pays its publisher; posted by
 * this wallet, it names the wallet's own commitment, so its issuance pays the
 * wallet wherever the batch lands.
 */
export async function runAssetCreationClient<Prepared, Output>(params: AssetCreationIntent & SettlePollOptions & {
  node: PcashNodeClient;
  store: WalletStateStore;
  wallet: PcashProfile;
  signer: PcashActionSigner;
  chainId: bigint;
  prover: AssetCreationProver;
  submission: DurableSubmissionAdapter<Prepared, Output>;
}): Promise<AssetActionSubmissionResult<Output> & { publicationDetails: ActionPublication; definition: AssetDefinition }> {
  const initialStatus = await params.node.status();
  const data = await loadWalletStateOrEmpty(params.store, {
    address: params.wallet.address, network: { chainId: params.chainId, genesisHash: initialStatus.genesisHash },
  });
  if (params.retryContentHash !== undefined) {
    const pending = data.pendingAssetActions?.find((item) => item.contentHash.toLowerCase() === params.retryContentHash!.toLowerCase());
    if (pending === undefined || pending.assetCreationReview === undefined || pending.receiptKind === "contractAccount") {
      throw new Error("retryContentHash does not name a journaled standard asset creation");
    }
    if (BigInt(pending.assetCreationReview.metadataCommitment) !== fungibleMetadataCommitment(params.metadata)
      || BigInt(pending.assetCreationReview.initialSupply) !== params.initialSupply
      || BigInt(pending.ownedOutputs.find((output) => output.outputIndex === 0)?.owner ?? 0n) !== params.wallet.address
      || BigInt(pending.ownedOutputs.find((output) => output.outputIndex === 0)?.amount ?? 0n) !== params.initialSupply
      || (params.openFeeAmount !== undefined && BigInt(pending.openFeeAmount) !== params.openFeeAmount)
      || (params.privateRelayFeeAmount !== undefined && BigInt(pending.privateRelayFeeAmount ?? 0n) !== params.privateRelayFeeAmount)
      || (params.validUntilTimestamp !== undefined && BigInt(pending.validUntilTimestamp) !== params.validUntilTimestamp)) {
      throw new Error("journaled asset creation differs from the reviewed terms");
    }
    const selected = pending.privateRelayRecipient !== undefined;
    if (publicationOf(params.submission, params.privateRelayFeeAmount ?? BigInt(pending.privateRelayFeeAmount ?? 0n)) !== (selected ? "selected"
      : BigInt(pending.issuanceOwnerCommitment) === 0n ? "open" : "self")) {
      throw new Error("asset creation retry uses another publication mode");
    }
    if (selected && params.selectedRelayQuote !== undefined
      && pending.privateRelayRecipient!.toLowerCase() !== addressHex(params.selectedRelayQuote.recipient).toLowerCase()) {
      throw new Error("journaled asset creation has another selected relay destination");
    }
    const result = await submitPendingAssetAction({
      node: params.node, store: params.store, data, status: initialStatus, pending,
      submission: params.submission, callbacks: params, ...settlePollOptions(params),
    });
    return {
      ...result,
      publicationDetails: actionPublication(pending, pendingIssuanceBeneficiary(pending, params.wallet)),
      definition: knownAssetDefinition(data, BigInt(pending.assetId))!,
    };
  }
  const asset = params.assetId === undefined
    ? createStandardFungibleAsset({ metadata: params.metadata, initialSupply: params.initialSupply })
    : await persistedCreation({ ...params, assetId: params.assetId, data });
  const assetId = BigInt(asset.descriptor.assetId);
  const definition = assetDefinitionFromCreated(asset);
  const plan = await planPublication({
    qualifying: true, byteSize: null, publication: publicationOf(params.submission, params.privateRelayFeeAmount), node: params.node,
    openFeeAmount: params.openFeeAmount, privateRelayFeeAmount: params.privateRelayFeeAmount,
    selectedRelayQuote: params.selectedRelayQuote,
  });
  const nativeNotes = plan.openFeeAmount + plan.privateRelayFeeAmount === 0n ? []
    : selectInputNotes(data, undefined, plan.openFeeAmount + plan.privateRelayFeeAmount, 3);
  params.onProgress?.("preparing", "reading the registered account…");
  const witnesses = await collectAssetActionWitnesses({
    node: params.node, store: params.store, wallet: params.wallet,
    authorizationKind: "asset-creation",
    inputOpenings: nativeNotes.map((note) => ({
      outputIndex: BigInt(note.leafIndex!), outputCommitment: BigInt(note.commitment!),
    })),
  });
  const receiveKey = registeredSelfReceiveKey(witnesses.account, data);
  const selfOutput = ownerChangeAssetActionOutput({
    kind: "asset", pcashChainId: params.chainId, assetId, amount: params.initialSupply,
    receiveKey,
  });
  const dummy = (): AssetActionOutput => ({ kind: "dummy", dummySecret: randomFieldEntropy(), amount: 0n });
  const dummyInputSeed = randomFieldEntropy();
  const nullifiers = [
    assetCreationMarker(assetId, asset.assetSecret),
    ...[1, 2, 3].map((slot) => {
      const note = nativeNotes[slot - 1];
      return note === undefined ? dummyNullifier(dummyInputSeed, slot)
        : noteNullifier(params.wallet.nkRoot, note);
    }),
  ];
  const validUntilTimestamp = publicationValidUntil({
    chainNow: witnesses.status.latestBlockTimestamp, defaultWindow: 1800n,
    selectedRelayQuote: params.selectedRelayQuote, requested: params.validUntilTimestamp,
    action: "asset creation",
  });
  const publication = await fixPublication({
    selectedRelayQuote: params.selectedRelayQuote, publication: plan.publication, owner: params.wallet,
    requestedCommitment: 0n, node: params.node, status: witnesses.status, nullifiers,
    shape: PRIVATE_VALUE_PROFILES.S.shapeId, openFeeAmount: plan.openFeeAmount,
    privateRelayFeeAmount: plan.privateRelayFeeAmount, validUntilTimestamp,
  });
  const privateFeeOutput = publication.privateRelayPayment === undefined ? dummy()
    : openedAssetActionOutput({
      kind: "native", pcashChainId: params.chainId, assetId: 0n,
      outputIndex: 4, amount: publication.privateRelayPayment.amount,
      recipientAddress: publication.privateRelayPayment.recipientAddress,
      recipientMlKemPublicKey: publication.privateRelayPayment.receiveKey,
      authenticatedRecipient: true,
    });
  const privateFeeOwner = privateFeeOutput.kind === "native" && privateFeeOutput.destination.kind === "opening"
    ? ownerCommitment(privateFeeOutput.destination.recipientAddress, privateFeeOutput.destination.noteSecret)
    : 0n;
  const nativeTotal = nativeNotes.reduce((sum, note) => sum + BigInt(note.amount), 0n);
  const changeAmount = nativeTotal - plan.openFeeAmount - plan.privateRelayFeeAmount;
  const nativeChange = changeAmount === 0n ? dummy() : ownerChangeAssetActionOutput({
    kind: "native", pcashChainId: params.chainId, assetId: 0n, amount: changeAmount,
    receiveKey,
  });
  const build = buildAssetAction({
    pcashChainId: params.chainId, snapshot: witnesses.snapshot, owner: witnesses.owner,
    assetDescriptor: asset.descriptor, assetSecret: asset.assetSecret,
    inputs: [{ kind: "creation-marker" }, ...[1, 2, 3].map((slot) => {
      const note = nativeNotes[slot - 1];
      return note === undefined ? { kind: "dummy" as const } : {
        kind: "native" as const, amount: BigInt(note.amount), noteSecret: BigInt(note.noteSecret),
        leafIndex: Number(note.leafIndex!), siblings: witnesses.inputSiblings[slot - 1]!,
      };
    })],
    outputs: [selfOutput, nativeChange, dummy(), dummy(), privateFeeOutput],
    openFeeAmount: plan.openFeeAmount,
    issuanceOwnerCommitment: publication.issuanceOwnerCommitment,
    ...(publication.designatedIssuanceOpening === undefined ? {} : { designatedIssuanceOpening: publication.designatedIssuanceOpening }),
    ...(publication.privateRelayPayment === undefined ? {} : { privateRelayPayment: {
      amount: publication.privateRelayPayment.amount, ownerCommitment: privateFeeOwner,
    } }),
    dummyInputSeed, validUntilTimestamp, assetDefinition: definition,
    sender: { outgoingKey: params.wallet.outgoingKey },
  });
  const authorization = build.prepareOwnerAuthorization({
    wallet: params.wallet, network: networkConfigFromStatus(witnesses.status),
  });
  const signed = authorization.authorize(await requestPcashAuthorization(params.signer, authorization.request));
  params.onProgress?.("proving", "proving the authorized asset creation…");
  const entry = await params.prover.proveAndEncode(build, signed.witnessMap);
  const preparedAction = prepareAssetAction({ build, transactionBytes: entry, ...publication,
    ...(publication.privateRelayPayment === undefined ? {} : { privateRelayRecipient: publication.privateRelayPayment.recipientAddress }),
    privateRelayFeeAmount: plan.privateRelayFeeAmount, ownedOutputs: [
      { outputIndex: 0, assetId, owner: params.wallet.address,
        noteSecret: build.outputNoteSecrets[0]!, amount: params.initialSupply },
      ...(changeAmount === 0n ? [] : [{ outputIndex: 1, assetId: 0n, owner: params.wallet.address,
        noteSecret: build.outputNoteSecrets[1]!, amount: changeAmount }]),
    ] });
  preparedAction.pending.assetCreationReview = {
    metadataCommitment: bytes32Hex(fungibleMetadataCommitment(params.metadata)),
    initialSupply: params.initialSupply.toString(),
  };
  const preparedSubmission = await params.submission.preflight({ transactionBytes: entry, status: witnesses.status, retry: false });
  const result = await submitPreparedAssetAction({
    node: params.node, store: params.store, data, status: witnesses.status, preparedAction,
    submission: params.submission, preparedSubmission, callbacks: params, ...settlePollOptions(params),
    createdAsset: { assetId, definition, assetSecret: asset.assetSecret },
  });
  return { ...result, publicationDetails: actionPublication(preparedAction.pending, plan.beneficiary), definition };
}
