//! The `txBytes` codec.
//!
//! Structural decoding rejects a selector byte outside its set. Every other
//! value, such as a word that is not a canonical field element, is preserved
//! for ordered execution, where it decides the committed outcome. Under one
//! network's chain ID, every decodable byte string has exactly one
//! [`Transaction`] and every decoded [`Transaction`] exactly one byte string.

use alloy_primitives::{Address, B256};
use pcash_crypto::{domain_tags, poseidon, poseidon_bytes, Fr};
use pcash_state::codec::{CursorError, PrefixOverflow, Reader, Writer};
use pcash_state::{fr_to_bytes, CircuitWord};
use std::sync::OnceLock;

use crate::params::{
    SectionLayout, KIND_CONTRACT_ACCOUNT_CREATION, KIND_PRIVATE_VALUE, KIND_USER_ACCOUNT_CREATION,
    KIND_USER_ACCOUNT_UPDATE, ML_KEM768_PUBLIC_KEY_LEN, OUTPUT_DATA_BYTES,
};
use crate::private_value_profiles::{PrivateValueProfile, PrivateValueShape};

pub const RECEIVE_KEY_ABSENT: u8 = 0;
pub const RECEIVE_KEY_PRESENT: u8 = 1;
pub const RECEIVE_KEY_UPDATE_KEEP: u8 = 0;
pub const RECEIVE_KEY_UPDATE_CLEAR: u8 = 1;
pub const RECEIVE_KEY_UPDATE_REPLACE: u8 = 2;

/// An ML-KEM-768 public key exactly as posted.
pub type ReceiveKey = Box<[u8; ML_KEM768_PUBLIC_KEY_LEN]>;

/// Errors from decoding one item's `txBytes`.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum ParseError {
    #[error("empty txBytes")]
    Empty,
    #[error("envelope chain ID {0} is not this network's")]
    WrongChainId(u32),
    #[error("unknown transaction kind {0}")]
    UnknownKind(u8),
    #[error("unknown private-value shape {0}")]
    UnknownPrivateValueShape(u8),
    #[error("unknown account authorization mode {0}")]
    UnknownAuthorizationMode(u8),
    #[error("unknown account-creation attachment tag {0}")]
    UnknownAccountCreationTag(u8),
    #[error("an attached user creation must use signed authorization")]
    DirectCreationAttachment,
    #[error("unknown receive-key mode {0}")]
    UnknownReceiveKeyMode(u8),
    #[error("unknown publishesNkRoot flag {0}")]
    UnknownPublishesNkRootFlag(u8),
    #[error("unknown y-parity {0}")]
    UnknownYParity(u8),
    #[error("truncated body")]
    Truncated,
    #[error("trailing bytes after body")]
    Trailing,
}

/// A transaction that has no `txBytes` encoding: decoding could never return
/// it.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum EncodeError {
    #[error("an attached user creation must use signed authorization")]
    DirectCreationAttachment,
    /// A private-value profile fixes how many words and output slots a section
    /// has; any other count would shift every later field.
    #[error("{field} has {actual} items but the profile fixes {expected}")]
    Dimension {
        field: &'static str,
        expected: usize,
        actual: usize,
    },
    /// A count or byte length that its wire prefix cannot represent.
    #[error("{field} is {actual}, above the {max} its length prefix can hold")]
    PrefixOverflow {
        field: &'static str,
        max: usize,
        actual: usize,
    },
}

impl From<CursorError> for ParseError {
    fn from(error: CursorError) -> Self {
        match error {
            // A read whose end overflows the offset also ends past the bytes.
            CursorError::Truncated | CursorError::Overflow => Self::Truncated,
            CursorError::Trailing => Self::Trailing,
        }
    }
}

impl From<PrefixOverflow> for EncodeError {
    fn from(overflow: PrefixOverflow) -> Self {
        Self::PrefixOverflow {
            field: overflow.field,
            max: overflow.max,
            actual: overflow.actual,
        }
    }
}

fn require_dimension(
    field: &'static str,
    expected: usize,
    actual: usize,
) -> Result<(), EncodeError> {
    if actual == expected {
        Ok(())
    } else {
        Err(EncodeError::Dimension {
            field,
            expected,
            actual,
        })
    }
}

fn require_prefix(field: &'static str, max: usize, actual: usize) -> Result<(), EncodeError> {
    if actual <= max {
        Ok(())
    } else {
        Err(EncodeError::PrefixOverflow { field, max, actual })
    }
}

const U8_PREFIX_MAX: usize = u8::MAX as usize;

