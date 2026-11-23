// One mint of an account-mint asset by this wallet, its configured account.
// Each mint names the replay IDs its markers are keyed by; reusing a replay ID
// for every retry, re-proof and key rotation of one logical mint is what makes
// it land once. The account's native notes fund the fee.

import type { PcashNodeClient } from "@pcash/sdk/clients";
import {
  buildAssetAction,
  openedAssetActionOutput,
  ownerChangeAssetActionOutput,
  type AssetActionInput,
  type AssetActionOutput,
} from "@pcash/sdk/builders";
import { resolveRecipientDelivery } from "@pcash/sdk/delivery";
import { requestPcashAuthorization, type PcashActionSigner, type SelectedRelayQuoteProvider } from "@pcash/sdk/eip712";
import {
  assetDefinitionDescriptor,
  dummyNullifier,
  mintMarker,
  nativeBurnAmount,
  networkConfigFromStatus,
  ownerCommitment,
  ProfileCapacityError,
  quoteNativeBurn,
  type AssetDefinition,
} from "@pcash/sdk/protocol";
import { ACCOUNT_MINT_RULE_CIRCUIT, accountMintWitness, recognizeMintRule } from "@pcash/sdk/rules";
import { bytes32Hex, randomFieldEntropy, U128_LIMIT } from "@pcash/sdk/utils";
import type { PcashProfile } from "../externalIdentity.ts";
import { selectInputNotes } from "../noteStore.ts";
import { loadWalletStateOrEmpty, type WalletStateStore } from "../store.ts";
import { directSendsToRecord } from "../directSends.ts";
import type { AssetCreationProver } from "./assetCreationClient.ts";
import {
  buildInFittingProfile,
  collectAssetActionWitnesses,
  prepareAssetAction,
  submitPreparedAssetAction,
  type AssetActionSubmissionResult,
} from "./assetActionClient.ts";
import { settlePollOptions, type DurableSubmissionAdapter, type DurableSubmissionCallbacks, type SettlePollOptions } from "./durableSubmission.ts";
import {
  actionPublication,
  fixPublication,
  noteNullifier,
  paddedPrivateValueByteSize,
  planPublication,
  privateValueActionUnits,
  publicationOf,
  publicationValidUntil,
  resolvePublicationFunding,
  type ActionPublication,
} from "./publication.ts";
import { registeredSelfReceiveKey } from "./selfDelivery.ts";

const MAX_NOTE_AMOUNT = U128_LIMIT - 1n;

export interface MintOutput {
  /** Address or extended receive code, as a payment accepts. */
  to: string;
  amount: bigint;
}

export interface AccountMintIntent extends DurableSubmissionCallbacks {
  /** The definition of an account-mint asset whose configured account is this wallet's. */
  definition: AssetDefinition;
  outputs: readonly MintOutput[];
  /**
   * One replay ID per mint marker. The same logical mint must always use the
   * same replay IDs: a marker already in the spent set means it landed.
   */
  replayIds: readonly bigint[];
  validUntilTimestamp?: bigint;
  openFeeAmount?: bigint;
  privateRelayFeeAmount?: bigint;
  /** Native PCASH to burn beyond the quoted protocol fee. */
  voluntaryBurnAmount?: bigint;
  selectedRelayQuote?: SelectedRelayQuoteProvider;
}

/** Whether each replay ID's marker is already spent, read from the node. */
export async function mintMarkersSpent(node: PcashNodeClient, assetId: bigint, replayIds: readonly bigint[]): Promise<boolean[]> {
  const snapshot = await node.getWitnessSnapshot({ nullifiers: replayIds.map((replayId) => bytes32Hex(mintMarker(assetId, replayId))) });
  return snapshot.nullifiers.statuses.map((status) => status.spent);
}

