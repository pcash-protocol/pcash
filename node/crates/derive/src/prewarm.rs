//! Block preparation off the derivation mutex: every framed item is admitted
//! at the block's timestamp, every creation's receive key hashed, and every
//! reachable proof verified before the follow loop takes the lock. Its
//! complete-cache verifier fails on a miss rather than invoking the backend.
//!
//! A proof is reachable when its transaction passes its type's static checks
//! and its validity conditions, including its carrier-context condition
//! against its carrier. [`ProofStatement::reachable`] runs execution's own
//! steps, the only source of the statement execution verifies, so execution
//! finds every verdict it asks for.
//!
//! Prewarming can verify proofs of transactions that later checks fail: the
//! zero and duplicate input nullifier checks, which execution applies after a
//! state check, and every state-dependent check. Cache tool failures instead
//! of returning them here: a failure becomes fatal only if derivation reaches
//! that exact verification.

use alloy_primitives::B256;
use pcash_l1::{Carrier, CarrierBatch, L1BlockData};
use pcash_state::{BatchExclusionReason, DerivationSource, Fr, ItemExclusionReason};
use pcash_verify::{Verifier, VerifyCache};

use crate::admission::{admit, AdmittedTransaction};
use crate::engine::ProofStatement;
use crate::framing::Batch;
use crate::params::ProtocolRules;

/// Block-scoped admitted input and off-lock verifier results. The borrowed raw
/// slices bind every admitted transaction to the exact carrier bytes held by
/// `block`, and derivation applies the same rules the block was prepared under.
pub struct PreparedBlock<'a> {
    pub(crate) block: &'a L1BlockData,
    pub(crate) rules: &'a ProtocolRules,
    /// Every carrier of the block, in derivation order.
    pub(crate) carriers: Vec<PreparedCarrier<'a>>,
    cache: VerifyCache,
}

pub(crate) struct PreparedCarrier<'a> {
    pub(crate) carrier: Carrier<'a>,
    pub(crate) framing: CarrierFraming<'a>,
}

/// What one carrier resolved to.
pub(crate) enum CarrierFraming<'a> {
    /// The carrier encoding is invalid or unsupported.
    Ignored,
    /// A blob carrier whose availability was never resolved.
    Unresolved,
    /// Candidate batch bytes whose framing was excluded.
    Excluded {
        bytes: &'a [u8],
        reason: BatchExclusionReason,
    },
    Batch(PreparedBatch<'a>),
}

pub(crate) struct PreparedBatch<'a> {
    pub(crate) bytes: &'a [u8],
    /// The carrier context hash of the carrier that delivered the batch.
    pub(crate) carrier_context_hash: Fr,
    pub(crate) poster_owner_commitment: Fr,
    pub(crate) poster_context: B256,
    pub(crate) items: Vec<PreparedBatchItem<'a>>,
}

/// One framed batch item: its exact bytes within the batch, and the admitted
/// transaction or the reason the item is excluded. The transaction is boxed,
/// so an excluded item, the cheapest kind to post, takes only a few words.
pub(crate) struct PreparedBatchItem<'a> {
    pub(crate) raw: &'a [u8],
    pub(crate) admission: Result<Box<AdmittedTransaction>, ItemExclusionReason>,
}

impl PreparedBlock<'_> {
    pub fn block(&self) -> &L1BlockData {
        self.block
    }

    pub fn cache(&self) -> &VerifyCache {
        &self.cache
    }
}

/// Admit each framed item once and verify its proof off the node lock.
/// `source` is the derivation source of the state the block will be derived
/// into; it selects the inbox and the chain ID items must name.
pub fn prepare_block<'a, V: Verifier>(
    block: &'a L1BlockData,
    rules: &'a ProtocolRules,
    source: &DerivationSource,
    verifier: &V,
) -> PreparedBlock<'a> {
    let mut cache = VerifyCache::new();
    // Walk carriers in the exact derivation order. Only the proof statement
    // matters here; all state-dependent checks stay in the engine.
    let carriers = block
        .carriers(source.inbox_address)
        .map(|carrier| PreparedCarrier {
            carrier,
            framing: prepare_carrier(&carrier, block, rules, source, verifier, &mut cache),
        })
        .collect();
    PreparedBlock {
        block,
        rules,
        carriers,
        cache,
    }
}

