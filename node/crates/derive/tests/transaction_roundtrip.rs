#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "tests use direct assertions for fixture setup"
)]
//! Transaction codec tests: frozen byte layouts, every structural edge case,
//! and encode/decode round trips for every transaction type and contract
//! funding mode.
//!
//! A round trip alone cannot catch the encoder and decoder agreeing on a wrong
//! layout, so the frozen tests place every field at a literal offset and the
//! cross-check tests compare against the independent byte builders in
//! `common`.

mod common;
use common::*;

use std::cmp::Ordering;

use alloy_primitives::Address;
use pcash_derive::params::private_value_tx_bytes;
use pcash_derive::private_value_profiles::PrivateValueShape;
use pcash_derive::{
    contract_funding_mode, AccountCreationAuthorization, ContractAccountCreation, ContractBody,
    ContractFunction, ContractFunding, ContractFundingMode, EncodeError, ParseError,
    PrivateValueSection, ReceiveKey, ReceiveKeyUpdate, SectionLayout, Transaction,
    UserAccountCreation, UserAccountUpdate, ACCOUNT_MAX_TX_BYTES, CONTRACT_MAX_BODY_BYTES,
    CONTRACT_MAX_TX_BYTES, FUNDING_MODE_OFFSET, ML_KEM768_PUBLIC_KEY_LEN, OUTPUT_DATA_BYTES,
    USER_ACCOUNT_UPDATE_MAX_TX_BYTES,
};
use pcash_state::CircuitWord;

const S: PrivateValueShape = PrivateValueShape::S;
const L: PrivateValueShape = PrivateValueShape::L;
const KEY_LEN: usize = ML_KEM768_PUBLIC_KEY_LEN;
const PV_S: SectionLayout = SectionLayout::PrivateValue(S);
const PV_L: SectionLayout = SectionLayout::PrivateValue(L);
const UPDATE: SectionLayout = SectionLayout::UserAccountUpdate;
const CONTRACT: SectionLayout = SectionLayout::ContractAccountCreation;
const LAYOUTS: [SectionLayout; 4] = [PV_S, PV_L, UPDATE, CONTRACT];
const OTHER_CHAIN_ID: u32 = PCASH_CHAIN_ID + 1;
/// Where a contract body starts: after the envelope, the funding mode, and
/// the mode's fixed-size payload.
const UNFUNDED_BODY: usize = 46;
const SPONSORED_BODY: usize = 31_615;

/// [`assert_roundtrip_on`] the test network.
#[track_caller]
fn assert_roundtrip(transaction: &Transaction) -> Vec<u8> {
    assert_roundtrip_on(transaction, PCASH_CHAIN_ID)
}

/// Both directions under `pcash_chain_id`: `decode(encode(t)) == t` and
/// `encode(decode(b)) == b`.
#[track_caller]
fn assert_roundtrip_on(transaction: &Transaction, pcash_chain_id: u32) -> Vec<u8> {
    let bytes = transaction.encode(pcash_chain_id).unwrap();
    let decoded =
        Transaction::decode(&bytes, pcash_chain_id).expect("an encoded transaction decodes");
    assert!(
        decoded == *transaction,
        "decode(encode(transaction)) differs from transaction"
    );
    assert!(
        decoded.encode(pcash_chain_id).unwrap() == bytes,
        "encode(decode(bytes)) differs"
    );
    bytes
}

/// `encode(transaction) == expected` and `decode(expected) == transaction`,
/// reporting the first differing offset rather than both buffers.
#[track_caller]
fn assert_frozen(transaction: &Transaction, expected: &[u8]) {
    let actual = transaction.encode(PCASH_CHAIN_ID).unwrap();
    let first_difference = actual.iter().zip(expected).position(|(a, e)| a != e);
    assert!(
        actual == expected,
        "encoded {} bytes, expected {}, first difference at {first_difference:?}",
        actual.len(),
        expected.len()
    );
    let decoded = Transaction::decode(expected, PCASH_CHAIN_ID).expect("the frozen bytes decode");
    assert!(
        decoded == *transaction,
        "the frozen bytes decode to another transaction"
    );
}

/// Expected bytes assembled by hand: each field goes at a literal offset, and
/// `done` requires the fields to tile the buffer exactly.
struct Layout {
    bytes: Vec<u8>,
    written: Vec<bool>,
}

impl Layout {
    fn new(len: usize) -> Self {
        Self {
            bytes: vec![0; len],
            written: vec![false; len],
        }
    }

    fn put(mut self, offset: usize, field: &[u8]) -> Self {
        for (i, byte) in field.iter().enumerate() {
            assert!(
                !self.written[offset + i],
                "offset {} written twice",
                offset + i
            );
            self.written[offset + i] = true;
            self.bytes[offset + i] = *byte;
        }
        self
    }

    fn done(self) -> Vec<u8> {
        let gap = self.written.iter().position(|written| !written);
        assert_eq!(gap, None, "layout leaves a byte unwritten");
        self.bytes
    }
}

/// The semantic fields of a private-value section, named as the spec names them.
struct Words {
    recent: CircuitWord,
    nullifiers: Vec<CircuitWord>,
    bodies: Vec<CircuitWord>,
    open_fee: CircuitWord,
    issuance_owner: CircuitWord,
    not_before: CircuitWord,
    valid_until: CircuitWord,
    carrier_context_hash: CircuitWord,
    events_commitment: CircuitWord,
}

impl Words {
    /// Distinct canonical words for every field of `shape`.
    fn distinct(shape: PrivateValueShape) -> Self {
        let profile = shape.profile();
        Self {
            recent: tagged_word(0x01, 1),
            nullifiers: (0..profile.inputs as u64)
                .map(|i| tagged_word(0x02, i))
                .collect(),
            bodies: (0..profile.outputs as u64)
                .map(|i| tagged_word(0x03, i))
                .collect(),
            open_fee: tagged_word(0x04, 7),
            issuance_owner: tagged_word(0x05, 8),
            not_before: word(9),
            valid_until: word(10),
            carrier_context_hash: tagged_word(0x07, 12),
            events_commitment: tagged_word(0x06, 11),
        }
    }

    /// The serialized order: every field except the derived ones.
    fn wire(&self) -> Vec<CircuitWord> {
        let mut wire = vec![self.recent];
        wire.extend_from_slice(&self.nullifiers);
        wire.extend_from_slice(&self.bodies);
        wire.extend([
            self.open_fee,
            self.issuance_owner,
            self.not_before,
            self.valid_until,
            self.carrier_context_hash,
            self.events_commitment,
        ]);
        wire
    }
}

/// A section of `shape` with exactly these words, proof, output data, and
/// arena.
fn section_of(
    shape: PrivateValueShape,
    pcash_chain_id: u32,
    words: &Words,
    proof: &[u8],
    output_data: &[Vec<u8>],
    arena: &[u8],
) -> PrivateValueSection {
    PrivateValueSection::new(
        shape,
        pcash_chain_id,
        &words.wire(),
        proof.to_vec(),
        output_data.to_vec(),
        arena.to_vec(),
    )
    .unwrap()
}

/// Position-dependent bytes, so a field read at a shifted offset or with the
/// wrong length does not match.
fn patterned(len: usize, tag: u8) -> Vec<u8> {
    (0..len)
        .map(|i| tag ^ (i as u8) ^ ((i >> 8) as u8))
        .collect()
}

/// A proof of exactly the size `layout` fixes.
fn full_proof(layout: SectionLayout, tag: u8) -> Vec<u8> {
    patterned(layout.proof_bytes(), tag)
}

/// One distinct `OUTPUT_DATA_BYTES` item per output slot of `shape`.
fn full_output_data(shape: PrivateValueShape) -> Vec<Vec<u8>> {
    (0..shape.profile().outputs)
        .map(|slot| patterned(OUTPUT_DATA_BYTES, 0x40 + slot as u8))
        .collect()
}

/// An arena of exactly the size `shape` fixes.
fn full_arena(shape: PrivateValueShape) -> Vec<u8> {
    patterned(shape.profile().arena_bytes, 0x60)
}

