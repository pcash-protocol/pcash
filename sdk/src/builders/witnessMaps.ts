// Builder-level witness blocks shared by the asset-action, native-transfer,
// and private-value kernels: the account scalars every application
// embeds, the authenticated account/rule openings, the three tree roots a
// block header proves, input-note slots, and verified application VKs.
//
// Builders project their own wallet/owner/accountState shapes into these
// neutral fields at the call site; the maps stay keyed exactly as the
// circuits' Prover.toml declares them.

import {
  ACCOUNT_RULE_SET_DEPTH,
  BLOCK_HEADER_TREE_DEPTH,
  MERKLE_DEPTH,
  STATE_TREE_DEPTH,
} from "../constants/params.ts";
import type { FieldNumberish } from "../crypto/field.ts";
import { checkedCircuitVk, type ChonkVkArtifacts } from "../protocol/account.ts";
import { requireLength } from "../utils/validate.ts";
import type { AssetAccountAuthorization } from "./assetOutputs.ts";
import {
  fieldArrayMap,
  fm,
  zeroFields,
  type WitnessMap,
} from "../protocol/witness.ts";

/** The account scalars every application and kernel witness embeds. */
export interface AccountWitnessScalars {
  address: FieldNumberish;
  nkRoot: FieldNumberish;
  accountRevision: FieldNumberish;
  receiveKeyHash: FieldNumberish;
  configurationCommitment: FieldNumberish;
  commitmentBlinder: FieldNumberish;
}

/** Authenticated openings of the account state leaf and the installed rule entry. */
export interface AccountWitnessOpenings {
  accountIndex: number;
  accountSiblings: readonly FieldNumberish[];
  ruleEntryIndex: number;
  ruleSiblings: readonly FieldNumberish[];
}

/**
 * The block-header-proved tree roots a kernel witness embeds. The kernel
 * derives the state root from the output root's opening.
 */
export interface SnapshotWitness {
  stateRootHeaderSiblings: readonly FieldNumberish[];
  outputRoot: FieldNumberish;
  outputRootStateSiblings: readonly FieldNumberish[];
  accountStateRoot: FieldNumberish;
  accountStateRootStateSiblings: readonly FieldNumberish[];
}

export function accountScalarMap(fields: AccountWitnessScalars): WitnessMap {
  return {
    address: fm(fields.address),
    nk_root: fm(fields.nkRoot),
    account_revision: fm(fields.accountRevision),
    receive_key_hash: fm(fields.receiveKeyHash),
    configuration_commitment: fm(fields.configurationCommitment),
    commitment_blinder: fm(fields.commitmentBlinder),
  };
}

export function accountWitnessMap(openings: AccountWitnessOpenings): WitnessMap {
  requireLength(openings.accountSiblings, MERKLE_DEPTH, "account siblings");
  requireLength(openings.ruleSiblings, ACCOUNT_RULE_SET_DEPTH, "account-rule siblings");
  return {
    account_witness: {
      leaf_index: fm(openings.accountIndex),
      siblings: fieldArrayMap(openings.accountSiblings),
    },
    account_rule_witness: {
      entry_index: openings.ruleEntryIndex,
      siblings: fieldArrayMap(openings.ruleSiblings),
    },
  };
}

/** An authenticated account's scalars and openings, as a kernel's account block embeds them. */
export function authorizedAccountMap(account: AssetAccountAuthorization): WitnessMap {
  return {
    ...accountScalarMap({
      address: account.address,
      nkRoot: account.nkRoot,
      accountRevision: account.accountRevision,
      receiveKeyHash: account.receiveKeyHash,
      configurationCommitment: account.rule.configurationCommitment,
      commitmentBlinder: account.rule.commitmentBlinder,
    }),
    ...accountWitnessMap({
      accountIndex: account.accountIndex,
      accountSiblings: account.accountSiblings,
      ruleEntryIndex: account.rule.entryIndex,
      ruleSiblings: account.rule.siblings,
    }),
  };
}

export function snapshotWitnessMap(snapshot: SnapshotWitness): WitnessMap {
  requireLength(snapshot.stateRootHeaderSiblings, BLOCK_HEADER_TREE_DEPTH, "state-root header siblings");
  requireLength(snapshot.outputRootStateSiblings, STATE_TREE_DEPTH, "output-root state siblings");
  requireLength(snapshot.accountStateRootStateSiblings, STATE_TREE_DEPTH, "account-state-root state siblings");
  return {
    block_header_state_siblings: fieldArrayMap(snapshot.stateRootHeaderSiblings),
    output_root: fm(snapshot.outputRoot),
    state_output_siblings: fieldArrayMap(snapshot.outputRootStateSiblings),
    account_state_root: fm(snapshot.accountStateRoot),
    state_account_siblings: fieldArrayMap(snapshot.accountStateRootStateSiblings),
  };
}

/**
 * One kernel input slot: the spent note's secret, amount, and output-tree path.
 * The kernel builds the note from the owner it authenticated and the slot's
 * namespace.
 */
export interface InputNoteWitness {
  leafIndex: FieldNumberish;
  noteSecret: FieldNumberish;
  amount: FieldNumberish;
  siblings: readonly FieldNumberish[];
}

export function inputNoteMap(input: InputNoteWitness): WitnessMap {
  return {
    output_index: fm(input.leafIndex),
    note_secret: fm(input.noteSecret),
    amount: fm(input.amount),
    siblings: fieldArrayMap(input.siblings),
  };
}

/** Unused private note padding for a slot whose class carries no note. */
export function absentInputMap(): WitnessMap {
  return inputNoteMap({ leafIndex: 0n, noteSecret: 0n, amount: 0n, siblings: zeroFields(MERKLE_DEPTH) });
}

/** A verified application VK as the `{ key, hash }` block a kernel witness embeds. */
export function vkWitnessMap(
  vk: ChonkVkArtifacts,
  label: string,
  expectedVkHash?: FieldNumberish,
): WitnessMap {
  const hash = checkedCircuitVk(vk, label, expectedVkHash);
  return { key: fieldArrayMap(vk.vkFields), hash: fm(hash) };
}
