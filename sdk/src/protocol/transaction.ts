import { PRIVATE_VALUE_PROFILES, privateValueProfile, type PrivateValueShape } from "../constants/privateValueProfiles.ts";
import type { FieldNumberish } from "../crypto/field.ts";
import { toField } from "../crypto/field.ts";
import { uintBelow, U64_LIMIT } from "../utils/validate.ts";
import { PRIVATE_VALUE_COMMITMENT_DOMAIN } from "../constants/domainTags.ts";
import { AMOUNT_BITS, ASSET_AGGREGATE_BITS } from "../constants/params.ts";
import { poseidon } from "../crypto/poseidon2.ts";

const AMOUNT_LIMIT = 1n << BigInt(AMOUNT_BITS);

// Private slot classes share one public transaction shape.
export const SlotClass = {
  DUMMY: 0,
  NATIVE: 1,
  ASSET: 2,
  ASSET_CREATION: 3,
  APPLICATION: 4,
} as const;

export type SlotClassValue = (typeof SlotClass)[keyof typeof SlotClass];

export interface PrivateValueGlobal {
  openFeeAmount: FieldNumberish;
  issuanceOwnerCommitment: FieldNumberish;
  notBeforeTimestamp: FieldNumberish;
  validUntilTimestamp: FieldNumberish;
  /** The carrier context the node requires of the delivering carrier; zero for any. */
  carrierContextHash: FieldNumberish;
  /** Private nonzero-asset value intentionally removed by this action. */
  assetBurnAmount: FieldNumberish;
  /** Commits every output-data item and the arena of the posted section. */
  deliveryCommitment: FieldNumberish;
  accountCreationCommitment: FieldNumberish;
}

export interface PrivateValueInput {
  slotClass: SlotClassValue;
  inputCommitment: FieldNumberish;
  nullifier: FieldNumberish;
}

export interface PrivateValueOutput {
  slotClass: SlotClassValue;
  outputBodyCommitment: FieldNumberish;
}

export interface PrivateValue {
  global: PrivateValueGlobal;
  inputs: readonly PrivateValueInput[];
  outputs: readonly PrivateValueOutput[];
}


function slotClass(value: SlotClassValue): bigint {
  if (!Number.isInteger(value) || value < 0 || value > 4) {
    throw new Error("slotClass must be one of the assigned transaction slot classes");
  }
  return BigInt(value);
}

function inputSlotClass(value: SlotClassValue): bigint {
  if (
    value !== SlotClass.DUMMY &&
    value !== SlotClass.NATIVE &&
    value !== SlotClass.ASSET &&
    value !== SlotClass.ASSET_CREATION &&
    value !== SlotClass.APPLICATION
  ) {
    throw new Error(
      "input slotClass must be DUMMY, NATIVE, ASSET, ASSET_CREATION, or APPLICATION",
    );
  }
  return slotClass(value);
}

function outputSlotClass(value: SlotClassValue): bigint {
  if (
    value !== SlotClass.NATIVE &&
    value !== SlotClass.ASSET &&
    value !== SlotClass.DUMMY
  ) {
    throw new Error("output slotClass must be NATIVE, ASSET, or DUMMY");
  }
  return slotClass(value);
}

function globalOperands(global: PrivateValueGlobal): bigint[] {
  if (BigInt(global.openFeeAmount) !== 0n && BigInt(global.issuanceOwnerCommitment) !== 0n) {
    throw new Error("open fee and designated issuance cannot coexist");
  }
  return [
    uintBelow(global.openFeeAmount, AMOUNT_LIMIT, "openFeeAmount"),
    toField(global.issuanceOwnerCommitment, "issuanceOwnerCommitment"),
    uintBelow(global.notBeforeTimestamp, U64_LIMIT, "notBeforeTimestamp"),
    uintBelow(global.validUntilTimestamp, U64_LIMIT, "validUntilTimestamp"),
    toField(global.carrierContextHash, "carrierContextHash"),
    uintBelow(global.assetBurnAmount, 1n << BigInt(ASSET_AGGREGATE_BITS), "assetBurnAmount"),
    toField(global.deliveryCommitment, "deliveryCommitment"),
    toField(global.accountCreationCommitment, "accountCreationCommitment"),
  ];
}

function inputOperands(input: PrivateValueInput | undefined, index: number): bigint[] {
  if (input === undefined) throw new Error(`privateValueCommitment input slot ${index} is missing`);
  return [
    inputSlotClass(input.slotClass),
    toField(input.inputCommitment, "inputCommitment"),
    toField(input.nullifier, "nullifier"),
  ];
}

function outputOperands(output: PrivateValueOutput | undefined, index: number): bigint[] {
  if (output === undefined) throw new Error(`privateValueCommitment output slot ${index} is missing`);
  return [
    outputSlotClass(output.slotClass),
    toField(output.outputBodyCommitment, "outputBodyCommitment"),
  ];
}

/** One hash over the profile, the global fields, and every slot in order. */
export function privateValueCommitment(value: PrivateValue, shape: PrivateValueShape = PRIVATE_VALUE_PROFILES.S.shapeId): bigint {
  const profile = privateValueProfile(shape);
  if (value.inputs.length !== profile.inputs) {
    throw new Error(`privateValueCommitment requires exactly ${profile.inputs} input slots`);
  }
  if (value.outputs.length !== profile.outputs) {
    throw new Error(`privateValueCommitment requires exactly ${profile.outputs} output slots`);
  }
  const operands = [
    PRIVATE_VALUE_COMMITMENT_DOMAIN,
    BigInt(profile.shapeId),
    BigInt(profile.inputs),
    BigInt(profile.outputs),
    ...globalOperands(value.global),
  ];
  // Indexed, so a hole in a caller-built array is a missing slot and never a
  // shorter preimage: array iteration methods skip holes.
  for (let index = 0; index < profile.inputs; index += 1) {
    operands.push(...inputOperands(value.inputs[index], index));
  }
  for (let index = 0; index < profile.outputs; index += 1) {
    operands.push(...outputOperands(value.outputs[index], index));
  }
  return poseidon(operands);
}
