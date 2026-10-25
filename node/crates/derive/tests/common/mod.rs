//! Shared test helpers: batch and transaction builders, a scripted stub
//! verifier, L1 block construction, item results, and field-word utilities.
#![allow(
    dead_code,
    reason = "helpers are shared selectively across integration tests"
)]
#![allow(
    clippy::unreadable_literal,
    clippy::many_single_char_names,
    reason = "test-vector constants and cryptographic helper parameters mirror protocol notation"
)]

use alloy_primitives::{Address, Bytes, B256};
use pcash_derive::private_value_profiles::PrivateValueShape;
use pcash_derive::{
    admit, validate_transactions, AdmittedTransaction, Batch, BatchVersion, BlockOutcome,
    CarrierContext, ContractBodyCheck, DeriveError, ForkActivation, ItemExclusionReason,
    ProtocolRules, SectionLayout, BASE_BATCH_VERSIONS, KIND_CONTRACT_ACCOUNT_CREATION,
    KIND_PRIVATE_VALUE, KIND_USER_ACCOUNT_CREATION, KIND_USER_ACCOUNT_UPDATE,
    ML_KEM768_PUBLIC_KEY_LEN, OUTPUT_DATA_BYTES,
};
use pcash_l1::{L1BlockData, L1Header, L1Log, L1Receipt, L1Tx};
use pcash_state::{CircuitWord, Codec, StateDb, TransactionOutcome};
use pcash_verify::{Verifier, VerifyError};
use sha3::{Digest, Keccak256};

pub const L1_CHAIN_ID: u64 = 11155111; // Sepolia
pub const PCASH_CHAIN_ID: u32 = 1346589512;
pub const DUMMY_OUTPUT_DATA: [u8; OUTPUT_DATA_BYTES] = [1; OUTPUT_DATA_BYTES];
/// The byte that fills every arena the builders below attach.
pub const DUMMY_ARENA_BYTE: u8 = 2;

/// The arena the builders below attach to a section of `shape`.
pub fn dummy_arena(shape: PrivateValueShape) -> Vec<u8> {
    vec![DUMMY_ARENA_BYTE; shape.profile().arena_bytes]
}

/// An ML-KEM-768 receive key filled with `byte`.
pub fn receive_key(byte: u8) -> pcash_derive::ReceiveKey {
    Box::new([byte; ML_KEM768_PUBLIC_KEY_LEN])
}

/// A stub proof of the layout's pinned size: `seed`, then zeros.
pub fn stub_proof(layout: SectionLayout, seed: &[u8]) -> Vec<u8> {
    assert!(seed.len() <= layout.proof_bytes());
    let mut proof = seed.to_vec();
    proof.resize(layout.proof_bytes(), 0);
    proof
}

/// What derivation made of one framed item: an admitted transaction's
/// outcome, or the reason the item was excluded.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ItemResult {
    Admitted(TransactionOutcome),
    Excluded(ItemExclusionReason),
}

/// A successful admitted transaction.
pub const SUCCEEDED: ItemResult = ItemResult::Admitted(TransactionOutcome::Succeeded);

/// Every framed item's result in canonical order, read from the committed
/// delivery manifest and transaction results.
pub fn item_results(outcome: &BlockOutcome) -> Vec<ItemResult> {
    let boundary = &outcome.committed_boundary;
    let mut results = boundary.block.transaction_results.iter();
    boundary
        .history
        .l1_delivery_batches
        .iter()
        .flat_map(|batch| &batch.items)
        .map(|item| match item.exclusion_reason {
            Some(reason) => ItemResult::Excluded(reason),
            None => ItemResult::Admitted(
                results
                    .next()
                    .expect("one result per admitted item")
                    .outcome,
            ),
        })
        .collect()
}

