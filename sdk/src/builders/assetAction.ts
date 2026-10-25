import { prepareEvent } from "../protocol/events.ts";
import { PRIVATE_VALUE_PROFILES, privateValueProfile, type PrivateValueShape } from "../constants/privateValueProfiles.ts";
import { authorizationIssuanceOpening } from "../protocol/payout.ts";
import {
  networkForChain,
  type NetworkConfigLike,
} from "../protocol/network.ts";
import {
  AMOUNT_BITS,
  MERKLE_DEPTH,
} from "../constants/params.ts";
import { type FieldNumberish, toAddressField, toField } from "../crypto/field.ts";
import {
  createPcashAuthorizationRequest,
  requirePcashAuthorization,
  type PcashAuthorizationRequest,
  type VerifiedPcashAuthorization,
} from "../eip712/authorization.ts";
import {
  assetCreationTypedData,
  assetBurnTypedData,
  assetPaymentTypedData,
  batchTransferTypedData,
} from "../rules/semanticRules.ts";
import {
  DEFAULT_ASSET_CREATION_RULE_ENTRY_INDEX,
  DEFAULT_LARGE_ASSET_CREATION_RULE_ENTRY_INDEX,
  DEFAULT_LARGE_BATCH_TRANSFER_RULE_ENTRY_INDEX,
  DEFAULT_ASSET_BURN_RULE_ENTRY_INDEX,
  DEFAULT_ASSET_PAYMENT_RULE_ENTRY_INDEX,
  DEFAULT_BATCH_TRANSFER_RULE_ENTRY_INDEX,
  ecdsaRuleConfigurationCommitment,
} from "../rules/referenceRules.ts";
import {
  buildAssetCreationRuleWitness,
  buildAssetBurnRuleWitness,
  buildAssetPaymentRuleWitness,
  buildBatchTransferRuleWitness,
} from "../rules/semanticWitnesses.ts";
import {
  assertAssetAggregate,
  assertAssetAmount,
  assetCreationMarker,
  assetSecretCommitment,
  standardFungibleAssetId,
  type StandardFungibleAssetDescriptor
} from "../protocol/asset.ts";
import { encodePrivateValueTransaction, TX_KIND_PRIVATE_VALUE, type PrivateValueOutputData } from "../protocol/codec.ts";
import { assertOutputDataItems, sizeClassFiller } from "../protocol/envelope.ts";
import { assetDefinitionAssetId } from "../protocol/assetDefinition.ts";
import { assetDefinitionSchema, type SentOpening } from "../protocol/arena.ts";
import { sealSectionDelivery, type EnvelopeOutput } from "../protocol/sectionDelivery.ts";
import {
  applicationNullifier,
  dummyNullifier,
  fullOutputCommitment,
  noteBodyCommitment,
  noteNk,
  nullifier,
  nullifierKeyCommitment,
  ownerChangeNoteSecret,
  ownerCommitment,
} from "../protocol/notes.ts";
import {
  fieldArrayMap,
  fm,
  privateValueChoicesMap,
  ruleStatementMap,
  type WitnessMap,
  zeroFields,
} from "../protocol/witness.ts";
import type { ChonkVkArtifacts } from "../protocol/account.ts";
import {
  assetCreationActionCommitment,
  authorizationCommitment,
  ruleStatement,
  transferActionCommitment,
} from "../protocol/statement.ts";
import {
  absentInputMap,
  authorizedAccountMap,
  inputNoteMap,
  snapshotWitnessMap,
  vkWitnessMap,
} from "./witnessMaps.ts";
import {
  SlotClass,
  privateValueCommitment,
  type PrivateValue,
  type SlotClassValue,
} from "../protocol/transaction.ts";
import { assertArena, deliveryCommitment } from "../protocol/transfer.ts";
import type { WalletProfile } from "../protocol/types.ts";
import { randomFieldEntropy } from "../utils/bytes.ts";
import { requireLength, U128_LIMIT } from "../utils/validate.ts";
import type {
  AssetActionInput,
  AssetActionOutput,
  BuildAssetActionParams,
} from "./assetOutputs.ts";

export interface ResolvedInput {
  kind: AssetActionInput["kind"];
  slotClass: SlotClassValue;
  inputCommitment: bigint;
  nullifier: bigint;
  amount: bigint;
  noteSecret: bigint;
  leafIndex: number;
  siblings: bigint[];
  /** The spent note's owner address; zero for a note-free slot. */
  owner: bigint;
  assetId: bigint;
  replayId: bigint;
}

export interface ResolvedOutput {
  kind: AssetActionOutput["kind"];
  /** Implicit change to the owner: proved under the derived secret, never declared. */
  ownerChange: boolean;
  slotClass: SlotClassValue;
  ownerCommitment: bigint;
  dummySecret: bigint;
  recipient: bigint;
  noteSecret: bigint;
  amount: bigint;
  body: bigint;
  outputData: Uint8Array;
}
/** A note-free input slot: only its class, nullifier, and application replay ID vary. */
function noteFreeInput(
  kind: AssetActionInput["kind"],
  slotClass: SlotClassValue,
  nullifier: bigint,
  replayId = 0n,
): ResolvedInput {
  return {
    kind,
    slotClass,
    inputCommitment: 0n,
    nullifier,
    amount: 0n,
    noteSecret: 0n,
    leafIndex: 0,
    siblings: zeroFields(MERKLE_DEPTH),
    owner: 0n,
    assetId: 0n,
    replayId,
  };
}