/// A section of `layout` with distinct words.
fn section(layout: SectionLayout) -> PrivateValueSection {
    let shape = layout.shape();
    PrivateValueSection::new(
        shape,
        PCASH_CHAIN_ID,
        &Words::distinct(shape).wire(),
        full_proof(layout, 0xa0),
        full_output_data(shape),
        full_arena(shape),
    )
    .unwrap()
}

fn key() -> ReceiveKey {
    Box::new(<[u8; KEY_LEN]>::try_from(patterned(KEY_LEN, 0x4b)).unwrap())
}

fn signature() -> AccountCreationAuthorization {
    AccountCreationAuthorization::Eip712 {
        sig_r: tagged_word(0x0b, 1),
        sig_s: tagged_word(0x0c, 2),
        y_parity: true,
    }
}

fn creation(
    receive_key: Option<ReceiveKey>,
    authorization: AccountCreationAuthorization,
) -> UserAccountCreation {
    UserAccountCreation::new(
        tagged_word(0x06, 1),
        tagged_word(0x07, 2),
        receive_key,
        tagged_word(0x08, 3),
        0x0102_0304_0506_0708,
        authorization,
    )
}

fn update(
    receive_key_update: ReceiveKeyUpdate,
    mut section: PrivateValueSection,
) -> UserAccountUpdate {
    let issuance_owner = section.shape().profile().issuance_owner_offset;
    *section.public_input_mut(issuance_owner).unwrap() = CircuitWord::ZERO;
    UserAccountUpdate {
        address: addr(0x5678),
        new_rule_set_commitment: tagged_word(0x09, 4),
        receive_key_update,
        account_update_commitment: tagged_word(0x0a, 5),
        section,
    }
}

fn function(selector: u8) -> ContractFunction {
    ContractFunction {
        selector,
        application_vk_hash: tagged_word(0x0d, u64::from(selector)),
        configuration_commitment: tagged_word(0x0e, u64::from(selector)),
    }
}

fn contract_body(
    publishes_nk_root: bool,
    receive_key: Option<ReceiveKey>,
    functions: Vec<ContractFunction>,
) -> ContractBody {
    ContractBody {
        publishes_nk_root,
        nullifier_key_material: tagged_word(0x0f, 6),
        receive_key,
        functions,
    }
}

fn sponsored(body: ContractBody, mut section: PrivateValueSection) -> Transaction {
    let issuance_owner = section.shape().profile().issuance_owner_offset;
    *section.public_input_mut(issuance_owner).unwrap() = CircuitWord::ZERO;
    Transaction::ContractAccountCreation(ContractAccountCreation {
        body,
        funding: ContractFunding::Sponsored(section),
    })
}

fn unfunded_with(
    body: ContractBody,
    recent_pcash_block_hash: CircuitWord,
    valid_until_timestamp: u64,
) -> Transaction {
    Transaction::ContractAccountCreation(ContractAccountCreation {
        body,
        funding: ContractFunding::Unfunded {
            recent_pcash_block_hash,
            valid_until_timestamp,
        },
    })
}

fn unfunded(body: ContractBody) -> Transaction {
    unfunded_with(body, tagged_word(0x08, 3), 0x1112_1314_1516_1718)
}

/// Where the body of a contract creation's encoding starts.
fn body_offset(transaction: &Transaction) -> usize {
    let Transaction::ContractAccountCreation(creation) = transaction else {
        panic!("type {:#04x} has no contract body", transaction.kind())
    };
    match creation.funding {
        ContractFunding::Unfunded { .. } => UNFUNDED_BODY,
        ContractFunding::Sponsored(_) => SPONSORED_BODY,
    }
}

/// A transaction that carries a section of `layout`.
fn carrier(layout: SectionLayout, section: PrivateValueSection) -> Transaction {
    match layout {
        SectionLayout::PrivateValue(_) => Transaction::PrivateValue(section),
        SectionLayout::UserAccountUpdate => {
            Transaction::UserAccountUpdate(update(ReceiveKeyUpdate::Keep, section))
        }
        SectionLayout::ContractAccountCreation => {
            sponsored(contract_body(false, None, vec![function(1)]), section)
        }
    }
}

fn carried_section(transaction: &Transaction) -> &PrivateValueSection {
    match transaction {
        Transaction::PrivateValue(section) => section,
        Transaction::UserAccountUpdate(update) => &update.section,
        Transaction::ContractAccountCreation(ContractAccountCreation {
            funding: ContractFunding::Sponsored(section),
            ..
        }) => section,
        _ => panic!("type {:#04x} carries no section", transaction.kind()),
    }
}

// ---- frozen layouts -------------------------------------------------------

#[test]
fn private_value_s_layout_is_frozen() {
    let words = Words::distinct(S);
    let proof = full_proof(PV_S, 0xd0);
    let output_data = full_output_data(S);
    let arena = full_arena(S);
    let transaction = Transaction::PrivateValue(section_of(
        S,
        PCASH_CHAIN_ID,
        &words,
        &proof,
        &output_data,
        &arena,
    ));

    let expected = Layout::new(31_647)
        .put(0, &[0x00])
        .put(1, &PCASH_CHAIN_ID.to_be_bytes())
        .put(5, &[0x00])
        .put(6, words.recent.as_slice())
        .put(38, words.nullifiers[0].as_slice())
        .put(70, words.nullifiers[1].as_slice())
        .put(102, words.nullifiers[2].as_slice())
        .put(134, words.nullifiers[3].as_slice())
        .put(166, words.bodies[0].as_slice())
        .put(198, words.bodies[1].as_slice())
        .put(230, words.bodies[2].as_slice())
        .put(262, words.bodies[3].as_slice())
        .put(294, words.bodies[4].as_slice())
        .put(326, words.open_fee.as_slice())
        .put(358, words.issuance_owner.as_slice())
        .put(390, words.not_before.as_slice())
        .put(422, words.valid_until.as_slice())
        .put(454, words.carrier_context_hash.as_slice())
        .put(486, words.events_commitment.as_slice())
        .put(518, &proof)
        .put(22_950, &output_data[0])
        .put(24_163, &output_data[1])
        .put(25_376, &output_data[2])
        .put(26_589, &output_data[3])
        .put(27_802, &output_data[4])
        .put(29_015, &arena)
        .done();

    assert_frozen(&transaction, &expected);
}

#[test]
fn private_value_l_layout_is_frozen() {
    let words = Words::distinct(L);
    let proof = full_proof(PV_L, 0xca);
    let output_data = full_output_data(L);
    let arena = full_arena(L);
    let transaction = Transaction::PrivateValue(section_of(
        L,
        PCASH_CHAIN_ID,
        &words,
        &proof,
        &output_data,
        &arena,
    ));

    let mut expected = Layout::new(80_198)
        .put(0, &[0x00])
        .put(1, &PCASH_CHAIN_ID.to_be_bytes())
        .put(5, &[0x01])
        .put(6, words.recent.as_slice());
    for i in 0..32 {
        expected = expected
            .put(38 + 32 * i, words.nullifiers[i].as_slice())
            .put(1_062 + 32 * i, words.bodies[i].as_slice());
    }
    expected = expected
        .put(2_086, words.open_fee.as_slice())
        .put(2_118, words.issuance_owner.as_slice())
        .put(2_150, words.not_before.as_slice())
        .put(2_182, words.valid_until.as_slice())
        .put(2_214, words.carrier_context_hash.as_slice())
        .put(2_246, words.events_commitment.as_slice())
        .put(2_278, &proof);
    for (slot, data) in output_data.iter().enumerate() {
        expected = expected.put(24_710 + 1_213 * slot, data);
    }
    expected = expected.put(63_526, &arena);

    assert_frozen(&transaction, &expected.done());
}