/// Admit ordered raw items at `current_timestamp` on the state's network and
/// validate the admitted ones against one non-committing overlay, as the
/// items of an Inbox carrier sent by `l1_sender`.
pub fn validate_raw_items<S: StateDb, V: Verifier, T: AsRef<[u8]>>(
    state: &S,
    rules: &ProtocolRules,
    verifier: &V,
    current_timestamp: u64,
    l1_sender: Address,
    items: &[T],
) -> Result<Vec<ItemResult>, DeriveError> {
    let chain_id = state.derivation_source().pcash_chain_id;
    let admissions = items
        .iter()
        .map(|raw| {
            admit(
                raw.as_ref(),
                rules,
                chain_id,
                current_timestamp,
                pcash_l1::CarrierKind::Inbox,
            )
        })
        .collect::<Vec<_>>();
    let admitted = admissions
        .iter()
        .filter_map(|admission| admission.as_ref().ok())
        .collect::<Vec<_>>();
    let mut outcomes = validate_transactions(
        state,
        rules,
        verifier,
        current_timestamp,
        Some(CarrierContext::inbox(l1_sender)),
        &admitted,
    )?
    .into_iter();
    Ok(admissions
        .iter()
        .map(|admission| match admission {
            Ok(_) => ItemResult::Admitted(outcomes.next().expect("one outcome per transaction")),
            Err(error) => ItemResult::Excluded(error.reason()),
        })
        .collect())
}

/// Admit and validate one raw item against the supplied state snapshot.
pub fn validate_raw_item<S: StateDb, V: Verifier>(
    state: &S,
    rules: &ProtocolRules,
    verifier: &V,
    current_timestamp: u64,
    l1_sender: Address,
    raw: &[u8],
) -> Result<ItemResult, DeriveError> {
    Ok(validate_raw_items(state, rules, verifier, current_timestamp, l1_sender, &[raw])?.remove(0))
}

/// A digest of everything one derived block committed: its header hash plus
/// the per-transaction effects and canonical history stored beside it.
pub fn committed_digest(outcome: &BlockOutcome) -> (B256, B256) {
    let boundary = &outcome.committed_boundary;
    let mut stored = pcash_state::codec::encode_list(&outcome.transaction_effects);
    stored.extend(boundary.history.encode());
    (boundary.block.hash, keccak(&stored))
}

/// A checked-in [`committed_digest`] expectation.
pub fn frozen_digest(block_hash: &str, stored: &str) -> (B256, B256) {
    (block_hash.parse().unwrap(), stored.parse().unwrap())
}

/// A verifier that returns a fixed scripted verdict for every call, and counts
/// how many times it was invoked.
pub struct StubVerifier {
    pub result: Result<bool, ()>,
    pub calls: std::cell::Cell<usize>,
}

impl StubVerifier {
    pub fn accept() -> Self {
        Self {
            result: Ok(true),
            calls: std::cell::Cell::new(0),
        }
    }
    pub fn reject() -> Self {
        Self {
            result: Ok(false),
            calls: std::cell::Cell::new(0),
        }
    }
}

impl Verifier for StubVerifier {
    fn verify(&self, _vk: &[u8], _proof: &[u8], _pi: &[u8]) -> Result<bool, VerifyError> {
        self.calls.set(self.calls.get() + 1);
        match self.result {
            Ok(b) => Ok(b),
            Err(()) => Err(VerifyError::Abnormal {
                exit: "signal".into(),
                stdout: String::new(),
                stderr: "stub tool failure".into(),
            }),
        }
    }
}

// ---- field words ----------------------------------------------------------

/// A canonical field word holding the small integer `v` (always `< p`).
pub fn word(v: u64) -> CircuitWord {
    let mut w = [0u8; 32];
    w[24..].copy_from_slice(&v.to_be_bytes());
    CircuitWord::from(w)
}

/// The field element of a canonical test word.
pub fn field_element(word: CircuitWord) -> pcash_state::Fr {
    pcash_state::fr_from_canonical_bytes(word).expect("test word is canonical")
}

/// A distinct canonical field word from a 1-byte high tag and a low value. The
/// high byte is kept `<= 0x2f` so the word is always `< p` (p's top byte is 0x30).
pub fn tagged_word(tag: u8, v: u64) -> CircuitWord {
    assert!(tag <= 0x2f);
    let mut w = word(v).0;
    w[0] = tag;
    CircuitWord::from(w)
}

pub fn addr(n: u64) -> Address {
    let mut b = [0u8; 20];
    b[12..].copy_from_slice(&n.to_be_bytes());
    Address::from(b)
}

pub fn keccak(bytes: &[u8]) -> CircuitWord {
    let mut h = Keccak256::new();
    h.update(bytes);
    CircuitWord::from(<[u8; 32]>::from(h.finalize()))
}

