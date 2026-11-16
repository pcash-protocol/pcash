#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "tests use direct assertions for fixture setup"
)]
//! Known-answer tests against the repo's pinned vectors.

use std::collections::HashMap;
use std::str::FromStr;

use alloy_primitives::B256;
use ark_ff::PrimeField;
use pcash_crypto::{domain_tags, merkle, poseidon, poseidon_bytes, Fr};
use serde_json::Value;

const POSEIDON_VECTORS: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../vectors/poseidon2_vectors.json"
));
const MERKLE_VECTORS: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../vectors/merkle_vectors.json"
));
const DOMAIN_TAGS: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../assets/domain_tags.json"
));
const BN254_SCALAR_MODULUS_HEX: &str =
    "0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001";

/// Context strings from `assets/gen_domain_tags.mjs` / protocol spec §2.5.
const DOMAIN_CONTEXTS: &[(&str, &str)] = &[
    (
        "NULLIFIER_KEY_COMMITMENT_DOMAIN",
        "nullifier_key_commitment",
    ),
    ("NOTE_NULLIFIER_KEY_DOMAIN", "note_nullifier_key"),
    ("PAYOUT_SEED_DOMAIN", "payout_seed"),
    ("PAYOUT_TX_CONTEXT_DOMAIN", "payout_tx_context"),
    ("PAYOUT_NOTE_SECRET_DOMAIN", "payout_note_secret"),
    ("OWNER_COMMITMENT_DOMAIN", "owner_commitment"),
    ("NOTE_BODY_COMMITMENT_DOMAIN", "note_body_commitment"),
    ("OUTPUT_COMMITMENT_DOMAIN", "output_commitment"),
    ("NULLIFIER_DOMAIN", "nullifier"),
    ("DUMMY_NULLIFIER_DOMAIN", "dummy_nullifier"),
    ("APPLICATION_NULLIFIER_DOMAIN", "application_nullifier"),
    ("ASSET_ID_DOMAIN", "asset_id"),
    ("ASSET_SECRET_COMMITMENT_DOMAIN", "asset_secret_commitment"),
    ("ASSET_CREATION_MARKER_DOMAIN", "asset_creation_marker"),
    (
        "CONTRACT_FEE_SPONSORSHIP_ACTION_DOMAIN",
        "contract_fee_sponsorship_action",
    ),
    (
        "IMPLICIT_NOTE_SECRET_SEED_DOMAIN",
        "implicit_note_secret_seed",
    ),
    ("TRANSACT_NOTE_SECRET_DOMAIN", "transact_note_secret"),
    ("EVENT_DOMAIN", "transaction_events"),
    ("EVENT_ENTRY_DOMAIN", "transaction_event_entry"),
    (
        "PRIVATE_VALUE_COMMITMENT_DOMAIN",
        "private_value_commitment",
    ),
    ("OUTPUT_DATA_HASH_DOMAIN", "output_data_hash"),
    ("ARENA_HASH_DOMAIN", "arena_hash"),
    ("DELIVERY_COMMITMENT_DOMAIN", "delivery_commitment"),
    (
        "ACCOUNT_CREATION_ATTACHMENT_DOMAIN",
        "account_creation_attachment",
    ),
    ("STATE_COMMITMENT_DOMAIN", "state_commitment"),
    ("BLOCK_HEADER_DOMAIN", "block_header"),
    ("GENESIS_PARENT_DOMAIN", "genesis_parent"),
    ("L1_ORIGIN_DOMAIN", "l1_origin"),
    ("L1_LOG_DOMAIN", "l1_log"),
    ("HISTORY_LEAF_DOMAIN", "history_leaf"),
    ("NULLIFIER_LEAF_DOMAIN", "nullifier_leaf"),
    ("TRANSACTION_STATEMENT_DOMAIN", "transaction_statement"),
    ("TRANSACTION_RESULT_DOMAIN", "transaction_result"),
    ("PAYOUT_RESULT_DOMAIN", "payout_result"),
    (
        "TRANSACTION_RESULTS_ROOT_DOMAIN",
        "transaction_results_root",
    ),
    ("TRANSACTION_ID_DOMAIN", "transaction_id"),
    (
        "AUTHORIZATION_COMMITMENT_DOMAIN",
        "authorization_commitment",
    ),
    ("TRANSFER_ACTION_DOMAIN", "transfer_action"),
    ("ASSET_CREATION_ACTION_DOMAIN", "asset_creation_action"),
    (
        "SPONSORED_TRANSFER_ACTION_DOMAIN",
        "sponsored_transfer_action",
    ),
    ("ACCOUNT_UPDATE_ACTION_DOMAIN", "account_update_action"),
    (
        "ACCOUNT_UPDATE_COMMITMENT_DOMAIN",
        "account_update_commitment",
    ),
    (
        "ACCOUNT_STATE_COMMITMENT_DOMAIN",
        "account_state_commitment",
    ),
    ("RECEIVE_KEY_HASH_DOMAIN", "receive_key_hash"),
    ("ACCOUNT_RULE_ENTRY_DOMAIN", "account_rule_entry"),
    ("CONTRACT_ADDRESS_DOMAIN", "contract_address"),
    ("CARRIER_CONTEXT_DOMAIN", "carrier_context"),
];

