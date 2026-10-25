//! Protocol rules and shared constants.

#![allow(
    clippy::expect_used,
    clippy::panic,
    reason = "compiled consensus schedule tables are validated at construction"
)]

use crate::private_value_profiles::{PrivateValueShape, L, S};
use alloy_primitives::{keccak256, B256};

/// Inbox batch encoding version. It selects framing, not transaction semantics;
/// each item carries its own transaction type.
pub const BATCH_VERSION_V1: u8 = 0x01;

/// Batch encoding selected by the calldata's explicit first byte.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BatchVersion {
    V1,
}

/// Batch encodings accepted from genesis, before any fork changes the set.
pub const BASE_BATCH_VERSIONS: [BatchVersion; 1] = [BatchVersion::V1];

impl BatchVersion {
    pub const fn wire_byte(self) -> u8 {
        match self {
            Self::V1 => BATCH_VERSION_V1,
        }
    }

    pub const fn from_wire_byte(value: u8) -> Option<Self> {
        match value {
            BATCH_VERSION_V1 => Some(Self::V1),
            _ => None,
        }
    }
}

pub const MAX_BATCH_ENTRIES: usize = 1024;
/// The exact size of one output-data item. Items carry no length, so this
/// decides where each item ends.
pub const OUTPUT_DATA_BYTES: usize = 1_213;

/// Byte length of an ML-KEM-768 public key carried by account transactions.
pub const ML_KEM768_PUBLIC_KEY_LEN: usize = pcash_state::ML_KEM768_PUBLIC_KEY_LEN;

/// Transaction type tags — the leading byte of `txBytes`.
///
/// A type tag permanently fixes the payload encoding and verification relation.
/// Once assigned it is never reinterpreted or reused. Historical transactions always
/// remain decodable under their original type, while a fork may change which
/// types are accepted for new blocks. Ordinary state and recent-block validity
/// rules still apply. A wallet picks a transaction type; it never picks a fork
/// or a batch version.
pub const KIND_PRIVATE_VALUE: u8 = 0;
pub const KIND_USER_ACCOUNT_CREATION: u8 = 1;
pub const KIND_CONTRACT_ACCOUNT_CREATION: u8 = 2;
pub const KIND_USER_ACCOUNT_UPDATE: u8 = 3;

/// Transaction types accepted from genesis, before any fork changes the set.
pub const BASE_TRANSACTION_TYPES: [u8; 4] = [
    KIND_PRIVATE_VALUE,
    KIND_USER_ACCOUNT_CREATION,
    KIND_CONTRACT_ACCOUNT_CREATION,
    KIND_USER_ACCOUNT_UPDATE,
];

fn is_strictly_ascending(values: impl IntoIterator<Item = u8>) -> bool {
    let mut previous = None;
    for value in values {
        if previous.is_some_and(|previous| value <= previous) {
            return false;
        }
        previous = Some(value);
    }
    true
}

fn validate_base_schedule_invariants() {
    assert!(
        is_strictly_ascending(BASE_TRANSACTION_TYPES),
        "base transaction types must be strictly ascending and unique"
    );
    assert!(
        is_strictly_ascending(
            BASE_BATCH_VERSIONS
                .iter()
                .map(|version| version.wire_byte())
        ),
        "base batch versions must be strictly ascending and unique"
    );
}

/// Account kinds committed into the account state commitment.
pub const ACCOUNT_KIND_USER: u8 = 0;
pub const ACCOUNT_KIND_CONTRACT: u8 = 1;

/// Number of 32-byte public inputs consumed by each proof verifier. A
/// user-account update and a sponsored contract-account creation verify the
/// profile-S private-value statement plus one word: the account update
/// commitment, or the derived contract address.
pub const PRIVATE_VALUE_PUBLIC_INPUTS: usize = S.public_inputs;
pub const USER_ACCOUNT_UPDATE_PUBLIC_INPUTS: usize = PRIVATE_VALUE_PUBLIC_INPUTS + 1;
pub const CONTRACT_CREATION_PUBLIC_INPUTS: usize = PRIVATE_VALUE_PUBLIC_INPUTS + 1;

/// Number of verifier-input words a profile-S private-value section serializes;
/// a fee section omits the issuance owner and serializes one fewer. The
/// delivery commitment remains a verifier input but is computed from the
/// posted output data and arena rather than duplicated on the wire.
pub const PRIVATE_VALUE_WIRE_INPUTS: usize = S.wire_inputs;

/// Output-data items in the S private-value profile.
pub const PRIVATE_VALUE_OUTPUT_DATA_ITEMS: usize = S.outputs;

/// Compressed CHONK body, excluding the reconstructed public-input prefix.
pub const WIRE_PROOF_BYTES: usize = 22_432;

