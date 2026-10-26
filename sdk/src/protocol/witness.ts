// noir_js InputMap witness encodings shared by every witness builder.
//
// A structured witness map is keyed by ABI parameter name, with Field → 0x-hex
// string, `[u8; N]` → array of decimal strings, arrays of Field → arrays of hex
// strings, structs → nested objects, and bool → boolean. One definition keeps
// every builder byte-identical to the circuits' noirc_abi expectations.

import { type FieldNumberish, fieldToHex } from "../crypto/field.ts";
import { PRIVATE_VALUE_MAX_INPUTS, PRIVATE_VALUE_MAX_OUTPUTS, privateValueProfile, type PrivateValueShape } from "../constants/privateValueProfiles.ts";
import type { PrivateValue } from "./transaction.ts";
import type { RuleStatement } from "./statement.ts";

/** The structured witness-map shape noir_js consumes (ACVM InputMap values). */
export type WitnessMap = Record<string, unknown>;

/** Field → 0x-hex string (the InputMap encoding noirc_abi parses for a Field). */
export function fm(value: FieldNumberish): string {
  return fieldToHex(value);
}

/** Array of Field → array of 0x-hex strings. */
export function fieldArrayMap(values: readonly FieldNumberish[]): string[] {
  return values.map(fm);
}

/** `[u8; N]` → array of decimal strings. */
export function u8ArrayMap(bytes: Uint8Array): string[] {
  return Array.from(bytes, String);
}

/** n zero Field values. */
export function zeroFields(n: number): bigint[] {
  return new Array<bigint>(n).fill(0n);
}

/**
 * A profile's hiding-kernel public-input parameter names, in verifier order.
 * The circuit wrapper generator reads the same list, so it takes slot counts
 * rather than a generated profile.
 */
export function privateValuePublicInputNames(profile: { inputs: number; outputs: number }): string[] {
  return [
    "pcash_chain_id", "recent_pcash_block_hash",
    ...Array.from({ length: profile.inputs }, (_, i) => `nullifier${i}`),
    ...Array.from({ length: profile.outputs }, (_, i) => `output_body_commitment${i}`),
    "delivery_commitment",
    "open_fee_amount", "issuance_owner_commitment", "not_before_timestamp", "valid_until_timestamp",
    "carrier_context_hash", "events_commitment", "account_creation_commitment",
  ];
}

/** A private value's free choices: every kernel's `choices` witness. */
export function privateValueChoicesMap(value: PrivateValue): WitnessMap {
  return {
    open_fee_amount: fm(value.global.openFeeAmount),
    issuance_owner_commitment: fm(value.global.issuanceOwnerCommitment),
    not_before_timestamp: fm(value.global.notBeforeTimestamp),
    valid_until_timestamp: fm(value.global.validUntilTimestamp),
    carrier_context_hash: fm(value.global.carrierContextHash),
    asset_burn_amount: fm(value.global.assetBurnAmount),
    delivery_commitment: fm(value.global.deliveryCommitment),
    account_creation_commitment: fm(value.global.accountCreationCommitment),
    input_slot_classes: fieldArrayMap(value.inputs.map((input) => input.slotClass)),
    output_slot_classes: fieldArrayMap(value.outputs.map((output) => output.slotClass)),
  };
}

/** The complete private value, as the `private_value` witness every rule opens. */
export function privateValueMap(value: PrivateValue): WitnessMap {
  return {
    ...privateValueChoicesMap(value),
    input_commitments: fieldArrayMap(value.inputs.map((input) => input.inputCommitment)),
    nullifiers: fieldArrayMap(value.inputs.map((input) => input.nullifier)),
    output_body_commitments: fieldArrayMap(value.outputs.map((output) => output.outputBodyCommitment)),
  };
}

/** The rule statement a kernel reads from an application's return data. */
export function ruleStatementMap(statement: RuleStatement): string[] {
  return fieldArrayMap(statement);
}

/** Canonical absent trailing slots for an application sharing one entry across S/L. */
export function compositePrivateValueMap(value: PrivateValue, shape: PrivateValueShape): WitnessMap {
  const profile = privateValueProfile(shape);
  const map = privateValueMap(value);
  for (const [key, active, maximum] of [
    ["input_slot_classes", profile.inputs, PRIVATE_VALUE_MAX_INPUTS],
    ["input_commitments", profile.inputs, PRIVATE_VALUE_MAX_INPUTS],
    ["nullifiers", profile.inputs, PRIVATE_VALUE_MAX_INPUTS],
    ["output_slot_classes", profile.outputs, PRIVATE_VALUE_MAX_OUTPUTS],
    ["output_body_commitments", profile.outputs, PRIVATE_VALUE_MAX_OUTPUTS],
  ] as const) {
    const values = map[key] as string[];
    if (values.length !== active) throw new Error(`composite ${key} does not match its explicit profile`);
    map[key] = [...values, ...Array<string>(maximum - active).fill(fm(0n))];
  }
  return map;
}