/// A private-value section's held verifier words, proof, output data and arena.
/// Delivery and account-creation commitments are derived from their exact
/// bytes on first use. The network supplies the chain ID; account-update
/// sections supply zero for issuance and account creation. Type `0x00`
/// prefixes the section with its shape and appends the tagged attachment.
/// [`SectionLayout`] fixes the serialized dimensions.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PrivateValueSection {
    shape: PrivateValueShape,
    /// Raw verifier words without the two derived commitments. Ordered
    /// execution checks field canonicality.
    words: Vec<CircuitWord>,
    pub proof: Vec<u8>,
    /// Opaque output data in slot order.
    output_data: Vec<Vec<u8>>,
    /// Opaque delivery data shared by the section's outputs.
    arena: Vec<u8>,
    delivery_commitment: Cached<CircuitWord>,
    account_creation: Option<AccountCreationAttachment>,
    account_creation_commitment: Cached<CircuitWord>,
}

/// A hash computed on first use from private fields of its owner, which
/// cannot change after construction. It is a function of those fields, so it
/// takes no part in equality: an owner whose hash is computed equals one whose
/// hash is not.
#[derive(Clone, Debug, Default)]
struct Cached<T>(OnceLock<T>);

impl<T> PartialEq for Cached<T> {
    fn eq(&self, _other: &Self) -> bool {
        true
    }
}

impl<T> Eq for Cached<T> {}

/// Where verifier input `offset` sits in the held words; derived commitments
/// have no held word.
const fn word_index(profile: PrivateValueProfile, offset: usize) -> Option<usize> {
    if offset == profile.public_inputs - 1 {
        None
    } else if offset < profile.delivery_commitment_offset {
        Some(offset)
    } else if offset == profile.delivery_commitment_offset {
        None
    } else {
        Some(offset - 1)
    }
}

impl PrivateValueSection {
    /// Build a section for the network `pcash_chain_id` from the words
    /// `txBytes` serializes: exactly the profile's `wire_inputs` verifier
    /// words in wire order, exactly one output-data item per output slot, and
    /// the arena.
    pub fn new(
        shape: PrivateValueShape,
        pcash_chain_id: u32,
        wire_inputs: &[CircuitWord],
        proof: Vec<u8>,
        output_data: Vec<Vec<u8>>,
        arena: Vec<u8>,
    ) -> Result<Self, EncodeError> {
        let profile = shape.profile();
        require_dimension("wire inputs", profile.wire_inputs, wire_inputs.len())?;
        require_dimension("output data", profile.outputs, output_data.len())?;
        Ok(Self::from_wire(
            SectionLayout::PrivateValue(shape),
            pcash_chain_id,
            wire_inputs,
            proof,
            output_data,
            arena,
        ))
    }

    /// [`PrivateValueSection::new`] for parts already known to match the
    /// profile.
    fn from_wire(
        layout: SectionLayout,
        pcash_chain_id: u32,
        wire_inputs: &[CircuitWord],
        proof: Vec<u8>,
        output_data: Vec<Vec<u8>>,
        arena: Vec<u8>,
    ) -> Self {
        let shape = layout.shape();
        let profile = shape.profile();
        let mut words = Vec::with_capacity(profile.public_inputs - 1);
        let mut chain_id_word = [0u8; 32];
        chain_id_word[28..].copy_from_slice(&pcash_chain_id.to_be_bytes());
        words.push(CircuitWord::from(chain_id_word));
        words.extend_from_slice(wire_inputs);
        if let Some(index) = word_index(profile, profile.issuance_owner_offset)
            .filter(|_| layout.omits_issuance_owner())
        {
            words.insert(index, CircuitWord::ZERO);
        }
        Self {
            shape,
            words,
            proof,
            output_data,
            arena,
            delivery_commitment: Cached::default(),
            account_creation: None,
            account_creation_commitment: Cached::default(),
        }
    }

    /// Kind-0 subtype; account fee sections use S.
    pub fn shape(&self) -> PrivateValueShape {
        self.shape
    }

    /// Verifier input `offset`, deriving each commitment on first use.
    pub fn public_input(&self, offset: usize) -> CircuitWord {
        match word_index(self.shape.profile(), offset) {
            Some(index) => self.words[index],
            None if offset == self.shape.profile().public_inputs - 1 => {
                self.account_creation_commitment()
            }
            None => self.delivery_commitment(),
        }
    }

    /// The held verifier word, or `None` for a derived commitment.
    pub fn public_input_mut(&mut self, offset: usize) -> Option<&mut CircuitWord> {
        word_index(self.shape.profile(), offset).map(|index| &mut self.words[index])
    }