/// The framing of one private-value section, fixed by the enclosing
/// transaction type and, for type `0x00`, its profile. Account actions carry
/// profile-S sections that omit the always-zero issuance word.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SectionLayout {
    PrivateValue(PrivateValueShape),
    UserAccountUpdate,
    ContractAccountCreation,
}

impl SectionLayout {
    pub const fn shape(self) -> PrivateValueShape {
        match self {
            Self::PrivateValue(shape) => shape,
            Self::UserAccountUpdate | Self::ContractAccountCreation => PrivateValueShape::S,
        }
    }

    pub const fn proof_bytes(self) -> usize {
        WIRE_PROOF_BYTES
    }

    pub const fn omits_issuance_owner(self) -> bool {
        !matches!(self, Self::PrivateValue(_))
    }

    pub const fn wire_inputs(self) -> usize {
        self.shape().profile().wire_inputs - self.omits_issuance_owner() as usize
    }

    /// Serialized section bytes:
    /// `wireInputs × 32 ‖ proof ‖ outputs × outputData ‖ arena`.
    pub const fn section_bytes(self) -> usize {
        let profile = self.shape().profile();
        self.wire_inputs() * 32
            + self.proof_bytes()
            + profile.outputs * OUTPUT_DATA_BYTES
            + profile.arena_bytes
    }
}

/// `txBytes` of a type-`0x00` transaction: the envelope, the profile byte, and the
/// section.
pub const fn private_value_tx_bytes(shape: PrivateValueShape) -> usize {
    6 + SectionLayout::PrivateValue(shape).section_bytes()
}
pub const PRIVATE_VALUE_MAX_TX_BYTES: usize = {
    let small = private_value_tx_bytes(PrivateValueShape::S);
    let large = private_value_tx_bytes(PrivateValueShape::L);
    if small > large {
        small
    } else {
        large
    }
};

/// Worst-case `txBytes` for a user-account creation:
/// `type(1) + chainId(4) + authorizationMode(1) + nullifierKeyCommitment(32) + ruleSetCommitment(32)
/// + receiveKeyMode(1) + receiveKey(1184) + recentBlockHash(32) + deadline(8)
/// + sig_r(32) + sig_s(32) + yParity(1)`.
pub const ACCOUNT_MAX_TX_BYTES: usize =
    1 + 4 + 1 + 32 + 32 + 1 + ML_KEM768_PUBLIC_KEY_LEN + 32 + 8 + 32 + 32 + 1;

/// Worst-case `txBytes` for a type-`0x03` user-account update:
/// `type(1) + chainId(4) + address(20) + newRuleSetCommitment(32) + receiveKeyOperation(1)
/// + replacementKey(1184) + accountUpdateCommitment(32) + privateValueSection`.
pub const USER_ACCOUNT_UPDATE_MAX_TX_BYTES: usize = 1
    + 4
    + 20
    + 32
    + 1
    + ML_KEM768_PUBLIC_KEY_LEN
    + 32
    + SectionLayout::UserAccountUpdate.section_bytes();

/// Bytes in one encoded contract function: selector and two field elements.
/// The account-rule entry blinder is the canonical `0` and is not serialized.
pub const CONTRACT_FUNCTION_BYTES: usize = 1 + 32 * 2;
/// Worst-case unsigned contract-account body: the nullifier-key tag and its one
/// 32-byte material field, a present receive key, and all 255 function
/// selectors populated. `functionSetCommitment` is derived, never serialized.
pub const CONTRACT_MAX_BODY_BYTES: usize =
    1 + 32 + 1 + ML_KEM768_PUBLIC_KEY_LEN + 1 + 255 * CONTRACT_FUNCTION_BYTES;
/// Worst-case `txBytes` for a contract-account creation, which is sponsored:
/// the envelope, the funding mode, the sponsor's private-value section, and
/// the body.
pub const CONTRACT_MAX_TX_BYTES: usize =
    1 + 4 + 1 + SectionLayout::ContractAccountCreation.section_bytes() + CONTRACT_MAX_BODY_BYTES;

/// Largest valid transaction shape understood by this binary, used by RPC and
/// P2P transport guards. This is narrower than the consensus parsing-sanity
/// bound: it is the widest shape the compiled transaction types can actually
/// produce.
pub const MAX_VALID_TX_BYTES: usize = if PRIVATE_VALUE_MAX_TX_BYTES > CONTRACT_MAX_TX_BYTES
    && PRIVATE_VALUE_MAX_TX_BYTES > USER_ACCOUNT_UPDATE_MAX_TX_BYTES
{
    PRIVATE_VALUE_MAX_TX_BYTES
} else if CONTRACT_MAX_TX_BYTES > USER_ACCOUNT_UPDATE_MAX_TX_BYTES {
    CONTRACT_MAX_TX_BYTES
} else {
    USER_ACCOUNT_UPDATE_MAX_TX_BYTES
};