export async function runAccountMintClient<Prepared, Output>(params: AccountMintIntent & SettlePollOptions & {
  node: PcashNodeClient;
  store: WalletStateStore;
  wallet: PcashProfile;
  signer: PcashActionSigner;
  chainId: bigint;
  prover: AssetCreationProver;
  submission: DurableSubmissionAdapter<Prepared, Output>;
}): Promise<AssetActionSubmissionResult<Output> & { publicationDetails: ActionPublication; assetId: bigint }> {
  const descriptor = assetDefinitionDescriptor(params.definition);
  const mintRule = recognizeMintRule(params.definition.mintRule);
  if (mintRule.kind !== "account-mint") throw new Error("only an account-mint asset is minted on demand");
  if (mintRule.configuration.accountAddress !== params.wallet.address) throw new Error("this wallet is not the asset's minting account");
  if (params.replayIds.length === 0) throw new Error("a mint names at least one replay ID");
  if (new Set(params.replayIds).size !== params.replayIds.length) throw new Error("replay IDs must be distinct");
  if (params.outputs.length === 0) throw new Error("a mint pays at least one recipient");
  for (const output of params.outputs) {
    if (output.amount <= 0n || output.amount > MAX_NOTE_AMOUNT) throw new Error("each minted output is one note amount");
  }
  const assetId = descriptor.assetId;
  if ((await mintMarkersSpent(params.node, assetId, params.replayIds)).some((spent) => spent)) {
    throw new Error("a replay ID of this mint is already spent: the mint already landed");
  }
  const status = await params.node.status();
  const data = await loadWalletStateOrEmpty(params.store, {
    address: params.wallet.address, network: { chainId: params.chainId, genesisHash: status.genesisHash },
  });
  const { plan, changeAmount, recipients, witnesses, publication, build } = await buildInFittingProfile(params.prover.shapes, async (profile) => {
    const plan = await planPublication({
      qualifying: true, byteSize: null, publication: publicationOf(params.submission, params.privateRelayFeeAmount), node: params.node,
      openFeeAmount: params.openFeeAmount, privateRelayFeeAmount: params.privateRelayFeeAmount,
      burn: quoteNativeBurn(status.feeExcess, privateValueActionUnits(profile.shapeId, undefined), params.voluntaryBurnAmount ?? 0n),
      selectedRelayQuote: params.selectedRelayQuote,
    });
    const fee = plan.openFeeAmount + plan.privateRelayFeeAmount + nativeBurnAmount(plan.burn);
    const nativeSlots = profile.inputs - params.replayIds.length;
    if (nativeSlots < (fee === 0n ? 0 : 1)) throw new ProfileCapacityError("the mint's markers leave too few input slots for its fee");
    const { funding: nativeNotes } = resolvePublicationFunding(plan, (amount) => amount === 0n ? [] : selectInputNotes(data, undefined, amount, nativeSlots));
    const changeAmount = nativeNotes.reduce((sum, note) => sum + BigInt(note.amount), 0n) - fee;
    const outputCapacity = profile.outputs - (plan.privateRelayFeeAmount === 0n ? 0 : 1) - (changeAmount === 0n ? 0 : 1);
    if (params.outputs.length > outputCapacity) throw new ProfileCapacityError(`one mint pays at most ${outputCapacity} recipients`);
    params.onProgress?.("preparing", "reading the minting account…");
    const witnesses = await collectAssetActionWitnesses({
      node: params.node, store: params.store, wallet: params.wallet, authorizationKind: "mint", shape: profile.shapeId,
      inputOpenings: nativeNotes.map((note) => ({ outputIndex: BigInt(note.leafIndex!), outputCommitment: BigInt(note.commitment!) })),
    });
    const recipients: AssetActionOutput[] = [];
    for (const [outputIndex, output] of params.outputs.entries()) {
      const delivery = await resolveRecipientDelivery(output.to, params.chainId, (address) => witnesses.receiveKeyOf(address));
      recipients.push(openedAssetActionOutput({
        kind: "asset", pcashChainId: params.chainId, assetId, outputIndex, amount: output.amount, assetDefinition: params.definition,
        ...(delivery.recipientExtendedCode === undefined
          ? { recipientAddress: delivery.recipientAddress, recipientMlKemPublicKey: delivery.recipientReceiveKey!, authenticatedRecipient: true as const }
          : { recipientExtendedCode: delivery.recipientExtendedCode }),
      }));
    }
    const dummy = (): AssetActionOutput => ({ kind: "dummy", dummySecret: randomFieldEntropy(), amount: 0n });
    const dummyInputSeed = randomFieldEntropy();
    const inputs: AssetActionInput[] = [
      ...params.replayIds.map((replayId) => ({ kind: "mint-marker" as const, replayId })),
      ...nativeNotes.map((note, index) => ({
        kind: "native" as const, amount: BigInt(note.amount), noteSecret: BigInt(note.noteSecret),
        leafIndex: Number(note.leafIndex!), siblings: witnesses.inputSiblings[index]!,
      })),
    ];
    while (inputs.length < profile.inputs) inputs.push({ kind: "dummy" });
    const nullifiers = inputs.map((input, slot) => input.kind === "mint-marker" ? mintMarker(assetId, input.replayId)
      : input.kind === "native" ? noteNullifier(params.wallet.nkRoot, nativeNotes[slot - params.replayIds.length]!)
      : dummyNullifier(dummyInputSeed, slot));
    const validUntilTimestamp = publicationValidUntil({
      chainNow: witnesses.status.latestBlockTimestamp, defaultWindow: 1800n,
      selectedRelayQuote: params.selectedRelayQuote, requested: params.validUntilTimestamp, action: "mint",
    });
    const publication = await fixPublication({
      maxTransactionBytes: paddedPrivateValueByteSize(profile.shapeId, undefined),
      selectedRelayQuote: params.selectedRelayQuote, publication: plan.publication, owner: params.wallet,
      requestedCommitment: 0n, node: params.node, status: witnesses.status, nullifiers,
      shape: profile.shapeId, openFeeAmount: plan.openFeeAmount,
      privateRelayFeeAmount: plan.privateRelayFeeAmount, validUntilTimestamp,
    });
    const outputs: AssetActionOutput[] = [...recipients];
    if (changeAmount !== 0n) {
      outputs.push(ownerChangeAssetActionOutput({
        kind: "native", pcashChainId: params.chainId, assetId: 0n, amount: changeAmount,
        receiveKey: registeredSelfReceiveKey(witnesses.account, data),
      }));
    }
    // A relay payment takes the last slot; without one, dummies fill every free slot.
    while (outputs.length < profile.outputs - (publication.privateRelayPayment === undefined ? 0 : 1)) outputs.push(dummy());
    let privateRelayOwnerCommitment = 0n;
    if (publication.privateRelayPayment !== undefined) {
      const feeOutput = openedAssetActionOutput({
        kind: "native", pcashChainId: params.chainId, assetId: 0n, outputIndex: profile.outputs - 1,
        amount: publication.privateRelayPayment.amount, recipientAddress: publication.privateRelayPayment.recipientAddress,
        recipientMlKemPublicKey: publication.privateRelayPayment.receiveKey, authenticatedRecipient: true,
      });
      if (feeOutput.kind !== "native" || feeOutput.destination.kind !== "opening") throw new Error("selected relay fee has no owner opening");
      privateRelayOwnerCommitment = ownerCommitment(feeOutput.destination.recipientAddress, feeOutput.destination.noteSecret);
      outputs.push(feeOutput);
    }
    const build = buildAssetAction({
      shape: profile.shapeId, pcashChainId: params.chainId, snapshot: witnesses.snapshot, owner: witnesses.owner,
      mint: { descriptor },
      inputs, outputs,
      openFeeAmount: plan.openFeeAmount,
      burn: plan.burn,
      issuanceOwnerCommitment: publication.issuanceOwnerCommitment,
      ...(publication.designatedIssuanceOpening === undefined ? {} : { designatedIssuanceOpening: publication.designatedIssuanceOpening }),
      ...(publication.privateRelayPayment === undefined ? {} : { privateRelayPayment: {
        amount: publication.privateRelayPayment.amount, ownerCommitment: privateRelayOwnerCommitment,
      } }),
      dummyInputSeed, validUntilTimestamp, assetDefinition: params.definition,
      sender: { outgoingKey: params.wallet.outgoingKey, directSendOpenings: directSendsToRecord(data, params.wallet.address, nativeNotes) },
    });
    return { plan, changeAmount, recipients, witnesses, publication, build };
  });
  const authorization = build.prepareOwnerAuthorization({ wallet: params.wallet, network: networkConfigFromStatus(witnesses.status) });
  const signed = authorization.authorize(await requestPcashAuthorization(params.signer, authorization.request));
  const mintRuleApplication = { packageName: ACCOUNT_MINT_RULE_CIRCUIT,
    witnessMap: accountMintWitness({ mint: build, configuration: mintRule.configuration }) };
  params.onProgress?.("proving", "proving the authorized mint…");
  const entry = await params.prover.proveAndEncode(build, signed.witnessMap, mintRuleApplication);
  const changeSlot = recipients.length;
  const preparedAction = prepareAssetAction({
    build, transactionBytes: entry, ...publication,
    ...(publication.privateRelayPayment === undefined ? {} : { privateRelayRecipient: publication.privateRelayPayment.recipientAddress }),
    privateRelayFeeAmount: plan.privateRelayFeeAmount,
    ownedOutputs: changeAmount === 0n ? [] : [{ outputIndex: changeSlot, assetId: 0n, owner: params.wallet.address,
      noteSecret: build.outputNoteSecrets[changeSlot]!, amount: changeAmount }],
  });
  const preparedSubmission = await params.submission.preflight({ transactionBytes: entry, status: witnesses.status, retry: false });
  const result = await submitPreparedAssetAction({
    node: params.node, store: params.store, data, status: witnesses.status, preparedAction,
    submission: params.submission, preparedSubmission, callbacks: params, ...settlePollOptions(params),
  });
  return { ...result, publicationDetails: actionPublication(preparedAction.pending, plan.beneficiary), assetId };
}
