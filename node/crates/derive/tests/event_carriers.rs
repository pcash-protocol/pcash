#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "tests use direct assertions for fixture setup"
)]
//! Carrier events: any Ethereum contract delivers a batch by emitting
//! `PcashBatch(bytes context, bytes batch)`, and the batch executes exactly
//! as an Inbox batch does, under the event's carrier context.

mod common;
use common::*;

use alloy_primitives::{keccak256, Address, B256, U256};
use pcash_derive::private_value_profiles::{PrivateValueShape, S};
use pcash_derive::{
    derive_block, Batch, BatchExclusionReason, BatchVersion, CarrierType, ItemExclusionReason,
    L1DeliveryBatch, L1DeliveryItem, SectionLayout,
};
use pcash_l1::{carrier_context_hash, CarrierKind};
use pcash_state::{
    content_hash, fr_to_bytes, transaction_id, CircuitWord, FailureDetail, FailureDetailSeed,
    PayoutSource, RejectedEffects, StateDb, TransactionEffects, TransactionOutcome,
};

const INBOX: fn() -> Address = || addr(0x5043_5348);
const ROUTER: fn() -> Address = || addr(0x7007);

fn initialize(rules: &pcash_derive::ProtocolRules) -> pcash_state::MemState {
    let mut state = mem_state(source(INBOX()));
    derive_block(
        &mut state,
        &block_with_txs(0, Vec::new()),
        rules,
        &StubVerifier::accept(),
    )
    .unwrap();
    state
}

/// A zero-fee profile-S transfer whose nullifiers derive from `salt`, valid
/// in block `block`, requiring `carrier_context` (zero for none). `proof_seed`
/// changes the bytes without changing the nullifiers.
fn transfer(
    state: &impl StateDb,
    block: u64,
    salt: u64,
    carrier_context: CircuitWord,
    proof_seed: u8,
) -> Vec<u8> {
    let mut words = section_words(
        state.canonical_tip().unwrap().hash,
        salt,
        0,
        Address::ZERO,
        0,
        ts_of(block) + 120,
    );
    words[S.carrier_context_hash_offset] = carrier_context;
    transfer_txbytes(
        &words,
        &stub_proof(
            SectionLayout::PrivateValue(PrivateValueShape::S),
            &[proof_seed; 64],
        ),
        &[DUMMY_OUTPUT_DATA.as_slice(); 5],
    )
}

/// A batch of `items` from `poster` with `context`.
fn posted(items: &[Vec<u8>], poster: u64, context: u64) -> Vec<u8> {
    Batch {
        version: BatchVersion::V1,
        poster_owner_commitment: field_element(word(poster)),
        poster_context: word(context),
        items: items.iter().map(Vec::as_slice).collect(),
    }
    .encode()
    .unwrap()
}

fn event_context(emitter: Address, context: &[u8]) -> CircuitWord {
    fr_to_bytes(carrier_context_hash(
        CarrierKind::Event,
        emitter.into_array(),
        context,
    ))
}

/// One manifest's carrier: `(l1 transaction index, log index or None for the
/// Inbox carrier, item indices, exclusion reason)`.
type CarrierSummary = (u64, Option<u64>, Vec<u64>, Option<BatchExclusionReason>);

/// Every manifest's [`CarrierSummary`].
fn carriers(outcome: &pcash_derive::BlockOutcome) -> Vec<CarrierSummary> {
    outcome
        .committed_boundary
        .history
        .l1_delivery_batches
        .iter()
        .map(|batch| {
            let log_index = match batch.carrier_type {
                CarrierType::Event { log_index, .. } => Some(log_index),
                CarrierType::Calldata | CarrierType::Blob => None,
            };
            let items = batch.items.iter().map(|item| item.batch_item_index);
            (
                batch.l1_transaction_index,
                log_index,
                items.collect(),
                batch.exclusion_reason,
            )
        })
        .collect()
}

