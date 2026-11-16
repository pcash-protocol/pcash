import { PRIVATE_VALUE_PROFILES, privateValueProfile, type PrivateValueShape } from "../constants/privateValueProfiles.ts";
// PCASH keys, note bodies, output commitments, and nullifiers. A note's owner
// is the uint160 address of the account that may spend it; padding notes belong
// to address zero, where no account exists.
//
// Every function is a length-tagged Poseidon2 sponge (`poseidon` == circuit
// `pcash_hash`) over the domain tag followed by the field operands, in the exact
// order the spec gives. Operand order is normative. One-to-one with
// circuits/protocol/lib/src/ledger/note.nr, and with circuits/rules/lib/src/payout.nr
// for the output note secrets; the SDK MUST produce identical field values.

import { toAddressField, toField, type FieldNumberish } from "../crypto/field.ts";
import { poseidon } from "../crypto/poseidon2.ts";
import type { Note } from "./types.ts";
import {
  IMPLICIT_NOTE_SECRET_SEED_DOMAIN,
  NOTE_BODY_COMMITMENT_DOMAIN,
  OUTPUT_COMMITMENT_DOMAIN,
  NOTE_NULLIFIER_KEY_DOMAIN,
  NULLIFIER_DOMAIN,
  NULLIFIER_KEY_COMMITMENT_DOMAIN,
  OWNER_COMMITMENT_DOMAIN,
  APPLICATION_NULLIFIER_DOMAIN,
  DUMMY_NULLIFIER_DOMAIN,
  TRANSACT_NOTE_SECRET_DOMAIN,
} from "../constants/domainTags.ts";

// ===========================================================================
// Account nullifier-key hierarchy
// ===========================================================================

/** P = poseidon(NULLIFIER_KEY_COMMITMENT_DOMAIN, nkRoot). Published in the account. */
export function nullifierKeyCommitment(nkRoot: FieldNumberish): bigint {
  return poseidon([NULLIFIER_KEY_COMMITMENT_DOMAIN, toField(nkRoot, "nkRoot")]);
}

/** noteNk = poseidon(NOTE_NULLIFIER_KEY_DOMAIN, nkRoot). nk for note nullifiers. */
export function noteNk(nkRoot: FieldNumberish): bigint {
  return poseidon([NOTE_NULLIFIER_KEY_DOMAIN, toField(nkRoot, "nkRoot")]);
}

// ===========================================================================
// Output commitment layers
// ===========================================================================

/** ownerCommitment = poseidon(OWNER_COMMITMENT_DOMAIN, uint160(owner), noteSecret). */
export function ownerCommitment(
  owner: FieldNumberish,
  noteSecret: FieldNumberish,
): bigint {
  return poseidon([OWNER_COMMITMENT_DOMAIN, toAddressField(owner, "owner"), noteSecret]);
}

/**
 * noteBodyCommitment = poseidon(
 *   NOTE_BODY_COMMITMENT_DOMAIN, ownerCommitment, assetId, amount
 * ).
 */
export function noteBodyCommitment(
  ownerCommitmentValue: FieldNumberish,
  assetId: FieldNumberish,
  amount: FieldNumberish,
): bigint {
  return poseidon([NOTE_BODY_COMMITMENT_DOMAIN, ownerCommitmentValue, assetId, amount]);
}

/** outputCommitment = poseidon(OUTPUT_COMMITMENT_DOMAIN, outputBody, outputIndex). */
export function outputCommitment(
  outputBody: FieldNumberish,
  outputIndex: FieldNumberish,
): bigint {
  const result = poseidon([OUTPUT_COMMITMENT_DOMAIN, outputBody, outputIndex]);
  return result;
}

/** The indexed output commitment for one ordinary note body. */
export function fullOutputCommitment(
  note: Note,
  outputIndex: FieldNumberish,
): bigint {
  const oc = ownerCommitment(note.owner, note.noteSecret);
  const body = noteBodyCommitment(oc, note.assetId, note.amount);
  return outputCommitment(body, outputIndex);
}

// ===========================================================================
// Nullifiers
// ===========================================================================

