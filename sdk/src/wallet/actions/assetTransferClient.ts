import { sameTransactionData, storeTransactionData, restoreTransactionData, resolveTransactionData, type TransactionData } from "@pcash/sdk/delivery";
import { decodeTransaction, type AccountCreationAttachment, type RawPrivateValueTransaction } from "@pcash/sdk/protocol";
import { sameAccountCreation } from "./accountCreation.ts";
// One S action that pays or burns a standard asset. Asset notes fund the
// recipients and burn, native notes fund the network fee, and both changes
// return to the owner with the asset's definition attached.

import { PRIVATE_VALUE_PROFILES } from "@pcash/sdk/constants";
import {
  buildAssetAction,
  openedAssetActionOutput,
  outOfBandAssetActionOutput,
  ownerChangeAssetActionOutput,
  type AssetActionInput,
  type AssetActionOutput,
  type AssetAuthorizationKind,
} from "@pcash/sdk/builders";
import type { PcashNodeClient, StatusResult } from "@pcash/sdk/clients";
import { fieldToHex } from "@pcash/sdk/crypto";
import { resolveRecipientAddress, resolveRecipientDelivery, parseExtendedCode } from "@pcash/sdk/delivery";
import { directSendsToRecord } from "../directSends.ts";
import { requestPcashAuthorization, type PcashActionSigner, type SelectedRelayQuoteProvider } from "@pcash/sdk/eip712";
import {
  networkConfigFromStatus,
  ownerCommitment,
} from "@pcash/sdk/protocol";
import { addressHex, fromHex, randomFieldEntropy, U128_LIMIT } from "@pcash/sdk/utils";
import { assertReceiveKeyOwned, registeredSelfReceiveKey } from "./selfDelivery.ts";
import type { PcashProfile } from "../externalIdentity.ts";
import { knownAssetDefinition, selectInputNotes, selectSpendableInputNotes, spendableNotes, type WalletFileData } from "../noteStore.ts";
import { loadWalletStateOrEmpty, type WalletStateStore } from "../store.ts";
import {
  collectAssetActionWitnesses,
  prepareAssetAction,
  submitPendingAssetAction,
  submitPreparedAssetAction,
  type AssetActionProver,
  type AssetActionSubmissionResult,
} from "./assetActionClient.ts";
import {
  settlePollOptions,
  type DurableSubmissionAdapter,
  type DurableSubmissionCallbacks,
  type SettlePollOptions,
} from "./durableSubmission.ts";
import {
  actionPublication,
  fixPublication,
  paddedPrivateValueByteSize,
  pendingIssuanceBeneficiary,
  planPublication,
  publicationOf,
  publicationValidUntil,
  transactionNullifiers,
  type ActionPublication,
} from "./publication.ts";

const MAX_NOTE_AMOUNT = U128_LIMIT - 1n;

export interface AssetSendOutput {
  /** Address or extended receive code, as a native payment accepts. */
  to: string;
  amount: bigint;
  /**
   * Open the note to `to` under this secret instead of a fresh one, with no
   * delivery envelope. The caller keeps the opening, as contract inventory does,
   * and the wallet's sender region records it.
   */
  noteSecret?: bigint;
}

export interface AssetTransferIntent extends DurableSubmissionCallbacks {
  /** Finality polling attempts after submission; applications may observe settlement separately. */
  settlePollMaxAttempts?: number;
  accountCreation?: AccountCreationAttachment;
  assetId: bigint;
  outputs: readonly AssetSendOutput[];
  /** Encrypted records for recipients and the sender. */
  data?: TransactionData;
  burnAmount?: bigint;
  openFeeAmount?: bigint;
  privateRelayFeeAmount?: bigint;
  selectedRelayQuote?: SelectedRelayQuoteProvider;
  validUntilTimestamp?: bigint;
  /** Resume one exact journaled payment or burn; no new selection, quote, or proof is made. */
  retryContentHash?: string;
}

type AssetTransferClientParams<Prepared, Output> = AssetTransferIntent & SettlePollOptions & {
  node: PcashNodeClient;
  store: WalletStateStore;
  wallet: PcashProfile;
  signer: PcashActionSigner;
  chainId: bigint;
  prover: AssetActionProver;
  submission: DurableSubmissionAdapter<Prepared, Output>;
};

/** Owner change in note-sized pieces. */
function changeAmounts(amount: bigint): bigint[] {
  const pieces: bigint[] = [];
  for (let remainder = amount; remainder > 0n; remainder -= MAX_NOTE_AMOUNT) {
    pieces.push(remainder > MAX_NOTE_AMOUNT ? MAX_NOTE_AMOUNT : remainder);
  }
  return pieces;
}