/// `poseidon(DELIVERY_COMMITMENT_DOMAIN, outputDataHash_0, ...,
/// outputDataHash_(O-1), arenaHash)` — the canonical word the delivery
/// commitment public input must carry for `output_data` and `arena`.
pub fn delivery_commitment_word(output_data: &[&[u8]], arena: &[u8]) -> CircuitWord {
    use pcash_crypto::domain_tags::{
        ARENA_HASH_DOMAIN, DELIVERY_COMMITMENT_DOMAIN, OUTPUT_DATA_HASH_DOMAIN,
    };
    let mut inputs = vec![DELIVERY_COMMITMENT_DOMAIN];
    for data in output_data {
        inputs.push(pcash_crypto::poseidon_bytes(OUTPUT_DATA_HASH_DOMAIN, data));
    }
    inputs.push(pcash_crypto::poseidon_bytes(ARENA_HASH_DOMAIN, arena));
    pcash_state::fr_to_bytes(pcash_crypto::poseidon(&inputs))
}

/// The delivery commitment of `shape`'s builders when every output-data item
/// is `data`.
pub fn uniform_delivery_commitment(shape: PrivateValueShape, data: &[u8]) -> CircuitWord {
    delivery_commitment_word(&vec![data; shape.profile().outputs], &dummy_arena(shape))
}

// ---- genesis / state ------------------------------------------------------

/// Launch rules with empty stub VKs, for use with a scripted verifier.
pub fn stub_rules() -> ProtocolRules {
    ProtocolRules::new([vec![], vec![]], vec![], vec![])
}

/// A network anchored at L1 block 0 with the header hash every
/// [`block_with_txs_at`] block carries.
pub fn source(inbox: Address) -> pcash_state::DerivationSource {
    pcash_state::DerivationSource {
        pcash_chain_id: PCASH_CHAIN_ID,
        l1_chain_id: L1_CHAIN_ID,
        inbox_address: inbox,
        genesis_l1_block: 0,
        genesis_l1_block_hash: B256::from([0xaa; 32]),
    }
}

/// A fork at `activation_timestamp` that retires user-account creation
/// (type `0x01`) and keeps every other launch type and encoding.
pub fn fork_at(activation_timestamp: u64) -> ForkActivation {
    ForkActivation {
        name: "retire user-account creation",
        activation_timestamp,
        accepted_transaction_types: vec![
            KIND_PRIVATE_VALUE,
            KIND_CONTRACT_ACCOUNT_CREATION,
            KIND_USER_ACCOUNT_UPDATE,
        ],
        accepted_batch_versions: BASE_BATCH_VERSIONS.to_vec(),
        hiding_kernel_vks: Vec::new(),
    }
}

pub fn mem_state(source: pcash_state::DerivationSource) -> pcash_state::MemState {
    pcash_state::MemState::new(source)
}

// ---- transaction / batch builders ----------------------------------------

/// A profile-S type-`0x00` transaction. `proof` must have the S size (see
/// [`stub_proof`]) and every output-data item `OUTPUT_DATA_BYTES`; the
/// section carries [`dummy_arena`].
pub fn transfer_txbytes(pis: &[CircuitWord], proof: &[u8], output_data: &[&[u8]]) -> Vec<u8> {
    profile_txbytes(PrivateValueShape::S, pis, proof, output_data)
}

/// The serialized section of `layout`: the wire words of the verifier-order
/// `pis` (all but the chain ID, the delivery commitment, and, for an account
/// section, the issuance word), the proof, the output data, and `arena`.
fn section_txbytes(
    layout: SectionLayout,
    pis: &[CircuitWord],
    proof: &[u8],
    output_data: &[&[u8]],
    arena: &[u8],
) -> Vec<u8> {
    let profile = layout.shape().profile();
    assert_eq!(pis.len(), profile.public_inputs);
    assert_eq!(output_data.len(), profile.outputs);
    assert_eq!(proof.len(), layout.proof_bytes());
    assert!(output_data
        .iter()
        .all(|data| data.len() == OUTPUT_DATA_BYTES));
    let omitted = |offset: usize| {
        offset == 0
            || offset == profile.delivery_commitment_offset
            || (layout.omits_issuance_owner() && offset == profile.issuance_owner_offset)
    };
    let mut b = Vec::with_capacity(layout.section_bytes());
    for (offset, pi) in pis.iter().enumerate() {
        if !omitted(offset) {
            b.extend_from_slice(pi.as_slice());
        }
    }
    b.extend_from_slice(proof);
    for data in output_data {
        b.extend_from_slice(data);
    }
    b.extend_from_slice(arena);
    b
}

