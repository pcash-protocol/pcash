import { prepareEvent, type EventOptions } from "../protocol/events.ts";
import { authorizationIssuanceOpening, type DesignatedIssuanceOpening } from "../protocol/payout.ts";
// The native fee payment every fee-bearing account action carries.
//
// One payer's native notes leave only as the public fee and at most one change
// note back to the payer. The result is a complete private-value transaction
// (four inputs, five outputs) whose section is wire-identical to a type-0
// payload, so the same codec, node checks, and effects apply. Mirrors
// `circuits/protocol/lib/src/ledger/fee_payment.nr`.

import { type FieldNumberish, toField } from "../crypto/field.ts";
import { uintBelow, U64_LIMIT, U128_LIMIT, U160_LIMIT } from "../utils/validate.ts";
import { randomFieldEntropy } from "../utils/bytes.ts";
import { MERKLE_DEPTH } from "../constants/params.ts";
import { PRIVATE_VALUE_PROFILES } from "../constants/privateValueProfiles.ts";
import {
  dummyNullifier,
  fullOutputCommitment,
  noteBodyCommitment,
  noteNk,
  nullifier,
  ownerChangeNoteSecret,
  ownerCommitment,
} from "../protocol/notes.ts";
import { assertOutputDataItems, sizeClassFiller } from "../protocol/envelope.ts";
import type {
  PrivateValueOutputData,
  PrivateValueOutputDataOverrides,
  TX_KIND_CONTRACT_ACCOUNT_CREATION,
  TX_KIND_USER_ACCOUNT_UPDATE,
} from "../protocol/codec.ts";
import { sealSectionDelivery, type ArenaSender, type EnvelopeOutput } from "../protocol/sectionDelivery.ts";
import { assertArena, deliveryCommitment } from "../protocol/transfer.ts";
import {
  SlotClass,
  privateValueCommitment,
  type PrivateValue,
  type PrivateValueInput,
  type PrivateValueOutput,
} from "../protocol/transaction.ts";
import { fieldArrayMap, fm, privateValueChoicesMap, type WitnessMap } from "../protocol/witness.ts";
import { absentInputMap, inputNoteMap } from "./witnessMaps.ts";

const N_IN = 4;
const N_OUT = 5;

/** One of the payer's native notes, opened against the recent block's output root. */
export interface FeePaymentNoteInput {
  noteSecret: FieldNumberish;
  amount: bigint;
  leafIndex: number;
  siblings: readonly FieldNumberish[];
}

export interface NativeFeePaymentParams extends EventOptions {
  /** The transaction whose fee section this is: its arena context names the type. */
  transactionType: typeof TX_KIND_CONTRACT_ACCOUNT_CREATION | typeof TX_KIND_USER_ACCOUNT_UPDATE;
  pcashChainId: FieldNumberish;
  recentPcashBlockHash: FieldNumberish;
  payer: {
    address: FieldNumberish;
    nkRoot: FieldNumberish;
    /** Encrypts the change note to the payer; without it the change slot carries filler. */
    receiveKey?: Uint8Array;
  };
  /** Up to four native notes; their total less the fee returns as change. */
  inputs: readonly FeePaymentNoteInput[];
  openFeeAmount: FieldNumberish;
  /** Ordinary private native-PCASH output to an authenticated selected relayer. */
  privateRelayPayment?: { recipientAddress: FieldNumberish; receiveKey: Uint8Array; amount: FieldNumberish };
  issuanceOwnerCommitment?: FieldNumberish;
  designatedIssuanceOpening?: DesignatedIssuanceOpening;
  notBeforeTimestamp?: FieldNumberish;
  validUntilTimestamp: FieldNumberish;
  /** The carrier context the delivering carrier must have; 0 = any delivery. Default 0. */
  carrierContextHash?: FieldNumberish;
  dummyInputEntropy?: FieldNumberish;
  dummyOutputEntropy?: readonly FieldNumberish[];
  outputData?: PrivateValueOutputDataOverrides;
  /**
   * A prior build's arena, to rebuild the same private value. Every encrypted
   * output must then reuse that build's output data too.
   */
  arena?: Uint8Array;
  /** The paying wallet's sender region. */
  sender?: ArenaSender;
}