#[test]
fn a_carrier_event_delivers_its_batch_and_records_its_manifest() {
    let rules = stub_rules();
    let mut state = initialize(&rules);
    let raw = transfer(&state, 1, 1, CircuitWord::ZERO, 1);
    let log = carrier_event(
        ROUTER(),
        b"router context",
        &batch(std::slice::from_ref(&raw)),
    );
    let data = log.data.clone();
    let payer = addr(0xa1);
    let block = block_with_receipts(1, vec![(payer, Some(ROUTER()), vec![0xab; 4], vec![log])]);
    let outcome = derive_block(&mut state, &block, &rules, &StubVerifier::accept()).unwrap();
    assert_eq!(item_results(&outcome), vec![SUCCEEDED]);
    let boundary = &outcome.committed_boundary;
    let result = &boundary.block.transaction_results[0];
    assert_eq!(
        (result.l1_transaction_index, result.batch_item_index),
        (0, 0)
    );
    assert_eq!(
        boundary.history.l1_delivery_batches,
        vec![L1DeliveryBatch {
            l1_transaction_index: 0,
            l1_transaction_hash: block.txs[0].0.hash,
            l1_sender: payer,
            carrier_type: CarrierType::Event {
                log_index: 0,
                emitter: ROUTER(),
                context: Some(b"router context".to_vec()),
            },
            carrier_hash: keccak256(&data),
            carrier_length: data.len() as u64,
            blob_versioned_hashes: Vec::new(),
            poster_owner_commitment: Some(word(0xbeef)),
            poster_context: Some(word(0xcafe)),
            exclusion_reason: None,
            first_batch_item_index: 0,
            items: vec![L1DeliveryItem {
                batch_item_index: 0,
                content_hash: content_hash(&raw),
                byte_offset: 71,
                byte_length: raw.len() as u64,
                exclusion_reason: None,
            }],
        }]
    );
    // The carrier event is an ordinary log of the block's L1 origin.
    assert_eq!(outcome.l1_logs.count(), 1);
}

/// Within one Ethereum transaction the Inbox carrier comes first, then carrier
/// events in log order. `batchItemIndex` counts the items of every validly
/// framed carrier of the transaction in that order; an ignored carrier adds
/// no positions, and an Inbox-only transaction numbers its batch as before.
#[test]
fn carriers_of_one_transaction_execute_in_carrier_order_and_number_their_items_across_carriers() {
    let rules = stub_rules();
    let mut state = initialize(&rules);
    let pv = |salt, seed| transfer(&state, 1, salt, CircuitWord::ZERO, seed);
    let unrelated = || receipt_log(ROUTER(), vec![B256::repeat_byte(7)], vec![1, 2, 3]);
    let mut malformed = carrier_event(ROUTER(), &[], &batch(&[pv(9, 1)]));
    malformed.data = [malformed.data.as_ref(), &[0]].concat().into();
    // The second event re-spends the first event's nullifiers with other
    // bytes: it fails because the first executed before it.
    let block = block_with_receipts(
        1,
        vec![
            (
                addr(0xa1),
                Some(ROUTER()),
                Vec::new(),
                vec![
                    unrelated(),
                    carrier_event(ROUTER(), b"one", &batch(&[pv(1, 1), pv(2, 1)])),
                    unrelated(),
                    carrier_event(ROUTER(), b"two", &batch(&[pv(1, 2), pv(3, 1)])),
                ],
            ),
            (
                addr(0xa2),
                Some(INBOX()),
                batch(&[pv(4, 1), vec![0xff]]),
                vec![
                    malformed,
                    carrier_event(addr(0xe1), &[], &batch(&[pv(5, 1)])),
                ],
            ),
            (
                addr(0xa3),
                Some(INBOX()),
                batch(&[pv(6, 1), pv(7, 1)]),
                Vec::new(),
            ),
        ],
    );
    let outcome = derive_block(&mut state, &block, &rules, &StubVerifier::accept()).unwrap();
    let spent = ItemResult::Admitted(TransactionOutcome::NullifierAlreadySpent);
    assert_eq!(
        item_results(&outcome),
        vec![
            SUCCEEDED,
            SUCCEEDED,
            spent,
            SUCCEEDED,
            SUCCEEDED,
            ItemResult::Excluded(ItemExclusionReason::Truncated),
            SUCCEEDED,
            SUCCEEDED,
            SUCCEEDED,
        ]
    );
    assert_eq!(
        carriers(&outcome),
        vec![
            (0, Some(1), vec![0, 1], None),
            (0, Some(3), vec![2, 3], None),
            (1, None, vec![0, 1], None),
            (
                1,
                Some(0),
                vec![],
                Some(BatchExclusionReason::InvalidCarrierEncoding)
            ),
            (1, Some(1), vec![2], None),
            (2, None, vec![0, 1], None),
        ]
    );
    let boundary = &outcome.committed_boundary;
    // Each carrier starts where its transaction's earlier carriers end, an
    // ignored carrier included.
    let starts: Vec<_> = boundary
        .history
        .l1_delivery_batches
        .iter()
        .map(|batch| (batch.l1_transaction_index, batch.first_batch_item_index))
        .collect();
    assert_eq!(starts, [(0, 0), (0, 2), (1, 0), (1, 2), (1, 2), (2, 0)]);
    let coordinates: Vec<_> = boundary
        .block
        .transaction_results
        .iter()
        .map(|result| (result.l1_transaction_index, result.batch_item_index))
        .collect();
    assert_eq!(
        coordinates,
        [
            (0, 0),
            (0, 1),
            (0, 2),
            (0, 3),
            (1, 0),
            (1, 2),
            (2, 0),
            (2, 1)
        ]
    );
    let ids: std::collections::HashSet<_> = coordinates
        .iter()
        .map(|&(l1, item)| transaction_id(boundary.block.l1_origin.block_hash, l1, item))
        .collect();
    assert_eq!(ids.len(), coordinates.len());
    // Every result resolves to its own manifest item.
    for result in &boundary.block.transaction_results {
        let (_, item) =
            pcash_state::admitted_delivery(&boundary.history.l1_delivery_batches, result).unwrap();
        assert_eq!(item.batch_item_index, result.batch_item_index);
    }
}

