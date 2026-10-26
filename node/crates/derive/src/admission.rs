//! Stateless admission of one batch item.
//!
//! An item is admitted when it is at most `MAX_TX_BYTES`, its complete
//! envelope names the network's chain ID, its payload decodes exactly for its
//! type, that type is active at the timestamp, and, for a direct-mode
//! user-account creation, its carrier is an Inbox carrier, checked in this
//! order by [`admit`]. A wrong-chain item is excluded as `WrongChainId` whatever its
//! payload holds, and nothing of it is decoded or verified. An admitted
//! transaction carries the static work its execution reuses, which an item of
//! an inactive type never pays for.

use alloy_primitives::Address;
use pcash_crypto::Fr;
use pcash_l1::CarrierKind;
use pcash_state::ItemExclusionReason;

use crate::engine::{prepare_contract_body, ContractValidation};
use crate::params::{
    ProtocolRules, KIND_CONTRACT_ACCOUNT_CREATION, KIND_PRIVATE_VALUE, KIND_USER_ACCOUNT_CREATION,
    KIND_USER_ACCOUNT_UPDATE, MAX_TX_BYTES,
};
use crate::transaction::{
    AccountCreationAttachment, AccountCreationAuthorization, ContractAccountCreation, ParseError,
    PrivateValueSection, Transaction, UserAccountCreation, UserAccountUpdate,
};

/// Why one item is not admitted.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum AdmissionError {
    #[error("item is {0} bytes; maximum is {MAX_TX_BYTES}")]
    TooLarge(usize),
    #[error(transparent)]
    Decode(#[from] ParseError),
    #[error("transaction type 0x{0:02x} is not active")]
    InactiveType(u8),
    #[error("a direct-mode account creation is delivered by a carrier event")]
    DirectModeOutsideInbox,
}

impl AdmissionError {
    /// The delivery-manifest reason that records this exclusion.
    pub fn reason(&self) -> ItemExclusionReason {
        match self {
            Self::TooLarge(_) => ItemExclusionReason::ItemTooLarge,
            Self::Decode(error) => match error {
                ParseError::Empty => ItemExclusionReason::Empty,
                ParseError::WrongChainId(_) => ItemExclusionReason::WrongChainId,
                ParseError::UnknownKind(_) => ItemExclusionReason::UnknownKind,
                ParseError::UnknownPrivateValueShape(_) => {
                    ItemExclusionReason::UnknownPrivateValueShape
                }
                ParseError::UnknownAuthorizationMode(_) => {
                    ItemExclusionReason::UnknownAuthorizationMode
                }
                ParseError::UnknownAccountCreationTag(_) => {
                    ItemExclusionReason::UnknownAccountCreationTag
                }
                ParseError::DirectCreationAttachment => {
                    ItemExclusionReason::DirectCreationAttachment
                }
                ParseError::UnknownReceiveKeyMode(_) => ItemExclusionReason::UnknownReceiveKeyMode,
                ParseError::UnknownPublishesNkRootFlag(_) => {
                    ItemExclusionReason::UnknownPublishesNkRootFlag
                }
                ParseError::UnknownYParity(_) => ItemExclusionReason::UnknownYParity,
                ParseError::Truncated => ItemExclusionReason::Truncated,
                ParseError::Trailing => ItemExclusionReason::TrailingBytes,
            },
            Self::InactiveType(_) => ItemExclusionReason::UnknownKind,
            Self::DirectModeOutsideInbox => ItemExclusionReason::DirectModeOutsideInbox,
        }
    }
}

/// The static validation of a contract body: its derived account material, or
/// the outcome of the first static check it fails.
#[derive(Clone, Debug)]
pub struct ContractBodyCheck(pub(crate) ContractValidation);

impl ContractBodyCheck {
    /// The address the body derives, when it passed its static checks.
    pub fn address(&self) -> Option<Address> {
        self.0.as_ref().ok().map(|material| material.address)
    }

    /// The account's nullifier-key commitment the body derives, when it
    /// passed its static checks.
    pub fn nullifier_key_commitment(&self) -> Option<Fr> {
        self.0.as_ref().ok().map(|material| material.nk_commitment)
    }
}