/** The fewest largest native notes that cover `fee`: input slots the asset side may not take. */
function feeInputReserve(amounts: readonly bigint[], fee: bigint, maximum: number): number {
  if (fee === 0n) return 0;
  let total = 0n;
  let count = 0;
  for (const amount of [...amounts].sort((a, b) => a > b ? -1 : a < b ? 1 : 0)) {
    if (total >= fee || count === maximum) break;
    total += amount;
    count++;
  }
  return Math.max(1, count);
}

/** Resubmit a journaled payment or burn byte-for-byte once its reviewed terms match the request. */
async function resumeAssetTransfer<Prepared, Output>(
  params: AssetTransferClientParams<Prepared, Output>,
  data: WalletFileData,
  status: StatusResult,
  burnAmount: bigint,
): Promise<AssetActionSubmissionResult<Output> & { publicationDetails: ActionPublication }> {
  const pending = data.pendingAssetActions?.find((item) => item.contentHash.toLowerCase() === params.retryContentHash!.toLowerCase());
  const review = pending?.assetTransferReview;
  if (pending === undefined || review === undefined) throw new Error("retryContentHash does not name a journaled asset payment or burn");
  const transaction = decodeTransaction(fromHex(pending.transactionHex)) as RawPrivateValueTransaction;
  if (BigInt(pending.assetId) !== params.assetId
    || BigInt(review.burnAmount) !== burnAmount
    || review.outputs.length !== params.outputs.length
    || review.outputs.some((output, index) => {
      const requested = params.outputs[index]!;
      return output.to !== requested.to || BigInt(output.amount) !== requested.amount
        || (output.noteSecret === undefined ? requested.noteSecret !== undefined : BigInt(output.noteSecret) !== requested.noteSecret);
    })
    || !sameTransactionData(review.data, params.data)
    || !sameAccountCreation(transaction.accountCreation, params.accountCreation)
    || (params.openFeeAmount !== undefined && BigInt(pending.openFeeAmount) !== params.openFeeAmount)
    || (params.privateRelayFeeAmount !== undefined && BigInt(pending.privateRelayFeeAmount ?? 0n) !== params.privateRelayFeeAmount)
    || (params.validUntilTimestamp !== undefined && BigInt(pending.validUntilTimestamp) !== params.validUntilTimestamp)) {
    throw new Error("journaled asset action differs from the reviewed terms");
  }
  const selected = pending.privateRelayRecipient !== undefined;
  if (publicationOf(params.submission, params.privateRelayFeeAmount ?? BigInt(pending.privateRelayFeeAmount ?? 0n)) !== (selected ? "selected"
    : BigInt(pending.issuanceOwnerCommitment) === 0n ? "open" : "self")) {
    throw new Error("asset action retry uses another publication mode");
  }
  if (selected && params.selectedRelayQuote !== undefined
    && pending.privateRelayRecipient!.toLowerCase() !== addressHex(params.selectedRelayQuote.recipient).toLowerCase()) {
    throw new Error("journaled asset action has another selected relay destination");
  }
  const result = await submitPendingAssetAction({
    node: params.node, store: params.store, data, status, pending,
    submission: params.submission, callbacks: params, ...settlePollOptions(params),
  });
  return { ...result, publicationDetails: actionPublication(pending, pendingIssuanceBeneficiary(pending, params.wallet)) };
}

