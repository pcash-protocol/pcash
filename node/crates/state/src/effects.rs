//! What each admitted transaction did, and the L1 logs of each block's
//! L1 origin. Canonical commits store these beside the block so the derived
//! index is built from local data alone. The records themselves are not
//! committed, but most of what they hold is committed elsewhere: each log leaf
//! under the normalized-log root in the L1 origin leaf; outputs and nullifiers
//! in the output and nullifier trees; and the kind, output start and payout in
//! the results tree. The account tree holds each account's row only at block
//! boundaries, so a row that a later transaction in the same block updates is
//! in no tree, and an update's predecessor may be such a row. A successful
//! update's predecessor and successor account states are bound instead by its
//! `accountUpdateCommitment`, part of the statement its result commits.
//! Failure details, a rejected transaction's account, receive-key operations
//! and payout contexts have no commitment.

use crate::codec::{codec_enum, codec_struct, codec_variants, Codec, DecodeError, Reader, Writer};
use crate::{AccountState, Fr, TransactionOutcome};
use alloy_primitives::{Address, B256, U256};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AccountField {
    NullifierKeyCommitment,
    RuleSetCommitment,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ContractField {
    NullifierKeyMaterial,
    ApplicationVkHash,
    ConfigurationCommitment,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AccountKindDetail {
    User,
    Contract,
}

/// Deterministic, non-consensus explanation attached to one failed receipt.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum FailureDetail {
    PublicInputNotInField {
        #[serde(with = "alloy_serde::quantity")]
        public_input_index: u16,
        supplied: B256,
    },
    RecentPcashBlockNotInWindow {
        referenced_block_hash: B256,
        #[serde(with = "alloy_serde::quantity")]
        window_start_timestamp: u64,
        #[serde(with = "alloy_serde::quantity")]
        window_end_timestamp: u64,
    },
    Expired {
        valid_until: U256,
        #[serde(with = "alloy_serde::quantity")]
        block_timestamp: u64,
    },
    NotYetValid {
        not_before: U256,
        #[serde(with = "alloy_serde::quantity")]
        block_timestamp: u64,
    },
    ZeroNullifier {
        #[serde(with = "alloy_serde::quantity")]
        input_slot: u16,
    },
    DuplicateInputNullifier {
        #[serde(with = "alloy_serde::quantity")]
        first_input_slot: u16,
        #[serde(with = "alloy_serde::quantity")]
        duplicate_input_slot: u16,
        nullifier: B256,
    },
    NullifierAlreadySpent {
        #[serde(with = "alloy_serde::quantity")]
        input_slot: u16,
        nullifier: B256,
        spending_transaction_id: B256,
    },
    /// `requested_count` is the next output index plus the transaction's
    /// outputs and the block's payout reservations including its own.
    OutputCapacity {
        #[serde(with = "alloy_serde::quantity")]
        requested_count: u64,
        #[serde(with = "alloy_serde::quantity")]
        limit: u64,
    },
    AccountCapacity {
        #[serde(with = "alloy_serde::quantity")]
        requested_count: u64,
        #[serde(with = "alloy_serde::quantity")]
        limit: u64,
    },
    AccountNotFound {
        address: Address,
    },
    AccountAlreadyExists {
        address: Address,
        #[serde(with = "alloy_serde::quantity")]
        existing_revision: u32,
    },
    AccountRevisionExhausted {
        address: Address,
        #[serde(with = "alloy_serde::quantity")]
        revision: u32,
    },
    WrongAccountKind {
        address: Address,
        expected: AccountKindDetail,
        actual: AccountKindDetail,
    },
    ClearWithoutReceiveKey {
        address: Address,
    },
    ReplaceWithIdenticalReceiveKey {
        address: Address,
        receive_key_hash: B256,
    },
    AccountUpdateCommitmentMismatch {
        expected: B256,
        supplied: B256,
    },
    NonCanonicalAccountField {
        field: AccountField,
        supplied: B256,
    },
    ContractAddressExists {
        address: Address,
    },
    NonCanonicalContractField {
        field: ContractField,
        #[serde(with = "alloy_serde::quantity::opt")]
        function_index: Option<u16>,
        supplied: B256,
    },
    SelectorsNotStrictlyIncreasing {
        #[serde(with = "alloy_serde::quantity")]
        previous_function_index: u16,
        #[serde(with = "alloy_serde::quantity")]
        previous_selector: u8,
        #[serde(with = "alloy_serde::quantity")]
        function_index: u16,
        #[serde(with = "alloy_serde::quantity")]
        selector: u8,
    },
    /// `required` is the transaction's `carrierContextHash`, `carrier` that
    /// of the carrier that delivered it.
    CarrierContextMismatch {
        required: B256,
        carrier: B256,
    },
}

/// Engine detail before the derived index resolves the prior spending inclusion.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FailureDetailSeed {
    Complete(FailureDetail),
    NullifierAlreadySpent { input_slot: u16, nullifier: B256 },
}