#[test]
fn user_account_creation_layouts_are_frozen() {
    let timestamp = [1, 2, 3, 4, 5, 6, 7, 8];

    let signed_with_key = Layout::new(1_360)
        .put(0, &[0x01])
        .put(1, &PCASH_CHAIN_ID.to_be_bytes())
        .put(5, &[0x01])
        .put(6, tagged_word(0x06, 1).as_slice())
        .put(38, tagged_word(0x07, 2).as_slice())
        .put(70, &[0x01])
        .put(71, key().as_slice())
        .put(1_255, tagged_word(0x08, 3).as_slice())
        .put(1_287, &timestamp)
        .put(1_295, tagged_word(0x0b, 1).as_slice())
        .put(1_327, tagged_word(0x0c, 2).as_slice())
        .put(1_359, &[0x01])
        .done();
    assert_frozen(
        &Transaction::UserAccountCreation(creation(Some(key()), signature())),
        &signed_with_key,
    );

    let signed_without_key = Layout::new(176)
        .put(0, &[0x01])
        .put(1, &PCASH_CHAIN_ID.to_be_bytes())
        .put(5, &[0x01])
        .put(6, tagged_word(0x06, 1).as_slice())
        .put(38, tagged_word(0x07, 2).as_slice())
        .put(70, &[0x00])
        .put(71, tagged_word(0x08, 3).as_slice())
        .put(103, &timestamp)
        .put(111, tagged_word(0x0b, 1).as_slice())
        .put(143, tagged_word(0x0c, 2).as_slice())
        .put(175, &[0x00])
        .done();
    let even = AccountCreationAuthorization::Eip712 {
        sig_r: tagged_word(0x0b, 1),
        sig_s: tagged_word(0x0c, 2),
        y_parity: false,
    };
    assert_frozen(
        &Transaction::UserAccountCreation(creation(None, even)),
        &signed_without_key,
    );

    let direct_with_key = Layout::new(1_295)
        .put(0, &[0x01])
        .put(1, &PCASH_CHAIN_ID.to_be_bytes())
        .put(5, &[0x00])
        .put(6, tagged_word(0x06, 1).as_slice())
        .put(38, tagged_word(0x07, 2).as_slice())
        .put(70, &[0x01])
        .put(71, key().as_slice())
        .put(1_255, tagged_word(0x08, 3).as_slice())
        .put(1_287, &timestamp)
        .done();
    assert_frozen(
        &Transaction::UserAccountCreation(creation(
            Some(key()),
            AccountCreationAuthorization::DirectL1,
        )),
        &direct_with_key,
    );

    let direct_without_key = Layout::new(111)
        .put(0, &[0x01])
        .put(1, &PCASH_CHAIN_ID.to_be_bytes())
        .put(5, &[0x00])
        .put(6, tagged_word(0x06, 1).as_slice())
        .put(38, tagged_word(0x07, 2).as_slice())
        .put(70, &[0x00])
        .put(71, tagged_word(0x08, 3).as_slice())
        .put(103, &timestamp)
        .done();
    assert_frozen(
        &Transaction::UserAccountCreation(creation(None, AccountCreationAuthorization::DirectL1)),
        &direct_without_key,
    );
}

#[test]
fn user_account_update_layout_is_frozen() {
    let words = Words::distinct(S);
    let proof = full_proof(UPDATE, 0x99);
    let output_data = full_output_data(S);
    let arena = full_arena(S);
    let fee = section_of(S, PCASH_CHAIN_ID, &words, &proof, &output_data, &arena);
    let transaction = Transaction::UserAccountUpdate(update(ReceiveKeyUpdate::Replace(key()), fee));

    let expected = Layout::new(32_883)
        .put(0, &[0x03])
        .put(1, &PCASH_CHAIN_ID.to_be_bytes())
        .put(5, addr(0x5678).as_slice())
        .put(25, tagged_word(0x09, 4).as_slice())
        .put(57, &[0x02])
        .put(58, key().as_slice())
        .put(1_242, tagged_word(0x0a, 5).as_slice())
        .put(1_274, words.recent.as_slice())
        .put(1_306, words.nullifiers[0].as_slice())
        .put(1_338, words.nullifiers[1].as_slice())
        .put(1_370, words.nullifiers[2].as_slice())
        .put(1_402, words.nullifiers[3].as_slice())
        .put(1_434, words.bodies[0].as_slice())
        .put(1_466, words.bodies[1].as_slice())
        .put(1_498, words.bodies[2].as_slice())
        .put(1_530, words.bodies[3].as_slice())
        .put(1_562, words.bodies[4].as_slice())
        .put(1_594, words.open_fee.as_slice())
        .put(1_626, words.not_before.as_slice())
        .put(1_658, words.valid_until.as_slice())
        .put(1_690, words.carrier_context_hash.as_slice())
        .put(1_722, words.events_commitment.as_slice())
        .put(1_754, &proof)
        .put(24_186, &output_data[0])
        .put(25_399, &output_data[1])
        .put(26_612, &output_data[2])
        .put(27_825, &output_data[3])
        .put(29_038, &output_data[4])
        .put(30_251, &arena)
        .done();

    assert_frozen(&transaction, &expected);
}

#[test]
fn contract_creation_layouts_are_frozen() {
    assert_eq!(SPONSORED_BODY, 6 + CONTRACT.section_bytes());
    let functions = || vec![function(0x07), function(0xfe)];
    // The envelope and funding mode, then the mode's payload, then the body at
    // `at`. A receive key moves everything after it by its length.
    let layout = |len: usize, mode: u8, at: usize, flag: u8, key: Option<&[u8]>| {
        let shift = key.map_or(0, <[u8]>::len);
        let layout = Layout::new(len)
            .put(0, &[0x02])
            .put(1, &PCASH_CHAIN_ID.to_be_bytes())
            .put(5, &[mode])
            .put(at, &[flag])
            .put(at + 1, tagged_word(0x0f, 6).as_slice());
        let layout = match key {
            None => layout.put(at + 33, &[0x00]),
            Some(key) => layout.put(at + 33, &[0x01]).put(at + 34, key),
        };
        layout
            .put(at + 34 + shift, &[0x02])
            .put(at + 35 + shift, &[0x07])
            .put(at + 36 + shift, tagged_word(0x0d, 0x07).as_slice())
            .put(at + 68 + shift, tagged_word(0x0e, 0x07).as_slice())
            .put(at + 100 + shift, &[0xfe])
            .put(at + 101 + shift, tagged_word(0x0d, 0xfe).as_slice())
            .put(at + 133 + shift, tagged_word(0x0e, 0xfe).as_slice())
    };

    let words = Words::distinct(S);
    let proof = full_proof(CONTRACT, 0x77);
    let output_data = full_output_data(S);
    let arena = full_arena(S);
    let section = section_of(S, PCASH_CHAIN_ID, &words, &proof, &output_data, &arena);
    let transaction = sponsored(contract_body(true, None, functions()), section);
    let expected = layout(31_780, 0x01, 31_615, 0x01, None)
        .put(6, words.recent.as_slice())
        .put(38, words.nullifiers[0].as_slice())
        .put(70, words.nullifiers[1].as_slice())
        .put(102, words.nullifiers[2].as_slice())
        .put(134, words.nullifiers[3].as_slice())
        .put(166, words.bodies[0].as_slice())
        .put(198, words.bodies[1].as_slice())
        .put(230, words.bodies[2].as_slice())
        .put(262, words.bodies[3].as_slice())
        .put(294, words.bodies[4].as_slice())
        .put(326, words.open_fee.as_slice())
        .put(358, words.not_before.as_slice())
        .put(390, words.valid_until.as_slice())
        .put(422, words.carrier_context_hash.as_slice())
        .put(454, words.events_commitment.as_slice())
        .put(486, &proof)
        .put(22_918, &output_data[0])
        .put(24_131, &output_data[1])
        .put(25_344, &output_data[2])
        .put(26_557, &output_data[3])
        .put(27_770, &output_data[4])
        .put(28_983, &arena)
        .done();
    assert_frozen(&transaction, &expected);

    let deadline = [0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18];
    let transaction = unfunded(contract_body(true, None, functions()));
    let expected = layout(211, 0x00, 46, 0x01, None)
        .put(6, tagged_word(0x08, 3).as_slice())
        .put(38, &deadline)
        .done();
    assert_frozen(&transaction, &expected);

    let transaction = unfunded(contract_body(false, Some(key()), functions()));
    let expected = layout(1_395, 0x00, 46, 0x00, Some(key().as_slice()))
        .put(6, tagged_word(0x08, 3).as_slice())
        .put(38, &deadline)
        .done();
    assert_frozen(&transaction, &expected);
}