/** nullifier = poseidon(NULLIFIER_DOMAIN, outputCommitment, noteNk, noteSecret). */
export function nullifier(
  outputCommitmentValue: FieldNumberish,
  noteNkValue: FieldNumberish,
  noteSecretValue: FieldNumberish,
): bigint {
  return poseidon([NULLIFIER_DOMAIN, outputCommitmentValue, noteNkValue, toField(noteSecretValue, "noteSecret")]);
}

/** dummyNullifier = poseidon(DUMMY_NULLIFIER_DOMAIN, dummyInputSeed, inputIndex). */
export function dummyNullifier(
  dummyInputSeed: FieldNumberish,
  inputIndex: FieldNumberish,
): bigint {
  return poseidon([DUMMY_NULLIFIER_DOMAIN, dummyInputSeed, inputIndex]);
}

/**
 * applicationNullifier = poseidon(
 *   APPLICATION_NULLIFIER_DOMAIN, uint160(address),
 *   selectedEntryCommitment, replayId).
 *
 * The account and the exact selected account-rule entry supply scope; `replayId`
 * is defined entirely by that rule. The operand list is closed on purpose: it
 * binds no slot index, note, output, fee, timestamp, root, or chain, so the same
 * fact yields one value however the transaction is reshaped.
 */
export function applicationNullifier(
  address: FieldNumberish,
  selectedEntryCommitment: FieldNumberish,
  replayId: FieldNumberish,
): bigint {
  return poseidon([
    APPLICATION_NULLIFIER_DOMAIN,
    toAddressField(address),
    toField(selectedEntryCommitment, "selectedEntryCommitment"),
    toField(replayId, "replayId"),
  ]);
}

// ===========================================================================
// Deterministic output note secrets
// ===========================================================================

/** noteSecretSeed = poseidon(IMPLICIT_NOTE_SECRET_SEED_DOMAIN, nk). */
export function noteSecretSeed(nk: FieldNumberish): bigint {
  return poseidon([IMPLICIT_NOTE_SECRET_SEED_DOMAIN, nk]);
}

/**
 * noteSecret_i = poseidon(TRANSACT_NOTE_SECRET_DOMAIN, noteSecretSeed,
 * shapeId, inputCount, outputCount, nullifierTuple, i, outputEntropy_i).
 *
 * The published nullifier tuple makes the salt unique per accepted transaction
 * and independent of output-slot arrangement; it is fixed before any output is
 * constructed, so there is no derivation cycle.
 * `outputEntropy_i` is private builder input. The reference native-transfer
 * builder uses 0 for canonical owner change, fresh nonzero randomness for
 * padding and private relay payments, and fresh randomness for every
 * non-canonical slot when `nkRoot` is public or no input slot is padding.
 */
export function noteSecret(
  seed: FieldNumberish,
  nullifiers: readonly FieldNumberish[],
  i: FieldNumberish,
  outputEntropy: FieldNumberish = 0n,
  shape: PrivateValueShape = PRIVATE_VALUE_PROFILES.S.shapeId,
): bigint {
  const profile = privateValueProfile(shape);
  if (nullifiers.length !== profile.inputs) throw new Error(`note secret requires ${profile.inputs} nullifiers`);
  const derived = poseidon([
    TRANSACT_NOTE_SECRET_DOMAIN,
    seed,
    BigInt(profile.shapeId), BigInt(profile.inputs), BigInt(profile.outputs),
    ...nullifiers,
    i,
    outputEntropy,
  ]);
  return derived;
}

/**
 * The secret every owner-change output opens under: the owner's implicit note
 * secret for the transaction and slot with zero entropy. The readable account
 * rules derive it in-circuit from `nkRoot` and the published nullifiers, which
 * binds change to the owner. The amount is a free witness and change may be
 * split across slots, so the software that built the transaction can still
 * withhold change by withholding its delivery.
 */
export function ownerChangeNoteSecret(
  nkRoot: FieldNumberish,
  nullifiers: readonly FieldNumberish[],
  slot: number | bigint,
  shape: PrivateValueShape = PRIVATE_VALUE_PROFILES.S.shapeId,
): bigint {
  return noteSecret(noteSecretSeed(noteNk(nkRoot)), nullifiers, BigInt(slot), 0n, shape);
}
