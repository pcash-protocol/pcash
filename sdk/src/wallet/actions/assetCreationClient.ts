import { sameAccountCreation } from "./accountCreation.ts";
import type { PcashNodeClient } from "@pcash/sdk/clients";
import { decodeTransaction, nativeBurnAmount, quoteNativeBurn, type AccountCreationAttachment, type RawPrivateValueTransaction } from "@pcash/sdk/protocol";
import { buildAssetAction, openedAssetActionOutput, ownerChangeAssetActionOutput, type AssetActionBuild, type AssetActionOutput } from "@pcash/sdk/builders";
import { requestPcashAuthorization, type PcashActionSigner, type SelectedRelayQuoteProvider } from "@pcash/sdk/eip712";
import { PRIVATE_VALUE_PROFILES, type PrivateValueShape } from "@pcash/sdk/constants";
import {
  fungibleMetadataCommitment,
  mintMarker,
  dummyNullifier,
  networkConfigFromStatus,
  ownerCommitment,
  type AssetDefinition,
  type FungibleMetadata,
} from "@pcash/sdk/protocol";
import type { MintRuleApplication } from "@pcash/sdk/prover";
import {
  createFixedSupplyAsset,
  deriveFixedSupplyAsset,
  FIXED_SUPPLY_RULE_CIRCUIT,
  fixedSupplyMintWitness,
  fixedSupplySecretCommitment,
  recognizeMintRule,
} from "@pcash/sdk/rules";
import { addressHex, bytes32Hex, fromHex, randomFieldEntropy } from "@pcash/sdk/utils";
import type { PcashProfile } from "../externalIdentity.ts";
import { loadWalletStateOrEmpty, type WalletStateStore } from "../store.ts";
import { knownAssetDefinition, selectInputNotes, storedAssetDefinition, walletAssetRecord, type WalletFileData } from "../noteStore.ts";
import { directSendsToRecord } from "../directSends.ts";
import { collectAssetActionWitnesses, prepareAssetAction, submitPendingAssetAction, submitPreparedAssetAction, type AssetActionSubmissionResult } from "./assetActionClient.ts";
import { settlePollOptions, type DurableSubmissionAdapter, type DurableSubmissionCallbacks, type SettlePollOptions } from "./durableSubmission.ts";
import { actionPublication, fixPublication, noteNullifier, pendingIssuanceBeneficiary, planPublication, privateValueActionUnits, publicationOf, publicationValidUntil, paddedPrivateValueByteSize, resolvePublicationFunding, type ActionPublication } from "./publication.ts";

import { registeredSelfReceiveKey } from "./selfDelivery.ts";

/** Proves a mint: the minting account's readable mint rule and the asset's mint rule. */
export interface AssetCreationProver {
  /** The shapes this prover can prove; a mint chooses its profile only among these. */
  readonly shapes: readonly PrivateValueShape[];
  proveAndEncode(build: AssetActionBuild, authorizationWitnessMap: Record<string, unknown>, mintRule: MintRuleApplication): Promise<Uint8Array>;
}

export interface AssetCreationIntent extends DurableSubmissionCallbacks {
  accountCreation?: AccountCreationAttachment;
  metadata: FungibleMetadata;
  supply: bigint;
  validUntilTimestamp?: bigint;
  openFeeAmount?: bigint;
  privateRelayFeeAmount?: bigint;
  /** Native PCASH to burn beyond the quoted protocol fee. */
  voluntaryBurnAmount?: bigint;
  selectedRelayQuote?: SelectedRelayQuoteProvider;
  /** Reuse one exact journaled creation; no new asset secret, quote, or proof is generated. */
  retryContentHash?: string;
  /**
   * Prove this wallet's persisted creation of `assetId` again after its earlier
   * proof expired uncommitted. The identity and asset secret are reused;
   * `metadata` and `supply` must match its definition.
   */
  assetId?: bigint;
}