// ---- cross-checks against the independent builders in `common` ------------

#[test]
fn encoder_matches_the_hand_written_private_value_builders() {
    for shape in [S, L] {
        let words = Words::distinct(shape);
        let output_data = full_output_data(shape);
        let proof = full_proof(SectionLayout::PrivateValue(shape), 0x12);
        let literal = section_of(
            shape,
            PCASH_CHAIN_ID,
            &words,
            &proof,
            &output_data,
            &dummy_arena(shape),
        );
        let data: Vec<&[u8]> = output_data.iter().map(Vec::as_slice).collect();
        let built = profile_txbytes(shape, &literal.public_inputs(), &literal.proof, &data);

        assert_frozen(&Transaction::PrivateValue(literal), &built);
    }

    let proof = stub_proof(PV_S, &[]);
    let literal = section_of(
        S,
        PCASH_CHAIN_ID,
        &Words::distinct(S),
        &proof,
        &vec![DUMMY_OUTPUT_DATA.to_vec(); 5],
        &dummy_arena(S),
    );
    let built = transfer_txbytes(
        &literal.public_inputs(),
        &proof,
        &[DUMMY_OUTPUT_DATA.as_slice(); 5],
    );
    assert_frozen(&Transaction::PrivateValue(literal), &built);
}

#[test]
fn encoder_matches_the_hand_written_account_builders() {
    for receive_key in [None, Some(key())] {
        let built = account_txbytes(
            tagged_word(0x06, 1),
            tagged_word(0x07, 2),
            receive_key.as_deref().map(<[u8; KEY_LEN]>::as_slice),
            tagged_word(0x08, 3),
            0x0102_0304_0506_0708,
            tagged_word(0x0b, 1),
            tagged_word(0x0c, 2),
            1,
        );
        let transaction = Transaction::UserAccountCreation(creation(receive_key, signature()));
        assert_frozen(&transaction, &built);
    }

    let fee = section_of(
        S,
        PCASH_CHAIN_ID,
        &Words::distinct(S),
        &full_proof(UPDATE, 0x07),
        &full_output_data(S),
        &dummy_arena(S),
    );
    let data: Vec<&[u8]> = fee.output_data().iter().map(Vec::as_slice).collect();
    let fee_bytes = private_value_section(&fee.public_inputs(), &fee.proof, &data);
    for receive_key_update in [
        ReceiveKeyUpdate::Keep,
        ReceiveKeyUpdate::Clear,
        ReceiveKeyUpdate::Replace(key()),
    ] {
        let built = account_update_txbytes(
            addr(0x5678),
            tagged_word(0x09, 4),
            receive_key_update.clone(),
            tagged_word(0x0a, 5),
            &fee_bytes,
        );
        let transaction = Transaction::UserAccountUpdate(update(receive_key_update, fee.clone()));
        assert_frozen(&transaction, &built);
    }
}

#[test]
fn encoder_matches_the_hand_written_contract_builders() {
    let functions = vec![function(0x07), function(0xfe)];
    for receive_key in [None, Some(key())] {
        let mut body = vec![0x01];
        body.extend_from_slice(tagged_word(0x0f, 6).as_slice());
        match &receive_key {
            None => body.push(0x00),
            Some(key) => {
                body.push(0x01);
                body.extend_from_slice(key.as_slice());
            }
        }
        body.push(2);
        for function in &functions {
            body.push(function.selector);
            body.extend_from_slice(function.application_vk_hash.as_slice());
            body.extend_from_slice(function.configuration_commitment.as_slice());
        }
        let contract = || contract_body(true, receive_key.clone(), functions.clone());

        assert_frozen(
            &unfunded(contract()),
            &unfunded_contract_txbytes(&body, tagged_word(0x08, 3), 0x1112_1314_1516_1718),
        );

        let section = section_of(
            S,
            PCASH_CHAIN_ID,
            &Words::distinct(S),
            &full_proof(CONTRACT, 0x07),
            &full_output_data(S),
            &dummy_arena(S),
        );
        let data: Vec<&[u8]> = section.output_data().iter().map(Vec::as_slice).collect();
        let section_bytes = private_value_section(&section.public_inputs(), &section.proof, &data);
        assert_frozen(
            &sponsored(contract(), section),
            &sponsored_contract_txbytes(&body, &section_bytes),
        );
    }
}

// ---- edge cases -----------------------------------------------------------

#[test]
fn every_type_round_trips_at_the_chain_id_extremes() {
    for pcash_chain_id in [0, 1, u32::MAX] {
        let fee = |layout: SectionLayout| {
            let shape = layout.shape();
            PrivateValueSection::new(
                shape,
                pcash_chain_id,
                &Words::distinct(shape).wire(),
                full_proof(layout, 1),
                full_output_data(shape),
                full_arena(shape),
            )
            .unwrap()
        };
        let body = || contract_body(false, None, vec![function(1)]);
        for transaction in [
            Transaction::PrivateValue(fee(PV_S)),
            Transaction::PrivateValue(fee(PV_L)),
            Transaction::UserAccountCreation(creation(
                None,
                AccountCreationAuthorization::DirectL1,
            )),
            Transaction::UserAccountUpdate(update(ReceiveKeyUpdate::Keep, fee(UPDATE))),
            sponsored(body(), fee(CONTRACT)),
            unfunded_with(body(), word(1), 2),
        ] {
            let bytes = assert_roundtrip_on(&transaction, pcash_chain_id);
            assert_eq!(bytes[1..5], pcash_chain_id.to_be_bytes());
            assert_eq!(
                Transaction::decode(&bytes, pcash_chain_id.wrapping_add(1)),
                Err(ParseError::WrongChainId(pcash_chain_id))
            );
        }
    }
}

#[test]
fn private_value_words_are_preserved_raw() {
    for shape in [S, L] {
        let layout = SectionLayout::PrivateValue(shape);
        let profile = shape.profile();
        for filler in [0x00, 0xff] {
            // 0xff..ff is above the field modulus: decoding must keep it for
            // ordered execution to reject, not normalize or refuse it.
            let wire = vec![CircuitWord::repeat_byte(filler); profile.wire_inputs];
            let raw = PrivateValueSection::new(
                shape,
                PCASH_CHAIN_ID,
                &wire,
                full_proof(layout, 0),
                full_output_data(shape),
                full_arena(shape),
            )
            .unwrap();
            let bytes = assert_roundtrip(&Transaction::PrivateValue(raw));
            let Ok(Transaction::PrivateValue(decoded)) =
                Transaction::decode(&bytes, PCASH_CHAIN_ID)
            else {
                panic!("private value");
            };
            assert_eq!(decoded.public_inputs().len(), profile.public_inputs);
            for (index, word) in decoded.public_inputs().iter().enumerate() {
                let derived = index == 0 || index == profile.delivery_commitment_offset;
                if !derived {
                    assert_eq!(
                        *word,
                        CircuitWord::repeat_byte(filler),
                        "public input {index}"
                    );
                }
            }
        }

        // Distinct words: a late L slot cannot be confused with an early one.
        let words = Words::distinct(shape);
        let distinct = section(layout);
        assert_eq!(
            distinct.public_inputs()[profile.recent_block_hash_offset],
            words.recent
        );
        assert_eq!(
            distinct.public_inputs()[profile.nullifiers_offset..profile.outputs_offset],
            words.nullifiers[..]
        );
        assert_eq!(
            distinct.public_inputs()[profile.outputs_offset..profile.delivery_commitment_offset],
            words.bodies[..]
        );
        assert_eq!(
            distinct.public_inputs()[profile.open_fee_amount_offset],
            words.open_fee
        );
        assert_eq!(
            distinct.public_inputs()[profile.issuance_owner_offset],
            words.issuance_owner
        );
        assert_eq!(
            distinct.public_inputs()[profile.not_before_offset],
            words.not_before
        );
        assert_eq!(
            distinct.public_inputs()[profile.valid_until_offset],
            words.valid_until
        );
        assert_eq!(
            distinct.public_inputs()[profile.carrier_context_hash_offset],
            words.carrier_context_hash
        );
        assert_eq!(
            distinct.public_inputs()[profile.public_inputs - 1],
            words.events_commitment
        );
        assert_roundtrip(&Transaction::PrivateValue(distinct));
    }
}