/// A `PcashBatch` log whose data is not the canonical encoding, or whose batch
/// exceeds `MAX_BATCH_BYTES`, is ignored in full: no item executes, derivation
/// continues, and its manifest records why, covering the whole log data. The
/// context is retained when the data decodes.
#[test]
fn malformed_and_oversize_carrier_events_are_ignored_in_full() {
    let rules = stub_rules();
    let mut state = initialize(&rules);
    let framed = batch(&[transfer(&state, 1, 1, CircuitWord::ZERO, 1)]);
    let canonical = pcash_batch_data(b"ctx", &framed);
    let mutate = |offset: usize| {
        let mut data = canonical.clone();
        data[offset] ^= 1;
        data
    };
    // Heads 0..64, context length 64..96, context 96..99 and padding to 128,
    // batch length 128..160, then the batch and its padding.
    let batch_end = 160 + framed.len();
    assert!(canonical.len() > batch_end);
    let oversize = vec![0x01; pcash_da::MAX_BATCH_BYTES + 1];
    let cases: Vec<(Vec<u8>, Option<Vec<u8>>)> = vec![
        (mutate(31), None),                                // bad context offset
        (mutate(63), None),                                // bad batch offset
        (mutate(100), None),                               // nonzero context padding
        (mutate(batch_end), None),                         // nonzero batch padding
        ([canonical.as_slice(), &[0; 32]].concat(), None), // trailing bytes
        (canonical[..canonical.len() - 1].to_vec(), None), // truncated
        (pcash_batch_data(b"big", &oversize), Some(b"big".to_vec())),
    ];
    let logs = cases
        .iter()
        .map(|(data, _)| receipt_log(ROUTER(), vec![pcash_batch_topic()], data.clone()))
        .chain(std::iter::once(receipt_log(
            ROUTER(),
            vec![pcash_batch_topic()],
            canonical.clone(),
        )))
        .collect();
    let block = block_with_receipts(1, vec![(addr(0xa1), Some(ROUTER()), Vec::new(), logs)]);
    let outcome = derive_block(&mut state, &block, &rules, &StubVerifier::accept()).unwrap();
    // Only the canonical event's batch executes.
    assert_eq!(item_results(&outcome), vec![SUCCEEDED]);
    let manifests = &outcome.committed_boundary.history.l1_delivery_batches;
    assert_eq!(manifests.len(), cases.len() + 1);
    for (log_index, ((data, context), manifest)) in cases.iter().zip(manifests).enumerate() {
        assert_eq!(
            (
                &manifest.carrier_type,
                manifest.carrier_hash,
                manifest.carrier_length,
                manifest.exclusion_reason,
                manifest.poster_owner_commitment,
                manifest.items.len(),
            ),
            (
                &CarrierType::Event {
                    log_index: log_index as u64,
                    emitter: ROUTER(),
                    context: context.clone(),
                },
                keccak256(data),
                data.len() as u64,
                Some(BatchExclusionReason::InvalidCarrierEncoding),
                None,
                0,
            ),
            "case {log_index}"
        );
    }
    let accepted = &manifests[cases.len()];
    assert_eq!(accepted.exclusion_reason, None);
    assert_eq!(accepted.items[0].batch_item_index, 0);
}

