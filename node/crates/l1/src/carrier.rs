//! Carriers and the carrier context a PCASH transaction can require.
//!
//! A carrier delivers one candidate batch: an Inbox transaction's calldata or
//! blobs, or a `PcashBatch(bytes context, bytes batch)` event from any emitter.
//! Every carrier has a carrier context: a kind, the address that vouches for
//! it, and context bytes. An Inbox transaction's is its sender with an empty
//! context; a `PcashBatch` event's is its emitter and its `context`.

use crate::logs::{data_chunk_slots, push_data_chunks};
use crate::types::{CarrierBatch, L1BlockData, L1Log, L1Tx};
use alloy_primitives::{b256, Address, B256};
use ark_ff::PrimeField;
use pcash_crypto::{domain_tags, poseidon, Fr};
use pcash_da::MAX_BATCH_BYTES;

/// `keccak256("PcashBatch(bytes,bytes)")`, the only topic of a carrier event.
pub const PCASH_BATCH_TOPIC: B256 =
    b256!("0x670af012ce670be5675273ba9381a51588870ed8b0539ed9874aa9a9a173f9df");

/// One carrier of a block. Carriers are read from the same block value, and
/// so the same receipts, whose logs the block's L1 origin commits.
#[derive(Clone, Copy, Debug)]
pub struct Carrier<'a> {
    /// The Ethereum transaction that carries it.
    pub tx: &'a L1Tx,
    pub source: CarrierSource<'a>,
}

#[derive(Clone, Copy, Debug)]
pub enum CarrierSource<'a> {
    /// The transaction's calldata or blobs.
    Inbox,
    /// A carrier event: a log whose only topic is [`PCASH_BATCH_TOPIC`], and
    /// its data decoded, `None` when the data is not the canonical encoding.
    Event {
        log: &'a L1Log,
        decoded: Option<EventData<'a>>,
    },
}

/// The fields of a carrier event's data.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct EventData<'a> {
    pub context: &'a [u8],
    pub batch: &'a [u8],
}

impl<'a> Carrier<'a> {
    pub fn kind(&self) -> CarrierKind {
        match self.source {
            CarrierSource::Inbox => CarrierKind::Inbox,
            CarrierSource::Event { .. } => CarrierKind::Event,
        }
    }

    /// The candidate batch, without performing I/O. A carrier event whose data
    /// is not the canonical encoding, or whose batch exceeds `MAX_BATCH_BYTES`,
    /// is ignored in full.
    pub fn batch(&self) -> CarrierBatch<'a> {
        match self.source {
            CarrierSource::Inbox => self.tx.inbox_batch(),
            CarrierSource::Event {
                decoded: Some(EventData { batch, .. }),
                ..
            } if batch.len() <= MAX_BATCH_BYTES => CarrierBatch::Bytes(batch),
            CarrierSource::Event { .. } => CarrierBatch::Ignore,
        }
    }

    /// The carrier context hash of a carrier that yields a batch: the Inbox
    /// sender with an empty context, or the event's emitter and context.
    pub fn context_hash(&self) -> Fr {
        match self.source {
            CarrierSource::Inbox => inbox_carrier_context_hash(self.tx.from),
            CarrierSource::Event { log, decoded } => carrier_context_hash(
                CarrierKind::Event,
                log.emitter.into_array(),
                decoded.map_or(&[][..], |data| data.context),
            ),
        }
    }
}

impl L1BlockData {
    /// Every carrier of the block in derivation order: by Ethereum
    /// transaction, its Inbox carrier if it is sent to `inbox`, then its
    /// carrier events in receipt-local log order. A log whose first topic is
    /// [`PCASH_BATCH_TOPIC`] but that has other topics is not a carrier.
    pub fn carriers(&self, inbox: Address) -> impl Iterator<Item = Carrier<'_>> {
        self.txs.iter().flat_map(move |(tx, receipt)| {
            let inbox_carrier = (tx.to == Some(inbox)).then_some(Carrier {
                tx,
                source: CarrierSource::Inbox,
            });
            let events = receipt
                .logs
                .iter()
                .filter(|log| log.topics.as_slice() == [PCASH_BATCH_TOPIC])
                .map(move |log| Carrier {
                    tx,
                    source: CarrierSource::Event {
                        log,
                        decoded: decode_event_data(&log.data),
                    },
                });
            inbox_carrier.into_iter().chain(events)
        })
    }
}