fn fr(s: &str) -> Fr {
    let s = s.strip_prefix("0x").unwrap_or(s);
    let s = if s.len() % 2 == 1 {
        format!("0{s}")
    } else {
        s.to_string()
    };
    Fr::from_be_bytes_mod_order(&hex::decode(s).unwrap())
}

fn rust_domain_tags() -> HashMap<&'static str, Fr> {
    domain_tags::FIELD_DOMAIN_TAGS.iter().copied().collect()
}

#[test]
fn vector_metadata_identifies_the_exact_scalar_field() {
    let poseidon: Value = serde_json::from_str(POSEIDON_VECTORS).unwrap();
    let merkle: Value = serde_json::from_str(MERKLE_VECTORS).unwrap();
    let domain_tags: Value = serde_json::from_str(DOMAIN_TAGS).unwrap();
    assert_eq!(poseidon["fieldModulus"], BN254_SCALAR_MODULUS_HEX);
    assert_eq!(merkle["fieldModulus"], BN254_SCALAR_MODULUS_HEX);
    assert_eq!(domain_tags["fieldModulus"], BN254_SCALAR_MODULUS_HEX);
}

#[test]
fn poseidon_sponge_matches_all_vectors() {
    let v: Value = serde_json::from_str(POSEIDON_VECTORS).unwrap();
    let vectors = v["poseidonVectors"].as_array().unwrap();
    assert!(!vectors.is_empty());
    let mut count = 0;
    for (i, vec) in vectors.iter().enumerate() {
        let inputs: Vec<Fr> = vec["inputs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|x| fr(x.as_str().unwrap()))
            .collect();
        let expected = fr(vec["output"].as_str().unwrap());
        let got = poseidon(&inputs);
        assert_eq!(got, expected, "poseidon vector {i} (N={})", inputs.len());
        count += 1;
    }
    assert_eq!(count, vectors.len());
}

#[test]
fn byte_hash_matches_all_vectors() {
    let v: Value = serde_json::from_str(POSEIDON_VECTORS).unwrap();
    let vectors = v["byteHashVectors"].as_array().unwrap();
    assert!(!vectors.is_empty());
    for (i, vec) in vectors.iter().enumerate() {
        let bytes =
            hex::decode(vec["bytes"].as_str().unwrap().strip_prefix("0x").unwrap()).unwrap();
        assert_eq!(
            poseidon_bytes(fr(vec["domain"].as_str().unwrap()), &bytes),
            fr(vec["output"].as_str().unwrap()),
            "byte hash vector {i} ({} bytes)",
            bytes.len()
        );
    }
}

#[test]
fn empty_ladder_matches_vectors() {
    let v: Value = serde_json::from_str(MERKLE_VECTORS).unwrap();
    let ladder = v["emptyLadder"].as_array().unwrap();
    // h = 0..=64, covering the normalized L1 log tree.
    assert_eq!(ladder.len(), 65);
    for entry in ladder {
        let h = entry["height"].as_u64().unwrap() as usize;
        let expected = fr(entry["value"].as_str().unwrap());
        assert_eq!(merkle::empty(h), expected, "EMPTY[{h}]");
    }
}

#[test]
fn empty_roots_match_vectors() {
    let v: Value = serde_json::from_str(MERKLE_VECTORS).unwrap();
    let roots = v["emptyRoots"].as_object().unwrap();
    assert!(!roots.is_empty());
    for (key, value) in roots {
        let depth = key
            .rsplit_once("_depth_")
            .unwrap_or_else(|| panic!("empty root key {key} missing _depth_ suffix"))
            .1
            .parse::<usize>()
            .unwrap();
        assert_eq!(merkle::empty(depth), fr(value.as_str().unwrap()), "{key}");
    }
}

#[test]
fn membership_examples_produce_expected_roots() {
    let v: Value = serde_json::from_str(MERKLE_VECTORS).unwrap();
    let examples = v["membershipExamples"].as_array().unwrap();
    assert_eq!(examples.len(), 2);
    for ex in examples {
        let label = ex["label"].as_str().unwrap();
        let leaf = fr(ex["leaf"].as_str().unwrap());
        let index = ex["index"].as_u64().unwrap();
        let siblings: Vec<Fr> = ex["siblings"]
            .as_array()
            .unwrap()
            .iter()
            .map(|x| fr(x.as_str().unwrap()))
            .collect();
        let expected = fr(ex["expectedRoot"].as_str().unwrap());
        let got = merkle::root_from_index(leaf, index, &siblings);
        assert_eq!(got, expected, "membership example {label}");

        let bits = ex["indexBitsLSBFirst"].as_array().unwrap();
        assert_eq!(bits.len(), siblings.len());
        for (height, bit) in bits.iter().enumerate() {
            assert_eq!(
                (index >> height) & 1,
                bit.as_u64().unwrap(),
                "{label} index bit {height}"
            );
        }

        let mut cur = leaf;
        for step in ex["steps"].as_array().unwrap() {
            let height = step["height"].as_u64().unwrap();
            let key_bit = step["keyBit"].as_u64().unwrap();
            let side = step["side"].as_str().unwrap();
            let left = fr(step["left"].as_str().unwrap());
            let right = fr(step["right"].as_str().unwrap());
            let parent = fr(step["parent"].as_str().unwrap());
            assert_eq!(
                (index >> height) & 1,
                key_bit,
                "{label} step {height} key bit"
            );
            assert_eq!(poseidon(&[left, right]), parent, "{label} step {height}");
            if key_bit == 0 {
                assert_eq!(side, "left", "{label} step {height}");
                assert_eq!(left, cur, "{label} step {height} current node");
            } else {
                assert_eq!(side, "right", "{label} step {height}");
                assert_eq!(right, cur, "{label} step {height} current node");
            }
            cur = parent;
        }
        assert_eq!(cur, expected, "{label} walked steps");
    }
}

#[test]
fn domain_tags_match_generated_asset() {
    let v: Value = serde_json::from_str(DOMAIN_TAGS).unwrap();
    let tags = v["tags"].as_object().unwrap();
    let rust = rust_domain_tags();
    assert_eq!(tags.len(), domain_tags::FIELD_DOMAIN_TAGS.len());
    for (name, value) in tags {
        assert_eq!(
            *rust
                .get(name.as_str())
                .unwrap_or_else(|| panic!("missing rust constant {name}")),
            fr(value.as_str().unwrap()),
            "{name}"
        );
    }
    assert_eq!(
        domain_tags::profile_digest(),
        B256::from_str(v["fieldDomainProfileDigest"].as_str().unwrap()).unwrap()
    );
}

#[test]
fn domain_tags_match_formula() {
    let rust = rust_domain_tags();
    assert_eq!(DOMAIN_CONTEXTS.len(), domain_tags::FIELD_DOMAIN_TAGS.len());
    for (name, context) in DOMAIN_CONTEXTS {
        // poseidon(uint64(L), chunk_0, ..., chunk_(m-1)) over "pcash." || context.
        let bytes = format!("pcash.{context}").into_bytes();
        let mut inputs = vec![Fr::from(bytes.len() as u64)];
        inputs.extend(bytes.chunks(16).map(Fr::from_be_bytes_mod_order));
        let got = poseidon(&inputs);
        assert_eq!(
            *rust
                .get(name)
                .unwrap_or_else(|| panic!("missing rust constant {name}")),
            got,
            "{name}"
        );
    }
}