/// `MAX_TX_BYTES`: a fixed parsing-sanity bound, deliberately NOT derived
/// from the transaction formats. Exact per-kind parsing enforces
/// every real transaction's size. A fixed bound stays independent of proof
/// formats and output-data sizes. Admission excludes an intact over-limit item
/// individually; the framing parser preserves its item boundary. The
/// per-kind maxima above are sizing guidance for buffers and mempools.
pub const MAX_TX_BYTES: usize = 131_072;

/// One compiled fork activation: the L1 header timestamp at which a new rule set
/// takes effect, the complete set of transaction types it accepts from then on,
/// and the hiding-kernel VKs it introduces. Keeping the types and their keys
/// in one value prevents accepting a type without the verification key that
/// validates it.
///
/// Activation is by L1 header timestamp, not block height: heights are not
/// predictable in wall-clock terms. L1 header timestamps are strictly
/// increasing under Ethereum consensus, so the partition is deterministic and
/// survives reorgs on the same rules a height would.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ForkActivation {
    /// Human label for release notes and status output. It enters no
    /// commitment and nothing in consensus is keyed by it.
    pub name: &'static str,
    pub activation_timestamp: u64,
    /// Every transaction type accepted once this fork is active, ascending.
    /// Written out in full rather than derived as a delta, so a fork that
    /// retires a type states that plainly instead of implying it.
    pub accepted_transaction_types: Vec<u8>,
    /// Complete accepted batch-encoding set once this fork is active, ascending.
    pub accepted_batch_versions: Vec<BatchVersion>,
    /// Hiding-kernel VKs this fork introduces, keyed by transaction type. A type
    /// it accepts but does not list keeps the key it already verified under.
    pub hiding_kernel_vks: Vec<(u8, Vec<u8>)>,
}

type TransactionTypeVkMapping = (u8, Option<B256>);

struct ActivatedForkPrefix {
    activation_timestamp: u64,
    accepted_transaction_types: Vec<TransactionTypeVkMapping>,
    accepted_batch_versions: Vec<BatchVersion>,
}

fn append_batch_versions(encoded: &mut Vec<u8>, versions: &[BatchVersion]) {
    encoded.extend_from_slice(
        &u16::try_from(versions.len())
            .expect("batch-version mapping exceeds u16")
            .to_be_bytes(),
    );
    for version in versions {
        encoded.push(version.wire_byte());
    }
}

fn append_transaction_type_vk_mapping(encoded: &mut Vec<u8>, mapping: &[TransactionTypeVkMapping]) {
    encoded.extend_from_slice(
        &u16::try_from(mapping.len())
            .expect("transaction-type mapping exceeds u16")
            .to_be_bytes(),
    );
    for (kind, vk_hash) in mapping {
        encoded.push(*kind);
        match vk_hash {
            Some(hash) => {
                encoded.push(1);
                encoded.extend_from_slice(hash.as_slice());
            }
            None => encoded.push(0),
        }
    }
}

/// The base sets and the already-activated prefix only. A fork scheduled for a
/// later timestamp contributes nothing, so a release may add one — including one
/// that introduces a batch encoding — without invalidating an older checkpoint.
fn fork_schedule_prefix_hash(
    base_batch_versions: &[BatchVersion],
    base_transaction_types: &[TransactionTypeVkMapping],
    activated_forks: &[ActivatedForkPrefix],
) -> B256 {
    let mut encoded = Vec::new();
    encoded.extend_from_slice(keccak256("pcash.fork-schedule-prefix").as_slice());
    append_batch_versions(&mut encoded, base_batch_versions);
    append_transaction_type_vk_mapping(&mut encoded, base_transaction_types);
    encoded.extend_from_slice(
        &u16::try_from(activated_forks.len())
            .expect("activated fork prefix exceeds u16")
            .to_be_bytes(),
    );
    for fork in activated_forks {
        encoded.extend_from_slice(&fork.activation_timestamp.to_be_bytes());
        append_transaction_type_vk_mapping(&mut encoded, &fork.accepted_transaction_types);
        append_batch_versions(&mut encoded, &fork.accepted_batch_versions);
    }
    keccak256(encoded)
}