/// The public fee and issuance destination of one successful transaction.
/// A zero `issuance_owner_commitment` selects the including batch's poster.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PayoutIntent {
    pub open_fee_amount: U256,
    pub issuance_owner_commitment: Fr,
    pub context: B256,
}

/// The receive-key change a successful user-account write made. A new key's
/// bytes are in the admitted transaction bytes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReceiveKeyOperation {
    Keep,
    Clear,
    Replace,
}

/// The account a successful creation or update wrote, including the exact
/// predecessor row for an update. A creation has no predecessor.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AccountResult {
    User {
        address: Address,
        revision: u32,
        receive_key: ReceiveKeyOperation,
        prior_state: Option<Box<AccountState>>,
    },
    /// A contract's receive key and functions are in the admitted
    /// transaction bytes.
    Contract {
        address: Address,
        nullifier_key_commitment: B256,
        function_set_commitment: B256,
    },
}

impl AccountResult {
    pub const fn address(&self) -> Address {
        match self {
            Self::User { address, .. } | Self::Contract { address, .. } => *address,
        }
    }

    /// Contracts are created at revision 1 and never updated.
    pub const fn revision(&self) -> u32 {
        match self {
            Self::User { revision, .. } => *revision,
            Self::Contract { .. } => 1,
        }
    }
}

/// The canonical effects of one successful transaction. Output data is in the
/// admitted transaction bytes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AcceptedEffects {
    pub kind: u8,
    /// First assigned output-tree index; `None` when the transaction appends
    /// no outputs.
    pub output_leaf_start: Option<u64>,
    /// One commitment per output slot; slot `i` is leaf `output_leaf_start + i`.
    pub output_commitments: Vec<B256>,
    /// One nullifier per consumed input slot, in slot order.
    pub nullifiers: Vec<B256>,
    pub account: Option<AccountResult>,
    pub payout: Option<PayoutIntent>,
}

/// What one failed transaction leaves behind.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RejectedEffects {
    /// The account the transaction bytes address, whatever check failed:
    /// `None` for a private-value transaction, a creation signature that does
    /// not recover, or a contract body that fails its static checks.
    pub account: Option<Address>,
    pub detail: Option<FailureDetailSeed>,
}

/// What one admitted transaction did, aligned with its `TransactionResult`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TransactionEffects {
    Accepted(AcceptedEffects),
    Rejected(RejectedEffects),
}

impl TransactionEffects {
    pub const fn accepted(&self) -> Option<&AcceptedEffects> {
        match self {
            Self::Accepted(effects) => Some(effects),
            Self::Rejected(_) => None,
        }
    }
}

/// One L1 log of a block's L1 origin, in leaf order.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct L1LogLeaf {
    pub transaction_index: u64,
    pub log_index: u64,
    pub leaf: B256,
}

codec_enum!(AccountField: u8 {
    NullifierKeyCommitment,
    RuleSetCommitment,
});

codec_enum!(ContractField: u8 {
    NullifierKeyMaterial,
    ApplicationVkHash,
    ConfigurationCommitment,
});

codec_enum!(AccountKindDetail: u8 { User, Contract });