/// A canonical event whose batch fails framing is excluded as any batch is.
#[test]
fn a_carrier_event_batch_that_fails_framing_is_excluded_with_its_reason() {
    let rules = stub_rules();
    let mut state = initialize(&rules);
    let mut unsupported = batch(&[transfer(&state, 1, 1, CircuitWord::ZERO, 1)]);
    unsupported[0] = 0xff;
    let block = block_with_receipts(
        1,
        vec![(
            addr(0xa1),
            Some(ROUTER()),
            Vec::new(),
            vec![
                carrier_event(ROUTER(), b"ctx", &unsupported),
                carrier_event(ROUTER(), &[], &[]),
            ],
        )],
    );
    let outcome = derive_block(&mut state, &block, &rules, &StubVerifier::accept()).unwrap();
    assert_eq!(item_results(&outcome), vec![]);
    assert_eq!(
        carriers(&outcome),
        vec![
            (
                0,
                Some(0),
                vec![],
                Some(BatchExclusionReason::UnsupportedBatchVersion)
            ),
            (
                0,
                Some(1),
                vec![],
                Some(BatchExclusionReason::TruncatedFraming)
            ),
        ]
    );
    assert_eq!(
        outcome.committed_boundary.history.l1_delivery_batches[0].carrier_type,
        CarrierType::Event {
            log_index: 0,
            emitter: ROUTER(),
            context: Some(b"ctx".to_vec()),
        }
    );
}

/// A log whose first topic is the carrier topic but that has any other topic
/// count is not a carrier: it gets no manifest, and only enters the log tree.
#[test]
fn a_log_with_the_carrier_topic_and_other_topics_is_not_a_carrier() {
    let rules = stub_rules();
    let mut state = initialize(&rules);
    let data = pcash_batch_data(&[], &batch(&[transfer(&state, 1, 1, CircuitWord::ZERO, 1)]));
    let other = B256::repeat_byte(0x11);
    let logs = [
        vec![pcash_batch_topic(), other],
        vec![pcash_batch_topic(), other, other, other],
        vec![other, pcash_batch_topic()],
        vec![],
    ]
    .into_iter()
    .map(|topics| receipt_log(ROUTER(), topics, data.clone()))
    .collect();
    let block = block_with_receipts(1, vec![(addr(0xa1), Some(ROUTER()), Vec::new(), logs)]);
    let outcome = derive_block(&mut state, &block, &rules, &StubVerifier::accept()).unwrap();
    assert!(outcome
        .committed_boundary
        .history
        .l1_delivery_batches
        .is_empty());
    assert!(outcome
        .committed_boundary
        .block
        .transaction_results
        .is_empty());
    assert_eq!(outcome.l1_logs.count(), 4);
}

