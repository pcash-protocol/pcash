// BN254 field arithmetic, the Poseidon2 sponge, and the Merkle constructions
// built on it. Depends on @noble only — never on viem — because these values are
// circuit witnesses rather than EVM words.
//
// ./poseidon2Constants.ts is deliberately absent: the round-constant table is an
// implementation detail of the sponge, not part of the public surface.

export * from "./field.ts";
export * from "./poseidon2.ts";
export * from "./merkle.ts";
export * from "./tree.ts";
export * from "./outputWitnessTree.ts";
export * from "./denseMerkleTree.ts";