export interface NativeChangeOpening {
  slot: number;
  noteSecret: bigint;
  amount: bigint;
  ownerCommitment: bigint;
}

export interface NativeRelayPaymentOpening {
  slot: number;
  noteSecret: bigint;
  amount: bigint;
  ownerCommitment: bigint;
  recipientAddress: bigint;
}

export interface NativeFeePaymentBuild {
  eventOpening: { eventEntry: bigint; eventSalt: bigint; eventsCommitment: bigint };
  issuanceRecipient: bigint;
  issuanceNoteSecret: bigint;
  transactionContext: bigint;
  transaction: PrivateValue;
  privateValueCommitment: bigint;
  /** The private-value public inputs, chain id first. */
  publicInputs: bigint[];
  outputData: PrivateValueOutputData;
  arena: Uint8Array;
  outputOwnerCommitments: bigint[];
  outputDummySecrets: bigint[];
  dummyInputSeed: bigint;
  nativeInputs: readonly (FeePaymentNoteInput & { slot: number; nullifier: bigint })[];
  change: NativeChangeOpening | null;
  relayPayment: NativeRelayPaymentOpening | null;
  /** The kernel witness fields shared by every native fee-payment relation. */
  kernelWitnessMap(): WitnessMap;
}

/** The change slot is always output 0; inputs occupy the leading input slots. */
const FEE_PAYMENT_CHANGE_SLOT = 0;