#[allow(
    clippy::too_many_arguments,
    reason = "account fixtures name every encoded field"
)]
/// A signed user-account creation. `y_parity` is the raw wire byte.
pub fn account_txbytes(
    nullifier_key_commitment: CircuitWord,
    rule_set: CircuitWord,
    ml_kem: Option<&[u8]>,
    recent_pcash_block_hash: CircuitWord,
    valid_until_timestamp: u64,
    r: CircuitWord,
    s: CircuitWord,
    y_parity: u8,
) -> Vec<u8> {
    let mut b = vec![KIND_USER_ACCOUNT_CREATION];
    b.extend_from_slice(&PCASH_CHAIN_ID.to_be_bytes());
    b.push(1); // EIP-712 authorization
    b.extend_from_slice(nullifier_key_commitment.as_slice());
    b.extend_from_slice(rule_set.as_slice());
    if let Some(k) = ml_kem {
        assert_eq!(k.len(), ML_KEM768_PUBLIC_KEY_LEN);
        b.push(1);
        b.extend_from_slice(k);
    } else {
        b.push(0);
    }
    b.extend_from_slice(recent_pcash_block_hash.as_slice());
    b.extend_from_slice(&valid_until_timestamp.to_be_bytes());
    b.extend_from_slice(r.as_slice());
    b.extend_from_slice(s.as_slice());
    b.push(y_parity);
    b
}

/// The private-value section carried by an account action: its serialized
/// verifier words (every position of `pis` but the chain ID, the delivery
/// commitment, and the issuance word), the proof, five output-data items, and
/// the [`dummy_arena`]. `proof` must have the account-action size (both
/// account layouts pin the same one) and every item `OUTPUT_DATA_BYTES`.
pub fn private_value_section(pis: &[CircuitWord], proof: &[u8], output_data: &[&[u8]]) -> Vec<u8> {
    assert_eq!(
        SectionLayout::UserAccountUpdate.section_bytes(),
        SectionLayout::ContractAccountCreation.section_bytes()
    );
    section_txbytes(
        SectionLayout::UserAccountUpdate,
        pis,
        proof,
        output_data,
        &dummy_arena(PrivateValueShape::S),
    )
}

/// The profile-S verifier words of a fee payment: distinct nonzero
/// nullifiers and bodies derived from `salt`, the delivery commitment of
/// [`DUMMY_OUTPUT_DATA`] and the [`dummy_arena`], the given payout terms, and
/// no carrier-context condition. `fee_recipient` zero selects the open route.
#[allow(
    clippy::too_many_arguments,
    reason = "section fixtures name every consensus field"
)]
pub fn section_words(
    recent_pcash_block_hash: CircuitWord,
    salt: u64,
    open_fee_amount: u64,
    fee_recipient: Address,
    not_before: u64,
    valid_until_timestamp: u64,
) -> Vec<CircuitWord> {
    let mut pis = vec![word(u64::from(PCASH_CHAIN_ID)), recent_pcash_block_hash];
    for slot in 0..4u64 {
        pis.push(tagged_word(0x0e, salt * 16 + slot + 1));
    }
    for slot in 0..5u64 {
        pis.push(tagged_word(0x0f, salt * 16 + slot + 1));
    }
    pis.push(uniform_delivery_commitment(
        PrivateValueShape::S,
        &DUMMY_OUTPUT_DATA,
    ));
    pis.push(word(open_fee_amount));
    let mut recipient = [0u8; 32];
    recipient[12..].copy_from_slice(fee_recipient.as_slice());
    pis.push(CircuitWord::from(recipient));
    pis.push(word(not_before));
    pis.push(word(valid_until_timestamp));
    pis.push(CircuitWord::ZERO);
    pis.push(tagged_word(0x10, salt));
    pis
}

/// A zero-fee section with all-empty output data and a stub proof.
pub fn zero_fee_section(
    recent_pcash_block_hash: CircuitWord,
    salt: u64,
    valid_until_timestamp: u64,
    proof: &[u8],
) -> Vec<u8> {
    private_value_section(
        &section_words(
            recent_pcash_block_hash,
            salt,
            0,
            Address::ZERO,
            0,
            valid_until_timestamp,
        ),
        proof,
        &[DUMMY_OUTPUT_DATA.as_slice(); 5],
    )
}