    /// The carrier context the section requires of the carrier that
    /// delivers it; zero requires none.
    pub fn carrier_context_hash(&self) -> CircuitWord {
        self.public_input(self.shape.profile().carrier_context_hash_offset)
    }

    /// The section's complete verifier-input vector in verifier order,
    /// including the delivery commitment.
    pub fn public_inputs(&self) -> Vec<CircuitWord> {
        (0..self.shape.profile().public_inputs)
            .map(|offset| self.public_input(offset))
            .collect()
    }

    pub fn account_creation(&self) -> Option<&AccountCreationAttachment> {
        self.account_creation.as_ref()
    }

    pub fn with_account_creation(
        mut self,
        attachment: AccountCreationAttachment,
    ) -> Result<Self, EncodeError> {
        match &attachment {
            AccountCreationAttachment::User(creation)
                if matches!(
                    creation.authorization,
                    AccountCreationAuthorization::DirectL1
                ) =>
            {
                return Err(EncodeError::DirectCreationAttachment)
            }
            AccountCreationAttachment::Contract(body) => {
                require_prefix("function count", U8_PREFIX_MAX, body.functions.len())?;
            }
            _ => {}
        }
        self.account_creation = Some(attachment);
        self.account_creation_commitment = Cached::default();
        Ok(self)
    }

    pub fn account_creation_commitment(&self) -> CircuitWord {
        *self.account_creation_commitment.0.get_or_init(|| {
            self.account_creation
                .as_ref()
                .map_or(CircuitWord::ZERO, |attachment| {
                    fr_to_bytes(poseidon_bytes(
                        domain_tags::ACCOUNT_CREATION_ATTACHMENT_DOMAIN,
                        &attachment.canonical_bytes(),
                    ))
                })
        })
    }

    /// Opaque output data in slot order.
    pub fn output_data(&self) -> &[Vec<u8>] {
        &self.output_data
    }

    /// The opaque arena.
    pub fn arena(&self) -> &[u8] {
        &self.arena
    }

    /// `poseidon(DELIVERY_COMMITMENT_DOMAIN, outputDataHash_0, ...,
    /// outputDataHash_(O-1), arenaHash)`, computed on first use.
    pub fn delivery_commitment(&self) -> CircuitWord {
        *self
            .delivery_commitment
            .0
            .get_or_init(|| delivery_commitment_word(&self.output_data, &self.arena))
    }
}

/// How a user-account creation is authorized, which also names the account:
/// the carrying Ethereum transaction's sender, or the signer an EIP-712
/// signature recovers to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AccountCreationAuthorization {
    DirectL1,
    Eip712 {
        sig_r: CircuitWord,
        sig_s: CircuitWord,
        /// The recovery parity: `true` for an odd `y`.
        y_parity: bool,
    },
}

/// A kind-1 user-account creation payload. It carries no address: the
/// authorization determines it. The receive key's hash, which the signature
/// and the account row commit, is computed on first use, once per creation
/// ([`Self::receive_key_hash`]).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UserAccountCreation {
    /// Nullifier-key commitment (raw 32-byte field element).
    pub nullifier_key_commitment: CircuitWord,
    pub rule_set_commitment: CircuitWord,
    receive_key: Option<ReceiveKey>,
    pub recent_pcash_block_hash: CircuitWord,
    pub valid_until_timestamp: u64,
    pub authorization: AccountCreationAuthorization,
    receive_key_hash: Cached<CircuitWord>,
}

impl UserAccountCreation {
    pub fn new(
        nullifier_key_commitment: CircuitWord,
        rule_set_commitment: CircuitWord,
        receive_key: Option<ReceiveKey>,
        recent_pcash_block_hash: CircuitWord,
        valid_until_timestamp: u64,
        authorization: AccountCreationAuthorization,
    ) -> Self {
        Self {
            nullifier_key_commitment,
            rule_set_commitment,
            receive_key,
            recent_pcash_block_hash,
            valid_until_timestamp,
            authorization,
            receive_key_hash: Cached::default(),
        }
    }

    /// The exact ML-KEM-768 public key the creation sets, if any.
    pub fn receive_key(&self) -> Option<&[u8; ML_KEM768_PUBLIC_KEY_LEN]> {
        self.receive_key.as_deref()
    }

    /// The [`pcash_state::receive_key_hash`] of the creation's receive key,
    /// else `bytes32(0)`, computed on first use.
    pub fn receive_key_hash(&self) -> CircuitWord {
        *self.receive_key_hash.0.get_or_init(|| {
            self.receive_key
                .as_deref()
                .map_or(CircuitWord::ZERO, |key| pcash_state::receive_key_hash(key))
        })
    }
}