/// The enclosing layout fixes the proof size, every item is
/// `OUTPUT_DATA_BYTES`, and the profile fixes the arena size, so a section
/// decodes at exactly one size.
#[test]
fn each_section_layout_decodes_only_at_its_exact_size() {
    // Items carry no length, so this size alone places every item boundary.
    assert_eq!(OUTPUT_DATA_BYTES, 1_213);
    // (layout, bytes of its carrier outside the section, section bytes)
    for (layout, outside, section_bytes) in [
        (PV_S, 6, 31_641),
        (PV_L, 6, 80_192),
        (UPDATE, 90, 31_609),
        // Envelope and funding mode, then a 100-byte body after the section.
        (CONTRACT, 106, 31_609),
    ] {
        let shape = layout.shape();
        let profile = shape.profile();
        assert_eq!(layout.section_bytes(), section_bytes);

        let exact = assert_roundtrip(&carrier(layout, section(layout)));
        assert_eq!(exact.len(), outside + section_bytes);
        if let SectionLayout::PrivateValue(shape) = layout {
            assert_eq!(exact.len(), private_value_tx_bytes(shape));
        }
        let decoded = Transaction::decode(&exact, PCASH_CHAIN_ID).unwrap();
        let decoded = carried_section(&decoded);
        assert_eq!(decoded.proof.len(), layout.proof_bytes());
        assert!(decoded
            .output_data()
            .iter()
            .all(|data| data.len() == OUTPUT_DATA_BYTES));
        assert_eq!(decoded.arena(), full_arena(shape));
        let data: Vec<&[u8]> = decoded.output_data().iter().map(Vec::as_slice).collect();
        assert_eq!(
            decoded.public_inputs()[profile.delivery_commitment_offset],
            delivery_commitment_word(&data, decoded.arena()),
        );

        let mut trailing = exact;
        trailing.push(0);
        assert_eq!(
            Transaction::decode(&trailing, PCASH_CHAIN_ID).err(),
            Some(ParseError::Trailing)
        );

        // The encoder writes whatever sizes it is given; these are the bytes
        // a wrongly sized proof, item, or arena produces. A section that ends
        // its item is then truncated or trailed; a contract creation's body
        // follows its section and is read from shifted bytes, failing on
        // whichever body field it misreads.
        let misframed =
            |proof: Vec<u8>, output_data: Vec<Vec<u8>>, arena: Vec<u8>, expected: ParseError| {
                let altered = PrivateValueSection::new(
                    shape,
                    PCASH_CHAIN_ID,
                    &Words::distinct(shape).wire(),
                    proof,
                    output_data,
                    arena,
                )
                .unwrap();
                let bytes = carrier(layout, altered).encode(PCASH_CHAIN_ID).unwrap();
                let error = Transaction::decode(&bytes, PCASH_CHAIN_ID).err();
                if layout == CONTRACT {
                    assert!(error.is_some(), "{layout:?}");
                } else {
                    assert_eq!(error, Some(expected), "{layout:?}");
                }
            };
        let proof_bytes = layout.proof_bytes();
        misframed(
            vec![0; proof_bytes - 1],
            full_output_data(shape),
            full_arena(shape),
            ParseError::Truncated,
        );
        misframed(
            vec![0; proof_bytes + 1],
            full_output_data(shape),
            full_arena(shape),
            ParseError::Trailing,
        );
        for slot in [0, profile.outputs - 1] {
            let mut short = full_output_data(shape);
            let mut bytes = short[slot].clone();
            bytes.pop();
            short[slot] = bytes;
            misframed(
                full_proof(layout, 0),
                short,
                full_arena(shape),
                ParseError::Truncated,
            );
            let mut long = full_output_data(shape);
            let mut bytes = long[slot].clone();
            bytes.push(0);
            long[slot] = bytes;
            misframed(
                full_proof(layout, 0),
                long,
                full_arena(shape),
                ParseError::Trailing,
            );
        }
        let mut short_arena = full_arena(shape);
        short_arena.pop();
        misframed(
            full_proof(layout, 0),
            full_output_data(shape),
            short_arena,
            ParseError::Truncated,
        );
        let mut long_arena = full_arena(shape);
        long_arena.push(0);
        misframed(
            full_proof(layout, 0),
            full_output_data(shape),
            long_arena,
            ParseError::Trailing,
        );

        // A proof of the size another layout fixes misframes this section.
        for other in LAYOUTS {
            let other_bytes = other.proof_bytes();
            let expected = match other_bytes.cmp(&proof_bytes) {
                Ordering::Less => ParseError::Truncated,
                Ordering::Greater => ParseError::Trailing,
                Ordering::Equal => continue,
            };
            misframed(
                vec![0; other_bytes],
                full_output_data(shape),
                full_arena(shape),
                expected,
            );
        }
        // The other profile's arena misframes this section.
        let other_arena = match shape {
            S => full_arena(L),
            L => full_arena(S),
        };
        let expected = if other_arena.len() < profile.arena_bytes {
            ParseError::Truncated
        } else {
            ParseError::Trailing
        };
        misframed(
            full_proof(layout, 0),
            full_output_data(shape),
            other_arena,
            expected,
        );
    }
}

#[test]
fn user_account_creation_edge_cases_round_trip() {
    for receive_key in [None, Some(key())] {
        for authorization in [AccountCreationAuthorization::DirectL1, signature()] {
            let key_bytes = if receive_key.is_some() { KEY_LEN } else { 0 };
            let signature_bytes = match authorization {
                AccountCreationAuthorization::DirectL1 => 0,
                AccountCreationAuthorization::Eip712 { .. } => 65,
            };
            let transaction = Transaction::UserAccountCreation(creation(
                receive_key.clone(),
                authorization.clone(),
            ));
            let bytes = assert_roundtrip(&transaction);
            assert_eq!(bytes.len(), 111 + key_bytes + signature_bytes);
        }
    }

    for y_parity in [false, true] {
        for filler in [0x00, 0xff] {
            let authorization = AccountCreationAuthorization::Eip712 {
                sig_r: CircuitWord::repeat_byte(filler),
                sig_s: CircuitWord::repeat_byte(filler),
                y_parity,
            };
            let bytes = assert_roundtrip(&Transaction::UserAccountCreation(creation(
                None,
                authorization,
            )));
            assert_eq!(bytes[175], u8::from(y_parity));
        }
    }

    for valid_until_timestamp in [0, u64::MAX] {
        for filler in [0x00, 0xff] {
            let mut creation = creation(Some(key()), signature());
            creation.valid_until_timestamp = valid_until_timestamp;
            creation.nullifier_key_commitment = CircuitWord::repeat_byte(filler);
            creation.rule_set_commitment = CircuitWord::repeat_byte(filler);
            creation.recent_pcash_block_hash = CircuitWord::repeat_byte(filler);
            assert_roundtrip(&Transaction::UserAccountCreation(creation));
        }
    }

    let largest = assert_roundtrip(&Transaction::UserAccountCreation(creation(
        Some(key()),
        signature(),
    )));
    assert_eq!(largest.len(), ACCOUNT_MAX_TX_BYTES);
}

#[test]
fn user_account_update_edge_cases_round_trip() {
    for (receive_key_update, operation, key_bytes) in [
        (ReceiveKeyUpdate::Keep, 0, 0),
        (ReceiveKeyUpdate::Clear, 1, 0),
        (ReceiveKeyUpdate::Replace(key()), 2, KEY_LEN),
    ] {
        let transaction =
            Transaction::UserAccountUpdate(update(receive_key_update, section(UPDATE)));
        let bytes = assert_roundtrip(&transaction);
        assert_eq!(bytes[57], operation);
        // envelope 5, address 20, rule set 32, operation 1 + key, action 32,
        // then the section.
        assert_eq!(bytes.len(), 90 + key_bytes + UPDATE.section_bytes());
    }

    for filler in [0x00, 0xff] {
        let mut update = update(ReceiveKeyUpdate::Keep, section(UPDATE));
        update.address = Address::repeat_byte(filler);
        update.new_rule_set_commitment = CircuitWord::repeat_byte(filler);
        update.account_update_commitment = CircuitWord::repeat_byte(filler);
        assert_roundtrip(&Transaction::UserAccountUpdate(update));
    }

    let largest = assert_roundtrip(&Transaction::UserAccountUpdate(update(
        ReceiveKeyUpdate::Replace(key()),
        section(UPDATE),
    )));
    assert_eq!(largest.len(), USER_ACCOUNT_UPDATE_MAX_TX_BYTES);
}

