// PCASH address accounts, account rules, and application Mega-VK hashing. One-to-one with
// circuits/protocol/lib/src/authorization/account.nr.

import { type FieldNumberish, fieldToHex, toField, toNonnegativeBigInt } from "../crypto/field.ts";
import { toHex } from "../utils/hex.ts";
import { poseidon, poseidonBytes } from "../crypto/poseidon2.ts";
import { ACCOUNT_RULE_SET_DEPTH, ACCOUNT_KIND_CONTRACT, ACCOUNT_KIND_USER } from "../constants/params.ts";
import { SparseMerkleTree } from "../crypto/tree.ts";
import {
  ACCOUNT_RULE_ENTRY_DOMAIN,
  ACCOUNT_STATE_COMMITMENT_DOMAIN,
  ACCOUNT_UPDATE_COMMITMENT_DOMAIN,
  RECEIVE_KEY_HASH_DOMAIN,
} from "../constants/domainTags.ts";

/**
 * Length of a CHONK MegaApp or MegaKernel verification key in field elements.
 */
export const VK_LEN = 151;

/** Length of the final CHONK MegaZK verification key in field elements. */
export const CHONK_VK_LEN = 119;

/**
 * Barretenberg's CHONK circuit kind. Applications and protocol kernels carry
 * Mega VKs; the hiding kernel carries the MegaZK VK.
 */
export type ChonkCircuitKind = "app" | "kernel" | "hiding";

/** The receive-key digest an account stores and commits: the byte hash of the ML-KEM-768 public key. Zero means no key. */
export function receiveKeyHash(mlKemPublicKey: Uint8Array): bigint {
  return poseidonBytes(RECEIVE_KEY_HASH_DOMAIN, mlKemPublicKey);
}

/** The sole account-tree leaf, including the revision and receive-key state. */
export function accountStateCommitment(
  address: FieldNumberish,
  nullifierKeyCommitment: FieldNumberish,
  accountRuleSetCommitment: FieldNumberish,
  accountKind: FieldNumberish,
  accountRevision: FieldNumberish,
  receiveKeyHashValue: FieldNumberish,
): bigint {
  const account = toNonnegativeBigInt(address, "address");
  if (account >= 1n << 160n) throw new Error("address must fit in 160 bits");
  const commitment = toField(nullifierKeyCommitment, "nullifierKeyCommitment");
  const ruleSet = toField(accountRuleSetCommitment, "accountRuleSetCommitment");
  const kind = toField(accountKind, "accountKind");
  if (kind !== ACCOUNT_KIND_USER && kind !== ACCOUNT_KIND_CONTRACT) {
    throw new Error("accountKind must be user or contract");
  }
  const revision = toNonnegativeBigInt(accountRevision, "accountRevision");
  if (revision >= 1n << 32n) throw new Error("accountRevision must be a u32");
  const stateCommitment = poseidon([
    ACCOUNT_STATE_COMMITMENT_DOMAIN,
    account,
    commitment,
    ruleSet,
    kind,
    revision,
    toField(receiveKeyHashValue, "receiveKeyHash"),
  ]);
  return stateCommitment;
}

/**
 * The network-independent compare-and-swap of a user-account update: the
 * account state it replaces and the one it installs. The update's action
 * commitment carries it as extra data.
 */
export function accountUpdateCommitment(params: {
  currentAccountStateCommitment: FieldNumberish;
  newAccountStateCommitment: FieldNumberish;
}): bigint {
  return poseidon([
    ACCOUNT_UPDATE_COMMITMENT_DOMAIN,
    toField(params.currentAccountStateCommitment, "currentAccountStateCommitment"),
    toField(params.newAccountStateCommitment, "newAccountStateCommitment"),
  ]);
}

/** accountRuleEntryCommitment = poseidon(ACCOUNT_RULE_ENTRY_DOMAIN, applicationVkHash, configurationCommitment, commitmentBlinder). */
export function accountRuleEntryCommitment(
  applicationVkHash: FieldNumberish,
  configurationCommitment: FieldNumberish,
  commitmentBlinder: FieldNumberish,
): bigint {
  return poseidon([
    ACCOUNT_RULE_ENTRY_DOMAIN,
    applicationVkHash,
    configurationCommitment,
    commitmentBlinder,
  ]);
}

/**
 * Barretenberg's canonical Mega VK hash: the length-tagged Poseidon2 hash of
 * the 151 field encoding. CHONK binds this same hash to the folded app claim,
 * so an installed account entry authenticates the exact executable circuit
 * without a second PCASH-specific VK identity.
 */
