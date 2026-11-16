#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "real proof tests read the generated release artifacts"
)]
//! Exercise payout destination binding with the generated release proof and the
//! actual node verifier. Full registration/spend derivation runs in the E2E suite.

use pcash_derive::{private_value_profiles::PrivateValueShape, SectionLayout};
use pcash_verify::{BbProcessVerifier, Verifier};
use std::{fs, path::PathBuf};

fn bundle_path() -> PathBuf {
    let path = std::env::var("PCASH_CIRCUIT_BUNDLE")
        .ok()
        .filter(|path| !path.is_empty())
        .expect("real proof tests require PCASH_CIRCUIT_BUNDLE at runtime");
    PathBuf::from(path)
}

/// Proofs carry no length on the wire, so each layout's pinned size must be
/// the size the release prover produces.
#[test]
#[ignore = "requires the generated release artifacts"]
fn release_proofs_have_each_layout_pinned_size() {
    let bundle = bundle_path();
    for (known_name, layout) in [
        (
            "private_value",
            SectionLayout::PrivateValue(PrivateValueShape::S),
        ),
        (
            "private_value_large",
            SectionLayout::PrivateValue(PrivateValueShape::L),
        ),
        ("user_account_update", SectionLayout::UserAccountUpdate),
    ] {
        let proof = fs::read(bundle.join("known-answers").join(known_name).join("proof")).unwrap();
        assert_eq!(proof.len(), layout.proof_bytes(), "{known_name}");
    }
}

#[test]
#[ignore = "requires the pinned native verifier and authenticated CRS"]
fn real_private_value_proof_binds_its_payout_destination() {
    for shape in [PrivateValueShape::S, PrivateValueShape::L] {
        check_private_value_proof(shape);
    }
}

fn check_private_value_proof(shape: PrivateValueShape) {
    let profile = shape.profile();
    let (known_name, hiding_kernel) = match shape {
        PrivateValueShape::S => ("private_value", "private_value_hiding_kernel"),
        PrivateValueShape::L => ("private_value_large", "private_value_large_hiding_kernel"),
    };
    let bundle = bundle_path();
    let known = bundle.join("known-answers").join(known_name);
    let proof = fs::read(known.join("proof")).unwrap();
    let inputs = fs::read(known.join("public_inputs")).unwrap();
    let rejected = fs::read(known.join("proof.rejected")).unwrap();
    let vk = fs::read(bundle.join("vks").join(format!("{hiding_kernel}.chonk.vk"))).unwrap();
    assert_eq!(inputs.len(), profile.public_inputs * 32);
    let verifier = BbProcessVerifier::from_env().unwrap();
    assert!(verifier.verify(&vk, &proof, &inputs).unwrap());
    assert!(!verifier.verify(&vk, &rejected, &inputs).unwrap());
    for destination in [
        profile.issuance_owner_offset,
        profile.nullifiers_offset + profile.inputs - 1,
        profile.outputs_offset + profile.outputs - 1,
        // A proof states the carrier context it requires; no other one
        // verifies.
        profile.carrier_context_hash_offset,
        profile.public_inputs - 1, // accountCreationCommitment
    ] {
        let mut changed = inputs.clone();
        changed[destination * 32..(destination + 1) * 32].fill(0);
        changed[(destination + 1) * 32 - 1] = 1;
        assert_ne!(changed, inputs);
        assert!(!verifier.verify(&vk, &proof, &changed).unwrap());
    }
}

#[test]
#[ignore = "requires the pinned native verifier and authenticated CRS"]
fn shared_claim_proofs_have_only_one_common_replay_identity() {
    let bundle = bundle_path();
    let verifier = BbProcessVerifier::from_env().unwrap();
    let mut statements = Vec::new();
    for (name, shape, hiding_kernel) in [
        (
            "shared_claim_s",
            PrivateValueShape::S,
            "private_value_hiding_kernel",
        ),
        (
            "shared_claim_l",
            PrivateValueShape::L,
            "private_value_large_hiding_kernel",
        ),
    ] {
        let known = bundle.join("known-answers").join(name);
        let proof = fs::read(known.join("proof")).unwrap();
        let inputs = fs::read(known.join("public_inputs")).unwrap();
        let vk = fs::read(bundle.join("vks").join(format!("{hiding_kernel}.chonk.vk"))).unwrap();
        assert!(verifier.verify(&vk, &proof, &inputs).unwrap());
        let profile = shape.profile();
        statements.push(
            inputs[profile.nullifiers_offset * 32..profile.outputs_offset * 32]
                .chunks_exact(32)
                .map(|word| word.to_vec())
                .collect::<Vec<_>>(),
        );
    }
    let shared = statements[0]
        .iter()
        .filter(|word| statements[1].contains(word))
        .collect::<Vec<_>>();
    assert_eq!(
        shared.len(),
        1,
        "only the application marker may collide; real funding is disjoint"
    );
    assert_eq!(shared[0], statements[0].last().unwrap());
    assert_eq!(shared[0], statements[1].last().unwrap());
}

#[test]
#[ignore = "requires the pinned native verifier and authenticated CRS"]
fn real_event_proof_binds_the_public_event_commitment() {
    let bundle = bundle_path();
    let known = bundle.join("known-answers/real_event");
    let proof = fs::read(known.join("proof")).unwrap();
    let inputs = fs::read(known.join("public_inputs")).unwrap();
    let vk = fs::read(bundle.join("vks/private_value_hiding_kernel.chonk.vk")).unwrap();
    let verifier = BbProcessVerifier::from_env().unwrap();
    assert!(verifier.verify(&vk, &proof, &inputs).unwrap());
    let mut changed = inputs.clone();
    let event_word = PrivateValueShape::S
        .profile()
        .account_creation_commitment_offset
        - 1;
    changed[event_word * 32 + 31] ^= 1;
    assert!(!verifier.verify(&vk, &proof, &changed).unwrap());
}