/// The protocol rules a node compiles: the launch hiding-kernel VKs and the fork
/// schedule. Network identity is not part of the rules; derivation reads it
/// from the state it derives into.
#[derive(Clone, Debug)]
pub struct ProtocolRules {
    /// Compiled private-value hiding-kernel VKs; passed to the verifier for
    /// type `0x00`.
    pub private_value_hiding_kernel_vks: [Vec<u8>; 2],
    /// Compiled user-account-update hiding-kernel VK for type `0x03`.
    pub user_account_update_hiding_kernel_vk: Vec<u8>,
    /// Compiled contract-creation hiding-kernel VK for a sponsored type `0x02`.
    pub contract_creation_hiding_kernel_vk: Vec<u8>,
    /// Forks this binary compiles, ascending by activation timestamp. Empty
    /// keeps the node on the launch transaction-type set alone.
    pub fork_schedule: Vec<ForkActivation>,
}

impl ProtocolRules {
    /// The launch rules with these pinned hiding-kernel VKs and no scheduled fork.
    pub fn new(
        private_value_hiding_kernel_vks: [Vec<u8>; 2],
        user_account_update_hiding_kernel_vk: Vec<u8>,
        contract_creation_hiding_kernel_vk: Vec<u8>,
    ) -> Self {
        validate_base_schedule_invariants();
        Self {
            private_value_hiding_kernel_vks,
            user_account_update_hiding_kernel_vk,
            contract_creation_hiding_kernel_vk,
            fork_schedule: Vec::new(),
        }
    }

    /// Append one fork to the compiled schedule. Activation timestamps must be
    /// strictly ascending: the schedule is a short compiled list walked in
    /// order, not a data-driven rule engine, and everything below reads it as a
    /// prefix.
    pub fn with_fork(mut self, fork: ForkActivation) -> Self {
        assert!(
            is_strictly_ascending(fork.accepted_transaction_types.iter().copied()),
            "fork {} accepted transaction types must be strictly ascending and unique",
            fork.name
        );
        assert!(
            is_strictly_ascending(
                fork.accepted_batch_versions
                    .iter()
                    .map(|version| version.wire_byte())
            ),
            "fork {} accepted batch versions must be strictly ascending and unique",
            fork.name
        );
        assert!(
            is_strictly_ascending(fork.hiding_kernel_vks.iter().map(|(kind, _)| *kind)),
            "fork {} hiding-kernel VK mappings must be strictly ascending and unique by \
             transaction type",
            fork.name
        );
        if let Some(last) = self.fork_schedule.last() {
            assert!(
                fork.activation_timestamp > last.activation_timestamp,
                "fork schedule must be strictly ascending by activation timestamp"
            );
        }
        // A transaction type permanently fixes its verifier, so no fork may
        // rebind one an earlier fork already introduced. This is a construction
        // error rather than something to resolve per timestamp: a relation that
        // needs a different verifier is a different relation and takes its own
        // type. Enforcing it here is also what keeps `fork_hiding_kernel_vk`
        // sound — at most one fork ever maps a given kind, so the lookup cannot
        // depend on which forks have activated.
        for kind in fork.hiding_kernel_vks.iter().map(|(kind, _)| *kind) {
            assert!(
                !BASE_TRANSACTION_TYPES.contains(&kind)
                    && !self
                        .fork_schedule
                        .iter()
                        .any(|earlier| earlier.hiding_kernel_vks.iter().any(|(k, _)| *k == kind)),
                "fork {} rebinds the verifier for transaction type {kind:#04x}, which an earlier \
                 rule set already fixed; a new relation needs a new transaction type",
                fork.name
            );
            assert!(
                fork.accepted_transaction_types.contains(&kind),
                "fork {} introduces a verifier for transaction type {kind:#04x} without accepting that type",
                fork.name
            );
        }
        for kind in fork.accepted_transaction_types.iter().copied() {
            let known = BASE_TRANSACTION_TYPES.contains(&kind)
                || fork
                    .hiding_kernel_vks
                    .iter()
                    .any(|(mapped, _)| *mapped == kind)
                || self.fork_schedule.iter().any(|earlier| {
                    earlier
                        .hiding_kernel_vks
                        .iter()
                        .any(|(mapped, _)| *mapped == kind)
                });
            assert!(
                known,
                "fork {} accepts transaction type {kind:#04x} without a permanent VK mapping",
                fork.name
            );
        }
        self.fork_schedule.push(fork);
        self
    }

    /// The forks already active at L1 header timestamp `ts`, in schedule order.
    fn activated_forks_at(&self, ts: u64) -> impl Iterator<Item = &ForkActivation> {
        self.fork_schedule
            .iter()
            .take_while(move |fork| ts >= fork.activation_timestamp)
    }