export function computeCircuitVkHash(vk: readonly FieldNumberish[]): bigint {
  if (vk.length !== VK_LEN) {
    throw new Error(`computeCircuitVkHash expects ${VK_LEN} VK field elements, got ${vk.length}`);
  }
  return poseidon(vk);
}

/** Barretenberg's canonical hash of the final CHONK MegaZK verification key. */
export function computeChonkVkHash(vk: readonly FieldNumberish[]): bigint {
  if (vk.length !== CHONK_VK_LEN) {
    throw new Error(`computeChonkVkHash expects ${CHONK_VK_LEN} VK field elements, got ${vk.length}`);
  }
  return poseidon(vk);
}

/** The hash of a VK of the given kind: MegaZK for the hiding kernel, Mega otherwise. */
export function vkFieldsHash(vkFields: readonly FieldNumberish[], kind: ChonkCircuitKind): bigint {
  return kind === "hiding" ? computeChonkVkHash(vkFields) : computeCircuitVkHash(vkFields);
}

/** The canonical field hexes of a serialized VK of the given kind. */
export function vkFieldsFromBytes(bytes: Uint8Array, kind: ChonkCircuitKind, label = "CHONK VK"): string[] {
  const length = kind === "hiding" ? CHONK_VK_LEN : VK_LEN;
  if (bytes.length !== length * 32) {
    throw new Error(`${label} must contain ${length} fields, got ${bytes.length / 32}`);
  }
  return Array.from({ length }, (_, index) => toHex(bytes.subarray(index * 32, (index + 1) * 32)));
}

/** Mega or MegaZK VK material for one CHONK circuit. */
export interface ChonkVkArtifacts {
  vkFields: readonly string[]; // 151 Mega or 119 MegaZK canonical field hexes
  /** Barretenberg Poseidon2 Mega VK hash computed when the fields are loaded. */
  vkHash: string;
}

/** Compute the VK identity once, at construction. */
export function chonkVkArtifacts(vkFields: readonly string[], kind: ChonkCircuitKind): ChonkVkArtifacts {
  return { vkFields, vkHash: fieldToHex(vkFieldsHash(vkFields, kind)) };
}

/** Compare an application VK with its independently installed rule. */
export function checkedCircuitVk(
  vk: ChonkVkArtifacts,
  label: string,
  expectedVkHash?: FieldNumberish,
): bigint {
  const hash = toField(vk.vkHash, `${label}.vkHash`);
  if (expectedVkHash !== undefined && hash !== toField(expectedVkHash, `${label} installed rule`)) {
    throw new Error(`${label} VK does not match the installed rule`);
  }
  return hash;
}

/** One shared account rule entry at a fixed index of the depth-8 account rule set. */
export interface AccountRuleEntry {
  accountRuleEntryCommitment: FieldNumberish;
  entryIndex: number;
}

/** A depth-8 membership opening of one entry against an account-rule-set commitment. */
export interface AccountRuleSetMembership {
  accountRuleSetCommitment: bigint;
  entryIndex: number;
  siblings: bigint[];
}

export interface AccountRuleSet {
  accountRuleSetCommitment: bigint;
  tree: SparseMerkleTree;
  membership(entryIndex: number): AccountRuleSetMembership;
}

/** Build the shared depth-8 account rule set: a user account's rules or a Smart Contract's functions. */
export function buildAccountRuleSet(entries: readonly AccountRuleEntry[]): AccountRuleSet {
  const tree = new SparseMerkleTree(ACCOUNT_RULE_SET_DEPTH);
  const filled = new Set<number>();
  for (const entry of entries) {
    if (filled.has(entry.entryIndex)) {
      throw new Error(`duplicate account rule entry index ${entry.entryIndex}`);
    }
    filled.add(entry.entryIndex);
    tree.setLeaf(
      entry.entryIndex,
      toField(entry.accountRuleEntryCommitment, "accountRuleEntryCommitment"),
    );
  }
  return {
    accountRuleSetCommitment: tree.root,
    tree,
    membership(entryIndex: number): AccountRuleSetMembership {
      if (!filled.has(entryIndex)) {
        throw new Error(`no account rule entry registered at index ${entryIndex}`);
      }
      const proof = tree.proof(entryIndex);
      return {
        accountRuleSetCommitment: proof.root,
        entryIndex: proof.leafIndex,
        siblings: proof.siblings,
      };
    },
  };
}