fn prepare_carrier<'a, V: Verifier>(
    carrier: &Carrier<'a>,
    block: &L1BlockData,
    rules: &ProtocolRules,
    source: &DerivationSource,
    verifier: &V,
    cache: &mut VerifyCache,
) -> CarrierFraming<'a> {
    let bytes = match carrier.batch() {
        CarrierBatch::Bytes(bytes) => bytes,
        CarrierBatch::Ignore => return CarrierFraming::Ignored,
        CarrierBatch::Unresolved => return CarrierFraming::Unresolved,
    };
    let batch = match Batch::decode_accepted(bytes, rules, block.header.timestamp) {
        Ok(batch) => batch,
        Err(reason) => return CarrierFraming::Excluded { bytes, reason },
    };
    let carrier_context_hash = carrier.context_hash();
    let mut items = Vec::with_capacity(batch.items.len());
    for raw in batch.items {
        let admission = admit(
            raw,
            rules,
            source.pcash_chain_id,
            block.header.timestamp,
            carrier.kind(),
        )
        .map(Box::new)
        .map_err(|error| error.reason());
        if let Ok(transaction) = admission.as_deref() {
            if let AdmittedTransaction::UserAccountCreation(creation) = transaction {
                creation.receive_key_hash();
            }
            if let Some(statement) = ProofStatement::reachable(
                rules,
                transaction,
                block.header.timestamp,
                carrier_context_hash,
            ) {
                cache.warm(
                    verifier,
                    statement.vk,
                    statement.proof,
                    &statement.public_inputs,
                );
            }
        }
        items.push(PreparedBatchItem { raw, admission });
    }
    CarrierFraming::Batch(PreparedBatch {
        bytes,
        carrier_context_hash,
        poster_owner_commitment: batch.poster_owner_commitment,
        poster_context: batch.poster_context,
        items,
    })
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
    use alloy_primitives::{Address, Bytes};
    use pcash_l1::{BlobResolution, L1Header, L1Receipt, L1Tx};
    use pcash_verify::VerifyError;
    use std::cell::Cell;

    struct CountingVerifier(Cell<usize>);

    impl CountingVerifier {
        fn new() -> Self {
            Self(Cell::new(0))
        }
    }

    impl Verifier for CountingVerifier {
        fn verify(
            &self,
            _vk: &[u8],
            _proof: &[u8],
            _public_inputs: &[u8],
        ) -> Result<bool, VerifyError> {
            self.0.set(self.0.get() + 1);
            Ok(true)
        }
    }

    fn test_header(timestamp: u64) -> L1Header {
        L1Header {
            number: 100,
            hash: B256::repeat_byte(0xaa),
            parent_hash: B256::repeat_byte(0x99),
            timestamp,
        }
    }

    fn test_receipt() -> L1Receipt {
        L1Receipt { logs: vec![] }
    }

    fn stub_rules() -> ProtocolRules {
        ProtocolRules::new([vec![], vec![]], vec![], vec![])
    }

    fn test_source(inbox: Address) -> DerivationSource {
        DerivationSource {
            pcash_chain_id: 1,
            l1_chain_id: 1,
            inbox_address: inbox,
            genesis_l1_block: 0,
            genesis_l1_block_hash: B256::repeat_byte(0xaa),
        }
    }

    #[test]
    fn an_excluded_item_holds_no_transaction_sized_slot() {
        assert!(std::mem::size_of::<PreparedBatchItem<'_>>() <= 4 * std::mem::size_of::<usize>());
    }

    #[test]
    fn prewarm_empty_block_is_noop() {
        let inbox = Address::repeat_byte(0x12);
        let rules = stub_rules();
        let source = test_source(inbox);
        let block = L1BlockData::new(test_header(1000), vec![]);
        let verifier = CountingVerifier::new();
        let _prepared = prepare_block(&block, &rules, &source, &verifier);
        assert_eq!(verifier.0.get(), 0);
    }

    #[test]
    fn a_wrong_chain_item_is_excluded_before_its_proof_is_verified() {
        use crate::private_value_profiles::{PrivateValueShape, S};
        use crate::transaction::{PrivateValueSection, Transaction};
        use crate::{SectionLayout, OUTPUT_DATA_BYTES};

        let inbox = Address::repeat_byte(0x12);
        let rules = stub_rules();
        let source = test_source(inbox);
        let mut section = PrivateValueSection::new(
            PrivateValueShape::S,
            source.pcash_chain_id,
            &vec![B256::ZERO; S.wire_inputs],
            vec![0; SectionLayout::PrivateValue(PrivateValueShape::S).proof_bytes()],
            vec![vec![0; OUTPUT_DATA_BYTES]; S.outputs],
            vec![0; S.arena_bytes],
        )
        .unwrap();
        *section.public_input_mut(S.valid_until_offset).unwrap() = B256::with_last_byte(0xff);
        let transaction = Transaction::PrivateValue(section);
        for (chain_id, verified) in [(source.pcash_chain_id, 1), (source.pcash_chain_id + 1, 0)] {
            let raw = transaction.encode(chain_id).unwrap();
            let batch = Batch {
                version: crate::params::BatchVersion::V1,
                poster_owner_commitment: Fr::from(1u64),
                poster_context: B256::ZERO,
                items: vec![&raw],
            }
            .encode()
            .unwrap();
            let tx = L1Tx {
                hash: B256::repeat_byte(0x01),
                from: Address::repeat_byte(0x02),
                to: Some(inbox),
                input: Bytes::from(batch),
                blob_versioned_hashes: vec![],
                blob_resolution: BlobResolution::Unresolved,
                tx_index: 0,
            };
            let block = L1BlockData::new(test_header(100), vec![(tx, test_receipt())]);
            let verifier = CountingVerifier::new();
            let prepared = prepare_block(&block, &rules, &source, &verifier);
            assert_eq!(verifier.0.get(), verified);
            let CarrierFraming::Batch(batch) = &prepared.carriers[0].framing else {
                panic!("a framed batch");
            };
            assert_eq!(
                batch.items[0].admission.as_ref().err(),
                (verified == 0).then_some(&ItemExclusionReason::WrongChainId)
            );
        }
    }

    #[test]
    fn prewarm_ignores_transactions_not_to_inbox() {
        let inbox = Address::repeat_byte(0x12);
        let rules = stub_rules();
        let source = test_source(inbox);
        let other_recipient = Address::repeat_byte(0x99);
        let tx = L1Tx {
            hash: B256::repeat_byte(0x01),
            from: Address::repeat_byte(0x02),
            to: Some(other_recipient),
            input: Bytes::from(vec![0x01, 0x00, 0x00]),
            blob_versioned_hashes: vec![],
            blob_resolution: BlobResolution::Unresolved,
            tx_index: 0,
        };
        let block = L1BlockData::new(test_header(1000), vec![(tx, test_receipt())]);
        let verifier = CountingVerifier::new();
        let _prepared = prepare_block(&block, &rules, &source, &verifier);
        assert_eq!(verifier.0.get(), 0);
    }

    #[test]
    fn prewarm_ignores_malformed_batches_and_excluded_items() {
        let inbox = Address::repeat_byte(0x12);
        let rules = stub_rules();
        let source = test_source(inbox);

        // Unsupported batch version.
        let malformed_tx = L1Tx {
            hash: B256::repeat_byte(0x01),
            from: Address::repeat_byte(0x02),
            to: Some(inbox),
            input: Bytes::from(vec![0xff, 0x00]),
            blob_versioned_hashes: vec![],
            blob_resolution: BlobResolution::Unresolved,
            tx_index: 0,
        };

        let valid_batch = Batch {
            version: crate::params::BatchVersion::V1,
            poster_owner_commitment: Fr::from(1u64),
            poster_context: B256::ZERO,
            items: vec![&[0xff, 0, 0, 0, 1, 0xee]],
        }
        .encode()
        .unwrap();

        let excluded_item_tx = L1Tx {
            hash: B256::repeat_byte(0x03),
            from: Address::repeat_byte(0x02),
            to: Some(inbox),
            input: Bytes::from(valid_batch),
            blob_versioned_hashes: vec![],
            blob_resolution: BlobResolution::Unresolved,
            tx_index: 1,
        };

        let block = L1BlockData::new(
            test_header(1000),
            vec![
                (malformed_tx, test_receipt()),
                (excluded_item_tx, test_receipt()),
            ],
        );
        let verifier = CountingVerifier::new();
        let prepared = prepare_block(&block, &rules, &source, &verifier);
        assert!(matches!(
            prepared.carriers[0].framing,
            CarrierFraming::Excluded {
                reason: BatchExclusionReason::UnsupportedBatchVersion,
                ..
            }
        ));
        let CarrierFraming::Batch(parsed) = &prepared.carriers[1].framing else {
            panic!("the second inbox transaction frames a batch");
        };
        assert!(matches!(
            parsed.items[0].admission,
            Err(ItemExclusionReason::UnknownKind)
        ));
        assert_eq!(verifier.0.get(), 0);
    }

    #[test]
    fn inbox_keeps_every_inbox_transaction_in_order_with_its_carrier() {
        let inbox = Address::repeat_byte(0x12);
        let rules = stub_rules();
        let source = test_source(inbox);
        let batch_bytes = Batch {
            version: crate::params::BatchVersion::V1,
            poster_owner_commitment: Fr::from(1u64),
            poster_context: B256::with_last_byte(2),
            items: vec![&[0xff, 0xee], &[0xdd]],
        }
        .encode()
        .unwrap();
        let mut versioned_hash = B256::repeat_byte(0x55);
        versioned_hash.0[0] = 0x01;
        let tx = |tx_index: u64,
                  to: Address,
                  input: &[u8],
                  blobs: usize,
                  blob_resolution: BlobResolution| {
            let tx = L1Tx {
                hash: B256::with_last_byte(tx_index as u8),
                from: Address::repeat_byte(0x02),
                to: Some(to),
                input: Bytes::copy_from_slice(input),
                blob_versioned_hashes: vec![versioned_hash; blobs],
                blob_resolution,
                tx_index,
            };
            (tx, test_receipt())
        };
        let unresolved = BlobResolution::Unresolved;
        let block = L1BlockData::new(
            test_header(1000),
            vec![
                tx(
                    0,
                    Address::repeat_byte(0x99),
                    &batch_bytes,
                    0,
                    unresolved.clone(),
                ),
                // Calldata and blobs together.
                tx(1, inbox, &[0x01], 1, unresolved.clone()),
                tx(2, inbox, &[], 1, unresolved.clone()),
                // Unsupported batch version.
                tx(3, inbox, &[0xff, 0x00], 0, unresolved.clone()),
                tx(4, Address::repeat_byte(0x99), &[], 1, unresolved.clone()),
                tx(5, inbox, &batch_bytes, 0, unresolved),
                tx(
                    6,
                    inbox,
                    &[],
                    1,
                    BlobResolution::Batch(Bytes::from(batch_bytes.clone())),
                ),
                tx(7, inbox, &[], 1, BlobResolution::Invalid),
            ],
        );

        let prepared = prepare_block(&block, &rules, &source, &CountingVerifier::new());

        let positions: Vec<u64> = prepared
            .carriers
            .iter()
            .map(|prepared| prepared.carrier.tx.tx_index)
            .collect();
        assert_eq!(positions, [1, 2, 3, 5, 6, 7]);
        let [mixed, unresolved, excluded, calldata, blob, invalid] = prepared.carriers.as_slice()
        else {
            panic!("six inbox transactions");
        };
        assert!(matches!(mixed.framing, CarrierFraming::Ignored));
        assert!(matches!(unresolved.framing, CarrierFraming::Unresolved));
        assert!(matches!(
            excluded.framing,
            CarrierFraming::Excluded {
                bytes: [0xff, 0x00],
                reason: BatchExclusionReason::UnsupportedBatchVersion,
            }
        ));
        assert!(matches!(invalid.framing, CarrierFraming::Ignored));
        for accepted in [calldata, blob] {
            let CarrierFraming::Batch(batch) = &accepted.framing else {
                panic!("a framed batch");
            };
            assert_eq!(batch.bytes, batch_bytes);
            assert_eq!(batch.poster_owner_commitment, Fr::from(1u64));
            assert_eq!(batch.poster_context, B256::with_last_byte(2));
            let raw: Vec<&[u8]> = batch.items.iter().map(|item| item.raw).collect();
            assert_eq!(raw, [&[0xff, 0xee][..], &[0xdd][..]]);
            assert!(matches!(
                batch.items[0].admission,
                Err(ItemExclusionReason::Truncated)
            ));
        }
    }
}