/// A transaction that passed admission, with the static work its execution
/// reuses: a contract creation carries its body's static validation.
#[derive(Clone, Debug)]
pub enum AdmittedTransaction {
    PrivateValue(PrivateValueSection, Option<ContractBodyCheck>),
    UserAccountCreation(UserAccountCreation),
    UserAccountUpdate(UserAccountUpdate),
    ContractAccountCreation(ContractAccountCreation, ContractBodyCheck),
}

impl AdmittedTransaction {
    /// Decode bytes [`admit`] accepted earlier on the network
    /// `pcash_chain_id`, with the same static work and without the size check
    /// or the fork gate. Whether the type is active depends on the timestamp,
    /// so a holder that validates the transaction at another timestamp applies
    /// the fork gate again.
    pub fn decode(raw: &[u8], pcash_chain_id: u32) -> Result<Self, ParseError> {
        Transaction::decode(raw, pcash_chain_id).map(Self::new)
    }

    /// Attach the static work execution reuses to a decoded transaction.
    fn new(transaction: Transaction) -> Self {
        match transaction {
            Transaction::PrivateValue(section) => {
                let check = match section.account_creation() {
                    Some(AccountCreationAttachment::Contract(body)) => {
                        Some(ContractBodyCheck(prepare_contract_body(body)))
                    }
                    _ => None,
                };
                Self::PrivateValue(section, check)
            }
            Transaction::UserAccountCreation(creation) => Self::UserAccountCreation(creation),
            Transaction::UserAccountUpdate(update) => Self::UserAccountUpdate(update),
            Transaction::ContractAccountCreation(creation) => {
                let check = ContractBodyCheck(prepare_contract_body(&creation.body));
                Self::ContractAccountCreation(creation, check)
            }
        }
    }

    /// The transaction type byte.
    pub fn kind(&self) -> u8 {
        match self {
            Self::PrivateValue(..) => KIND_PRIVATE_VALUE,
            Self::UserAccountCreation(_) => KIND_USER_ACCOUNT_CREATION,
            Self::UserAccountUpdate(_) => KIND_USER_ACCOUNT_UPDATE,
            Self::ContractAccountCreation(..) => KIND_CONTRACT_ACCOUNT_CREATION,
        }
    }

    /// The private-value section the transaction carries, if any.
    pub fn section(&self) -> Option<&PrivateValueSection> {
        match self {
            Self::PrivateValue(section, _) => Some(section),
            Self::UserAccountUpdate(update) => Some(&update.section),
            Self::ContractAccountCreation(..) => None,
            Self::UserAccountCreation(_) => None,
        }
    }
}

/// Admit one batch item `raw` delivered by a carrier of kind `carrier` under
/// the network chain ID `pcash_chain_id`, for a block, or a validation
/// context, at L1 timestamp `timestamp`.
pub fn admit(
    raw: &[u8],
    rules: &ProtocolRules,
    pcash_chain_id: u32,
    timestamp: u64,
    carrier: CarrierKind,
) -> Result<AdmittedTransaction, AdmissionError> {
    if raw.len() > MAX_TX_BYTES {
        return Err(AdmissionError::TooLarge(raw.len()));
    }
    let transaction = Transaction::decode(raw, pcash_chain_id)?;
    if !rules.transaction_type_allowed_at(transaction.kind(), timestamp) {
        return Err(AdmissionError::InactiveType(transaction.kind()));
    }
    // Direct mode registers the top-level Ethereum sender, which authenticates
    // only an Inbox carrier.
    if carrier == CarrierKind::Event
        && matches!(
            &transaction,
            Transaction::UserAccountCreation(creation)
                if matches!(creation.authorization, AccountCreationAuthorization::DirectL1)
        )
    {
        return Err(AdmissionError::DirectModeOutsideInbox);
    }
    Ok(AdmittedTransaction::new(transaction))
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "tests use direct assertions"
)]
mod tests {
    use super::*;
    use crate::params::{ForkActivation, BASE_BATCH_VERSIONS};
    use crate::transaction::{ContractBody, ContractFunction};
    use pcash_state::{fr_from_canonical_bytes, CircuitWord};

    const CHAIN: u32 = 7;
    const RETIRED_AT: u64 = 100;

