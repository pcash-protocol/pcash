// Shared CHONK circuit plumbing. Barretenberg replaces these empty proof
// placeholders with the preceding folded claims and appends the corresponding
// Oink/HyperNova consistency constraints to protocol kernel circuits.
// Applications are MegaApp circuits, protocol kernels are MegaKernel circuits,
// and hiding kernels are MegaZK circuits; each VK type below has its flavor's
// length.
//
// Stacks fold two applications, or three for sponsored transfers, followed by
// the protocol kernel and hiding kernel. A single-rule kernel folds an event
// application second, including the reference no-op.
//
// The prover supplies both the key and its claimed hash, and every pin compares
// the hash: the rule entry in the kernels and the kernel allowlist in the
// hiding kernel. Event entries also bind the actual application hash. Each helper
// below therefore first binds the hash to the key it verifies with:
// `pcash_hash` is Barretenberg's canonical VK hash. The databus link from one
// circuit's return_data to the next one's call_data cannot be stated in Noir:
// in the pinned Barretenberg release (protocol spec §16),
// Chonk::process_kernel_public_inputs and the bus depot bind it, and
// Noir/ACVM execution alone does not check it. Keep the native
// recursiveComposition.proving.test.ts regressions when upgrading the backend.

use crate::primitives::hash::pcash_hash;

pub global MEGA_APP_VK_LENGTH_IN_FIELDS: u32 = 151;
pub global MEGA_KERNEL_VK_LENGTH_IN_FIELDS: u32 = 151;
global PROOF_TYPE_OINK: u32 = 1;
global PROOF_TYPE_HN: u32 = 2;
global PROOF_TYPE_HN_FINAL: u32 = 7;

pub struct AppVerificationKey {
    pub key: [Field; MEGA_APP_VK_LENGTH_IN_FIELDS],
    pub hash: Field,
}

pub struct KernelVerificationKey {
    pub key: [Field; MEGA_KERNEL_VK_LENGTH_IN_FIELDS],
    pub hash: Field,
}

pub fn verify_first_app(vk: AppVerificationKey) {
    assert(pcash_hash(vk.key) == vk.hash, "verification key hash must match the key");
    std::verify_proof_with_type(vk.key, [], [], vk.hash, PROOF_TYPE_OINK);
}

pub fn verify_next_app(vk: AppVerificationKey) {
    assert(pcash_hash(vk.key) == vk.hash, "verification key hash must match the key");
    std::verify_proof_with_type(vk.key, [], [], vk.hash, PROOF_TYPE_HN);
}

fn verify_hiding_input(vk: KernelVerificationKey) {
    assert(pcash_hash(vk.key) == vk.hash, "verification key hash must match the key");
    std::verify_proof_with_type(vk.key, [], [], vk.hash, PROOF_TYPE_HN_FINAL);
}

// The hiding kernel accepts one of its allowed protocol-kernel VKs and checks
// that the kernel's statement equals its public inputs.
pub fn hiding_kernel<let N: u32, let K: u32>(
    public_statement: [Field; N],
    transaction_statement: [Field; N],
    kernel_vk: KernelVerificationKey,
    allowed_kernel_vk_hashes: [Field; K],
) {
    for i in 0..N {
        assert(
            transaction_statement[i] == public_statement[i],
            "kernel statement must equal the public inputs",
        );
    }
    let mut allowed = false;
    for hash in allowed_kernel_vk_hashes {
        allowed = allowed | (kernel_vk.hash == hash);
    }
    assert(allowed, "kernel VK must be one the hiding kernel allows");
    verify_hiding_input(kernel_vk);
}

mod tests {
    use crate::primitives::hash::pcash_hash;
    use super::{
        AppVerificationKey, hiding_kernel, KernelVerificationKey, MEGA_APP_VK_LENGTH_IN_FIELDS,
        MEGA_KERNEL_VK_LENGTH_IN_FIELDS, verify_first_app, verify_hiding_input, verify_next_app,
    };

    #[test]
    fn test_each_verifier_accepts_a_key_with_its_hash() {
        let key = [7; MEGA_APP_VK_LENGTH_IN_FIELDS];
        verify_first_app(AppVerificationKey { key, hash: pcash_hash(key) });
        verify_next_app(AppVerificationKey { key, hash: pcash_hash(key) });
        verify_hiding_input(KernelVerificationKey { key, hash: pcash_hash(key) });
    }

    #[test(should_fail_with = "verification key hash must match the key")]
    fn test_first_app_rejects_a_hash_of_another_key() {
        verify_first_app(
            AppVerificationKey {
                key: [7; MEGA_APP_VK_LENGTH_IN_FIELDS],
                hash: pcash_hash([8; MEGA_APP_VK_LENGTH_IN_FIELDS]),
            },
        );
    }

    #[test(should_fail_with = "verification key hash must match the key")]
    fn test_next_app_rejects_a_hash_of_another_key() {
        verify_next_app(
            AppVerificationKey {
                key: [7; MEGA_APP_VK_LENGTH_IN_FIELDS],
                hash: pcash_hash([8; MEGA_APP_VK_LENGTH_IN_FIELDS]),
            },
        );
    }

    #[test(should_fail_with = "verification key hash must match the key")]
    fn test_hiding_input_rejects_a_hash_of_another_key() {
        verify_hiding_input(
            KernelVerificationKey {
                key: [7; MEGA_KERNEL_VK_LENGTH_IN_FIELDS],
                hash: pcash_hash([8; MEGA_KERNEL_VK_LENGTH_IN_FIELDS]),
            },
        );
    }

    #[test]
    fn test_hiding_kernel_accepts_each_allowed_kernel() {
        let key = [7; MEGA_KERNEL_VK_LENGTH_IN_FIELDS];
        let vk = KernelVerificationKey { key, hash: pcash_hash(key) };
        hiding_kernel([1, 2], [1, 2], vk, [vk.hash, 5, 6]);
        hiding_kernel([1, 2], [1, 2], vk, [5, 6, vk.hash]);
    }

    #[test(should_fail_with = "kernel VK must be one the hiding kernel allows")]
    fn test_hiding_kernel_rejects_a_kernel_outside_its_allowlist() {
        let key = [7; MEGA_KERNEL_VK_LENGTH_IN_FIELDS];
        hiding_kernel(
            [1, 2],
            [1, 2],
            KernelVerificationKey { key, hash: pcash_hash(key) },
            [5, 6],
        );
    }

    #[test(should_fail_with = "kernel statement must equal the public inputs")]
    fn test_hiding_kernel_rejects_a_statement_other_than_the_public_inputs() {
        let key = [7; MEGA_KERNEL_VK_LENGTH_IN_FIELDS];
        let vk = KernelVerificationKey { key, hash: pcash_hash(key) };
        hiding_kernel([1, 2], [1, 3], vk, [vk.hash]);
    }

    // An allowed kernel hash must also be the key the hiding kernel verifies with.
    #[test(should_fail_with = "verification key hash must match the key")]
    fn test_hiding_kernel_rejects_an_allowed_hash_with_another_key() {
        let allowed = pcash_hash([8; MEGA_KERNEL_VK_LENGTH_IN_FIELDS]);
        hiding_kernel(
            [1, 2],
            [1, 2],
            KernelVerificationKey { key: [7; MEGA_KERNEL_VK_LENGTH_IN_FIELDS], hash: allowed },
            [allowed],
        );
    }
}