export function buildNativeFeePayment(params: NativeFeePaymentParams): NativeFeePaymentBuild {
  if (params.inputs.length > N_IN) throw new Error(`a fee payment spends at most ${N_IN} notes`);
  const chainId = toField(params.pcashChainId, "pcashChainId");
  const recentPcashBlockHash = toField(params.recentPcashBlockHash, "recentPcashBlockHash");
  if (recentPcashBlockHash === 0n) throw new Error("recentPcashBlockHash must be nonzero");
  const address = uintBelow(params.payer.address, U160_LIMIT, "payer.address");
  const nkRoot = toField(params.payer.nkRoot, "payer.nkRoot");
  const openFeeAmount = uintBelow(params.openFeeAmount, U128_LIMIT, "openFeeAmount");
  const issuanceOwnerCommitment = toField(params.issuanceOwnerCommitment ?? 0n, "issuanceOwnerCommitment");
  if (issuanceOwnerCommitment !== 0n) throw new Error("account operations cannot designate issuance");
  const relayAmount = params.privateRelayPayment === undefined ? 0n
    : uintBelow(params.privateRelayPayment.amount, U128_LIMIT, "privateRelayPayment.amount");
  if (params.privateRelayPayment !== undefined && relayAmount === 0n) throw new Error("private relay payment must be positive");
  const notBeforeTimestamp = uintBelow(params.notBeforeTimestamp ?? 0n, U64_LIMIT, "notBeforeTimestamp");
  const validUntilTimestamp = uintBelow(params.validUntilTimestamp, U64_LIMIT, "validUntilTimestamp");
  if (validUntilTimestamp === 0n) throw new Error("validUntilTimestamp must be nonzero");
  const carrierContextHash = toField(params.carrierContextHash ?? 0n, "carrierContextHash");
  const dummyInputSeed = toField(params.dummyInputEntropy ?? randomFieldEntropy(), "dummyInputEntropy");

  const nk = noteNk(nkRoot);

  const inputs: PrivateValueInput[] = [];
  const nativeInputs: (FeePaymentNoteInput & { slot: number; nullifier: bigint })[] = [];
  let nativeIn = 0n;
  for (let slot = 0; slot < N_IN; slot += 1) {
    const opening = params.inputs[slot];
    if (opening === undefined) {
      inputs.push({
        slotClass: SlotClass.DUMMY,
        inputCommitment: 0n,
        nullifier: dummyNullifier(dummyInputSeed, slot),
      });
      continue;
    }
    if (opening.siblings.length !== MERKLE_DEPTH) {
      throw new Error(`inputs[${slot}].siblings must have length ${MERKLE_DEPTH}`);
    }
    const noteSecret = toField(opening.noteSecret, `inputs[${slot}].noteSecret`);
    const amount = uintBelow(opening.amount, U128_LIMIT, `inputs[${slot}].amount`);
    if (amount === 0n) throw new Error(`inputs[${slot}].amount must be nonzero`);
    const commitment = fullOutputCommitment(
      { owner: address, noteSecret, assetId: 0n, amount },
      opening.leafIndex,
    );
    const inputNullifier = nullifier(commitment, nk, noteSecret);
    inputs.push({ slotClass: SlotClass.NATIVE, inputCommitment: commitment, nullifier: inputNullifier });
    nativeInputs.push({ ...opening, slot, nullifier: inputNullifier });
    nativeIn += amount;
  }
  if (nativeIn < openFeeAmount + relayAmount) {
    throw new Error(`native inputs total ${nativeIn} but fees total ${openFeeAmount + relayAmount}`);
  }
  const changeAmount = nativeIn - openFeeAmount - relayAmount;
  if (changeAmount >= U128_LIMIT) throw new Error("change amount exceeds the note amount range");
  const nullifiers = inputs.map((input) => input.nullifier);
  const feeOpening = authorizationIssuanceOpening(issuanceOwnerCommitment, chainId, nullifiers, params.designatedIssuanceOpening);

  // Output 0 is the change note when there is change, otherwise padding; the
  // remaining slots are always padding.
  const outputs: PrivateValueOutput[] = [];
  const outputOwnerCommitments: bigint[] = [];
  const outputDummySecrets: bigint[] = [];
  const outputData: Uint8Array[] = [];
  const envelopeOutputs: EnvelopeOutput[] = [];
  let change: NativeChangeOpening | null = null;
  let relayPayment: NativeRelayPaymentOpening | null = null;
  for (let slot = 0; slot < N_OUT; slot += 1) {
    const override = params.outputData?.[slot];
    if (slot === FEE_PAYMENT_CHANGE_SLOT && changeAmount !== 0n) {
      const noteSecret = ownerChangeNoteSecret(nkRoot, nullifiers, slot);
      const changeOwner = ownerCommitment(address, noteSecret);
      change = { slot, noteSecret, amount: changeAmount, ownerCommitment: changeOwner };
      outputOwnerCommitments.push(changeOwner);
      outputDummySecrets.push(0n);
      if (override === undefined && params.payer.receiveKey !== undefined) {
        envelopeOutputs.push({
          slot,
          receiveKey: params.payer.receiveKey,
          note: { chainId, assetId: 0n, amount: changeAmount, owner: address, noteSecret },
        });
      }
      outputData.push(override ?? (params.payer.receiveKey === undefined ? sizeClassFiller() : new Uint8Array(0)));
      outputs.push({
        slotClass: SlotClass.NATIVE,
        outputBodyCommitment: noteBodyCommitment(changeOwner, 0n, changeAmount),
      });
      continue;
    }
    if (slot === 1 && params.privateRelayPayment !== undefined) {
      const recipientAddress = uintBelow(params.privateRelayPayment.recipientAddress, U160_LIMIT, "privateRelayPayment.recipientAddress");
      // This opening is fresh and independent of the public issuance commitment.
      const noteSecret = randomFieldEntropy();
      const relayOwner = ownerCommitment(recipientAddress, noteSecret);
      relayPayment = { slot, noteSecret, amount: relayAmount, ownerCommitment: relayOwner, recipientAddress };
      outputOwnerCommitments.push(relayOwner);
      outputDummySecrets.push(0n);
      if (override === undefined) {
        envelopeOutputs.push({
          slot,
          receiveKey: params.privateRelayPayment.receiveKey,
          note: { chainId, assetId: 0n, amount: relayAmount, owner: recipientAddress, noteSecret },
        });
      }
      outputData.push(override ?? new Uint8Array(0));
      outputs.push({
        slotClass: SlotClass.NATIVE,
        outputBodyCommitment: noteBodyCommitment(relayOwner, 0n, relayAmount),
      });
      continue;
    }
    const dummySecret = toField(
      params.dummyOutputEntropy?.[slot] ?? randomFieldEntropy(),
      `dummyOutputEntropy[${slot}]`,
    );
    const dummyOwner = ownerCommitment(0n, dummySecret);
    outputOwnerCommitments.push(dummyOwner);
    outputDummySecrets.push(dummySecret);
    const data = override ?? sizeClassFiller();
    outputData.push(data);
    outputs.push({
      slotClass: SlotClass.DUMMY,
      outputBodyCommitment: noteBodyCommitment(dummyOwner, 0n, 0n),
    });
  }

  let arena: Uint8Array;
  if (params.arena !== undefined) {
    if (envelopeOutputs.length > 0) {
      throw new Error("a supplied arena requires the prior build's output data for every encrypted output");
    }
    arena = params.arena;
  } else {
    const delivery = sealSectionDelivery({
      shape: PRIVATE_VALUE_PROFILES.S.shapeId,
      context: { chainId, transactionType: params.transactionType, nullifiers },
      envelopes: envelopeOutputs,
      ...(params.sender === undefined ? {} : { sender: params.sender }),
    });
    arena = delivery.arena;
    for (const [slot, envelope] of delivery.envelopes) outputData[slot] = envelope;
  }
  assertOutputDataItems(outputData);
  assertArena(arena, PRIVATE_VALUE_PROFILES.S.shapeId);
  const delivery = deliveryCommitment(outputData, arena);
  const transaction: PrivateValue = {
    global: {
      openFeeAmount,
      issuanceOwnerCommitment,
      notBeforeTimestamp,
      validUntilTimestamp,
      carrierContextHash,
      assetBurnAmount: 0n,
      deliveryCommitment: delivery,
    },
    inputs: [inputs[0]!, inputs[1]!, inputs[2]!, inputs[3]!],
    outputs: [outputs[0]!, outputs[1]!, outputs[2]!, outputs[3]!, outputs[4]!],
  };
  const eventOpening = prepareEvent(params);
  const publicInputs: bigint[] = [
    chainId,
    recentPcashBlockHash,
    ...nullifiers.map((value) => toField(value)),
    ...outputs.map((output) => toField(output.outputBodyCommitment)),
    delivery,
    openFeeAmount,
    issuanceOwnerCommitment,
    notBeforeTimestamp,
    validUntilTimestamp,
    carrierContextHash,
    eventOpening.eventsCommitment,
  ];
  const nativeInputWitness = Array.from({ length: N_IN }, (_, slot) => {
    const opening = nativeInputs.find((input) => input.slot === slot);
    if (opening === undefined) return absentInputMap();
    return inputNoteMap(opening);
  });
  const changeOpening = change;
  return {
    ...feeOpening,
    transaction,
    privateValueCommitment: privateValueCommitment(transaction),
    eventOpening,
    publicInputs,
    outputData: [outputData[0]!, outputData[1]!, outputData[2]!, outputData[3]!, outputData[4]!],
    arena,
    outputOwnerCommitments,
    outputDummySecrets,
    dummyInputSeed,
    nativeInputs,
    change,
    relayPayment,
    kernelWitnessMap: () => ({
      event_salt: fm(eventOpening.eventSalt),
      choices: privateValueChoicesMap(transaction),
      native_inputs: nativeInputWitness,
      dummy_input_seed: fm(dummyInputSeed),
      output_owner_commitments: fieldArrayMap(outputOwnerCommitments),
      output_dummy_secrets: fieldArrayMap(outputDummySecrets),
      native_change: {
        slot: changeOpening?.slot ?? 0,
        secret: fm(changeOpening?.noteSecret ?? 0n),
        amount: fm(changeOpening?.amount ?? 0n),
      },
      native_relay_output: {
        slot: relayPayment?.slot ?? 0,
        amount: fm(relayPayment?.amount ?? 0n),
      },
    }),
  };
}
