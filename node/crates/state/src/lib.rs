//! Canonical PCASH state and proof-friendly block commitments.

mod block;
pub mod codec;
mod commitment_tree;
mod delegate;
mod effects;
mod field;
mod history;
mod inner;
mod mem;
mod nullifier_tree;
mod read;
mod redb_backend;
mod source;
mod tree;

pub use block::{
    content_hash, result_tree_path, transaction_id, transaction_results_root,
    transaction_statement_hash, BlockHeader, BlockInput, BlockSummary, L1Origin, PcashBlock,
    PcashBlockMetadata, StoredBlock, TransactionOutcome, TransactionResult,
    BLOCK_HEADER_KEY_HISTORY_ROOT, BLOCK_HEADER_KEY_L1_ORIGIN_ROOT, BLOCK_HEADER_KEY_NUMBER,
    BLOCK_HEADER_KEY_PARENT_HASH, BLOCK_HEADER_KEY_STATE_ROOT, BLOCK_HEADER_KEY_TIMESTAMP,
    BLOCK_HEADER_KEY_TRANSACTION_RESULTS_ROOT, BLOCK_HEADER_LEAF_COUNT, COMMITMENT_TREE_DEPTH,
    TRANSACTION_RESULTS_TREE_DEPTH,
};
pub use codec::{Codec, DecodeError};
pub use effects::{
    AcceptedEffects, AccountField, AccountKindDetail, AccountResult, ContractField, FailureDetail,
    FailureDetailSeed, L1LogLeaf, PayoutIntent, ReceiveKeyOperation, RejectedEffects,
    TransactionEffects,
};
pub use field::{
    addr_to_fr, address_from_word, fr_from_canonical_bytes, fr_from_internal_word, fr_to_bytes,
    u256_to_fr, word_to_u256,
};
pub use history::{
    admitted_delivery, payout_output_commitment, BatchExclusionReason, BlockEconomics,
    CanonicalBlockHistory, CarrierType, ItemExclusionReason, L1DeliveryBatch, L1DeliveryItem,
    PayoutComponent, PayoutRecord, PayoutSource,
};
pub use inner::{
    account_state_commitment, history_leaf, output_commitment, state_root_from_components,
    InnerState, StateCommitment, MAX_LEAVES, RECENT_PCASH_BLOCK_WINDOW_SECONDS,
    STATE_KEY_ACCOUNT_COUNT, STATE_KEY_ACCOUNT_STATE_ROOT, STATE_KEY_ISSUED_SO_FAR,
    STATE_KEY_LAG_HIGH128, STATE_KEY_LAG_LOW128, STATE_KEY_NULLIFIER_COUNT,
    STATE_KEY_NULLIFIER_ROOT, STATE_KEY_OUTPUT_COUNT, STATE_KEY_OUTPUT_ROOT, STATE_LEAF_COUNT,
    STATE_TREE_DEPTH, TREE_DEPTH,
};
pub use mem::MemState;
pub use nullifier_tree::{NullifierLeaf, NullifierProof, NullifierTree, NULLIFIER_TREE_DEPTH};
pub use read::StateRead;
pub use redb_backend::{
    AdoptedForkCompatibility, PersistedCheckpoint, RedbReadSnapshot, RedbState, RedbStateReader,
};
pub use source::{l1_origin_leaf, DerivationSource};
pub use tree::SparseTree;

pub use alloy_primitives::{Address, B256, I256, U256};
pub use pcash_crypto::Fr;
pub use pcash_issuance::IssuanceState;

/// A 32-byte circuit public-input word. Words decoded from a transaction are
/// kept as posted; execution checks that each is a canonical BN254 field encoding.
pub type CircuitWord = B256;

use std::fmt;

pub const ML_KEM768_PUBLIC_KEY_LEN: usize = 1_184;

/// Named circuit-facing mutable state trees.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TreeId {
    Output,
    Account,
}

impl TreeId {
    pub(crate) fn index(self) -> usize {
        match self {
            Self::Output => 0,
            Self::Account => 1,
        }
    }
}

/// The `receiveKeyHash` of an exact ML-KEM-768 public key:
/// `poseidonBytes(RECEIVE_KEY_HASH_DOMAIN, key)`, as canonical field bytes.
pub fn receive_key_hash(key: &[u8]) -> B256 {
    fr_to_bytes(pcash_crypto::poseidon_bytes(
        pcash_crypto::domain_tags::RECEIVE_KEY_HASH_DOMAIN,
        key,
    ))
}