    /// Every batch encoding accepted for a block with L1 header timestamp `ts`.
    ///
    /// Batch versions stay independent of which transaction types are accepted
    /// — a version never selects transaction semantics — but they are not
    /// independent of time. Framing decides which items exist in a block at
    /// all, so a version that is unreadable at `ts` must stay unreadable when
    /// that block is replayed later.
    pub fn accepted_batch_versions_at(&self, ts: u64) -> Vec<BatchVersion> {
        self.activated_forks_at(ts).last().map_or_else(
            || BASE_BATCH_VERSIONS.to_vec(),
            |fork| fork.accepted_batch_versions.clone(),
        )
    }

    /// Every transaction type accepted for a block with L1 header timestamp
    /// `ts`, ascending: the set declared by the last fork that has activated,
    /// or the launch set when none has. Each fork states its whole set, so a
    /// fork may retire a type as well as introduce one.
    pub fn accepted_transaction_types_at(&self, ts: u64) -> Vec<u8> {
        match self.activated_forks_at(ts).last() {
            Some(fork) => fork.accepted_transaction_types.clone(),
            None => BASE_TRANSACTION_TYPES.to_vec(),
        }
    }

    /// The hiding-kernel VK a fork introduced for transaction type `kind`,
    /// latest fork first. Fork activation is not consulted: the VK is a
    /// permanent property of the transaction type, and every caller has already
    /// decided whether the type is accepted.
    fn fork_hiding_kernel_vk(&self, kind: u8) -> Option<&[u8]> {
        self.fork_schedule.iter().rev().find_map(|fork| {
            fork.hiding_kernel_vks
                .iter()
                .find(|(fork_kind, _)| *fork_kind == kind)
                .map(|(_, vk)| vk.as_slice())
        })
    }

    fn transaction_type_vk_mapping(
        &self,
        transaction_types: &[u8],
    ) -> Vec<TransactionTypeVkMapping> {
        transaction_types
            .iter()
            .map(|kind| {
                let vk_hash = match *kind {
                    KIND_PRIVATE_VALUE => {
                        let mut shapes = Vec::with_capacity(66);
                        for profile in [S, L] {
                            shapes.push(profile.shape_id);
                            shapes.extend_from_slice(
                                keccak256(
                                    &self.private_value_hiding_kernel_vks
                                        [usize::from(profile.shape_id)],
                                )
                                .as_slice(),
                            );
                        }
                        Some(keccak256(shapes))
                    }
                    KIND_USER_ACCOUNT_UPDATE => {
                        Some(keccak256(&self.user_account_update_hiding_kernel_vk))
                    }
                    KIND_CONTRACT_ACCOUNT_CREATION => {
                        Some(keccak256(&self.contract_creation_hiding_kernel_vk))
                    }
                    KIND_USER_ACCOUNT_CREATION => None,
                    other => Some(keccak256(self.fork_hiding_kernel_vk(other).unwrap_or_else(
                        || panic!("accepted transaction type {other} has no VK mapping"),
                    ))),
                };
                (*kind, vk_hash)
            })
            .collect()
    }

    /// Count-zero compatibility prefix used when a new store adopts only the
    /// launch rules. This deliberately excludes every fork, including one whose
    /// activation timestamp is zero.
    pub fn base_fork_schedule_prefix_hash(&self) -> B256 {
        let base_transaction_types = self.transaction_type_vk_mapping(&BASE_TRANSACTION_TYPES);
        fork_schedule_prefix_hash(&BASE_BATCH_VERSIONS, &base_transaction_types, &[])
    }

    /// Internal restart-compatibility guard for the fork schedule that has
    /// already activated at `ts`. Future forks are deliberately excluded so a
    /// release may add them without invalidating an older checkpoint. This is
    /// not a public fork ID, chain identity, block-header field, or transaction
    /// domain.
    pub fn activated_fork_schedule_prefix_hash_at(&self, ts: u64) -> B256 {
        let base_transaction_types = self.transaction_type_vk_mapping(&BASE_TRANSACTION_TYPES);
        let activated_forks: Vec<ActivatedForkPrefix> = self
            .activated_forks_at(ts)
            .map(|fork| ActivatedForkPrefix {
                activation_timestamp: fork.activation_timestamp,
                accepted_transaction_types: self
                    .transaction_type_vk_mapping(&fork.accepted_transaction_types),
                accepted_batch_versions: fork.accepted_batch_versions.clone(),
            })
            .collect();

        fork_schedule_prefix_hash(
            &BASE_BATCH_VERSIONS,
            &base_transaction_types,
            &activated_forks,
        )
    }

    /// Whether transaction type `kind` is accepted at L1 header timestamp `ts`.
    /// Historical replay selects the accepted set from the timestamp of the
    /// block being derived.
    pub fn transaction_type_allowed_at(&self, kind: u8, ts: u64) -> bool {
        self.accepted_transaction_types_at(ts).contains(&kind)
    }