/// A transaction requiring an event's carrier context executes only when
/// that emitter delivers it with those exact context bytes. Through the
/// Inbox from the same address, from another emitter with the same context,
/// or from the same emitter with another context, it fails with
/// `CarrierContextMismatch`, consumes nothing, and is never verified.
#[test]
fn an_event_carrier_context_is_met_only_by_its_exact_emitter_and_context() {
    let rules = stub_rules();
    let mut state = initialize(&rules);
    let context = b"offer 7, seller 9".to_vec();
    let required = event_context(ROUTER(), &context);
    let raw = transfer(&state, 1, 1, required, 1);
    let framed = batch(std::slice::from_ref(&raw));
    let impostor = addr(0x7008);
    let block = block_with_receipts(
        1,
        vec![
            // The router's address posting through the Inbox.
            (ROUTER(), Some(INBOX()), framed.clone(), Vec::new()),
            (
                addr(0xa1),
                Some(impostor),
                Vec::new(),
                vec![
                    carrier_event(impostor, &context, &framed),
                    carrier_event(ROUTER(), b"offer 7, seller 8", &framed),
                ],
            ),
            (
                addr(0xa2),
                Some(ROUTER()),
                Vec::new(),
                vec![carrier_event(ROUTER(), &context, &framed)],
            ),
        ],
    );
    let verifier = StubVerifier::accept();
    let outcome = derive_block(&mut state, &block, &rules, &verifier).unwrap();
    let mismatch = ItemResult::Admitted(TransactionOutcome::CarrierContextMismatch);
    assert_eq!(
        item_results(&outcome),
        vec![mismatch, mismatch, mismatch, SUCCEEDED]
    );
    assert_eq!(verifier.calls.get(), 1);
    let delivered = [
        fr_to_bytes(carrier_context_hash(
            CarrierKind::Inbox,
            ROUTER().into_array(),
            &[],
        )),
        event_context(impostor, &context),
        event_context(ROUTER(), b"offer 7, seller 8"),
    ];
    for (index, carrier) in delivered.into_iter().enumerate() {
        assert_eq!(
            outcome.transaction_effects[index],
            TransactionEffects::Rejected(RejectedEffects {
                account: None,
                detail: Some(FailureDetailSeed::Complete(
                    FailureDetail::CarrierContextMismatch { required, carrier }
                )),
            })
        );
    }
    let coordinates: Vec<_> = outcome
        .committed_boundary
        .block
        .transaction_results
        .iter()
        .map(|result| (result.l1_transaction_index, result.batch_item_index))
        .collect();
    assert_eq!(coordinates, [(0, 0), (1, 0), (1, 1), (2, 0)]);
}

/// Two carriers of one Ethereum transaction that name one poster keep both
/// batches' poster contexts in the poster's payout records.
#[test]
fn a_poster_keeps_the_context_of_every_batch_in_one_transaction() {
    let rules = stub_rules();
    let mut state = initialize(&rules);
    let block = block_with_receipts(
        1,
        vec![(
            addr(0xa1),
            Some(INBOX()),
            posted(
                &[transfer(&state, 1, 1, CircuitWord::ZERO, 1)],
                0xbeef,
                0x61,
            ),
            vec![carrier_event(
                ROUTER(),
                &[],
                &posted(
                    &[transfer(&state, 1, 2, CircuitWord::ZERO, 1)],
                    0xbeef,
                    0x62,
                ),
            )],
        )],
    );
    let outcome = derive_block(&mut state, &block, &rules, &StubVerifier::accept()).unwrap();
    assert_eq!(item_results(&outcome), vec![SUCCEEDED; 2]);
    let payouts = &outcome.committed_boundary.history.payouts;
    assert!(!payouts.is_empty());
    for payout in payouts {
        assert_eq!(
            payout.source,
            PayoutSource::PosterPayout {
                l1_transaction_indices: vec![0]
            }
        );
        assert_eq!(payout.contexts, vec![word(0x61), word(0x62)]);
    }
    assert!(payouts.iter().any(|payout| payout.amount > U256::ZERO));
}