function inputMap(input: ResolvedInput, present: boolean): WitnessMap {
  return present ? inputNoteMap(input) : absentInputMap();
}

export interface AssetActionBuild {
  eventOpening: { eventEntry: bigint; eventSalt: bigint; eventsCommitment: bigint };
  shape: PrivateValueShape;
  operation: "transfer" | "assetCreation";
  assetId: bigint;
  /** The acting account's address: the owner of its inputs and change. */
  address: bigint;
  transaction: PrivateValue;
  resolvedInputs: readonly ResolvedInput[];
  resolvedOutputs: readonly ResolvedOutput[];
  privateValueCommitment: bigint;
  publicInputs: bigint[];
  outputData: PrivateValueOutputData;
  arena: Uint8Array;
  /** The exact type-0 transaction bytes for this build's kernel proof. */
  encodeTransaction(proof: Uint8Array): Uint8Array;
  assetBurnAmount: bigint;
  recentPcashBlockHash: bigint;
  pcashChainId: bigint;
  dummyInputSeed: bigint;
  outputOwnerCommitments: readonly bigint[];
  outputDummySecrets: readonly bigint[];
  outputAmounts: readonly bigint[];
  /** Note secret per output slot; zero for dummies. Owner change carries the derived secret. */
  outputNoteSecrets: readonly bigint[];
  buildAssetCreationKernelWitnessMap: (authorizationVk: ChonkVkArtifacts) => WitnessMap;
  buildKernelWitnessMap: (authorizationVk: ChonkVkArtifacts) => WitnessMap;
  prepareOwnerAuthorization: (params: OwnerAuthorizationParams) => PreparedOwnerAuthorization;
}

export type AssetAuthorizationKind = "asset-creation" | "asset-payment" | "asset-burn" | "batch-transfer";

export interface OwnerAuthorizationParams {
  wallet: WalletProfile;
  network?: NetworkConfigLike;
}

export interface PreparedOwnerAuthorization {
  authorizationKind: AssetAuthorizationKind;
  authorizationCircuit:
    | "account_rule_asset_creation_ecdsa"
    | "account_rule_large_asset_creation_ecdsa"
    | "account_rule_large_batch_transfer_ecdsa"
    | "account_rule_asset_payment_ecdsa"
    | "account_rule_asset_burn_ecdsa"
    | "account_rule_batch_transfer_ecdsa";
  request: PcashAuthorizationRequest;
  authorize: (authorization: VerifiedPcashAuthorization) => {
    witnessMap: Record<string, unknown>;
  };
}

export interface AssetActionInputNullifierParams {
  owner: Pick<BuildAssetActionParams["owner"], "address" | "nkRoot">;
  assetId: bigint;
  inputs: readonly AssetActionInput[];
  dummyInputSeed: FieldNumberish;
  nativeFeePayer?: boolean;
  assetSecret?: bigint;
}

/** The ordered input nullifiers used by the action builder, before outputs exist. */
export function assetActionInputNullifiers(params: AssetActionInputNullifierParams): bigint[] {
  return resolveAssetActionInputs(params).map((input) => input.nullifier);
}

function resolveAssetActionInputs(params: AssetActionInputNullifierParams): ResolvedInput[] {
  const assetId = toField(params.assetId, "assetId");
  const dummyInputSeed = toField(params.dummyInputSeed, "dummyInputSeed");
  const nativeFeePayer = params.nativeFeePayer === true;
  const address = toAddressField(params.owner.address, "owner.address");
  const inputNk = noteNk(params.owner.nkRoot);
  return params.inputs.map((input, slot) => {
    if (input.kind === "dummy") return noteFreeInput(input.kind, SlotClass.DUMMY, dummyNullifier(dummyInputSeed, slot));
    if (input.kind === "application") {
      const replayId = toField(input.replayId, "replayId");
      const entry = toField(input.selectedEntryCommitment, "selectedEntryCommitment");
      return noteFreeInput(input.kind, SlotClass.APPLICATION, applicationNullifier(address, entry, replayId), replayId);
    }
    if (input.kind === "creation-marker") {
      if (params.assetSecret === undefined) throw new Error("a creation marker input requires assetSecret");
      return noteFreeInput(input.kind, SlotClass.ASSET_CREATION, assetCreationMarker(assetId, params.assetSecret));
    }
    requireLength(input.siblings, MERKLE_DEPTH, `${input.kind} input siblings`);
    if (input.kind === "asset") assertAssetAmount(input.amount, `${input.kind} input amount`);
    else if (input.amount <= 0n || input.amount >= (1n << BigInt(AMOUNT_BITS))) throw new Error(`${input.kind} input amount must be in 1..2^${AMOUNT_BITS}-1`);
    const noteSecret = toField(input.noteSecret, `${input.kind} noteSecret`);
    const id = input.kind === "asset" ? assetId : 0n;
    const override = input.kind === "native" ? input : undefined;
    if ((override?.owner === undefined) !== (override?.nk === undefined)) throw new Error("an input owner override requires its nullifier key");
    if (override?.owner !== undefined && !nativeFeePayer) throw new Error("input owner overrides are only valid under a separate fee payer");
    const slotOwner = override?.owner === undefined ? address : toAddressField(override.owner, "input owner");
    const slotNk = override?.nk === undefined ? inputNk : toField(override.nk, "input nk");
    const commitment = fullOutputCommitment({ owner: slotOwner, noteSecret, assetId: id, amount: input.amount }, input.leafIndex);
    return {
      kind: input.kind,
      slotClass: input.kind === "asset" ? SlotClass.ASSET : SlotClass.NATIVE,
      inputCommitment: commitment,
      nullifier: nullifier(commitment, slotNk, noteSecret),
      amount: input.amount,
      noteSecret,
      leafIndex: input.leafIndex,
      siblings: input.siblings.map((value) => toField(value)),
      owner: slotOwner,
      assetId: id,
      replayId: 0n,
    };
  });
}