    /// The type-`0x00` hiding-kernel VK for one private-value shape. The VK is
    /// a permanent property of the transaction type and shape, never of the
    /// enclosing batch or the active fork.
    pub fn private_value_hiding_kernel_vk(&self, shape: PrivateValueShape) -> &[u8] {
        &self.private_value_hiding_kernel_vks[shape as usize]
    }
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "tests use direct assertions for fixture setup"
)]
mod tests {
    use super::*;

    /// A transaction type introduced by the fork under test. Written as a
    /// literal so this test says what it exercises without depending on any
    /// particular proposal's tag.
    const FORK_KIND: u8 = 0x40;

    fn base_rules() -> ProtocolRules {
        ProtocolRules::new([vec![0xaa], vec![]], vec![0xcc], vec![0xdd])
    }

    #[test]
    fn base_schedule_sets_are_canonical() {
        validate_base_schedule_invariants();
    }

    #[test]
    fn launch_prefix_commits_to_every_launch_hiding_kernel_vk() {
        let launch = base_rules().base_fork_schedule_prefix_hash();
        for rules in [
            ProtocolRules::new([vec![0xab], vec![]], vec![0xcc], vec![0xdd]),
            ProtocolRules::new([vec![0xaa], vec![0x01]], vec![0xcc], vec![0xdd]),
            ProtocolRules::new([vec![0xaa], vec![]], vec![0xcd], vec![0xdd]),
            ProtocolRules::new([vec![0xaa], vec![]], vec![0xcc], vec![0xde]),
        ] {
            assert_ne!(rules.base_fork_schedule_prefix_hash(), launch);
        }
    }

    #[test]
    fn base_prefix_excludes_even_a_timestamp_zero_fork() {
        let launch = base_rules();
        let mut types = BASE_TRANSACTION_TYPES.to_vec();
        types.push(FORK_KIND);
        let forked = base_rules().with_fork(fork_at(0, types));
        assert_eq!(
            launch.base_fork_schedule_prefix_hash(),
            forked.base_fork_schedule_prefix_hash()
        );
        assert_ne!(
            forked.base_fork_schedule_prefix_hash(),
            forked.activated_fork_schedule_prefix_hash_at(0)
        );
    }

    #[test]
    #[should_panic(expected = "accepted transaction types must be strictly ascending and unique")]
    fn fork_rejects_noncanonical_transaction_types() {
        let _ = base_rules().with_fork(fork_at(100, vec![KIND_PRIVATE_VALUE, KIND_PRIVATE_VALUE]));
    }

    #[test]
    #[should_panic(expected = "accepted batch versions must be strictly ascending and unique")]
    fn fork_rejects_duplicate_batch_versions() {
        let mut fork = fork_at(100, BASE_TRANSACTION_TYPES.to_vec());
        fork.accepted_batch_versions = vec![BatchVersion::V1, BatchVersion::V1];
        let _ = base_rules().with_fork(fork);
    }

    #[test]
    #[should_panic(expected = "hiding-kernel VK mappings must be strictly ascending and unique")]
    fn fork_rejects_duplicate_hiding_kernel_vk_mappings() {
        let mut fork = fork_at(
            100,
            vec![
                KIND_PRIVATE_VALUE,
                KIND_USER_ACCOUNT_CREATION,
                KIND_CONTRACT_ACCOUNT_CREATION,
                KIND_USER_ACCOUNT_UPDATE,
                FORK_KIND,
            ],
        );
        fork.hiding_kernel_vks.push((FORK_KIND, vec![0xdd]));
        let _ = base_rules().with_fork(fork);
    }

    #[test]
    #[should_panic(expected = "rebinds the verifier for transaction type")]
    fn fork_rejects_base_type_vk_rebinding() {
        let mut fork = fork_at(100, BASE_TRANSACTION_TYPES.to_vec());
        fork.hiding_kernel_vks = vec![(KIND_PRIVATE_VALUE, vec![0xcc])];
        let _ = base_rules().with_fork(fork);
    }

    #[test]
    #[should_panic(expected = "without a permanent VK mapping")]
    fn fork_rejects_unknown_accepted_type_without_vk() {
        let mut fork = fork_at(
            100,
            vec![
                KIND_PRIVATE_VALUE,
                KIND_USER_ACCOUNT_CREATION,
                KIND_CONTRACT_ACCOUNT_CREATION,
                KIND_USER_ACCOUNT_UPDATE,
                FORK_KIND,
            ],
        );
        fork.hiding_kernel_vks.clear();
        let _ = base_rules().with_fork(fork);
    }