#[test]
fn contract_creation_edge_cases_round_trip() {
    let all_selectors = || (0..=254u8).map(function).collect::<Vec<_>>();
    let function_sets = [
        Vec::new(),
        vec![function(0)],
        // Unordered and duplicated selectors are execution failures, so the
        // codec must carry them unchanged.
        vec![function(5), function(5), function(0)],
        all_selectors(),
    ];

    for publishes_nk_root in [false, true] {
        for functions in &function_sets {
            for receive_key in [None, Some(key())] {
                let key_bytes = if receive_key.is_some() { KEY_LEN } else { 0 };
                let body =
                    || contract_body(publishes_nk_root, receive_key.clone(), functions.clone());
                let body_len = 35 + key_bytes + 65 * functions.len();

                for (transaction, mode, payload) in [
                    (unfunded(body()), ContractFundingMode::Unfunded, 40),
                    (
                        sponsored(body(), section(CONTRACT)),
                        ContractFundingMode::Sponsored,
                        CONTRACT.section_bytes(),
                    ),
                ] {
                    let bytes = assert_roundtrip(&transaction);
                    assert_eq!(bytes.len(), 6 + payload + body_len);
                    assert_eq!(bytes[FUNDING_MODE_OFFSET], mode as u8);
                    assert_eq!(contract_funding_mode(&bytes), Some(mode));
                    let body_at = body_offset(&transaction);
                    assert_eq!(body_at, 6 + payload);
                    assert_eq!(bytes[body_at], u8::from(publishes_nk_root));
                    assert_eq!(bytes[body_at + 33], u8::from(receive_key.is_some()));
                }
            }
        }
    }

    for valid_until_timestamp in [0, u64::MAX] {
        for filler in [0x00, 0xff] {
            let mut body = contract_body(true, None, vec![function(9)]);
            body.nullifier_key_material = CircuitWord::repeat_byte(filler);
            body.functions[0].application_vk_hash = CircuitWord::repeat_byte(filler);
            body.functions[0].configuration_commitment = CircuitWord::repeat_byte(filler);
            let bytes = assert_roundtrip(&unfunded_with(
                body,
                CircuitWord::repeat_byte(filler),
                valid_until_timestamp,
            ));
            assert_eq!(bytes[38..46], valid_until_timestamp.to_be_bytes());
        }
    }

    let largest_body = || contract_body(true, Some(key()), all_selectors());
    let largest = assert_roundtrip(&unfunded(largest_body()));
    assert_eq!(largest.len(), 17_840);
    assert_eq!(largest.len() - UNFUNDED_BODY, CONTRACT_MAX_BODY_BYTES);
    let largest = assert_roundtrip(&sponsored(largest_body(), section(CONTRACT)));
    assert_eq!(largest.len(), CONTRACT_MAX_TX_BYTES);
    assert_eq!(largest.len() - SPONSORED_BODY, CONTRACT_MAX_BODY_BYTES);
}

/// The funding byte names its mode without decoding, and only for a contract
/// creation.
#[test]
fn contract_funding_mode_reads_only_the_mode_byte() {
    let body = || contract_body(false, None, vec![function(1)]);
    let unfunded = unfunded(body()).encode(PCASH_CHAIN_ID).unwrap();
    let sponsored = sponsored(body(), section(CONTRACT))
        .encode(PCASH_CHAIN_ID)
        .unwrap();
    assert_eq!(
        contract_funding_mode(&unfunded),
        Some(ContractFundingMode::Unfunded)
    );
    assert_eq!(
        contract_funding_mode(&sponsored),
        Some(ContractFundingMode::Sponsored)
    );
    // The six-byte prefix decides it, whatever follows.
    assert_eq!(
        contract_funding_mode(&sponsored[..=FUNDING_MODE_OFFSET]),
        Some(ContractFundingMode::Sponsored)
    );
    assert_eq!(
        contract_funding_mode(&unfunded[..FUNDING_MODE_OFFSET]),
        None
    );
    for mode in 2..=u8::MAX {
        let mut unknown = unfunded.clone();
        unknown[FUNDING_MODE_OFFSET] = mode;
        assert_eq!(contract_funding_mode(&unknown), None);
        assert_eq!(ContractFundingMode::from_wire_byte(mode), None);
    }
    let account_update =
        Transaction::UserAccountUpdate(update(ReceiveKeyUpdate::Keep, section(UPDATE)))
            .encode(PCASH_CHAIN_ID)
            .unwrap();
    assert_eq!(contract_funding_mode(&account_update), None);
}

// ---- constructors ---------------------------------------------------------

#[test]
fn constructors_build_the_form_decoding_returns() {
    for shape in [S, L] {
        let words = Words::distinct(shape);
        let proof = full_proof(SectionLayout::PrivateValue(shape), 0x45);
        let output_data = full_output_data(shape);
        let arena = full_arena(shape);
        assert_eq!(
            PrivateValueSection::new(
                shape,
                PCASH_CHAIN_ID,
                &words.wire(),
                proof.clone(),
                output_data.clone(),
                arena.clone(),
            )
            .unwrap(),
            section_of(shape, PCASH_CHAIN_ID, &words, &proof, &output_data, &arena)
        );
    }

    for receive_key in [None, Some(key())] {
        for publishes_nk_root in [false, true] {
            let body = ContractBody::new(
                publishes_nk_root,
                tagged_word(0x0f, 6),
                receive_key.clone(),
                vec![function(3)],
            )
            .unwrap();
            assert_eq!(
                body,
                contract_body(publishes_nk_root, receive_key.clone(), vec![function(3)])
            );
            assert_roundtrip(&unfunded(body.clone()));
            assert_roundtrip(&sponsored(body, section(CONTRACT)));
        }
    }
}

#[test]
fn derived_section_words_are_recomputed_by_decoding() {
    // The chain-ID word comes from the network and is not written, so a
    // section that disagrees with it decodes to the one that agrees.
    for layout in LAYOUTS {
        let profile = layout.shape().profile();
        let mut altered = section(layout);
        *altered.public_input_mut(profile.chain_id_offset).unwrap() = word(0xdead);
        let bytes = carrier(layout, altered).encode(PCASH_CHAIN_ID).unwrap();
        let decoded = Transaction::decode(&bytes, PCASH_CHAIN_ID);
        assert!(
            decoded == Ok(carrier(layout, section(layout))),
            "{layout:?}"
        );
    }
}

// ---- transactions with no encoding -----------------------------------------

fn dimension(field: &'static str, expected: usize, actual: usize) -> EncodeError {
    EncodeError::Dimension {
        field,
        expected,
        actual,
    }
}

#[test]
fn proof_sections_require_their_profile_dimensions() {
    for shape in [S, L] {
        let profile = shape.profile();
        let wire = Words::distinct(shape).wire();
        let proof = full_proof(SectionLayout::PrivateValue(shape), 0);
        let slots = full_output_data(shape);
        let arena = full_arena(shape);
        let section = PrivateValueSection::new(
            shape,
            PCASH_CHAIN_ID,
            &wire,
            proof.clone(),
            slots.clone(),
            arena.clone(),
        )
        .unwrap();
        assert_eq!(section.public_inputs().len(), profile.public_inputs);
        assert_roundtrip(&Transaction::PrivateValue(section));

        for len in [0, profile.wire_inputs - 1, profile.wire_inputs + 1] {
            let mut words = wire.clone();
            words.resize(len, word(1));
            assert_eq!(
                PrivateValueSection::new(
                    shape,
                    PCASH_CHAIN_ID,
                    &words,
                    proof.clone(),
                    slots.clone(),
                    arena.clone(),
                )
                .err(),
                Some(dimension("wire inputs", profile.wire_inputs, len))
            );
        }
        for len in [0, profile.outputs - 1, profile.outputs + 1] {
            let output_data = vec![vec![0; OUTPUT_DATA_BYTES]; len];
            assert_eq!(
                PrivateValueSection::new(
                    shape,
                    PCASH_CHAIN_ID,
                    &wire,
                    proof.clone(),
                    output_data,
                    arena.clone(),
                )
                .err(),
                Some(dimension("output data", profile.outputs, len))
            );
        }
    }
}