export async function runAssetTransferClient<Prepared, Output>(
  params: AssetTransferClientParams<Prepared, Output>,
): Promise<AssetActionSubmissionResult<Output> & { publicationDetails: ActionPublication }> {
  const storedData = storeTransactionData(params.data);
  params = { ...params, outputs: structuredClone(params.outputs),
    ...(storedData === undefined ? {} : { data: restoreTransactionData(storedData)! }) };
  const profile = PRIVATE_VALUE_PROFILES.S;
  const burnAmount = params.burnAmount ?? 0n;
  if (params.assetId === 0n) throw new Error("asset actions require a nonzero assetId; send native PCASH as a payment");
  if (params.outputs.length === 0 && burnAmount === 0n) throw new Error("an asset action requires a recipient or a burn");
  const selected = params.selectedRelayQuote !== undefined;
  const outputCapacity = profile.outputs - (selected ? 1 : 0);
  if (params.outputs.length > outputCapacity) {
    throw new Error(`one asset action pays at most ${outputCapacity} recipients; use a bulk job for more`);
  }
  const status = await params.node.status();
  const data = await loadWalletStateOrEmpty(params.store, {
    address: params.wallet.address, network: { chainId: params.chainId, genesisHash: status.genesisHash },
  });
  if (params.retryContentHash !== undefined) return resumeAssetTransfer(params, data, status, burnAmount);
  const plan = await planPublication({
    qualifying: true, byteSize: paddedPrivateValueByteSize(profile.shapeId, params.accountCreation),
    publication: publicationOf(params.submission, params.privateRelayFeeAmount), node: params.node,
    openFeeAmount: params.openFeeAmount, privateRelayFeeAmount: params.privateRelayFeeAmount,
    selectedRelayQuote: params.selectedRelayQuote,
  });
  const assetDefinition = knownAssetDefinition(data, params.assetId);

  const fee = plan.openFeeAmount + plan.privateRelayFeeAmount;
  const assetNeed = params.outputs.reduce((sum, output) => sum + output.amount, burnAmount);
  const nativeSpendable = fee === 0n ? [] : spendableNotes(data, 0n);
  const reserve = feeInputReserve(nativeSpendable.map((note) => BigInt(note.amount)), fee, profile.inputs - 1);
  const assetNotes = selectInputNotes(data, undefined, assetNeed, profile.inputs - reserve, params.assetId);
  const nativeNotes = fee === 0n ? [] : selectSpendableInputNotes(nativeSpendable, fee, profile.inputs - assetNotes.length);
  const inputNotes = [...assetNotes, ...nativeNotes];
  const change = [
    ...changeAmounts(assetNotes.reduce((sum, note) => sum + BigInt(note.amount), 0n) - assetNeed)
      .map((amount) => ({ assetId: params.assetId, amount })),
    ...changeAmounts(nativeNotes.reduce((sum, note) => sum + BigInt(note.amount), 0n) - fee)
      .map((amount) => ({ assetId: 0n, amount })),
  ];
  if (params.outputs.length + change.length > outputCapacity) {
    throw new Error("recipients and change do not fit in one asset action; pay fewer recipients");
  }

  const authorizationKind: AssetAuthorizationKind = params.outputs.length === 0 ? "asset-burn"
    : burnAmount === 0n && params.outputs.length === 1 ? "asset-payment" : "batch-transfer";
  params.onProgress?.("preparing", "reading the registered account…");
  const witnesses = await collectAssetActionWitnesses({
    node: params.node, store: params.store, wallet: params.wallet, authorizationKind,
    inputOpenings: inputNotes.map((note) => ({
      outputIndex: BigInt(note.leafIndex!), outputCommitment: BigInt(note.commitment!),
    })),
  });
  let selfKey: Uint8Array | undefined;
  const selfReceiveKey = () => selfKey ??= registeredSelfReceiveKey(witnesses.account, data);
  const recipients: AssetActionOutput[] = [];
  for (const [outputIndex, output] of params.outputs.entries()) {
    if (output.noteSecret !== undefined) {
      const { recipientAddress } = resolveRecipientAddress(output.to, params.chainId);
      recipients.push(outOfBandAssetActionOutput({
        kind: "asset", recipientAddress, noteSecret: output.noteSecret, amount: output.amount,
      }));
      continue;
    }
    const delivery = await resolveRecipientDelivery(output.to, params.chainId, address =>
      BigInt(address) === params.wallet.address ? selfReceiveKey() : witnesses.receiveKeyOf(address));
    if (delivery.recipientAddress === params.wallet.address && delivery.recipientExtendedCode !== undefined) {
      assertReceiveKeyOwned(data, parseExtendedCode(delivery.recipientExtendedCode).mlKemPublicKey);
    }
    recipients.push(openedAssetActionOutput({
      kind: "asset", pcashChainId: params.chainId, assetId: params.assetId, outputIndex, amount: output.amount,
      ...(assetDefinition === undefined ? {} : { assetDefinition }),
      ...(delivery.recipientExtendedCode === undefined
        ? { recipientAddress: delivery.recipientAddress, recipientMlKemPublicKey: delivery.recipientReceiveKey!, authenticatedRecipient: true as const }
        : { recipientExtendedCode: delivery.recipientExtendedCode }),
    }));
  }


  const dummyInputSeed = randomFieldEntropy();
  const validUntilTimestamp = publicationValidUntil({
    chainNow: witnesses.status.latestBlockTimestamp, defaultWindow: 1800n,
    selectedRelayQuote: params.selectedRelayQuote, requested: params.validUntilTimestamp,
    action: "asset action",
  });
  const publication = await fixPublication({
    maxTransactionBytes: paddedPrivateValueByteSize(profile.shapeId, params.accountCreation),
    selectedRelayQuote: params.selectedRelayQuote, publication: plan.publication, owner: params.wallet,
    requestedCommitment: 0n, node: params.node, status: witnesses.status,
    nullifiers: transactionNullifiers(params.wallet.nkRoot, inputNotes, dummyInputSeed, profile.inputs),
    shape: profile.shapeId, openFeeAmount: plan.openFeeAmount,
    privateRelayFeeAmount: plan.privateRelayFeeAmount, validUntilTimestamp,
  });

  const outputs: AssetActionOutput[] = [
    ...recipients,
    ...change.map((item) => ownerChangeAssetActionOutput({
      kind: item.assetId === 0n ? "native" : "asset", pcashChainId: params.chainId, assetId: item.assetId,
      amount: item.amount, receiveKey: selfReceiveKey(),
    })),
  ];
  while (outputs.length < outputCapacity) {
    outputs.push({ kind: "dummy", dummySecret: randomFieldEntropy(), amount: 0n });
  }
  let privateRelayOwnerCommitment = 0n;
  if (selected) {
    const payment = publication.privateRelayPayment;
    if (payment === undefined) throw new Error("selected relay quote omitted its private relay payment");
    const feeOutput = openedAssetActionOutput({
      kind: "native", pcashChainId: params.chainId, assetId: 0n, outputIndex: profile.outputs - 1,
      amount: payment.amount, recipientAddress: payment.recipientAddress,
      recipientMlKemPublicKey: payment.receiveKey, authenticatedRecipient: true,
    });
    if (feeOutput.kind !== "native" || feeOutput.destination.kind !== "opening") throw new Error("selected relay fee has no owner opening");
    privateRelayOwnerCommitment = ownerCommitment(payment.recipientAddress, feeOutput.destination.noteSecret);
    outputs.push(feeOutput);
  }
  const inputs: AssetActionInput[] = inputNotes.map((note, index) => ({
    kind: BigInt(note.assetId) === 0n ? "native" : "asset", amount: BigInt(note.amount),
    noteSecret: BigInt(note.noteSecret), leafIndex: Number(note.leafIndex!), siblings: witnesses.inputSiblings[index]!,
  }));
  while (inputs.length < profile.inputs) inputs.push({ kind: "dummy" });
  const build = buildAssetAction({
    ...(params.accountCreation === undefined ? {} : { accountCreation: params.accountCreation }),
    pcashChainId: params.chainId, snapshot: witnesses.snapshot, owner: witnesses.owner, assetId: params.assetId,
    assetBurnAmount: burnAmount, inputs, outputs, openFeeAmount: plan.openFeeAmount,
    issuanceOwnerCommitment: publication.issuanceOwnerCommitment,
    ...(publication.designatedIssuanceOpening === undefined ? {} : { designatedIssuanceOpening: publication.designatedIssuanceOpening }),
    ...(selected ? { privateRelayPayment: { amount: plan.privateRelayFeeAmount, ownerCommitment: privateRelayOwnerCommitment } } : {}),
    dummyInputSeed, validUntilTimestamp,
    ...(assetDefinition === undefined ? {} : { assetDefinition }),
    data: await resolveTransactionData(params.data, params.chainId, witnesses.receiveKeyOf),
    sender: {
      outgoingKey: params.wallet.outgoingKey,
      directSendOpenings: directSendsToRecord(data, params.wallet.address, inputNotes),
    },
  });
  const authorization = build.prepareOwnerAuthorization({
    wallet: params.wallet, network: networkConfigFromStatus(witnesses.status),
  });
  const signed = authorization.authorize(await requestPcashAuthorization(params.signer, authorization.request));
  params.onProgress?.("proving", "proving the authorized asset action…");
  const entry = await params.prover.proveAndEncode(build, {
    packageName: authorization.authorizationCircuit, witnessMap: signed.witnessMap,
  });
  const preparedAction = prepareAssetAction({
    build, transactionBytes: entry,
    ...(publication.designatedIssuanceOpening === undefined ? {} : { designatedIssuanceOpening: publication.designatedIssuanceOpening }),
    ...(selected ? { privateRelayRecipient: params.selectedRelayQuote!.recipient, privateRelayFeeAmount: plan.privateRelayFeeAmount } : {}),
    ownedOutputs: change.map((item, offset) => ({
      outputIndex: recipients.length + offset, assetId: item.assetId, amount: item.amount,
      owner: params.wallet.address, noteSecret: build.outputNoteSecrets[recipients.length + offset]!,
    })),
  });
  preparedAction.pending.assetTransferReview = {
    outputs: params.outputs.map((output) => ({
      to: output.to, amount: output.amount.toString(),
      ...(output.noteSecret === undefined ? {} : { noteSecret: fieldToHex(output.noteSecret) }),
    })),
    burnAmount: burnAmount.toString(),
    ...(storedData === undefined ? {} : { data: storedData }),
  };
  const preparedSubmission = await params.submission.preflight({
    transactionBytes: entry, status: witnesses.status, retry: false,
  });
  const result = await submitPreparedAssetAction({
    node: params.node, store: params.store, data, status: witnesses.status, preparedAction,
    submission: params.submission, preparedSubmission, callbacks: params, ...settlePollOptions(params),
  });
  return { ...result, publicationDetails: actionPublication(preparedAction.pending, plan.beneficiary) };
}
