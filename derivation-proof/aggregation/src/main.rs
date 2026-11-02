//! Aggregate a chain of PCASH range proofs into one proof, as op-succinct's
//! aggregation program does for its range proofs, with the public values
//! `PcashState` checks.
//!
//! Each range proof is verified against the range program's key, each range
//! must start from the checkpoint the one before it reached, and all must
//! derive the same network. The ranges' Ethereum blocks are continuous
//! because each range starts from its checkpoint's Ethereum block.
//!
//! The Ethereum head the proof names may be later than the last block
//! derived, as in op-succinct, so a contract that reads recent block hashes
//! can check it however long proving took: the headers in between must link
//! by parent hash from the last range's block to the head.
#![no_main]
sp1_zkvm::entrypoint!(main);

use alloy_primitives::{keccak256, B256, U256};
use alloy_rlp::Decodable;
use alloy_sol_types::SolValue;
use derivation_proof_types::{
    checkpoint_root, config_hash, AggregationInput, AggregationOutputs, PublicValues, Source,
};
use sha2::{Digest, Sha256};

fn source(values: &PublicValues) -> Source {
    Source {
        pcash_chain_id: values.pcashChainId,
        l1_chain_id: values.l1ChainId,
        inbox_address: values.inboxAddress,
        genesis_l1_block: values.genesisL1Block,
        genesis_l1_block_hash: values.genesisL1BlockHash,
    }
}

/// An RLP-encoded Ethereum header's first field. The last header's hash is
/// checked against Ethereum, so each one before it is the real header and its
/// first field the real parent hash.
fn parent_hash(header: &[u8]) -> B256 {
    let mut fields = header;
    let list = alloy_rlp::Header::decode(&mut fields).expect("header encoding");
    assert!(list.list, "header encoding");
    B256::decode(&mut fields).expect("header parent hash")
}

pub fn main() {
    let input: AggregationInput = sp1_zkvm::io::read();
    assert!(!input.ranges.is_empty(), "no range proofs");
    let ranges: Vec<PublicValues> = input
        .ranges
        .iter()
        .map(|bytes| {
            // A range proof commits its ABI-encoded public values; SP1 binds
            // a proof to the SHA-256 digest of what the program committed.
            sp1_lib::verify::verify_sp1_proof(&input.range_vkey, &Sha256::digest(bytes).into());
            PublicValues::abi_decode(bytes).expect("range public values")
        })
        .collect();
    for pair in ranges.windows(2) {
        let (previous, next) = (&pair[0], &pair[1]);
        assert_eq!(previous.pcashHash, next.preBlockHash, "ranges are not consecutive");
        assert_eq!(previous.aux, next.preAux, "ranges are not consecutive");
        assert_eq!(source(previous), source(next), "ranges derive different networks");
    }

    let (first, last) = (&ranges[0], &ranges[ranges.len() - 1]);
    let mut l1_head = last.l1Hash;
    for header in &input.headers {
        assert_eq!(parent_hash(header), l1_head, "Ethereum headers do not link");
        l1_head = keccak256(header);
    }
    let range_vkey: Vec<u8> = input
        .range_vkey
        .iter()
        .flat_map(|word| word.to_be_bytes())
        .collect();
    let outputs = AggregationOutputs {
        l1Head: l1_head,
        l2PreRoot: checkpoint_root(first.preBlockHash, first.preAux),
        claimRoot: checkpoint_root(last.pcashHash, last.aux),
        claimBlockNum: U256::from(last.pcashNumber),
        configHash: config_hash(&source(last)),
        rangeVkeyCommitment: B256::from_slice(&range_vkey),
        proverAddress: input.prover_address,
    };
    sp1_zkvm::io::commit_slice(&outputs.abi_encode());
}