    /// Launch rules plus a fork at [`RETIRED_AT`] that retires contract
    /// creation.
    fn rules() -> ProtocolRules {
        ProtocolRules::new([vec![], vec![]], vec![]).with_fork(ForkActivation {
            name: "retire contract creation",
            activation_timestamp: RETIRED_AT,
            accepted_transaction_types: vec![
                KIND_PRIVATE_VALUE,
                KIND_USER_ACCOUNT_CREATION,
                KIND_USER_ACCOUNT_UPDATE,
            ],
            accepted_batch_versions: BASE_BATCH_VERSIONS.to_vec(),
            hiding_kernel_vks: Vec::new(),
        })
    }

    fn unfunded(functions: Vec<ContractFunction>) -> Vec<u8> {
        Transaction::ContractAccountCreation(ContractAccountCreation {
            body: ContractBody::new(false, CircuitWord::repeat_byte(1), None, functions).unwrap(),
            recent_pcash_block_hash: CircuitWord::repeat_byte(2),
            valid_until_timestamp: 3,
        })
        .encode(CHAIN)
        .unwrap()
    }

    fn envelope(kind: u8, chain: u32, payload: &[u8]) -> Vec<u8> {
        [&[kind][..], &chain.to_be_bytes(), payload].concat()
    }

    fn reason(raw: &[u8], chain: u32, ts: u64) -> Option<ItemExclusionReason> {
        admit(raw, &rules(), chain, ts, CarrierKind::Inbox)
            .err()
            .map(|error| error.reason())
    }

    #[test]
    fn admission_checks_size_envelope_chain_payload_then_fork_gate() {
        let wrong = CHAIN + 1;
        let mut oversized = envelope(0xff, wrong, &[]);
        oversized.resize(MAX_TX_BYTES + 1, 0);
        assert_eq!(
            reason(&oversized, CHAIN, 0),
            Some(ItemExclusionReason::ItemTooLarge)
        );
        assert_eq!(reason(&[], CHAIN, 0), Some(ItemExclusionReason::Empty));
        // A partial envelope is truncated whatever its type byte says.
        for partial in [&[0xff][..], &envelope(0xff, CHAIN, &[])[..4]] {
            assert_eq!(
                reason(partial, CHAIN, 0),
                Some(ItemExclusionReason::Truncated)
            );
        }
        // A foreign envelope excludes the item before its type or payload.
        for foreign in [
            envelope(KIND_PRIVATE_VALUE, wrong, &[]),
            envelope(KIND_PRIVATE_VALUE, wrong, &[0xee]),
            envelope(0xff, wrong, &[0xee]),
            envelope(KIND_CONTRACT_ACCOUNT_CREATION, wrong, &[0xee]),
        ] {
            for ts in [0, RETIRED_AT] {
                assert_eq!(
                    reason(&foreign, CHAIN, ts),
                    Some(ItemExclusionReason::WrongChainId)
                );
            }
        }
        assert_eq!(
            reason(&envelope(0xff, CHAIN, &[]), CHAIN, 0),
            Some(ItemExclusionReason::UnknownKind)
        );
        assert_eq!(
            reason(&envelope(KIND_PRIVATE_VALUE, CHAIN, &[0xee]), CHAIN, 0),
            Some(ItemExclusionReason::UnknownPrivateValueShape)
        );
        assert_eq!(
            reason(&envelope(KIND_PRIVATE_VALUE, CHAIN, &[0]), CHAIN, 0),
            Some(ItemExclusionReason::Truncated)
        );
        for mode in [2, 0xff] {
            assert_eq!(
                reason(
                    &envelope(KIND_CONTRACT_ACCOUNT_CREATION, CHAIN, &[mode]),
                    CHAIN,
                    0
                ),
                Some(ItemExclusionReason::Truncated)
            );
        }
        for mode in [0, 1] {
            assert_eq!(
                reason(
                    &envelope(KIND_CONTRACT_ACCOUNT_CREATION, CHAIN, &[mode]),
                    CHAIN,
                    0
                ),
                Some(ItemExclusionReason::Truncated)
            );
        }
        // A malformed payload of a retired type is a structural failure.
        assert_eq!(
            reason(
                &envelope(KIND_CONTRACT_ACCOUNT_CREATION, CHAIN, &[0xee]),
                CHAIN,
                RETIRED_AT
            ),
            Some(ItemExclusionReason::Truncated)
        );

        let raw = unfunded(Vec::new());
        assert!(matches!(
            admit(&raw, &rules(), CHAIN, RETIRED_AT - 1, CarrierKind::Inbox),
            Ok(AdmittedTransaction::ContractAccountCreation(..))
        ));
        assert_eq!(
            admit(&raw, &rules(), CHAIN, RETIRED_AT, CarrierKind::Inbox).err(),
            Some(AdmissionError::InactiveType(KIND_CONTRACT_ACCOUNT_CREATION))
        );
        assert_eq!(
            reason(&raw, CHAIN, RETIRED_AT),
            Some(ItemExclusionReason::UnknownKind)
        );
        // The same bytes are never admitted on another network.
        assert_eq!(
            reason(&raw, CHAIN + 1, 0),
            Some(ItemExclusionReason::WrongChainId)
        );
    }