/// An unfunded contract-account creation: the envelope, funding mode `0`,
/// the recent block and deadline, then `body`.
pub fn unfunded_contract_txbytes(body: &[u8], recent: CircuitWord, deadline: u64) -> Vec<u8> {
    let mut b = vec![KIND_CONTRACT_ACCOUNT_CREATION];
    b.extend_from_slice(&PCASH_CHAIN_ID.to_be_bytes());
    b.push(0);
    b.extend_from_slice(recent.as_slice());
    b.extend_from_slice(&deadline.to_be_bytes());
    b.extend_from_slice(body);
    b
}

/// A sponsored contract-account creation: the envelope, funding mode `1`, the
/// sponsor's section (see [`private_value_section`]), then `body`.
pub fn sponsored_contract_txbytes(body: &[u8], section: &[u8]) -> Vec<u8> {
    assert_eq!(
        section.len(),
        SectionLayout::ContractAccountCreation.section_bytes()
    );
    let mut b = vec![KIND_CONTRACT_ACCOUNT_CREATION];
    b.extend_from_slice(&PCASH_CHAIN_ID.to_be_bytes());
    b.push(1);
    b.extend_from_slice(section);
    b.extend_from_slice(body);
    b
}

/// The static body check of the contract creation `raw`, decoded as bytes
/// admitted earlier.
pub fn contract_body_check(raw: &[u8]) -> ContractBodyCheck {
    let Ok(AdmittedTransaction::ContractAccountCreation(_, check)) =
        AdmittedTransaction::decode(raw, PCASH_CHAIN_ID)
    else {
        panic!("a contract creation");
    };
    check
}

pub fn account_update_txbytes(
    address: Address,
    new_rule_set: CircuitWord,
    receive_key_update: pcash_derive::ReceiveKeyUpdate,
    account_update_commitment: CircuitWord,
    section: &[u8],
) -> Vec<u8> {
    let mut b = vec![pcash_derive::KIND_USER_ACCOUNT_UPDATE];
    b.extend_from_slice(&PCASH_CHAIN_ID.to_be_bytes());
    b.extend_from_slice(address.as_slice());
    b.extend_from_slice(new_rule_set.as_slice());
    match receive_key_update {
        pcash_derive::ReceiveKeyUpdate::Keep => b.push(pcash_derive::RECEIVE_KEY_UPDATE_KEEP),
        pcash_derive::ReceiveKeyUpdate::Clear => b.push(pcash_derive::RECEIVE_KEY_UPDATE_CLEAR),
        pcash_derive::ReceiveKeyUpdate::Replace(key) => {
            b.push(pcash_derive::RECEIVE_KEY_UPDATE_REPLACE);
            b.extend_from_slice(key.as_slice());
        }
    }
    b.extend_from_slice(account_update_commitment.as_slice());
    b.extend_from_slice(section);
    b
}

/// Frame items into inbox calldata.
pub fn batch(items: &[Vec<u8>]) -> Vec<u8> {
    batch_for_version(items, BatchVersion::V1)
}

pub fn batch_for_version(items: &[Vec<u8>], version: BatchVersion) -> Vec<u8> {
    Batch {
        version,
        poster_owner_commitment: field_element(word(0xbeef)),
        poster_context: word(0xcafe),
        items: items.iter().map(Vec::as_slice).collect(),
    }
    .encode()
    .unwrap()
}

/// Deterministic header timestamp for block `number`: 12 s slots from a fixed
/// epoch, so sequentially numbered blocks carry monotonic timestamps.
pub fn ts_of(number: u64) -> u64 {
    1_700_000_000 + number * 12
}

/// A single-transaction L1 block whose one transaction is an inbox batch from
/// `sender`.
pub fn block_with_batch(
    number: u64,
    inbox: Address,
    sender: Address,
    calldata: Vec<u8>,
) -> L1BlockData {
    block_with_txs(number, vec![(sender, Some(inbox), calldata)])
}

/// A general L1 block from `(from, to, input)` tuples in tx order.
pub fn block_with_txs(number: u64, txs: Vec<(Address, Option<Address>, Vec<u8>)>) -> L1BlockData {
    block_with_txs_at(number, ts_of(number), txs)
}