/// The `(context, batch)` of carrier-event data that is exactly the canonical
/// ABI encoding of `(bytes, bytes)`: head words `0x40` and the batch offset,
/// each length word, the bytes, zero padding to a 32-byte boundary, and nothing
/// after. Every offset is checked against `data` before it is used.
pub fn decode_event_data(data: &[u8]) -> Option<EventData<'_>> {
    const WORD: usize = 32;
    const CONTEXT_LENGTH_OFFSET: usize = 2 * WORD;
    let word = |offset: usize| -> Option<usize> {
        let word = data.get(offset..offset.checked_add(WORD)?)?;
        let (high, low) = word.split_at(WORD - 8);
        if high.iter().any(|&byte| byte != 0) {
            return None;
        }
        usize::try_from(u64::from_be_bytes(low.try_into().ok()?)).ok()
    };
    let padded = |length: usize| length.checked_next_multiple_of(WORD);
    // The bytes from `start` holding `length` bytes and their zero padding,
    // and the offset after the padding.
    let field = |start: usize, length: usize| -> Option<(&[u8], usize)> {
        let end = start.checked_add(length)?;
        let padded_end = start.checked_add(padded(length)?)?;
        let bytes = data.get(start..end)?;
        let padding = data.get(end..padded_end)?;
        padding
            .iter()
            .all(|&byte| byte == 0)
            .then_some((bytes, padded_end))
    };
    if word(0)? != CONTEXT_LENGTH_OFFSET {
        return None;
    }
    let (context, batch_length_offset) =
        field(CONTEXT_LENGTH_OFFSET + WORD, word(CONTEXT_LENGTH_OFFSET)?)?;
    if word(WORD)? != batch_length_offset {
        return None;
    }
    let (batch, end) = field(
        batch_length_offset.checked_add(WORD)?,
        word(batch_length_offset)?,
    )?;
    (end == data.len()).then_some(EventData { context, batch })
}

/// Where a batch came from. The discriminant is the hashed `carrierKind`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum CarrierKind {
    Inbox = 0,
    Event = 1,
}

/// The carrier context hash of an Inbox carrier sent by `sender`: its sender
/// with an empty context.
pub fn inbox_carrier_context_hash(sender: Address) -> Fr {
    carrier_context_hash(CarrierKind::Inbox, sender.into_array(), &[])
}

/// Hash inputs before the context chunks: domain, kind, address, context length.
const CARRIER_CONTEXT_HEADER_INPUTS: usize = 4;

/// `poseidon(CARRIER_CONTEXT_DOMAIN, kind, address, len, chunks...)` with the
/// context chunked as log data is (§7.2).
pub fn carrier_context_hash(kind: CarrierKind, address: [u8; 20], context: &[u8]) -> Fr {
    poseidon(&carrier_context_inputs(kind, address, context))
}

fn carrier_context_inputs(kind: CarrierKind, address: [u8; 20], context: &[u8]) -> Vec<Fr> {
    let mut inputs =
        Vec::with_capacity(CARRIER_CONTEXT_HEADER_INPUTS + data_chunk_slots(context.len()));
    inputs.extend([
        domain_tags::CARRIER_CONTEXT_DOMAIN,
        Fr::from(kind as u8),
        Fr::from_be_bytes_mod_order(&address),
        Fr::from(context.len() as u64),
    ]);
    push_data_chunks(&mut inputs, context);
    inputs
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    reason = "tests use direct assertions for fixture setup"
)]
mod tests {
    use super::*;
    use alloy_primitives::{hex, B256};
    use ark_ff::PrimeField;
    use pcash_crypto::{domain_tags, fr_to_bytes, Fr};

    fn word(value: &serde_json::Value) -> B256 {
        value.as_str().unwrap().parse().unwrap()
    }