/// A kind-3 user-account update. Its private-value section pays the fee from
/// the account's own notes; the account update commitment is the public input
/// after the section's own.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UserAccountUpdate {
    pub address: Address,
    pub new_rule_set_commitment: CircuitWord,
    pub receive_key_update: ReceiveKeyUpdate,
    pub account_update_commitment: CircuitWord,
    pub section: PrivateValueSection,
}

/// Delivery-material operation encoded by a user-account update.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ReceiveKeyUpdate {
    /// Preserve the immediately preceding live receive-key state.
    Keep,
    /// Install the canonical absent receive-key state.
    Clear,
    /// Install a new ML-KEM-768 public key.
    Replace(ReceiveKey),
}

pub(crate) fn words_blob(words: &[CircuitWord]) -> Vec<u8> {
    let mut out = Vec::with_capacity(words.len() * 32);
    for word in words {
        out.extend_from_slice(word.as_slice());
    }
    out
}

/// One registered function in a kind-2 smart-contract body: its depth-8
/// selector and the two field elements that commit its account-rule circuit.
/// The account-rule entry's `commitmentBlinder` is the canonical `0` for a
/// contract function and is therefore not serialized.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ContractFunction {
    pub selector: u8,
    pub application_vk_hash: B256,
    pub configuration_commitment: B256,
}

/// The public body of a standalone or attached contract-account creation.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ContractBody {
    /// False: `nullifier_key_material` is the account's `nullifierKeyCommitment`.
    /// True: it is `nkRoot`, and the commitment is derived from it.
    pub publishes_nk_root: bool,
    /// Exactly one representation of the account's nullifier-key material,
    /// selected by `publishes_nk_root`. A body never carries both, so it
    /// cannot encode a root and a commitment that disagree.
    pub nullifier_key_material: CircuitWord,
    pub receive_key: Option<ReceiveKey>,
    /// The registered functions, in wire order (selectors verified in the
    /// engine). `functionSetCommitment` is derived from this list, never
    /// serialized beside it.
    pub functions: Vec<ContractFunction>,
}

impl ContractBody {
    /// A body with at most the 255 functions its count byte can state.
    pub fn new(
        publishes_nk_root: bool,
        nullifier_key_material: CircuitWord,
        receive_key: Option<ReceiveKey>,
        functions: Vec<ContractFunction>,
    ) -> Result<Self, EncodeError> {
        require_prefix("function count", U8_PREFIX_MAX, functions.len())?;
        Ok(Self {
            publishes_nk_root,
            nullifier_key_material,
            receive_key,
            functions,
        })
    }
}

/// The account whose existence a private-value transaction ensures.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AccountCreationAttachment {
    User(UserAccountCreation),
    Contract(ContractBody),
}

impl AccountCreationAttachment {
    #[allow(
        clippy::expect_used,
        reason = "attachment construction bounds the contract function count"
    )]
    fn canonical_bytes(&self) -> Vec<u8> {
        let mut writer = Writer::default();
        match self {
            Self::User(creation) => {
                writer.u8(1);
                encode_user_account_creation(&mut writer, creation);
            }
            Self::Contract(body) => {
                writer.u8(2);
                // A decoded body's function count fits its u8 prefix.
                encode_contract_body(&mut writer, body)
                    .expect("contract body count fits its prefix");
            }
        }
        writer.into_bytes()
    }
}

/// A proof-free kind-2 contract-account creation.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ContractAccountCreation {
    pub body: ContractBody,
    pub recent_pcash_block_hash: CircuitWord,
    pub valid_until_timestamp: u64,
}

/// A decoded transaction: one type's payload. The chain ID its envelope
/// names is the network's, so it is not stored here.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Transaction {
    PrivateValue(PrivateValueSection),
    UserAccountCreation(UserAccountCreation),
    UserAccountUpdate(UserAccountUpdate),
    ContractAccountCreation(ContractAccountCreation),
}

impl Transaction {
    /// The transaction type byte this transaction was decoded from.
    pub fn kind(&self) -> u8 {
        match self {
            Self::PrivateValue(_) => KIND_PRIVATE_VALUE,
            Self::UserAccountCreation(_) => KIND_USER_ACCOUNT_CREATION,
            Self::UserAccountUpdate(_) => KIND_USER_ACCOUNT_UPDATE,
            Self::ContractAccountCreation(_) => KIND_CONTRACT_ACCOUNT_CREATION,
        }
    }

