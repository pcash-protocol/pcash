// PCASH binary Merkle membership.
//
// Internal node hash is the length-tagged 2-input Poseidon2 sponge
// `pcash_hash([left, right])`. Index bits are consumed LSB-first to match the
// protocol's incremental-tree convention: bit i = (index >> i) & 1, bit 0
// chooses whether the current node is the left (0) or right (1) child.

use crate::primitives::hash::pcash_hash;

// The root of a depth-D tree with `leaf` at `index`. Field::to_le_bits
// constrains the whole index to D bits, so an index cannot alias another
// position by truncation.
pub fn binary_root_from_index<let D: u32>(
    leaf: Field,
    index: Field,
    siblings: [Field; D],
) -> Field {
    let bits: [bool; D] = index.to_le_bits();
    let mut acc = leaf;
    for i in 0..D {
        let left = if bits[i] { siblings[i] } else { acc };
        let right = if bits[i] { acc } else { siblings[i] };
        acc = pcash_hash([left, right]);
    }
    acc
}

mod tests {
    use crate::primitives::params::{ACCOUNT_RULE_SET_DEPTH, MERKLE_DEPTH};
    use super::binary_root_from_index;

    #[test]
    fn test_root_from_index_orientation() {
        let leaf = 0x123;
        let mut siblings: [Field; MERKLE_DEPTH] = [0; MERKLE_DEPTH];
        for i in 0..MERKLE_DEPTH {
            siblings[i] = (i + 1) as Field;
        }
        // Frozen roots from the off-circuit Poseidon2 implementation.
        assert(
            binary_root_from_index(leaf, 0, siblings)
                == 0x2e9998104c2a1a3e314ae6f8dc17ed67ec3dc5a80f78d94c09c7e6e374252d85,
        );
        // index 5 = 0b101 chooses right, left, right at the first three levels.
        assert(
            binary_root_from_index(leaf, 5, siblings)
                == 0x2d29e23296e7277114ea77faedca932795324cdc73329e8d8c84d2cd8435ce4c,
        );
    }

    #[test]
    fn test_root_from_max_depth40_index() {
        let leaf = 0x123;
        let mut siblings: [Field; MERKLE_DEPTH] = [0; MERKLE_DEPTH];
        for i in 0..MERKLE_DEPTH {
            siblings[i] = (i + 1) as Field;
        }
        assert(
            binary_root_from_index(leaf, 0xffffffffff, siblings)
                == 0x2de73e35ca528412802a6c78a3c72f890788f118148a2893d26368d120814000,
        );
    }

    #[test]
    fn test_account_rule_root_depth8() {
        let leaf = 0xabc;
        let mut siblings: [Field; ACCOUNT_RULE_SET_DEPTH] = [0; ACCOUNT_RULE_SET_DEPTH];
        for i in 0..ACCOUNT_RULE_SET_DEPTH {
            siblings[i] = (i + 7) as Field;
        }
        assert(
            binary_root_from_index(leaf, 3, siblings)
                == 0x27c9cdb819e76da1ce7da7e1cc58794c5ff63bafef8e3ac627b9e5783e1f0e96,
        );
        assert(
            binary_root_from_index(leaf, 4, siblings)
                == 0x232abc4440d7a0c3921a6779d9cd52b2716f94ee8873bf7d50d326a2f8318880,
        );
    }

    #[test]
    fn test_rule_index_accepts_last_leaf() {
        assert(
            binary_root_from_index(7, 255, [3; ACCOUNT_RULE_SET_DEPTH])
                == 0x2768125b5ef5151b3ffaec6b5291ec48c04b375425ad74b8669ab47fc92abe11,
        );
    }

    #[test(should_fail)]
    fn test_rule_index_cannot_alias_by_truncation() {
        let _ = binary_root_from_index(7, 256, [3; ACCOUNT_RULE_SET_DEPTH]);
    }

    #[test(should_fail)]
    fn test_output_index_cannot_alias_by_truncation() {
        let _ = binary_root_from_index(7, 0x10000000000, [3; MERKLE_DEPTH]);
    }

    // Published depth-4 vectors exercise every level with fixed expected roots.
    // Index 11 = 0b1011 puts the leaf on the right at levels 0, 1 and 3.
    #[test]
    fn test_binary_paths_match_published_vectors() {
        assert(
            binary_root_from_index(
                0x255ee8299be9389b21052fd317f8cae762f9c89f756ac79262fb648a70ee7a08,
                0,
                [
                    0x0000000000000000000000000000000000000000000000000000000000000000,
                    0x0b63a53787021a4a962a452c2921b3663aff1ffd8d5510540f8e659e782956f1,
                    0x0e34ac2c09f45a503d2908bcb12f1cbae5fa4065759c88d501c097506a8b2290,
                    0x21f9172d72fdcdafc312eee05cf5092980dda821da5b760a9fb8dbdf607c8a20,
                ],
            )
                == 0x1adc9df66c937f2f546ea4e460491b72882b7e6257baa9e42fe25f9d095e16ff,
        );
        assert(
            binary_root_from_index(
                0x1f7a903ff6ebf6088f018bef42d630d28cc499eec89bec2ba6cc2763da3b957c,
                11,
                [
                    0x25ac755e82d9f956e42d7555c9b2cddb4becf4153b4e8f297253f20c0adf552b,
                    0x0c8666db884a9f767ac7476e323f808b0d6ff33dc0c2729071f19acfb1ce8699,
                    0x022a7c09345b915e583a159df68df37ae07af6c0d192c41a01b87b801bb8e34c,
                    0x0290dae1610ff548cb70b44541697b651efc9b1591b18e475835975c378af8ae,
                ],
            )
                == 0x0f45a2dbfbec0cc0b1caf2e826e03a55a3115e7a525074a712399d070f944b05,
        );
    }
}