    #[test]
    fn carrier_contexts_match_published_vectors() {
        let vectors: serde_json::Value = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../vectors/protocol_vectors.json"
        )))
        .unwrap();
        let mut shapes = Vec::new();
        for vector in vectors["carrierContexts"].as_array().unwrap() {
            let kind = if vector["kind"].as_u64().unwrap() == 0 {
                CarrierKind::Inbox
            } else {
                CarrierKind::Event
            };
            assert_eq!(kind as u64, vector["kind"].as_u64().unwrap());
            let address: [u8; 20] = hex::decode(vector["address"].as_str().unwrap())
                .unwrap()
                .try_into()
                .unwrap();
            let context = hex::decode(vector["context"].as_str().unwrap()).unwrap();
            let expected_inputs: Vec<Fr> = vector["inputs"]
                .as_array()
                .unwrap()
                .iter()
                .map(|input| Fr::from_be_bytes_mod_order(word(input).as_slice()))
                .collect();
            assert_eq!(expected_inputs[0], domain_tags::CARRIER_CONTEXT_DOMAIN);
            assert_eq!(
                carrier_context_inputs(kind, address, &context),
                expected_inputs
            );
            assert_eq!(
                fr_to_bytes(carrier_context_hash(kind, address, &context)),
                word(&vector["hash"])
            );
            shapes.push((
                kind as u8,
                context.len(),
                expected_inputs.len(),
                vector["inputCount"].as_u64().unwrap(),
            ));
        }
        assert_eq!(
            shapes,
            [
                (0, 0, 12, 12),
                (1, 0, 12, 12),
                (1, 17, 12, 12),
                (1, 128, 12, 12),
                (1, 200, 17, 17),
            ]
        );
    }

    alloy_sol_types::sol! {
        event PcashBatch(bytes context, bytes batch);
    }

    /// The log data Solidity emits for `PcashBatch(context, batch)`.
    fn emitted(context: &[u8], batch: &[u8]) -> Vec<u8> {
        use alloy_sol_types::SolEvent;
        PcashBatch {
            context: context.to_vec().into(),
            batch: batch.to_vec().into(),
        }
        .encode_data()
    }

    #[test]
    fn the_carrier_topic_is_the_event_signature() {
        use alloy_sol_types::SolEvent;
        assert_eq!(PCASH_BATCH_TOPIC, PcashBatch::SIGNATURE_HASH);
        assert_eq!(
            PCASH_BATCH_TOPIC,
            alloy_primitives::keccak256("PcashBatch(bytes,bytes)")
        );
    }

    #[test]
    fn emitted_event_data_decodes_to_its_context_and_batch() {
        for (context, batch) in [
            (&[][..], &[][..]),
            (&[7; 17][..], &[1, 2, 3][..]),
            (&[7; 32][..], &[9; 33][..]),
            (&[1; 128][..], &[2; 64][..]),
            (&[][..], &[5; 1_000][..]),
        ] {
            assert_eq!(
                decode_event_data(&emitted(context, batch)),
                Some(EventData { context, batch })
            );
        }
    }

    #[test]
    fn every_other_event_data_form_is_rejected() {
        // Heads 0..64, context length 64..96, context 96..113 and its padding
        // to 128, batch length 128..160, batch 160..200 and its padding to 224.
        let canonical = emitted(&[7; 17], &[9; 40]);
        assert_eq!(canonical.len(), 224);
        assert!(decode_event_data(&canonical).is_some());
        for offset in [
            0,   // first head, high byte
            31,  // first head is 0x40
            63,  // second head points past the context
            64,  // context length, high byte
            95,  // context length shrinks into nonzero padding
            113, // context padding
            127, // context padding
            128, // batch length, high byte
            200, // batch padding
            223, // batch padding
        ] {
            let mut data = canonical.clone();
            data[offset] ^= 1;
            assert_eq!(decode_event_data(&data), None, "byte {offset}");
        }
        let mut hostile = canonical.clone();
        hostile[88..96].fill(0xff);
        assert_eq!(decode_event_data(&hostile), None);
        for trailing in [&[0u8][..], &[0; 32][..]] {
            assert_eq!(
                decode_event_data(&[canonical.as_slice(), trailing].concat()),
                None
            );
        }
        for end in [0, 32, 64, 160, 199, 200, 223] {
            assert_eq!(decode_event_data(&canonical[..end]), None, "{end} bytes");
        }
    }

    #[test]
    fn an_inbox_sender_and_an_event_emitter_at_one_address_differ() {
        let address = [0x33; 20];
        assert_ne!(
            carrier_context_hash(CarrierKind::Inbox, address, &[]),
            carrier_context_hash(CarrierKind::Event, address, &[])
        );
    }

    #[test]
    fn contexts_that_differ_only_in_length_differ() {
        let address = [0x33; 20];
        let mut seventeen = [7u8; 17];
        seventeen[16] = 0;
        assert_ne!(
            carrier_context_hash(CarrierKind::Event, address, &seventeen[..16]),
            carrier_context_hash(CarrierKind::Event, address, &seventeen)
        );
    }
}