    pub fn contract_body(&self) -> Option<&ContractBody> {
        match self {
            Self::ContractAccountCreation(creation) => Some(&creation.body),
            Self::PrivateValue(section) => match section.account_creation() {
                Some(AccountCreationAttachment::Contract(body)) => Some(body),
                _ => None,
            },
            _ => None,
        }
    }

    /// The private-value section that carries this transaction's outputs, if
    /// any.
    pub fn section(&self) -> Option<&PrivateValueSection> {
        match self {
            Self::PrivateValue(section) => Some(section),
            Self::UserAccountCreation(_) => None,
            Self::UserAccountUpdate(update) => Some(&update.section),
            Self::ContractAccountCreation(_) => None,
        }
    }

    /// The output data of each output slot, in slot order.
    pub fn output_data(&self) -> &[Vec<u8>] {
        self.section().map_or(&[], PrivateValueSection::output_data)
    }
}

/// Whether already decoded transaction bytes name a creation authorized by its L1 sender.
pub fn is_direct_account_creation(raw: &[u8]) -> bool {
    raw[0] == KIND_USER_ACCOUNT_CREATION && raw[ENVELOPE_BYTES] == 0
}

/// Bytes of the fixed envelope `txType (u8) ‖ pcashChainId (u32be)`.
pub const ENVELOPE_BYTES: usize = 5;

impl Transaction {
    /// Decode one item's `txBytes` under the network chain ID
    /// `pcash_chain_id`.
    ///
    /// The complete fixed envelope is read first: an item shorter than
    /// [`ENVELOPE_BYTES`] is `Empty` or `Truncated`, and an envelope naming
    /// another chain is `WrongChainId` without its payload being read. The
    /// type byte then selects the payload grammar, which must consume the item
    /// exactly. An assigned type decodes the same way at every timestamp;
    /// whether it is active is admission's separate question
    /// ([`crate::admit`]), which also bounds the item to `MAX_TX_BYTES`
    /// before decoding.
    pub fn decode(tx_bytes: &[u8], pcash_chain_id: u32) -> Result<Self, ParseError> {
        if tx_bytes.is_empty() {
            return Err(ParseError::Empty);
        }
        let mut r = Reader::new(tx_bytes);
        let ty = r.take_u8()?;
        let envelope_chain_id = r.take_u32()?;
        if envelope_chain_id != pcash_chain_id {
            return Err(ParseError::WrongChainId(envelope_chain_id));
        }
        let transaction = match ty {
            KIND_PRIVATE_VALUE => {
                let selector = r.take_u8()?;
                let shape = PrivateValueShape::from_wire_byte(selector)
                    .ok_or(ParseError::UnknownPrivateValueShape(selector))?;
                let mut section = decode_private_value_section(
                    &mut r,
                    pcash_chain_id,
                    SectionLayout::PrivateValue(shape),
                )?;
                section.account_creation = match r.take_u8()? {
                    0 => None,
                    1 => {
                        let creation = decode_user_account_creation(&mut r)?;
                        if matches!(
                            creation.authorization,
                            AccountCreationAuthorization::DirectL1
                        ) {
                            return Err(ParseError::DirectCreationAttachment);
                        }
                        Some(AccountCreationAttachment::User(creation))
                    }
                    2 => Some(AccountCreationAttachment::Contract(decode_contract_body(
                        &mut r,
                    )?)),
                    tag => return Err(ParseError::UnknownAccountCreationTag(tag)),
                };
                Self::PrivateValue(section)
            }
            KIND_USER_ACCOUNT_CREATION => {
                Self::UserAccountCreation(decode_user_account_creation(&mut r)?)
            }
            KIND_USER_ACCOUNT_UPDATE => {
                Self::UserAccountUpdate(decode_user_account_update(&mut r, pcash_chain_id)?)
            }
            KIND_CONTRACT_ACCOUNT_CREATION => {
                Self::ContractAccountCreation(decode_contract_account_creation(&mut r)?)
            }
            other => return Err(ParseError::UnknownKind(other)),
        };
        r.finish()?;
        Ok(transaction)
    }

