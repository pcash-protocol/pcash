import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function load<T>(relative: string): T {
  const url = new URL(relative, import.meta.url);
  return JSON.parse(readFileSync(fileURLToPath(url), "utf8")) as T;
}

export interface PoseidonVectors {
  fieldModulus: string;
  poseidonVectors: { inputs: string[]; output: string }[];
  byteHashVectors: { domain: string; bytes: string; inputs: string[]; output: string }[];
}

export interface MerkleVectors {
  fieldModulus: string;
  emptyLadder: { height: number; value: string }[];
  emptyRoots: Record<string, string>;
  membershipExamples: {
    depth: number;
    label: string;
    index: number;
    leaf: string;
    siblings: string[];
    expectedRoot: string;
    indexBitsLSBFirst: number[];
  }[];
}

export interface DomainTagsAsset {
  domainPrefix: string;
  tags: Record<string, string>;
}

export const poseidonVectors = load<PoseidonVectors>("../../vectors/poseidon2_vectors.json");
export const merkleVectors = load<MerkleVectors>("../../vectors/merkle_vectors.json");
export const domainTagsAsset = load<DomainTagsAsset>("../../assets/domain_tags.json");