#[test]
fn function_count_must_fit_its_prefix_byte() {
    let functions = |count: usize| (0..count).map(|i| function(i as u8)).collect::<Vec<_>>();

    let body = ContractBody::new(false, word(1), None, functions(255)).unwrap();
    let bytes = assert_roundtrip(&unfunded(body.clone()));
    assert_eq!(bytes[UNFUNDED_BODY + 34], 255);
    let bytes = assert_roundtrip(&sponsored(body, section(CONTRACT)));
    assert_eq!(bytes[SPONSORED_BODY + 34], 255);

    // 256 functions would wrap the count byte to zero and leave 256 records
    // of trailing bytes.
    let error = EncodeError::PrefixOverflow {
        field: "function count",
        max: 255,
        actual: 256,
    };
    assert_eq!(
        ContractBody::new(false, word(1), None, functions(256)),
        Err(error.clone())
    );
    let body = contract_body(false, None, functions(256));
    assert_eq!(
        unfunded(body.clone()).encode(PCASH_CHAIN_ID).err(),
        Some(error.clone())
    );
    assert_eq!(
        sponsored(body, section(CONTRACT))
            .encode(PCASH_CHAIN_ID)
            .err(),
        Some(error)
    );
}

// ---- decoder exactness ----------------------------------------------------

/// One instance of every layout and every optional field.
fn transactions_of_every_layout() -> Vec<Transaction> {
    let with_key = || contract_body(true, Some(key()), vec![function(1), function(2)]);
    let without_key = || contract_body(false, None, vec![function(1)]);
    vec![
        Transaction::PrivateValue(section(PV_S)),
        Transaction::PrivateValue(section(PV_L)),
        Transaction::UserAccountCreation(creation(None, AccountCreationAuthorization::DirectL1)),
        Transaction::UserAccountCreation(creation(
            Some(key()),
            AccountCreationAuthorization::DirectL1,
        )),
        Transaction::UserAccountCreation(creation(None, signature())),
        Transaction::UserAccountCreation(creation(Some(key()), signature())),
        Transaction::UserAccountUpdate(update(ReceiveKeyUpdate::Keep, section(UPDATE))),
        Transaction::UserAccountUpdate(update(ReceiveKeyUpdate::Clear, section(UPDATE))),
        Transaction::UserAccountUpdate(update(ReceiveKeyUpdate::Replace(key()), section(UPDATE))),
        sponsored(with_key(), section(CONTRACT)),
        sponsored(without_key(), section(CONTRACT)),
        unfunded(with_key()),
        unfunded(without_key()),
    ]
}

/// A closed-set selector byte: its offset in an encoding, the smallest value
/// outside its set, and the error a value outside the set gives.
type Selector = (usize, u8, fn(u8) -> ParseError);

/// Every closed-set selector in the `len`-byte encoding of `transaction`.
fn selectors(transaction: &Transaction, len: usize) -> Vec<Selector> {
    let mut out = vec![(0, 4, ParseError::UnknownKind as fn(u8) -> ParseError)];
    match transaction {
        Transaction::PrivateValue(_) => out.push((5, 2, ParseError::UnknownPrivateValueShape)),
        Transaction::UserAccountCreation(creation) => {
            out.push((5, 2, ParseError::UnknownAuthorizationMode));
            out.push((70, 2, ParseError::UnknownReceiveKeyMode));
            if creation.authorization != AccountCreationAuthorization::DirectL1 {
                out.push((len - 1, 2, ParseError::UnknownYParity));
            }
        }
        Transaction::UserAccountUpdate(_) => out.push((57, 3, ParseError::UnknownReceiveKeyMode)),
        Transaction::ContractAccountCreation(_) => {
            let body = body_offset(transaction);
            out.push((FUNDING_MODE_OFFSET, 2, ParseError::UnknownFundingMode));
            out.push((body, 2, ParseError::UnknownPublishesNkRootFlag));
            out.push((body + 33, 2, ParseError::UnknownReceiveKeyMode));
        }
    }
    out
}

#[test]
fn every_encoding_has_exactly_one_valid_length() {
    assert_eq!(
        Transaction::decode(&[], PCASH_CHAIN_ID),
        Err(ParseError::Empty)
    );
    for transaction in transactions_of_every_layout() {
        let bytes = assert_roundtrip(&transaction);
        for len in 1..bytes.len() {
            let prefix = &bytes[..len];
            assert_eq!(
                Transaction::decode(prefix, PCASH_CHAIN_ID).err(),
                Some(ParseError::Truncated),
                "type {:#04x} prefix {len} of {}",
                bytes[0],
                bytes.len()
            );
            // A complete foreign envelope excludes the item before its payload.
            let foreign = if len < 5 {
                ParseError::Truncated
            } else {
                ParseError::WrongChainId(PCASH_CHAIN_ID)
            };
            assert_eq!(
                Transaction::decode(prefix, OTHER_CHAIN_ID).err(),
                Some(foreign),
                "type {:#04x} prefix {len} under another chain",
                bytes[0]
            );
        }
        let mut extended = bytes;
        extended.push(0);
        assert_eq!(
            Transaction::decode(&extended, PCASH_CHAIN_ID).err(),
            Some(ParseError::Trailing)
        );
    }
}

#[test]
fn every_selector_outside_its_set_is_a_decode_error() {
    for transaction in transactions_of_every_layout() {
        let bytes = transaction.encode(PCASH_CHAIN_ID).unwrap();
        for (offset, first_invalid, error) in selectors(&transaction, bytes.len()) {
            assert!(bytes[offset] < first_invalid, "byte {offset} is a selector");
            for value in [first_invalid, first_invalid + 1, 0x40, 0xff] {
                let mut altered = bytes.clone();
                altered[offset] = value;
                assert_eq!(
                    Transaction::decode(&altered, PCASH_CHAIN_ID).err(),
                    Some(error(value)),
                    "type {:#04x}, byte {offset} = {value}",
                    bytes[0]
                );
                assert_eq!(
                    Transaction::decode(&altered, OTHER_CHAIN_ID).err(),
                    Some(ParseError::WrongChainId(PCASH_CHAIN_ID)),
                    "type {:#04x}, byte {offset} = {value} under another chain",
                    bytes[0]
                );
            }
        }
    }
    // An unassigned type is read only from a complete same-chain envelope.
    for kind in [4, 5, 0x40, 0xff] {
        let envelope = [&[kind][..], &PCASH_CHAIN_ID.to_be_bytes()].concat();
        assert_eq!(
            Transaction::decode(&envelope, PCASH_CHAIN_ID),
            Err(ParseError::UnknownKind(kind))
        );
        assert_eq!(
            Transaction::decode(&envelope, OTHER_CHAIN_ID),
            Err(ParseError::WrongChainId(PCASH_CHAIN_ID))
        );
        for len in 1..5 {
            assert_eq!(
                Transaction::decode(&envelope[..len], PCASH_CHAIN_ID),
                Err(ParseError::Truncated)
            );
        }
    }
}