    /// Encode this transaction as `txBytes` whose envelope names
    /// `pcash_chain_id`: the exact inverse of [`Transaction::decode`] under
    /// the same chain ID on every transaction it returns, so encoding a
    /// decoded transaction never fails.
    ///
    /// The derived verifier words of a section are not written; the output
    /// data and arena they are derived from are.
    ///
    /// A function count above 255 is an error. Proofs, output-data items, and
    /// arenas are written without a length, so their sizes must be the ones
    /// the enclosing type fixes; decoded transactions always have them.
    pub fn encode(&self, pcash_chain_id: u32) -> Result<Vec<u8>, EncodeError> {
        let mut w = Writer::default();
        w.u8(self.kind());
        w.u32(pcash_chain_id);
        match self {
            Self::PrivateValue(section) => {
                w.u8(section.shape as u8);
                encode_private_value_section(
                    &mut w,
                    section,
                    SectionLayout::PrivateValue(section.shape),
                );
                match section.account_creation() {
                    None => w.u8(0),
                    Some(attachment) => w.bytes(&attachment.canonical_bytes()),
                }
            }
            Self::UserAccountCreation(creation) => {
                encode_user_account_creation(&mut w, creation);
            }
            Self::UserAccountUpdate(update) => encode_user_account_update(&mut w, update),
            Self::ContractAccountCreation(creation) => {
                encode_contract_account_creation(&mut w, creation)?;
            }
        }
        Ok(w.into_bytes())
    }
}

/// The private-value section of one layout: its serialized verifier words,
/// the proof, one output-data item per output slot, and the arena, each of
/// the size the layout fixes. `pcash_chain_id` is the network's, which
/// supplies the section's first verifier word.
fn decode_private_value_section(
    r: &mut Reader<'_>,
    pcash_chain_id: u32,
    layout: SectionLayout,
) -> Result<PrivateValueSection, ParseError> {
    let shape = layout.shape();
    let profile = shape.profile();
    let mut wire_inputs = Vec::with_capacity(layout.wire_inputs());
    for _ in 0..layout.wire_inputs() {
        wire_inputs.push(CircuitWord::from(r.take_array::<32>()?));
    }
    let proof = r.take(layout.proof_bytes())?.to_vec();
    let mut output_data = Vec::with_capacity(profile.outputs);
    for _ in 0..profile.outputs {
        output_data.push(r.take(OUTPUT_DATA_BYTES)?.to_vec());
    }
    let arena = r.take(profile.arena_bytes)?.to_vec();
    Ok(PrivateValueSection::from_wire(
        layout,
        pcash_chain_id,
        &wire_inputs,
        proof,
        output_data,
        arena,
    ))
}

fn encode_private_value_section(
    w: &mut Writer,
    section: &PrivateValueSection,
    layout: SectionLayout,
) {
    let profile = section.shape.profile();
    let omitted = word_index(profile, profile.issuance_owner_offset)
        .filter(|_| layout.omits_issuance_owner());
    // Word 0 is the network's chain-ID word, which the envelope states.
    for (index, word) in section.words.iter().enumerate().skip(1) {
        if Some(index) != omitted {
            w.bytes(word.as_slice());
        }
    }
    w.bytes(&section.proof);
    for data in &section.output_data {
        w.bytes(data);
    }
    w.bytes(&section.arena);
}

/// `poseidonBytes(OUTPUT_DATA_HASH_DOMAIN, outputData)`.
fn output_data_hash(output_data: &[u8]) -> Fr {
    poseidon_bytes(domain_tags::OUTPUT_DATA_HASH_DOMAIN, output_data)
}

/// `poseidonBytes(ARENA_HASH_DOMAIN, arena)`.
fn arena_hash(arena: &[u8]) -> Fr {
    poseidon_bytes(domain_tags::ARENA_HASH_DOMAIN, arena)
}

/// `poseidon(DELIVERY_COMMITMENT_DOMAIN, outputDataHashes..., arenaHash)`.
fn delivery_commitment(output_data_hashes: impl IntoIterator<Item = Fr>, arena_hash: Fr) -> Fr {
    let mut inputs = vec![domain_tags::DELIVERY_COMMITMENT_DOMAIN];
    inputs.extend(output_data_hashes);
    inputs.push(arena_hash);
    poseidon(&inputs)
}

/// The canonical verifier word committing a section's output data and arena.
fn delivery_commitment_word(output_data: &[Vec<u8>], arena: &[u8]) -> CircuitWord {
    fr_to_bytes(delivery_commitment(
        output_data.iter().map(|data| output_data_hash(data)),
        arena_hash(arena),
    ))
}

/// A creation or contract-body receive key: `ABSENT`, or `PRESENT` followed
/// by exactly one key.
fn decode_receive_key(r: &mut Reader<'_>) -> Result<Option<ReceiveKey>, ParseError> {
    match r.take_u8()? {
        RECEIVE_KEY_ABSENT => Ok(None),
        RECEIVE_KEY_PRESENT => Ok(Some(take_receive_key(r)?)),
        mode => Err(ParseError::UnknownReceiveKeyMode(mode)),
    }
}