/** Rebuild a persisted, never-created asset after checking its reviewed terms and its unspent marker. */
async function persistedCreation(params: {
  node: PcashNodeClient;
  data: WalletFileData;
  assetId: bigint;
  metadata: FungibleMetadata;
  supply: bigint;
}) {
  const record = walletAssetRecord(params.data, params.assetId);
  if (record?.assetSecret === undefined) throw new Error("this wallet holds no creation material for the asset");
  const definition = storedAssetDefinition(record);
  const mintRule = recognizeMintRule(definition.mintRule);
  if (fungibleMetadataCommitment(definition.metadata) !== fungibleMetadataCommitment(params.metadata)
    || mintRule.kind !== "fixed-supply" || mintRule.configuration.supply !== params.supply) {
    throw new Error("persisted asset definition differs from the reviewed terms");
  }
  const pending = params.data.pendingAssetActions?.find((action) =>
    action.assetCreationReview !== undefined && BigInt(action.assetId) === params.assetId);
  if (pending !== undefined) throw new Error(`asset creation ${pending.contentHash} is still pending; retry its exact bytes`);
  const assetSecret = BigInt(record.assetSecret);
  const marker = mintMarker(params.assetId, assetSecret);
  if ((await params.node.getWitnessSnapshot({ nullifiers: [bytes32Hex(marker)] })).nullifiers.statuses[0]!.spent) {
    throw new Error("the asset was already created");
  }
  return deriveFixedSupplyAsset({
    metadata: definition.metadata, supply: params.supply, secret: assetSecret, instanceSalt: definition.instanceSalt,
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
    if (pending === undefined || pending.assetCreationReview === undefined) {
      throw new Error("retryContentHash does not name a journaled standard asset creation");
    }
    const transaction = decodeTransaction(fromHex(pending.transactionHex)) as RawPrivateValueTransaction;
    if (BigInt(pending.assetCreationReview.metadataCommitment) !== fungibleMetadataCommitment(params.metadata)
      || BigInt(pending.assetCreationReview.supply) !== params.supply
      || !sameAccountCreation(transaction.accountCreation, params.accountCreation)
      || BigInt(pending.ownedOutputs.find((output) => output.outputIndex === 0)?.owner ?? 0n) !== params.wallet.address
      || BigInt(pending.ownedOutputs.find((output) => output.outputIndex === 0)?.amount ?? 0n) !== params.supply
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
    ? createFixedSupplyAsset({ metadata: params.metadata, supply: params.supply })
    : await persistedCreation({ ...params, assetId: params.assetId, data });
  const assetId = asset.descriptor.assetId;
  const definition = asset.definition;
  const plan = await planPublication({
    qualifying: true, byteSize: null, publication: publicationOf(params.submission, params.privateRelayFeeAmount), node: params.node,
    openFeeAmount: params.openFeeAmount, privateRelayFeeAmount: params.privateRelayFeeAmount,
    burn: quoteNativeBurn(initialStatus.feeExcess,
      privateValueActionUnits(PRIVATE_VALUE_PROFILES.S.shapeId, params.accountCreation), params.voluntaryBurnAmount ?? 0n),
    selectedRelayQuote: params.selectedRelayQuote,
  });
  const { funding: nativeNotes } = resolvePublicationFunding(plan, fee => fee === 0n ? [] : selectInputNotes(data, undefined, fee, 3));
  params.onProgress?.("preparing", "reading the registered account…");
  const witnesses = await collectAssetActionWitnesses({
    node: params.node, store: params.store, wallet: params.wallet,
    authorizationKind: "mint",
    inputOpenings: nativeNotes.map((note) => ({
      outputIndex: BigInt(note.leafIndex!), outputCommitment: BigInt(note.commitment!),
    })),
  });
  const receiveKey = registeredSelfReceiveKey(witnesses.account, data);
  // The mint rule declares every minted unit, the creator's own included.
  const selfOutput = openedAssetActionOutput({
    kind: "asset", pcashChainId: params.chainId, assetId, outputIndex: 0, amount: params.supply,
    recipientAddress: params.wallet.address, recipientMlKemPublicKey: receiveKey, authenticatedRecipient: true,
    assetDefinition: definition, change: true,
  });
  const dummy = (): AssetActionOutput => ({ kind: "dummy", dummySecret: randomFieldEntropy(), amount: 0n });
  const dummyInputSeed = randomFieldEntropy();
  const nullifiers = [
    mintMarker(assetId, asset.secret),
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
    maxTransactionBytes: paddedPrivateValueByteSize(PRIVATE_VALUE_PROFILES.S.shapeId, params.accountCreation),
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
  const changeAmount = nativeTotal - plan.openFeeAmount - plan.privateRelayFeeAmount - nativeBurnAmount(plan.burn);
  const nativeChange = changeAmount === 0n ? dummy() : ownerChangeAssetActionOutput({
    kind: "native", pcashChainId: params.chainId, assetId: 0n, amount: changeAmount,
    receiveKey,
  });
  const build = buildAssetAction({
    ...(params.accountCreation === undefined ? {} : { accountCreation: params.accountCreation }),
    pcashChainId: params.chainId, snapshot: witnesses.snapshot, owner: witnesses.owner,
    mint: { descriptor: asset.descriptor },
    // The fixed-supply rule keys the asset's one mint marker by its secret.
    inputs: [{ kind: "mint-marker", replayId: asset.secret }, ...[1, 2, 3].map((slot) => {
      const note = nativeNotes[slot - 1];
      return note === undefined ? { kind: "dummy" as const } : {
        kind: "native" as const, amount: BigInt(note.amount), noteSecret: BigInt(note.noteSecret),
        leafIndex: Number(note.leafIndex!), siblings: witnesses.inputSiblings[slot - 1]!,
      };
    })],
    outputs: [selfOutput, nativeChange, dummy(), dummy(), privateFeeOutput],
    openFeeAmount: plan.openFeeAmount,
    burn: plan.burn,
    issuanceOwnerCommitment: publication.issuanceOwnerCommitment,
    ...(publication.designatedIssuanceOpening === undefined ? {} : { designatedIssuanceOpening: publication.designatedIssuanceOpening }),
    ...(publication.privateRelayPayment === undefined ? {} : { privateRelayPayment: {
      amount: publication.privateRelayPayment.amount, ownerCommitment: privateFeeOwner,
    } }),
    dummyInputSeed, validUntilTimestamp, assetDefinition: definition,
    sender: { outgoingKey: params.wallet.outgoingKey, directSendOpenings: directSendsToRecord(data, params.wallet.address, nativeNotes) },
  });
  const authorization = build.prepareOwnerAuthorization({
    wallet: params.wallet, network: networkConfigFromStatus(witnesses.status),
  });
  const signed = authorization.authorize(await requestPcashAuthorization(params.signer, authorization.request));
  const mintRule = { packageName: FIXED_SUPPLY_RULE_CIRCUIT, witnessMap: fixedSupplyMintWitness({
    mint: build, secret: asset.secret,
    configuration: { supply: params.supply, secretCommitment: fixedSupplySecretCommitment(asset.secret) },
  }) };
  params.onProgress?.("proving", "proving the authorized asset creation…");
  const entry = await params.prover.proveAndEncode(build, signed.witnessMap, mintRule);
  const preparedAction = prepareAssetAction({ build, transactionBytes: entry, ...publication,
    ...(publication.privateRelayPayment === undefined ? {} : { privateRelayRecipient: publication.privateRelayPayment.recipientAddress }),
    privateRelayFeeAmount: plan.privateRelayFeeAmount, ownedOutputs: [
      { outputIndex: 0, assetId, owner: params.wallet.address,
        noteSecret: build.outputNoteSecrets[0]!, amount: params.supply },
      ...(changeAmount === 0n ? [] : [{ outputIndex: 1, assetId: 0n, owner: params.wallet.address,
        noteSecret: build.outputNoteSecrets[1]!, amount: changeAmount }]),
    ] });
  preparedAction.pending.assetCreationReview = {
    metadataCommitment: bytes32Hex(fungibleMetadataCommitment(params.metadata)),
    supply: params.supply.toString(),
  };
  const preparedSubmission = await params.submission.preflight({ transactionBytes: entry, status: witnesses.status, retry: false });
  const result = await submitPreparedAssetAction({
    node: params.node, store: params.store, data, status: witnesses.status, preparedAction,
    submission: params.submission, preparedSubmission, callbacks: params, ...settlePollOptions(params),
    createdAsset: { assetId, definition, assetSecret: asset.secret },
  });
  return { ...result, publicationDetails: actionPublication(preparedAction.pending, plan.beneficiary), definition };
}