    /// A fork that changes only the accepted-type set, introducing no verifier.
    fn no_new_verifier(
        activation_timestamp: u64,
        accepted_transaction_types: Vec<u8>,
    ) -> ForkActivation {
        let mut fork = fork_at(activation_timestamp, accepted_transaction_types);
        fork.hiding_kernel_vks = Vec::new();
        fork
    }

    fn fork_at(activation_timestamp: u64, accepted_transaction_types: Vec<u8>) -> ForkActivation {
        let hiding_kernel_vks = if accepted_transaction_types.contains(&FORK_KIND) {
            vec![(FORK_KIND, vec![0xcc])]
        } else {
            Vec::new()
        };
        ForkActivation {
            name: "test fork",
            activation_timestamp,
            accepted_transaction_types,
            accepted_batch_versions: BASE_BATCH_VERSIONS.to_vec(),
            hiding_kernel_vks,
        }
    }

    #[test]
    fn fork_schedule_prefix_distinguishes_addition_from_replacement() {
        let activation_timestamp = 100;
        let rules =
            ProtocolRules::new([vec![0xaa], vec![]], vec![0xcc], vec![0xdd]).with_fork(fork_at(
                activation_timestamp,
                vec![
                    KIND_USER_ACCOUNT_CREATION,
                    KIND_CONTRACT_ACCOUNT_CREATION,
                    KIND_USER_ACCOUNT_UPDATE,
                    FORK_KIND,
                ],
            ));
        let base = rules.transaction_type_vk_mapping(&BASE_TRANSACTION_TYPES);
        let replacement = rules.transaction_type_vk_mapping(&[
            KIND_USER_ACCOUNT_CREATION,
            KIND_CONTRACT_ACCOUNT_CREATION,
            KIND_USER_ACCOUNT_UPDATE,
            FORK_KIND,
        ]);
        let additive = rules.transaction_type_vk_mapping(&[
            KIND_PRIVATE_VALUE,
            KIND_USER_ACCOUNT_CREATION,
            KIND_CONTRACT_ACCOUNT_CREATION,
            KIND_USER_ACCOUNT_UPDATE,
            FORK_KIND,
        ]);
        let replacement_hash = fork_schedule_prefix_hash(
            &[BatchVersion::V1],
            &base,
            &[ActivatedForkPrefix {
                activation_timestamp,
                accepted_transaction_types: replacement,
                accepted_batch_versions: BASE_BATCH_VERSIONS.to_vec(),
            }],
        );
        let additive_hash = fork_schedule_prefix_hash(
            &[BatchVersion::V1],
            &base,
            &[ActivatedForkPrefix {
                activation_timestamp,
                accepted_transaction_types: additive,
                accepted_batch_versions: BASE_BATCH_VERSIONS.to_vec(),
            }],
        );

        assert_eq!(
            replacement_hash,
            rules.activated_fork_schedule_prefix_hash_at(activation_timestamp)
        );
        assert_ne!(replacement_hash, additive_hash);
    }

    /// The prefix covers exactly the forks that have activated, in order, so a
    /// second fork scheduled later cannot invalidate a checkpoint written under
    /// the first.
    #[test]
    fn prefix_extends_with_each_activation_and_ignores_future_forks() {
        let first_types = vec![
            KIND_PRIVATE_VALUE,
            KIND_USER_ACCOUNT_CREATION,
            KIND_CONTRACT_ACCOUNT_CREATION,
            KIND_USER_ACCOUNT_UPDATE,
            FORK_KIND,
        ];
        let one = ProtocolRules::new([vec![0xaa], vec![]], vec![0xcc], vec![0xdd])
            .with_fork(fork_at(100, first_types.clone()));
        let two = ProtocolRules::new([vec![0xaa], vec![]], vec![0xcc], vec![0xdd])
            .with_fork(fork_at(100, first_types))
            // Only the first fork introduces FORK_KIND; a second one that
            // rebound its verifier would be an invalid schedule.
            .with_fork(no_new_verifier(
                200,
                vec![
                    KIND_USER_ACCOUNT_CREATION,
                    KIND_CONTRACT_ACCOUNT_CREATION,
                    KIND_USER_ACCOUNT_UPDATE,
                    FORK_KIND,
                ],
            ));

        for ts in [99, 100, 199] {
            assert_eq!(
                one.activated_fork_schedule_prefix_hash_at(ts),
                two.activated_fork_schedule_prefix_hash_at(ts),
                "an unactivated future fork must not change the prefix at {ts}"
            );
        }
        assert_ne!(
            one.activated_fork_schedule_prefix_hash_at(200),
            two.activated_fork_schedule_prefix_hash_at(200)
        );

        assert_eq!(
            two.accepted_transaction_types_at(99),
            BASE_TRANSACTION_TYPES
        );
        assert_eq!(two.accepted_transaction_types_at(100).len(), 5);
        assert_eq!(
            two.accepted_transaction_types_at(200),
            vec![
                KIND_USER_ACCOUNT_CREATION,
                KIND_CONTRACT_ACCOUNT_CREATION,
                KIND_USER_ACCOUNT_UPDATE,
                FORK_KIND
            ]
        );
    }

