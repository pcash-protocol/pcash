use alloy_primitives::{Address, B256};
use pcash_state::codec::{codec_struct, codec_variants};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IndexedL1LogProof {
    pub block_number: u64,
    pub block_hash: B256,
    pub block_timestamp: u64,
    pub logs_root: B256,
    pub log_count: u64,
    pub leaf_index: u64,
    pub transaction_index: u64,
    pub log_index: u64,
    pub siblings: Vec<B256>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct IndexedL1Log {
    pub leaf_index: u64,
}

codec_struct!(IndexedL1Log { leaf_index });

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct IndexedL1LogBlock {
    pub block_hash: B256,
    pub block_timestamp: u64,
    pub logs_root: B256,
    pub log_count: u64,
}

codec_struct!(IndexedL1LogBlock {
    block_hash,
    block_timestamp,
    logs_root,
    log_count
});

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct IndexBlockId {
    pub number: u64,
    pub hash: B256,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DerivedIndexCursor {
    pub chain_id: u32,
    pub genesis_hash: B256,
    pub pcash_number: u64,
    pub pcash_hash: B256,
}

codec_struct!(DerivedIndexCursor {
    chain_id,
    genesis_hash,
    pcash_number,
    pcash_hash
});

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DerivedIndexLifecycle {
    Ready(DerivedIndexCursor),
    CatchingUp { cursor: Option<DerivedIndexCursor> },
    Unavailable,
}

/// One indexed PCASH block, keyed by its number: the identity a cursor or
/// rewind target must match, the output count at its end, and its L1 origin.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct IndexedBlockRow {
    pub hash: B256,
    pub output_count: u64,
    pub l1_block_number: u64,
}

codec_struct!(IndexedBlockRow {
    hash,
    output_count,
    l1_block_number
});

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IndexedOutputItem {
    pub output_index: u64,
    pub output_commitment: B256,
    pub material: IndexedOutputMaterial,
    pub pcash_block_number: u64,
    pub pcash_block_hash: B256,
}

codec_struct!(IndexedOutputItem {
    output_index,
    output_commitment,
    material,
    pcash_block_number,
    pcash_block_hash
});

impl IndexedOutputItem {
    /// The first output index of the page unit this row belongs to: its
    /// transaction's slot-0 row, or the row itself for a system payout.
    pub(super) fn unit_start(&self) -> u64 {
        match &self.material {
            IndexedOutputMaterial::Ordinary { output_slot, .. } => {
                self.output_index - u64::from(*output_slot)
            }
            IndexedOutputMaterial::System { .. } => self.output_index,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum IndexedOutputMaterial {
    Ordinary {
        output_data: Vec<u8>,
        transaction_id: B256,
        transaction_kind: u8,
        private_value_shape: Option<u8>,
        output_slot: u16,
        content_hash: B256,
        /// Every nullifier the transaction inserted, in input-slot order, on
        /// its slot-0 row; empty on every other row.
        nullifiers: Vec<B256>,
        /// The transaction's arena on its slot-0 row; empty on every other
        /// row.
        arena: Vec<u8>,
    },
    System {
        transaction_id: Option<B256>,
        payout: pcash_state::PayoutRecord,
    },
}

codec_variants!(IndexedOutputMaterial: u8 {
    0 => Ordinary {
        output_data,
        transaction_id,
        transaction_kind,
        private_value_shape,
        output_slot,
        content_hash,
        nullifiers,
        arena
    },
    1 => System { transaction_id, payout },
});

/// One page's budget. A page holds only whole units: every row of one
/// transaction, or one system payout row.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct OutputLimits {
    /// Charged one per row.
    pub max_outputs: u32,
    /// Charged against each row's stored length, not its response encoding.
    pub max_bytes: u32,
}

impl OutputLimits {
    pub const HARD_MAX_OUTPUTS: u32 = 10_000;
    pub const HARD_MAX_BYTES: u32 = 4 * 1024 * 1024;

    pub(super) fn bounded(self) -> Result<Self, OutputError> {
        if self.max_outputs == 0
            || self.max_outputs > Self::HARD_MAX_OUTPUTS
            || self.max_bytes == 0
            || self.max_bytes > Self::HARD_MAX_BYTES
        {
            return Err(OutputError::InvalidRequest(
                "output limits are outside the supported range".into(),
            ));
        }
        Ok(self)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OutputContinuation {
    pub from_output_index: u64,
    pub target: IndexBlockId,
    pub target_output_count: u64,
    pub next_output_index: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OutputTarget {
    pub block: IndexBlockId,
    pub output_count: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OutputPage {
    pub from_output_index: u64,
    pub target: OutputTarget,
    pub outputs: Vec<IndexedOutputItem>,
    pub continuation: Option<OutputContinuation>,
    pub complete: bool,
}

#[derive(Debug, thiserror::Error)]
pub enum OutputError {
    #[error("derived index unavailable: {0}")]
    Unavailable(String),
    #[error("output cursor does not identify the canonical indexed branch")]
    CursorMismatch,
    #[error("invalid output request: {0}")]
    InvalidRequest(String),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReceiveMaterialUpdate {
    pub key: Option<Vec<u8>>,
}

codec_struct!(ReceiveMaterialUpdate { key });

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ContractMaterialUpdate {
    pub address: Address,
    pub pcash_block_number: u64,
    pub pcash_block_hash: B256,
    /// Dense ordinal across every admitted transaction in the PCASH block.
    pub pcash_transaction_index: u64,
    pub transaction_id: B256,
    pub timestamp: u64,
    pub nullifier_key_commitment: B256,
    pub account_rule_set_commitment: B256,
    pub functions: Vec<ContractFunctionMaterial>,
    pub l1_block_number: u64,
    pub l1_block_hash: B256,
    pub l1_transaction_index: u64,
    pub l1_transaction_hash: B256,
    pub batch_item_index: u64,
}

codec_struct!(ContractMaterialUpdate {
    address,
    pcash_block_number,
    pcash_block_hash,
    pcash_transaction_index,
    transaction_id,
    timestamp,
    nullifier_key_commitment,
    account_rule_set_commitment,
    functions,
    l1_block_number,
    l1_block_hash,
    l1_transaction_index,
    l1_transaction_hash,
    batch_item_index
});

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ContractFunctionMaterial {
    pub selector: u8,
    pub application_vk_hash: B256,
    pub configuration_commitment: B256,
}

codec_struct!(ContractFunctionMaterial {
    selector,
    application_vk_hash,
    configuration_commitment
});

/// Source-verification status and configuration-opening count for one contract.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ContractSourceInfo {
    pub verified: bool,
    pub opening_count: u64,
}

codec_struct!(ContractSourceInfo {
    verified,
    opening_count
});

/// Resolves a contract's verification status against the current source registry.
pub trait ContractVerificationLookup: Send + Sync {
    /// `None` means verification is unavailable (disabled or not loaded), and
    /// removes the contract's existing verification rows.
    fn lookup(
        &self,
        address: Address,
        functions: &[ContractFunctionMaterial],
    ) -> Option<ContractSourceInfo>;
}

#[derive(Clone, Debug, Default)]
pub(super) struct IndexUndoRow {
    pub(super) receive_keys: Vec<[u8; 24]>,
    pub(super) contract_addresses: Vec<Address>,
}

codec_struct!(IndexUndoRow {
    receive_keys,
    contract_addresses
});
