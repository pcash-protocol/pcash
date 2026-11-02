//! What the derivation proof programs read and commit.
//!
//! A range proof derives a run of Ethereum blocks: from the anchor, or from a
//! checkpoint, a PCASH block hash with the commitment to its uncommitted state.

use alloy_primitives::{Address, FixedBytes, B256};
use serde::{Deserialize, Serialize};

/// The network being derived: the fields of the node's `DerivationSource`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Source {
    pub pcash_chain_id: u32,
    pub l1_chain_id: u64,
    pub inbox_address: Address,
    pub genesis_l1_block: u64,
    pub genesis_l1_block_hash: B256,
}

/// One Ethereum block in its consensus encodings: the RLP header, and each
/// transaction and receipt as its EIP-2718 encoding, in index order; plus the
/// blobs its inbox blob carriers name, in any order, each with its KZG
/// commitment and blob proof at the same position.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct RawBlock {
    pub header: Vec<u8>,
    pub transactions: Vec<Vec<u8>>,
    pub receipts: Vec<Vec<u8>>,
    #[serde(default)]
    pub blobs: Vec<Vec<u8>>,
    #[serde(default)]
    pub commitments: Vec<FixedBytes<48>>,
    #[serde(default)]
    pub proofs: Vec<FixedBytes<48>>,
}

/// Where a range starts when it does not start at the anchor: the checkpoint
/// and the encoded `pcash_state::StateWitness` of the range.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RangeStart {
    pub block_hash: B256,
    pub aux: B256,
    pub witness: Vec<u8>,
}

alloy_sol_types::sol! {
    /// A range proof's public values, ABI-encoded: the source; the checkpoint
    /// it starts from (a zero block hash and the empty state's commitment at
    /// the anchor); the last Ethereum block it derived; and the checkpoint it
    /// reaches.
    #[derive(Debug, PartialEq, Eq)]
    struct PublicValues {
        uint32 pcashChainId;
        uint64 l1ChainId;
        address inboxAddress;
        uint64 genesisL1Block;
        bytes32 genesisL1BlockHash;
        bytes32 preBlockHash;
        bytes32 preAux;
        uint64 l1Number;
        bytes32 l1Hash;
        uint64 pcashNumber;
        bytes32 pcashHash;
        bytes32 aux;
    }
}

/// The aggregation program's input: the range program's verification key
/// digest, each range proof's public values in order, the RLP-encoded
/// Ethereum headers after the last range's Ethereum block up to the head the
/// proof names, and the address the aggregation proof is bound to.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AggregationInput {
    pub range_vkey: [u32; 8],
    pub ranges: Vec<Vec<u8>>,
    pub headers: Vec<Vec<u8>>,
    pub prover_address: Address,
}

alloy_sol_types::sol! {
    /// The aggregation proof's public values, in the shape `PcashState`
    /// rebuilds and verifies (op-succinct's): an Ethereum block at or after the last one derived, the
    /// checkpoint roots before and after, the PCASH block number reached, the
    /// network, the range program's key, and the prover.
    #[derive(Debug, PartialEq, Eq)]
    struct AggregationOutputs {
        bytes32 l1Head;
        bytes32 l2PreRoot;
        bytes32 claimRoot;
        uint256 claimBlockNum;
        bytes32 configHash;
        bytes32 rangeVkeyCommitment;
        address proverAddress;
    }
}

/// The single root `PcashState` stores for a checkpoint: the PCASH block
/// hash and the commitment to its uncommitted state.
pub fn checkpoint_root(block_hash: B256, aux: B256) -> B256 {
    use alloy_sol_types::SolValue;
    alloy_primitives::keccak256((block_hash, aux).abi_encode())
}

/// `PcashState`'s configuration hash: the network being derived.
pub fn config_hash(source: &Source) -> B256 {
    use alloy_sol_types::SolValue;
    alloy_primitives::keccak256(
        (
            source.pcash_chain_id,
            source.l1_chain_id,
            source.inbox_address,
            source.genesis_l1_block,
            source.genesis_l1_block_hash,
        )
            .abi_encode(),
    )
}
