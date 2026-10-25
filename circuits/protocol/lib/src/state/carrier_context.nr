// The carrier context a transaction can require: a kind, the address that
// vouches for the carrier, and context bytes. An Inbox transaction's is its
// sender with an empty context; a `PcashBatch` event's is its emitter and its
// `context`. The node compares the carrying carrier's hash with the one a
// transaction states; a rule that cares recomputes it here from the bytes it
// pins and leaves the rest as witnesses.

use crate::generated::pcash_constants::CARRIER_CONTEXT_DOMAIN;
use crate::primitives::hash::pcash_hash;

pub global CARRIER_KIND_INBOX: Field = 0;
pub global CARRIER_KIND_EVENT: Field = 1;

// Hash inputs before the context chunks: domain, kind, address, context length.
global HEADER_INPUTS: u32 = 4;
// A context hash carries at least eight chunk slots, as a log's data does
// (§7.2).
global MIN_CHUNKS: u32 = 8;
global BYTES_PER_CHUNK: u32 = 16;

// poseidon(CARRIER_CONTEXT_DOMAIN, kind, address, N, chunk_0, ..., chunk_(m-1))
// with m = max(8, ceil(N / 16)): the N-byte context in 16-byte big-endian
// chunks, the last the integer of its own bytes, and zero slots past them.
// `kind` and `address` enter as given: a value outside its width equals no
// carrier's hash.
pub fn carrier_context_hash<let N: u32>(kind: Field, address: Field, context: [u8; N]) -> Field {
    if N < MIN_CHUNKS * BYTES_PER_CHUNK {
        chunked_hash::<N, MIN_CHUNKS>(kind, address, context)
    } else {
        chunked_hash::<N, (N + BYTES_PER_CHUNK - 1) / BYTES_PER_CHUNK>(kind, address, context)
    }
}

// The hash over M chunk slots, which hold the N context bytes.
fn chunked_hash<let N: u32, let M: u32>(kind: Field, address: Field, context: [u8; N]) -> Field {
    let mut inputs: [Field; HEADER_INPUTS + M] = [0; HEADER_INPUTS + M];
    inputs[0] = CARRIER_CONTEXT_DOMAIN;
    inputs[1] = kind;
    inputs[2] = address;
    inputs[3] = N as Field;
    for i in 0..N {
        let slot = HEADER_INPUTS + i / BYTES_PER_CHUNK;
        inputs[slot] = inputs[slot] * 256 + context[i] as Field;
    }
    pcash_hash(inputs)
}

mod tests {
    use crate::generated::pcash_constants::CARRIER_CONTEXT_DOMAIN;
    use crate::primitives::hash::pcash_hash;
    use super::{carrier_context_hash, CARRIER_KIND_EVENT, CARRIER_KIND_INBOX};

    global ADDRESS: Field = 0x3333333333333333333333333333333333333333;

    // N bytes of a counting pattern.
    fn pattern<let N: u32>() -> [u8; N] {
        let mut context: [u8; N] = [0; N];
        for i in 0..N {
            context[i] = (i + 1) as u8;
        }
        context
    }

    // The eight chunks of the 128-byte pattern, written without the helper.
    fn pattern_chunks() -> [Field; 8] {
        let context: [u8; 128] = pattern();
        let mut chunks: [Field; 8] = [0; 8];
        for chunk in 0..8 {
            for j in 0..16 {
                chunks[chunk] = chunks[chunk] * 256 + context[chunk * 16 + j] as Field;
            }
        }
        chunks
    }

    #[test]
    fn test_kinds_are_numbered() {
        assert_eq(CARRIER_KIND_INBOX, 0);
        assert_eq(CARRIER_KIND_EVENT, 1);
    }

    #[test]
    fn test_eight_chunk_context_is_the_plain_sponge() {
        let chunks = pattern_chunks();
        let expected = pcash_hash([
            CARRIER_CONTEXT_DOMAIN,
            CARRIER_KIND_EVENT,
            ADDRESS,
            128,
            chunks[0],
            chunks[1],
            chunks[2],
            chunks[3],
            chunks[4],
            chunks[5],
            chunks[6],
            chunks[7],
        ]);
        assert_eq(carrier_context_hash(CARRIER_KIND_EVENT, ADDRESS, pattern::<128>()), expected);
    }

    // An empty context still carries the eight zero chunk slots.
    #[test]
    fn test_empty_context_pads_to_eight_chunks() {
        let empty: [u8; 0] = [];
        let expected = pcash_hash([
            CARRIER_CONTEXT_DOMAIN,
            CARRIER_KIND_INBOX,
            ADDRESS,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
        ]);
        assert_eq(carrier_context_hash(CARRIER_KIND_INBOX, ADDRESS, empty), expected);
    }

    // The last chunk is the integer of its own bytes, so a 17-byte context ends
    // in a one-byte chunk, and the eight-chunk minimum pads with zeros.
    #[test]
    fn test_short_final_chunk_is_not_shifted() {
        let mut chunks: [Field; 8] = [0; 8];
        for j in 0..16 {
            chunks[0] = chunks[0] * 256 + (j + 1) as Field;
        }
        chunks[1] = 17;
        let expected = pcash_hash([
            CARRIER_CONTEXT_DOMAIN,
            CARRIER_KIND_INBOX,
            ADDRESS,
            17,
            chunks[0],
            chunks[1],
            0,
            0,
            0,
            0,
            0,
            0,
        ]);
        assert_eq(carrier_context_hash(CARRIER_KIND_INBOX, ADDRESS, pattern::<17>()), expected);
    }

    // Past eight chunks every chunk takes a slot: a 129-byte context ends in a
    // ninth, one-byte chunk.
    #[test]
    fn test_context_beyond_eight_chunks_uses_every_chunk() {
        let chunks = pattern_chunks();
        let expected = pcash_hash([
            CARRIER_CONTEXT_DOMAIN,
            CARRIER_KIND_EVENT,
            ADDRESS,
            129,
            chunks[0],
            chunks[1],
            chunks[2],
            chunks[3],
            chunks[4],
            chunks[5],
            chunks[6],
            chunks[7],
            129,
        ]);
        assert_eq(carrier_context_hash(CARRIER_KIND_EVENT, ADDRESS, pattern::<129>()), expected);
    }

    #[test]
    fn test_kind_and_address_separate_carriers() {
        let empty: [u8; 0] = [];
        let inbox = carrier_context_hash(CARRIER_KIND_INBOX, ADDRESS, empty);
        assert(inbox != carrier_context_hash(CARRIER_KIND_EVENT, ADDRESS, empty));
        assert(inbox != carrier_context_hash(CARRIER_KIND_INBOX, ADDRESS + 1, empty));
    }

    #[test]
    fn test_length_separates_trailing_zero_bytes() {
        let mut longer: [u8; 17] = [0; 17];
        let context: [u8; 16] = pattern();
        for i in 0..16 {
            longer[i] = context[i];
        }
        assert(
            carrier_context_hash(CARRIER_KIND_EVENT, ADDRESS, context)
                != carrier_context_hash(CARRIER_KIND_EVENT, ADDRESS, longer),
        );
    }
}
