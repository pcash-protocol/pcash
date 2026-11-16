// PCASH Poseidon hashing.
//
// Every `poseidon(x_1..x_N)` in the spec is the length-tagged Poseidon2
// sponge over the BN254 t=4 (rf=8, rp=56) permutation:
//
//   state init = [0, 0, 0, (N as Field) * 2^64]
//   rate-3 absorb into lanes 0..2, permute per chunk
//   return lane 0
//   N == 0 => one permutation
//
// The vendored `poseidon::poseidon2::Poseidon2::hash(input, N)` implements
// this construction. The known answers below pin representative outputs to
// the Rust/TS vectors.

use poseidon::poseidon2::Poseidon2;

/// Length-tagged Poseidon2 sponge over N field elements.
pub fn pcash_hash<let N: u32>(input: [Field; N]) -> Field {
    Poseidon2::hash(input, N)
}

mod tests {
    use super::pcash_hash;

    // Golden values from vectors/poseidon2_vectors.json cover empty input and
    // both sides of a rate-3 chunk boundary.
    #[test]
    fn test_poseidon_agreement_gate() {
        let empty: [Field; 0] = [];
        assert(
            pcash_hash(empty) == 0x18dfb8dc9b82229cff974efefc8df78b1ce96d9d844236b496785c698bc6732e,
            "poseidon([]) must match the published vector",
        );

        assert(
            pcash_hash([1]) == 0x168758332d5b3e2d13be8048c8011b454590e06c44bce7f702f09103eef5a373,
            "poseidon([1]) must match the published vector",
        );

        assert(
            pcash_hash([1, 2])
                == 0x038682aa1cb5ae4e0a3f13da432a95c77c5c111f6f030faf9cad641ce1ed7383,
            "poseidon([1,2]) must match the published vector",
        );

        // Boundary case: exactly one full rate-3 chunk (no final extra permutation).
        assert(
            pcash_hash([1, 2, 3])
                == 0x23864adb160dddf590f1d3303683ebcb914f828e2635f6e85a32f0a1aecd3dd8,
            "poseidon([1,2,3]) must match the published vector",
        );

        // Two chunks: one full + a 1-element remainder.
        assert(
            pcash_hash([1, 2, 3, 4])
                == 0x130bf204a32cac1f0ace56c78b731aa3809f06df2731ebcf6b3464a15788b1b9,
            "poseidon([1,2,3,4]) must match the published vector",
        );
    }
}