// Each detail is tagged with the outcome it explains.
codec_variants!(FailureDetail: u16 {
    TransactionOutcome::PublicInputNotInField.as_u16() => PublicInputNotInField { public_input_index, supplied },
    TransactionOutcome::RecentPcashBlockNotInWindow.as_u16() => RecentPcashBlockNotInWindow { referenced_block_hash, window_start_timestamp, window_end_timestamp },
    TransactionOutcome::Expired.as_u16() => Expired { valid_until, block_timestamp },
    TransactionOutcome::NotYetValid.as_u16() => NotYetValid { not_before, block_timestamp },
    TransactionOutcome::ZeroNullifier.as_u16() => ZeroNullifier { input_slot },
    TransactionOutcome::DuplicateInputNullifier.as_u16() => DuplicateInputNullifier { first_input_slot, duplicate_input_slot, nullifier },
    TransactionOutcome::NullifierAlreadySpent.as_u16() => NullifierAlreadySpent { input_slot, nullifier, spending_transaction_id },
    TransactionOutcome::OutputCapacity.as_u16() => OutputCapacity { requested_count, limit },
    TransactionOutcome::AccountCapacity.as_u16() => AccountCapacity { requested_count, limit },
    TransactionOutcome::AccountNotFound.as_u16() => AccountNotFound { address },
    TransactionOutcome::AccountAlreadyExists.as_u16() => AccountAlreadyExists { address, existing_revision },
    TransactionOutcome::AccountRevisionExhausted.as_u16() => AccountRevisionExhausted { address, revision },
    TransactionOutcome::WrongAccountKind.as_u16() => WrongAccountKind { address, expected, actual },
    TransactionOutcome::ClearWithoutReceiveKey.as_u16() => ClearWithoutReceiveKey { address },
    TransactionOutcome::ReplaceWithIdenticalReceiveKey.as_u16() => ReplaceWithIdenticalReceiveKey { address, receive_key_hash },
    TransactionOutcome::AccountUpdateCommitmentMismatch.as_u16() => AccountUpdateCommitmentMismatch { expected, supplied },
    TransactionOutcome::NonCanonicalAccountField.as_u16() => NonCanonicalAccountField { field, supplied },
    TransactionOutcome::ContractAddressExists.as_u16() => ContractAddressExists { address },
    TransactionOutcome::NonCanonicalContractField.as_u16() => NonCanonicalContractField { field, function_index, supplied },
    TransactionOutcome::SelectorsNotStrictlyIncreasing.as_u16() => SelectorsNotStrictlyIncreasing { previous_function_index, previous_selector, function_index, selector },
    TransactionOutcome::CarrierContextMismatch.as_u16() => CarrierContextMismatch { required, carrier },
});

impl Codec for FailureDetailSeed {
    fn write(&self, w: &mut Writer) {
        match self {
            Self::Complete(detail) => {
                w.u8(0);
                detail.write(w);
            }
            Self::NullifierAlreadySpent {
                input_slot,
                nullifier,
            } => {
                w.u8(1);
                input_slot.write(w);
                nullifier.write(w);
            }
        }
    }

    fn read(r: &mut Reader<'_>) -> Result<Self, DecodeError> {
        match r.take_u8()? {
            0 => Ok(Self::Complete(Codec::read(r)?)),
            1 => Ok(Self::NullifierAlreadySpent {
                input_slot: Codec::read(r)?,
                nullifier: Codec::read(r)?,
            }),
            _ => Err(DecodeError::Invalid("FailureDetailSeed")),
        }
    }
}

codec_struct!(PayoutIntent {
    open_fee_amount,
    issuance_owner_commitment,
    context,
});

codec_enum!(ReceiveKeyOperation: u8 { Keep, Clear, Replace });

codec_variants!(AccountResult: u8 {
    0 => User { address, revision, receive_key, prior_state },
    1 => Contract { address, nullifier_key_commitment, function_set_commitment },
});

codec_struct!(AcceptedEffects {
    kind,
    output_leaf_start,
    output_commitments,
    nullifiers,
    account,
    payout,
});

codec_struct!(RejectedEffects { account, detail });

impl Codec for TransactionEffects {
    fn write(&self, w: &mut Writer) {
        match self {
            Self::Accepted(effects) => {
                w.u8(0);
                effects.write(w);
            }
            Self::Rejected(effects) => {
                w.u8(1);
                effects.write(w);
            }
        }
    }

    fn read(r: &mut Reader<'_>) -> Result<Self, DecodeError> {
        match r.take_u8()? {
            0 => Ok(Self::Accepted(Codec::read(r)?)),
            1 => Ok(Self::Rejected(Codec::read(r)?)),
            _ => Err(DecodeError::Invalid("TransactionEffects")),
        }
    }
}

codec_struct!(L1LogLeaf {
    transaction_index,
    log_index,
    leaf,
});