export function buildAssetAction(params: BuildAssetActionParams): AssetActionBuild {
  // The sponsored-transfer kernel authenticates both authorizing accounts, so
  // this transfer-kernel account opening stays absent on that path.
  const nativeFeePayer = params.nativeFeePayer === true;
  const shape = params.shape ?? PRIVATE_VALUE_PROFILES.S.shapeId;
  const profile = privateValueProfile(shape);
  const large = shape === PRIVATE_VALUE_PROFILES.L.shapeId;
  if (params.inputs.length !== profile.inputs) throw new Error(`asset action must contain exactly ${profile.inputs} inputs`);
  if (params.outputs.length !== profile.outputs) throw new Error(`asset action must contain exactly ${profile.outputs} outputs`);
  const pcashChainId = toField(params.pcashChainId, "pcashChainId");
  const recent = toField(params.snapshot.recentPcashBlockHash, "recentPcashBlockHash");
  const assetInputCount = params.inputs.filter((input) => input.kind === "asset").length;
  const markerCount = params.inputs.filter((input) => input.kind === "creation-marker").length;
  const operation = params.assetDescriptor !== undefined || markerCount > 0 ? "assetCreation" : "transfer";
  let assetId: bigint;
  let assetSecret = 0n;
  let creationDescriptor: StandardFungibleAssetDescriptor | null = null;
  if (operation === "transfer") {
    if (params.assetId === undefined) throw new Error("asset transfer requires assetId");
    assetId = toField(params.assetId, "assetId");
    if (assetId === 0n && (assetInputCount > 0 || params.outputs.some(output => output.kind === "asset"))) {
      throw new Error("asset slots require a nonzero assetId");
    }
    if (params.assetDescriptor !== undefined || params.assetSecret !== undefined) {
      throw new Error("asset transfer does not accept an asset definition");
    }
  } else {
    if (params.assetDescriptor === undefined || params.assetSecret === undefined) {
      throw new Error("asset creation requires assetDescriptor and assetSecret");
    }
    creationDescriptor = params.assetDescriptor;
    assetId = standardFungibleAssetId(creationDescriptor);
    if (toField(creationDescriptor.assetId, "assetDescriptor.assetId") !== assetId) {
      throw new Error("asset descriptor does not match its assetId");
    }
    assetSecret = toField(params.assetSecret, "assetSecret");
  }
  if (operation === "transfer" && markerCount !== 0) {
    throw new Error("asset transfer cannot contain a creation marker");
  }
  if (operation === "assetCreation" && markerCount !== 1) {
    throw new Error("asset creation requires exactly one creation marker");
  }
  if (operation === "assetCreation") {
    if (assetSecretCommitment(assetSecret)
      !== toField(creationDescriptor!.assetSecretCommitment)) {
      throw new Error("asset secret does not match the asset descriptor");
    }
  }
  const assetBurnAmount = params.assetBurnAmount ?? 0n;
  assertAssetAggregate(assetBurnAmount, "assetBurnAmount");
  if (operation === "assetCreation" && assetBurnAmount !== 0n) {
    throw new Error("asset creation cannot burn");
  }
  const dummyInputSeed = toField(params.dummyInputSeed ?? randomFieldEntropy(), "dummyInputSeed");

  const owner = params.owner;
  const nativeInputMask = params.inputs.reduce(
    (mask, input, slot) => mask + (input.kind === "native" ? 1n << BigInt(slot) : 0n),
    0n,
  );
  const nativeOutputMask = params.outputs.reduce(
    (mask, output, slot) => mask + (output.kind === "native" ? 1n << BigInt(slot) : 0n),
    0n,
  );
  const hasNative = nativeInputMask !== 0n || nativeOutputMask !== 0n || params.openFeeAmount !== 0n;
  if (hasNative && nativeInputMask === 0n) {
    throw new Error("native effects and fees require a real native input");
  }
  const address = toAddressField(owner.address, "owner.address");
  const resolvedInputs = resolveAssetActionInputs({
    owner, assetId, inputs: params.inputs, dummyInputSeed, nativeFeePayer,
    ...(operation === "assetCreation" ? { assetSecret } : {}),
  });
  const nullifiers = resolvedInputs.map((input) => input.nullifier);
  const relaySlot = params.privateRelayPayment === undefined ? undefined : profile.outputs - 1;
  const envelopeOutputs: EnvelopeOutput[] = [];
  const sentOpenings: SentOpening[] = [];
  const resolvedOutputs: ResolvedOutput[] = params.outputs.map((output, slot) => {
    if (output.kind === "dummy") {
      const dummySecret = toField(output.dummySecret, `outputs[${slot}].dummySecret`);
      if (output.amount !== 0n) throw new Error("dummy output amount must be zero");
      const dummyCommitment = ownerCommitment(0n, dummySecret);
      return {
        kind: output.kind,
        ownerChange: false,
        slotClass: SlotClass.DUMMY,
        ownerCommitment: dummyCommitment,
        dummySecret,
        recipient: 0n,
        noteSecret: 0n,
        amount: 0n,
        body: noteBodyCommitment(dummyCommitment, 0n, 0n),
        outputData: output.outputData ?? sizeClassFiller(),
      };
    }
    const id = output.kind === "asset" ? assetId : 0n;
    if (output.kind === "asset") {
      assertAssetAmount(output.amount, `outputs[${slot}].amount`);
    } else if (output.amount <= 0n || output.amount >= (1n << BigInt(AMOUNT_BITS))) {
      throw new Error(`outputs[${slot}].amount must be in 1..2^${AMOUNT_BITS}-1`);
    }
    const slotClass = output.kind === "asset" ? SlotClass.ASSET : SlotClass.NATIVE;
    if (output.destination.kind === "owner-change") {
      // Owner change opens under the secret the readable rules derive in-circuit,
      // so the owner recomputes it from `nkRoot` and the published nullifiers.
      if (output.delivery.kind !== "owner-change-encrypted") {
        throw new Error(`outputs[${slot}] owner change requires owner-change delivery`);
      }
      if (output.delivery.pcashChainId !== pcashChainId) {
        throw new Error(`outputs[${slot}] owner change delivery uses another PCASH chain`);
      }
      if (output.delivery.assetId !== id) {
        throw new Error(`outputs[${slot}] owner change delivery uses another asset namespace`);
      }
      const secret = ownerChangeNoteSecret(owner.nkRoot, nullifiers, slot, shape);
      const commitment = ownerCommitment(address, secret);
      envelopeOutputs.push({
        slot,
        receiveKey: output.delivery.receiveKey,
        recipientAddress: address,
        note: { chainId: pcashChainId, assetId: id, amount: output.amount, owner: address, noteSecret: secret },
        records: output.delivery.assetDefinition === undefined ? [] : [assetDefinitionSchema.encode(output.delivery.assetDefinition)],
      });
      return {
        kind: output.kind,
        ownerChange: true,
        slotClass,
        ownerCommitment: commitment,
        dummySecret: 0n,
        recipient: address,
        noteSecret: secret,
        amount: output.amount,
        body: noteBodyCommitment(commitment, id, output.amount),
        outputData: new Uint8Array(0),
      };
    }
    if (output.delivery.kind === "owner-change-encrypted") {
      throw new Error(`outputs[${slot}] owner-change delivery requires an owner-change destination`);
    }
    const openedNoteSecret = output.destination.kind === "opening"
      ? toField(output.destination.noteSecret, `outputs[${slot}].destination.noteSecret`)
      : 0n;
    const recipient = output.destination.kind === "opening"
      ? toAddressField(output.destination.recipientAddress, `outputs[${slot}].destination.recipientAddress`)
      : 0n;
    const resolvedOwnerCommitment = output.destination.kind === "opening"
      ? ownerCommitment(recipient, openedNoteSecret)
      : toField(output.destination.ownerCommitment, `outputs[${slot}].destination.ownerCommitment`);
    if (output.delivery.kind === "canonical-encrypted") {
      if (output.destination.kind !== "opening") {
        throw new Error(`outputs[${slot}] canonical delivery requires an opened destination`);
      }
      if (output.delivery.pcashChainId !== pcashChainId) {
        throw new Error(`outputs[${slot}] canonical delivery uses another PCASH chain`);
      }
      if (output.delivery.assetId !== id) {
        throw new Error(`outputs[${slot}] canonical delivery uses another asset namespace`);
      }
      if (output.delivery.outputIndex !== slot) {
        throw new Error(`outputs[${slot}] canonical delivery uses the wrong output index`);
      }
      if (output.outputData !== undefined) {
        throw new Error(`outputs[${slot}] canonical delivery is sealed by the builder`);
      }
      envelopeOutputs.push({
        slot,
        receiveKey: output.delivery.receiveKey,
        recipientAddress: recipient,
        note: {
          chainId: pcashChainId,
          assetId: id,
          amount: output.amount,
          owner: recipient,
          noteSecret: openedNoteSecret,
        },
        records: output.delivery.assetDefinition === undefined ? [] : [assetDefinitionSchema.encode(output.delivery.assetDefinition)],
        ...(output.delivery.change === true || slot === relaySlot ? {} : { sentTo: recipient }),
      });
    } else if (output.delivery.kind === "recipient-supplied") {
      if (output.destination.kind !== "recipient-commitment") {
        throw new Error(`outputs[${slot}] recipient delivery requires a recipient commitment`);
      }
    } else if (output.delivery.kind === "out-of-band") {
      if (output.destination.kind !== "opening") {
        throw new Error(`outputs[${slot}] out-of-band delivery requires an opened destination`);
      }
      if (slot !== relaySlot) {
        sentOpenings.push({ slot, recipientAddress: recipient, assetId: id, amount: output.amount, noteSecret: openedNoteSecret });
      }
    } else if (output.destination.kind !== "raw-commitment") {
      throw new Error(`outputs[${slot}] unsafe raw delivery requires a raw commitment`);
    }
    return {
      kind: output.kind,
      ownerChange: false,
      slotClass,
      ownerCommitment: resolvedOwnerCommitment,
      dummySecret: 0n,
      recipient,
      noteSecret: openedNoteSecret,
      amount: output.amount,
      body: noteBodyCommitment(resolvedOwnerCommitment, id, output.amount),
      outputData: output.delivery.kind === "canonical-encrypted" ? new Uint8Array(0) : output.outputData ?? sizeClassFiller(),
    };
  });
  if (params.assetDefinition !== undefined && (assetId === 0n || assetDefinitionAssetId(params.assetDefinition) !== assetId)) {
    throw new Error("assetDefinition must derive the action's nonzero assetId");
  }
  const delivery = sealSectionDelivery({
    shape,
    context: { chainId: pcashChainId, transactionType: TX_KIND_PRIVATE_VALUE, nullifiers },
    envelopes: envelopeOutputs,
    data: params.data,
    freeSlots: params.outputs.flatMap((output, slot) => output.kind === "dummy" && output.outputData === undefined ? [slot] : []),
    ...(params.sender === undefined ? {} : { sender: params.sender }),
    sentOpenings,
    ...(params.assetDefinition === undefined ? {} : { assetDefinition: params.assetDefinition }),
  });
  for (const [slot, envelope] of delivery.envelopes) resolvedOutputs[slot]!.outputData = envelope;
  const arena = delivery.arena;
  const outputData = resolvedOutputs.map((output) => output.outputData);
  assertOutputDataItems(outputData, shape);
  assertArena(arena, shape);
  const deliveryCommitmentValue = deliveryCommitment(outputData, arena);

  const openFeeAmount = params.openFeeAmount;
  if (openFeeAmount < 0n || openFeeAmount >= (1n << BigInt(AMOUNT_BITS))) {
    throw new Error(`openFeeAmount must be in 0..2^${AMOUNT_BITS}-1`);
  }
  const issuanceOwnerCommitment = toField(params.issuanceOwnerCommitment, "issuanceOwnerCommitment");
  if (issuanceOwnerCommitment !== 0n && openFeeAmount !== 0n) throw new Error("designated issuance cannot coexist with an open fee");
  const relayPayment = params.privateRelayPayment;
  const relayOutput = resolvedOutputs[profile.outputs - 1]!;
  if (relayPayment !== undefined && (relayPayment.amount <= 0n || relayOutput.kind !== "native"
    || relayOutput.amount !== relayPayment.amount
    || relayOutput.ownerCommitment !== toField(relayPayment.ownerCommitment, "privateRelayPayment.ownerCommitment")
    || relayOutput.ownerChange)) {
    throw new Error("private relay payment must match the final native output");
  }
  const { issuanceRecipient, issuanceNoteSecret, transactionContext } = authorizationIssuanceOpening(issuanceOwnerCommitment, pcashChainId, nullifiers, params.designatedIssuanceOpening, shape);
  const carrierContextHash = toField(params.carrierContextHash ?? 0n, "carrierContextHash");
  const transaction: PrivateValue = {
    global: {
      openFeeAmount,
      issuanceOwnerCommitment,
      notBeforeTimestamp: toField(params.notBeforeTimestamp ?? 0n),
      validUntilTimestamp: toField(params.validUntilTimestamp),
      carrierContextHash,
      assetBurnAmount,
      deliveryCommitment: deliveryCommitmentValue,
    },
    inputs: resolvedInputs.map((input) => ({
      slotClass: input.slotClass,
      inputCommitment: input.inputCommitment,
      nullifier: input.nullifier,
    })),
    outputs: resolvedOutputs.map((output) => ({
      slotClass: output.slotClass,
      outputBodyCommitment: output.body,
    })),
  };
  const pvCommitment = privateValueCommitment(transaction, shape);

  const assetInputTotal = resolvedInputs.reduce(
    (sum, input) => sum + (input.kind === "asset" ? input.amount : 0n),
    0n,
  );
  const assetOutputTotal = resolvedOutputs.reduce(
    (sum, output) => sum + (output.kind === "asset" ? output.amount : 0n),
    0n,
  );
  assertAssetAggregate(assetInputTotal, "asset input total");
  assertAssetAggregate(assetOutputTotal, "asset output total");
  if (operation === "transfer" && assetInputTotal !== assetOutputTotal + assetBurnAmount) {
    throw new Error("asset inputs must equal asset outputs plus assetBurnAmount");
  }
  const nativeInputTotal = resolvedInputs.reduce((sum, input) => sum + (input.kind === "native" ? input.amount : 0n), 0n);
  const nativeOutputTotal = resolvedOutputs.reduce((sum, output) => sum + (output.kind === "native" ? output.amount : 0n), 0n);
  if (nativeInputTotal !== nativeOutputTotal + openFeeAmount) throw new Error("native inputs must equal native outputs plus openFeeAmount");
  if (operation === "assetCreation") {
    const initialSupply = toField(creationDescriptor!.initialSupply, "initialSupply");
    if (assetOutputTotal !== initialSupply) {
      throw new Error("asset creation outputs must equal initialSupply");
    }
    if (assetOutputTotal === 0n) throw new Error("asset creation requires an asset output");
  }
  const eventOpening = prepareEvent(params);
  const publicInputs = [
    pcashChainId,
    recent,
    ...resolvedInputs.map((input) => input.nullifier),
    ...resolvedOutputs.map((output) => output.body),
    deliveryCommitmentValue,
    openFeeAmount,
    issuanceOwnerCommitment,
    toField(params.notBeforeTimestamp ?? 0n),
    toField(params.validUntilTimestamp),
    carrierContextHash,
    eventOpening.eventsCommitment,
  ];

  const prepareReadableOwnerAuthorization = (
    authorizationParams: OwnerAuthorizationParams,
  ): PreparedOwnerAuthorization => {
    if (transaction.inputs.some((input) =>
      input.slotClass === SlotClass.APPLICATION || (operation !== "assetCreation" && input.slotClass === SlotClass.ASSET_CREATION))) {
      throw new Error("semantic owner authorization does not cover application or creation markers");
    }
    const wallet = authorizationParams.wallet;
    if (toField(owner.address) !== wallet.address || toField(owner.nkRoot) !== wallet.nkRoot) {
      throw new Error("authorization wallet does not match the owner account");
    }
    const network = networkForChain(pcashChainId, authorizationParams.network);
    if (
      ecdsaRuleConfigurationCommitment(network, nullifierKeyCommitment(wallet.nkRoot))
      !== toField(owner.rule.configurationCommitment)
    ) {
      throw new Error("semantic rule configuration does not match the owner account");
    }
    for (let i = 0;i < resolvedOutputs.length;i++) {
      const output = resolvedOutputs[i]!;
      // The readable messages declare every output by address; an output
      // without an opened, nonzero recipient has nothing to declare.
      if (output.kind !== "dummy" && output.recipient === 0n) {
        throw new Error(`readable authorization requires output ${i} recipient address`);
      }
    }
    const outputs = resolvedOutputs.map((output) => output.kind === "dummy"
      ? { recipient: 0n, amount: 0n, assetId: 0n }
      : {
        recipient: output.recipient,
        amount: output.amount,
        assetId: output.kind === "asset" ? assetId : 0n,
      });
    const firstAssetInput = resolvedInputs.find((input) => input.kind === "asset");
    const assetNamespaceOpening = assetBurnAmount !== 0n
      && !resolvedOutputs.some((output) => output.kind === "asset")
      && firstAssetInput !== undefined
      ? {
        ownerCommitment: ownerCommitment(firstAssetInput.owner, firstAssetInput.noteSecret),
        amount: firstAssetInput.amount,
        leafIndex: firstAssetInput.leafIndex,
      }
      : undefined;
    // Owner change is proved, not signed: it carries no declaration, so private
    // change stays out of the typed data. An opened output to the owner's own
    // address is an explicit self-payment and stays declared like any recipient.
    const isOwnerChange = (index: number) => resolvedOutputs[index]?.ownerChange === true;
    // The readable rules prove one split of owner change per namespace, so the
    // owner can recompute each amount: every change note but the last holds the
    // largest note amount. Refuse another split here, before a signature is
    // requested for a transaction the rule cannot prove.
    const lastChange: Partial<Record<"native" | "asset", { slot: number; amount: bigint }>> = {};
    resolvedOutputs.forEach((output, slot) => {
      if (output.kind === "dummy" || !isOwnerChange(slot)) return;
      const earlier = lastChange[output.kind];
      if (earlier !== undefined && earlier.amount !== U128_LIMIT - 1n) {
        throw new Error(
          `outputs[${slot}] is ${output.kind} owner change after outputs[${earlier.slot}], which is below the largest note amount; `
          + "split owner change into full-size notes followed by one remainder",
        );
      }
      lastChange[output.kind] = { slot, amount: output.amount };
    });

    const declaredOutputs = outputs.map((output, index) =>
      isOwnerChange(index) || (relayPayment !== undefined && index === profile.outputs - 1)
        ? { recipient: 0n, amount: 0n, assetId: 0n }
        : output) as typeof outputs;
    const externalOutputIndices = resolvedOutputs.flatMap((output, index) =>
      output.kind !== "dummy"
        && !isOwnerChange(index)
        && !(relayPayment !== undefined && index === profile.outputs - 1)
        ? [index]
        : []);
    const authorizationKind = operation === "assetCreation"
      ? "asset-creation"
      : large ? "batch-transfer"
      : assetBurnAmount !== 0n && externalOutputIndices.length === 0
      ? "asset-burn"
      : assetBurnAmount === 0n
          && externalOutputIndices.length === 1
          && externalOutputIndices[0] === 0
          && resolvedOutputs[0]!.kind === "asset"
        ? "asset-payment"
        : "batch-transfer";
    const rules: Record<AssetAuthorizationKind, {
      entryIndex: number;
      authorizationCircuit: PreparedOwnerAuthorization["authorizationCircuit"];
    }> = {
      "asset-creation": large
        ? { entryIndex: DEFAULT_LARGE_ASSET_CREATION_RULE_ENTRY_INDEX, authorizationCircuit: "account_rule_large_asset_creation_ecdsa" }
        : { entryIndex: DEFAULT_ASSET_CREATION_RULE_ENTRY_INDEX, authorizationCircuit: "account_rule_asset_creation_ecdsa" },
      "asset-payment": { entryIndex: DEFAULT_ASSET_PAYMENT_RULE_ENTRY_INDEX, authorizationCircuit: "account_rule_asset_payment_ecdsa" },
      "asset-burn": { entryIndex: DEFAULT_ASSET_BURN_RULE_ENTRY_INDEX, authorizationCircuit: "account_rule_asset_burn_ecdsa" },
      "batch-transfer": large
        ? { entryIndex: DEFAULT_LARGE_BATCH_TRANSFER_RULE_ENTRY_INDEX, authorizationCircuit: "account_rule_large_batch_transfer_ecdsa" }
        : { entryIndex: DEFAULT_BATCH_TRANSFER_RULE_ENTRY_INDEX, authorizationCircuit: "account_rule_batch_transfer_ecdsa" },
    };
    const rule = rules[authorizationKind];
    if (owner.rule.entryIndex !== rule.entryIndex) {
      throw new Error(
        `${authorizationKind} requires default rule entry ${rule.entryIndex}, got ${owner.rule.entryIndex}`,
      );
    }
    const commonMessage = {
      pcashChainId,
      assetId,
      openFeeAmount,
      issuanceRecipient,
      issuanceOwnerCommitment,
      relayFeeAmount: relayPayment?.amount ?? 0n,
      relayFeeOwnerCommitment: relayPayment?.ownerCommitment ?? 0n,
      transactionContext,
      notBefore: toField(params.notBeforeTimestamp ?? 0n),
      validUntil: toField(params.validUntilTimestamp),
    };
    const ruleContext = {
      network,
      wallet,
      recentPcashBlockHash: recent,
      eventEntry: eventOpening.eventEntry,
      nkRoot: wallet.nkRoot,
      transaction,
      issuanceNoteSecret,
    };
    const ownerChangeAmounts = resolvedOutputs.map((output, index) => isOwnerChange(index) ? output.amount : 0n);
    const outputNoteSecrets = resolvedOutputs.map((output, index) =>
      isOwnerChange(index) || (relayPayment !== undefined && index === profile.outputs - 1) ? 0n : output.noteSecret);
    /** One signature request under the selected rule, and its rule witness once signed. */
    const prepared = (
      typedData: PcashAuthorizationRequest["typedData"],
      ruleWitness: (authorization: VerifiedPcashAuthorization) => { witnessMap: Record<string, unknown> },
    ): PreparedOwnerAuthorization => {
      const request = createPcashAuthorizationRequest({
        kind: authorizationKind,
        authorizingAddress: wallet.address,
        typedData,
      });
      return {
        authorizationKind,
        authorizationCircuit: rule.authorizationCircuit,
        request,
        authorize: (authorization) => ruleWitness(requirePcashAuthorization(request, authorization)),
      };
    };
    if (authorizationKind === "asset-creation") {
      const descriptor = creationDescriptor!;
      const message = {
        ...commonMessage,
        metadataCommitment: toField(descriptor.metadataCommitment),
        initialSupply: toField(descriptor.initialSupply),
        assetSecretCommitment: toField(descriptor.assetSecretCommitment),
        outputs: declaredOutputs,
      };
      return prepared(
        assetCreationTypedData(network, message, shape),
        (authorization) => buildAssetCreationRuleWitness({
          ...ruleContext,
          shape,
          authorization,
          message,
          outputNoteSecrets,
          ownerChangeAmounts,
        }),
      );
    }
    if (authorizationKind === "asset-payment") {
      const output = resolvedOutputs[0]!;
      const message = {
        ...commonMessage,
        recipient: output.recipient,
        amount: output.amount,
      };
      return prepared(
        assetPaymentTypedData(network, message),
        (authorization) => buildAssetPaymentRuleWitness({
          ...ruleContext,
          authorization,
          message,
          recipientNoteSecret: output.noteSecret,
          changeAmounts: ownerChangeAmounts,
        }),
      );
    }
    if (authorizationKind === "asset-burn") {
      const message = {
        ...commonMessage,
        burnAmount: assetBurnAmount,
      };
      return prepared(
        assetBurnTypedData(network, message),
        (authorization) => buildAssetBurnRuleWitness({
          ...ruleContext,
          authorization,
          message,
          changeAmounts: ownerChangeAmounts,
          assetNamespaceOpening,
        }),
      );
    }
    const message = {
      ...commonMessage,
      assetId: assetInputTotal === 0n && assetBurnAmount === 0n ? 0n : assetId,
      assetBurnAmount,
      outputs: declaredOutputs,
    };
    return prepared(
      batchTransferTypedData(network, message, shape),
      (authorization) => buildBatchTransferRuleWitness({
        ...ruleContext,
        shape,
        authorization,
        message,
        outputNoteSecrets,
        ownerChangeAmounts,
        assetNamespaceOpening,
      }),
    );
  };

  const outputOwnerCommitments = resolvedOutputs.map((output) => output.ownerCommitment);
  const outputDummySecrets = resolvedOutputs.map((output) => output.dummySecret);
  const outputAmounts = resolvedOutputs.map((output) => output.amount);
  // The witnesses both one-account asset kernels derive the private value
  // from, and the rule statement for the kernel's own action.
  const kernelPrivateValueMap = (actionCommitment: bigint): WitnessMap => ({
    event_salt: fm(eventOpening.eventSalt),
    pcash_chain_id: fm(pcashChainId),
    recent_pcash_block_hash: fm(recent),
    choices: privateValueChoicesMap(transaction),
    output_owner_commitments: fieldArrayMap(outputOwnerCommitments),
    output_dummy_secrets: fieldArrayMap(outputDummySecrets),
    output_amounts: fieldArrayMap(outputAmounts),
    dummy_input_seed: fm(dummyInputSeed),
    replay_ids: fieldArrayMap(resolvedInputs.map((input) => input.replayId)),
    ...snapshotWitnessMap(params.snapshot),
    account: authorizedAccountMap(owner),
    account_kind: fm(owner.accountKind),
    rule_statement: ruleStatementMap(ruleStatement(
      authorizationCommitment(address, owner.rule.configurationCommitment),
      actionCommitment,
      recent,
      eventOpening.eventEntry,
    )),
  });
  return {
    shape,
    operation,
    assetId,
    address,
    transaction,
    resolvedInputs,
    resolvedOutputs,
    privateValueCommitment: pvCommitment,
    eventOpening,
    publicInputs,
    outputData,
    arena,
    encodeTransaction: (proof) => encodePrivateValueTransaction({ shape, publicInputs, proof, outputData, arena }),
    assetBurnAmount,
    recentPcashBlockHash: recent,
    pcashChainId,
    dummyInputSeed,
    outputOwnerCommitments,
    outputDummySecrets,
    outputAmounts,
    outputNoteSecrets: resolvedOutputs.map((output) => output.noteSecret),
    buildAssetCreationKernelWitnessMap(authorizationVk) {
      if (operation !== "assetCreation") throw new Error("asset-creation kernel is absent");
      const authorizationVkMap = vkWitnessMap(authorizationVk, "asset-creation authorization");
      return {
        ...kernelPrivateValueMap(assetCreationActionCommitment(pcashChainId, pvCommitment, assetId)),
        metadata_commitment: fm(creationDescriptor!.metadataCommitment),
        initial_supply: fm(creationDescriptor!.initialSupply),
        asset_secret: fm(assetSecret),
        native_inputs: resolvedInputs.map((input) => inputMap(input, input.kind === "native")),
        authorization_vk: authorizationVkMap,
      };
    },
    buildKernelWitnessMap(authorizationVk) {
      if (operation !== "transfer" || nativeFeePayer) {
        throw new Error("asset creation and sponsored transfers use dedicated CHONK kernels");
      }
      const authorizationVkMap = vkWitnessMap(authorizationVk, "authorization");
      return {
        ...kernelPrivateValueMap(transferActionCommitment(pcashChainId, pvCommitment)),
        asset_id: fm(assetId),
        owner_inputs: resolvedInputs.map((input) => inputMap(input, input.kind === "asset" || input.kind === "native")),
        authorization_vk: authorizationVkMap,
      };
    },
    prepareOwnerAuthorization(authorizationParams) {
      return prepareReadableOwnerAuthorization(authorizationParams);
    },
  };
}