#[derive(Clone, Debug)]
pub struct AccountOp {
    pub address: Address,
    pub nullifier_key_commitment: Fr,
    pub account_rule_set_commitment: Fr,
    /// `0` user, `1` contract; immutable after creation.
    pub kind: u8,
    /// [`receive_key_hash`] of the account's receive key after this write; zero means none.
    pub receive_key_hash: B256,
    /// Exact ML-KEM-768 public key this write introduces: a creation with a
    /// key or a replacement. `None` when the write keeps, clears, or has no key.
    pub published_receive_key: Option<Vec<u8>>,
}

/// One account write as the state engine applied it: the complete account row
/// after the write and the exact receive key the write introduced.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AccountWrite {
    pub address: Address,
    pub account: AccountState,
    pub published_receive_key: Option<Vec<u8>>,
}

codec::codec_struct!(AccountWrite {
    address,
    account,
    published_receive_key,
});

/// An [`AccountWrite`] at its canonical position: block, then the order the
/// state engine applied the block's writes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AccountWriteEntry {
    pub block_number: u64,
    pub block_hash: B256,
    pub ordinal: u32,
    pub write: AccountWrite,
}

/// The output tree committed by one block and its append frontier: for each
/// set bit `h` of `output_count`, ascending, the complete node at height `h`
/// and index `(output_count >> h) - 1`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OutputFrontier {
    pub output_count: u64,
    pub output_root: B256,
    pub ommers: Vec<B256>,
}

/// All canonical mutations produced by one L1 block. Block identity and L1
/// provenance are supplied separately in the required [`BlockInput`].
#[derive(Clone, Debug)]
pub struct BlockUpdate {
    pub output_commitments: Vec<Fr>,
    pub issuance: IssuanceState,
    pub account_ops: Vec<AccountOp>,
    /// Exact nonzero canonical BN254 encodings.
    pub nullifiers: Vec<B256>,
}