/// A mode fixes whether its field follows: neither value reads the other's
/// layout.
#[test]
fn a_mode_byte_fixes_whether_its_field_follows() {
    let encode = |creation: UserAccountCreation| {
        Transaction::UserAccountCreation(creation)
            .encode(PCASH_CHAIN_ID)
            .unwrap()
    };
    let decode = |bytes: &[u8]| Transaction::decode(bytes, PCASH_CHAIN_ID).err();
    let direct = || creation(None, AccountCreationAuthorization::DirectL1);

    let mut bytes = encode(direct());
    bytes[5] = 1;
    assert_eq!(decode(&bytes), Some(ParseError::Truncated));
    let mut bytes = encode(creation(None, signature()));
    bytes[5] = 0;
    assert_eq!(decode(&bytes), Some(ParseError::Trailing));

    let mut bytes = encode(direct());
    bytes[70] = 1;
    assert_eq!(decode(&bytes), Some(ParseError::Truncated));
    let mut bytes = encode(creation(
        Some(key()),
        AccountCreationAuthorization::DirectL1,
    ));
    bytes[70] = 0;
    assert_eq!(decode(&bytes), Some(ParseError::Trailing));

    let encode = |receive_key_update| {
        Transaction::UserAccountUpdate(update(receive_key_update, section(UPDATE)))
            .encode(PCASH_CHAIN_ID)
            .unwrap()
    };
    let mut bytes = encode(ReceiveKeyUpdate::Keep);
    bytes[57] = 2;
    assert_eq!(decode(&bytes), Some(ParseError::Truncated));
    let mut bytes = encode(ReceiveKeyUpdate::Replace(key()));
    bytes[57] = 0;
    assert_eq!(decode(&bytes), Some(ParseError::Trailing));

    // An unfunded payload is too short to be read as a section. A section
    // read as an unfunded payload leaves its later words to be read as the
    // body; these words give a body with no receive key and no functions,
    // and the rest of the section trails it.
    let body = || contract_body(false, None, vec![function(1)]);
    let mut bytes = unfunded(body()).encode(PCASH_CHAIN_ID).unwrap();
    bytes[FUNDING_MODE_OFFSET] = 1;
    assert_eq!(decode(&bytes), Some(ParseError::Truncated));
    let mut bytes = sponsored(body(), section(CONTRACT))
        .encode(PCASH_CHAIN_ID)
        .unwrap();
    bytes[FUNDING_MODE_OFFSET] = 0;
    assert_eq!(decode(&bytes), Some(ParseError::Trailing));
}

// ---- seeded generation ----------------------------------------------------

/// splitmix64: deterministic, so a failing case reproduces from its index.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }

    fn pick<T: Copy>(&mut self, choices: &[T]) -> T {
        choices[(self.next() % choices.len() as u64) as usize]
    }

    fn coin(&mut self) -> bool {
        self.next().is_multiple_of(2)
    }

    /// Any 32 bytes, including values above the field modulus.
    fn word(&mut self) -> CircuitWord {
        let mut out = [0u8; 32];
        for chunk in out.chunks_mut(8) {
            chunk.copy_from_slice(&self.next().to_be_bytes());
        }
        CircuitWord::from(out)
    }

    fn address(&mut self) -> Address {
        Address::from_slice(&self.word()[..20])
    }

    /// Filler for a fixed-size field: one random value, with random bytes at
    /// both ends.
    fn filler(&mut self, len: usize) -> Vec<u8> {
        let mut out = vec![self.next() as u8; len];
        for byte in out.iter_mut().take(8) {
            *byte = self.next() as u8;
        }
        for byte in out.iter_mut().rev().take(8) {
            *byte = self.next() as u8;
        }
        out
    }

    fn key(&mut self) -> ReceiveKey {
        Box::new(<[u8; KEY_LEN]>::try_from(self.filler(KEY_LEN)).unwrap())
    }

    fn receive_key(&mut self) -> Option<ReceiveKey> {
        if self.coin() {
            Some(self.key())
        } else {
            None
        }
    }

    fn section(&mut self, layout: SectionLayout, pcash_chain_id: u32) -> PrivateValueSection {
        let shape = layout.shape();
        let profile = shape.profile();
        let wire: Vec<CircuitWord> = (0..profile.wire_inputs).map(|_| self.word()).collect();
        let proof = self.filler(layout.proof_bytes());
        let output_data = (0..profile.outputs)
            .map(|_| self.filler(OUTPUT_DATA_BYTES))
            .collect();
        let arena = self.filler(profile.arena_bytes);
        let mut section =
            PrivateValueSection::new(shape, pcash_chain_id, &wire, proof, output_data, arena)
                .unwrap();
        if layout.omits_issuance_owner() {
            *section
                .public_input_mut(profile.issuance_owner_offset)
                .unwrap() = CircuitWord::ZERO;
        }
        section
    }

    fn body(&mut self) -> ContractBody {
        let publishes_nk_root = self.coin();
        let nullifier_key_material = self.word();
        let receive_key = self.receive_key();
        let function_count = self.pick(&[0, 1, 2, 6, 255]);
        let functions = (0..function_count)
            .map(|_| ContractFunction {
                selector: self.next() as u8,
                application_vk_hash: self.word(),
                configuration_commitment: self.word(),
            })
            .collect();
        ContractBody {
            publishes_nk_root,
            nullifier_key_material,
            receive_key,
            functions,
        }
    }

    /// A transaction whose sections belong to the network `pcash_chain_id`.
    fn transaction(&mut self, pcash_chain_id: u32) -> Transaction {
        match self.next() % 5 {
            0 => {
                let shape = self.pick(&[S, S, S, L]);
                Transaction::PrivateValue(
                    self.section(SectionLayout::PrivateValue(shape), pcash_chain_id),
                )
            }
            1 => {
                let authorization = if self.coin() {
                    AccountCreationAuthorization::DirectL1
                } else {
                    AccountCreationAuthorization::Eip712 {
                        sig_r: self.word(),
                        sig_s: self.word(),
                        y_parity: self.coin(),
                    }
                };
                Transaction::UserAccountCreation(UserAccountCreation::new(
                    self.word(),
                    self.word(),
                    self.receive_key(),
                    self.word(),
                    self.next(),
                    authorization,
                ))
            }
            2 => {
                let receive_key_update = match self.next() % 3 {
                    0 => ReceiveKeyUpdate::Keep,
                    1 => ReceiveKeyUpdate::Clear,
                    _ => ReceiveKeyUpdate::Replace(self.key()),
                };
                let section = self.section(UPDATE, pcash_chain_id);
                Transaction::UserAccountUpdate(UserAccountUpdate {
                    address: self.address(),
                    new_rule_set_commitment: self.word(),
                    receive_key_update,
                    account_update_commitment: self.word(),
                    section,
                })
            }
            3 => {
                let section = self.section(CONTRACT, pcash_chain_id);
                Transaction::ContractAccountCreation(ContractAccountCreation {
                    body: self.body(),
                    funding: ContractFunding::Sponsored(section),
                })
            }
            _ => Transaction::ContractAccountCreation(ContractAccountCreation {
                funding: ContractFunding::Unfunded {
                    recent_pcash_block_hash: self.word(),
                    valid_until_timestamp: self.next(),
                },
                body: self.body(),
            }),
        }
    }
}

#[test]
fn generated_transactions_round_trip() {
    let mut rng = Rng(0x5043_4153_4845_4e43);
    let mut seen = [0usize; 5];
    for case in 0..3_000 {
        let pcash_chain_id = rng.next() as u32;
        let transaction = rng.transaction(pcash_chain_id);
        // Types 0 to 3, with a sponsored contract creation counted as 4.
        let variant = match &transaction {
            Transaction::ContractAccountCreation(ContractAccountCreation {
                funding: ContractFunding::Sponsored(_),
                ..
            }) => 4,
            _ => usize::from(transaction.kind()),
        };
        seen[variant] += 1;
        let bytes = transaction.encode(pcash_chain_id).unwrap();
        let decoded = Transaction::decode(&bytes, pcash_chain_id);
        assert!(
            decoded.as_ref() == Ok(&transaction),
            "case {case}: decode(encode) differs"
        );
        assert!(
            decoded.unwrap().encode(pcash_chain_id).unwrap() == bytes,
            "case {case}: encode(decode) differs"
        );

        // Any value outside a selector's set makes the encoding undecodable.
        for (offset, first_invalid, error) in selectors(&transaction, bytes.len()) {
            let value = first_invalid + (rng.next() % u64::from(u8::MAX - first_invalid + 1)) as u8;
            let mut altered = bytes.clone();
            altered[offset] = value;
            assert_eq!(
                Transaction::decode(&altered, pcash_chain_id).err(),
                Some(error(value)),
                "case {case}: byte {offset} = {value}"
            );
        }
    }
    assert!(
        seen.iter().all(|count| *count > 100),
        "every type is generated: {seen:?}"
    );
}