/// [`block_with_txs`] with an explicit header timestamp (for regression tests).
pub fn block_with_txs_at(
    number: u64,
    timestamp: u64,
    txs: Vec<(Address, Option<Address>, Vec<u8>)>,
) -> L1BlockData {
    let header = L1Header {
        number,
        hash: B256::from([0xaa; 32]),
        parent_hash: B256::from([0xbb; 32]),
        timestamp,
    };
    let txs = txs
        .into_iter()
        .enumerate()
        .map(|(i, (from, to, input))| {
            (
                L1Tx {
                    hash: B256::from([i as u8; 32]),
                    from,
                    to,
                    input: Bytes::from(input),
                    blob_versioned_hashes: Vec::new(),
                    blob_resolution: Default::default(),
                    tx_index: i as u64,
                },
                L1Receipt { logs: Vec::new() },
            )
        })
        .collect();
    L1BlockData::new(header, txs)
}

alloy_sol_types::sol! {
    /// The carrier event any Ethereum contract may emit to deliver a batch.
    event PcashBatch(bytes context, bytes batch);
}

/// The log data Solidity emits for `PcashBatch(context, batch)`.
pub fn pcash_batch_data(context: &[u8], batch: &[u8]) -> Vec<u8> {
    use alloy_sol_types::SolEvent;
    PcashBatch {
        context: context.to_vec().into(),
        batch: batch.to_vec().into(),
    }
    .encode_data()
}

/// A receipt log from `emitter`. [`block_with_receipts`] assigns its
/// transaction and log indices.
pub fn receipt_log(emitter: Address, topics: Vec<B256>, data: Vec<u8>) -> L1Log {
    L1Log {
        transaction_index: 0,
        log_index: 0,
        emitter,
        topics,
        data: Bytes::from(data),
    }
}

/// The `PcashBatch` topic.
pub fn pcash_batch_topic() -> B256 {
    use alloy_sol_types::SolEvent;
    PcashBatch::SIGNATURE_HASH
}

/// A carrier event from `emitter` delivering `batch` with `context`.
pub fn carrier_event(emitter: Address, context: &[u8], batch: &[u8]) -> L1Log {
    receipt_log(
        emitter,
        vec![pcash_batch_topic()],
        pcash_batch_data(context, batch),
    )
}

/// One L1 transaction of [`block_with_receipts`]: `(from, to, input, logs)`.
pub type TxWithLogs = (Address, Option<Address>, Vec<u8>, Vec<L1Log>);

/// A general L1 block from transactions in order; each transaction's logs take
/// receipt-local indices in order.
pub fn block_with_receipts(number: u64, txs: Vec<TxWithLogs>) -> L1BlockData {
    let mut logs = Vec::with_capacity(txs.len());
    let block = block_with_txs(
        number,
        txs.into_iter()
            .map(|(from, to, input, tx_logs)| {
                logs.push(tx_logs);
                (from, to, input)
            })
            .collect(),
    );
    let header = block.header.clone();
    let txs = block
        .txs
        .into_iter()
        .zip(logs)
        .map(|((tx, _), tx_logs)| {
            let logs = tx_logs
                .into_iter()
                .enumerate()
                .map(|(log_index, log)| L1Log {
                    transaction_index: tx.tx_index,
                    log_index: log_index as u64,
                    ..log
                })
                .collect();
            (tx, L1Receipt { logs })
        })
        .collect();
    L1BlockData::new(header, txs)
}

/// A type-`0x00` transaction of `shape` carrying the [`dummy_arena`].
pub fn profile_txbytes(
    shape: PrivateValueShape,
    pis: &[CircuitWord],
    proof: &[u8],
    output_data: &[&[u8]],
) -> Vec<u8> {
    profile_txbytes_with_arena(shape, pis, proof, output_data, &dummy_arena(shape))
}

/// A type-`0x00` transaction of `shape` carrying `arena`, of any length.
pub fn profile_txbytes_with_arena(
    shape: PrivateValueShape,
    pis: &[CircuitWord],
    proof: &[u8],
    output_data: &[&[u8]],
    arena: &[u8],
) -> Vec<u8> {
    let mut b = vec![KIND_PRIVATE_VALUE];
    let chain_id = u32::from_be_bytes(pis[0].as_slice()[28..32].try_into().unwrap());
    b.extend_from_slice(&chain_id.to_be_bytes());
    b.push(shape as u8);
    b.extend(section_txbytes(
        SectionLayout::PrivateValue(shape),
        pis,
        proof,
        output_data,
        arena,
    ));
    b
}
