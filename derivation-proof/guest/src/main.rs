//! A PCASH range proof: derive a run of Ethereum blocks from the anchor, or
//! from a checkpoint and the witness of the state the run touches.
//!
//! Input: the source, the range's start (`None` at the anchor), and the
//! Ethereum blocks in their consensus encodings. The program authenticates
//! each block against the one before it, derives it with the node's
//! `derive_block`, and commits the checkpoints the range starts from and
//! reaches.
#![no_main]
sp1_zkvm::entrypoint!(main);

mod crt;
mod eh;
mod verifier;

use alloy_primitives::B256;
use alloy_sol_types::SolValue;
use derivation_proof_core::l1::Chain;
use derivation_proof_core::{compiled_rules, PublicValues, RangeStart, RawBlock, Source};
use pcash_derive::derive_block;
use pcash_state::{Checkpoint, DerivationSource, StateDb, StateWitness, WitnessState};

pub fn main() {
    let source: Source = sp1_zkvm::io::read();
    let start: Option<RangeStart> = sp1_zkvm::io::read();
    let blocks: Vec<RawBlock> = sp1_zkvm::io::read();

    let derivation_source = DerivationSource {
        pcash_chain_id: source.pcash_chain_id,
        l1_chain_id: source.l1_chain_id,
        inbox_address: source.inbox_address,
        genesis_l1_block: source.genesis_l1_block,
        genesis_l1_block_hash: source.genesis_l1_block_hash,
    };
    let (pre, mut state, mut chain) = match start {
        None => {
            let state = WitnessState::genesis(derivation_source);
            let pre = Checkpoint {
                block_hash: B256::ZERO,
                aux: state.aux(),
            };
            let chain = Chain::from_anchor(source.genesis_l1_block, source.inbox_address);
            (pre, state, chain)
        }
        Some(start) => {
            let pre = Checkpoint {
                block_hash: start.block_hash,
                aux: start.aux,
            };
            let witness = StateWitness::decode(&start.witness).expect("state witness encoding");
            let state = WitnessState::open(derivation_source, pre, witness)
                .unwrap_or_else(|error| panic!("state witness: {error}"));
            let tip = state.canonical_tip().expect("a checkpoint has a tip");
            let chain = Chain::from_checkpoint(
                tip.l1_origin.block_number,
                tip.l1_origin.block_hash,
                source.inbox_address,
            );
            (pre, state, chain)
        }
    };

    let rules = compiled_rules();
    let verifier = verifier::Chonk::new();
    // Cycle trackers split the cost by phase; `derive` includes `bb`, and
    // `authenticate` includes `kzg`.
    for raw in &blocks {
        println!("cycle-tracker-report-start: authenticate");
        let block = chain.authenticate(raw);
        println!("cycle-tracker-report-end: authenticate");
        println!("cycle-tracker-report-start: derive");
        if let Err(error) = derive_block(&mut state, &block, &rules, &verifier) {
            panic!("derivation halted at L1 block {}: {error}", block.header.number);
        }
        println!("cycle-tracker-report-end: derive");
    }

    let (l1_number, l1_hash) = chain.last();
    let tip = state.canonical_tip_summary().expect("no PCASH block derived");
    let post = state.checkpoint().expect("no PCASH block derived");
    let public_values = PublicValues {
        pcashChainId: source.pcash_chain_id,
        l1ChainId: source.l1_chain_id,
        inboxAddress: source.inbox_address,
        genesisL1Block: source.genesis_l1_block,
        genesisL1BlockHash: source.genesis_l1_block_hash,
        preBlockHash: pre.block_hash,
        preAux: pre.aux,
        l1Number: l1_number,
        l1Hash: l1_hash,
        pcashNumber: tip.number,
        pcashHash: post.block_hash,
        aux: post.aux,
    };
    sp1_zkvm::io::commit_slice(&public_values.abi_encode());
}