fn take_receive_key(r: &mut Reader<'_>) -> Result<ReceiveKey, ParseError> {
    Ok(Box::new(r.take_array::<ML_KEM768_PUBLIC_KEY_LEN>()?))
}

fn encode_receive_key(w: &mut Writer, receive_key: Option<&ReceiveKey>) {
    match receive_key {
        None => w.u8(RECEIVE_KEY_ABSENT),
        Some(key) => {
            w.u8(RECEIVE_KEY_PRESENT);
            w.bytes(key.as_slice());
        }
    }
}

fn decode_user_account_creation(r: &mut Reader<'_>) -> Result<UserAccountCreation, ParseError> {
    let mode = r.take_u8()?;
    if mode > 1 {
        return Err(ParseError::UnknownAuthorizationMode(mode));
    }
    let nullifier_key_commitment = CircuitWord::from(r.take_array::<32>()?);
    let rule_set_commitment = CircuitWord::from(r.take_array::<32>()?);
    let receive_key = decode_receive_key(r)?;
    let recent_pcash_block_hash = CircuitWord::from(r.take_array::<32>()?);
    let valid_until_timestamp = r.take_u64()?;

    let authorization = if mode == 0 {
        AccountCreationAuthorization::DirectL1
    } else {
        let sig_r = CircuitWord::from(r.take_array::<32>()?);
        let sig_s = CircuitWord::from(r.take_array::<32>()?);
        let y_parity = match r.take_u8()? {
            0 => false,
            1 => true,
            parity => return Err(ParseError::UnknownYParity(parity)),
        };
        AccountCreationAuthorization::Eip712 {
            sig_r,
            sig_s,
            y_parity,
        }
    };

    Ok(UserAccountCreation::new(
        nullifier_key_commitment,
        rule_set_commitment,
        receive_key,
        recent_pcash_block_hash,
        valid_until_timestamp,
        authorization,
    ))
}

fn encode_user_account_creation(w: &mut Writer, creation: &UserAccountCreation) {
    w.u8(match creation.authorization {
        AccountCreationAuthorization::DirectL1 => 0,
        AccountCreationAuthorization::Eip712 { .. } => 1,
    });
    w.bytes(creation.nullifier_key_commitment.as_slice());
    w.bytes(creation.rule_set_commitment.as_slice());
    encode_receive_key(w, creation.receive_key.as_ref());
    w.bytes(creation.recent_pcash_block_hash.as_slice());
    w.u64(creation.valid_until_timestamp);

    if let AccountCreationAuthorization::Eip712 {
        sig_r,
        sig_s,
        y_parity,
    } = &creation.authorization
    {
        w.bytes(sig_r.as_slice());
        w.bytes(sig_s.as_slice());
        w.u8(u8::from(*y_parity));
    }
}

fn decode_user_account_update(
    r: &mut Reader<'_>,
    pcash_chain_id: u32,
) -> Result<UserAccountUpdate, ParseError> {
    let address = Address::from(r.take_array::<20>()?);
    let new_rule_set_commitment = CircuitWord::from(r.take_array::<32>()?);
    let receive_key_update = match r.take_u8()? {
        RECEIVE_KEY_UPDATE_KEEP => ReceiveKeyUpdate::Keep,
        RECEIVE_KEY_UPDATE_CLEAR => ReceiveKeyUpdate::Clear,
        RECEIVE_KEY_UPDATE_REPLACE => ReceiveKeyUpdate::Replace(take_receive_key(r)?),
        mode => return Err(ParseError::UnknownReceiveKeyMode(mode)),
    };
    let account_update_commitment = CircuitWord::from(r.take_array::<32>()?);
    let section =
        decode_private_value_section(r, pcash_chain_id, SectionLayout::UserAccountUpdate)?;
    Ok(UserAccountUpdate {
        address,
        new_rule_set_commitment,
        receive_key_update,
        account_update_commitment,
        section,
    })
}

fn encode_user_account_update(w: &mut Writer, update: &UserAccountUpdate) {
    w.bytes(update.address.as_slice());
    w.bytes(update.new_rule_set_commitment.as_slice());
    match &update.receive_key_update {
        ReceiveKeyUpdate::Keep => w.u8(RECEIVE_KEY_UPDATE_KEEP),
        ReceiveKeyUpdate::Clear => w.u8(RECEIVE_KEY_UPDATE_CLEAR),
        ReceiveKeyUpdate::Replace(key) => {
            w.u8(RECEIVE_KEY_UPDATE_REPLACE);
            w.bytes(key.as_slice());
        }
    }
    w.bytes(update.account_update_commitment.as_slice());
    encode_private_value_section(w, &update.section, SectionLayout::UserAccountUpdate);
}