    #[test]
    #[should_panic(expected = "strictly ascending")]
    fn fork_schedule_rejects_a_non_ascending_activation() {
        ProtocolRules::new([vec![0xaa], vec![]], vec![0xcc], vec![0xdd])
            .with_fork(fork_at(200, BASE_TRANSACTION_TYPES.to_vec()))
            .with_fork(fork_at(100, BASE_TRANSACTION_TYPES.to_vec()));
    }
    /// Two forks may each introduce their own transaction type, and the
    /// verifier lookup stays keyed to the type rather than to which fork is
    /// active. A later fork must not be able to rebind an earlier one: the
    /// lookup is timestamp-independent, so a rebind would retroactively change
    /// the verifier for blocks before the later fork activated, and would move
    /// the checkpoint prefix at historical timestamps too.
    #[test]
    fn two_forks_may_each_introduce_a_type_with_its_own_verifier() {
        let mut first_types = BASE_TRANSACTION_TYPES.to_vec();
        first_types.push(0x40);
        let mut first = fork_at(100, first_types);
        first.hiding_kernel_vks = vec![(0x40, vec![0xaa])];
        let mut second_types = BASE_TRANSACTION_TYPES.to_vec();
        second_types.extend([0x40, 0x41]);
        let mut second = fork_at(200, second_types);
        second.hiding_kernel_vks = vec![(0x41, vec![0xbb])];

        let rules = ProtocolRules::new([vec![0x01], vec![]], vec![0x03], vec![0x02])
            .with_fork(first)
            .with_fork(second);

        assert_eq!(rules.fork_hiding_kernel_vk(0x40), Some([0xaa].as_slice()));
        assert_eq!(rules.fork_hiding_kernel_vk(0x41), Some([0xbb].as_slice()));
    }

    #[test]
    #[should_panic(expected = "rebinds the verifier for transaction type")]
    fn a_later_fork_cannot_rebind_an_earlier_forks_verifier() {
        let mut accepted = BASE_TRANSACTION_TYPES.to_vec();
        accepted.push(0x40);
        let mut first = fork_at(100, accepted.clone());
        first.hiding_kernel_vks = vec![(0x40, vec![0xaa])];
        let mut second = fork_at(200, accepted);
        second.hiding_kernel_vks = vec![(0x40, vec![0xbb])];

        let _ = ProtocolRules::new([vec![0x01], vec![]], vec![0x03], vec![0x02])
            .with_fork(first)
            .with_fork(second);
    }

    /// The checkpoint prefix commits to the batch-encoding set, and does so
    /// under the same prefix rule as transaction types.
    ///
    /// Two schedules differing ONLY in which encodings a fork accepts must hash
    /// identically before that fork activates and differently from it onward.
    /// Without the second half the prefix would not really commit to the
    /// encoding; without the first, changing an encoding set would invalidate
    /// every existing checkpoint, which is the thing the prefix rule exists to
    /// stop.
    #[test]
    fn the_checkpoint_prefix_commits_to_batch_encodings_only_once_activated() {
        let base_only = ProtocolRules::new([vec![0xaa], vec![]], vec![0xcc], vec![0xdd])
            .with_fork(fork_at(100, BASE_TRANSACTION_TYPES.to_vec()));

        let mut retired = fork_at(100, BASE_TRANSACTION_TYPES.to_vec());
        retired.accepted_batch_versions = Vec::new();
        let without_encoding =
            ProtocolRules::new([vec![0xaa], vec![]], vec![0xcc], vec![0xdd]).with_fork(retired);

        for ts in [0, 50, 99] {
            assert_eq!(
                base_only.activated_fork_schedule_prefix_hash_at(ts),
                without_encoding.activated_fork_schedule_prefix_hash_at(ts),
                "an unactivated encoding change must not invalidate a checkpoint at {ts}"
            );
        }
        assert_ne!(
            base_only.activated_fork_schedule_prefix_hash_at(100),
            without_encoding.activated_fork_schedule_prefix_hash_at(100),
            "from activation the prefix must commit to the encoding set"
        );

        assert_eq!(
            without_encoding.accepted_batch_versions_at(99),
            BASE_BATCH_VERSIONS.to_vec()
        );
        assert!(without_encoding.accepted_batch_versions_at(100).is_empty());
    }
}