impl BlockUpdate {
    /// No outputs, account writes, or nullifiers; the issuance state after the
    /// block is `issuance`.
    pub fn empty(issuance: IssuanceState) -> Self {
        Self {
            output_commitments: Vec::new(),
            issuance,
            account_ops: Vec::new(),
            nullifiers: Vec::new(),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
/// Consensus-authenticated state stored for one account.
pub struct AccountState {
    pub index: u64,
    pub revision: u32,
    pub nullifier_key_commitment: Fr,
    pub account_rule_set_commitment: Fr,
    pub kind: u8,
    /// [`receive_key_hash`] of the account's receive key; zero means no receive key.
    pub receive_key_hash: B256,
}

codec::codec_struct!(AccountState {
    index,
    revision,
    nullifier_key_commitment,
    account_rule_set_commitment,
    kind,
    receive_key_hash,
});

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StateComponents {
    pub output_root: B256,
    pub output_count: u64,
    pub issuance: IssuanceState,
    pub account_state_root: B256,
    pub account_count: u64,
    pub nullifier_root: B256,
    pub nullifier_count: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StateOutcome {
    pub state_root: StateRoot,
    pub output_leaf_start: u64,
    pub outputs_added: u64,
    pub inserted_nullifiers: Vec<B256>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommittedBoundary {
    pub block: PcashBlock,
    pub history: CanonicalBlockHistory,
    pub state: StateCommitment,
    pub l1_origin: L1Origin,
    pub state_outcome: StateOutcome,
}

/// Full canonical-boundary retention in the local state store.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BoundaryRetention {
    pub oldest_contiguous: u64,
    pub tip: u64,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub struct StateRoot(pub B256);

impl StateRoot {
    pub fn as_bytes(&self) -> &[u8; 32] {
        self.0.as_ref()
    }

    pub fn to_hex(&self) -> String {
        format!("{}", self.0)
    }
}

impl fmt::Debug for StateRoot {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "StateRoot({})", self.to_hex())
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum StateError {
    MissingCanonicalBoundary(u64),
    SavepointNotFound(u64),
    InvalidForkAdoption,
    ForkDowngrade,
    Backend(String),
}

impl fmt::Display for StateError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{self:?}")
    }
}

impl std::error::Error for StateError {}

/// Canonical state store. A successful commit returns the only boundary object
/// consumers may publish or index, with the block's transaction effects moved
/// out of `input`. A failed commit restores the in-memory state; an error from
/// the durable commit leaves the store's outcome unknown until it is reopened,
/// so derivation treats every commit error as fatal.
pub trait StateDb {
    fn commit(
        &mut self,
        input: BlockInput,
        update: BlockUpdate,
    ) -> Result<(CommittedBoundary, Vec<TransactionEffects>), StateError>;

    fn state_root(&self) -> StateRoot;
    fn state_components(&self) -> StateComponents;
    fn issuance_state(&self) -> IssuanceState;
    fn derivation_source(&self) -> DerivationSource;

    fn canonical_tip(&self) -> Option<StoredBlock>;
    fn canonical_tip_summary(&self) -> Option<BlockSummary>;
    fn canonical_stored_block(&self, number: u64) -> Result<Option<StoredBlock>, StateError>;
    fn canonical_stored_block_by_hash(&self, hash: B256)
        -> Result<Option<StoredBlock>, StateError>;
    fn canonical_block_metadata(
        &self,
        number: u64,
    ) -> Result<Option<PcashBlockMetadata>, StateError>;
    fn canonical_block_metadata_by_hash(
        &self,
        hash: B256,
    ) -> Result<Option<PcashBlockMetadata>, StateError>;
    fn canonical_transaction_body(
        &self,
        number: u64,
        transaction_index: u64,
    ) -> Result<Option<Vec<u8>>, StateError>;
    /// Effects of every admitted transaction in canonical block `number`,
    /// aligned with its transaction results.
    fn canonical_transaction_effects(
        &self,
        number: u64,
    ) -> Result<Option<Vec<TransactionEffects>>, StateError>;
    fn canonical_block(&self, number: u64) -> Result<Option<PcashBlock>, StateError>;
    fn committed_boundary(&self, number: u64) -> Result<Option<CommittedBoundary>, StateError>;
    fn committed_boundary_by_block_hash(
        &self,
        hash: B256,
    ) -> Result<Option<CommittedBoundary>, StateError>;
    /// Every carrier this PCASH block was derived from, in L1 transaction
    /// order and then carrier order. A block's transaction results carry an L1
    /// transaction index; these manifests are what name the transaction that
    /// index refers to.
    fn l1_delivery_batches(&self, number: u64) -> Result<Vec<L1DeliveryBatch>, StateError>;
    fn block_economics(&self, number: u64) -> Result<Option<BlockEconomics>, StateError>;
    fn payout_records(&self, number: u64) -> Result<Option<Vec<PayoutRecord>>, StateError> {
        Ok(self
            .committed_boundary(number)?
            .map(|boundary| boundary.history.payouts))
    }
    fn boundary_retention(&self) -> Option<BoundaryRetention>;

    fn last_l1_timestamp(&self) -> u64;
    fn genesis_l1_timestamp(&self) -> Option<u64>;

    fn output_root(&self) -> Fr;

    fn account_state_root(&self) -> Fr;
    fn output_count(&self) -> u64;

    fn account_count(&self) -> u64;

    fn path(&self, tree: TreeId, index: u64) -> Result<[Fr; TREE_DEPTH], StateError>;
    fn nullifier_seen(&self, nullifier: B256) -> Result<bool, StateError>;
    fn nullifier_proof(&self, nullifier: B256) -> Result<NullifierProof, StateError>;

    fn account_of(&self, addr: Address) -> Result<Option<AccountState>, StateError>;

    fn l1_origin_root(&self) -> Fr;
    fn l1_origin_path(&self, index: u64) -> Result<Option<[Fr; TREE_DEPTH]>, StateError>;
    fn output_path_at(
        &self,
        number: u64,
        index: u64,
    ) -> Result<Option<[Fr; TREE_DEPTH]>, StateError>;
    fn l1_origin_path_at(
        &self,
        pcash_block_number: u64,
        index: u64,
    ) -> Result<Option<[Fr; TREE_DEPTH]>, StateError>;

    fn history_block_path_at(
        &self,
        at_block: u64,
        index: u64,
    ) -> Result<Option<[Fr; TREE_DEPTH]>, StateError>;
    fn block_header_path_at(
        &self,
        block_hash: B256,
        key: u64,
    ) -> Result<Option<(Fr, [Fr; COMMITMENT_TREE_DEPTH])>, StateError>;
    fn state_path_at(
        &self,
        block_hash: B256,
        key: u64,
    ) -> Result<Option<(Fr, [Fr; STATE_TREE_DEPTH])>, StateError>;
    fn recent_pcash_block_hash_in_window(&self, block_hash: B256, current_timestamp: u64) -> bool;

    /// Restore to the end of the PCASH block derived from `l1_block_number`.
    fn restore_to(&mut self, l1_block_number: u64) -> Result<StateRoot, StateError>;
    fn prune(&mut self, finalized_l1_block: u64) -> Result<(), StateError>;
}