fn decode_contract_body(r: &mut Reader<'_>) -> Result<ContractBody, ParseError> {
    let publishes_nk_root = match r.take_u8()? {
        0 => false,
        1 => true,
        flag => return Err(ParseError::UnknownPublishesNkRootFlag(flag)),
    };
    let nullifier_key_material = CircuitWord::from(r.take_array::<32>()?);
    let receive_key = decode_receive_key(r)?;

    let function_count = r.take_u8()? as usize;
    let mut functions = Vec::with_capacity(function_count);
    for _ in 0..function_count {
        let selector = r.take_u8()?;
        let application_vk_hash = B256::from(r.take_array::<32>()?);
        let configuration_commitment = B256::from(r.take_array::<32>()?);
        functions.push(ContractFunction {
            selector,
            application_vk_hash,
            configuration_commitment,
        });
    }

    Ok(ContractBody {
        publishes_nk_root,
        nullifier_key_material,
        receive_key,
        functions,
    })
}

fn encode_contract_body(w: &mut Writer, body: &ContractBody) -> Result<(), EncodeError> {
    w.u8(u8::from(body.publishes_nk_root));
    w.bytes(body.nullifier_key_material.as_slice());
    encode_receive_key(w, body.receive_key.as_ref());

    w.len_u8("function count", body.functions.len())?;
    for function in &body.functions {
        w.u8(function.selector);
        w.bytes(function.application_vk_hash.as_slice());
        w.bytes(function.configuration_commitment.as_slice());
    }
    Ok(())
}

/// A bounded lifetime followed by the unsigned body.
fn decode_contract_account_creation(
    r: &mut Reader<'_>,
) -> Result<ContractAccountCreation, ParseError> {
    let recent_pcash_block_hash = CircuitWord::from(r.take_array::<32>()?);
    let valid_until_timestamp = r.take_u64()?;
    let body = decode_contract_body(r)?;
    Ok(ContractAccountCreation {
        body,
        recent_pcash_block_hash,
        valid_until_timestamp,
    })
}

fn encode_contract_account_creation(
    w: &mut Writer,
    creation: &ContractAccountCreation,
) -> Result<(), EncodeError> {
    w.bytes(creation.recent_pcash_block_hash.as_slice());
    w.u64(creation.valid_until_timestamp);
    encode_contract_body(w, &creation.body)
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "tests use direct assertions"
)]
mod tests {
    use super::*;

    fn vectors() -> serde_json::Value {
        serde_json::from_str(include_str!("../../../../vectors/protocol_vectors.json"))
            .expect("parse published protocol vectors")
    }

    fn hex_bytes(value: &serde_json::Value) -> Vec<u8> {
        hex::decode(value.as_str().unwrap().strip_prefix("0x").unwrap()).unwrap()
    }

    fn word(value: &serde_json::Value) -> B256 {
        value.as_str().unwrap().parse::<B256>().unwrap()
    }

    fn field(value: &serde_json::Value) -> Fr {
        pcash_state::fr_from_internal_word(word(value))
    }

    #[test]
    fn output_data_hash_matches_published_vector() {
        let vector = &vectors()["outputDataHash"];
        let output_data = hex_bytes(&vector["outputData"]);
        assert_eq!(output_data.len(), OUTPUT_DATA_BYTES);
        assert_eq!(
            fr_to_bytes(output_data_hash(&output_data)),
            word(&vector["value"])
        );
    }

    #[test]
    fn arena_hash_matches_published_vector() {
        let vector = &vectors()["arenaHash"];
        let arena = hex_bytes(&vector["arena"]);
        assert_eq!(arena.len(), PrivateValueShape::S.profile().arena_bytes);
        assert_eq!(fr_to_bytes(arena_hash(&arena)), word(&vector["value"]));
    }

    #[test]
    fn delivery_commitment_matches_published_vector() {
        let vector = &vectors()["deliveryCommitment"];
        let hashes = vector["outputDataHashes"].as_array().unwrap();
        assert_eq!(hashes.len(), PrivateValueShape::S.profile().outputs);
        assert_eq!(
            fr_to_bytes(delivery_commitment(
                hashes.iter().map(field),
                field(&vector["arenaHash"])
            )),
            word(&vector["value"])
        );
    }
}
