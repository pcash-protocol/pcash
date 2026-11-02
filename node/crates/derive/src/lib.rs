//! pcash-derive — the PCASH L1 derivation engine.
//!
//! Derivation is a pure function of the L1 chain. For each L1 block it:
//!
//! 1. extracts every carrier's candidate batch — a top-level transaction whose
//!    `to` is the `INBOX_ADDRESS` routing tag, and each `PcashBatch` event —
//!    and frames each into ordered items ([`framing`]);
//! 2. admits each item as a typed [`AdmittedTransaction`] or excludes it,
//!    without reading state ([`admission`], [`transaction`]);
//! 3. executes each admitted transaction at its `(l1TransactionIndex,
//!    batchItemIndex)` position against the state produced by all prior
//!    successful transactions — running common checks and type-specific node
//!    rules (private value or account), hiding-kernel proof verification
//!    via [`pcash_verify`], and node-side `ecrecover` ([`eip712`]) —
//!    accumulating a success's nullifiers, output commitments, and account
//!    writes and recording a failure's outcome ([`engine`]);
//! 4. settles each successful transaction's open fee to its poster and
//!    issuance to its designated owner or poster, builds the block's
//!    [`pcash_state::BlockUpdate`] from the accumulated mutations and the
//!    settlement, then commits the `StateRoot`.
//!
//! Proof verification is injected through the [`pcash_verify::Verifier`] trait,
//! so the whole pipeline is unit-testable with a scripted stub and exercised for
//! real with [`pcash_verify::BbProcessVerifier`].

pub mod admission;
pub mod eip712;
pub mod engine;
pub mod framing;
pub mod params;
pub mod prewarm;
pub mod private_value_profiles;
pub mod public_records;
pub mod transaction;

pub use pcash_state::CircuitWord;

pub use admission::{admit, AdmissionError, AdmittedTransaction, ContractBodyCheck};
pub use engine::{
    derive_block, derive_prepared_block, earns_issuance, user_account_update_commitment,
    validate_transactions, BlockOutcome, CarrierContext, DeriveError, ProofStatement,
};
pub use framing::Batch;
pub use params::{
    BatchVersion, ForkActivation, ProtocolRules, SectionLayout, ACCOUNT_KIND_CONTRACT,
    ACCOUNT_KIND_USER, ACCOUNT_MAX_TX_BYTES, BASE_BATCH_VERSIONS, BASE_TRANSACTION_TYPES,
    BATCH_VERSION_V1, CONTRACT_FUNCTION_BYTES, CONTRACT_MAX_BODY_BYTES, CONTRACT_MAX_TX_BYTES,
    KIND_CONTRACT_ACCOUNT_CREATION, KIND_PRIVATE_VALUE, KIND_USER_ACCOUNT_CREATION,
    KIND_USER_ACCOUNT_UPDATE, MAX_BATCH_ENTRIES, MAX_TX_BYTES, MAX_VALID_TX_BYTES,
    ML_KEM768_PUBLIC_KEY_LEN, OUTPUT_DATA_BYTES, PRIVATE_VALUE_MAX_TX_BYTES,
    PRIVATE_VALUE_OUTPUT_DATA_ITEMS, PRIVATE_VALUE_PUBLIC_INPUTS, PRIVATE_VALUE_WIRE_INPUTS,
    USER_ACCOUNT_UPDATE_MAX_TX_BYTES, USER_ACCOUNT_UPDATE_PUBLIC_INPUTS, WIRE_PROOF_BYTES,
};
pub use pcash_state::{
    BatchExclusionReason, CarrierType, ItemExclusionReason, L1DeliveryBatch, L1DeliveryItem,
};
pub use prewarm::{prepare_block, PreparedBlock};
pub use transaction::{
    AccountCreationAttachment, AccountCreationAuthorization, ContractAccountCreation, ContractBody,
    ContractFunction, EncodeError, ParseError, PrivateValueSection, ReceiveKey, ReceiveKeyUpdate,
    Transaction, UserAccountCreation, UserAccountUpdate, ENVELOPE_BYTES, RECEIVE_KEY_ABSENT,
    RECEIVE_KEY_PRESENT, RECEIVE_KEY_UPDATE_CLEAR, RECEIVE_KEY_UPDATE_KEEP,
    RECEIVE_KEY_UPDATE_REPLACE,
};
