import { poseidon } from "@pcash/sdk/crypto";
import { toField } from "@pcash/sdk/crypto";
import { SparseMerkleTree } from "@pcash/sdk/crypto";
import { bytesToBigInt, utf8 } from "@pcash/sdk/utils";

export const POLICY_DEPTH = 32;
export const CLAIM_DOMAIN = bytesToBigInt(utf8("pcash_lineage_claim"));
export const POLICY_DOMAIN = bytesToBigInt(utf8("pcash_lineage_policy"));
export const SOURCE_DOMAIN = bytesToBigInt(utf8("pcash_lineage_source"));
export const DENY_GAP_DOMAIN = bytesToBigInt(utf8("pcash_lineage_deny_gap"));

export interface LineageClaim { root: bigint; applicationVkHash: bigint; qualificationMask: number }
export function claimEvent(claim: LineageClaim): bigint {
  if (!Number.isInteger(claim.qualificationMask) || claim.qualificationMask < 0 || claim.qualificationMask >= 32) {
    throw new Error("invalid S output qualification mask");
  }
  return poseidon([CLAIM_DOMAIN, toField(claim.root), toField(claim.applicationVkHash), BigInt(claim.qualificationMask)]);
}

export interface Gap { lowerPresent: boolean; lower: bigint; upperPresent: boolean; upper: bigint }
export function gapLeaf(gap: Gap): bigint {
  return poseidon([DENY_GAP_DOMAIN, BigInt(gap.lowerPresent), gap.lower, BigInt(gap.upperPresent), gap.upper]);
}

/** Provider-published set contents. They must remain available to every later holder. */
export function buildPolicy(provider: bigint, approvedSources: readonly bigint[], deniedOutputs: readonly bigint[]) {
  const sorted = (values: readonly bigint[]) => [...new Set(values.map(value => toField(value)))].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  const sources = sorted(approvedSources), denied = sorted(deniedOutputs);
  const sourceTree = new SparseMerkleTree(POLICY_DEPTH), gapTree = new SparseMerkleTree(POLICY_DEPTH);
  sources.forEach((value, index) => sourceTree.setLeaf(index, poseidon([SOURCE_DOMAIN, value])));
  const gaps: Gap[] = Array.from({ length: denied.length + 1 }, (_, index) => ({
    lowerPresent: index > 0, lower: denied[index - 1] ?? 0n,
    upperPresent: index < denied.length, upper: denied[index] ?? 0n,
  }));
  gaps.forEach((gap, index) => gapTree.setLeaf(index, gapLeaf(gap)));
  const root = poseidon([POLICY_DOMAIN, provider, sourceTree.root, gapTree.root]);
  return {
    provider, root, sources, denied, sourceTree, gapTree,
    sourceWitness(commitment: bigint) {
      const index = sources.indexOf(commitment);
      if (index < 0) throw new Error("unapproved issuance source");
      return sourceTree.proof(index);
    },
    denyWitness(commitment: bigint) {
      const value = toField(commitment);
      const index = gaps.findIndex(gap => (!gap.lowerPresent || value > gap.lower) && (!gap.upperPresent || value < gap.upper));
      if (index < 0) throw new Error("denied output");
      return { ...gaps[index]!, ...gapTree.proof(index) };
    },
  };
}
export type LineagePolicy = ReturnType<typeof buildPolicy>;