    /// A direct-mode user-account creation (authorization mode `0`).
    fn direct_creation() -> Vec<u8> {
        let mut raw = vec![KIND_USER_ACCOUNT_CREATION];
        raw.extend_from_slice(&CHAIN.to_be_bytes());
        raw.push(0);
        raw.extend_from_slice(&[0; 64]);
        raw.push(0);
        raw.extend_from_slice(&[0; 32 + 8]);
        raw
    }

    #[test]
    fn a_direct_creation_is_admitted_only_from_an_inbox_carrier() {
        let direct = direct_creation();
        assert!(matches!(
            admit(&direct, &rules(), CHAIN, 0, CarrierKind::Inbox),
            Ok(AdmittedTransaction::UserAccountCreation(_))
        ));
        assert_eq!(
            admit(&direct, &rules(), CHAIN, 0, CarrierKind::Event)
                .err()
                .map(|error| error.reason()),
            Some(ItemExclusionReason::DirectModeOutsideInbox)
        );
        // Earlier checks name the class first.
        assert_eq!(
            admit(&direct, &rules(), CHAIN + 1, 0, CarrierKind::Event)
                .err()
                .map(|error| error.reason()),
            Some(ItemExclusionReason::WrongChainId)
        );
        let mut trailing = direct.clone();
        trailing.push(0);
        assert_eq!(
            admit(&trailing, &rules(), CHAIN, 0, CarrierKind::Event)
                .err()
                .map(|error| error.reason()),
            Some(ItemExclusionReason::TrailingBytes)
        );
        // Signed mode is admitted from any carrier.
        let mut signed = direct;
        signed[5] = 1;
        signed.extend_from_slice(&[0; 65]);
        assert!(admit(&signed, &rules(), CHAIN, 0, CarrierKind::Event).is_ok());
    }

    fn body_check(admitted: AdmittedTransaction) -> ContractBodyCheck {
        let AdmittedTransaction::ContractAccountCreation(_, check) = admitted else {
            panic!("a contract creation");
        };
        check
    }

    #[test]
    fn a_contract_creation_carries_its_static_body_check() {
        // An empty function set fails its static checks, so it has no
        // derived material.
        let check = body_check(
            admit(
                &unfunded(Vec::new()),
                &rules(),
                CHAIN,
                0,
                CarrierKind::Inbox,
            )
            .unwrap(),
        );
        assert_eq!(check.address(), None);
        assert_eq!(check.nullifier_key_commitment(), None);

        let raw = unfunded(vec![ContractFunction {
            selector: 0,
            application_vk_hash: CircuitWord::repeat_byte(2),
            configuration_commitment: CircuitWord::repeat_byte(3),
        }]);
        let admitted =
            body_check(admit(&raw, &rules(), CHAIN, RETIRED_AT - 1, CarrierKind::Inbox).unwrap());
        assert!(admitted.address().is_some());
        // Without a published root, the body's material is the commitment.
        assert_eq!(
            admitted.nullifier_key_commitment(),
            fr_from_canonical_bytes(CircuitWord::repeat_byte(1))
        );
        // Bytes admitted earlier decode with the same check and no fork gate.
        assert_eq!(
            admit(&raw, &rules(), CHAIN, RETIRED_AT, CarrierKind::Inbox).err(),
            Some(AdmissionError::InactiveType(KIND_CONTRACT_ACCOUNT_CREATION))
        );
        let decoded = body_check(AdmittedTransaction::decode(&raw, CHAIN).unwrap());
        assert_eq!(decoded.address(), admitted.address());
        assert_eq!(
            decoded.nullifier_key_commitment(),
            admitted.nullifier_key_commitment()
        );
    }
}
